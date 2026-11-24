/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuddy, UNIT } from './buddy.js';
import { openKeeper } from './keeper.js';
import { createReader } from './reader.js';
import { memoryDisk } from './disk.fixture.js';

const KIB = 1024;

/** A keeper and a reader in one thread, the clock stepped by hand. */
async function cacheOf(options = {}){
    let clock = 0;
    /** @type {any[]} */
    const said = [];
    /** @type {import('./reader.js').Reader | null} */
    let reader = null;
    const keeper = await openKeeper({
        budget: 256 * KIB, segmentBytes: 64 * KIB, coldAfterMs: 100, goneAfterMs: 1000,
        releaseAfterMs: 50, now: ()=>clock,
        announce: message=>{
            said.push(message);
            reader?.adopt(message);
        },
        ...options,
    });
    reader = createReader({
        shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, opts)=>keeper.reserve(name, length, opts),
            raise: name=>keeper.raise(name),
            raiseLater: name=>{
                keeper.raise(name);
            },
            drop: name=>{
                keeper.drop(name);
            },
        },
    });
    // The first pack opens behind a promise, as on OPFS.
    await new Promise(resolve=>setTimeout(resolve, 0));
    return {
        keeper, reader, said,
        /** @param {number} ms */
        step(ms){
            clock += ms;
            keeper.sweep();
        },
    };
}

/** @param {number} length @param {number} seed */
const bodyOf = (length, seed)=>Uint8Array.from({ length }, (_, i)=>(i * 31 + seed) & 255);

test('a buddy block given back joins its twin, and a segment emptied is one block again', ()=>{
    const buddy = createBuddy(64 * KIB);
    const a = buddy.place(5000);
    const b = buddy.place(UNIT);
    assert.equal(a, 0);
    assert.equal(buddy.used(), 3 * UNIT);
    assert.equal(buddy.wasted(), 3 * UNIT - 5000 - UNIT);
    assert.equal(buddy.place(64 * KIB), -1);
    buddy.give(a, 5000);
    buddy.give(b, UNIT);
    assert.equal(buddy.empty(), true);
    assert.equal(buddy.largest(), 64 * KIB);
    assert.equal(buddy.place(64 * KIB), 0);
});

test('a body written is read in place by its name, a miss is null, two names keep apart', async()=>{
    const { reader } = await cacheOf();
    assert.equal(reader.look('a'), null);
    assert.equal(reader.put('a', bodyOf(5000, 1)), true);
    assert.equal(reader.put('b', bodyOf(300, 2)), true);
    assert.equal(reader.look('a'), 'hot');
    assert.deepEqual(reader.with('a', body=>Array.from(body)), Array.from(bodyOf(5000, 1)));
    assert.deepEqual(reader.with('b', body=>Array.from(body)), Array.from(bodyOf(300, 2)));
    assert.equal(reader.with('c', ()=>1), undefined);
});

test('past the budget the oldest body goes cold to the disk and comes back as it was', async()=>{
    const { reader, keeper } = await cacheOf({ disk: memoryDisk() });
    for (let i = 0; i < 12; i++)
    {
        assert.equal(reader.put(`n${i}`, bodyOf(32 * KIB, i)), true, `n${i}`);
    }
    // 12 bodies of 32 KiB in 256 KiB: the first went cold.
    assert.equal(reader.look('n0'), 'cold');
    assert.equal(reader.look('n11'), 'hot');
    assert.equal(reader.with('n0', ()=>1), undefined);
    assert.deepEqual(reader.with('n1', body=>Array.from(body), { wait: true }),
        Array.from(bodyOf(32 * KIB, 1)));
    const figures = keeper.figures();
    assert.ok(figures.cooled >= 4, JSON.stringify(figures));
    assert.ok(figures.segmentBytes <= 256 * KIB);
});

test('without a disk a body that can be made again goes away, the only copy stays', async()=>{
    const { reader, keeper } = await cacheOf();
    assert.equal(reader.put('kept', bodyOf(32 * KIB, 9), { onlyCopy: true }), true);
    for (let i = 0; i < 12; i++)
    {
        reader.put(`n${i}`, bodyOf(32 * KIB, i));
    }
    assert.equal(reader.look('kept'), 'hot');
    assert.equal(reader.look('n0'), null);
    assert.ok(keeper.figures().gone > 0);
});

test('a body being read is not taken: its drop waits for the reader to leave', async()=>{
    const { reader, keeper, step } = await cacheOf();
    reader.put('a', bodyOf(100, 3));
    reader.with('a', ()=>{
        assert.equal(keeper.drop('a'), false);
        assert.equal(reader.look('a'), 'hot');
    });
    step(1);
    assert.equal(reader.look('a'), null);
});

test('idle bodies go cold, then away; an emptied segment past the spare is let go', async()=>{
    const { reader, keeper, step, said } = await cacheOf({ disk: memoryDisk() });
    for (let i = 0; i < 6; i++)
    {
        reader.put(`n${i}`, bodyOf(32 * KIB, i));
    }
    const made = keeper.figures().segments;
    assert.ok(made >= 3);
    step(100);
    assert.equal(reader.look('n0'), 'cold');
    step(60);
    assert.equal(keeper.figures().segments, 1);
    assert.ok(said.some(message=>message.buffer === null));
    step(1000);
    assert.equal(reader.look('n0'), null);
});

test('a table filled is made larger and sent; every name is found through it', async()=>{
    const { reader, said } = await cacheOf({ budget: 8 * 1024 * KIB, segmentBytes: 1024 * KIB });
    for (let i = 0; i < 1500; i++)
    {
        reader.put(`name-${i}`, bodyOf(64, i));
    }
    assert.ok(said.some(message=>message.table !== undefined));
    for (let i = 0; i < 1500; i += 97)
    {
        assert.equal(reader.with(`name-${i}`, body=>body[1]), (31 + i) & 255);
    }
});

test('a body larger than a segment is refused and said so', async()=>{
    const { reader, keeper } = await cacheOf();
    assert.equal(reader.put('big', new Uint8Array(65 * KIB)), false);
    assert.equal(keeper.figures().refusedLarge, 1);
});
