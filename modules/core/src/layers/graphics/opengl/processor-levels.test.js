/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The processor path's levels under the run's cache (`processor-levels.js`):
 * a level no draw samples waits in the texel store and comes back as it was
 * at its first reader or writer, and the RGBA the rasteriser samples is held
 * memory of the cache. Seeded programs of legacy RGBA, sized and S3TC
 * textures - drawn, written in part, read back, left idle and drawn again -
 * run three ways: with no cache (the reference), with a cache that takes
 * every idle level, and with a cache too small for any of them (store and
 * holds refused, the bodies kept in plain memory behind the same accessors).
 * Every frame's pixels and every read-back must be the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { TEX } from './formats.js';
import { createGlContext } from './context.js';
import { createOpenglRoot } from './root.js';
import { createProcessorLevels } from './processor-levels.js';
import { openRunCache } from '../../../process/run-cache.js';
import { channelSpace } from '../../cache/module.js';
import { testCache } from '../../cache/testing.fixture.js';

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

/** The side of every texture: 64 x 64, a level of each kind past the store's smallest body. */
const SIZE = 64;

/**
 * A texture of a seeded kind: legacy RGBA texels, a sized level's own bytes
 * (RG8, RGBA16F), or S3TC blocks.
 *
 * @param {any} gl @param {() => number} next
 */
function makeTexture(gl, next){
    const kind = next() % 4;
    if (kind === 0)
    {
        const bytes = new Uint8Array(SIZE * SIZE * 4).map(()=>next() & 0xff);
        gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, SIZE, SIZE, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            bytes);
    }
    else if (kind === 1)
    {
        const bytes = new Uint8Array(SIZE * SIZE * 2).map(()=>next() & 0xff);
        gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RG8, SIZE, SIZE, 0, TEX.RG, GL.UNSIGNED_BYTE,
            bytes);
    }
    else if (kind === 2)
    {
        const values = new Float32Array(SIZE * SIZE * 4).map(()=>(next() % 1000) / 999);
        gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, SIZE, SIZE, 0, GL.RGBA, GL.FLOAT,
            new Uint8Array(values.buffer));
    }
    else
    {
        const dxt5 = next() % 2 === 0;
        const bytes = new Uint8Array(SIZE * SIZE / (dxt5 ? 1 : 2)).map(()=>next() & 0xff);
        gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, dxt5 ? GL.COMPRESSED_RGBA_S3TC_DXT5_EXT
            : GL.COMPRESSED_RGB_S3TC_DXT1_EXT, SIZE, SIZE, 0, bytes.length, bytes);
    }
    return kind;
}

/** @param {any} value */
const flat = value=>[...(value?.packed ?? value ?? [])].join(',');

/**
 * One run of a seeded program on the processor: every frame's pixels and
 * every read-back, in order, and what the levels' keeper did.
 *
 * @param {number} seed @param {'plain' | 'cached' | 'starved'} arm
 */
