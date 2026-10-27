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
 * is (`emit/width64.test.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CALLS, CORPUS, HOISTED_SWITCHES, SWITCHES, compare, nested, pool, program,
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
        ['hoisted', HOISTED_SWITCHES]].flatMap(([name, code])=>CORPUS.cases.slice(0, 4)
        .map((/** @type {any} */ one, /** @type {number} */ i)=>{
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
