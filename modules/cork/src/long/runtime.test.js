/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The long-mode translator judged by the long-mode interpreter: every case of
 * the hardware corpus (`x64-corpus.json.gz`), seeded programs drawn from it
 * and directed ones run twice over the same machine -- once as translated
 * regions (each start translated the first time it is met, the interpreter
 * taking what a block stops before), once on the interpreter alone -- and
 * everything a program can see compared: the sixteen registers, RIP, the
 * instructions retired, the whole flags word (undefined flags included: the
 * translator keeps them as the model does), the XMM registers, the x87 unit
 * the MMX registers are part of, the data buffer, and a fault's vector and
 * instruction.
 *
 * The interpreter is itself judged by the processor (`ir64-corpus.test.js`),
 * so this is the translator against the hardware one step removed, exact
 * where the hardware leaves a flag to the implementation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ownLayout, pageFlagsAt, pagesFor, tablesSize } from '../runtime/layout.js';
import { PageFlag, createPageTable } from '../runtime/pages.js';
import { blockState64, interpret64 } from '../interp64.js';
import { MODE_64, decode } from '../decode/decoder.js';
import { createLongRunner } from './runtime.js';
import { endsBlock, translates } from './emit.js';

const CORPUS = JSON.parse(gunzipSync(readFileSync(new URL('../x64-corpus.json.gz',
    import.meta.url))).toString('utf8'));
/** CF, PF, AF, ZF, SF and OF. */
const STATUS = 0x8d5;
/** Where the runner's exit jump goes: a closed page, whose fetch ends the case. */
const EXIT = 0x1f000000;

/** @param {number} seed @param {number} size */
function fill(seed, size){
    const data = new Uint8Array(size);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < data.length; i++)
    {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        data[i] = x & 0xff;
    }
    return data;
}

/**
 * A machine with the corpus's data and code areas open and every other page closed.
 *
 * @param {boolean} [transfers]  regions go on into each other without the host
 * @param {boolean} [checkReads]  translated reads test their pages from the start
 * @param {boolean} [looseStacks]  false: stores through rsp test their pages too
 * @param {boolean} [defaultNaNNegative]  false: float code as for a host whose default NaN is
 *     positive, an arm64 one (the host's own unless given)
 */
