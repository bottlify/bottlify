/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a frame of each graphics scene (`tools/graphics-scenes.mjs`) costs, in
 * node, over the recording GPU double: the program's thread, and -- where the
 * scene's API is drawn in the graphics worker -- that worker, each as the
 * time its event loop was busy for a frame. No browser and no GPU, so it says
 * nothing of the device's own work; what it measures is the JavaScript each
 * thread runs, which is where the engine's part of a frame is.
 *
 *     node tools/graphics-node-bench.mjs [--scenes a,b] [--draws N] [--frames F]
 *         [--warm W] [--reps R] [--modes direct,remote] [--roots name=dir,...] [--json]
 *
 * `direct` draws on the program's thread, as a build without the graphics
 * worker does. `remote` records on it and plays the calls in a worker thread
 * of its own over a message port, as the graphics worker does: a Direct3D 7,
 * 8 or 9 root or an OpenGL root, each played as `remote/worker.js` plays it.
 * A scene whose API is not drawn there (DirectDraw) has no `remote` row, nor
 * does a root whose tree has no `remote/` for that API.
 *
 * `--roots` names checkouts whose graphics layer is measured, each with this
 * checkout's scenes; every run is a process of its own, the runs interleaved
 * root by root, and the fastest of `--reps` for the thread kept.
 *
 * `--alloc`: what a frame of draws allocates on the JavaScript heap, and what it costs,
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
 *   node tools/graphics-node-bench.mjs --alloc [--scene NAME] [--draws N] [--frames F]
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
 *   d3d9-materials   the same with a material per draw: a pixel constant, one
 *                 of 32 textures and an alpha reference out of 96 in turn, so
 *                 the frame draws with 96 render states
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

