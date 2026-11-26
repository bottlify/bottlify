/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The graphics worker of `run/graphics-worker.mjs`: the checkout's
 * `serveGraphics` over the fake GPU in a worker thread, answering `cpu` with
 * the thread's processor time in ms.
 */

import { parentPort, workerData } from 'node:worker_threads';

const { root } = workerData;
const { serveGraphics } = await import(`${root}modules/core/src/layers/graphics/remote/worker.js`);
const { createFakeDevice } = await import(
    `${root}modules/core/src/layers/graphics/webgpu/internal/fake-device.js`);

const gpu = createFakeDevice();
// The fake keeps every call it was given; nothing reads the log here.
setInterval(()=>{
    gpu.calls.length = 0;
}, 1000).unref();
Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
    createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
/** @type {{ postMessage: (message: any, transfer?: any[]) => void, onmessage: any }} */
const scope = { postMessage: (message, transfer)=>parentPort?.postMessage(message, transfer),
    onmessage: null };
serveGraphics(/** @type {any} */ (scope), /** @type {any} */ ({
    gpu: { requestAdapter: async()=>({ features: new Set(), info: {},
        requestDevice: async()=>gpu.device }) },
    canvas: (/** @type {number} */ width, /** @type {number} */ height)=>Object.assign(gpu.canvas,
        { width, height, transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
}));
parentPort?.on('message', data=>{
    if (data?.type === 'cpu')
    {
        const { user, system } = process.threadCpuUsage();
        parentPort?.postMessage({ type: 'cpu', ms: (user + system) / 1000 });
        return;
    }
    scope.onmessage?.({ data });
});
