/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Primitive restart (OpenGL 3.1 section 2.8.1, 4.3's fixed index) on the
 * processor path: what each run between restart indices draws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {{ gl: any, bytes: Uint8Array }} */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    const gl = /** @type {any} */ (createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
    }, keepPrimitives: true }));
    gl.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    // Eight vertices along x: vertex k at (k, 0).
    for (let k = 0; k < 8; k++)
    {
        view.setFloat32(0x100 + k * 8, k, true);
    }
    gl.glVertexPointer(2, GL.FLOAT, 0, 0x100);
    gl.glEnableClientState(GL.VERTEX_ARRAY);
    return { gl, bytes };
}

/** @param {any} gl @returns {number[][]} each primitive's vertices by their x */
const drawn = gl=>gl.submittedPrimitives.map((/** @type {any} */ p)=>p.vertices.map(
    (/** @type {any} */ v)=>v.position[0]));

test('a restart index ends one strip and starts the next', ()=>{
    const { gl, bytes } = fixture();
    new Uint16Array(bytes.buffer, 0x300, 8).set([0, 1, 2, 3, 0xbeef, 4, 5, 6]);
    gl.glEnable(GL.PRIMITIVE_RESTART);
    gl.glPrimitiveRestartIndex(0xbeef);
    assert.deepEqual(gl.glGetIntegerv(GL.PRIMITIVE_RESTART_INDEX), [0xbeef]);
    gl.glDrawElements(GL.TRIANGLE_STRIP, 8, GL.UNSIGNED_SHORT, 0x300);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(drawn(gl), [[0, 1, 2, 3], [4, 5, 6]], 'two strips');
    // A draw compiled into a display list holds its indices, and restarts as it replays.
    gl.glNewList(1, GL.COMPILE);
    gl.glDrawElements(GL.TRIANGLE_STRIP, 8, GL.UNSIGNED_SHORT, 0x300);
    gl.glEndList();
    gl.glCallList(1);
    assert.deepEqual(drawn(gl).slice(2), [[0, 1, 2, 3], [4, 5, 6]]);
    // Indices handed over as the bytes themselves, as a caller that read them does.
    gl.glDrawElements(GL.TRIANGLE_STRIP, 8, GL.UNSIGNED_SHORT, bytes.slice(0x300, 0x310));
    assert.deepEqual(drawn(gl).slice(4), [[0, 1, 2, 3], [4, 5, 6]]);
});

test('a restart index in a list drops the primitive it cut; restart off reads it as an index', ()=>{
    const { gl, bytes } = fixture();
    new Uint32Array(bytes.buffer, 0x300, 7).set([0, 1, 2, 3, 7, 4, 5]);
    gl.glEnable(GL.PRIMITIVE_RESTART);
    gl.glPrimitiveRestartIndex(7);
    gl.glDrawElements(GL.LINES, 7, GL.UNSIGNED_INT, 0x300);
    assert.deepEqual(drawn(gl), [[0, 1, 2, 3], [4, 5]], 'the runs, each a list');
    gl.glDisable(GL.PRIMITIVE_RESTART);
    gl.glDrawElements(GL.LINES, 7, GL.UNSIGNED_INT, 0x300);
    assert.deepEqual(drawn(gl).at(-1), [0, 1, 2, 3, 7, 4, 5], 'seven read as a vertex');
});

test('the fixed restart index is the type\'s largest, whatever the restart index says', ()=>{
    const { gl, bytes } = fixture();
    bytes.set([0, 1, 2, 0xff, 3, 4, 5], 0x300);
    gl.glPrimitiveRestartIndex(1);
    gl.glEnable(GL.PRIMITIVE_RESTART_FIXED_INDEX);
    gl.glDrawElements(GL.TRIANGLE_FAN, 7, GL.UNSIGNED_BYTE, 0x300);
    assert.deepEqual(drawn(gl), [[0, 1, 2], [3, 4, 5]], 'two fans, one is no restart here');
    // A list compiled into a display list restarts as it replays.
    gl.glNewList(1, GL.COMPILE);
    gl.glDrawElements(GL.TRIANGLE_FAN, 7, GL.UNSIGNED_BYTE, 0x300);
    gl.glEndList();
    gl.glCallList(1);
    assert.deepEqual(drawn(gl).slice(2), [[0, 1, 2], [3, 4, 5]]);
});