import { spawnSync } from 'node:child_process';
import { Session } from 'node:inspector/promises';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative, resolve } from 'node:path';
import { MessageChannel, Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SELF = fileURLToPath(import.meta.url);

/** The API a scene draws through, by the start of its name. @param {string} scene */
const apiOf = scene=>(scene.startsWith('gl-') ? 'opengl'
    : scene.startsWith('d3d7') ? 'd3d7'
        : scene.startsWith('d3d8') ? 'd3d8'
            : scene.startsWith('d3d9') ? 'd3d9' : null);

/** @param {string} graphics  the graphics layer's URL @param {string} path */
const load = (graphics, path)=>import(`${graphics}/${path}`);

/**
 * The played side, in a worker thread: one root per port it is handed, each
 * over a backend on its own recording double, as the graphics worker plays it.
 */
async function serve(){
    const { graphics } = workerData;
    const { createFakeDevice } = await load(graphics, 'webgpu/internal/fake-device.js');
    const { createBackend } = await load(graphics, 'webgpu/backend.js');
    const { createReceiver } = await load(graphics, 'remote/channel.js');
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    /** @param {string} api @param {import('node:worker_threads').MessagePort} port */
    const root = async(api, port)=>{
        /** @type {(message: any, transfer?: any[]) => void} */
        const post = (message, transfer)=>port.postMessage(message, transfer ?? []);
        const wrote = (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            post({ type: 'wrote', writes: [{ address, bytes: bytes.slice() }] });
        let played;
        if (api === 'opengl')
        {
            const { playedOpengl } = await load(graphics, 'remote/opengl.js');
            const { createOpenglRoot } = await load(graphics, 'opengl/root.js');
            played = playedOpengl(createOpenglRoot, { backend: ()=>backend, createSampler,
                writeMemory: wrote, frameQueued: (/** @type {any} */ settled)=>settled });
        }
        else if (api === 'd3d7')
        {
            const { playedDirect3D7 } = await load(graphics, 'remote/d3d7.js');
            played = playedDirect3D7({ backend, createSampler, writeMemory: wrote });
        }
        else
        {
            const { playedDirect3D } = await load(graphics, 'remote/direct3d.js');
            const { [api === 'd3d8' ? 'createDirect3D8' : 'createDirect3D9']: factory } =
                await load(graphics, `${api}/device.js`);
            played = playedDirect3D(factory, { backend, createSampler, readMemory: true,
                writeMemory: wrote });
        }
        const receiver = createReceiver({ played, post });
        port.on('message', data=>{
            receiver.receive(data);
            // The double keeps every call made of it; a worker that plays
            // frame after frame lets them go.
            gpu.reset();
        });
    };
    /** @type {Promise<void>} */
    let ready = Promise.resolve();
    /** @type {ReturnType<typeof performance.eventLoopUtilization> | null} */
    let since = null;
    parentPort?.on('message', message=>{
        if (message.type === 'root')
        {
            ready = ready.then(()=>root(message.api, message.port));
        }
        else if (message.type === 'mark')
        {
            since = performance.eventLoopUtilization();
            parentPort?.postMessage({ type: 'marked' });
        }
        else if (message.type === 'busy')
        {
            const used = performance.eventLoopUtilization(since ?? undefined);
            parentPort?.postMessage({ type: 'busy', ms: used.active });
        }
    });
}

/**
 * One scene on one root in one mode, in this process: the program's thread
 * busy per frame, the worker's, frames a second by the wall clock, and the
 * bytes sent a frame.
 *
 * @param {{ root: string, scene: string, mode: string, draws: number, frames: number,
 *     warm: number }} job
 */
async function child(job){
    const graphics = pathToFileURL(`${job.root}/modules/core/src/layers/graphics`).href;
    const { createFakeDevice } = await load(graphics, 'webgpu/internal/fake-device.js');
    const { SCENES } = await import(`${pathToFileURL(`${HERE}/tools/graphics-scenes.mjs`).href}`
        + `?root=${encodeURIComponent(graphics)}`);
    if (!SCENES[job.scene])
    {
        return { error: `no scene ${job.scene}` };
    }
    const gpu = createFakeDevice();
    /** @type {any} */
    const sceneGpu = { device: gpu.device, queue: gpu.queue, reset: ()=>gpu.reset() };
    /** @type {Worker | null} */
    let worker = null;
    let sent = 0;
    if (job.mode === 'remote')
    {
        const api = apiOf(job.scene);
        const remotes = { opengl: 'remote/opengl.js', d3d7: 'remote/d3d7.js',
            d3d8: 'remote/direct3d.js', d3d9: 'remote/direct3d.js' };
        if (!api)
        {
            return { skipped: 'not drawn in the graphics worker' };
        }
        const recorded = await load(graphics, remotes[api]).catch(()=>null);
        const { createSender } = await load(graphics, 'remote/channel.js').catch(()=>({}));
        if (!recorded || !createSender)
        {
            return { skipped: `this tree does not draw ${api} in the graphics worker` };
        }
        worker = new Worker(SELF, { workerData: { graphics } });
        const port = ()=>{
            const { port1, port2 } = new MessageChannel();
            /** @type {Worker} */ (worker).postMessage({ type: 'root', api, port: port2 },
                [port2]);
            /** @param {any} message @param {any[]} transfer */
            const post = (message, transfer)=>{
                sent += message.buffer?.byteLength ?? 0;
                port1.postMessage(message, transfer);
            };
            const sender = createSender({ post });
            port1.on('message', data=>sender.receive(data));
            port1.unref();
            return sender;
        };
        if (api === 'opengl')
        {
            sceneGpu.opengl = (/** @type {any} */ factory, /** @type {any} */ services)=>
                recorded.recordedOpengl(factory, services, port());
        }
        else if (api === 'd3d7')
        {
            sceneGpu.d3d7 = (/** @type {any} */ ddraw, /** @type {any} */ services)=>
                recorded.recordedDirect3D7(ddraw, services, port());
        }
        else
        {
            sceneGpu.root = (/** @type {any} */ factory, /** @type {any} */ services)=>
                recorded.recordedDirect3D(factory, services, port());
        }
    }
    /** @param {any} message @param {string} reply */
    const ask = (message, reply)=>new Promise(answer=>{
        /** @param {any} data */
        const take = data=>{
            if (data.type === reply)
            {
                worker?.off('message', take);
                answer(data);
            }
        };
        worker?.on('message', take);
        worker?.postMessage(message);
    });
    const scene = await SCENES[job.scene](job.draws, sceneGpu);
    // A frame's promises settle without the event loop going round, and its
    // busy time is counted only when it does: each frame ends with a turn of it.
    const turn = ()=>new Promise(done=>setImmediate(done));
    for (let frame = 0; frame < job.warm; frame++)
    {
        await scene.frame();
        await turn();
    }
    if (worker)
    {
        await ask({ type: 'mark' }, 'marked');
    }
    sent = 0;
    const since = performance.eventLoopUtilization();
    const started = performance.now();
    for (let frame = 0; frame < job.frames; frame++)
    {
        await scene.frame();
        await turn();
    }
    const wall = performance.now() - started;
    const thread = performance.eventLoopUtilization(since).active;
    const busy = worker ? /** @type {any} */ (await ask({ type: 'busy' }, 'busy')).ms : null;
    await worker?.terminate();
    return {
        threadMs: thread / job.frames,
        workerMs: busy === null ? null : busy / job.frames,
        fps: job.frames * 1000 / wall,
        sentKiB: sent / job.frames / 1024,
    };
}

/** @param {string[]} argv */
function parse(argv){
    const options = {
        scenes: ['gl-buffers', 'gl-client', 'd3d7-lit', 'd3d9-lit', 'd3d9-shader', 'ddraw-32'],
        draws: 200, frames: 40, warm: 10, reps: 3, modes: ['direct', 'remote'],
        roots: [{ name: 'head', dir: HERE }], json: false,
    };
    for (let index = 0; index < argv.length; index++)
    {
        const arg = argv[index];
        const value = ()=>argv[++index];
        if (arg === '--scenes') options.scenes = value().split(',');
        else if (arg === '--draws') options.draws = Number(value());
        else if (arg === '--frames') options.frames = Number(value());
        else if (arg === '--warm') options.warm = Number(value());
        else if (arg === '--reps') options.reps = Number(value());
        else if (arg === '--modes') options.modes = value().split(',');
        else if (arg === '--roots')
        {
            options.roots = value().split(',').map(pair=>{
                const [name, dir] = pair.split('=');
                return { name, dir: resolve(dir) };
            });
        }
        else if (arg === '--json') options.json = true;
        else throw new Error(`unknown argument ${arg}`);
    }
    return options;
}

/** --alloc: the allocations and the time of a frame of draws, in this process. */
async function allocations(){
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
    function parseAlloc(argv){
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
            else if (arg === '--remote' || arg === '--model' || arg === '--alloc') continue;
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
                ? { ...(at ?? { name: frame.functionName || '(root)', url: '', line: 0 }),
                    bytes: self }
                : { ...at, name: `${frame.functionName} in ${at.name}`, bytes: self });
        }
        for (const below of node.children ?? [])
        {
            flatten(below, into, at);
        }
        return into;
    }

    /** @param {string} url */
    const isDouble = url=>url.includes('fake-device.js') || url.includes('graphics-node-bench')
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
        const options = parseAlloc(process.argv.slice(2));
        const make = SCENES[options.scene];
        if (!make)
        {
            throw new Error(`no scene ${options.scene}; there are`
                + ` ${Object.keys(SCENES).join(', ')}`);
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
            + `(${2 * result.draws} draws; the double's own`
            + ` ${round(result.doubleBytesPerFrame, 0)})`);
        console.log(`  us a draw             ${round(result.microsecondsPerDraw, 2)}`);
        console.log(`  ms a frame            ${round(result.millisecondsPerFrame, 2)}`);
        const pausedMs = round(result.pauseTotalMs, 2);
        const longestMs = round(result.pauseLongestMs, 2);
        console.log(`  collections           ${result.collections}, ${pausedMs} ms in all, `
            + `the longest ${longestMs} ms`);
        console.log('  the engine\'s allocations, bytes a draw at 2N:');
        for (const entry of result.top)
        {
            console.log(`    ${round(entry.bytesPerDraw).padStart(8)}  ${entry.name}`
                + `  ${entry.where}`);
        }
    }

    await main();
}

