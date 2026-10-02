/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a frame of draws allocates on the JavaScript heap, and what it costs,
 * in node: a scene drives a graphics device over the recording GPU double --
 * its render passes recording nothing -- frame after frame, and three things
 * are measured over the frames after a warm-up --
 *
 *   - the bytes allocated, by the V8 sampling heap profiler with the objects
 *     both collectors reclaimed counted in (an estimate: one sample per
 *     `--interval` bytes), split into the engine's own code and the double's,
 *     and per draw as the difference between a run of N and one of 2N draws
 *     a frame, which takes out what a frame costs whatever it draws;
 *   - the time per draw, the same difference over a run without the profiler;
 *   - the collections that run took, by count and by pause.
 *
 *   node tools/draw-alloc-bench.mjs [--scene NAME] [--draws N] [--frames F]
 *       [--interval BYTES] [--top K] [--root DIR] [--json]
 *
 * Scenes:
 *
 *   d3d8-lit      Direct3D 8: indexed draws of a lit, textured cube, three
 *                 lights enabled, and before every draw a new world matrix, a
 *                 texture and a render state that alternate, and the same
 *                 light set again -- a program that sets its lights per model
 *   d3d8-moving   the same, with the light set before every draw in a new
 *                 place -- a light per model
 *   d3d9-lit, d3d9-moving   the same two through Direct3D 9
 *   d3d9-shader   Direct3D 9 through a vertex and a pixel shader, the matrix
 *                 constants set before every draw with the texture and the
 *                 cull mode
 *   ddraw-32, ddraw-8   DirectDraw: a back buffer filled, N sprites put on it
 *                 with BltFast and a colour key, copied to the primary and
 *                 presented, at 32 and 8 bits a pixel (a draw is a sprite)
 *
 * `--top K` prints the K functions of the engine's own code that allocated
 * the most, with the file and line each starts at. `--root DIR` measures the
 * engine of another checkout, for a tree before a change against one after.
 *
 * `--model` gives the Direct3D devices no backend: what the calls cost the
 * device's model alone. `--remote` gives the scene a recorded root whose calls
 * go out as a worker's would -- each turn's batch cloned as a port clones it --
 * and are played nowhere: what the program's thread keeps of a frame whose
 * rendering is another thread's.
 */

import { Session } from 'node:inspector/promises';
import { PerformanceObserver } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative } from 'node:path';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rootAt = process.argv.indexOf('--root');
const ROOT = rootAt > 0 ? resolve(process.argv[rootAt + 1]) : HERE;
// A URL, not a path: an absolute Windows path is no module specifier.
const GRAPHICS = pathToFileURL(`${ROOT}/modules/core/src/layers/graphics`).href;

const { createFakeDevice } = await import(`${GRAPHICS}/webgpu/internal/fake-device.js`);
const remote = process.argv.includes('--remote');
const modelOnly = process.argv.includes('--model');
const { recordedDirect3D } = remote ? await import(`${GRAPHICS}/remote/direct3d.js`) : {};
const { createSender } = remote ? await import(`${GRAPHICS}/remote/channel.js`) : {};
// The scenes of this checkout, over the graphics layer of the one measured.
const { SCENES } = await import(`${pathToFileURL(`${HERE}/tools/graphics-scenes.mjs`).href}`
    + `?root=${encodeURIComponent(GRAPHICS)}`);

/** @param {string[]} argv */
function parse(argv){
    const options = { scene: 'd3d8-lit', draws: 200, frames: 60, interval: 1024, top: 12,
        json: false };
    for (let index = 0; index < argv.length; index++)
    {
        const arg = argv[index];
        const value = ()=>argv[++index];
        if (arg === '--scene') options.scene = value();
        else if (arg === '--draws') options.draws = Number(value());
        else if (arg === '--frames') options.frames = Number(value());
        else if (arg === '--interval') options.interval = Number(value());
        else if (arg === '--top') options.top = Number(value());
        else if (arg === '--json') options.json = true;
        else if (arg === '--root') index++;
        else if (arg === '--remote' || arg === '--model') continue;
        else throw new Error(`unknown argument ${arg}`);
    }
    return options;
}

