/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shared runtime over long mode's layout (`testing/runtime-runner64.js`):
 * its regions in modules, the entry hash and the transfers between them, its
 * invalidation of rewritten code, judged by the long-mode interpreter on the
 * hardware corpus and on seeded programs drawn from it, as the emitter alone
 * is (`emit/width64.itest.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CALLS, CORPUS, FAR_SWITCH, HOISTED_SWITCHES, MASKED_SWITCHES, SWITCHES, compare,
    flagsLeftUndefined, load,
    loopCases, machine, nested, pool, program, run,
} from '../testing/long-machine.js';
import { createRuntimeRunner64 } from '../testing/runtime-runner64.js';

/** @param {WebAssembly.Memory} memory @param {any} layout */
const runtime = (memory, layout)=>createRuntimeRunner64({ memory, layout });

test('the shared runtime runs long-mode code as the interpreter does on the corpus', ()=>{
    const { failures, exits, stats } = compare(CORPUS.cases, { budget: 7, makeRunner: runtime });
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
    assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
});

test('outside precise, as a program runs, the corpus\'s cases that run to their end run as'
    + ' interpreted', ()=>{
    // A read left untested reads RAM where a closed page or one past the window
    // faults: the cases where the interpreter faults are another answer by design.
    // The flags a case leaves undefined are the emitter's to leave as it will there.
    const interpreter = machine();
    const bytes = new Uint8Array(interpreter.memory.buffer);
    const clean = CORPUS.cases.flatMap((/** @type {any} */ one)=>{
        load(interpreter, one);
        const undefinedFlags = flagsLeftUndefined(interpreter.state,
            address=>bytes[interpreter.layout.ramBase + address]);
        load(interpreter, one);
        return undefinedFlags !== null && run(interpreter, false).fault === 'exit'
            ? [{ ...one, undefinedFlags }] : [];
    });
    const loose = (/** @type {WebAssembly.Memory} */ memory, /** @type {any} */ layout)=>
        createRuntimeRunner64({ memory, layout, config: { precise: false } });
    const { failures, exits, stats } = compare(clean, { budget: 7, makeRunner: loose });
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.equal(exits, clean.length);
    assert.ok(clean.length > CORPUS.cases.length * 0.8, `${clean.length} cases`);
    assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
});

test('seeded long programs run in the shared runtime as interpreted', ()=>{
    const instructions = pool();
    const straight = Array.from({ length: 200 },
        (_, i)=>program(instructions, 0x7eed + i, 20 + i % 60));
    const loops = Array.from({ length: 150 }, (_, i)=>nested(instructions, 0x2005 + i));
    for (const [cases, budget] of /** @type {const} */ ([[straight, 7], [loops, 1000]]))
    {
        const { failures, exits, stats } = compare(cases, { budget, makeRunner: runtime });
        assert.ok(exits > cases.length * 0.6, `${exits} programs ran to their exit`);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
});

test('calls and returns, switches among them, run in the shared runtime as interpreted', ()=>{
    const cases = [...Object.entries(CALLS), ['switches', SWITCHES],
        ['hoisted', HOISTED_SWITCHES], ['masked', MASKED_SWITCHES]].flatMap(([name, code])=>CORPUS
        .cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>{
            const regs = [...one.regs];
            regs[10] = i % 2 === 0 ? '0' : '1';
            return { ...one, text: `${name} ${i}`, code, regs };
        }));
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(cases, { budget, makeRunner: runtime });
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
});

test('a return to its call\'s address past the 4 GiB window faults as interpreted', ()=>{
    // call f (or call rdi, f a region of its own whose ret goes back to the wasm call
    // waiting for it); jmp done; f: [bts qword [rsp], 32]; ret -- three turns on esi,
    // the last with the return address moved past the window: its low half the call's own.
    const codes = ['be03000000e806000000ffce75f7eb0c83fe017506480fba2c2420c3',
        'be03000000488d3d08000000ffd7ffce75faeb0c83fe017506480fba2c2420c3'];
    const cases = codes.flatMap(code=>CORPUS.cases.slice(0, 4).map((/** @type {any} */ one,
        /** @type {number} */ i)=>({ ...one, text: `far return ${i}`, code })));
    for (const budget of [7, 100000])
    {
        const { failures, stats } = compare(cases, { budget, makeRunner: runtime });
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.ok(stats.translated > 0, JSON.stringify(stats));
    }
});

test('a switch whose entry is rewritten past the 4 GiB window faults as interpreted', ()=>{
    const cases = CORPUS.cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `far ${i}`, code: FAR_SWITCH }));
    for (const budget of [7, 100000])
    {
        const { failures, stats } = compare(cases, { budget, makeRunner: runtime });
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
});

test('loops whose accesses move by a stride run as interpreted, to the turn a page or the'
    + ' 4 GiB window stops them', ()=>{
    const cases = loopCases();
    for (const budget of [7, 100000])
    {
        const { failures, stats } = compare(cases, { budget, makeRunner: runtime });
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
});

test('the interpreter tier in wasm runs translated code\'s misses in place,'
    + ' as interpreted', ()=>{
    // Every start hot at once and formed where it is first met: a miss is a target
    // the runtime has not formed yet, the tier taking it from inside the region.
    const tiered = (/** @type {WebAssembly.Memory} */ memory, /** @type {any} */ layout,
        /** @type {any} */ tier)=>createRuntimeRunner64({ memory, layout, tier });
    const cases = [...loopCases(), ...Object.values(CALLS).flatMap(code=>CORPUS.cases.slice(0, 2)
        .map((/** @type {any} */ one)=>({ ...one, text: 'calls', code })))];
    for (const budget of [7, 100000])
    {
        const { failures, stats } = compare([...CORPUS.cases.slice(0, 600), ...cases],
            { budget, tiered: true, makeRunner: tiered });
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.ok(stats.tiered > 0, JSON.stringify(stats));
    }
});

test('stos and movs run in the shared runtime as interpreted: by pages, across them,'
    + ' into a closed one', ()=>{
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
                // and toward the closed page past the data, an element across
                // into it.
                for (const at of [0x10, 0xffe, 0x1ff8 - 0x40, CORPUS.dataSize - 0x100,
                    CORPUS.dataSize - 0x103])
                {
                    for (const down of [false, true])
                    {
                        const shapes = op === 'stos'
                            ? [[0n, 0n], [0x4141414141414141n, 0n], [0x1234n, 0n]]
                            // The source behind the destination by an element or two, or
                            // by bytes that are no whole elements, or by a hundred (the
                            // processor copies forward through what it wrote), apart, and
                            // ahead.
                            : [[0n, -1n], [0n, -8n], [0n, -3n], [0n, -6n], [0n, -100n],
                                [0n, 0x400n], [0n, 3n]];
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
    const { failures, exits, stats } = compare(cases, { makeRunner: runtime });
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    // Some ran to the closed page, most did not; most ran translated.
    assert.ok(exits > cases.length / 2 && exits < cases.length,
        `${exits} of ${cases.length} ran to their exit`);
    assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
});
