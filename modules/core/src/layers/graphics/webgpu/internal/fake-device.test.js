/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDevice, fillWith } from './fake-device.js';

/** The fill a pixel at a time, as the clear was written first. */
function slowFill(/** @type {Uint8Array} */ bytes, /** @type {number[]} */ pixel){
    for (let at = 0; at + pixel.length <= bytes.length; at += pixel.length)
    {
        bytes.set(pixel, at);
    }
}

test('a fill lays the pixel over every whole pixel of the bytes, as one a pixel at a time', ()=>{
    for (const size of [1, 2, 3, 4, 8, 16])
    {
        const pixel = Array.from({ length: size }, (_, k)=>k * 37 + 11 & 0xff);
        for (const count of [0, 1, 2, 3, 5, 7, 64, 1000, 1023])
        {
            for (const extra of [0, 1])
            {
                const fast = new Uint8Array(count * size + extra).fill(0xee);
                const slow = fast.slice();
                fillWith(fast, pixel);
                slowFill(slow, pixel);
                assert.deepEqual(fast, slow, `${count} pixels of ${size} bytes, ${extra} over`);
            }
        }
    }
});

test('a render pass that clears a kept texture fills it at submit, in each kept format', ()=>{
    const gpu = createFakeDevice();
    const value = { r: 0.25, g: 0.5, b: 1, a: 0.75 };
    const expected = /** @type {Record<string, number[]>} */ ({
        bgra8unorm: [255, 128, 64, 191],
        rgba8unorm: [64, 128, 255, 191],
        r32float: [...new Uint8Array(Float32Array.of(0.25).buffer)],
        rgba32float: [...new Uint8Array(Float32Array.of(0.25, 0.5, 1, 0.75).buffer)],
    });
    for (const [format, pixel] of Object.entries(expected))
    {
        const texture = gpu.device.createTexture({ size: [33, 7], format, usage: 0x10 });
        const encoder = gpu.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(),
            loadOp: 'clear', storeOp: 'store', clearValue: value }] });
        pass.end();
        assert.ok(texture.bytes.every((/** @type {number} */ b)=>b === 0), 'nothing before submit');
        gpu.queue.submit([encoder.finish()]);
        const want = new Uint8Array(texture.bytes.length);
        slowFill(want, pixel);
        assert.deepEqual(texture.bytes, want, format);
    }
});
