/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenGL from a 64-bit program through `createApp` over the recording device
 * (`test/fixtures/src/gl64.c` says which calls): floats and doubles from XMM
 * registers and single stack slots, read back through the getters, a pointer
 * a query writes whole, an extension's entry point, and a frame -- the clear
 * colour and the triangle's colour and corners reaching the device.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';

const FIXTURE = new URL('../test/fixtures/gl64.exe', import.meta.url);

/** @param {number[]} values */
const floatBytes = values=>new Uint8Array(Float32Array.from(values).buffer);

/** @param {Uint8Array} bytes @param {Uint8Array} part */
const holds = (bytes, part)=>{
    for (let at = 0; at + part.length <= bytes.length; at += 4)
    {
        if (part.every((byte, index)=>bytes[at + index] === byte))
        {
            return true;
        }
    }
    return false;
};

test('a 64-bit program draws with OpenGL: a clear and a triangle, swapped',
    { timeout: 120000 }, async t=>{
        const gpu = createFakeDevice();
        const gpuDevice = /** @type {any} */ (gpu.device);
        gpuDevice.features = new Set();
        gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            descriptor });
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            commandLine: '"C:\\gl64.exe"',
            device: { device: gpu.device, queue: gpu.queue, screen: gpu.screen,
                canvas: gpu.canvas,
                adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' } } });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 100000 });
        const text = output.join('');
        const lines = text.split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [], text);
        assert.equal(lines.length, 13, `every check was reached:\n${text}`);
        assert.equal(code, 0, text);

        /** @param {number[]} values */
        const reached = values=>gpu.of('writeBuffer').some((/** @type {any} */ call)=>
            holds(call.bytes, floatBytes(values)));
        assert.ok(reached([0.2, 0.4, 0.6, 1]), 'the clear colour reaches the device');
        assert.ok(reached([1, 0.5, 0.25]), 'and the triangle\'s colour');
        assert.ok(reached([0.5, -0.5]), 'and its corners');
        assert.ok(gpu.of('draw').length >= 2, 'the clear and the triangle are drawn');
    });
