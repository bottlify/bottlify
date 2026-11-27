/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the bytes a frame keeps until its replay (`gpu.js`
 * `keptForReplay`): an upload or a depth write that takes its place among the
 * commands of the frame being recorded, because that frame already samples
 * the texture, hands its bytes to the device's texel store and holds only
 * their key. Seeded programs of textures in several kinds - legacy RGBA,
 * sized red-green, S3TC decoded on the way up or kept as blocks on a device
 * that samples them, depth - written whole and in part between draws that
 * sample them, run over the two real ways a root holds the run's cache under
 * its store: the names a root drawn on the run's own thread holds
 * (`ownedSpace`), the reference, and those a root in the graphics worker
 * holds (`channelSpace`). The device must be given the same calls with the
 * same bytes, and nothing may be left in the store or under the root's names
 * once the frames are replayed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { TEX } from './formats.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { openRunCache } from '../../../process/run-cache.js';
import { channelSpace, ownedSpace } from '../../cache/module.js';
import { roomy, testScratch } from '../../cache/testing.fixture.js';

/** @param {number} seed @returns {() => number} 0 up to 2^32 */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

const turn = ()=>new Promise(resolve=>setTimeout(resolve, 0));

/** A call as text: the double's objects left out, bytes by their exact values. @param {any} call */
const callText = call=>JSON.stringify({ op: call.op, size: call.size, layout: call.layout,
    origin: call.destination?.origin, mipLevel: call.destination?.mipLevel,
    bufferOffset: call.bufferOffset, bytes: call.bytes ? [...call.bytes].join(',') : undefined });

/**
 * The kinds of texture a program makes: how a level is given, and how a
 * part of it is written again.
 *
 * @type {{ name: string, make: (gl: any, side: number, bytes: (n: number) => Uint8Array)
 *     => void, write: (gl: any, side: number, next: () => number,
 *     bytes: (n: number) => Uint8Array) => void }[]}
 */
const KINDS = [
    { name: 'rgba',
        make: (gl, side, bytes)=>gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, side, side, 0,
            GL.RGBA, GL.UNSIGNED_BYTE, bytes(side * side * 4)),
        // Rows whole on some writes, a rectangle inside on others.
        write: (gl, side, next, bytes)=>{
            const width = next() % 2 === 0 ? side : 8 + next() % 24;
            const height = 8 + next() % 24;
            const x = side === width ? 0 : next() % (side - width);
            const y = next() % (side - height);
            gl.glTexSubImage2D(GL.TEXTURE_2D, 0, x, y, width, height, GL.RGBA, GL.UNSIGNED_BYTE,
                bytes(width * height * 4));
        } },
    { name: 'rg8',
        make: (gl, side, bytes)=>gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RG8, side, side, 0,
            TEX.RG, GL.UNSIGNED_BYTE, bytes(side * side * 2)),
        write: (gl, side, next, bytes)=>{
            const height = 8 + next() % 24;
            gl.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, next() % (side - height), side, height,
                TEX.RG, GL.UNSIGNED_BYTE, bytes(side * height * 2));
        } },
    { name: 'dxt5',
        make: (gl, side, bytes)=>gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, side, side, 0, side * side, bytes(side * side)),
        // A level given again whole: its blocks, which a rectangle would turn into texels.
        write: (gl, side, next, bytes)=>gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, side, side, 0, side * side, bytes(side * side)) },
    { name: 'dxt1',
        make: (gl, side, bytes)=>gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGB_S3TC_DXT1_EXT, side, side, 0, side * side / 2,
            bytes(side * side / 2)),
        // A rectangle of blocks: the level decoded from then on.
        write: (gl, side, next, bytes)=>gl.glCompressedTexSubImage2DARB(GL.TEXTURE_2D, 0,
            4 * (next() % (side / 4 - 4)), 4 * (next() % (side / 4 - 4)), 16, 16,
            GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 128, bytes(128)) },
    { name: 'depth',
        make: (gl, side, bytes)=>gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.DEPTH_COMPONENT24, side,
            side, 0, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT, bytes(side * side * 4)),
        write: (gl, side, next, bytes)=>gl.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, side, 16,
            GL.DEPTH_COMPONENT, GL.UNSIGNED_INT, bytes(side * 16 * 4)) },
];

