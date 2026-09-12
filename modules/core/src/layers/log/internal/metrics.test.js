/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics } from './metrics.js';
import { readTable } from './table.js';

test('a layer registers its counters once and updates them in place', ()=>{
    const metrics = createMetrics();
    const cpu = metrics.counters('cpu', ['instructions', 'eip']);
    cpu[0] += 1000;
    cpu[0] += 500;
    cpu[1] = 0x401000;

    const description = metrics.describe();
    assert.deepEqual(Object.keys(description), ['cpu']);
    assert.deepEqual(description.cpu.counters.columns, ['instructions', 'eip']);
    assert.deepEqual(readTable(description.cpu.counters).row(0),
        { instructions: 1500, eip: 0x401000 });
});

test('a name is published once: a second table under it is a mistake', ()=>{
    const metrics = createMetrics();
    metrics.table('kernel', 'threads', { rows: 4, columns: ['id'] });
    assert.throws(()=>metrics.table('kernel', 'threads', { rows: 4, columns: ['id'] }),
        /already publishes/);
});

test('a sampler runs when asked and not otherwise', ()=>{
    const metrics = createMetrics();
    let samples = 0;
    const remove = metrics.onFrame(()=>{ samples++; });
    metrics.sample();
    metrics.sample();
    remove();
    metrics.sample();
    assert.equal(samples, 2);
});