function machine(transfers = true, checkReads = undefined, looseStacks = undefined,
    defaultNaNNegative = undefined)
{
    const ramSize = CORPUS.codeAt + 0x100000;
    const layout = ownLayout({ ramSize, ramBase: 0, bits: 64 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const flags = new Uint8Array(memory.buffer, pageFlagsAt(layout), 1 << 20);
    flags.fill(PageFlag.INACCESSIBLE);
    for (const [at, size] of [[CORPUS.dataAt, CORPUS.dataSize], [CORPUS.codeAt, CORPUS.codeSize]])
    {
        flags.fill(0, at >>> 12, (at + size) >>> 12);
    }
    const pages = createPageTable(memory, layout);
    const runner = createLongRunner({ memory, layout, pages, hot: 1, transfers, checkReads,
        looseStacks, ...(defaultNaNNegative === undefined ? {} : { defaultNaNNegative }) });
    const state = blockState64({ memory, layout,
        onCodeWrite: (at, size)=>runner.invalidate(at, size) });
    return { layout, memory, state, runner, view: new DataView(memory.buffer) };
}

/**
 * Every instruction of the corpus the translator takes that leaves the
 * stack, the pointer and index registers and r15 alone, as its bytes: the
 * pool the seeded programs are drawn from.
 */
function pool(){
    const kept = new Set([3, 4, 5, 6, 7, 12, 13, 15]);
    /** @type {Set<string>} */
    const out = new Set();
    for (const one of CORPUS.cases)
    {
        const code = Buffer.from(one.code, 'hex');
        for (let at = 0; at < code.length;)
        {
            const instruction = decode(address=>code[address] ?? 0, at, MODE_64);
            if ('refused' in instruction)
            {
                break;
            }
            const { op, operands } = instruction;
            // Both operands of an exchange are written, and leave writes rsp and rbp.
            const writesKept = op === 'leave' || operands.some(operand=>operand.kind === 'reg'
                && kept.has(/** @type {number} */ (operand.reg))
                && (operand === operands[0] || op === 'xchg' || op === 'xadd'))
                && op !== 'cmp' && op !== 'test' && op !== 'bt';
            if (translates(instruction) && !endsBlock(op) && op !== 'push' && op !== 'pop'
                && !writesKept && !operands.some(operand=>operand.kind === 'mem' && operand.rip))
            {
                out.add(code.subarray(at, at + instruction.length).toString('hex'));
            }
            at += instruction.length;
        }
    }
    return [...out].map(hex=>Buffer.from(hex, 'hex'));
}

/**
 * A seeded program from the pool: `count` instructions run three times by a
 * loop on r15 (`dec r15d; jnz` back to the start), set up on a corpus case's
 * registers and data.
 *
 * @param {Buffer[]} instructions @param {number} seed @param {number} count
 */
function program(instructions, seed, count){
    let x = seed >>> 0 || 1;
    const next = ()=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
    /** @type {Buffer[]} */
    const parts = [];
    for (let i = 0; i < count; i++)
    {
        parts.push(instructions[next() % instructions.length]);
    }
    const body = Buffer.concat(parts);
    const back = -(body.length + 3 + 6);
    const loop = Buffer.from([0x41, 0xff, 0xcf, 0x0f, 0x85, back & 0xff, back >>> 8 & 0xff,
        back >>> 16 & 0xff, back >>> 24 & 0xff]);
    const one = CORPUS.cases[next() % CORPUS.cases.length];
    const regs = [...one.regs];
    if ((seed & 1) !== 0)
    {
        // Small values in the registers no address uses: equal operands, zero
        // results and borrows of one, which random quadwords almost never give.
        for (const index of [0, 1, 2, 8, 9, 10, 11, 14])
        {
            regs[index] = (next() & 3).toString(16);
        }
    }
    regs[15] = '3';
    const code = Buffer.concat([body, loop]).toString('hex');
    return { ...one, text: `program ${seed}`, code, regs };
}

/**
 * A seeded program of nested control flow over the pool's instructions:
 * runs of them, a run jumped over when a condition holds, and loops on r12
 * and r13 (which the pool leaves alone) of one to three turns, a loop now
 * and then left from its middle past its jump back, and entered past its
 * head from before it -- a way into its middle, which makes it no natural
 * loop. Every jump is a rel32.
 *
 * @param {Buffer[]} instructions @param {number} seed
 */
function nested(instructions, seed){
    let x = seed >>> 0 || 1;
    const next = ()=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
    /** @param {number} value */
    const rel = value=>{
        const bytes = Buffer.alloc(4);
        bytes.writeInt32LE(value);
        return bytes;
    };
    /** A conditional jump over `length` bytes. @param {number} length */
    const jcc = length=>Buffer.concat([Buffer.from([0x0f, 0x80 + next() % 16]), rel(length)]);
    /** @param {number} depth @returns {Buffer} */
    const body = depth=>{
        /** @type {Buffer[]} */
        const parts = [];
        for (let item = 1 + next() % 4; item > 0; item--)
        {
            const kind = next() % 4;
            if (kind === 1)
            {
                const over = body(depth + 1);
                parts.push(jcc(over.length), over);
            }
            else if (kind === 2 && depth < 2)
            {
                // mov r12d/r13d, turns; [jcc into the middle]; head: first; middle: second;
                // dec r12d/r13d; jnz head
                const counter = depth === 0 ? 0xc : 0xd;
                const first = body(depth + 1);
                let second = body(depth + 1);
                if (next() % 3 === 0)
                {
                    // A way out of the loop past its jump back.
                    second = Buffer.concat([jcc(second.length + 3 + 6), second]);
                }
                const turns = 1 + next() % 3;
                parts.push(Buffer.from([0x41, 0xb8 + counter - 8]), rel(turns));
                if (next() % 3 === 0)
                {
                    parts.push(jcc(first.length));
                }
                parts.push(first, second, Buffer.from([0x41, 0xff, 0xc0 + counter]));
                parts.push(Buffer.from([0x0f, 0x85]),
                    rel(-(first.length + second.length + 3 + 6)));
            }
            else
            {
                for (let n = 1 + next() % 3; n > 0; n--)
                {
                    parts.push(instructions[next() % instructions.length]);
                }
            }
        }
        return Buffer.concat(parts);
    };
    const code = body(0).subarray(0, CORPUS.codeSize - 64);
    const one = CORPUS.cases[next() % CORPUS.cases.length];
    return { ...one, text: `nested ${seed}`, code: code.toString('hex'), regs: [...one.regs] };
}

/**
 * Sets a case up on a machine: its code area (with the exit jump and EXIT in
 * the area's last eight bytes), data, registers, flags and XMM registers.
 *
 * @param {ReturnType<typeof machine>} m @param {any} one
 */
function load(m, one){
    const { layout, memory, view } = m;
    const bytes = new Uint8Array(memory.buffer);
    const code = Buffer.from(one.code, 'hex');
    bytes.fill(0, CORPUS.codeAt, CORPUS.codeAt + CORPUS.codeSize);
    bytes.set(code, CORPUS.codeAt);
    const disp = CORPUS.codeSize - 8 - (code.length + 6);
    bytes.set([0xff, 0x25, disp & 0xff, disp >>> 8 & 0xff, disp >>> 16 & 0xff, disp >>> 24],
        CORPUS.codeAt + code.length);
    view.setBigUint64(CORPUS.codeAt + CORPUS.codeSize - 8, BigInt(EXIT), true);
    bytes.set(fill(one.seed, CORPUS.dataSize), CORPUS.dataAt);
    one.regs.forEach((/** @type {string} */ value, /** @type {number} */ i)=>{
        view.setBigUint64(layout.regs + i * 8, BigInt(`0x${value}`), true);
    });
    view.setBigUint64(layout.eip, BigInt(CORPUS.codeAt), true);
    view.setUint32(layout.eflags, one.flags | 0x202, true);
    view.setUint32(layout.mxcsr, one.mxcsr ?? 0x1f80, true);
    bytes.set(one.xmm ?? fill(one.seed ^ CORPUS.xmmSeed, 256), layout.xmm);
    // The x87 unit as `fninit` leaves it, its registers (the MMX ones) seeded,
    // and some marked as holding a `fild`'s quadword, which an MMX write ends.
    bytes.set(fill(one.seed ^ 0x87, 128), layout.x87);
    bytes[layout.x87Top] = 0;
    bytes[layout.x87Empty] = 0xff;
    view.setUint16(layout.x87Control, 0x37f, true);
    view.setUint16(layout.x87Status, 0, true);
    bytes[/** @type {number} */ (layout.x87Exact)] = one.seed & 0xff;
    m.state.syncIn();
    m.state.halted = false;
    m.state.trapped.length = 0;
    m.state.retired = 0;
}

/**
 * Runs the loaded case to its exit or a fault, translated or interpreted,
 * and answers what the program can see.
 *
 * @param {ReturnType<typeof machine>} m @param {boolean} translated
 * @param {number} [budget]
 */
function run(m, translated, budget = 7){
    const { layout, memory, state, runner, view } = m;
    let fault;
    try
    {
        for (let round = 0; round < 100000; round++)
        {
            if (translated)
            {
                // A small budget by default, so runs end between blocks as well as at faults.
                runner.run(state, budget);
                // The host writes the state back after a run (cork-host's
                // `settle`): RIP and the flags must be the blocks' own.
                state.syncOut();
            }
            else
            {
                state.syncIn();
                interpret64(state, 10000);
                state.syncOut();
            }
        }
        fault = 'ran on';
    }
    catch (e){
        const error = /** @type {{ vector?: number, eip?: number }} */ (e);
        if (typeof error.vector !== 'number')
        {
            throw e;
        }
        state.syncOut();
        fault = error.eip === EXIT ? 'exit' : `${error.vector}@${(error.eip ?? 0) - CORPUS.codeAt}`;
    }
    const bytes = new Uint8Array(memory.buffer);
    return {
        fault,
        regs: [...new BigUint64Array(memory.buffer, layout.regs, 16)]
            .map(value=>value.toString(16)),
        rip: view.getBigUint64(layout.eip, true).toString(16),
        retired: String(state.retired),
        flags: view.getUint32(layout.eflags, true).toString(16),
        xmm: Buffer.from(bytes.subarray(layout.xmm, layout.xmm + 256)).toString('hex'),
        x87: Buffer.from(bytes.subarray(layout.x87, layout.x87 + 128)).toString('hex')
            + [layout.x87Top, layout.x87Empty, layout.x87Control, layout.x87Control + 1,
                layout.x87Status, layout.x87Status + 1, /** @type {number} */ (layout.x87Exact)]
                .map(at=>bytes[at].toString(16)).join(','),
        data: Buffer.from(bytes.subarray(CORPUS.dataAt, CORPUS.dataAt + CORPUS.dataSize))
            .toString('base64'),
    };
}

/**
 * Runs every case on both machines and answers the differences.
 *
 * @param {any[]} cases @param {number} [budget]  each translated run's
 * @param {boolean} [transfers]  the translated machine's regions go on into each
 *     other without the host: both ways must be the interpreter's
 * @param {boolean} [checkReads]  its reads test their pages, as the interpreter's do
 * @param {boolean} [defaultNaNNegative]  its float code as for that host (`machine`)
 */
function compare(cases, budget = 7, transfers = true, checkReads = undefined,
    defaultNaNNegative = undefined)
{
    const translatedMachine = machine(transfers, checkReads, undefined, defaultNaNNegative);
    const interpretedMachine = machine();
    /** @type {string[]} */
    const failures = [];
    let exits = 0;
    for (const one of cases)
    {
        // A fresh translation per case: the code area is rewritten in place.
        translatedMachine.runner.invalidate(CORPUS.codeAt, CORPUS.codeSize);
        load(translatedMachine, one);
        load(interpretedMachine, one);
        const translated = run(translatedMachine, true, budget);
        const interpreted = run(interpretedMachine, false);
        exits += translated.fault === 'exit' ? 1 : 0;
        if (translated.fault === interpreted.fault && /^[1-9]\d*@/.test(translated.fault))
        {
            // At a fault other than a division's, the status flags a write the
            // code after it overwrites left are the translator's to drop, as
            // the 32-bit translator drops them: the handler resumes the same
            // code, which writes them again before it reads them.
            for (const seen of [translated, interpreted])
            {
                seen.flags = (Number.parseInt(seen.flags, 16) & ~STATUS).toString(16);
            }
        }
        for (const key of /** @type {const} */ (['fault', 'rip', 'retired', 'flags', 'xmm',
            'x87', 'data']))
        {
            if (translated[key] !== interpreted[key])
            {
                failures.push(`${one.text}: ${key} ${translated[key].slice(0, 80)}`
                    + ` vs ${interpreted[key].slice(0, 80)}`);
            }
        }
        translated.regs.forEach((value, i)=>{
            if (value !== interpreted.regs[i])
            {
                failures.push(`${one.text}: r${i} ${value} vs ${interpreted.regs[i]}`);
            }
        });
    }
    return { failures, exits, stats: translatedMachine.runner.stats };
}

test('translated long-mode blocks do what the interpreter does on every corpus case', ()=>{
    const { failures, exits, stats } = compare(CORPUS.cases);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    // The gate means something only if most of the corpus ran translated.
    assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
    assert.ok(stats.translated > stats.interpreted / 2,
        JSON.stringify(stats));
});

test('seeded long programs run translated as they run interpreted', ()=>{
    const instructions = pool();
    assert.ok(instructions.length > 1000, `${instructions.length} instructions in the pool`);
    const cases = Array.from({ length: 600 },
        (_, i)=>program(instructions, 0x5eed + i, 20 + i % 60));
    for (const transfers of [true, false])
    {
        const { failures, stats, exits } = compare(cases, 7, transfers);
        // A division from the pool raises #DE in some (both ways alike); most run through.
        assert.ok(exits > cases.length * 0.6, `${exits} programs ran to their exit`);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted * 2,
            `translated ${stats.translated}, interpreted ${stats.interpreted}`);
    }
});

/**
 * MMX forms at 64 bits, as bytes: the saturating, multiplying, unpacking,
 * packing, shuffling and shifting ones, moves among the MMX registers, the
 * general ones and memory (through rbx, rsi and rdi, which hold the corpus's
 * data pointers), with the integer and x87 instructions around them that
 * leave and enter the MMX state.
 */
const MMX_POOL = [
    '0f6f4b10', '0f6f5e08', '0f6f6718', '0f7f4320', '0f7f6e28', '0f7e5730', '0f6e7334',
    '0fe74b38', '0f6ffb', '0f7fe8', '410f6ef8', '490f6ed1', '410f7eca', '490f7ee3', '480f7ec0',
    '0f7ef1', '0fe9c3', '0fedc7', '0fddcc', '0fd8e3', '0fdbef', '0fdfc1', '0febd6', '0fefdb',
    '0f75f6', '0f64d1', '0f764e10', '0ffcca', '0ffdca', '0ffedc', '0fd4c1', '0ffb13', '0f60d1',
    '0f68d1', '0f61ff', '0f69cb', '0f62ff', '0f6ae8', '0f605f04', '0fe5e7', '0fd5cf', '0fe4d3',
    '0ff4ca', '0ff5d9', '0ff6d4', '0fe0ca', '0fe3d8', '0fdac2', '0feee9', '0f70c11b',
    '0f7053084e', '0f71e707', '0f73f310', '0f73d720', '0f72d121', '0f72e228', '0ff1c1', '0fd3d3',
    '0fe16618', '0f63c1', '0f67d3', '0f6be5', '0fd7ca', '440fd7c8', '0fc5c802', '440fc5c307',
    '0fc4e801', '0fc44f1206', 'b80180ff7f', '01c8', '4989c0', 'd9e8', '0f77',
].map(hex=>Buffer.from(hex, 'hex'));

test('MMX runs translated as interpreted, the x87 unit it leaves in its state included', ()=>{
    const cases = Array.from({ length: 400 }, (_, i)=>program(MMX_POOL, 0x3d00 + i, 3 + i % 14));
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(cases, budget);
        assert.equal(exits, cases.length);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted * 2,
            `translated ${stats.translated}, interpreted ${stats.interpreted}`);
    }
});

