/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a frame of draws allocates on the JavaScript heap, and what it costs,
 * in node: a scene drives a graphics device over the recording GPU double
 * frame after frame, and three things are measured over the frames after a
 * warm-up --
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
 *
 * `--top K` prints the K functions of the engine's own code that allocated
 * the most, with the file and line each starts at. `--root DIR` measures the
 * engine of another checkout, for a tree before a change against one after.
 */

import { Session } from 'node:inspector/promises';
import { PerformanceObserver } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rootAt = process.argv.indexOf('--root');
const ROOT = rootAt > 0 ? resolve(process.argv[rootAt + 1]) : HERE;
const GRAPHICS = `${ROOT}/modules/core/src/layers/graphics`;

const {
    D3DFMT, D3DFMT_INDEX, D3DLIGHTTYPE, D3DPOOL, D3DPT, D3DRS, D3DSWAPEFFECT, D3DTS, D3DCLEAR,
    D3DCULL, D3D_OK,
} = await import(`${GRAPHICS}/d3d8/constants.js`);
const { createDirect3D8 } = await import(`${GRAPHICS}/d3d8/device.js`);
const { createBackend } = await import(`${GRAPHICS}/webgpu/backend.js`);
const { createFakeDevice } = await import(`${GRAPHICS}/webgpu/internal/fake-device.js`);
const { FVF } = await import(`${GRAPHICS}/webgpu/internal/vertexformat.js`);

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
        else throw new Error(`unknown argument ${arg}`);
    }
    return options;
}

const RAM_BASE = 0x40000000;

/** @param {number} value @param {number} index */
const check = (value, index = 0)=>{
    if (value !== D3D_OK)
    {
        throw new Error(`call ${index} answered 0x${(value >>> 0).toString(16)}`);
    }
};

/**
 * @param {Partial<any>} over
 */
const light = (over = {})=>({
    Type: D3DLIGHTTYPE.DIRECTIONAL,
    Diffuse: { r: 1, g: 0.5, b: 0.25, a: 1 },
    Specular: { r: 0.5, g: 0.25, b: 0.125, a: 1 },
    Ambient: { r: 0.125, g: 0.0625, b: 0.03125, a: 1 },
    Position: { x: 1, y: 2, z: 3 },
    Direction: { x: 0, y: -1, z: 1 },
    Range: 50,
    Falloff: 1,
    Attenuation0: 1,
    Attenuation1: 0.1,
    Attenuation2: 0,
    Theta: 0.5,
    Phi: 1,
    ...over,
});

/**
 * A Direct3D 8 device over the recording double, and a frame of `draws`
 * draws on it.
 *
 * @param {{ draws: number, moving: boolean }} scene
 */
