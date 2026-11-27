/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The smaller state of OpenGL 3.0 to 3.2: colour clamping, integer texture
 * parameters, depth clamping and seamless cube maps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

test('glClampColor keeps what it is given, and says when that is not what is done', ()=>{
    /** @type {string[]} */
    const said = [];
    const gl = /** @type {any} */ (createGlContext({ divergence: d=>said.push(d) }));
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    assert.deepEqual([GL.CLAMP_VERTEX_COLOR, GL.CLAMP_FRAGMENT_COLOR, GL.CLAMP_READ_COLOR]
        .map(q=>gl.glGetIntegerv(q)[0]), [GL.TRUE, GL.FIXED_ONLY, GL.FIXED_ONLY]);
    gl.glClampColor(GL.CLAMP_READ_COLOR, GL.FIXED_ONLY);
    assert.deepEqual(said, [], 'what is done already');
    gl.glClampColor(GL.CLAMP_FRAGMENT_COLOR, GL.TRUE);
    assert.deepEqual(gl.glGetIntegerv(GL.CLAMP_FRAGMENT_COLOR), [GL.TRUE]);
    assert.equal(said.length, 1);
    gl.glClampColor(GL.DEPTH_TEST, GL.TRUE);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glClampColor(GL.CLAMP_READ_COLOR, 7);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glPushAttrib(GL.COLOR_BUFFER_BIT);
    gl.glClampColor(GL.CLAMP_FRAGMENT_COLOR, GL.FALSE);
    gl.glPopAttrib();
    assert.deepEqual(gl.glGetIntegerv(GL.CLAMP_FRAGMENT_COLOR), [GL.TRUE], 'saved with colour');
});

test('an integer border colour is kept as the integers given; the other integer parameters '
    + 'are judged as glTexParameteriv judges them', ()=>{
    const gl = /** @type {any} */ (createGlContext({}));
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    gl.glBindTexture(GL.TEXTURE_2D, 1);
    gl.texParameterI(GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR, [7, -3, 300, 1]);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR),
        [7, -3, 300, 1], 'not clamped as a colour');
    gl.texParameterI(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, [GL.CLAMP_TO_EDGE]);
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S),
        [GL.CLAMP_TO_EDGE]);
    gl.texParameterI(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, [GL.TEXTURE_2D]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.texParameterI(GL.TEXTURE_2D, GL.TEXTURE_BORDER_COLOR, [1, 2]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'a colour is four');
});

test('GL_DEPTH_CLAMP leaves depth unclipped where the device can, and says so where it cannot',
    async()=>{
        for (const features of [['depth-clip-control'], []])
        {
            /** @type {string[]} */
            const said = [];
            const gpu = createFakeDevice({ features });
            const renderer = createGpuRenderer({
                backend: createBackend({ device: gpu.device, queue: gpu.queue,
                    presentTo: ()=>{} }),
                createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
                divergence: d=>said.push(d),
            });
            const gl = /** @type {any} */ (createGlContext({ gpu: renderer }));
            gl.attach({ width: 4, height: 4, doubleBuffered: true, depthBits: 24 });
            const triangle = ()=>{
                gl.glBegin(GL.TRIANGLES);
                gl.glVertex2f(0, 0);
                gl.glVertex2f(1, 0);
                gl.glVertex2f(0, 1);
                gl.glEnd();
            };
            // Clipped first: the clamp is a pipeline of its own.
            triangle();
            gl.glEnable(GL.DEPTH_CLAMP);
            assert.equal(gl.glIsEnabled(GL.DEPTH_CLAMP), GL.TRUE);
            triangle();
            renderer.present(gl);
            await renderer.settled();
            const unclipped = gpu.of('createRenderPipeline').some((/** @type {any} */ c)=>
                c.descriptor.primitive?.unclippedDepth === true);
            assert.equal(unclipped, features.length > 0);
            assert.equal(said.some(d=>/DEPTH_CLAMP/.test(d)), features.length === 0);
        }
        const gl = /** @type {any} */ (createGlContext({}));
        gl.attach({ width: 4, height: 4, doubleBuffered: true });
        gl.glEnable(GL.TEXTURE_CUBE_MAP_SEAMLESS);
        assert.equal(gl.glIsEnabled(GL.TEXTURE_CUBE_MAP_SEAMLESS), GL.TRUE);
    });
