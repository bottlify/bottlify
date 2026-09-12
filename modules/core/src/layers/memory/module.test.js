/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGION_COLUMNS, memoryModule } from './module.js';
import { createMetrics } from '../log/internal/metrics.js';
import { readTable } from '../log/internal/table.js';

/** A log layer that only publishes, with a dictionary that numbers words in order. */
function fakeLog(){
    /** @type {string[]} */
    const words = [];
    const metrics = createMetrics({ shared: false });
    return {
        words,
        metrics,
        /** @param {string} text */
        intern: text=>{
            const at = words.indexOf(text);
            return at >= 0 ? at : words.push(text) - 1;
        },
    };
}

/** @param {any} log */
async function open(log){
    return memoryModule.create({}, /** @type {any} */ ({
        /** @param {string} name */
        requireApi: name=>(name === 'log' ? log : {}),
        provide: ()=>{},
    }));
}

test('the layout is published as a table, lowest first, and kept current', async()=>{
    const log = fakeLog();
    const memory = await open(log);
    memory.register({ name: 'stack', base: 0x300000, size: 0x10000, kind: 'stack', access: 'rw' });
    memory.register({ name: 'game.exe', base: 0x400000, size: 0x200000, kind: 'image',
        access: 'rx' });
    memory.register({ name: 'low', base: 0, size: 0x1000, kind: 'low-mem', access: 'rw' });

    const table = readTable(log.metrics.describe().memory.regions);
    assert.deepEqual(table.columns, REGION_COLUMNS);
    const rows = table.all();
    assert.deepEqual(rows.map(row=>log.words[row.name]), ['low', 'stack', 'game.exe']);
    assert.deepEqual(rows.map(row=>row.base), [0, 0x300000, 0x400000]);
    assert.equal(rows[2].size, 0x200000);

    memory.protect('game.exe', 'rwx');
    assert.equal(table.all()[2].access, Object.values(memory.Access).indexOf('rwx'),
        'a reprotected region is republished');
    await memoryModule.dispose();
});

test('the diagnostics table is the cold path and a fake log without a registry is fine', async()=>{
    const memory = await open({});
    memory.register({ name: 'stack', base: 0x300000, size: 0x10000, kind: 'stack', access: 'rw' });
    const metrics = /** @type {any} */ (memoryModule.diagnostics().metrics);
    assert.equal(metrics.regions, 1);
    assert.deepEqual(metrics.layout, ['stack 0x300000+0x10000 rw']);
    await memoryModule.dispose();
});