/**
 * x87 forms at 64 bits, as bytes: loads, stores and arithmetic of every
 * memory width through rbx and rsi (the corpus's data pointers), the stack
 * forms, compares into the flags and the status word, the transcendentals,
 * the control word from memory, the environment's image (which a region
 * leaves to the interpreter), and the integer instructions that read what
 * `fcomi`, `fnstsw ax` and `cmp` leave.
 */
const X87_POOL = [
    'dd4310', 'd94318', 'db6b20', 'db4328', 'df6b30', 'df4338', 'dd5e08', 'd95610', 'db7e18',
    'df7e28', 'db5630', 'db4e34', 'df5e38', 'dc4310', 'd84b18', 'dc6340', 'd87b44', 'da4328',
    'dc5310', 'd85b18', 'd97e40', 'd96b48', 'dd7e44', 'd9e8', 'd9ee', 'd9eb', 'd9ea', 'd9c1',
    'ddd9', 'd9c9', 'd9cb', 'dec1', 'dee1', 'dec9', 'def9', 'd8c2', 'dccb', 'd9e0', 'd9e1',
    'd9fa', 'd9fc', 'd9fd', 'd9f0', 'd9f1', 'd9f8', 'd9e5', 'd9e4', 'dbf1', 'dfe9', 'd8d9',
    'ded9', 'dae9', 'dfe0', 'dac1', 'daca', 'dbd1', 'ddc2', 'd9f7', 'd9f6', 'dbe3', 'dbe2', '9b',
    'd9fe', 'd9ff', 'd9f3', 'd9f2', 'd9f4', 'd9fb', 'd97650', 'd96650', '0f97c0', '0f42ca', '9e',
    '39c8',
].map(hex=>Buffer.from(hex, 'hex'));

