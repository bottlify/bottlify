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

test('blend factors and equations per draw buffer (4.0): the first is the unindexed state, the '
    + 'unindexed calls set every buffer', ()=>{
    const gl = fixture();
    /** @param {number} query @param {number} index */
    const at = (query, index)=>gl.glGetIntegeri_v(query, index)[0];
    gl.glBlendFuncSeparatei(2, GL.ONE, GL.ONE, GL.ZERO, GL.ONE);
    assert.deepEqual([GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA, GL.BLEND_DST_ALPHA]
        .map(q=>at(q, 2)), [GL.ONE, GL.ONE, GL.ZERO, GL.ONE]);
    assert.equal(at(GL.BLEND_SRC_RGB, 1), GL.ONE, 'the others keep the unindexed state');
    assert.deepEqual(gl.glGetIntegerv(GL.BLEND_DST_RGB), [GL.ZERO]);
    gl.glBlendFuncSeparatei(0, GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.ONE, GL.ZERO);
    assert.deepEqual(gl.glGetIntegerv(GL.BLEND_SRC_RGB), [GL.SRC_ALPHA], 'the first is it');
    assert.equal(at(GL.BLEND_SRC_RGB, 1), GL.ONE, 'and the others did not follow it');
    assert.equal(at(GL.BLEND_DST_RGB, 1), GL.ZERO);
    gl.glBlendEquationSeparatei(3, GL.MAX, GL.MIN);
    assert.deepEqual([at(GL.BLEND_EQUATION_RGB, 3), at(GL.BLEND_EQUATION_ALPHA, 3)],
        [GL.MAX, GL.MIN]);
    const apart = gl.side.perBuffer().functions;
    assert.equal(apart[3].equation, GL.MAX);
    assert.equal(apart[2].src, GL.ONE);
    gl.glBlendFunc(GL.ONE, GL.ZERO);
    assert.equal(at(GL.BLEND_SRC_RGB, 2), GL.ONE);
    assert.equal(at(GL.BLEND_DST_RGB, 2), GL.ZERO, 'glBlendFunc sets every buffer');
    assert.equal(at(GL.BLEND_EQUATION_RGB, 3), GL.MAX, 'but no equation');
    gl.glBlendEquation(GL.FUNC_ADD);
    assert.equal(gl.side.perBuffer(), null, 'all agree again');
    gl.glBlendFuncSeparatei(4, GL.ONE, GL.ONE, GL.ONE, GL.ONE);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glBlendFuncSeparatei(1, GL.ONE, GL.SRC_ALPHA_SATURATE, GL.ONE, GL.ONE);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'saturate is no destination');
    gl.glBlendEquationSeparatei(1, GL.ONE, GL.FUNC_ADD);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
});
