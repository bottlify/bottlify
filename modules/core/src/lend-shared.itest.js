/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program unlocks is lent to the graphics worker: the worker reads it
 * in guest memory, in place.
 *
 * The program locks a texture each frame, fills it, unlocks it, draws with
 * it and presents, then exits. The device is played in a worker thread over
 * the fake GPU, as the browser's graphics worker plays it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { TEXTURE, texturedFrames } from '../../../tools/fixtures/d3d9-program.mjs';

const FRAMES = 3;

async function run(){
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    const thread = new Worker(new URL('../../../tools/fixtures/fake-graphics-worker.mjs', import.meta.url));
    thread.postMessage({ type: 'open', frames: 'none' });
    /** @type {Map<Function, (data: any) => void>} */
    const listeners = new Map();
    const worker = {
        postMessage: (/** @type {any} */ message, /** @type {any} */ transfer)=>
            thread.postMessage(message, transfer),
        addEventListener: (/** @type {string} */ type, /** @type {Function} */ listener)=>{
            const relay = (/** @type {any} */ data)=>listener({ data });
            listeners.set(listener, relay);
            thread.on('message', relay);
        },
        removeEventListener: (/** @type {string} */ type, /** @type {Function} */ listener)=>{
            thread.off('message', /** @type {any} */ (listeners.get(listener)));
        },
    };
    try
    {
        const app = await createApp({
            executable: texturedFrames(FRAMES),
            device: {
                device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
                adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
                worker,
            },
        });
        /** @type {string[]} */
        const divergences = [];
        app.on('divergence', (/** @type {any} */ seen)=>divergences.push(seen.detail));
        const code = await app.run({ timeoutMs: 50000 });
        const layers = app.diagnostics();
        const metrics = layers.find((/** @type {any} */ layer)=>layer.name === 'graphics')?.metrics;
        // A report is the first ask of the run for the played device's own
        // account, and waits for it rather than saying nothing.
        const reported = (await app.report()).diagnostics;
        const result = { code, divergences, lent: metrics?.worker?.lent,
            device: reported.find((/** @type {any} */ layer)=>layer.name === 'graphics')
                ?.metrics?.seam?.device };
        await app.dispose();
        return result;
    }
    finally
    {
        await thread.terminate();
    }
}

test('a texture unlocked each frame is lent to the graphics worker',
    { timeout: 60000 }, async()=>{
        const result = await run();
        assert.equal(result.code, 0);
        assert.deepEqual(result.divergences, []);
        assert.equal(result.lent.lent, FRAMES, JSON.stringify(result.lent));
        assert.equal(result.lent.lentBytes, FRAMES * TEXTURE * TEXTURE * 4);
        assert.ok(result.device, 'the report carries what the played device counted');
        assert.equal(result.device.frames, FRAMES + 0, JSON.stringify(result.device).slice(0, 200));
    });