test('x87 runs in regions as the interpreter runs it, the unit and what it leaves outside', ()=>{
    const cases = Array.from({ length: 400 }, (_, i)=>program(X87_POOL, 0x8700 + i, 3 + i % 14));
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(cases, budget);
        assert.equal(exits, cases.length);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted * 4,
            `translated ${stats.translated}, interpreted ${stats.interpreted}`);
    }
});

test('nested loops, jumps over them, out of them and into them run as interpreted', ()=>{
    const instructions = pool();
    const cases = Array.from({ length: 400 }, (_, i)=>nested(instructions, 0x1005 + i));
    for (const [budget, transfers] of /** @type {const} */ ([[7, true], [1000, true], [5, false]]))
    {
        const { failures, exits } = compare(cases, budget, transfers);
        assert.ok(exits > cases.length * 0.6, `${exits} programs ran to their exit`);
        assert.deepEqual(failures.slice(0, 20), [],
            `${failures.length} differences, budget ${budget}`);
    }
});

test('the cases of a switch join its region, its jump going among them as interpreted', ()=>{
    // Eight rounds through four switches, then eight more after a table is rewritten
    // (tools: GNU as, `ld -Ttext=0x20000000 --oformat binary`):
    //   jmp [tableA + rax*8]                 GCC's absolute quadwords, bound by cmp esi, 5; ja
    //   lea rdx, [rip + base]; mov ecx, [rdx + rax*4 + tableB - base]; add rcx, rdx; jmp rcx
    //                                        MSVC's RVAs from a base below the code (the
    //                                        image's), the index widened by movsxd
    //   lea rdx, [rip + tableC]; movsxd rax, [rdx + rax*4]; add rax, rdx; jmp rax
    //                                        MinGW's offsets, the bound tested in memory
    //   jmp [0x10000040 + rax*8]             a table in the data area, filled by the program
    //                                        (read at forming before or after the fill), and
    //                                        an entry rewritten once its region has run
    // Each case changes a word of [rbx] differently, a default the indices past the bound.
    const code = '488d05d40000004889042540000010488d05cc0000004889042548000010488d05c4000000488904'
        + '25500000104531c931f683fe05772889f0ff24c52001002048830301eb204883030aeb1a48830364'
        + '48830303eb10486b0b0348890beb07488103e803000083fe0477294863c6488d158bffffff8b8c82'
        + '500100004801d1ffe14883430807eb1148836b0805eb0a48837308554883430802897318837b1803'
        + '77268b4318488d15b8000000486304824801d0ffe0488343100beb1148d16310eb0b48f75310eb05'
        + '488343100d83fe02771d89f0ff24c5400000104883432011eb1248c1432003eb0b48f75b20eb0548'
        + '83432013ffc683fe080f8233ffffff4585c9757041ffc1488d05dbffffff488904254800001031f6'
        + 'e915ffffff0f1f00400000200000000046000020000000004c000020000000005000002000000000'
        + '56000020000000005f0000200000000081000000880000008f0000008f0000008100000051ffffff'
        + '58ffffff5effffff51ffffff';
    const cases = CORPUS.cases.slice(0, 6).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `switch ${i}`, code }));
    for (const [budget, transfers] of /** @type {const} */ ([[7, true], [100000, true], [50, false]]))
    {
        const { failures, exits, stats } = compare(cases, budget, transfers);
        assert.deepEqual(failures, [], `budget ${budget}, transfers ${transfers}`);
        assert.equal(exits, cases.length);
        // GCC's, MSVC's and MinGW's tables in the code are read wherever they are formed.
        assert.ok(stats.switches >= 3, JSON.stringify(stats));
    }
});

test('an access across into a closed page or past 4 GiB faults where the interpreter faults', ()=>{
    const base = CORPUS.cases[0];
    const end = CORPUS.dataAt + CORPUS.dataSize;
    /** @param {string} code @param {bigint} rbx */
    const edge = (code, rbx)=>{
        const regs = [...base.regs];
        regs[3] = rbx.toString(16);
        return { ...base, text: `${code} rbx=${rbx.toString(16)}`, code, regs };
    };
    const cases = [];
    // mov rax, [rbx]; mov [rbx], rax; mov eax, [rbx]; mov [rbx], eax; mov ax, [rbx];
    // mov word [rbx], 1; movzx rax, byte [rbx]; push qword [rbx]; add [rbx], rax
    for (const code of ['488b03', '488903', '8b03', '8903', '668b03', '66c7030100', '480fb603',
        'ff33', '480103'])
    {
        for (const rbx of [BigInt(end - 8), BigInt(end - 4), BigInt(end - 2), BigInt(end - 1),
            BigInt(CORPUS.dataAt - 1), 1n << 32n, (1n << 32n) - 4n, (1n << 64n) - 4n,
            // Past 4 GiB with an open page under its low half.
            (1n << 32n) + BigInt(CORPUS.dataAt + 16)])
        {
            cases.push(edge(code, rbx));
        }
    }
    // Reads tested, as a program that has faulted on a read once has them.
    const { failures, exits } = compare(cases, 7, true, true);
    assert.deepEqual(failures, []);
    // Some ran clean, most faulted: both ways were taken.
    assert.ok(exits > 0 && exits < cases.length, `${exits} of ${cases.length} ran to their exit`);
});

