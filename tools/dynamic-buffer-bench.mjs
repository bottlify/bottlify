/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Direct3D 9 recording and its played twin spend on draws from a
 * dynamic vertex buffer a program skins into, both sides in one thread: the
 * recording's draws (what it sends of the buffer) and the twin's (what it
 * uploads to its GPU copy), on a fake GPU. A synthetic frame shaped like
 * skinning, not one measured from a game: a buffer of 400 meshes of 40 KB;
 * each frame rewrites 80 random meshes in the program's memory, which an
 * engine's write watch sees, then draws 600 times, each a whole random mesh,
 * and presents. Measured over the frames after five.
 *
 *   node tools/dynamic-buffer-bench.mjs [--frames N] [--root DIR]
 *
 * `--root` is a tree to take the engine from, for the same frames before and
 * after a change. One JSON line: milliseconds a frame, and the bytes the
 * recording compared and sent over the run.
 */

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const frames = Number(flag('--frames', '30'));
const root = pathToFileURL(`${resolve(flag('--root', '.'))}/`).href;
const core = `${root}modules/core/src/layers/graphics/`;
const { playedAtOnce, playedDirect3D, recordedDirect3D } = await import(
    `${core}remote/direct3d.js`);
const { createDirect3D9 } = await import(`${core}d3d9/device.js`);
const { createBackend } = await import(`${core}webgpu/backend.js`);
const { createFakeDevice } = await import(`${core}webgpu/internal/fake-device.js`);

const MESH = 40 * 1024;
const MESHES = 400;
const WRITTEN = 80;
const DRAWS = 600;
const WARM = 5;
const STRIDE = 16;
/** D3DFVF_XYZ | D3DFVF_DIFFUSE. */
const FVF = 0x002 | 0x040;

/** A seeded generator. @param {number} seed */
function random(seed){
    let s = seed >>> 0;
    return (/** @type {number} */ n)=>{
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
    };
}

/** The engine's write watch as the recording is promised it, over the program's stores. */
function watches(){
    /** @type {Set<{ first: number, last: number, dirty: Set<number> }>} */
    const all = new Set();
    return {
        /** @param {number} address @param {number} length */
        stored(address, length){
            for (const watch of all)
            {
                for (let page = Math.max(watch.first, address >>> 12);
                    page <= Math.min(watch.last, (address + length - 1) >>> 12); page++)
                {
                    watch.dirty.add(page);
                }
            }
        },
        /** @param {number} address @param {number} length */
        watchWrites(address, length){
            const watch = { first: address >>> 12, last: (address + length - 1) >>> 12,
                dirty: new Set() };
            all.add(watch);
            return {
                /** @param {number} from @param {number} bytes */
                take(from, bytes){
                    const pages = [];
                    for (let page = Math.max(watch.first, from >>> 12);
                        page <= Math.min(watch.last, (from + bytes - 1) >>> 12); page++)
                    {
                        if (watch.dirty.delete(page))
                        {
                            pages.push(page);
                        }
                    }
                    return pages;
                },
            };
        },
    };
}

const next = random(7);
const ram = new Uint8Array(32 << 20);
let free = 0x10000;
const engine = watches();
const gpu = createFakeDevice();
const services = {
    allocate: (/** @type {number} */ bytes)=>{
        const at = free;
        free += (bytes + 0xfff) & ~0xfff;
        return at;
    },
    readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
        ram.slice(at, at + length),
    windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
        ram.subarray(at, at + length),
    writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>ram.set(bytes, at),
    watchWrites: engine.watchWrites,
};
const played = playedDirect3D(createDirect3D9, {
    backend: createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 }),
    createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
    readMemory: true,
});
const transport = playedAtOnce(played);
/** The bytes the recording compared and sent of the buffer, by kind. @type {Record<string, number>} */
const shipped = {};
/** @type {any} */ (transport).shipped = (/** @type {string} */ kind, /** @type {number} */ bytes)=>{
    shipped[kind] = (shipped[kind] ?? 0) + bytes;
};
const d3d = recordedDirect3D(createDirect3D9, services, transport);
/** @type {{ device?: any }} */
const out = {};
d3d.CreateDevice({ swapEffect: 1, backBufferCount: 1, backBufferWidth: 64, backBufferHeight: 64,
    backBufferFormat: 22 }, out);
const device = out.device;
/** @type {{ buffer?: any }} */
const made = {};
// DYNAMIC | WRITEONLY, the default pool.
device.CreateVertexBuffer(MESH * MESHES, 0x200 | 0x8, FVF, 0, made);
/** @type {{ pBits?: number }} */
const locked = {};
made.buffer.Lock(0, 0, locked, 0x2000);
made.buffer.Unlock();
const base = /** @type {number} */ (locked.pBits);
device.SetFVF(FVF);
device.SetStreamSource(0, made.buffer, 0, STRIDE);
device.SetRenderState(137, 0);
const vertices = MESH / STRIDE;
let ms = 0;
for (let frame = 0; frame < frames; frame++)
{
    for (let mesh = 0; mesh < WRITTEN; mesh++)
    {
        const at = base + next(MESHES) * MESH;
        ram.fill((frame * 7 + mesh) & 0xff, at, at + MESH);
        engine.stored(at, MESH);
    }
    gpu.reset();
    const began = performance.now();
    device.BeginScene();
    for (let draw = 0; draw < DRAWS; draw++)
    {
        device.DrawPrimitive(4, next(MESHES) * vertices, Math.floor(vertices / 3));
    }
    device.EndScene();
    await device.Present();
    await device.idle();
    if (frame >= WARM)
    {
        ms += performance.now() - began;
    }
}
console.log(JSON.stringify({ root: flag('--root', '.'), msPerFrame: ms / (frames - WARM),
    compared: shipped.compared ?? 0, sent: shipped.dynamic ?? 0 }));
