/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainOf, sendFrames } from './process.worker.js';
import { connectGraphicsWorker, portEnd } from '../layers/graphics/remote/connect.js';
import { testCache } from '../layers/cache/testing.fixture.js';

test('a report that cannot be read as data says why, rather than nothing', ()=>{
    assert.deepEqual(plainOf(()=>[{ name: 'cpu', metrics: { n: 1 } }]),
        [{ name: 'cpu', metrics: { n: 1 } }]);
    assert.equal(plainOf(()=>{
        throw new Error('no such table');
    }), null);
    assert.deepEqual(plainOf(()=>{
        throw new Error('blocks.decoded is not a function');
    }, message=>[{ name: 'diagnostics', status: 'error', metrics: { error: message } }]),
    [{ name: 'diagnostics', status: 'error',
        metrics: { error: 'blocks.decoded is not a function' } }]);
    assert.equal(plainOf(()=>({ big: 1n })), null, 'a BigInt does not cross as JSON');
});

test('a process\'s frames are held in the run\'s cache, read in place by the run\'s thread, '
    + 'and let go of as its answers come back; one with no room is said', async t=>{
    const channel = new MessageChannel();
    /** @type {Uint8Array[]} */
    const written = [];
    const device = {
        createTexture: ()=>({ createView: ()=>({}), destroy: ()=>{} }),
        // WebGPU copies the data as the call is made: so does this.
        queue: { writeTexture: (/** @type {any} */ _texture, /** @type {Uint8Array} */ data)=>{
            written.push(data.slice());
        } },
    };
    const end = connectGraphicsWorker({ worker: portEnd(channel.port2), device,
        presentTo: ()=>{} });
    // A cache of one 64 KiB segment: the frames fit only as their memory comes back.
    const cache = await testCache({ budget: 1 << 16, segmentBytes: 1 << 16 });
    /** @type {string[]} */
    const lost = [];
    const display = sendFrames(channel.port1, cache.space('frames').hold ?? null,
        detail=>lost.push(detail));
    try
    {
        const frames = 40;
        const length = 64 * 64 * 4;
        for (let frame = 0; frame < frames; frame++)
        {
            const pixels = display.bytes(length) ?? assert.fail(`no room for frame ${frame}`);
            assert.ok(pixels.buffer instanceof SharedArrayBuffer, 'the cache\'s memory');
            pixels.fill(frame);
            display.send({ pixels, width: 64, height: 64, bytesPerRow: 256,
                format: 'bgra8unorm' });
            // A turn for the frame to cross and its answer to come back. No
            // sweep: the next frame's hold of the name takes the room back.
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
        await new Promise(resolve=>setTimeout(resolve, 5));
        assert.equal(written.length, frames);
        assert.ok(written.every((bytes, frame)=>bytes.length === length
            && bytes.every(byte=>byte === frame)), 'each frame shown with its own bytes');
        assert.deepEqual(display.figures(), { held: 0, heldBytes: 0, refused: 0 },
            'every frame answered, none held');
        cache.idle(0);
        assert.equal(cache.keeper.under('frames/').bodies, 0, 'the memory the cache\'s again');
        assert.equal(lost.length, 0, 'nothing lost');
        // Frames never answered hold their memory: past the segment, a frame is not sent.
        const unanswered = new MessageChannel();
        t.after(()=>unanswered.port1.close());
        const stuck = sendFrames(unanswered.port1, cache.space('stuck').hold ?? null,
            detail=>lost.push(detail));
        let refusedAt = -1;
        for (let frame = 0; frame < 8 && refusedAt < 0; frame++)
        {
            const pixels = stuck.bytes(length);
            if (pixels === null)
            {
                refusedAt = frame;
                break;
            }
            stuck.send({ pixels, width: 64, height: 64, bytesPerRow: 256, format: 'bgra8unorm' });
        }
        assert.ok(refusedAt > 0, `refused once the segment was full (${refusedAt})`);
        assert.equal(lost.length, 1, 'said once');
    }
    finally
    {
        end.dispose();
        channel.port1.close();
        channel.port2.close();
    }
});