test('stos and movs run translated as interpreted: by pages, across them, into a closed one', ()=>{
    const base = CORPUS.cases[0];
    const cases = [];
    // stos and movs of every width: byte, word, dword, qword.
    const ops = [['aa', 'stos'], ['66ab', 'stos'], ['ab', 'stos'], ['48ab', 'stos'],
        ['a4', 'movs'], ['66a5', 'movs'], ['a5', 'movs'], ['48a5', 'movs']];
    for (const [opcode, op] of ops)
    {
        for (const prefix of ['f3', 'f2', ''])
        {
            for (const count of [0n, 1n, 3n, 100n, 1500n, 5000n])
            {
                // Inside the first page, at its end, across into the second,
                // and toward the closed page past the data.
                for (const at of [0x10, 0xffe, 0x1ff8 - 0x40, CORPUS.dataSize - 0x100])
                {
                    for (const down of [false, true])
                    {
                        const shapes = op === 'stos'
                            ? [[0n, 0n], [0x4141414141414141n, 0n], [0x1234n, 0n]]
                            // The source behind the destination by an element or two
                            // (the processor copies forward through what it wrote), apart,
                            // and ahead.
                            : [[0n, -1n], [0n, -8n], [0n, 0x400n], [0n, 3n]];
                        for (const [rax, lead] of shapes)
                        {
                            const regs = [...base.regs];
                            const rdi = BigInt(CORPUS.dataAt + at);
                            regs[0] = rax.toString(16);
                            regs[1] = count.toString(16);
                            regs[7] = rdi.toString(16);
                            regs[6] = (op === 'movs' ? rdi + lead : rdi).toString(16);
                            const code = `${down ? 'fd' : ''}${prefix}${opcode}fc`;
                            const text = `${code} rcx=${count} rdi=+${at.toString(16)}`
                                + ` rax=${rax.toString(16)} lead=${lead}`;
                            cases.push({ ...base, text, code, regs });
                        }
                    }
                }
            }
        }
    }
    const { failures, exits, stats } = compare(cases);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    // Some ran to the closed page, most did not; most ran translated.
    assert.ok(exits > cases.length / 2 && exits < cases.length,
        `${exits} of ${cases.length} ran to their exit`);
    assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
});

test('a store through rsp tests no page until code is translated on a noted stack', ()=>{
    // mov dword [rsp], 0x90c8ff48 over the next instruction, inc rax; nop, which
    // it makes dec rax: code on the page rsp points into.
    const code = 'c7042448ffc89048ffc090';
    const regs = [...CORPUS.cases[0].regs];
    regs[0] = '10';
    regs[4] = (CORPUS.codeAt + 7).toString(16);
    const one = { ...CORPUS.cases[0], text: 'store over the code through rsp', code, regs };
    /** @param {ReturnType<typeof machine>} m @param {boolean} translated */
    const rax = (m, translated)=>{
        m.runner.invalidate(CORPUS.codeAt, CORPUS.codeSize);
        load(m, one);
        return run(m, translated).regs[0];
    };
    const interpreted = rax(machine(), false);
    assert.equal(interpreted, 'f');
    // Tested, as the interpreter does it.
    assert.equal(rax(machine(true, undefined, false), true), interpreted);
    // Loose, with the code's page named a stack: made again tested, once.
    const noted = machine();
    noted.runner.noteStack(CORPUS.codeAt, 0x1000);
    assert.equal(rax(noted, true), interpreted);
    assert.equal(noted.runner.stats.stackSwitches, 1);
    // Loose with no stack named there, the store went untested: the code it
    // wrote over ran as it was, which a thread's stack never holds.
    assert.equal(rax(machine(), true), '11');
});

test('a translated read wraps into RAM until the program faults on a page, then faults', ()=>{
    // mov rax, [rbx] with rbx on the closed page past the data; then hlt-free exit.
    const base = CORPUS.cases[0];
    const closed = CORPUS.dataAt + CORPUS.dataSize + 0x10;
    const regs = [...base.regs];
    regs[3] = closed.toString(16);
    const one = { ...base, text: 'read a closed page', code: '488b03', regs };
    const m = machine();
    load(m, one);
    const wrapped = run(m, true);
    // RAM a power of two here: the address itself, which is in RAM, read as it stands.
    assert.equal(wrapped.fault, 'exit', 'the translated read did not test its page');
    const ram = new DataView(m.memory.buffer).getBigUint64(closed, true);
    assert.equal(wrapped.regs[0], ram.toString(16));
    m.runner.readsFaulted();
    assert.equal(m.runner.stats.readSwitches, 1);
    load(m, one);
    const faulted = run(m, true);
    const interpreted = run((()=>{
        const other = machine();
        load(other, one);
        return other;
    })(), false);
    assert.equal(faulted.fault, interpreted.fault, 'after the switch it faults as the interpreter');
    assert.notEqual(faulted.fault, 'exit');
});

test('an instruction whose two operands are one register runs translated as interpreted', ()=>{
    // xadd rax, rax; xadd eax, eax; xchg rax, rax; cmpxchg rax, rax; cmpxchg ecx, ecx;
    // bsf rax, rax; bsr eax, eax; imul rax, rax; bts rax, rax; btc eax, eax; mul rax;
    // div rdx; idiv rax; xadd al, al; xadd ah, ah (in 32-bit form)
    const codes = ['480fc1c0', '0fc1c0', '4887c0', '480fb1c0', '0fb1c9', '480fbcc0', '0fbdc0',
        '480fafc0', '480fabc0', '0fbbc0', '48f7e0', '48f7f2', '48f7f8', '0fc0c0', '0fc0e4'];
    const cases = CORPUS.cases.slice(0, 20).flatMap((/** @type {any} */ one)=>codes.map(code=>({
        ...one, text: `${code} on ${one.text}`, code,
        regs: one.regs.map((/** @type {string} */ value, /** @type {number} */ i)=>(i === 0 || i === 2
            ? (Number.parseInt(value.slice(-2), 16) & 7).toString(16) : value)),
    })));
    const { failures } = compare(cases);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
});

