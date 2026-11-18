/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPageRuns } from './page-runs.js';

const PAGE = 4096;

test('page runs read as a value per page does, over seeded sets and clears', ()=>{
    let seed = 0x2545;
    /** @param {number} n */
    const next = n=>{
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) % n;
    };
    for (let round = 0; round < 200; round++)
    {
        const base = 0x10000000;
        const pages = 1 + next(64);
        /** @type {ReturnType<typeof createPageRuns<number>>} */
        const runs = createPageRuns();
        /** @type {Map<number, number>} */
        const model = new Map();
        for (let step = 0; step < 60; step++)
        {
            const first = next(pages);
            const count = 1 + next(pages - first);
            const from = base + first * PAGE;
            const to = from + count * PAGE;
            if (next(4) === 0)
            {
                runs.clear(from, to);
                for (let at = from; at < to; at += PAGE)
                {
                    model.delete(at);
                }
            }
            else
            {
                const value = 1 + next(3);
                runs.set(from, to, value);
                for (let at = from; at < to; at += PAGE)
                {
                    model.set(at, value);
                }
            }
            const fallback = 1 + next(3);
            let changes = 0;
            for (let page = 0; page < pages; page++)
            {
                const at = base + page * PAGE;
                assert.equal(runs.get(at), model.get(at),
                    `round ${round} step ${step} page ${page}`);
                // The stretch from here that reads as one value, a page with none as the fallback.
                const value = model.get(at) ?? fallback;
                let end = at;
                while (end < base + pages * PAGE && (model.get(end) ?? fallback) === value)
                {
                    end += PAGE;
                }
                assert.equal(runs.extent(at, base + pages * PAGE, fallback), end,
                    `round ${round} step ${step}: extent from page ${page}`);
                const before = model.get(at - PAGE);
                if (model.has(at) && (before === undefined || before !== model.get(at)))
                {
                    changes++;
                }
            }
            assert.equal(runs.size, changes, 'as few runs as the values need');
            // A window's runs, cut to it, cover exactly its pages that hold a value.
            const low = base + next(pages) * PAGE;
            const high = low + (1 + next(pages)) * PAGE;
            /** @type {Map<number, number>} */
            const covered = new Map();
            for (const run of runs.within(low, high))
            {
                assert.ok(run.from >= low && run.to <= high && run.from < run.to);
                for (let at = run.from; at < run.to; at += PAGE)
                {
                    covered.set(at, run.value);
                }
            }
            for (let at = low; at < high; at += PAGE)
            {
                assert.equal(covered.get(at), model.get(at), `round ${round}: within at ${at}`);
            }
        }
    }
});

test('a gigabyte given one value is one run, and given it again costs nothing more', ()=>{
    /** @type {ReturnType<typeof createPageRuns<number>>} */
    const runs = createPageRuns();
    const base = 0x40000000;
    for (let k = 0; k < 1000; k++)
    {
        runs.set(base, base + 2 ** 30, 0x04);
    }
    assert.equal(runs.size, 1, 'a thousand commits of it leave one run, not a million entries');
});
