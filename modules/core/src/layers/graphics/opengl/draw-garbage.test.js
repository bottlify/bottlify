/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { roomy, testScratch } from '../../cache/testing.fixture.js';

/**
 * A fixed-function frame as an old title draws it - a mipmapped texture on a
 * lit, fogged triangle list from client arrays in guest memory - through the
 * whole OpenGL path over a quiet device: the front end, the recording and the
 * renderer. Frames of `draws` draws, presented.
 */
function scene(){
    const fake = createFakeDevice({ quiet: true });
    const backend = createBackend({ scratches: testScratch,
        device: fake.device, queue: fake.queue, presentTo: ()=>{} });
    const renderer = createGpuRenderer({ backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
    const guest = new Uint8Array(0x80000);
    let free = 0x40000;
    const gl = /** @type {any} */ (createGlContext({ holds: roomy.api.hold, gpu: renderer, memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>guest.subarray(at, at + n),
        window: (/** @type {number} */ at, /** @type {number} */ n)=>guest.subarray(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>guest.set(value, at),
        allocate: (/** @type {number} */ size)=>{
            const at = free;
            free += (size + 16) & ~15;
            return at;
        },
        free: ()=>{},
    } }));
    gl.attach({ width: 64, height: 64, doubleBuffered: true, depthBits: 24 });
    // Six vertices: position (3 floats) and texture coordinate (2), interleaved.
    const vertices = new Float32Array(guest.buffer, 0x1000, 30);
    for (let n = 0; n < 6; n++)
    {
        vertices.set([n % 3, (n >> 1) % 2, 0.5, n * 0.25, 1 - n * 0.125], n * 5);
    }
    const texture = gl.glGenTextures(1)[0] ?? 1;
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    for (let level = 0; level <= 4; level++)
    {
        gl.glTexImage2D(GL.TEXTURE_2D, level, GL.RGBA, 16 >> level, 16 >> level, 0, GL.RGBA,
            GL.UNSIGNED_BYTE, 0x8000);
    }
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_LINEAR);
    gl.glEnable(GL.TEXTURE_2D);
    gl.glEnable(GL.LIGHTING);
    gl.glEnable(GL.LIGHT0);
    gl.glEnable(GL.FOG);
    gl.glEnable(GL.DEPTH_TEST);
    gl.glEnableClientState(GL.VERTEX_ARRAY);
    gl.glEnableClientState(GL.TEXTURE_COORD_ARRAY);
    gl.glVertexPointer(3, GL.FLOAT, 20, 0x1000);
    gl.glTexCoordPointer(2, GL.FLOAT, 20, 0x100c);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    /** @param {number} draws */
    const frame = async draws=>{
        for (let n = 0; n < draws; n++)
        {
            gl.glDrawArrays(GL.TRIANGLES, 0, 6);
        }
        renderer.present(gl);
        await renderer.settled();
    };
    return { gl, frame, stats: fake.stats };
}

/**
 * What a draw leaves for the collector in the OpenGL layer's own functions,
 * by file and line, over frames after warming: the sampling heap profiler,
 * collected objects included.
 *
 * @param {number} frames @param {number} draws
 */
async function garbagePerDraw(frames, draws){
    const { frame, stats } = scene();
    for (let n = 0; n < 20; n++)
    {
        await frame(draws);
    }
    const before = stats.draws;
    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', { samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let n = 0; n < frames; n++)
    {
        await frame(draws);
    }
    const { profile } = await session.post('HeapProfiler.stopSampling');
    session.disconnect();
    /** @type {Map<string, number>} */
    const sites = new Map();
    let total = 0;
    /** @param {any} node */
    const walk = node=>{
        const { url, lineNumber, functionName } = node.callFrame;
        if (url.includes('/graphics/opengl/') && node.selfSize > 0)
        {
            const site = `${url.split('/opengl/')[1]}:${lineNumber + 1} ${functionName}`;
            sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
            total += node.selfSize;
        }
        node.children.forEach(walk);
    };
    walk(profile.head);
    const drawn = stats.draws - before;
    // A present draws once more, the frame copied out.
    assert.equal(drawn, frames * (draws + 1), 'every draw reached the device');
    return { perDraw: total / (frames * draws), sites: [...sites].sort((a, b)=>b[1] - a[1]) };
}

test('a fixed-function draw of a textured, lit, fogged triangle list leaves at most 11 KB a draw '
    + 'for the collector in the OpenGL layer', async()=>{
    // 12.9-13.1 KB a draw before texture completeness, the chain of levels
    // and the normal matrix stopped making values a draw (three runs each);
    // the sites left are printed when it fails.
    const { perDraw, sites } = await garbagePerDraw(20, 50);
    const top = sites.slice(0, 15).map(([site, bytes])=>
        `${(bytes / 1000).toFixed(0).padStart(7)} B a draw  ${site}`);
    assert.ok(perDraw <= 11000, `${perDraw.toFixed(0)} bytes a draw:\n${top.join('\n')}`);
});
