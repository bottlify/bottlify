/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A graphics worker for node: `serveGraphics` in a worker thread, over the
 * fake GPU device, for a test that plays a device's calls on another thread
 * as the browser's graphics worker does. Dev tooling; no package imports it.
 */

import { parentPort } from 'node:worker_threads';
import { serveGraphics } from '../modules/core/src/layers/graphics/remote/worker.js';
import { createFakeDevice } from '../modules/core/src/layers/graphics/webgpu/internal/fake-device.js';

const gpu = createFakeDevice();
Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
    createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
/** @type {{ postMessage: (message: any, transfer?: any[]) => void, onmessage: any }} */
const scope = {
    postMessage: (message, transfer)=>parentPort?.postMessage(message, transfer),
    onmessage: null,
};
serveGraphics(/** @type {any} */ (scope), /** @type {any} */ ({
    gpu: { requestAdapter: async()=>({ features: new Set(), info: {},
        requestDevice: async()=>gpu.device }) },
    canvas: (/** @type {number} */ width, /** @type {number} */ height)=>Object.assign(gpu.canvas,
        { width, height, transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
}));
parentPort?.on('message', data=>scope.onmessage?.({ data }));