async function run(seed, arm){
    const next = random(seed);
    const runCache = arm === 'plain' ? null
        : await openRunCache(arm === 'cached' ? { budget: 64 << 20 }
            : { budget: 1 << 12 });
    /** @type {ReturnType<typeof channelSpace> | null} */
    let texels = null;
    if (runCache)
    {
        const joined = runCache.join(message=>texels?.adopt(message));
        texels = channelSpace(joined, runCache.serve('texels'));
    }
    // Held memory as the engine's thread holds it, from the cache layer
    // whose keeper answers on this thread (`channelSpace`'s hold asks a keeper
    // on another thread, and waits for it).
    // Starved, the cache has room for no hold at all.
    const hold = arm === 'plain' ? null : arm === 'cached'
        ? (await testCache()).space('scratch').hold ?? null : ()=>null;
    /** @type {string[]} */
    const said = [];
    const levels = createProcessorLevels({ cache: texels, hold,
        divergence: detail=>said.push(detail) });
    const gl = /** @type {any} */ (createGlContext({ levels }));
    gl.attach({ width: 16, height: 16, doubleBuffered: false, depthBits: 24 });
    gl.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.glEnable(GL.TEXTURE_2D);
    const names = gl.glGenTextures(6);
    for (const name of names)
    {
        gl.glBindTexture(GL.TEXTURE_2D, name);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        makeTexture(gl, next);
    }
    /** @type {string[]} */
    const seen = [];
    const all = ()=>[...gl.shareGroup.textures.objects.values()];
    for (let frame = 0; frame < 12; frame++)
    {
        gl.glClear(GL.COLOR_BUFFER_BIT);
        // A few textures drawn a frame: the others go idle, and wait.
        for (let draw = 0; draw < 2; draw++)
        {
            const name = names[next() % names.length];
            gl.glBindTexture(GL.TEXTURE_2D, name);
            if (next() % 4 === 0)
            {
                const patch = new Uint8Array(8 * 8 * 4).map(()=>next() & 0xff);
                gl.glTexSubImage2D(GL.TEXTURE_2D, 0, next() % (SIZE - 8), next() % (SIZE - 8),
                    8, 8, GL.RGBA, GL.UNSIGNED_BYTE, patch);
            }
            const x = (next() % 100) / 100 - 1;
            gl.glBegin(GL.TRIANGLES);
            gl.glTexCoord2f(0, 0);
            gl.glVertex2f(x, -1);
            gl.glTexCoord2f(1, 0);
            gl.glVertex2f(1, -1);
            gl.glTexCoord2f(0.5, 1);
            gl.glVertex2f(0, 1);
            gl.glEnd();
        }
        seen.push(`frame ${frame}: ${flat(gl.glReadPixels(0, 0, 16, 16, GL.RGBA,
            GL.UNSIGNED_BYTE))}`);
        // A read-back of a level that may be waiting in the store.
        if (next() % 3 === 0)
        {
            const name = names[next() % names.length];
            gl.glBindTexture(GL.TEXTURE_2D, name);
            seen.push(`read ${name}: ${flat(gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA,
                GL.UNSIGNED_BYTE))}`);
        }
        levels.look(all());
        // The room is asked for without waiting: the moves land a few turns on.
        for (let turns = 0; turns < 20; turns++)
        {
            await turn();
        }
    }
    gl.glDeleteTextures(names);
    levels.look(all());
    const figures = levels.figures();
    runCache?.close();
    texels?.close();
    return { seen, figures, said };
}

test('gate: the processor\'s levels draw and read back the same with every idle level in the'
    + ' run\'s cache, with a cache too small for any, and with none', async()=>{
    for (let seed = 1; seed <= 6; seed++)
    {
        const plain = await run(seed, 'plain');
        const cached = await run(seed, 'cached');
        const starved = await run(seed, 'starved');
        for (const [name, other] of /** @type {const} */ ([['cached', cached],
            ['starved', starved]]))
        {
            assert.equal(other.seen.length, plain.seen.length, `${name}, seed ${seed}`);
            other.seen.forEach((line, at)=>assert.equal(line, plain.seen[at],
                `${name}, seed ${seed}: ${plain.seen[at].slice(0, 40)}`));
            assert.deepEqual(other.said, [], `${name}: nothing lost`);
        }
        assert.equal(plain.figures.spills.levels, 0, 'no cache: nothing moves');
        assert.equal(plain.figures.rgbaHeld, 0);
        // A different path in fact: levels moved and taken back, RGBA held.
        assert.ok(cached.figures.store.moved > 0, `seed ${seed}: idle levels moved`);
        assert.ok(cached.figures.spills.back > 0, `seed ${seed}: and taken back`);
        assert.ok(cached.figures.rgbaHeld > 0, `seed ${seed}: RGBA held in the cache`);
        assert.equal(cached.figures.held, 0, 'every hold let go of with its texture');
        // The starved arm runs the accessors with the bodies refused room.
        assert.ok(starved.figures.spills.levels > 0, `seed ${seed}: levels handed over`);
        assert.equal(starved.figures.store.moved, 0, 'none moved: no room');
        assert.equal(starved.figures.rgbaHeld, 0, 'no RGBA held: no room');
    }
});

