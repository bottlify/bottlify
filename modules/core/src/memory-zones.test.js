/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAccount } from '@bottlify/cellar';
import { NOT_MEASURED, withZones, zonesTable } from './memory-zones.js';
import { createRunAccount } from './layers/cache/account.js';

const MIB = 1024 * 1024;

/** The run's account holding these, as the cpu layer reports it. @param {Record<string, number>} kinds */
const accountOf = (kinds, machineMemory = 1024 * MIB)=>{
    const account = openAccount(createRunAccount({ machineMemory }));
    for (const [kind, bytes] of Object.entries(kinds))
    {
        assert.equal(account.take(bytes, kind), true);
    }
    return { ...account.report(), refusedGrows: 0 };
};

test('the account is the sum, each accounted zone\'s pools beside it; what no account counts is '
    + 'named, and a layer that says nothing is named not measured', ()=>{
    const machineMemory = accountOf({ guest: 512 * MIB, engine: 32 * MIB, translation: 16 * MIB,
        cache: 16 * MIB });
    const table = zonesTable([
        { name: 'cpu', metrics: { machineMemory, bytesHeld: {
            guest: { heap: 500 * MIB },
            translation: { tables: 16 * MIB, modules: NOT_MEASURED } } } },
        { name: 'app', metrics: { bytesHeld: { heaps: { blockCache: 3 * MIB } } } },
        { name: 'graphics', metrics: { bytesHeld: {
            heaps: { mirror: 2 * MIB, worker: NOT_MEASURED },
            device: { textures: 100 * MIB } } } },
        { name: 'kernel', metrics: { threads: 3 } },
    ]);
    assert.equal(table.name, 'zones');
    assert.equal(table.status, 'ready');
    const { account, zones, total, outside, notAccounted, limit } = table.metrics;
    assert.equal(limit, 1024 * MIB);
    assert.deepEqual(account.kinds, { cache: 16 * MIB, blocks: 0, guest: 512 * MIB,
        engine: 32 * MIB, translation: 16 * MIB });
    assert.equal(Object.values(account.kinds).reduce((/** @type {number} */ sum, bytes)=>sum
        + /** @type {number} */ (bytes), 0), account.used, 'the report sums to the account');
    assert.equal(zones.guest.accounted, 512 * MIB);
    assert.deepEqual(zones.guest.pools, { 'cpu.heap': 500 * MIB }, 'held in the account\'s sum');
    assert.deepEqual(zones.translation.notMeasured, ['cpu.modules']);
    assert.deepEqual(notAccounted, { 'app.blockCache': 3 * MIB, 'graphics.mirror': 2 * MIB,
        'graphics.worker': NOT_MEASURED, kernel: NOT_MEASURED },
    'every byte no account counts, by name; a layer that says nothing is not taken for zero');
    assert.equal(total, 576 * MIB + 5 * MIB, 'the account and what it does not count');
    assert.deepEqual(outside, { device: { 'graphics.textures': 100 * MIB } });
});

test('past the account\'s limit with what it does not count, the table is over', ()=>{
    const machineMemory = accountOf({ guest: 60 * MIB }, 64 * MIB);
    const table = zonesTable([{ name: 'cpu', metrics: { machineMemory } },
        { name: 'app', metrics: { bytesHeld: { heaps: { blockCache: 8 * MIB } } } }]);
    assert.equal(table.status, 'over');
    assert.equal(table.metrics.total, 68 * MIB);
});

test('without the account the total is not measured, never the pools alone', ()=>{
    const table = zonesTable([{ name: 'app',
        metrics: { bytesHeld: { heaps: { blockCache: 8 } } } }]);
    assert.equal(table.metrics.account, NOT_MEASURED);
    assert.equal(table.metrics.total, NOT_MEASURED);
    assert.equal(table.metrics.zones.guest.accounted, NOT_MEASURED);
});

test('two processes\' tables count the run\'s cache once: one account, whichever holds it', ()=>{
    const machineMemory = accountOf({ guest: 64 * MIB, cache: 32 * MIB });
    const process = withZones([
        { name: 'cpu', metrics: { machineMemory, bytesHeld: { guest: { heap: 64 } } } },
        { name: 'app', metrics: { bytesHeld: { heaps: {} } } }]);
    assert.equal(process.at(-1)?.name, 'zones');
    const page = withZones([...process,
        { name: 'cpu', metrics: { machineMemory, bytesHeld: { guest: { heap: 32 } } } },
        { name: 'system-bundle', metrics: { bytesHeld: { heaps: { blockCache: 8 } } } }]);
    assert.equal(page.filter(table=>table.name === 'zones').length, 1);
    const sums = /** @type {any} */ (page.at(-1)).metrics;
    assert.equal(sums.account.kinds.cache, 32 * MIB);
    assert.equal(sums.total, 96 * MIB + 8, 'the cache once, not once a process');
});