test('a run comes back once it has interpreted its limit, the budget left over', ()=>{
    const m = machine();
    // Twenty cpuids, which no block holds: each one the interpreter's.
    const code = Buffer.alloc(0x100, 0x90);
    for (let i = 0; i < 20; i++)
    {
        code.set([0x0f, 0xa2], i * 2);
    }
    load(m, { ...CORPUS.cases[0], code: code.toString('hex') });
    const interpreted = m.runner.stats.interpreted;
    m.runner.run(m.state, 1000000, { interpretLimit: 4 });
    const spent = m.runner.stats.interpreted - interpreted;
    assert.ok(spent >= 4 && spent < 8, `${spent} interpreted`);
    assert.ok(m.state.retired < 1000000);
});

test('calls from region to region return where they were made, and leave where they cannot', ()=>{
    // start:  mov ecx, 12; call fib; mov [rbx], rax          fib(12), nested wasm calls
    //         mov ecx, 80; call depth; mov [rbx + 8], rax     deeper than CALL_DEPTH
    //         call skip; mov qword [rbx + 16], 1             skip returns 8 bytes on,
    //         mov qword [rbx + 24], 2                          past the first store
    //         call cold; mov [rbx + 32], rax; jmp done       cold starts untranslated
    // fib:    cmp ecx, 2; jb small; push rcx; dec ecx; call fib; pop rcx; push rax;
    //         sub ecx, 2; call fib; pop rdx; add rax, rdx; ret
    // small:  mov eax, ecx; ret
    // depth:  test ecx, ecx; jz zero; dec ecx; call depth; inc rax; ret
    // zero:   xor eax, eax; ret
    // skip:   add qword [rsp], 8; ret
    // cold:   pxor xmm0, xmm0; mov eax, 7; ret
    // done:
    const code = 'b90c000000e831000000488903b950000000e84300000048894308e84c00000048c7431001'
        + '00000048c7431802000000e83d00000048894320eb4183f902721751ffc9e8f3ffffff595083e902e8'
        + 'e9ffffff5a4801d0c389c8c385c9740bffc9e8f5ffffff48ffc0c331c0c34883042408c3660fefc0b8'
        + '07000000c3';
    const cases = CORPUS.cases.slice(0, 8).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `calls ${i}`, code }));
    /** @type {Record<string, number>} */
    const entered = {};
    for (const budget of [7, 100000])
    {
        for (const transfers of [true, false])
        {
            const { failures, exits, stats } = compare(cases, budget, transfers);
            assert.deepEqual(failures, [], `budget ${budget}, transfers ${transfers}`);
            assert.equal(exits, cases.length);
            entered[`${budget} ${transfers}`] = stats.entered;
        }
    }
    // The returns past a call too deep and the jumps out of a region go on
    // in wasm: the host enters regions less often.
    assert.ok(entered['100000 true'] * 2 < entered['100000 false'], JSON.stringify(entered));
});

test('a call loads back only what the code after it touches, and no store undoes a callee', ()=>{
    //         jmp start
    // f1:     add ebx, 7; movd xmm3, ebx; ret          writes what the caller then leaves alone
    // f2:     lea rax, [rbx + 100]; movd edx, xmm3     reads it, and writes it,
    //         add ebx, 3; paddd xmm3, xmm3; ret        which the caller's exit must keep
    // body:   test r10, r10; jz b
    //         mov ebx, 1; movd xmm3, ebx; jmp q        one way to q writes rbx and xmm3,
    // b:      call f1                                  the other comes from f1's return,
    // q:      call f2                                  whose values the call must keep
    //         add r13, rax; add r13, rdx; ret
    // start:  mov r12d, 4
    // again:  call body; dec r12d; jnz again           the later rounds' calls in wasm
    const code = 'eb3983c307660f6edbc3488d4364660f7eda83c303660ffedbc34d85d2740bbb01000000660f6edb'
        + 'eb05e8d3ffffffe8d6ffffff4901c54901d5c341bc04000000e8d4ffffff41ffcc75f6';
    const cases = CORPUS.cases.slice(0, 8).map((/** @type {any} */ one, /** @type {number} */ i)=>{
        const regs = [...one.regs];
        regs[10] = i % 2 === 0 ? '0' : '1';
        return { ...one, text: `fresh ${i}`, code, regs };
    });
    for (const budget of [7, 100000])
    {
        const { failures, exits } = compare(cases, budget);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
    }
});

test('indirect calls are wasm calls that return where they were made', ()=>{
    // start:  mov esi, 3
    // again:  lea rdx, [rip + fib]; mov ecx, 10; call rdx; add [rbx], rax
    //         lea rax, [rip + small]; mov [rbx + 64], rax; mov ecx, 7
    //         call qword [rbx + 64]; add [rbx + 8], rax; dec esi; jnz again; jmp done
    // fib:    cmp ecx, 2; jb small; push rcx; dec ecx; lea rdx, [rip + fib]; call rdx
    //         pop rcx; push rax; sub ecx, 2; call fib; pop rdx; add rax, rdx; ret
    // small:  mov eax, ecx; ret
    // done:
    const code = 'be03000000488d1527000000b90a000000ffd2480103488d053600000048894340b9070000'
        + '00ff534048014308ffce75d4eb2383f902721b51ffc9488d15f1ffffffffd2595083e902e8e5ff'
        + 'ffff5a4801d0c389c8c3';
    const cases = CORPUS.cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `indirect ${i}`, code }));
    /** @type {Record<string, number>} */
    const entered = {};
    for (const budget of [7, 100000])
    {
        for (const transfers of [true, false])
        {
            const { failures, exits, stats } = compare(cases, budget, transfers);
            assert.deepEqual(failures, [], `budget ${budget}, transfers ${transfers}`);
            assert.equal(exits, cases.length);
            entered[`${budget} ${transfers}`] = stats.entered;
        }
    }
    assert.ok(entered['100000 true'] * 4 < entered['100000 false'], JSON.stringify(entered));
});