test('a context on the processor of a root looks for idle levels every 60 swaps, and moves them',
    async()=>{
        const runCache = await openRunCache({ budget: 16 << 20 });
        /** @type {ReturnType<typeof channelSpace> | null} */
        let texels = null;
        const joined = runCache.join(message=>texels?.adopt(message));
        texels = channelSpace(joined, runCache.serve('texels'));
        try
        {
            const root = createOpenglRoot({ texelCache: texels,
                hold: (await testCache()).space('scratch').hold ?? null });
            const gl = /** @type {any} */ (root.CreateContext({ processor: true }));
            gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
            const [name] = gl.glGenTextures(1);
            gl.glBindTexture(GL.TEXTURE_2D, name);
            gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, SIZE, SIZE, 0, GL.RGBA, GL.UNSIGNED_BYTE,
                new Uint8Array(SIZE * SIZE * 4).fill(7));
            for (let swap = 0; swap < 120; swap++)
            {
                root.Swap(gl);
            }
            for (let turns = 0; turns < 100
            && root.diagnostics()?.processorLevels.store.moved === 0; turns++)
            {
                await turn();
            }
            const figures = root.diagnostics()?.processorLevels;
            assert.equal(figures.looks, 2);
            assert.equal(figures.store.moved, 1, 'the idle level moved into the cache');
            const read = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
            assert.ok([...(read?.packed ?? read)].every(byte=>byte === 7),
                'and comes back as it was');
        }
        finally
        {
            runCache.close();
            texels.close();
        }
    });

test('a write in place into a level whose RGBA is held takes a copy of its own: the hold let go'
    + ' and held again by another level leaves it as written', async()=>{
    const hold = (await testCache()).space('scratch').hold ?? null;
    const levels = createProcessorLevels({ hold });
    const gl = /** @type {any} */ (createGlContext({ levels }));
    gl.attach({ width: 4, height: 4, doubleBuffered: false, depthBits: 24 });
    gl.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.glEnable(GL.TEXTURE_2D);
    const [first, second] = gl.glGenTextures(2);
    const draw = (/** @type {number} */ name)=>{
        gl.glBindTexture(GL.TEXTURE_2D, name);
        gl.glBegin(GL.TRIANGLES);
        gl.glTexCoord2f(0, 0);
        gl.glVertex2f(-1, -1);
        gl.glTexCoord2f(1, 0);
        gl.glVertex2f(1, -1);
        gl.glTexCoord2f(0, 1);
        gl.glVertex2f(-1, 1);
        gl.glEnd();
    };
    // S3TC levels: what the rasteriser samples is decoded from the blocks and
    // held, and a write in place turns the level into texels of its own.
    for (const [name, fill] of [[first, 0], [second, 0x22]])
    {
        gl.glBindTexture(GL.TEXTURE_2D, name);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        const blocks = new Uint8Array(SIZE * SIZE / 2).fill(fill);
        gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, SIZE,
            SIZE, 0, blocks.length, blocks);
    }
    draw(first);
    assert.equal(levels.figures().rgbaHeld, 1, 'its RGBA held in the cache');
    gl.glBindTexture(GL.TEXTURE_2D, first);
    gl.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array([1, 2, 3, 4]));
    const written = gl.shareGroup.textures.objects.get(first).levels.get(0);
    assert.ok(!(written.texels.buffer instanceof SharedArrayBuffer),
        'the level\'s texels are its own, not the cache\'s memory let go of');
    assert.equal(levels.figures().held, 0, 'and its hold let go of');
    // The second's RGBA held, perhaps in the room the first let go of.
    draw(second);
    gl.glBindTexture(GL.TEXTURE_2D, first);
    const read = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    const bytes = read?.packed ?? read;
    assert.deepEqual([...bytes.subarray(0, 8)], [1, 2, 3, 255, 0, 0, 0, 255]);
    levels.dispose();
    assert.equal(levels.figures().held, 0);
});
