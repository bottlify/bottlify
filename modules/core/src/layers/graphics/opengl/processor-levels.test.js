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
 * run three ways: every level kept where the program put it (the
 * reference), idle levels handed to a roomy run's cache, and to a cramped
 * one that puts them on its disk. Every frame's pixels and every read-back
 * must be the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { TEX } from './formats.js';
import { createGlContext } from './context.js';
import { createOpenglRoot } from './root.js';
import { createProcessorLevels } from './processor-levels.js';
import { forgetRgba } from './context-textures.js';
import { openRunCache } from '../../../process/run-cache.js';
import { cacheSpace, channelSpace } from '../../cache/module.js';
import { fakeOpfs } from '../../filesystem/internal/opfs.fixture.js';
import { openRunFolder } from '../../filesystem/internal/run-folder.js';
import { testCache } from '../../cache/testing.fixture.js';
import { createScratches } from '../../cache/scratch.js';

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
 * The root's names in a run's cache as a thread beside the keeper's has them
 * (`channelSpace`): each ask crosses to the keeper, here served in place, as
 * the keeper's server waits on this thread.
 *
 * @param {any} runCache
 */
function channelTexels(runCache){
    /** @type {ReturnType<typeof channelSpace> | null} */
    let texels = null;
    const joined = runCache.join((/** @type {any} */ message)=>texels?.adopt(message));
    texels = channelSpace(joined, runCache.serve('texels'));
    return texels;
}

/** A body of 6 MiB that can be made again: put past the budget, it makes room. */
const FILLER = 6 << 20;

/**
 * One run of a seeded program on the processor: every frame's pixels and
 * every read-back, in order, and what the levels' keeper did.
 *
 * `reference` keeps every level where the program put it (no levels' keeper);
 * `roomy` hands idle levels to a run's cache with room for all; `cramped`
 * to a run's cache of one 16 MiB segment over a disk (`fakeOpfs`), pressed
 * after every look by bodies that can be made again, so idle levels go to
 * the disk and come back from it.
 *
 * @param {number} seed @param {'reference' | 'roomy' | 'cramped'} arm
 */
async function run(seed, arm){
    const next = random(seed);
    const runFolder = arm === 'cramped'
        ? await openRunFolder({ root: fakeOpfs().root }) : null;
    const runCache = await openRunCache(arm === 'cramped' ? { budget: 16 << 20, runFolder }
        : { budget: 64 << 20 });
    // The keeper's first pack opens behind a promise, as every file on OPFS.
    await turn();
    const texels = channelTexels(runCache);
    const fillers = cacheSpace(runCache.reader, 'reads');
    let filled = 0;
    // The RGBA the rasteriser samples, held as the engine's thread holds it
    // (`channelSpace`'s hold asks a keeper on another thread, and waits for it).
    const holds = createScratches((await testCache()).space('scratch').hold ?? null).hold;
    /** @type {string[]} */
    const said = [];
    const levels = arm === 'reference' ? null : createProcessorLevels({ cache: texels,
        forgetRgba, divergence: detail=>said.push(detail) });
    const gl = /** @type {any} */ (createGlContext({ levels: levels ?? undefined, holds }));
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
        levels?.look(all());
        // The room is asked for without waiting: the moves land a few turns on.
        for (let turns = 0; turns < 20; turns++)
        {
            await turn();
        }
        if (arm === 'cramped')
        {
            for (let made = 0; made < 3; made++)
            {
                fillers.put(String(++filled), new Uint8Array(FILLER));
            }
        }
    }
    gl.glDeleteTextures(names);
    levels?.look(all());
    const figures = levels?.figures() ?? null;
    const cache = runCache.figures();
    runCache.close();
    texels.close?.();
    return { seen, figures, said, cache };
}

test('gate: the processor\'s levels draw and read back the same handed to a roomy run\'s'
    + ' cache, to a cramped one that puts them on its disk, and kept where they are', async()=>{
    for (let seed = 1; seed <= 6; seed++)
    {
        const reference = await run(seed, 'reference');
        const roomy = await run(seed, 'roomy');
        const cramped = await run(seed, 'cramped');
        for (const [name, other] of /** @type {const} */ ([['roomy', roomy],
            ['cramped', cramped]]))
        {
            assert.equal(other.seen.length, reference.seen.length, `${name}, seed ${seed}`);
            other.seen.forEach((line, at)=>assert.equal(line, reference.seen[at],
                `${name}, seed ${seed}: ${reference.seen[at].slice(0, 40)}`));
            assert.deepEqual(other.said, [], `${name}: nothing lost`);
            // A different path in fact: idle levels moved into the cache and taken back.
            assert.ok((other.figures?.store.moved ?? 0) > 0, `${name}, seed ${seed}: moved`);
            assert.ok((other.figures?.spills.back ?? 0) > 0, `${name}, seed ${seed}: taken back`);
            assert.equal(other.figures?.store.refused, 0, `${name}: no room refused`);
        }
        assert.equal(roomy.cache.written, 0, 'roomy: nothing went to a disk');
        assert.ok(cramped.cache.written > 0, `seed ${seed}: cramped, idle levels on its disk`);
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
                holds: createScratches((await testCache()).space('scratch').hold ?? null).hold });
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
