/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// The graphics worker over the fake GPU device (`--fake-gpu`): the devices'
// calls played as the browser's graphics worker plays them, on a device that
// takes every call and draws nothing -- so a run measures the engine with no
// software rasteriser sharing the machine with it.

import { serveGraphics } from '../../../src/layers/graphics/remote/worker.js';
import { createFakeDevice } from '../../../src/layers/graphics/webgpu/internal/fake-device.js';
import { nudgeWhenAsked } from '../../../src/layers/cpu/internal/gc-nudge.js';

// Quiet: nothing reads a log of the calls here, and keeping one cost the
// played side a third of its time -- what a run measures is the engine.
// `?pipelineMs=N`: a pipeline takes that long to build, as a GPU compiling its
// shaders does, so frames queue behind their pipelines as on a real device.
// `?features=a,b`: the optional features the device says it has, as a phone's
// GPU says texture-compression-astc and not -bc.
const search = new URL(self.location.href).searchParams;
const pipelineDelayMs = Number(search.get('pipelineMs') ?? 0);
const features = new Set((search.get('features') ?? '').split(',').filter(Boolean));
const gpu = createFakeDevice({ quiet: true, pipelineDelayMs });
nudgeWhenAsked(self);
Object.assign(gpu.device, { queue: gpu.queue, features,
    createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
serveGraphics(/** @type {any} */ (self), /** @type {any} */ ({
    gpu: { requestAdapter: async()=>({ features, info: { vendor: 'fake' },
        requestDevice: async()=>gpu.device }) },
    canvas: (/** @type {number} */ width, /** @type {number} */ height)=>Object.assign(gpu.canvas,
        { width, height, transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
}));