test('a function called indirectly that jumps out past its caller does not return to it', ()=>{
    // start:  mov esi, 2
    // again:  xor eax, eax; call f
    // after:  add [rbx], rax; dec esi; jnz again; jmp done
    // f:      lea rdx, [rip + g]; call rdx; mov eax, 1000; ret
    // g:      mov eax, 7; add rsp, 16; lea rdx, [rip + after]; jmp rdx
    // done:
    // g leaves both frames by a jump to `after`, where the call to f waits:
    // the wasm call to g waits at f's `mov`, and must not take it for its own.
    const code = 'be0200000031c0e809000000480103ffce75f2eb21488d1508000000ffd2b8e8030000c3b8'
        + '070000004883c410488d15d8ffffffffe2';
    const cases = CORPUS.cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `jumped out ${i}`, code }));
    for (const budget of [7, 100000])
    {
        const { failures, exits } = compare(cases, budget);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
    }
});

test('a region left by a jump goes on expecting the return its caller waits for', ()=>{
    // start:  mov esi, 2
    // again:  mov ecx, 3; xor eax, eax; call f; add [rbx], rax; dec esi; jnz again; jmp done
    // f:      call g                                 a call made inside f's region
    // L:      inc eax; dec ecx; jz fret; lea rdx, [rip + far]; jmp rdx
    // fret:   ret
    // g:      ret
    // far:    add eax, 100; lea rdx, [rip + L]; jmp rdx
    // done:
    // The second pass calls f as a wasm call waiting at `add`; far, entered by a
    // transfer, leaves for L, the address f's own call to g waited at: only the
    // return `add` expects may end the wasm call, not that one.
    const code = 'be02000000b90300000031c0e809000000480103ffce75edeb22e810000000ffc0ffc97409'
        + '488d1504000000ffe2c3c383c064488d15e5ffffffffe2';
    const cases = CORPUS.cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `expect ${i}`, code }));
    for (const budget of [7, 100000])
    {
        const { failures, exits } = compare(cases, budget);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
    }
});

/** SSE forms, one instruction each, as llvm-mc assembles them. */
const SSE_FORMS = [
    ['f30f58c1', 'addss xmm0, xmm1'], ['f20f58c1', 'addsd xmm0, xmm1'],
    ['0f58c1', 'addps xmm0, xmm1'], ['660f58c1', 'addpd xmm0, xmm1'],
    ['0f5cd3', 'subps xmm2, xmm3'], ['f20f5cd3', 'subsd xmm2, xmm3'],
    ['0f59c1', 'mulps xmm0, xmm1'], ['f20f59e5', 'mulsd xmm4, xmm5'],
    ['0f5ec1', 'divps xmm0, xmm1'], ['f20f5ec1', 'divsd xmm0, xmm1'],
    ['f30f5ef7', 'divss xmm6, xmm7'], ['0f51c1', 'sqrtps xmm0, xmm1'],
    ['660f51c1', 'sqrtpd xmm0, xmm1'], ['f30f51d3', 'sqrtss xmm2, xmm3'],
    ['f20f51d3', 'sqrtsd xmm2, xmm3'], ['0f5dc1', 'minps xmm0, xmm1'],
    ['0f5fc1', 'maxps xmm0, xmm1'], ['660f5dc1', 'minpd xmm0, xmm1'],
    ['660f5fc1', 'maxpd xmm0, xmm1'], ['f30f5dc1', 'minss xmm0, xmm1'],
    ['f20f5fc1', 'maxsd xmm0, xmm1'], ['0fc2c100', 'cmpps xmm0, xmm1, 0'],
    ['0fc2c101', 'cmpps xmm0, xmm1, 1'], ['0fc2c102', 'cmpps xmm0, xmm1, 2'],
    ['0fc2c103', 'cmpps xmm0, xmm1, 3'], ['0fc2c104', 'cmpps xmm0, xmm1, 4'],
    ['0fc2c105', 'cmpps xmm0, xmm1, 5'], ['0fc2c106', 'cmpps xmm0, xmm1, 6'],
    ['0fc2c107', 'cmpps xmm0, xmm1, 7'], ['660fc2c101', 'cmppd xmm0, xmm1, 1'],
    ['f20fc2c105', 'cmpsd xmm0, xmm1, 5'], ['f30fc2c103', 'cmpss xmm0, xmm1, 3'],
    ['0f2fc1', 'comiss xmm0, xmm1'], ['0f2ec1', 'ucomiss xmm0, xmm1'],
    ['660f2fc1', 'comisd xmm0, xmm1'], ['660f2ec1', 'ucomisd xmm0, xmm1'],
    ['f3480f2ac0', 'cvtsi2ss xmm0, rax'], ['f2480f2ac0', 'cvtsi2sd xmm0, rax'],
    ['f30f2ac0', 'cvtsi2ss xmm0, eax'], ['f20f2ac0', 'cvtsi2sd xmm0, eax'],
    ['f30f2cc0', 'cvttss2si eax, xmm0'], ['f3480f2cc0', 'cvttss2si rax, xmm0'],
    ['f20f2cc0', 'cvttsd2si eax, xmm0'], ['f2480f2cc0', 'cvttsd2si rax, xmm0'],
    ['f30f2dc0', 'cvtss2si eax, xmm0'], ['f2480f2dc0', 'cvtsd2si rax, xmm0'],
    ['0f5bc1', 'cvtdq2ps xmm0, xmm1'], ['f30f5bc1', 'cvttps2dq xmm0, xmm1'],
    ['660f5bc1', 'cvtps2dq xmm0, xmm1'], ['f30fe6c1', 'cvtdq2pd xmm0, xmm1'],
    ['660fe6c1', 'cvttpd2dq xmm0, xmm1'], ['f20fe6c1', 'cvtpd2dq xmm0, xmm1'],
    ['f30f5ac1', 'cvtss2sd xmm0, xmm1'], ['f20f5ac1', 'cvtsd2ss xmm0, xmm1'],
    ['0f5ac1', 'cvtps2pd xmm0, xmm1'], ['660f5ac1', 'cvtpd2ps xmm0, xmm1'],
    ['660ff1c1', 'psllw xmm0, xmm1'], ['660fd2c1', 'psrld xmm0, xmm1'],
    ['660fe1c1', 'psraw xmm0, xmm1'], ['660fe2c1', 'psrad xmm0, xmm1'],
    ['660fd3c1', 'psrlq xmm0, xmm1'], ['660f73f03f', 'psllq xmm0, 63'],
    ['660f71d010', 'psrlw xmm0, 16'], ['660f71e014', 'psraw xmm0, 20'],
    ['660f73f805', 'pslldq xmm0, 5'], ['660f73d811', 'psrldq xmm0, 17'],
    ['660fe5c1', 'pmulhw xmm0, xmm1'], ['660fe4c1', 'pmulhuw xmm0, xmm1'],
    ['660ff4c1', 'pmuludq xmm0, xmm1'], ['660ff5c1', 'pmaddwd xmm0, xmm1'],
    ['660ff6c1', 'psadbw xmm0, xmm1'], ['660f63c1', 'packsswb xmm0, xmm1'],
    ['660f6bc1', 'packssdw xmm0, xmm1'], ['660f67c1', 'packuswb xmm0, xmm1'],
    ['660fd7c0', 'pmovmskb eax, xmm0'], ['0f50c0', 'movmskps eax, xmm0'],
    ['660f50c0', 'movmskpd eax, xmm0'], ['660fc5c005', 'pextrw eax, xmm0, 5'],
    ['660fc4c003', 'pinsrw xmm0, eax, 3'], ['660f70c11b', 'pshufd xmm0, xmm1, 0x1b'],
    ['f20f70c193', 'pshuflw xmm0, xmm1, 0x93'], ['f30f70c14e', 'pshufhw xmm0, xmm1, 0x4e'],
    ['0fc6c1b1', 'shufps xmm0, xmm1, 0xb1'], ['660fc6c102', 'shufpd xmm0, xmm1, 2'],
    ['0f14c1', 'unpcklps xmm0, xmm1'], ['660f15c1', 'unpckhpd xmm0, xmm1'],
    ['0f12c1', 'movhlps xmm0, xmm1'], ['0f16c1', 'movlhps xmm0, xmm1'],
    ['660f6ec0', 'movd xmm0, eax'], ['66480f6ec0', 'movq xmm0, rax'],
    ['66480f7ec0', 'movq rax, xmm0'], ['660f7ec0', 'movd eax, xmm0'],
    ['f30f7ec1', 'movq xmm0, xmm1'], ['f30f10c1', 'movss xmm0, xmm1'],
    ['f20f10c1', 'movsd xmm0, xmm1'], ['660fdfc1', 'pandn xmm0, xmm1'],
    ['0f55c1', 'andnps xmm0, xmm1'], ['660f66c1', 'pcmpgtd xmm0, xmm1'],
    ['660fe0c1', 'pavgb xmm0, xmm1'],
];

