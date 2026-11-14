/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createMemoryBudget, openMemoryBudget } from './memory-budget.js';

const MiB = 1 << 20;

test('a budget gives what fits, refuses what does not, and takes back what is given', ()=>{
    const budget = openMemoryBudget(createMemoryBudget(100 * MiB));
    assert.equal(budget.take(60 * MiB), true);
    assert.equal(budget.take(50 * MiB), false, 'past the machine');
    assert.equal(budget.report().used, 60 * MiB, 'a refusal takes nothing');
    assert.equal(budget.take(40 * MiB), true, 'up to the last page');
    budget.give(30 * MiB);
    assert.equal(budget.fits(30 * MiB), true);
    assert.equal(budget.fits(31 * MiB), false);
    assert.deepEqual({ ...budget.report(), limit: 0, byKind: undefined },
        { limit: 0, used: 70 * MiB, peak: 100 * MiB, refused: 1, made: 0, dropped: 0,
            byKind: undefined });
});

test('a part of a page is a whole page, as a memory grows by whole pages', ()=>{
    const budget = openMemoryBudget(createMemoryBudget(65536 * 2));
    assert.equal(budget.take(1), true);
    assert.equal(budget.take(65537), false);
    assert.equal(budget.take(65536), true);
});

test('threads taking at once never take past the machine together', async()=>{
    // Four threads each try to take a page 10 000 times from a machine of
    // 1000 pages: a check and a store apart would let two take the last page.
    const buffer = createMemoryBudget(1000 * 65536);
    const source = `
        const { workerData, parentPort } = require('node:worker_threads');
        import(${JSON.stringify(new URL('./memory-budget.js', import.meta.url).href)})
            .then(({ openMemoryBudget })=>{
                const budget = openMemoryBudget(workerData);
                let got = 0;
                for (let i = 0; i < 10000; i++) { if (budget.take(65536)) got++; }
                parentPort.postMessage(got);
            });`;
    const counts = await Promise.all(Array.from({ length: 4 }, ()=>new Promise((resolve, reject)=>{
        const worker = new Worker(source, { eval: true, workerData: buffer });
        worker.once('message', resolve);
        worker.once('error', reject);
    })));
    const report = openMemoryBudget(buffer).report();
    assert.equal(counts.reduce((sum, count)=>sum + /** @type {number} */ (count), 0), 1000);
    assert.equal(report.used, report.limit);
    assert.equal(report.peak, report.limit);
});

test('each kind keeps its own sum, and all kinds share the one limit', ()=>{
    const budget = openMemoryBudget(createMemoryBudget(100 * MiB));
    assert.equal(budget.take(40 * MiB, 'guest'), true);
    assert.equal(budget.take(30 * MiB, 'translation'), true);
    assert.equal(budget.take(20 * MiB, 'engine'), true);
    assert.equal(budget.take(20 * MiB, 'heaps'), false, 'past the machine, whatever the kind');
    budget.give(10 * MiB, 'translation');
    assert.equal(budget.take(20 * MiB, 'heaps'), true);
    assert.deepEqual(budget.report().byKind,
        { guest: 40 * MiB, engine: 20 * MiB, translation: 20 * MiB, heaps: 20 * MiB });
});

test('a charge takes whole pages only as its sum crosses them, each byte weighed', async()=>{
    const { openCharge } = await import('./memory-budget.js');
    const budget = openMemoryBudget(createMemoryBudget(10 * 65536));
    const charge = openCharge(budget, 'translation', 2);
    for (let i = 0; i < 16; i++)
    {
        assert.equal(charge.take(4096), true, 'sixteen 4 KiB modules');
    }
    assert.equal(budget.report().byKind.translation, 2 * 65536, '64 KiB weighed twice: two pages');
    assert.equal(charge.take(5 * 65536), false, 'past the machine');
    charge.give(16 * 4096);
    assert.equal(budget.report().used, 0);
});

test('a holder\'s memory is given back at once however it ended, and a memory moves'
    + ' between holders without the sum moving', ()=>{
    const buffer = createMemoryBudget(100 * MiB);
    const run = openMemoryBudget(buffer);
    const first = run.claim();
    const second = run.claim();
    assert.ok(first > 0 && second > 0 && first !== second);
    const process = openMemoryBudget(buffer, first);
    assert.equal(process.take(30 * MiB, 'guest'), true);
    assert.equal(process.take(10 * MiB, 'translation'), true);
    // Its memory kept by the run for the next process.
    process.move(30 * MiB, 'guest', 0);
    assert.equal(run.release(first), 10 * MiB, 'only what it still held');
    assert.deepEqual(run.report().byKind, { guest: 30 * MiB, engine: 0, translation: 0, heaps: 0 });
    // The next process takes the kept memory, then is gone without a word.
    run.move(30 * MiB, 'guest', second);
    assert.equal(run.release(second), 30 * MiB);
    assert.equal(run.report().used, 0);
    assert.equal(run.claim(), first, 'a released holder is claimed again');
});
