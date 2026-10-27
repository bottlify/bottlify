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
    CALLS, CORPUS, HOISTED_SWITCHES, MASKED_SWITCHES, SWITCHES, compare, flagsLeftUndefined, load,
    loopCases, machine, nested, pool, program, run,
} from '../testing/long-machine.js';
import { createRuntimeRunner64 } from '../testing/runtime-runner64.js';

/** @param {WebAssembly.Memory} memory @param {any} layout */
const runtime = (memory, layout)=>createRuntimeRunner64({ memory, layout });

test('the shared runtime runs long-mode code as the interpreter does on the corpus', ()=>{
    const { failures, exits, stats } = compare(CORPUS.cases, 7, true, undefined, undefined,
        true, 0, false, runtime);
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
    const { failures, exits, stats } = compare(clean, 7, true, undefined, undefined, true, 0,
        false, loose);
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
        const { failures, exits, stats } = compare(cases, budget, true, undefined, undefined,
            true, 0, false, runtime);
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
        const { failures, exits, stats } = compare(cases, budget, true, undefined, undefined,
            true, 0, false, runtime);
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
});

test('loops whose accesses move by a stride run as interpreted, to the turn a page or the'
    + ' 4 GiB window stops them', ()=>{
    const cases = loopCases();
    for (const budget of [7, 100000])
    {
        const { failures, stats } = compare(cases, budget, true, undefined, undefined, true, 0,
            false, runtime);
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
        const { failures, stats } = compare([...CORPUS.cases.slice(0, 600), ...cases], budget,
            true, undefined, undefined, true, 0, true, tiered);
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.ok(stats.tiered > 0, JSON.stringify(stats));
    }
});
