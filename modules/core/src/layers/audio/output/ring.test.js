/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRing } from './ring.js';

/** @param {number[]} values */
const frames = values=>Float32Array.from(values);

test('what goes in comes out, in order', ()=>{
    const ring = createRing({ channels: 2, capacityFrames: 8 });
    assert.equal(ring.filled(), 0);

    assert.equal(ring.write(frames([1, -1, 2, -2, 3, -3])), 3);
    assert.equal(ring.filled(), 3);

    const out = new Float32Array(6);
    assert.equal(ring.read(out), 3);
    assert.deepEqual([...out], [1, -1, 2, -2, 3, -3]);
    assert.equal(ring.filled(), 0);
    assert.equal(ring.consumed(), 3);
});

test('a read past what is there is silence, and silence is not consumed', ()=>{
    const ring = createRing({ channels: 2, capacityFrames: 8 });
    ring.write(frames([1, 1]));

    const out = new Float32Array(8);
    assert.equal(ring.read(out), 1, 'one real frame');
    assert.deepEqual([...out], [1, 1, 0, 0, 0, 0, 0, 0]);
    // The gap must not count as played: a cursor run through it would have a
    // program refilling against a position the sound never reached.
    assert.equal(ring.consumed(), 1);
});

test('a full ring refuses the rest rather than overwriting', ()=>{
    const ring = createRing({ channels: 1, capacityFrames: 4 });
    assert.equal(ring.write(frames([1, 2, 3, 4, 5, 6])), 4, 'only what fits');
    assert.equal(ring.room(), 0);
    assert.equal(ring.write(frames([9])), 0);

    const out = new Float32Array(4);
    ring.read(out);
    assert.deepEqual([...out], [1, 2, 3, 4], 'and what fitted is unharmed');
});

test('it keeps working past the end of its own storage', ()=>{
    // The indices are monotonic and the storage wraps under them, so a ring
    // that has been round several times must behave exactly as a fresh one.
    const ring = createRing({ channels: 1, capacityFrames: 4 });
    const out = new Float32Array(3);
    for (let round = 0; round < 10; round++)
    {
        assert.equal(ring.write(frames([round, round + 1, round + 2])), 3);
        assert.equal(ring.read(out), 3);
        assert.deepEqual([...out], [round, round + 1, round + 2]);
    }
    assert.equal(ring.consumed(), 30);
});

test('a second view over the same memory sees the same ring', ()=>{
    // This is the whole point of it: the reader is on another thread and is
    // given the buffers, not the object.
    const ring = createRing({ channels: 2, capacityFrames: 4 });
    const reader = createRing({ channels: 2, capacityFrames: 4, memory: ring.memory });

    ring.write(frames([5, 6]));
    const out = new Float32Array(2);
    assert.equal(reader.read(out), 1);
    assert.deepEqual([...out], [5, 6]);
    assert.equal(ring.filled(), 0, 'the writer sees the reader take it');
});

test('a ring over memory another wrote to continues its counts', ()=>{
    // The control block belongs to the storage, not to the object: a machine
    // rebuilt over the same output -- a process replacement, where the reader
    // on the far side was handed the ring once -- must pick the stream up
    // where it was rather than restart the count under the reader.
    const first = createRing({ channels: 2, capacityFrames: 4 });
    first.write(frames([1, 1, 2, 2]));
    assert.equal(first.read(new Float32Array(4)), 2);

    const second = createRing({ channels: 2, capacityFrames: 4, memory: first.memory });
    assert.equal(second.written(), 2, "the first ring's write count");
    assert.equal(second.consumed(), 2, "the reader's position");

    // And what it writes lands after what was written, not over it.
    assert.equal(second.write(frames([3, 3])), 1);
    assert.equal(second.written(), 3);
    const out = new Float32Array(2);
    assert.equal(second.read(out), 1);
    assert.deepEqual([...out], [3, 3]);
});

test('clearing drops what was queued without disturbing the count', ()=>{
    const ring = createRing({ channels: 1, capacityFrames: 4 });
    ring.write(frames([1, 2, 3]));
    ring.clear();
    assert.equal(ring.filled(), 0);
    assert.equal(ring.consumed(), 3, 'discarded is still gone, as a device does');
});
