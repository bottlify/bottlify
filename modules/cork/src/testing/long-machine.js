/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The long-mode translator's test harness: a machine over the hardware
 * corpus's areas (`x64-corpus.json.gz`), its cases and seeded programs run as
 * translated regions and on the interpreter alone, and what a program can see
 * compared (`compare`). The suites in `long/runtime*.test.js` share it.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ownLayout, pageFlagsAt, pagesFor, tablesSize } from '../runtime/layout.js';
import { PageFlag, createPageTable } from '../runtime/pages.js';
import { blockState64, interpret64 } from '../interp64.js';
import { MODE_64, decode } from '../decode/decoder.js';
import { createLongRunner } from '../long/runtime.js';
import {
    WASM_INTERPRETER_AREA, WASM_INTERPRETER_STATICS_AT, createWasmInterpreter,
} from '../interp-wasm.js';
import { endsBlock, translates } from '../long/emit.js';

export const CORPUS = JSON.parse(gunzipSync(readFileSync(new URL('../x64-corpus.json.gz',
    import.meta.url))).toString('utf8'));
/** CF, PF, AF, ZF, SF and OF. */
export const STATUS = 0x8d5;
/** Where the runner's exit jump goes: a closed page, whose fetch ends the case. */
export const EXIT = 0x1f000000;

/** @param {number} seed @param {number} size */
export function fill(seed, size){
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
 * @param {boolean} [leafCalls]  false: every call a wasm call, no callee formed in
 * @param {number} [volatileWindowMs]  the runner's: none by default, so that the cases'
 *     code, written over for each, is never left to the interpreter
 * @param {number} [trapPort]
 * @param {boolean} [tiered]  what no region holds runs on the interpreter tier in wasm
 *     (`createWasmInterpreter`), `interp64.js` taking what it hands back
 * @param {((memory: WebAssembly.Memory, layout: any) => any) | null} [makeRunner]  a
 *     runner of another translator in the long runner's place (`shared-runner64.js`)
 *
 * Its regions are gathered into one module every three (`packRegions`), so every case
 * runs packed regions beside fresh ones.
 */
export function machine(transfers = true, checkReads = undefined, looseStacks = undefined,
    defaultNaNNegative = undefined, leafCalls = true, volatileWindowMs = 0,
    /** @type {number | undefined} */ trapPort = undefined, tiered = false, makeRunner = null)
{
    const ramSize = CORPUS.codeAt + 0x100000;
    const layout = ownLayout({ ramSize, ramBase: 0, bits: 64 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout,
        tablesSize(layout) + (tiered ? WASM_INTERPRETER_AREA : 0)) });
    const flags = new Uint8Array(memory.buffer, pageFlagsAt(layout), 1 << 20);
    flags.fill(PageFlag.INACCESSIBLE);
    for (const [at, size] of [[CORPUS.dataAt, CORPUS.dataSize], [CORPUS.codeAt, CORPUS.codeSize]])
    {
        flags.fill(0, at >>> 12, (at + size) >>> 12);
    }
    const pages = createPageTable(memory, layout);
    const tier = tiered ? createWasmInterpreter({ memory, layout,
        area: layout.tables + tablesSize(layout),
        statics: layout.regs + WASM_INTERPRETER_STATICS_AT, hotThreshold: 1, trapPort,
        parkBase: 0 }) : null;
    const runner = makeRunner !== null ? makeRunner(memory, layout) : createLongRunner({
        memory, layout, pages, hot: 1, transfers, checkReads,
        looseStacks, leafCalls, volatileWindowMs, callTargets: true, packRegions: 3, tier,
        ...(defaultNaNNegative === undefined ? {} : { defaultNaNNegative }),
        ...(trapPort === undefined ? {} : { trapPort }) });
    /** The writes to ports other than the trap port, each port and value. @type {number[][]} */
    const writes = [];
    const ports = trapPort === undefined ? undefined : {
        trapPort,
        read: ()=>0xffffffff,
        /** @param {number} port @param {number} size @param {number} value */
        write: (port, size, value)=>writes.push([port, size, value]),
    };
    const state = blockState64({ memory, layout, ports,
        onCodeWrite: (at, size)=>runner.invalidate(at, size) });
    return { layout, memory, state, runner, writes, view: new DataView(memory.buffer) };
}

