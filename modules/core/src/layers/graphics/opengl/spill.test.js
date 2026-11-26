/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texels no draw has needed wait in the run's cache rather than the drawing
 * thread's heap (`spill`), and come back as they were at their first reader:
 * an upload, a write into the level in place, a read-back. Seeded programs of
 * textures made, written in part and drawn run twice - with the cache and
 * without - and the device must be given the same bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { openRunCache } from '../../../process/run-cache.js';
import { channelSpace } from '../../cache/module.js';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

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

/** The side of the textures kept as S3TC blocks: large enough to be spilled. */
const BLOCKS_SIZE = 256;
/** A texture's kind by a seeded draw: RGBA texels, or blocks of DXT1 or DXT5. */
const S3TC = [null,
    { format: GL.COMPRESSED_RGB_S3TC_DXT1_EXT, bytes: BLOCKS_SIZE * BLOCKS_SIZE / 2 },
    { format: GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, bytes: BLOCKS_SIZE * BLOCKS_SIZE }];

/**
 * One run of a seeded program: what the device was given, and the renderer's
 * figures at the end.
 *
 * @param {number} seed @param {boolean} cached
 */
async function run(seed, cached){
    const next = random(seed);
    const fake = createFakeDevice({});
    const backend = createBackend({ device: fake.device, queue: fake.queue, presentTo: ()=>{} });
    const runCache = cached ? await openRunCache({ budget: 64 << 20 }) : null;
    /** @type {ReturnType<typeof channelSpace> | null} */
    let texels = null;
    if (runCache)
    {
        const joined = runCache.join(message=>texels?.adopt(message));
        texels = channelSpace(joined, runCache.serve('texels'));
    }
    const renderer = createGpuRenderer({
        backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        texelCache: texels,
    });
    const gl = /** @type {any} */ (createGlContext({ gpu: renderer }));
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    const count = 4 + next() % 4;
    const names = gl.glGenTextures(count);
    const size = 64 + 64 * (next() % 2);
    for (const name of names)
    {
        gl.glBindTexture(GL.TEXTURE_2D, name);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        // Some kept as S3TC blocks, which wait in the cache in their place.
        const blocks = S3TC[next() % 3];
        if (blocks)
        {
            const bytes = new Uint8Array(blocks.bytes).map(()=>next() & 0xff);
            gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, blocks.format, BLOCKS_SIZE,
                BLOCKS_SIZE, 0, bytes.length, bytes);
            continue;
        }
        const bytes = new Uint8Array(size * size * 4).map(()=>next() & 0xff);
        gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, size, size, 0, GL.RGBA, GL.UNSIGNED_BYTE, bytes);
    }
    const all = ()=>[...gl.shareGroup.textures.objects.values()];
    if (texels)
    {
        renderer.spill(all());
        for (let turns = 0; turns < 1000 && /** @type {any} */ (renderer.diagnostics()).spills.levels < count; turns++)
        {
            await turn();
        }
        assert.equal(/** @type {any} */ (renderer.diagnostics()).spills.levels, count, 'every undrawn level moved');
        const held = renderer.heldTexels(all());
        assert.equal(held.undrawnBytes, 0, 'none of their texels left on this thread');
        assert.equal(held.undrawnBlockBytes, 0, 'none of their blocks left on this thread');
        assert.equal(held.cachedLevels, count);
    }
    gl.glEnable(GL.TEXTURE_2D);
    /** What a read-back of a level before its first draw answered, on some. */
    const readBacks = [];
    for (const name of names)
    {
        gl.glBindTexture(GL.TEXTURE_2D, name);
        if (next() % 2 === 0)
        {
            const read = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
            readBacks.push([...(read?.packed ?? read ?? [])].join(','));
        }
    }
    for (const name of names)
    {
        gl.glBindTexture(GL.TEXTURE_2D, name);
        // A part written in place first, on some.
        if (next() % 2 === 0)
        {
            const patch = new Uint8Array(8 * 8 * 4).map(()=>next() & 0xff);
            gl.glTexSubImage2D(GL.TEXTURE_2D, 0, next() % (size - 8), next() % (size - 8), 8, 8,
                GL.RGBA, GL.UNSIGNED_BYTE, patch);
        }
        gl.glBegin(GL.TRIANGLES);
        gl.glTexCoord2f(0, 0);
        gl.glVertex2f(-1, -1);
        gl.glTexCoord2f(1, 0);
        gl.glVertex2f(1, -1);
        gl.glTexCoord2f(0, 1);
        gl.glVertex2f(-1, 1);
        gl.glEnd();
        renderer.present(gl);
        await renderer.settled();
    }
    const uploads = fake.calls.filter((/** @type {any} */ call)=>call.op === 'writeTexture')
        .map((/** @type {any} */ call)=>[...call.bytes].join(','));
    const figures = /** @type {any} */ (renderer.diagnostics());
    // What was taken back is dropped from the cache: nothing of it stays there.
    for (let turns = 0; turns < 100 && (runCache?.figures().hot ?? 0) > 0; turns++)
    {
        await turn();
    }
    const left = runCache?.figures().hot ?? 0;
    runCache?.close();
    texels?.close();
    return { uploads, readBacks, figures, left };
}