/**
 * One run of a seeded program: the calls the device was given, the store's
 * figures, the losses said, and what the cache held under the root's names
 * at the end.
 *
 * @param {number} seed @param {'worker' | 'thread'} where  the texels' store: the run's
 *     cache from the graphics worker or from the run's thread
 * @param {{ mutate?: boolean }} [options]  `mutate`: the cache's read of a body is wrong
 *     in its first byte, which the gate must see
 */
async function run(seed, where, { mutate = false } = {}){
    const next = random(seed);
    const fake = createFakeDevice({});
    const backend = createBackend({ scratches: testScratch,
        device: fake.device, queue: fake.queue, presentTo: ()=>{} });
    const runCache = await openRunCache({ budget: 64 << 20 });
    /** @type {ReturnType<typeof channelSpace> | ReturnType<typeof ownedSpace>} */
    let texels;
    if (where === 'worker')
    {
        /** @type {ReturnType<typeof channelSpace> | null} */
        let worker = null;
        worker = channelSpace(runCache.join(message=>worker?.adopt(message)),
            /** @type {NonNullable<ReturnType<typeof runCache.serve>>} */ (
                runCache.serve('texels')));
        texels = worker;
    }
    else
    {
        texels = ownedSpace(runCache.reader,
            /** @type {NonNullable<ReturnType<typeof runCache.own>>} */ (runCache.own('texels')));
    }
    if (mutate)
    {
        const space = texels.space;
        const read = space.with;
        space.with = (key, reader, options)=>read(key, body=>{
            const wrong = body.slice();
            wrong[0] ^= 0xff;
            return reader(wrong);
        }, options);
    }
    /** @type {string[]} */
    const losses = [];
    const renderer = createGpuRenderer({
        backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        divergence: (detail, severity)=>{
            if (severity === 'loss')
            {
                losses.push(detail);
            }
        },
        // Half the programs on a device that samples S3TC blocks as they are.
        compressedTextures: seed % 2 === 0,
        texelCache: texels,
    });
    const gl = /** @type {any} */ (createGlContext({ holds: roomy.api.hold, gpu: renderer }));
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    /** @param {number} n */
    const bytes = n=>new Uint8Array(n).map(()=>next() & 0xff);
    const count = 3 + next() % 4;
    const names = gl.glGenTextures(count);
    const made = names.map((/** @type {number} */ name)=>{
        const kind = KINDS[next() % KINDS.length];
        const side = 64 << next() % 2;
        gl.glBindTexture(GL.TEXTURE_2D, name);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        kind.make(gl, side, bytes);
        return { name, kind, side };
    });
    gl.glEnable(GL.TEXTURE_2D);
    for (let frame = 0; frame < 4; frame++)
    {
        // The levels no draw needs at the frame's start wait in the store,
        // and go up from where they wait.
        renderer.spill([...gl.shareGroup.textures.objects.values()]);
        const draws = 4 + next() % 6;
        for (let draw = 0; draw < draws; draw++)
        {
            const one = made[next() % made.length];
            gl.glBindTexture(GL.TEXTURE_2D, one.name);
            // Written while this frame may already sample it: the upload then
            // waits in the frame's order, its bytes in the store.
            if (next() % 3 !== 0)
            {
                one.kind.write(gl, one.side, next, bytes);
            }
            gl.glBegin(GL.TRIANGLES);
            gl.glTexCoord2f(0, 0);
            gl.glVertex2f(-1, -1);
            gl.glTexCoord2f(1, 0);
            gl.glVertex2f(1, -1);
            gl.glTexCoord2f(0, 1);
            gl.glVertex2f(-1, 1);
            gl.glEnd();
            // Some time for room asked for to be granted, as a frame's calls
            // take it: bodies move into the cache before their replay.
            if (next() % 2 === 0)
            {
                await turn();
            }
        }
        renderer.present(gl);
        await renderer.settled();
    }
    const spilled = /** @type {any} */ (renderer.diagnostics()).spills;
    // Deleted, the textures let go at the next look of what of them still waits.
    gl.glDeleteTextures(names);
    renderer.spill([...gl.shareGroup.textures.objects.values()]);
    const kept =()=>/** @type {any} */ (renderer.diagnostics()).keptTexels;
    for (let turns = 0; turns < 200 && (kept().asking > 0
        || runCache.under(texels.prefix).bodies > 0); turns++)
    {
        await turn();
    }
    const left = runCache.under(texels.prefix).bodies;
    const figures = kept();
    const released = await texels.close();
    runCache.close();
    return {
        calls: fake.calls.map(callText),
        kinds: made.map((/** @type {any} */ one)=>one.kind.name),
        kept: figures,
        inPlace: spilled.inPlace,
        spilledLevels: spilled.levels,
        losses,
        left,
        released,
    };
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test('a frame\'s uploads and depth writes give the device the same bytes from the graphics '
    + 'worker\'s names in the run\'s cache as from the run\'s thread\'s, and leave nothing there',
{ timeout: 240_000 }, async()=>{
    /** @type {Record<string, number>} */
    const moved = { worker: 0, thread: 0 };
    /** @type {Record<string, number>} */
    const inPlace = { worker: 0, thread: 0 };
    let puts = 0;
    /** @type {Set<string>} */
    const kinds = new Set();
    for (const seed of SEEDS)
    {
        const thread = await run(seed, 'thread');
        const worker = await run(seed, 'worker');
        const at = `seed ${seed}`;
        assert.ok(thread.calls.some(call=>call.includes('"writeTexture"')), at);
        assert.equal(worker.calls.length, thread.calls.length, at);
        for (let call = 0; call < thread.calls.length; call++)
        {
            assert.equal(worker.calls[call], thread.calls[call], `${at}: call ${call}`);
        }
        assert.equal(worker.kept.put - worker.spilledLevels,
            thread.kept.put - thread.spilledLevels, `${at}: the same bytes kept for the frames`);
        for (const [where, one] of Object.entries({ thread, worker }))
        {
            assert.deepEqual(one.losses, [], `${where}, ${at}`);
            assert.equal(one.kept.lost, 0, `${where}, ${at}`);
            assert.equal(one.kept.bodies, 0, `${where}, ${at}: every frame let its bytes go`);
            assert.equal(one.left, 0, `${where}, ${at}: nothing left under the root's names`);
            assert.deepEqual(one.released, { bodies: 0, bytes: 0, waiting: 0 }, `${where}, ${at}`);
            moved[where] += one.kept.moved;
            inPlace[where] += one.inPlace;
        }
        puts += thread.kept.put - thread.spilledLevels;
        for (const kind of thread.kinds)
        {
            kinds.add(kind);
        }
    }
    assert.ok(puts > 0, 'uploads waited for their frames');
    for (const where of ['thread', 'worker'])
    {
        assert.ok(moved[where] > 0, `${where}: some of their bytes waited in the run's cache`);
        assert.ok(inPlace[where] > 0, `${where}: levels uploaded from where they waited`);
    }
    assert.deepEqual([...kinds].sort(), KINDS.map(kind=>kind.name).sort(), 'every kind made');
});

test('the gate sees a wrong read of the run\'s cache', { timeout: 240_000 }, async()=>{
    let differed = 0;
    for (const seed of SEEDS)
    {
        const thread = await run(seed, 'thread');
        const wrong = await run(seed, 'worker', { mutate: true });
        differed += wrong.calls.some((call, at)=>call !== thread.calls[at]) ? 1 : 0;
    }
    assert.ok(differed > 0, 'a body read wrong reaches the device');
});
