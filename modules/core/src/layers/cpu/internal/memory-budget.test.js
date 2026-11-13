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
    assert.deepEqual({ ...budget.report(), limit: 0 },
        { limit: 0, used: 70 * MiB, peak: 100 * MiB, refused: 1, made: 0, dropped: 0 });
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
