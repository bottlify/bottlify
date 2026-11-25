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
        texels = channelSpace(joined, runCache.serve(), 'texels');
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
        const bytes = new Uint8Array(size * size * 4).map(()=>next() & 0xff);
        gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, size, size, 0, GL.RGBA, GL.UNSIGNED_BYTE, bytes);
    }
    const all = ()=>[...gl.shareGroup.textures.objects.values()];
    if (texels)
    {
        renderer.spill(all());
        for (let turns = 0; turns < 1000 && renderer.diagnostics().spills.levels < count; turns++)
        {
            await turn();
        }
        assert.equal(renderer.diagnostics().spills.levels, count, 'every undrawn level moved');
        const held = renderer.heldTexels(all());
        assert.equal(held.undrawnBytes, 0, 'none of their texels left on this thread');
        assert.equal(held.cachedLevels, count);
    }
    gl.glEnable(GL.TEXTURE_2D);
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
    const figures = renderer.diagnostics();
    // What was taken back is dropped from the cache: nothing of it stays there.
    for (let turns = 0; turns < 100 && (runCache?.figures().hot ?? 0) > 0; turns++)
    {
        await turn();
    }
    const left = runCache?.figures().hot ?? 0;
    runCache?.close();
    texels?.close();
    return { uploads, figures, left };
}

test('texels no draw needed wait in the run\'s cache and the device is given the same bytes',
    async()=>{
        for (const seed of [1, 2, 3, 4, 5, 6])
        {
            const plain = await run(seed, false);
            const cached = await run(seed, true);
            assert.ok(plain.uploads.length > 0, `seed ${seed}: textures uploaded`);
            assert.deepEqual(cached.uploads, plain.uploads, `seed ${seed}`);
            assert.equal(cached.figures.spills.back, cached.figures.spills.levels,
                `seed ${seed}: every level taken back at its first draw`);
            assert.equal(cached.figures.spills.lost, 0);
            assert.equal(cached.left, 0, `seed ${seed}: no body left in the cache`);
            assert.equal(plain.figures.spills, 'no cache');
        }
    });
