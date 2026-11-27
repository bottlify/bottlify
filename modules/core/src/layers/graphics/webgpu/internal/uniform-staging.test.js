/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the uniform ring's copy on this side (`createUniformPool`'s
 * `staging`): seeded frames of blocks - floats, bytes, words, a block handed
 * again, one larger than the ring - laid by three pools whose copy is held in
 * the run's cache, held in rooms whose every grow is dirty memory a page into
 * a larger buffer, and made fresh each time a ring is, as before it had a
 * room. Every slot they answer and every byte every ring is written with must
 * be the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUniformPool } from './bindings.js';
import { createFakeDevice } from './fake-device.js';
import { createScratches } from '../../../cache/scratch.js';
import { testCache } from '../../../cache/testing.fixture.js';

/** @param {number} seed */
const random = seed=>{
    let state = seed >>> 0;
    return (/** @type {number} */ below)=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return Math.floor((state / 2 ** 32) * below);
    };
};

/** @type {import('../../../cache/scratch.js').Scratch} */
const FRESH = { bytes: length=>new Uint8Array(length), release: ()=>{} };

/**
 * One seeded program run on a pool whose copy is `staging`: every slot, and
 * every ring's bytes after each frame.
 *
 * @param {number} seed @param {import('../../../cache/scratch.js').Scratch} staging
 */
function run(seed, staging){
    const next = random(seed);
    const gpu = createFakeDevice();
    const pool = createUniformPool({ device: gpu.device, queue: gpu.queue,
        capacity: 1024 << next(3), staging });
    /** @type {string[]} */
    const seen = [];
    /** @type {ArrayBufferView[]} */
    const kept = [];
    for (let frame = 0; frame < 12; frame++)
    {
        const blocks = 1 + next(40);
        for (let index = 0; index < blocks; index++)
        {
            const kind = next(8);
            const length = 4 * (1 + next(kind === 0 ? 1200 : 64));
            /** @type {ArrayBufferView} */
            let block;
            if (kind === 1 && kept.length > 0)
            {
                // The same block again in the frame: bound where it was laid.
                block = kept[next(kept.length)];
            }
            else if (kind < 4)
            {
                block = Float32Array.from({ length: length / 4 }, ()=>next(1 << 20) / 7);
            }
            else if (kind < 6)
            {
                block = Uint8Array.from({ length }, ()=>next(256));
            }
            else
            {
                block = Int32Array.from({ length: length / 4 }, ()=>next(2 ** 31));
            }
            kept.push(block);
            const slot = pool.allocate(block);
            seen.push(`${slot.buffer.label}:${slot.offset}:${slot.size}:${slot.dynamicOffset}`);
        }
        pool.flush();
        pool.endFrame();
        kept.length = 0;
        for (const call of gpu.of('createBuffer'))
        {
            const bytes = call.createBuffer.bytes ?? [];
            seen.push(`${call.descriptor.label}:${[...bytes].join(',')}`);
        }
        seen.push(`writes:${gpu.count('writeBuffer')}`);
    }
    return seen;
}

test('gate: the uniform ring is written the same from a copy held in the run\'s cache, '
    + 'from a dirty one and from a fresh one', async()=>{
    // A small cache: a ring past its segment keeps its copy in plain memory.
    const cache = await testCache({ budget: 1 << 18, segmentBytes: 1 << 16 });
    const held = createScratches(cache.space('scratch').hold ?? null);
    const dirty = createScratches((_key, length)=>({
        bytes: new Uint8Array(length + 4096).fill(0xcd).subarray(4096), release: ()=>{} }));
    for (let seed = 1; seed <= 12; seed++)
    {
        const fresh = run(seed, FRESH);
        assert.deepEqual(run(seed, held.scratch(`uniforms/${seed}`)), fresh, `held, seed ${seed}`);
        assert.deepEqual(run(seed, dirty.scratch(`uniforms/${seed}`)), fresh,
            `dirty, seed ${seed}`);
    }
    const figures = held.figures();
    assert.ok(figures.grows - figures.plainGrows > 12, 'copies held in the run\'s cache');
    assert.ok(figures.plainGrows > 0, 'and copies that had no room there');
});
