/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The state calls OpenGL 1.2 to 2.1 added, against the specification: each
 * one's errors and the queries that read back what it set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {any} */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    return context;
}

test('blending: separate factors and equations, constant factors, and glBlendFunc setting'
    + ' all four', ()=>{
    const gl = fixture();
    const read = ()=>[GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA, GL.BLEND_DST_ALPHA]
        .map(q=>gl.glGetIntegerv(q)[0]);
    assert.deepEqual(read(), [GL.ONE, GL.ZERO, GL.ONE, GL.ZERO]);
    gl.glBlendFuncSeparate(GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.ONE, GL.CONSTANT_ALPHA);
    assert.deepEqual(read(), [GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.ONE, GL.CONSTANT_ALPHA]);
    assert.deepEqual(gl.glGetIntegerv(GL.BLEND_SRC), [GL.SRC_ALPHA], 'GL_BLEND_SRC is the colour');
    gl.glBlendFunc(GL.DST_COLOR, GL.ZERO);
    assert.deepEqual(read(), [GL.DST_COLOR, GL.ZERO, GL.DST_COLOR, GL.ZERO]);
    gl.glBlendFuncSeparate(GL.ONE, GL.SRC_ALPHA_SATURATE, GL.ONE, GL.ONE);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'saturate is a source factor alone');
    gl.glBlendEquationSeparate(GL.FUNC_REVERSE_SUBTRACT, GL.MAX);
    assert.deepEqual([gl.glGetIntegerv(GL.BLEND_EQUATION_RGB), gl.glGetIntegerv(
        GL.BLEND_EQUATION_ALPHA)], [[GL.FUNC_REVERSE_SUBTRACT], [GL.MAX]]);
    gl.glBlendEquation(0x1234);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glBlendColor(2, 0.5, -1, 0.25);
    assert.deepEqual(gl.glGetFloatv(GL.BLEND_COLOR), [1, 0.5, 0, 0.25], 'clamped');
});

