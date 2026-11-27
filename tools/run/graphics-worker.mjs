/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Direct3D 9 program's frames cost the two threads of the graphics
 * worker's transport, in Node: the program of `fixtures/d3d9-frames-program.mjs`
 * run by an engine (this checkout's, or `--root DIR`'s) whose devices play in
 * a worker thread over the fake GPU (`run/graphics-worker/thread.mjs`), as
 * `--graphics-worker` plays them in a browser. Prints, as JSON, the run's
 * wall time, each thread's processor time over it, the batches sent and what
 * came back, and the calls the program's thread waited on.
 *
 *     node tools/run/graphics-worker.mjs [--root DIR] [--frames N] [--draws N] [--queries N]
 *
 * Node's posting of a transferred buffer costs its size, which a browser's
 * does not: a figure from here is the transport in Node, not in a browser.
 */

import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { framesProgram } from '../fixtures/d3d9-frames-program.mjs';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const root = pathToFileURL(`${resolve(flag('--root', '.'))}/`).href;
const frames = Number(flag('--frames', '600'));
const draws = Number(flag('--draws', '300'));
const queries = Number(flag('--queries', '1'));

const { createApp } = await import(`${root}modules/core/src/app.js`);
const { createFakeDevice } = await import(
    `${root}modules/core/src/layers/graphics/webgpu/internal/fake-device.js`);

const gpu = createFakeDevice();
Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
    createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
const thread = new Worker(new URL('./graphics-worker/thread.mjs', import.meta.url),
    { workerData: { root } });
thread.postMessage({ type: 'open', frames: 'pixels' });
/** @type {Map<any, (data: any) => void>} */
const listeners = new Map();
/** @type {((ms: number) => void) | null} */
let cpuReply = null;
thread.on('message', data=>{
    if (data?.type === 'cpu')
    {
        cpuReply?.(data.ms);
    }
});
/** The worker thread's processor time so far, in ms. @returns {Promise<number>} */
const workerCpu = ()=>new Promise(done=>{
    cpuReply = done;
    thread.postMessage({ type: 'cpu' });
});
// The graphics worker as the engine is handed one: messages relayed both ways.
const worker = {
    postMessage: (/** @type {any} */ message, /** @type {any[]} */ transfer)=>
        thread.postMessage(message, transfer),
    addEventListener: (/** @type {string} */ _type, /** @type {(event: any) => void} */ listener)=>{
        const relay = (/** @type {any} */ data)=>listener({ data });
        listeners.set(listener, relay);
        thread.on('message', relay);
    },
    removeEventListener: (/** @type {string} */ _type, /** @type {any} */ listener)=>
        thread.off('message', /** @type {any} */ (listeners.get(listener))),
};
const app = await createApp({ executable: framesProgram({ frames, draws, queries }),
    imagePath: 'C:\\frames.exe', device: { device: gpu.device, queue: gpu.queue,
        screen: gpu.screen, canvas: gpu.canvas,
        adapter: { vendor: 'fake', architecture: '', description: 'stand-in' }, worker } });
/** @type {string[]} */
const divergences = [];
app.on('divergence', (/** @type {any} */ said)=>divergences.push(said.detail));
const mainBefore = process.threadCpuUsage();
const workerBefore = await workerCpu();
const began = performance.now();
const code = await app.run({ timeoutMs: 600_000 });
const wallMs = performance.now() - began;
const mainAfter = process.threadCpuUsage();
const workerAfter = await workerCpu();
const graphics = app.diagnostics().find((/** @type {any} */ entry)=>entry.name === 'graphics')
    ?.metrics?.worker;
console.log(JSON.stringify({
    root, code, frames, draws, queries, divergences: divergences.slice(0, 3),
    wallMs: Math.round(wallMs),
    mainCpuMs: Math.round((mainAfter.user + mainAfter.system - mainBefore.user
        - mainBefore.system) / 1000),
    workerCpuMs: Math.round(workerAfter - workerBefore),
    sent: graphics?.sent ?? 'not measured', received: graphics?.received ?? 'not measured',
    waits: graphics?.waits ?? 'not measured',
}, null, 1));
await app.dispose();
await thread.terminate();
