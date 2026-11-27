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
 * sample them, run with the run's cache under the store and without one: the
 * names a root in the graphics worker holds (`channelSpace`) and those a root
 * drawn on the run's own thread holds (`ownedSpace`). The device must be
 * given the same calls with the same bytes, and nothing may be left in the
 * store or under the root's names once the frames are replayed.
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
 * @param {number} seed @param {'plain' | 'worker' | 'thread'} where  the texels' store:
 *     plain memory, or the run's cache from the graphics worker or from the run's thread
 * @param {{ mutate?: boolean }} [options]  `mutate`: the cache's read of a body is wrong
 *     in its first byte, which the gate must see
 */
async function run(seed, where, { mutate = false } = {}){
    const next = random(seed);
    const fake = createFakeDevice({});
    const backend = createBackend({ device: fake.device, queue: fake.queue, presentTo: ()=>{} });
    const runCache = where === 'plain' ? null : await openRunCache({ budget: 64 << 20 });
    /** @type {ReturnType<typeof channelSpace> | ReturnType<typeof ownedSpace> | null} */
    let texels = null;
    if (runCache && where === 'worker')
    {
        /** @type {ReturnType<typeof channelSpace> | null} */
        let worker = null;
        worker = channelSpace(runCache.join(message=>worker?.adopt(message)),
            runCache.serve('texels'));
        texels = worker;
    }
    else if (runCache)
    {
        texels = ownedSpace(runCache.reader, runCache.serve('texels'));
    }
    if (texels && mutate)
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
    const gl = /** @type {any} */ (createGlContext({ gpu: renderer }));
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
        // The levels no draw needs at the frame's start wait in the store (a
        // look with the cache, none without), and go up from where they wait.
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
        || (runCache?.under(/** @type {any} */ (texels).prefix).bodies ?? 0) > 0); turns++)
    {
        await turn();
    }
    const left = runCache?.under(/** @type {any} */ (texels).prefix).bodies ?? 0;
    const figures = kept();
    const released = await texels?.close();
    runCache?.close();
    return {
        calls: fake.calls.map(callText),
        kinds: made.map((/** @type {any} */ one)=>one.kind.name),
        kept: figures,
        inPlace: spilled === 'no cache' ? 0 : spilled.inPlace,
        spilledLevels: spilled === 'no cache' ? 0 : spilled.levels,
        losses,
        left,
        released,
    };
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test('a frame\'s uploads and depth writes give the device the same bytes from the run\'s cache as '
    + 'from plain memory, and leave nothing there', { timeout: 240_000 }, async()=>{
    for (const where of /** @type {const} */ (['worker', 'thread']))
    {
        let moved = 0;
        let puts = 0;
        let inPlace = 0;
        /** @type {Set<string>} */
        const kinds = new Set();
        for (const seed of SEEDS)
        {
            const plain = await run(seed, 'plain');
            const cached = await run(seed, where);
            const at = `${where}, seed ${seed}`;
            assert.ok(plain.calls.some(call=>call.includes('"writeTexture"')), at);
            assert.equal(cached.calls.length, plain.calls.length, at);
            for (let call = 0; call < plain.calls.length; call++)
            {
                assert.equal(cached.calls[call], plain.calls[call], `${at}: call ${call}`);
            }
            // The cache's run puts the levels that wait into the store as well.
            assert.equal(cached.kept.put - cached.spilledLevels, plain.kept.put,
                `${at}: the same bytes kept for the frames`);
            assert.deepEqual([...plain.losses, ...cached.losses], [], at);
            assert.equal(cached.kept.lost, 0, at);
            assert.equal(cached.kept.bodies, 0, `${at}: every frame let its bytes go`);
            assert.equal(plain.kept.bodies, 0, at);
            assert.equal(cached.left, 0, `${at}: nothing left under the root's names`);
            assert.deepEqual(cached.released, { bodies: 0, bytes: 0, waiting: 0 }, at);
            assert.equal(plain.kept.cache, false);
            moved += cached.kept.moved;
            puts += plain.kept.put;
            inPlace += cached.inPlace;
            for (const kind of cached.kinds)
            {
                kinds.add(kind);
            }
        }
        assert.ok(puts > 0, `${where}: uploads waited for their frames`);
        assert.ok(moved > 0, `${where}: some of their bytes waited in the run's cache`);
        assert.ok(inPlace > 0, `${where}: levels uploaded from where they waited`);
        assert.deepEqual([...kinds].sort(), KINDS.map(kind=>kind.name).sort(),
            `${where}: every kind made`);
    }
});

test('the gate sees a wrong read of the run\'s cache', { timeout: 240_000 }, async()=>{
    for (const where of /** @type {const} */ (['worker', 'thread']))
    {
        let differed = 0;
        for (const seed of SEEDS)
        {
            const plain = await run(seed, 'plain');
            const wrong = await run(seed, where, { mutate: true });
            differed += wrong.calls.some((call, at)=>call !== plain.calls[at]) ? 1 : 0;
        }
        assert.ok(differed > 0, `${where}: a body read wrong reaches the device`);
    }
});
