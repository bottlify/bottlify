/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoredBlocks } from './stored-blocks.js';
import { keyOf } from './entries.js';

/** A seeded generator, so a failure names its case. @param {number} seed */
const random = seed=>()=>{
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
};

/** A map of blocks over the whole address range and every top. @param {() => number} next @param {number} count */
const someBlocks = (next, count)=>{
    const map = new Map();
    for (let i = 0; i < count; i++)
    {
        map.set(keyOf(Math.floor(next() * 2 ** 32), Math.floor(next() * 9)),
            keyOf(Math.floor(next() * 2 ** 32), Math.floor(next() * 9)));
    }
    return map;
};

test('stored blocks answer as the map they were made from, through a record and back', ()=>{
    for (const seed of [1, 2, 3, 4, 5])
    {
        const next = random(seed);
        const map = someBlocks(next, 2000);
        const blocks = StoredBlocks.fromBytes(StoredBlocks.fromMap(map).bytes().slice());
        assert.equal(blocks.size, map.size);
        for (const [block, owner] of map)
        {
            assert.equal(blocks.get(block), owner, `seed ${seed}: block ${block}`);
        }
        for (let i = 0; i < 500; i++)
        {
            const absent = keyOf(Math.floor(next() * 2 ** 32), Math.floor(next() * 9));
            assert.equal(blocks.get(absent), map.get(absent));
        }
    }
});

test('a record in the order a map put it is sorted as it is read, and an odd length is none', ()=>{
    const map = new Map([[keyOf(0x500000, 3), keyOf(0x400000, 3)],
        [keyOf(0x100000, 8), keyOf(0x100000, 8)], [keyOf(0x300000, 0), keyOf(0x2ff000, 0)]]);
    const words = new Uint32Array(map.size * 3);
    let at = 0;
    for (const [block, owner] of map)
    {
        words.set([Math.floor(block / 16), Math.floor(owner / 16), (block % 16) << 4 | owner % 16], at);
        at += 3;
    }
    const bytes = new Uint8Array(words.buffer);
    const blocks = StoredBlocks.fromBytes(bytes);
    assert.ok(blocks.sorted());
    assert.deepEqual([...map].map(([block])=>blocks.get(block)), [...map.values()]);
    assert.equal(StoredBlocks.fromBytes(bytes.subarray(0, 13)).size, 0);
    // Unaligned bytes, as a record may be handed in a larger buffer.
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    assert.equal(StoredBlocks.fromBytes(shifted.subarray(1)).get(keyOf(0x500000, 3)),
        keyOf(0x400000, 3));
});

test('blocks with more over them answer the newer owner, count only changes, and stay sorted', ()=>{
    for (const seed of [11, 12, 13])
    {
        const next = random(seed);
        const map = someBlocks(next, 1500);
        const before = StoredBlocks.fromMap(map);
        const added = someBlocks(next, 300);
        // Some of them the same as stored, some stored blocks given another owner.
        const kept = [...map].slice(0, 50);
        for (const [block, owner] of kept)
        {
            added.set(block, owner);
        }
        for (const [block] of [...map].slice(50, 100))
        {
            added.set(block, keyOf(0x12345, 1));
        }
        const { blocks, changed } = before.with(added);
        const expected = new Map([...map, ...added]);
        assert.equal(changed, [...added].filter(([block, owner])=>map.get(block) !== owner).length);
        assert.equal(blocks.size, expected.size);
        assert.ok(blocks.sorted());
        for (const [block, owner] of expected)
        {
            assert.equal(blocks.get(block), owner);
        }
        assert.equal(before.with(new Map(kept)).blocks, before, 'nothing new is the same map');
    }
});
