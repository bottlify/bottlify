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
 */

import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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

if (!isMainThread)
{
    await serve();
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