function d3d8Scene({ draws, moving }){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(8 << 20);
    const d3d = createDirect3D8({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        windowMemory: (address, length)=>ram.subarray(address - RAM_BASE,
            address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
    });
    /** @type {{ device?: any }} */
    const out = {};
    check(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 64,
        backBufferHeight: 64, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    }, out));
    const device = out.device;

    // A cube: 24 vertices of position, normal and one coordinate set, 36 indices.
    const fvf = FVF.XYZ | FVF.NORMAL | (1 << FVF.TEXCOUNT_SHIFT);
    const stride = 32;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    check(device.CreateVertexBuffer(24 * stride, 0, fvf, D3DPOOL.MANAGED, vertices));
    check(device.CreateIndexBuffer(36 * 2, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, indices));
    /** @type {{ pBits?: number }} */
    const locked = {};
    check(vertices.buffer.Lock(0, 0, locked, 0));
    const view = new DataView(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE,
        24 * stride);
    for (let face = 0; face < 6; face++)
    {
        const axis = face >> 1;
        const sign = face & 1 ? -1 : 1;
        for (let corner = 0; corner < 4; corner++)
        {
            const at = (face * 4 + corner) * stride;
            const p = [0, 0, 0];
            p[axis] = sign;
            p[(axis + 1) % 3] = corner & 1 ? 1 : -1;
            p[(axis + 2) % 3] = corner & 2 ? 1 : -1;
            const n = [0, 0, 0];
            n[axis] = sign;
            [...p, ...n, corner & 1, corner >> 1].forEach((value, index)=>
                view.setFloat32(at + index * 4, value, true));
        }
    }
    check(vertices.buffer.Unlock());
    check(indices.buffer.Lock(0, 0, locked, 0));
    const index16 = new Uint16Array(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE,
        36);
    for (let face = 0; face < 6; face++)
    {
        index16.set([0, 1, 2, 2, 1, 3].map(corner=>face * 4 + corner), face * 6);
    }
    check(indices.buffer.Unlock());

    /** @type {any[]} */
    const textures = [];
    for (let made = 0; made < 2; made++)
    {
        /** @type {{ texture?: any }} */
        const texture = {};
        check(device.CreateTexture(16, 16, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, texture));
        /** @type {{ pBits?: number }} */
        const rect = {};
        check(texture.texture.LockRect(0, rect, null, 0));
        ram.fill(0x40 + made * 0x40, /** @type {number} */ (rect.pBits) - RAM_BASE,
            /** @type {number} */ (rect.pBits) - RAM_BASE + 16 * 16 * 4);
        check(texture.texture.UnlockRect(0));
        textures.push(texture.texture);
    }

    check(device.SetRenderState(D3DRS.LIGHTING, 1));
    check(device.SetRenderState(D3DRS.AMBIENT, 0xff202020));
    check(device.SetMaterial({
        Diffuse: { r: 1, g: 1, b: 1, a: 1 }, Ambient: { r: 1, g: 1, b: 1, a: 1 },
        Specular: { r: 0, g: 0, b: 0, a: 0 }, Emissive: { r: 0, g: 0, b: 0, a: 0 }, Power: 0,
    }));
    const lights = [
        light(),
        light({ Type: D3DLIGHTTYPE.POINT }),
        light({ Type: D3DLIGHTTYPE.SPOT, Direction: { x: 0, y: 0, z: 1 } }),
    ];
    lights.forEach((one, index)=>{
        check(device.SetLight(index, one));
        check(device.LightEnable(index, true));
    });
    // Made before the frames, so the scene's own arrays are not what is counted.
    const worlds = Array.from({ length: draws }, (_, index)=>{
        const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        matrix[0] = 1 + (index % 7) / 8;
        matrix[12] = index % 17 - 8;
        matrix[13] = (index >> 4) % 11 - 5;
        matrix[14] = 20 + (index % 5);
        return matrix;
    });
    const movingLights = Array.from({ length: draws }, (_, index)=>
        light({ Type: D3DLIGHTTYPE.POINT, Position: { x: index % 13, y: 2, z: index % 9 } }));
    const viewMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
    const projection = new Float32Array([1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1.001, 1, 0, 0,
        -0.1, 0]);

    return {
        gpu,
        device,
        async frame(){
            check(device.BeginScene());
            check(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000, 1, 0));
            check(device.SetTransform(D3DTS.VIEW, viewMatrix));
            check(device.SetTransform(D3DTS.PROJECTION, projection));
            check(device.SetVertexShader(fvf));
            check(device.SetStreamSource(0, vertices.buffer, stride));
            check(device.SetIndices(indices.buffer, 0));
            for (let index = 0; index < draws; index++)
            {
                check(device.SetTransform(D3DTS.WORLD, worlds[index]), index);
                check(device.SetTexture(0, textures[index & 1]), index);
                check(device.SetRenderState(D3DRS.CULLMODE,
                    index & 2 ? D3DCULL.CW : D3DCULL.CCW), index);
                check(device.SetLight(1, moving ? movingLights[index] : lights[1]), index);
                check(device.LightEnable(1, true), index);
                check(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 24, 0, 12), index);
            }
            check(device.EndScene());
            check(device.Present());
            await device.idle();
            gpu.reset();
        },
    };
}

/** @type {Record<string, (draws: number) => ReturnType<typeof d3d8Scene>>} */
const SCENES = {
    'd3d8-lit': draws=>d3d8Scene({ draws, moving: false }),
    'd3d8-moving': draws=>d3d8Scene({ draws, moving: true }),
};

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
const isDouble = url=>url.includes('fake-device.js') || url.includes('draw-alloc-bench');

/**
 * @param {ReturnType<typeof d3d8Scene>} scene @param {number} frames
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

/** @param {ReturnType<typeof d3d8Scene>} scene @param {number} frames */
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
        const scene = make(draws);
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
