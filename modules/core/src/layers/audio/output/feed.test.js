/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRing } from './ring.js';
import { createFeeder } from './feed.js';

/** The next message on a port. @param {MessagePort} port @returns {Promise<any>} */
const next = port=>new Promise(done=>{
    port.onmessage = event=>done(event.data);
});

/** @param {number} count @param {number} from */
const frames = (count, from)=>Float32Array.from({ length: count * 2 }, (_, at)=>from + at);

test('the feeder posts what was mixed, no further ahead than it is allowed', async()=>{
    const ring = createRing({ channels: 2, capacityFrames: 16 });
    ring.write(frames(10, 0));
    const channel = new MessageChannel();
    const feeder = createFeeder({ memory: ring.memory, channels: 2, port: channel.port1,
        aheadFrames: 4 });
    try
    {
        const first = await next(channel.port2);
        assert.equal(first.at, 0);
        assert.deepEqual([...first.frames], [...frames(4, 0)]);
        assert.equal(ring.consumed(), 0, 'posted is not played');

        const second = next(channel.port2);
        channel.port2.postMessage({ played: 3, blocks: 2, starvedBlocks: 1, starvedFrames: 5 });
        const topped = await second;
        assert.equal(ring.consumed(), 3, 'played is what the audio thread said');
        assert.deepEqual(ring.starved(), { blocks: 1, frames: 5, asked: 2 });
        assert.equal(topped.at, 4, 'the next chunk starts where the last ended');
        assert.equal(topped.frames.length / 2, 3, 'and keeps four frames ahead of what was played');
        assert.equal(feeder.diagnostics().posted, 7);
    }
    finally
    {
        feeder.close();
        channel.port2.close();
    }
});

test('the feeder starts from what was written but not played, and follows a clear', async()=>{
    const ring = createRing({ channels: 2, capacityFrames: 16 });
    ring.write(frames(6, 0));
    ring.acknowledge(4);
    const channel = new MessageChannel();
    const feeder = createFeeder({ memory: ring.memory, channels: 2, port: channel.port1,
        aheadFrames: 8 });
    try
    {
        const first = await next(channel.port2);
        assert.equal(first.at, 4);
        assert.equal(first.frames.length / 2, 2);

        ring.write(frames(3, 100));
        ring.clear();
        ring.write(frames(2, 200));
        const second = next(channel.port2);
        feeder.top();
        const after = await second;
        assert.equal(after.at, 9, 'what the clear threw away is not sent');
        assert.deepEqual([...after.frames], [...frames(2, 200)]);
    }
    finally
    {
        feeder.close();
        channel.port2.close();
    }
});
