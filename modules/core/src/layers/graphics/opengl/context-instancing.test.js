/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Instanced draws, divided arrays and base vertices on the processor path
 * (OpenGL 3.1 section 2.8.3, 3.2's base vertex, 3.3's divisor): what each
 * instance reads, the errors, and the divisor as vertex array state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {{ gl: any, floats: (at: number, values: number[]) => void, words: (at: number, values: number[]) => void }} */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
    }, keepPrimitives: true });
    gl.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    return {
        gl,
        floats: (at, values)=>values.forEach((v, i)=>view.setFloat32(at + i * 4, v, true)),
        words: (at, values)=>values.forEach((v, i)=>view.setUint32(at + i * 4, v, true)),
    };
}

test('each instance is drawn in turn, a divided array read by instance from the base one', ()=>{
    const { gl, floats } = fixture();
    floats(0x100, [0, 0, 1, 0, 0, 1]);
    // Three colours, one an instance from the second.
    floats(0x200, [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
    gl.glVertexPointer(2, GL.FLOAT, 0, 0x100);
    gl.glColorPointer(4, GL.FLOAT, 0, 0x200);
    gl.glEnableClientState(GL.VERTEX_ARRAY);
    gl.glEnableClientState(GL.COLOR_ARRAY);
    gl.glVertexAttribDivisor(3, 1);
    gl.glDrawArraysInstancedBaseInstance(GL.TRIANGLES, 0, 3, 2, 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    const drawn = gl.submittedPrimitives;
    assert.equal(drawn.length, 2, 'two instances, two triangles');
    assert.deepEqual(drawn.map((/** @type {any} */ p)=>p.vertices[0].color),
        [[0, 1, 0, 1], [0, 0, 1, 1]], 'each instance its own colour, from the base instance');
    assert.deepEqual(drawn[0].vertices[2].color, [0, 1, 0, 1], 'the same for every vertex');
    assert.deepEqual(gl.glGetVertexAttribfvARB(3, GL.VERTEX_ATTRIB_ARRAY_DIVISOR), [1]);
});

test('a base vertex moves every index before the arrays are read', ()=>{
    const { gl, floats, words } = fixture();
    floats(0x100, [9, 9, 0, 0, 1, 0, 0, 1]);
    words(0x300, [0, 1, 2]);
    gl.glVertexPointer(2, GL.FLOAT, 0, 0x100);
    gl.glEnableClientState(GL.VERTEX_ARRAY);
    gl.glDrawElementsBaseVertex(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x300, 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.submittedPrimitives[0].vertices.map((/** @type {any} */ v)=>
        v.position.slice(0, 2)), [[0, 0], [1, 0], [0, 1]], 'vertex 0 is skipped');
    gl.glDrawRangeElementsBaseVertex(GL.TRIANGLES, 2, 1, 3, GL.UNSIGNED_INT, 0x300, 1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'an end before the start');
    gl.glDrawElementsInstanced(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x300, -2);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a negative instance count');
    gl.glMultiDrawElementsBaseVertex(GL.TRIANGLES, [3, 3], GL.UNSIGNED_INT, [0x300, 0x300], -1,
        [0, 1]);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a negative draw count');
    gl.glMultiDrawElementsBaseVertex(GL.TRIANGLES, [3, 3], GL.UNSIGNED_INT, [0x300, 0x300], 2,
        [0, 1]);
    assert.equal(gl.submittedPrimitives.length, 3, 'one more draw a list');
    assert.deepEqual(gl.submittedPrimitives[1].vertices[0].position.slice(0, 2), [9, 9]);
});

test('the divisor is vertex array object state, and refused past the last attribute', ()=>{
    const { gl } = fixture();
    const [vao] = gl.glGenVertexArrays(1);
    gl.glBindVertexArray(vao);
    gl.glVertexAttribDivisor(6, 4);
    gl.glBindVertexArray(0);
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_DIVISOR), [0]);
    gl.glBindVertexArray(vao);
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_DIVISOR), [4]);
    gl.glVertexAttribDivisor(99, 1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
});
