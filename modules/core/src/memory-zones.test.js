/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    HEAP_POOLS, MEMORY_ZONES, NOT_MEASURED, TAB_MEMORY_LIMIT, withZones, zonesTable,
} from './memory-zones.js';
import { TRANSLATION_ZONE_BYTES } from './layers/cpu/module.js';

const MIB = 1024 * 1024;

test('the zones\' ceilings sum to no more than the tab\'s limit, a gigabyte and a half', ()=>{
    const sum = Object.values(MEMORY_ZONES).reduce((total, bytes)=>total + bytes, 0);
    assert.ok(TAB_MEMORY_LIMIT <= 1536 * MIB, 'the tab\'s limit is a gigabyte and a half');
    assert.ok(sum <= TAB_MEMORY_LIMIT, `zones ${sum / MIB} MiB within ${TAB_MEMORY_LIMIT / MIB}`);
    assert.deepEqual(Object.keys(MEMORY_ZONES), ['guest', 'translation', 'heaps']);
    assert.equal(MEMORY_ZONES.guest, 1024 * MIB, 'what the program holds, a gigabyte at most');
    assert.equal(MEMORY_ZONES.translation, TRANSLATION_ZONE_BYTES);
});

test('the heaps\' evicting pools fit inside the heaps\' zone', ()=>{
    const sum = Object.values(HEAP_POOLS).reduce((total, bytes)=>total + bytes, 0);
    assert.ok(sum <= MEMORY_ZONES.heaps, `pools ${sum / MIB} MiB within ${MEMORY_ZONES.heaps / MIB}`);
});

test('the zones\' table sums what the layers measured and names what they could not', ()=>{
    const table = zonesTable([
        { name: 'cpu', metrics: { bytesHeld: {
            guest: { heap: 512 * MIB },
            translation: { tables: 16 * MIB, modules: NOT_MEASURED } } } },
        { name: 'app',
            metrics: { bytesHeld: { heaps: { blockCache: 3 * MIB, decodedBlocks: MIB } } } },
        { name: 'graphics', metrics: { bytesHeld: {
            heaps: { mirror: 2 * MIB, worker: NOT_MEASURED },
            device: { textures: 100 * MIB } } } },
        { name: 'kernel', metrics: { threads: 3 } },
    ]);
    assert.equal(table.name, 'zones');
    assert.equal(table.status, 'ready');
    const { zones, total, outside, unreported } = table.metrics;
    assert.equal(zones.guest.bytes, 512 * MIB);
    assert.equal(zones.translation.bytes, 16 * MIB);
    assert.deepEqual(zones.translation.notMeasured, ['cpu.modules']);
    assert.equal(zones.heaps.bytes, 6 * MIB);
    assert.deepEqual(zones.heaps.pools, { 'app.blockCache': 3 * MIB, 'app.decodedBlocks': MIB,
        'graphics.mirror': 2 * MIB });
    assert.deepEqual(zones.heaps.notMeasured, ['graphics.worker']);
    assert.equal(total, 534 * MIB, 'the tab\'s zones only: the device\'s is apart');
    assert.deepEqual(outside, { device: { 'graphics.textures': 100 * MIB } });
    assert.deepEqual(unreported, ['kernel'], 'a layer that says nothing is not taken for zero');
    assert.equal(zones.guest.free, MEMORY_ZONES.guest - 512 * MIB);
});

test('a zone past its ceiling marks the table', ()=>{
    const table = zonesTable([{ name: 'app',
        metrics: { bytesHeld: { heaps: { blockCache: MEMORY_ZONES.heaps + 1 } } } }]);
    assert.equal(table.status, 'over');
    assert.equal(table.metrics.zones.heaps.over, true);
    assert.equal(table.metrics.zones.guest.over, false);
});

test('the sums are made again over every table, in place of a process\'s own', ()=>{
    const process = withZones([{ name: 'app', metrics: { bytesHeld: { guest: { heap: 64 } } } }]);
    assert.equal(process.at(-1)?.name, 'zones');
    const page = withZones([...process,
        { name: 'system-bundle', metrics: { bytesHeld: { heaps: { blockCache: 8 } } } }]);
    assert.equal(page.filter(table=>table.name === 'zones').length, 1);
    const sums = /** @type {any} */ (page.at(-1)).metrics.zones;
    assert.equal(sums.guest.bytes, 64);
    assert.equal(sums.heaps.bytes, 8);
});
