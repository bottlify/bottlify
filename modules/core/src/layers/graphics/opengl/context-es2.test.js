/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenGL ES 2.0's calls on the desktop (4.1, GL_ARB_ES2_compatibility):
 * precisions, shader binaries, the limits in vectors and fixed-point arrays.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { GL_EXTENSIONS } from './extensions.js';

/** @returns {any} */
function context(){
    const bytes = new Uint8Array(0x1000);
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
    }, keepPrimitives: true });
    gl.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    return Object.assign(gl, { bytes });
}

test('every precision is the desktop\'s, and asked of a stage only', ()=>{
    const gl = context();
    assert.deepEqual(gl.glGetShaderPrecisionFormat(GL.FRAGMENT_SHADER, GL.MEDIUM_FLOAT),
        { range: [127, 127], precision: 23 });
    assert.deepEqual(gl.glGetShaderPrecisionFormat(GL.VERTEX_SHADER, GL.LOW_INT),
        { range: [31, 30], precision: 0 });
    assert.equal(gl.glGetShaderPrecisionFormat(GL.GEOMETRY_SHADER ?? 0x8dd9, GL.HIGH_FLOAT),
        null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'a stage ES 2.0 does not have');
    gl.glGetShaderPrecisionFormat(GL.VERTEX_SHADER, GL.FLOAT);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not a precision');
});

test('no shader binary format is known, and the compiler stays', ()=>{
    const gl = context();
    assert.deepEqual(gl.glGetIntegerv(GL.NUM_SHADER_BINARY_FORMATS), [0]);
    assert.deepEqual(gl.glGetIntegerv(GL.SHADER_BINARY_FORMATS), []);
    const shader = gl.glCreateShader(GL.VERTEX_SHADER);
    gl.glShaderBinary([shader], 0x1234, 16);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glShaderBinary([shader], 0x1234, -1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glReleaseShaderCompiler();
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetBooleanv(GL.SHADER_COMPILER), [GL.TRUE]);
});

test('the limits in vectors are the component limits by four, and glReadPixels\' best is'
    + ' RGBA bytes', ()=>{
    const gl = context();
    for (const [vectors, components] of [
        [GL.MAX_VERTEX_UNIFORM_VECTORS, GL.MAX_VERTEX_UNIFORM_COMPONENTS],
        [GL.MAX_FRAGMENT_UNIFORM_VECTORS, GL.MAX_FRAGMENT_UNIFORM_COMPONENTS],
        [GL.MAX_VARYING_VECTORS, GL.MAX_VARYING_FLOATS],
    ])
    {
        assert.equal(gl.glGetIntegerv(vectors)[0] * 4, gl.glGetIntegerv(components)[0]);
    }
    assert.deepEqual(gl.glGetIntegerv(GL.IMPLEMENTATION_COLOR_READ_FORMAT), [GL.RGBA]);
    assert.deepEqual(gl.glGetIntegerv(GL.IMPLEMENTATION_COLOR_READ_TYPE), [GL.UNSIGNED_BYTE]);
    assert.ok(GL_EXTENSIONS.GL_ARB_ES2_compatibility.includes('glGetShaderPrecisionFormat'));
});

test('a fixed-point attribute array reads 16.16, never normalised', ()=>{
    const gl = context();
    const view = new DataView(gl.bytes.buffer);
    [0, 0, 1.5, 0, 0, -2.25].forEach((v, i)=>view.setInt32(0x100 + i * 4, v * 65536, true));
    gl.glVertexAttribPointerARB(0, 2, GL.FIXED, GL.TRUE, 0, 0x100);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.submittedPrimitives[0].vertices.map((/** @type {any} */ v)=>
        v.position.slice(0, 2)), [[0, 0], [1.5, 0], [0, -2.25]]);
});
