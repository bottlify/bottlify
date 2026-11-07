/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pixel transfer (scale, bias, GL_MAP_COLOR; `context-legacy.js`) on
 * every path an image takes: applied where the pixels are 8-bit RGBA here
 * (copies of the processor's framebuffer, glCopyPixels, a legacy array's
 * upload, glGetTexImage of RGBA bytes), said where they never are (a sized
 * format's own bytes, a copy the device makes), and nothing said for an
 * integer format, which takes no transfer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { TEX } from './formats.js';
import { createGlContext } from './context.js';
import { LEGACY } from './legacy-state.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @returns {{ gl: any, divergences: string[] }} */
function processor(){
    /** @type {string[]} */
    const divergences = [];
    const bytes = new Uint8Array(0x10000);
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    }, divergence: d=>divergences.push(d) });
    gl.attach({ width: 4, height: 4, doubleBuffered: false });
    return { gl, divergences };
}

/** A white framebuffer, and red halved by the transfer from here. @param {any} gl */
function whiteThenHalveRed(gl){
    gl.glClearColor(1, 1, 1, 1);
    gl.glClear(GL.COLOR_BUFFER_BIT);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 0.5);
}

/** @param {any} gl @param {number} target @returns {number[]} */
const firstTexel = (gl, target)=>{
    const read = gl.glGetTexImage(target, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    return Array.from((read.packed ?? read).subarray(0, 4));
};

const SKIPPED = /without the pixel transfer set/;

test('a copy of the processor\'s framebuffer into a texture passes through the transfer', ()=>{
    const { gl } = processor();
    whiteThenHalveRed(gl);
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);
    gl.glCopyTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 0, 0, 2, 2, 0);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 1);
    assert.deepEqual(firstTexel(gl, GL.TEXTURE_2D), [128, 255, 255, 255]);
    const [sized] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, sized);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 2, 2, 0, GL.RGBA, GL.FLOAT, null);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 0.5);
    gl.glCopyTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 0, 0, 2, 2);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 1);
    const read = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.FLOAT).packed;
    assert.equal(new Float32Array(read.buffer, read.byteOffset, 4)[0].toFixed(2), '0.50',
        'into a sized level too');
});

test('glCopyPixels passes through the transfer', ()=>{
    const { gl } = processor();
    gl.glClearColor(1, 1, 1, 1);
    gl.glClear(GL.COLOR_BUFFER_BIT);
    gl.glRasterPos2f(-1, -1);
    gl.glPixelTransferf(LEGACY.RED_BIAS, -0.5);
    gl.glCopyPixels(0, 0, 4, 4, GL.COLOR);
    gl.glPixelTransferf(LEGACY.RED_BIAS, 0);
    const rgba = gl.glReadPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.deepEqual(Array.from(rgba.subarray(0, 4)), [128, 255, 255, 255]);
});

test('a legacy format kept as bytes takes the transfer; a sized one says it does not', ()=>{
    const { gl, divergences } = processor();
    gl.glPixelTransferf(LEGACY.RED_SCALE, 0.5);
    const [array] = gl.glGenTextures(1);
    gl.glBindTexture(TEX.TEXTURE_2D_ARRAY, array);
    gl.glTexImage3D(TEX.TEXTURE_2D_ARRAY, 0, GL.RGBA, 1, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array([200, 100, 50, 255]));
    gl.glPixelTransferf(LEGACY.RED_SCALE, 1);
    assert.deepEqual(firstTexel(gl, TEX.TEXTURE_2D_ARRAY), [100, 100, 50, 255]);
    assert.deepEqual(divergences.filter(d=>SKIPPED.test(d)), []);

    const [integers] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, integers);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 0.5);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA8UI, 1, 1, 0, TEX.RGBA_INTEGER,
        GL.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(divergences.filter(d=>SKIPPED.test(d)), [],
        'an integer format takes no transfer, and nothing is said');
    const [floats] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, floats);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 1, 1, 0, GL.RGBA, GL.FLOAT,
        new Uint8Array(new Float32Array([1, 1, 1, 1]).buffer));
    assert.ok(divergences.some(d=>/an image of RGBA16F/.test(d) && SKIPPED.test(d)),
        divergences.join('\n'));
});

test('glGetTexImage of RGBA bytes takes the transfer; of a sized format says it does not', ()=>{
    const { gl, divergences } = processor();
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array([200, 100, 50, 255]));
    gl.glPixelTransferf(LEGACY.GREEN_BIAS, 0.5);
    assert.deepEqual(firstTexel(gl, GL.TEXTURE_2D), [200, 227, 50, 255]);
    assert.deepEqual(firstTexel(gl, GL.TEXTURE_2D), [200, 227, 50, 255],
        'the texture keeps its own texels');
    const [floats] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, floats);
    gl.glPixelTransferf(LEGACY.GREEN_BIAS, 0);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 1, 1, 0, GL.RGBA, GL.FLOAT, null);
    assert.deepEqual(divergences.filter(d=>SKIPPED.test(d)), [], 'nothing while it is off');
    gl.glPixelTransferf(LEGACY.GREEN_BIAS, 0.5);
    gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.FLOAT);
    assert.ok(divergences.some(d=>/a read of a texture of RGBA16F/.test(d)),
        divergences.join('\n'));
});

test('a copy the device makes says it skipped the transfer', ()=>{
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const divergences = [];
    const renderer = createGpuRenderer({ backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        divergence: detail=>divergences.push(detail) });
    /** @type {any} */
    const gl = createGlContext({ gpu: renderer, divergence: d=>divergences.push(d) });
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    gl.glCopyTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 0, 0, 2, 2);
    assert.deepEqual(divergences.filter(d=>SKIPPED.test(d)), []);
    gl.glPixelTransferf(LEGACY.RED_SCALE, 0.5);
    gl.glCopyTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 0, 0, 2, 2);
    assert.ok(divergences.some(d=>/a copy of the framebuffer into a texture on the device/
        .test(d)), divergences.join('\n'));
});
