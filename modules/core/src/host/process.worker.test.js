/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainOf, sendFrames } from './process.worker.js';
import { connectGraphicsWorker, portEnd } from '../layers/graphics/remote/connect.js';

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

test('a process\'s frames cross in a few buffers: the run\'s thread copies each onto its device '
    + 'and hands the buffer back with its answer', async()=>{
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
    const display = sendFrames(channel.port1);
    try
    {
        const frames = 40;
        for (let frame = 0; frame < frames; frame++)
        {
            const pixels = display.bytes(8 * 4 * 2);
            pixels.fill(frame);
            display.send({ pixels, width: 8, height: 2, bytesPerRow: 32, format: 'bgra8unorm' });
            assert.equal(pixels.byteLength, 0, 'transferred, not copied');
            // A turn for the frame to cross and its answer to come back.
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
        await new Promise(resolve=>setTimeout(resolve, 5));
        assert.equal(written.length, frames);
        assert.ok(written.every((bytes, frame)=>bytes.length === 64
            && bytes.every(byte=>byte === frame)), 'each frame shown with its own bytes');
        const figures = display.figures();
        assert.ok(figures.made <= 3, `at most the rotation's buffers made (${figures.made})`);
        assert.equal(figures.made + figures.reused, frames);
        assert.equal(figures.returned, frames, 'every buffer came back');
    }
    finally
    {
        end.dispose();
        channel.port1.close();
        channel.port2.close();
    }
});
