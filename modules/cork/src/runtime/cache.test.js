/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CACHE_VERSION, cacheKey, memoryTranslationStore, moduleKey, packRegion, seedRecords,
    unpackRegion,
} from './cache.js';

test('a record round-trips, and bytes of another version or shape are a miss', ()=>{
    const region = {
        module: new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 9, 9]),
        labels: /** @type {[number, number][]} */ ([[0x1000, 0], [0x1010, 1]]),
        cut: [1], entryTop: 6, instructions: 42,
    };
    const bytes = packRegion(region);
    const back = unpackRegion(bytes);
    assert.ok(back);
    assert.deepEqual([...back.module], [...region.module]);
    assert.deepEqual(back.labels, region.labels);
    assert.deepEqual(back.cut, [1]);
    assert.equal(back.entryTop, 6);
    assert.equal(back.instructions, 42);
    assert.equal(back.closed, undefined, 'no closed blocks, none kept');
    assert.deepEqual(unpackRegion(packRegion({ ...region, closed: [0x1010] }))?.closed, [0x1010],
        'the blocks inside the loops with no entry, which the runtime answers for');
    assert.equal(back.shape, undefined, 'a module\'s record has no shape');
    /** @type {import('./cache.js').RegionShape} */
    const shape = { hash: '0123456789abcdef', targets: [[0x1004, [0x2000]]],
        narrow: true, checked: true };
    assert.deepEqual(unpackRegion(packRegion({ ...region, shape }))?.shape, shape,
        'what forming made of the region, to form it again so');
    const other = new Uint8Array(bytes);
    new DataView(other.buffer).setUint32(4, CACHE_VERSION + 1, true);
    assert.equal(unpackRegion(other), null, 'another version');
    assert.equal(unpackRegion(bytes.subarray(0, 8)), null, 'too short');
    const torn = new Uint8Array(bytes);
    new DataView(torn.buffer).setUint32(8, 1 << 20, true);
    assert.equal(unpackRegion(torn), null, 'a header past the end');
    assert.equal(unpackRegion(new Uint8Array(40)), null, 'not a record');
});

test('the key changes with every input', ()=>{
    const base = {
        version: 1, features: { simd: true, tailCalls: true }, layoutId: 'abc', bundleId: 'game',
        entry: 0x401000, kept: '3-s',
    };
    const key = cacheKey(base);
    assert.equal(key, 'cork/1st-/abc/game/401000/3-s');
    for (const change of [
        { version: 2 }, { features: { simd: false, tailCalls: true } }, { layoutId: 'abd' },
        { bundleId: 'other' }, { entry: 0x401001 }, { kept: '3' },
        { features: { simd: true, tailCalls: true, defaultNaNNegative: true } },
        { variant: 'S' }, { variant: 'pb077' },
    ])
    {
        assert.notEqual(cacheKey({ ...base, ...change }), key, JSON.stringify(change));
    }
});

test('the memory store keeps what it is given', async()=>{
    const store = memoryTranslationStore();
    assert.equal(await store.get('a'), null);
    await store.put('a', new Uint8Array([1, 2]));
    assert.deepEqual([...(await store.get('a') ?? [])], [1, 2]);
    assert.equal(store.size(), 1);
});

test('a module\'s key sees its bytes past 32 bits, and the emitting settings', ()=>{
    const of = { version: 1, features: { simd: true, tailCalls: true }, layoutId: 'abc',
        bundleId: 'game' };
    const key = moduleKey(of, new Uint8Array([1, 2, 3]));
    assert.match(key, /^cork\/1st-\/abc\/game\/module\/[0-9a-f]{9,16}-3$/);
    assert.notEqual(moduleKey(of, new Uint8Array([1, 2, 4])), key);
    assert.notEqual(moduleKey({ ...of, variant: 'S' }, new Uint8Array([1, 2, 3])), key);
});

test('a seed takes the region records and the modules they name, and nothing else', ()=>{
    const nameOf = (/** @type {string} */ key)=>`name(${key})`;
    const module = (/** @type {number} */ fill)=>packRegion({ module: new Uint8Array(8).fill(fill),
        labels: [], cut: [], entryTop: 0, instructions: 0 });
    const region = (/** @type {string} */ key, linked = false)=>packRegion({
        module: new Uint8Array(0), moduleKey: key, labels: [[0x1000, 0]], cut: [], entryTop: 0,
        instructions: 3, exportName: 'r0', ...(linked ? { linked: true } : {}) });
    const otherVersion = region('batch');
    new DataView(otherVersion.buffer).setUint32(4, CACHE_VERSION - 1, true);
    /** @type {[string, Uint8Array][]} */
    const records = [
        ['a', region('relinked', true)], ['b', region('batch')],
        ['name(batch)', module(1)], ['name(relinked)', module(2)],
        ['name(gone)', module(3)], ['old', otherVersion],
    ];
    assert.deepEqual(seedRecords(records, nameOf).map(([name])=>name),
        ['a', 'b', 'name(batch)', 'name(relinked)']);
});

test('a record is kept and read under the version it is asked for', ()=>{
    const bytes = packRegion({ module: Uint8Array.of(1, 2, 3), labels: [], cut: [], entryTop: 0,
        instructions: 1 }, CACHE_VERSION + 5);
    assert.equal(unpackRegion(bytes), null, 'the translator\'s own version is another');
    assert.deepEqual([...(unpackRegion(bytes, CACHE_VERSION + 5)?.module ?? [])], [1, 2, 3]);
});
