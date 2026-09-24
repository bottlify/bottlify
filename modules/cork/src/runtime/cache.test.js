/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CACHE_VERSION, cacheKey, memoryTranslationStore, packRegion, unpackRegion,
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
        entry: 0x401000, hash: 'deadbeef',
    };
    const key = cacheKey(base);
    assert.equal(key, 'cork/1st/abc/game/401000/deadbeef');
    for (const change of [
        { version: 2 }, { features: { simd: false, tailCalls: true } }, { layoutId: 'abd' },
        { bundleId: 'other' }, { entry: 0x401001 }, { hash: 'deadbeee' },
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
