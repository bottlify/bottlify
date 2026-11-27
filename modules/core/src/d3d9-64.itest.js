/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 9 from a 64-bit program through `createApp` over the recording
 * device (`test/fixtures/src/d3d9_64.c` says which calls): its interfaces
 * called through tables of eight-byte slots, the structures with a handle in
 * them in their 64-bit layouts, every interface and locked pointer written
 * whole, a float argument and answer in XMM registers, and a frame -- the
 * clear and two triangles, one from a vertex buffer the program filled
 * through Lock -- reaching the device.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';

const FIXTURE = new URL('../test/fixtures/d3d9_64.exe', import.meta.url);

/** The first vertex the program writes through Lock: x, y, z, rhw. */
const FIRST_VERTEX = new Uint8Array(Float32Array.of(32, 4, 0.5, 1).buffer);

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

test('a 64-bit program draws with Direct3D 9: a clear and two triangles, presented',
    { timeout: 120000 }, async t=>{
        const gpu = createFakeDevice();
        const gpuDevice = /** @type {any} */ (gpu.device);
        gpuDevice.features = new Set();
        gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            descriptor });
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            commandLine: '"C:\\d3d9_64.exe"',
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
        assert.equal(lines.length, 15, `every check was reached:\n${text}`);
        assert.equal(code, 0, text);

        const clears = gpu.of('beginRenderPass').flatMap((/** @type {any} */ call)=>
            call.descriptor.colorAttachments ?? []).filter((/** @type {any} */ attachment)=>
            attachment?.loadOp === 'clear');
        assert.ok(clears.some((/** @type {any} */ attachment)=>
            Math.abs(attachment.clearValue.r - 0x33 / 255) < 1e-6
            && Math.abs(attachment.clearValue.g - 0x66 / 255) < 1e-6
            && Math.abs(attachment.clearValue.b - 0x99 / 255) < 1e-6),
        `the colour the program cleared to: ${JSON.stringify(clears.map((
            /** @type {any} */ attachment)=>attachment.clearValue))}`);
        const draws = gpu.of('draw');
        assert.equal(draws.length, 2, 'a draw for each triangle');
        assert.ok(gpu.of('createBuffer').some((/** @type {any} */ call)=>
            call.createBuffer.bytes && holds(call.createBuffer.bytes, FIRST_VERTEX)),
        'the vertices written through the locked pointer reach the device');
    });
