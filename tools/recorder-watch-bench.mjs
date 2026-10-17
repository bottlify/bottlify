/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the graphics recorder spends on draws from a dynamic buffer, with the
 * write watch (`watchWrites`) and comparing every byte of each draw's range:
 * a synthetic frame shaped like skinning into one buffer, not one measured
 * from a game. A 16 MB buffer of 400 meshes of 40 KB under cork's own memory;
 * each frame rewrites 80 random meshes through the host's write path (which
 * marks pages as a store does), then draws 600 times, each a whole random
 * mesh. The recording's batches go nowhere: the draws' time on the engine
 * thread and the bytes compared and sent are what is measured, over the frames
 * after five.
 *
 *   node tools/recorder-watch-bench.mjs [--frames N] [--arm full|watch] [--root DIR]
 *
 * One JSON line per arm (both, full first, unless `--arm` names one): its
 * milliseconds a frame, and the bytes compared and sent over the whole run.
 */

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const frames = Number(flag('--frames', '40'));
const arm = flag('--arm', '');
const root = pathToFileURL(`${resolve(flag('--root', '.'))}/`).href;
const { createCorkHost } = await import(
    `${root}modules/core/src/layers/cpu/internal/cork-host.js`);
const engine = await import(`${root}modules/cork/src/index.js`);
const { createWriteClock } = await import(
    `${root}modules/core/src/layers/cpu/internal/write-clock.js`);
const { recordedDirect3D } = await import(
    `${root}modules/core/src/layers/graphics/remote/direct3d.js`);
const { createSender } = await import(`${root}modules/core/src/layers/graphics/remote/channel.js`);

const MESH = 40 * 1024;
const MESHES = 400;
const WRITTEN = 80;
const DRAWS = 600;
const WARM = 5;

/** A seeded generator. @param {number} seed */
function random(seed){
    let s = seed >>> 0;
    return (/** @type {number} */ n)=>{
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
    };
}

/** A root with a buffer and a draw of a range of it. @param {any} services */
const toy = services=>({
    /** @param {number} length @param {{ buffer?: any }} out */
    CreateBuffer(length, out){
        const base = services.allocate(length);
        out.buffer = { base, length };
        return 0;
    },
    /** @param {any} buffer @param {number} from @param {number} to */
    Draw(buffer, from, to){
        services.drawsFrom?.(buffer, from, to);
        return 0;
    },
});

/** @param {boolean} watched */
function run(watched){
    const next = random(7);
    const host = createCorkHost({ memorySize: 64 << 20, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: 0x300000, closedBelow: 0x10000, cork: {}, engine });
    const clock = createWriteClock({ take: host.takeWrites, epochs: ()=>[] });
    let free = 0x1000000;
    const services = {
        allocate: (/** @type {number} */ bytes)=>{
            const at = free;
            free += bytes;
            return at;
        },
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            host.readPhysical(at, length).slice(),
        windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            host.readPhysical(at, length),
        ...(watched ? { watchWrites: (/** @type {number} */ at, /** @type {number} */ length)=>
            clock.watch(at, length) } : {}),
    };
    const sender = createSender({ post: ()=>{}, later: flush=>flush() });
    const device = recordedDirect3D(toy, services, sender);
    /** @type {{ buffer?: any }} */
    const out = {};
    device.CreateBuffer(MESH * MESHES, out);
    const buffer = out.buffer;
    const chunk = new Uint8Array(MESH);
    let ms = 0;
    for (let frame = 0; frame < frames; frame++)
    {
        for (let mesh = 0; mesh < WRITTEN; mesh++)
        {
            chunk.fill(frame * 7 + mesh);
            host.writePhysical(buffer.base + next(MESHES) * MESH, chunk);
        }
        const began = performance.now();
        for (let draw = 0; draw < DRAWS; draw++)
        {
            const at = next(MESHES);
            device.Draw(buffer, at * MESH, (at + 1) * MESH);
        }
        if (frame >= WARM)
        {
            ms += performance.now() - began;
        }
    }
    const shipped = sender.shippedBytes();
    return { arm: watched ? 'watch' : 'full', msPerFrame: ms / (frames - WARM),
        compared: shipped.compared, sent: shipped.dynamic };
}

for (const watched of arm === 'full' ? [false] : arm === 'watch' ? [true] : [false, true])
{
    console.log(JSON.stringify(run(watched)));
}