/**
 * The recording double with what its render passes record and its queue's
 * writes left out: a pass of it resolves every binding and keeps every call,
 * which is the double's work, and inlined into the backend's own calls the
 * profiler would put it to the engine's account.
 *
 * @param {any} gpu
 */
function quietPasses(gpu){
    const nothing = ()=>{};
    // Nor does its queue keep a copy of every write: a frame's uniform
    // blocks, copied twice, are external memory a browser's queue does not
    // put on the JavaScript heap, and which moved the collector here as it
    // would not there.
    gpu.queue.writeBuffer = nothing;
    const encoderFor = gpu.device.createCommandEncoder.bind(gpu.device);
    gpu.device.createCommandEncoder = (/** @type {any[]} */ ...args)=>{
        const encoder = encoderFor(...args);
        const open = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (/** @type {any} */ descriptor)=>{
            const pass = open(descriptor);
            for (const key of Object.keys(pass))
            {
                if (typeof pass[key] === 'function')
                {
                    pass[key] = nothing;
                }
            }
            return pass;
        };
        return encoder;
    };
    return gpu;
}

/**
 * The sampled allocation profile's nodes flattened, each with the bytes it
 * allocated itself.
 *
 * @param {any} node @param {{ name: string, url: string, line: number, bytes: number }[]} into
 * @param {{ name: string, url: string, line: number } | null} caller
 */
function flatten(node, into = [], caller = null){
    const frame = node.callFrame;
    // A builtin (a join, an iterator's next) has no script of its own; its
    // allocations are its caller's, which is what can be changed.
    const own = frame.url ? { name: frame.functionName || '(anonymous)', url: frame.url,
        line: frame.lineNumber + 1 } : null;
    const at = own ?? caller;
    const self = node.selfSize ?? 0;
    if (self > 0)
    {
        into.push(own || !at
            ? { ...(at ?? { name: frame.functionName || '(root)', url: '', line: 0 }), bytes: self }
            : { ...at, name: `${frame.functionName} in ${at.name}`, bytes: self });
    }
    for (const child of node.children ?? [])
    {
        flatten(child, into, at);
    }
    return into;
}

/** @param {string} url */
const isDouble = url=>url.includes('fake-device.js') || url.includes('draw-alloc-bench')
    || url.includes('graphics-scenes');

/**
 * @param {{ frame: () => Promise<void> }} scene @param {number} frames
 * @param {number} interval
 */
async function allocationsOf(scene, frames, interval){
    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
        samplingInterval: interval,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
    });
    for (let frame = 0; frame < frames; frame++)
    {
        await scene.frame();
    }
    const { profile } = await session.post('HeapProfiler.stopSampling');
    await session.post('HeapProfiler.disable');
    session.disconnect();
    const nodes = flatten(profile.head);
    let engine = 0;
    let double = 0;
    /** @type {Map<string, { name: string, where: string, bytes: number }>} */
    const byFunction = new Map();
    for (const node of nodes)
    {
        if (isDouble(node.url))
        {
            double += node.bytes;
            continue;
        }
        engine += node.bytes;
        const where = node.url.startsWith('file:')
            ? `${relative(ROOT, fileURLToPath(node.url))}:${node.line}` : node.url;
        const key = `${node.name}@${where}`;
        const held = byFunction.get(key) ?? { name: node.name, where, bytes: 0 };
        held.bytes += node.bytes;
        byFunction.set(key, held);
    }
    return { engine, double, byFunction };
}

/** @param {{ frame: () => Promise<void> }} scene @param {number} frames */
async function timeOf(scene, frames){
    /** @type {number[]} */
    const pauses = [];
    const observer = new PerformanceObserver(list=>{
        for (const entry of list.getEntries())
        {
            pauses.push(entry.duration);
        }
    });
    observer.observe({ entryTypes: ['gc'] });
    const start = performance.now();
    for (let frame = 0; frame < frames; frame++)
    {
        await scene.frame();
    }
    const elapsed = performance.now() - start;
    // The observer is told after the fact; a turn of the loop lets it hear,
    // and what it has not been handed yet is taken.
    await new Promise(done=>setTimeout(done, 10));
    for (const entry of observer.takeRecords())
    {
        pauses.push(entry.duration);
    }
    observer.disconnect();
    return { elapsed, pauses };
}

