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
 * translator keeps them as the model does), the XMM registers, the data
 * buffer, and a fault's vector and instruction.
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

/** A machine with the corpus's data and code areas open and every other page closed. */
function machine(){
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
    const runner = createLongRunner({ memory, layout, pages, hot: 1 });
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
    view.setUint32(layout.mxcsr, 0x1f80, true);
    bytes.set(fill(one.seed ^ CORPUS.xmmSeed, 256), layout.xmm);
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
        data: Buffer.from(bytes.subarray(CORPUS.dataAt, CORPUS.dataAt + CORPUS.dataSize))
            .toString('base64'),
    };
}

/**
 * Runs every case on both machines and answers the differences.
 *
 * @param {any[]} cases @param {number} [budget]  each translated run's
 */
function compare(cases, budget = 7){
    const translatedMachine = machine();
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
        for (const key of /** @type {const} */ (['fault', 'rip', 'retired', 'flags', 'xmm',
            'data']))
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
    const { failures, stats, exits } = compare(cases);
    // A division from the pool raises #DE in some (both ways alike); most run through.
    assert.ok(exits > cases.length * 0.6, `${exits} programs ran to their exit`);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(stats.translated > stats.interpreted * 2,
        `translated ${stats.translated}, interpreted ${stats.interpreted}`);
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
            BigInt(CORPUS.dataAt - 1), 1n << 32n, (1n << 32n) - 4n, (1n << 64n) - 4n])
        {
            cases.push(edge(code, rbx));
        }
    }
    const { failures, exits } = compare(cases);
    assert.deepEqual(failures, []);
    // Some ran clean, most faulted: both ways were taken.
    assert.ok(exits > 0 && exits < cases.length, `${exits} of ${cases.length} ran to their exit`);
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
    for (const budget of [7, 100000])
    {
        const { failures, exits } = compare(cases, budget);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
    }
});
