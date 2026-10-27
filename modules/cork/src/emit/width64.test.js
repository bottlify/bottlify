/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shared emitter at long mode's width (`width.js`) judged by the
 * long-mode interpreter, as the long translator is (`testing/long-machine.js`):
 * every case of the hardware corpus and seeded programs drawn from it, run as
 * the emitter's regions (`testing/shared-runner64.js`) and on the interpreter
 * alone, and everything a program can see compared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, compare, nested, pool, program } from '../testing/long-machine.js';
import { createSharedRunner64 } from '../testing/shared-runner64.js';

/** @param {WebAssembly.Memory} memory @param {any} layout */
const shared = (memory, layout)=>createSharedRunner64({ memory, layout });

test('long-mode regions of the shared emitter do what the interpreter does on the corpus', ()=>{
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(CORPUS.cases, budget, true, undefined,
            undefined, true, 0, false, shared);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
        assert.ok(stats.translated > 5000, JSON.stringify(stats));
    }
});

test('seeded long programs run in the shared emitter\'s regions as interpreted', ()=>{
    const instructions = pool();
    const straight = Array.from({ length: 600 },
        (_, i)=>program(instructions, 0x5eed + i, 20 + i % 60));
    const loops = Array.from({ length: 400 }, (_, i)=>nested(instructions, 0x1005 + i));
    for (const [cases, budget] of /** @type {const} */ ([[straight, 7], [loops, 7],
        [loops, 1000]]))
    {
        const { failures, exits, stats } = compare(cases, budget, true, undefined, undefined,
            true, 0, false, shared);
        assert.ok(exits > cases.length * 0.6, `${exits} programs ran to their exit`);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > 0, JSON.stringify(stats));
    }
});