async function main(){
    const options = parse(process.argv.slice(2));
    const make = SCENES[options.scene];
    if (!make)
    {
        throw new Error(`no scene ${options.scene}; there are ${Object.keys(SCENES).join(', ')}`);
    }
    const warm = Math.max(10, options.frames >> 2);
    /** @type {Record<string, any>} */
    const runs = {};
    for (const draws of [options.draws, options.draws * 2])
    {
        const gpu = quietPasses(createFakeDevice());
        gpu.modelOnly = modelOnly;
        if (remote)
        {
            // The batch crosses as a port carries it; what waits for an
            // answer is answered at once, with nothing.
            /** @type {number[]} */
            const owed = [];
            const sender = createSender({
                post: (/** @type {any} */ message, /** @type {any[]} */ transfer)=>{
                    structuredClone(message, { transfer });
                    for (const serial of owed.splice(0))
                    {
                        queueMicrotask(()=>sender.receive({ type: 'answer', serial, answer: 0,
                            outs: [] }));
                    }
                },
                framesAhead: Infinity,
            });
            const called = sender.called;
            let serials = 0;
            sender.called = (/** @type {number} */ wait, /** @type {string} */ name)=>{
                if (wait === 1 && name !== 'diagnostics')
                {
                    owed.push(++serials);
                }
                return called(wait, name);
            };
            gpu.root = (/** @type {any} */ factory, /** @type {any} */ services)=>
                recordedDirect3D(factory, services, sender);
        }
        const scene = make(draws, gpu);
        for (let frame = 0; frame < warm; frame++)
        {
            await scene.frame();
        }
        const timed = await timeOf(scene, options.frames);
        const allocated = await allocationsOf(scene, options.frames, options.interval);
        runs[draws] = { timed, allocated };
    }
    const small = runs[options.draws];
    const large = runs[options.draws * 2];
    const drawn = options.draws * options.frames;
    const perDraw = (/** @type {number} */ a, /** @type {number} */ b)=>(b - a) / drawn;
    const pauses = large.timed.pauses;
    const result = {
        scene: options.scene,
        draws: options.draws,
        frames: options.frames,
        engineBytesPerDraw: perDraw(small.allocated.engine, large.allocated.engine),
        engineBytesPerFrame: large.allocated.engine / options.frames,
        doubleBytesPerFrame: large.allocated.double / options.frames,
        microsecondsPerDraw: perDraw(small.timed.elapsed, large.timed.elapsed) * 1000,
        millisecondsPerFrame: large.timed.elapsed / options.frames,
        collections: pauses.length,
        pauseTotalMs: pauses.reduce((sum, one)=>sum + one, 0),
        pauseLongestMs: pauses.reduce((most, one)=>Math.max(most, one), 0),
        top: [...large.allocated.byFunction.values()].sort((a, b)=>b.bytes - a.bytes)
            .slice(0, options.top)
            .map(entry=>({ ...entry, bytesPerDraw: entry.bytes / (options.draws * 2
                * options.frames) })),
    };
    if (options.json)
    {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    const round = (/** @type {number} */ value, digits = 1)=>value.toFixed(digits);
    console.log(`${result.scene}: ${result.draws} and ${result.draws * 2} draws a frame, `
        + `${result.frames} frames`);
    console.log(`  engine bytes a draw   ${round(result.engineBytesPerDraw)}`);
    console.log(`  engine bytes a frame  ${round(result.engineBytesPerFrame, 0)} `
        + `(${2 * result.draws} draws; the double's own ${round(result.doubleBytesPerFrame, 0)})`);
    console.log(`  us a draw             ${round(result.microsecondsPerDraw, 2)}`);
    console.log(`  ms a frame            ${round(result.millisecondsPerFrame, 2)}`);
    const pausedMs = round(result.pauseTotalMs, 2);
    const longestMs = round(result.pauseLongestMs, 2);
    console.log(`  collections           ${result.collections}, ${pausedMs} ms in all, `
        + `the longest ${longestMs} ms`);
    console.log('  the engine\'s allocations, bytes a draw at 2N:');
    for (const entry of result.top)
    {
        console.log(`    ${round(entry.bytesPerDraw).padStart(8)}  ${entry.name}  ${entry.where}`);
    }
}

await main();