/**
 * Every instruction of the corpus the translator takes that leaves the
 * stack, the pointer and index registers and r15 alone, as its bytes: the
 * pool the seeded programs are drawn from.
 */
export function pool(){
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
export function program(instructions, seed, count){
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
export function nested(instructions, seed){
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
export function load(m, one){
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
export function run(m, translated, budget = 7){
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
 * @param {boolean} [leafCalls]  its small callees formed into their callers (`machine`)
 * @param {number} [volatileWindowMs]  its runner's (`machine`)
 * @param {boolean} [tiered]  its runner's (`machine`)
 * @param {((memory: WebAssembly.Memory, layout: any) => any) | null} [makeRunner]  (`machine`)
 */
export function compare(cases, budget = 7, transfers = true, checkReads = undefined,
    defaultNaNNegative = undefined, leafCalls = true, volatileWindowMs = 0, tiered = false,
    makeRunner = null)
{
    const translatedMachine = machine(transfers, checkReads, undefined, defaultNaNNegative,
        leafCalls, volatileWindowMs, undefined, tiered, makeRunner);
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

/**
 * Four switches run eight rounds, then eight more after a table is rewritten, each
 * case changing a word of [rbx] its own way (`long/runtime.test.js` gives the
 * source): GCC's absolute quadwords, MSVC's RVAs from a base, MinGW's offsets and a
 * table in the data area the program fills.
 */
export const SWITCHES = ''
    + '488d05d40000004889042540000010488d05cc0000004889042548000010488d05c4000000488904'
    + '25500000104531c931f683fe05772889f0ff24c52001002048830301eb204883030aeb1a48830364'
    + '48830303eb10486b0b0348890beb07488103e803000083fe0477294863c6488d158bffffff8b8c82'
    + '500100004801d1ffe14883430807eb1148836b0805eb0a48837308554883430802897318837b1803'
    + '77268b4318488d15b8000000486304824801d0ffe0488343100beb1148d16310eb0b48f75310eb05'
    + '488343100d83fe02771d89f0ff24c5400000104883432011eb1248c1432003eb0b48f75b20eb0548'
    + '83432013ffc683fe080f8233ffffff4585c9757041ffc1488d05dbffffff488904254800001031f6'
    + 'e915ffffff0f1f00400000200000000046000020000000004c000020000000005000002000000000'
    + '56000020000000005f0000200000000081000000880000008f0000008f0000008100000051ffffff'
    + '58ffffff5effffff51ffffff';

/** Clang's tables, the base's `lea` hoisted out of each loop (`long/runtime.test.js`). */
export const HOISTED_SWITCHES = ''
    + '4c8d2ddd00000031f6488d0502000000ffe089f083e0034883f803772349634c85004c01e9ffe148'
    + '830301eb134883030aeb0d486b1303488913eb0448832b07ffc681fec800000072c84c8d25a30000'
    + '0031f6eb0089f083e0034883f803772149630c844c01e1ffe148317308eb124883430805eb0b48c1'
    + '430803eb0448f75308ffc681fec800000072ca31f6488d0502000000ffe089f183e1034883f90377'
    + '2749634c8df04c01e9ffe14883431003eb16486b53100548895310eb0b48317310eb0548c14b1007'
    + 'ffc681fec800000072c4eb30c7ffffffceffffffd9ffffffdfffffff43ffffff49ffffff4fffffff'
    + '58ffffff75ffffff7bffffff82ffffff89ffffff';
