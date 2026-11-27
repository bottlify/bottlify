/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a frame's uniform arena held in the run's cache
 * (`createUniformArena`): seeded frames whose draws take blocks of every size,
 * some past what the arena holds so that it grows mid-frame, recorded two at a
 * time as a device keeps a frame in flight while it records the next, and
 * "replayed" only after the next has been taken from: every block must read at
 * replay what its draw wrote, whether the arena's memory is the run's cache
 * (the names a root on the run's thread holds, `ownedSpace`, and those a root
 * in the graphics worker holds, `channelSpace`) or plain memory, and the cache
 * must hold nothing of it once the arenas are let go of.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUniformArena } from './render.js';
import { createScratches } from '../../cache/scratch.js';
import { openRunCache } from '../../../process/run-cache.js';
import { ownedSpace } from '../../cache/module.js';
import { testCache } from '../../cache/testing.fixture.js';

/** @param {number} seed @returns {() => number} 0 up to 2^32 */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

/**
 * One seeded run: what every block read at its frame's replay, in order.
 *
 * @param {number} seed @param {'plain' | 'thread' | 'small'} where  the arenas' memory: plain,
 *     names of the run's cache an owner on this thread holds, or a cache too small for all of
 *     it whose blocks come back full of what an earlier holder left there
 * @param {{ shared?: boolean }} [options]  `shared`: every arena's memory one scratch of the
 *     device - what the arena must not be - which the gate must see
 */
async function run(seed, where, { shared = false } = {}){
    const next = random(seed);
    const runCache = where === 'thread' ? await openRunCache({ budget: 64 << 20 }) : null;
    const owner = runCache ? ownedSpace(runCache.reader, runCache.own('rooms')) : null;
    /** @type {import('../../cache/scratch.js').Hold | null} */
    let hold = owner?.space.hold ?? null;
    /** Other holders taking the room let go of meanwhile, as a run's do. */
    let others = ()=>{};
    if (where === 'small')
    {
        const small = await testCache({ budget: 256 << 10, segmentBytes: 128 << 10 });
        const space = small.space('scratch');
        hold = (key, length)=>{
            const got = space.hold?.(key, length) ?? null;
            got?.bytes.fill(0xcd);
            return got;
        };
        let other = 0;
        others = ()=>{
            small.keeper.sweep();
            const taken = [];
            for (let size = 1024; size <= 16384; size *= 2)
            {
                const got = hold?.(`other/${++other}`, size);
                if (got)
                {
                    taken.push(got);
                }
            }
            taken.forEach(got=>got.release());
        };
    }
    const rooms = createScratches(hold);
    const one = rooms.scratch('d3d/uniforms');
    /** @type {(name: string, length: number) => import('../../cache/scratch.js').Held} */
    const holdOf = shared
        ? (name, length)=>({ bytes: one.bytes(length), release: ()=>{} })
        : (name, length)=>rooms.hold(name, length);
    /** @type {ReturnType<typeof createUniformArena>[]} */
    const pool = [];
    /** @type {ReturnType<typeof createUniformArena>[]} */
    const made = [];
    /** @type {number[]} */
    const read = [];
    /** @type {{ arena: ReturnType<typeof createUniformArena>, blocks: { block: Float32Array, wrote: number[] }[] } | null} */
    let inFlight = null;
    let heldMost = 0;
    for (let frame = 0; frame < 12; frame++)
    {
        let arena = pool.pop();
        if (!arena)
        {
            arena = createUniformArena(256, holdOf);
            made.push(arena);
        }
        arena.reset();
        const blocks = [];
        const draws = 4 + next() % 24;
        for (let draw = 0; draw < draws; draw++)
        {
            // Mostly a draw's few registers, now and then one past the arena.
            const count = next() % 8 === 0 ? 200 + next() % 400 : 4 + next() % 60;
            const written = next() % 2 === 0;
            const before = /** @type {number} */ (arena.serial);
            const block = arena.take(count, written);
            assert.equal(arena.serial, before);
            assert.equal(block.length, count);
            if (!written)
            {
                assert.ok(block.every(value=>value === 0), 'a block not written reads zero');
            }
            const wrote = [];
            for (let at = 0; at < count; at += 1 + next() % 3)
            {
                block[at] = (next() % 100000) / 7;
                wrote.push(at, block[at]);
            }
            blocks.push({ block, wrote });
        }
        heldMost = Math.max(heldMost, rooms.figures().held);
        others();
        // The frame before replays now, after this one took its blocks.
        if (inFlight)
        {
            for (const { block, wrote } of inFlight.blocks)
            {
                for (let at = 0; at < wrote.length; at += 2)
                {
                    read.push(block[wrote[at]] === wrote[at + 1] ? 1 : 0);
                }
            }
            pool.push(inFlight.arena);
        }
        inFlight = { arena, blocks };
    }
    for (const arena of made)
    {
        arena.release();
    }
    one.release();
    const figures = rooms.figures();
    const released = await owner?.close();
    runCache?.close();
    // An arena's first hold is its own; every one past those is a generation grown.
    return { read, grew: figures.holds - made.length, heldMost, figures, released };
}

test('a frame\'s uniform blocks read at replay what their draws wrote, from the run\'s cache as '
    + 'from plain memory, across the arena growing', async()=>{
    for (const where of /** @type {const} */ (['thread', 'small']))
    {
        let grew = 0;
        for (const seed of [1, 2, 3, 4, 5, 6])
        {
            const plain = await run(seed, 'plain');
            const cached = await run(seed, where);
            const at = `${where}, seed ${seed}`;
            assert.ok(plain.read.length > 0, at);
            assert.ok(plain.read.every(ok=>ok === 1), `${at}: plain memory reads what was written`);
            assert.deepEqual(cached.read, plain.read, at);
            assert.ok(cached.figures.held === 0 && cached.figures.plain === 0,
                `${at}: every generation let go of`);
            assert.ok(cached.heldMost > 0, `${at}: the arenas held in the cache`);
            assert.equal(plain.figures.held, 0);
            if (where === 'thread')
            {
                assert.deepEqual(cached.released, { bodies: 0, bytes: 0, waiting: 0 }, at);
            }
            grew += cached.grew;
        }
        assert.ok(grew > 0, `${where}: arenas grew mid-frame`);
    }
});

test('the gate sees arenas that share their memory', async()=>{
    for (const where of /** @type {const} */ (['plain', 'thread']))
    {
        let wrong = 0;
        for (const seed of [1, 2, 3])
        {
            const shared = await run(seed, where, { shared: true });
            wrong += shared.read.filter(ok=>ok === 0).length;
        }
        assert.ok(wrong > 0, `${where}: a frame's blocks overwritten before its replay`);
    }
});