test('texels and blocks no draw needed wait in the run\'s cache and come back as they were',
    async()=>{
        let blockBytes = 0;
        for (const seed of [1, 2, 3, 4, 5, 6])
        {
            const plain = await run(seed, false);
            const cached = await run(seed, true);
            assert.ok(plain.uploads.length > 0, `seed ${seed}: textures uploaded`);
            assert.deepEqual(cached.uploads, plain.uploads, `seed ${seed}`);
            assert.ok(plain.readBacks.length > 0, `seed ${seed}: levels read back`);
            assert.deepEqual(cached.readBacks, plain.readBacks, `seed ${seed}: read back as made`);
            assert.equal(cached.figures.spills.back, cached.figures.spills.levels,
                `seed ${seed}: every level taken back at its first draw`);
            assert.equal(cached.figures.spills.lost, 0);
            assert.equal(cached.left, 0, `seed ${seed}: no body left in the cache`);
            assert.equal(plain.figures.spills, 'no cache');
            blockBytes += cached.figures.spills.blockBytes;
        }
        assert.ok(blockBytes > 0, 'S3TC blocks among what waited');
    });

test('a level\'s texels and blocks that wait in the run\'s cache are let go here', async()=>{
    // The bytes moved out are kept nowhere on this thread: an accessor that
    // held them would leave this heap as it was, the cache's copy beside it.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    const fake = createFakeDevice({});
    const backend = createBackend({ device: fake.device, queue: fake.queue, presentTo: ()=>{} });
    const runCache = await openRunCache({ budget: 64 << 20 });
    /** @type {ReturnType<typeof channelSpace> | null} */
    let texels = null;
    const joined = runCache.join(message=>texels?.adopt(message));
    texels = channelSpace(joined, runCache.serve('texels'));
    const renderer = createGpuRenderer({
        backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        texelCache: texels,
    });
    const gl = /** @type {any} */ (createGlContext({ gpu: renderer }));
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    const [plainName, blocksName] = gl.glGenTextures(2);
    gl.glBindTexture(GL.TEXTURE_2D, plainName);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 128, 128, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(128 * 128 * 4).fill(7));
    gl.glBindTexture(GL.TEXTURE_2D, blocksName);
    gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT,
        BLOCKS_SIZE, BLOCKS_SIZE, 0, BLOCKS_SIZE * BLOCKS_SIZE,
        new Uint8Array(BLOCKS_SIZE * BLOCKS_SIZE).fill(9));
    const objects = gl.shareGroup.textures.objects;
    const levelOf = (/** @type {number} */ name)=>objects.get(name).levels.get(0);
    const own = (/** @type {object} */ level, /** @type {string} */ property)=>
        Object.getOwnPropertyDescriptor(level, property)?.value;
    const texelsHeld = new WeakRef(own(levelOf(plainName), 'texels'));
    const blocksHeld = new WeakRef(own(levelOf(blocksName), 'compressed').bytes);
    renderer.spill([...objects.values()]);
    const moved = ()=>/** @type {any} */ (renderer.diagnostics()).spills.levels;
    for (let turns = 0; turns < 1000 && moved() < 2; turns++)
    {
        await turn();
    }
    const movedLevels = moved();
    for (let tries = 0; tries < 4; tries++)
    {
        gc();
        await turn();
    }
    const kept = { texels: texelsHeld.deref() !== undefined,
        blocks: blocksHeld.deref() !== undefined };
    // And they come back as they were.
    gl.glBindTexture(GL.TEXTURE_2D, plainName);
    const texelsBack = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE)
        .every((/** @type {number} */ byte)=>byte === 7);
    const blocksBack = levelOf(blocksName).compressed.bytes
        .every((/** @type {number} */ byte)=>byte === 9);
    // Closed before judging: an open channel would hold the process.
    runCache.close();
    texels.close();
    assert.equal(movedLevels, 2, 'both levels moved');
    assert.deepEqual(kept, { texels: false, blocks: false }, 'neither is held here');
    assert.ok(texelsBack, 'the texels read back as they were');
    assert.ok(blocksBack, 'the blocks come back as they were');
});