test('SSE on NaNs, infinities, zeros, denormals and the edges of conversion', ()=>{
    const singles = [0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x3fc00000, 0x40200000,
        0xc0200000, 0x3f000000, 0x4f000000, 0xcf000000, 0x4effffff, 0xcf000001, 0x7f800000,
        0xff800000, 0x7fc00001, 0x7f800001, 0xffc00002, 0xff800003, 0x00000001, 0x80000003,
        0x7f7fffff, 0x5f000000, 0xdf000000, 0x4f800000];
    const doubles = [0n, 1n << 63n, 0x3ff0000000000000n, 0xbff0000000000000n, 0x3ff8000000000000n,
        0x4004000000000000n, 0xc004000000000000n, 0x3fe0000000000000n, 0x41e0000000000000n,
        0xc1e0000000000000n, 0x41dfffffffe00000n, 0xc1e0000000100000n, 0xc1e0000000200000n,
        0x7ff0000000000000n, 0xfff0000000000000n, 0x7ff8000000000001n, 0x7ff0000000000001n,
        0xfff8000000000002n, 0xfff0000000000003n, 1n, 0x8000000000000003n, 0x7fefffffffffffffn,
        0x43e0000000000000n, 0xc3e0000000000000n, 0x4340000000000001n, 0x36a0000000000000n];
    const integers = [0n, 1n, (1n << 64n) - 1n, 0x7fffffffn, 0x80000000n, (1n << 63n) - 1n,
        1n << 63n, 0x20000001n, 0x0123456789abcdefn, (1n << 53n) + 1n,
        (1n << 64n) - (1n << 53n) - 1n, 0xffffffffn];
    let x = 0x9e3779b9;
    const next = ()=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
    const base = CORPUS.cases[0];
    const cases = [];
    for (const [code, text] of SSE_FORMS)
    {
        for (let k = 0; k < 24; k++)
        {
            const xmm = new Uint8Array(256);
            const view = new DataView(xmm.buffer);
            for (let reg = 0; reg < 16; reg++)
            {
                const kind = next() % 3;
                for (let lane = 0; lane < (kind === 1 ? 2 : 4); lane++)
                {
                    if (kind === 1)
                    {
                        view.setBigUint64(reg * 16 + lane * 8, doubles[next() % doubles.length],
                            true);
                    }
                    else
                    {
                        view.setUint32(reg * 16 + lane * 4,
                            kind === 0 ? singles[next() % singles.length] : next(), true);
                    }
                }
            }
            const regs = [...base.regs];
            regs[0] = integers[next() % integers.length].toString(16);
            // Rounding to nearest mostly; down, up and toward zero now and then.
            const mxcsr = 0x1f80 | (k % 4 === 3 ? (next() % 4) << 13 : 0);
            cases.push({ ...base, text: `${text} #${k}`, code, regs, xmm, mxcsr });
        }
    }
    // Both ways a host may be: an x86 one leaves a NaN as its instruction does, which is
    // the processor's; one whose default NaN is positive has an invalid operation's put
    // right, which on this host must change nothing either.
    for (const defaultNaNNegative of [undefined, false])
    {
        const { failures, stats } = compare(cases, 7, true, undefined, defaultNaNNegative);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > cases.length / 2, JSON.stringify(stats));
    }
});
