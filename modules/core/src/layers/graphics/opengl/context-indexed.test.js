/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {any} */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 8, height: 4, doubleBuffered: true, depthBits: 24 });
    return context;
}

test('blending per draw buffer: glEnable sets every buffer, glEnablei one, the unindexed query '
    + 'reads the first', ()=>{
    const gl = fixture();
    gl.glEnable(GL.BLEND);
    assert.deepEqual([0, 1, 2, 3].map(i=>gl.glIsEnabledi(GL.BLEND, i)),
        [GL.TRUE, GL.TRUE, GL.TRUE, GL.TRUE]);
    gl.glDisablei(GL.BLEND, 2);
    assert.equal(gl.glIsEnabledi(GL.BLEND, 2), GL.FALSE);
    assert.equal(gl.glIsEnabled(GL.BLEND), GL.TRUE, 'the first is still on');
    gl.glDisablei(GL.BLEND, 0);
    assert.equal(gl.glIsEnabled(GL.BLEND), GL.FALSE, 'the first is GL_BLEND');
    assert.deepEqual(gl.glGetBooleani_v(GL.BLEND, 1), [GL.TRUE]);
    assert.deepEqual(gl.side.perBuffer(), { blend: [false, true, false, true],
        masks: [15, 15, 15, 15] });
    gl.glDisable(GL.BLEND);
    assert.equal(gl.side.perBuffer(), null, 'all agree again');
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    gl.glEnablei(GL.DEPTH_TEST, 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'only blending is indexed in 3.0');
    gl.glEnablei(GL.BLEND, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the last draw buffer');
    assert.equal(gl.glIsEnabledi(GL.BLEND, 9), GL.FALSE);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
});

test('colour masks per draw buffer, and the indexed queries\' errors', ()=>{
    const gl = fixture();
    gl.glColorMask(1, 0, 1, 0);
    assert.deepEqual(gl.glGetBooleani_v(GL.COLOR_WRITEMASK, 3), [1, 0, 1, 0]);
    gl.glColorMaski(1, 0, 1, 0, 1);
    assert.deepEqual(gl.glGetIntegeri_v(GL.COLOR_WRITEMASK, 1), [0, 1, 0, 1]);
    assert.deepEqual(gl.glGetIntegerv(GL.COLOR_WRITEMASK), [1, 0, 1, 0], 'the first');
    gl.glColorMaski(0, 1, 1, 1, 1);
    assert.deepEqual(gl.glGetIntegerv(GL.COLOR_WRITEMASK), [1, 1, 1, 1]);
    assert.deepEqual(gl.side.perBuffer().masks, [15, 10, 5, 5]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.equal(gl.glGetIntegeri_v(GL.DEPTH_FUNC, 0), null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.equal(gl.glGetIntegeri_v(GL.COLOR_WRITEMASK, 4), null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glColorMaski(4, 1, 1, 1, 1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    assert.deepEqual(gl.glGetInteger64v(GL.DEPTH_FUNC), [GL.LESS], 'what glGetIntegerv answers');
});

test('glClearBuffer clears one buffer with the value given, under that buffer\'s mask', ()=>{
    const gl = fixture();
    gl.glClearColor(0, 0, 0, 0);
    gl.clearBuffer(GL.COLOR, 0, [1, 0, 0, 1], 'float');
    // BGRX, the top row first.
    assert.deepEqual([...gl.framebuffer.bytes.subarray(0, 4)], [0, 0, 255, 255]);
    assert.deepEqual(gl.glGetFloatv(GL.COLOR_CLEAR_VALUE), [0, 0, 0, 0],
        'the clear value is not touched');
    gl.glColorMaski(0, 0, 1, 1, 1);
    gl.clearBuffer(GL.COLOR, 0, [0, 1, 0, 1], 'float');
    assert.deepEqual([...gl.framebuffer.bytes.subarray(0, 4)], [0, 255, 255, 255],
        'red kept under the buffer\'s mask');
    gl.clearBuffer(GL.DEPTH, 0, [0.25], 'float');
    assert.equal(gl.framebuffer.depth[0], 0.25);
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    gl.clearBuffer(GL.DEPTH, 0, [1], 'int');
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'depth takes floats');
    gl.clearBuffer(GL.STENCIL, 0, [1], 'float');
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'stencil takes integers');
    gl.clearBuffer(GL.DEPTH_STENCIL, 0, [1], 'float');
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'glClearBufferfi\'s alone');
    gl.clearBuffer(GL.COLOR, 4, [0, 0, 0, 0], 'float');
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.clearBuffer(GL.DEPTH, 1, [0], 'float');
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glClearBufferfi(GL.DEPTH, 0, 0, 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glClearBufferfi(GL.DEPTH_STENCIL, 0, 0.75, 3);
    assert.equal(gl.framebuffer.depth[0], 0.75);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});