test('a level of the cache\'s unit of room moves, one below it stays', async()=>{
    const fake = createFakeDevice({});
    const backend = createBackend({ device: fake.device, queue: fake.queue, presentTo: ()=>{} });
    const runCache = await openRunCache({ budget: 64 << 20 });
    /** @type {ReturnType<typeof channelSpace> | null} */
    let texels = null;
    const joined = runCache.join(message=>texels?.adopt(message));
    texels = channelSpace(joined, runCache.serve('texels'));
    const renderer = createGpuRenderer({
        backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        texelCache: texels,
    });
    const gl = /** @type {any} */ (createGlContext({ gpu: renderer }));
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, 1);
    // A 32x32 chain: 4 KiB on top, then 1 KiB, 256 bytes and on.
    for (let level = 0, side = 32; side >= 1; level++, side >>= 1)
    {
        gl.glTexImage2D(GL.TEXTURE_2D, level, GL.RGBA, side, side, 0, GL.RGBA,
            GL.UNSIGNED_BYTE, new Uint8Array(side * side * 4).fill(level + 1));
    }
    const all = [...gl.shareGroup.textures.objects.values()];
    renderer.spill(all);
    const figures = ()=>/** @type {any} */ (renderer.diagnostics()).spills;
    for (let turns = 0; turns < 1000 && figures().levels + figures().refused < 1; turns++)
    {
        await turn();
    }
    for (let turns = 0; turns < 20; turns++)
    {
        await turn();
    }
    const moved = { levels: figures().levels, bytes: figures().bytes };
    const back = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE)
        .every((/** @type {number} */ byte)=>byte === 1);
    runCache.close();
    texels.close();
    assert.deepEqual(moved, { levels: 1, bytes: 4096 }, 'the top level alone moved');
    assert.ok(back, 'and reads back as it was');
});

test('a texture the program deleted gives back what of it waited in the run\'s cache at the next '
    + 'look, and the root that goes gives back the rest', async()=>{
    const fake = createFakeDevice({});
    const backend = createBackend({ device: fake.device, queue: fake.queue, presentTo: ()=>{} });
    const runCache = await openRunCache({ budget: 64 << 20 });
    /** @type {ReturnType<typeof channelSpace> | null} */
    let texels = null;
    const joined = runCache.join(message=>texels?.adopt(message));
    texels = channelSpace(joined, runCache.serve('texels'));
    const renderer = createGpuRenderer({
        backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        texelCache: texels,
    });
    const gl = /** @type {any} */ (createGlContext({ gpu: renderer }));
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    const names = gl.glGenTextures(3);
    for (const name of names)
    {
        gl.glBindTexture(GL.TEXTURE_2D, name);
        gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 64, 64, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            new Uint8Array(64 * 64 * 4).fill(name));
    }
    const all = ()=>[...gl.shareGroup.textures.objects.values()];
    renderer.spill(all());
    const moved = ()=>/** @type {any} */ (renderer.diagnostics()).spills.levels;
    for (let turns = 0; turns < 1000 && moved() < 3; turns++)
    {
        await turn();
    }
    const under = ()=>runCache.under(texels?.prefix ?? '').bodies;
    const before = under();
    gl.glDeleteTextures([names[0], names[2]]);
    // The next look, handed the textures alive.
    renderer.spill(all());
    for (let turns = 0; turns < 100 && under() > 1; turns++)
    {
        await turn();
    }
    const afterDelete = under();
    const released = await texels.close();
    const afterClose = under();
    runCache.close();
    assert.equal(before, 3, 'every level waited there');
    assert.equal(afterDelete, 1, 'the deleted textures\' levels let go of');
    assert.equal(/** @type {any} */ (renderer.diagnostics()).spills.forgotten, 2);
    assert.deepEqual(released, { bodies: 1, bytes: 64 * 64 * 4, waiting: 0 },
        'the root that goes takes the level it still held');
    assert.equal(afterClose, 0, 'nothing left under its names');
    assert.deepEqual(runCache.figures().ownerTails, { owners: 0, bodies: 0, bytes: 0 });
});
