/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenGL 2.0 from a program, through `createApp` over the recording device:
 * the program finds the version's functions with wglGetProcAddress, as
 * OPENGL32.dll exports 1.1 alone; compiles and links a GLSL program, sets its
 * uniforms (through the command ring's routines); draws a quad into a
 * texture attached to a framebuffer object with a depth renderbuffer; then
 * draws the window sampling that texture, and swaps. What it was answered is
 * dumped to the console; what reached the device is read off it.
 *
 * Every call is stdcall, so a word count one out anywhere is a stack the
 * program returns through wrong: the program exiting 0 with its answers is
 * the sizes' test as much as the answers are.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { bytesOfHex } from '../../../tools/gl-program.mjs';
import { OUT, glslProgram } from '../../../tools/gl-glsl-program.mjs';

test('a program draws with GLSL into a framebuffer object and samples it in the window',
    { timeout: 120000 }, async t=>{
        const gpu = createFakeDevice();
        const gpuDevice = /** @type {any} */ (gpu.device);
        gpuDevice.features = new Set();
        gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            descriptor });
        const app = await createApp({ executable: glslProgram(),
            device: { device: gpu.device, queue: gpu.queue, screen: gpu.screen,
                canvas: gpu.canvas,
                adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' } } });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.on('output', (/** @type {any} */ payload)=>output.push(payload.text));
        assert.equal(await app.run({ timeoutMs: 100000 }), 0, 'the program exits 0');
        const out = bytesOfHex(output.join(''));
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
        /** @param {number} at */
        const word = at=>view.getInt32(at, true);
        assert.equal(word(OUT.procs), 0, 'every function of the version is obtained');
        assert.deepEqual([word(OUT.vs), word(OUT.fs), word(OUT.link)], [1, 1, 1],
            'both shaders compile and the program links');
        assert.deepEqual([word(OUT.projection), word(OUT.useTexture)], [0, 3]);
        assert.equal(word(OUT.framebuffer), 0x8cd5, 'the framebuffer is complete');
        assert.equal(word(OUT.error), 0, 'no call raised an error');

        // Waits for the frame the swap queued to be played on the device.
        for (let tries = 0; tries < 100 && !gpu.of('beginRenderPass').some(
            (/** @type {any} */ p)=>/gl-texture/.test(
                p.descriptor.colorAttachments[0]?.view?.viewDescriptor?.label ?? '')); tries++)
        {
            await new Promise(done=>setTimeout(done, 20));
        }
        const pipelines = gpu.of('createRenderPipeline').map((/** @type {any} */ p)=>p.descriptor)
            .filter((/** @type {any} */ d)=>d.vertex.module.descriptor.code.includes('fn vmain'));
        assert.deepEqual(pipelines.map((/** @type {any} */ d)=>d.fragment.targets[0].format)
            .sort(), ['bgra8unorm', 'rgba8unorm'],
        'the program draws into the texture and into the window');
        assert.ok(gpu.of('beginRenderPass').some((/** @type {any} */ p)=>/gl-texture/.test(
            p.descriptor.colorAttachments[0]?.view?.viewDescriptor?.label ?? '')),
        'a pass draws into the texture\'s level');
    });
