/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Viewport arrays (OpenGL 4.1, GL_ARB_viewport_array): each viewport's
 * rectangle, depth range, scissor box and test, the first the unindexed
 * state, saved with their groups.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { GL_EXTENSIONS } from './extensions.js';

/** @returns {any} */
function context(){
    const gl = createGlContext({});
    gl.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    return gl;
}

test('every viewport starts as the window, and an unindexed call sets them all', ()=>{
    const gl = context();
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VIEWPORTS), [16]);
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 15), [0, 0, 64, 32]);
    gl.glViewportArrayv(3, 2, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 4), [5, 6, 7, 8]);
    assert.deepEqual(gl.glGetIntegerv(GL.VIEWPORT), [0, 0, 64, 32], 'the first is apart');
    gl.glViewport(1, 1, 10, 10);
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 4), [1, 1, 10, 10], 'all of them');

    gl.glViewportArrayv(0, 1, [2.5, 0, 8, 8]);
    assert.deepEqual(gl.glGetIntegerv(GL.VIEWPORT), [3, 0, 8, 8],
        'the first is the record, at whole pixels');
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 0), [3, 0, 8, 8]);
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 1), [1, 1, 10, 10],
        'the others keep what they had');

    gl.glViewportArrayv(15, 2, [0, 0, 1, 1, 0, 0, 1, 1]);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the last');
    gl.glViewportArrayv(1, 1, [0, 0, -1, 1]);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a negative size');
    gl.glGetFloati_v(GL.VIEWPORT, 16);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glViewportArrayv(1, 1, [-1e6, 1e6, 1e6, 1]);
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 1), [-32768, 32767, 4096, 1],
        'within the bounds and the largest viewport');
    assert.ok(GL_EXTENSIONS.GL_ARB_viewport_array.includes('glViewportIndexedf'));
});

test('scissor boxes, scissor tests and depth ranges are per viewport too', ()=>{
    const gl = context();
    gl.glScissorArrayv(2, 1, [1, 2, 3, 4]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.SCISSOR_BOX, 2), [1, 2, 3, 4]);
    gl.glScissor(0, 0, 5, 5);
    assert.deepEqual(gl.glGetIntegeri_v(GL.SCISSOR_BOX, 2), [0, 0, 5, 5]);

    gl.glEnablei(GL.SCISSOR_TEST, 5);
    assert.equal(gl.glIsEnabledi(GL.SCISSOR_TEST, 5), GL.TRUE);
    assert.equal(gl.glIsEnabled(GL.SCISSOR_TEST), GL.FALSE);
    assert.deepEqual(gl.glGetBooleani_v(GL.SCISSOR_TEST, 5), [GL.TRUE]);
    gl.glEnablei(GL.SCISSOR_TEST, 0);
    assert.equal(gl.glIsEnabled(GL.SCISSOR_TEST), GL.TRUE, 'the first is the unindexed test');
    gl.glDisable(GL.SCISSOR_TEST);
    assert.equal(gl.glIsEnabledi(GL.SCISSOR_TEST, 5), GL.FALSE, 'glDisable is every viewport\'s');
    gl.glEnablei(GL.SCISSOR_TEST, 16);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);

    gl.glDepthRangeArrayv(1, 2, [0.25, 0.5, 2, -1]);
    assert.deepEqual(gl.glGetFloati_v(GL.DEPTH_RANGE, 2), [1, 0], 'clamped');
    assert.deepEqual(gl.glGetFloati_v(GL.DEPTH_RANGE, 1), [0.25, 0.5]);
    gl.glDepthRange(0, 0.5);
    assert.deepEqual(gl.glGetFloati_v(GL.DEPTH_RANGE, 1), [0, 0.5]);
});

test('every viewport\'s state is saved with its attribute group, and compiled into lists', ()=>{
    const gl = context();
    gl.glViewportArrayv(1, 1, [1, 1, 2, 2]);
    gl.glScissorArrayv(1, 1, [3, 3, 4, 4]);
    gl.glEnablei(GL.SCISSOR_TEST, 1);
    gl.glPushAttrib(GL.VIEWPORT_BIT);
    gl.glViewportArrayv(1, 1, [9, 9, 9, 9]);
    gl.glScissorArrayv(1, 1, [9, 9, 9, 9]);
    gl.glPopAttrib();
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 1), [1, 1, 2, 2]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.SCISSOR_BOX, 1), [9, 9, 9, 9], 'not the viewport group');
    gl.glPushAttrib(GL.ENABLE_BIT);
    gl.glDisablei(GL.SCISSOR_TEST, 1);
    gl.glPopAttrib();
    assert.equal(gl.glIsEnabledi(GL.SCISSOR_TEST, 1), GL.TRUE);

    const list = gl.glGenLists(1);
    gl.glNewList(list, GL.COMPILE);
    gl.glViewportArrayv(7, 1, [4, 4, 4, 4]);
    gl.glEndList();
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 7), [0, 0, 64, 32]);
    gl.glCallList(list);
    assert.deepEqual(gl.glGetFloati_v(GL.VIEWPORT, 7), [4, 4, 4, 4]);
});
