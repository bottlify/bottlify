/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the wide window (`wideLayout`): long-mode code translated over
 * an 8 or 16 GiB window, its RAM a `memory64` memory of its own, runs the
 * hardware corpus as the long-mode interpreter does over the same window --
 * with the data the cases read and write, and the registers pointing into it,
 * past 4 GiB, where every access takes its address's high half.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, compare } from '../testing/long-machine.js';

for (const [window, high] of /** @type {const} */ ([[2 ** 33, 0], [2 ** 33, 2 ** 32],
    [2 ** 34, 3 * 2 ** 32]]))
{
    test(`a ${window / 2 ** 30} GiB window, the data ${high / 2 ** 30} GiB past its place:`
        + ' translated as interpreted', ()=>{
        const { failures, exits, stats } = compare(CORPUS.cases, { budget: 7, window, high });
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
        assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
    });
}