test('stencil faces: the separate calls set the face named, the one-face calls both', ()=>{
    const gl = fixture();
    gl.glStencilFuncSeparate(GL.BACK, GL.LESS, 4, 0x0f);
    gl.glStencilOpSeparate(GL.FRONT, GL.KEEP, GL.INCR_WRAP, GL.REPLACE);
    gl.glStencilMaskSeparate(GL.FRONT_AND_BACK, 0x3c);
    assert.deepEqual(gl.glGetIntegerv(GL.STENCIL_BACK_FUNC), [GL.LESS]);
    assert.deepEqual(gl.glGetIntegerv(GL.STENCIL_BACK_REF), [4]);
    assert.deepEqual(gl.glGetIntegerv(GL.STENCIL_FUNC), [GL.ALWAYS], 'the front untouched');
    assert.deepEqual(gl.glGetIntegerv(GL.STENCIL_PASS_DEPTH_FAIL), [GL.INCR_WRAP]);
    assert.deepEqual(gl.glGetIntegerv(GL.STENCIL_BACK_PASS_DEPTH_FAIL), [GL.KEEP]);
    assert.deepEqual([gl.glGetIntegerv(GL.STENCIL_WRITEMASK), gl.glGetIntegerv(
        GL.STENCIL_BACK_WRITEMASK)], [[0x3c], [0x3c]]);
    gl.glStencilFunc(GL.EQUAL, 1, 0xff);
    assert.deepEqual(gl.glGetIntegerv(GL.STENCIL_BACK_FUNC), [GL.EQUAL], 'both faces');
    gl.glStencilFuncSeparate(0x1234, GL.LESS, 0, 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glStencilOpSeparate(GL.BACK, GL.KEEP, 0x1234, GL.KEEP);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
});

test('the window\'s draw buffers: one buffer each, none twice, none it does not have', ()=>{
    const gl = fixture();
    gl.glDrawBuffers([GL.BACK_LEFT, GL.NONE]);
    assert.deepEqual([gl.glGetIntegerv(GL.DRAW_BUFFER0), gl.glGetIntegerv(GL.DRAW_BUFFER1)],
        [[GL.BACK_LEFT], [GL.NONE]]);
    gl.glDrawBuffers([GL.BACK]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'BACK names two buffers, and glDrawBuffers'
        + ' takes one each');
    gl.glDrawBuffers([GL.BACK_LEFT, GL.BACK_LEFT]);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    gl.glDrawBuffers(new Array(5).fill(GL.NONE));
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past GL_MAX_DRAW_BUFFERS');
    gl.glDrawBuffers([GL.COLOR_ATTACHMENT0]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'an attachment is a framebuffer object\'s');
    gl.glDrawBuffer(GL.FRONT);
    assert.deepEqual(gl.glGetIntegerv(GL.DRAW_BUFFER0), [GL.FRONT], 'glDrawBuffer sets the first');
});

test('point parameters, sample coverage, and the multisample enables are state', ()=>{
    const gl = fixture();
    gl.glPointParameterfv(GL.POINT_DISTANCE_ATTENUATION, [1, 0.5, 0.25]);
    assert.deepEqual(gl.glGetFloatv(GL.POINT_DISTANCE_ATTENUATION), [1, 0.5, 0.25]);
    gl.glPointParameterfv(GL.POINT_SIZE_MIN, [-1]);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glPointParameterfv(GL.POINT_SPRITE_COORD_ORIGIN, [GL.LOWER_LEFT]);
    assert.deepEqual(gl.glGetIntegerv(GL.POINT_SPRITE_COORD_ORIGIN), [GL.LOWER_LEFT]);
    gl.glSampleCoverage(0.25, 1);
    assert.deepEqual([gl.glGetFloatv(GL.SAMPLE_COVERAGE_VALUE), gl.glGetBooleanv(
        GL.SAMPLE_COVERAGE_INVERT)], [[0.25], [1]]);
    assert.equal(gl.glIsEnabled(GL.MULTISAMPLE), GL.TRUE, 'on by default');
    gl.glEnable(GL.POINT_SPRITE);
    assert.equal(gl.glIsEnabled(GL.POINT_SPRITE), GL.TRUE);
});

test('a transposed matrix loads as its transpose, and a window position needs no transform',
    ()=>{
        const gl = fixture();
        gl.glMatrixMode(GL.MODELVIEW);
        gl.glLoadTransposeMatrixf([1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1]);
        assert.deepEqual(gl.glGetFloatv(GL.MODELVIEW_MATRIX).slice(12), [5, 6, 7, 1]);
        gl.glDepthRange(0.5, 1);
        gl.glWindowPos3f(10, 20, 0.5);
        assert.deepEqual(gl.glGetFloatv(GL.CURRENT_RASTER_POSITION), [10, 20, 0.75, 1]);
        assert.deepEqual(gl.glGetBooleanv(GL.CURRENT_RASTER_POSITION_VALID), [1]);
    });

test('an occlusion query answers at once, and its errors are the specification\'s', ()=>{
    const gl = fixture();
    const [q] = gl.glGenQueries(1);
    assert.equal(gl.glIsQuery(q), GL.FALSE, 'not a query until begun');
    gl.glBeginQuery(GL.SAMPLES_PASSED, q);
    assert.deepEqual(gl.glGetQueryiv(GL.SAMPLES_PASSED, GL.CURRENT_QUERY), [q]);
    gl.glBeginQuery(GL.SAMPLES_PASSED, q);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'one active at a time');
    assert.equal(gl.glGetQueryObject(q, GL.QUERY_RESULT), null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not while it is active');
    gl.glEndQuery(GL.SAMPLES_PASSED);
    assert.deepEqual(gl.glGetQueryObject(q, GL.QUERY_RESULT_AVAILABLE), [1]);
    assert.ok(gl.glGetQueryObject(q, GL.QUERY_RESULT)[0] > 0);
    gl.glEndQuery(GL.SAMPLES_PASSED);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'none active');
    assert.deepEqual(gl.glGetQueryiv(GL.SAMPLES_PASSED, GL.QUERY_COUNTER_BITS), [32]);
});

test('3D textures: the minimum size is taken, past it is a value error', ()=>{
    const gl = fixture();
    gl.texImage3D('glTexImage3D', GL.TEXTURE_3D, 0, 16, 16, 16);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.texImage3D('glTexImage3D', GL.TEXTURE_3D, 0, 32, 16, 16);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.texImage3D('glTexImage3D', GL.TEXTURE_2D, 0, 1, 1, 1);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_3D_TEXTURE_SIZE), [16]);
});
