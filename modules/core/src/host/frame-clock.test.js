/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SLOTS, createFrameClock, readFrameClock } from './frame-clock.js';

test('a reader of the buffer sees every frame ticked, with its time', ()=>{
    const clock = createFrameClock();
    assert.deepEqual(readFrameClock(clock.buffer), { count: 0, times: [] });
    clock.tick(10);
    clock.tick(26.5);
    clock.tick(43);
    assert.deepEqual(readFrameClock(clock.buffer), { count: 3, times: [10, 26.5, 43] });
    assert.deepEqual(readFrameClock(clock.buffer, 2), { count: 3, times: [43] },
        'only the frames after a count read before');
});

test('past the ring the newest frames are kept, the count goes on', ()=>{
    const clock = createFrameClock();
    for (let n = 0; n < SLOTS + 5; n++)
    {
        clock.tick(n);
    }
    const read = readFrameClock(clock.buffer);
    assert.equal(read.count, SLOTS + 5);
    assert.equal(read.times.length, SLOTS - 1, 'the slot being written next is not read');
    assert.equal(read.times[0], 6);
    assert.equal(read.times.at(-1), SLOTS + 4);
});
