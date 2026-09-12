/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createTable, readTable } from './table.js';

test('a value stored where it happens is what a reader picks up', ()=>{
    const table = createTable({ rows: 2, columns: ['turns', 'boosts'] });
    table.add(0, 0, 3);
    table.add(0, 0, 4);
    table.set(1, 1, 9);
    table.used(2);

    const reader = readTable(table.describe());
    assert.deepEqual(reader.all(), [{ turns: 7, boosts: 0 }, { turns: 0, boosts: 9 }]);
    assert.equal(reader.used(), 2);
});

test('a ring of rows reads oldest first once it has lapped', ()=>{
    const table = createTable({ rows: 3, columns: ['index'] });
    for (let at = 0; at < 5; at++)
    {
        table.set(table.advance(), 0, at);
    }
    const reader = readTable(table.describe());
    assert.equal(reader.written(), 5);
    assert.deepEqual(reader.all().map(row=>row.index), [2, 3, 4]);
});

test('a reader on another thread sees a store the writer made after handing the memory over',
    async()=>{
        const table = createTable({ rows: 1, columns: ['instructions'] });
        table.used(1);
        const worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            import(workerData.url).then(({ readTable })=>{
                const reader = readTable(workerData.descriptor);
                const look = ()=>{
                    const value = reader.row(0).instructions;
                    if (value === 12345) { parentPort.postMessage(value); }
                    else { setTimeout(look, 1); }
                };
                look();
            });
        `, {
            eval: true,
            workerData: { url: new URL('./table.js', import.meta.url).href,
                descriptor: table.describe() },
        });
        const seen = new Promise(resolve=>worker.once('message', resolve));
        table.set(0, 0, 12345);
        assert.equal(await seen, 12345);
        await worker.terminate();
    });