if (!isMainThread)
{
    await serve();
}
else if (process.argv.includes('--alloc'))
{
    await allocations();
}
else if (process.argv[2] === '--child')
{
    const result = await child(JSON.parse(process.argv[3])).catch(error=>(
        { error: String(error?.stack ?? error) }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
}
else
{
    const options = parse(process.argv.slice(2));
    /** @type {Map<string, any>} */
    const best = new Map();
    for (let rep = 0; rep < options.reps; rep++)
    {
        for (const scene of options.scenes)
        {
            for (const mode of options.modes)
            {
                for (const { name, dir } of options.roots)
                {
                    const job = { root: dir, scene, mode, draws: options.draws,
                        frames: options.frames, warm: options.warm };
                    const run = spawnSync(process.execPath, [SELF, '--child', JSON.stringify(job)],
                        { encoding: 'utf8', timeout: 600_000 });
                    const line = (run.stdout ?? '').trim().split('\n').pop() ?? '';
                    /** @type {any} */
                    let result;
                    try
                    {
                        result = JSON.parse(line);
                    }
                    catch {
                        result = {
                            error: (run.stderr || line || `exit ${run.status}`).slice(0, 400),
                        };
                    }
                    const key = `${scene}\u0000${mode}\u0000${name}`;
                    const held = best.get(key);
                    if (!held || (result.threadMs ?? Infinity) < (held.threadMs ?? Infinity))
                    {
                        best.set(key, { scene, mode, root: name, ...result });
                    }
                    process.stderr.write(`rep ${rep} ${scene} ${mode} ${name}\n`);
                }
            }
        }
    }
    const rows = [...best.values()];
    if (options.json)
    {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    }
    else
    {
        /** @param {number | null | undefined} value */
        const ms = value=>(value === null || value === undefined ? '-' : value.toFixed(2));
        console.log(`ms a frame busy, ${options.draws} draws, fastest of ${options.reps}`
            + ` (recording double: no device work)`);
        console.log(`${'scene'.padEnd(14)}${'mode'.padEnd(8)}${'root'.padEnd(10)}`
            + `${'thread'.padStart(9)}${'worker'.padStart(9)}${'fps'.padStart(9)}`
            + `${'KiB/frame'.padStart(11)}`);
        for (const row of rows)
        {
            const tail = row.error ? `  error: ${row.error.split('\n')[0]}`
                : row.skipped ? `  (${row.skipped})` : '';
            console.log(`${row.scene.padEnd(14)}${row.mode.padEnd(8)}${row.root.padEnd(10)}`
                + `${ms(row.threadMs).padStart(9)}${ms(row.workerMs).padStart(9)}`
                + `${ms(row.fps).padStart(9)}${ms(row.sentKiB).padStart(11)}${tail}`);
        }
    }
}
