/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Invalidation, barriers, sample shading and format queries (OpenGL 4.0 to
 * 4.5): the checks they make, the state they keep.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {any} */
function context(){
    const bytes = new Uint8Array(0x1000);
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
        allocate: ()=>0x800,
        free: ()=>{},
    } });
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    return gl;
}

test('invalidation keeps what it holds and checks what it names', ()=>{
    const gl = context();
    const [buffer] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, buffer);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 4, Uint8Array.of(1, 2, 3, 4), GL.STATIC_DRAW);
    gl.glInvalidateBufferData(buffer, null, 0);
    gl.glInvalidateBufferData(buffer, 2, 2);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual([...gl.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 0, 4)], [1, 2, 3, 4]);
    gl.glInvalidateBufferData(buffer, 2, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the store');
    gl.glInvalidateBufferData(77, null, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no such buffer');
    gl.glMapBufferARB(GL.ARRAY_BUFFER, GL.READ_ONLY);
    gl.glInvalidateBufferData(buffer, null, 0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'mapped');

    const [texture] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    gl.glInvalidateTexImage(texture, 0, null);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glInvalidateTexImage(texture, -1, null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glInvalidateTexImage(0, 0, null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);

    gl.glInvalidateFramebuffer(GL.FRAMEBUFFER, 1, [GL.COLOR], null);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'the window\'s colour');
    gl.glInvalidateFramebuffer(GL.FRAMEBUFFER, 1, [GL.COLOR_ATTACHMENT0], null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not an attachment of the window');
    gl.glInvalidateFramebuffer(GL.TEXTURE_2D, 0, [], null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not a framebuffer target');
});

test('barriers check their bits, and sample shading is kept', ()=>{
    const gl = context();
    gl.glMemoryBarrier(0xffffffff, false);
    gl.glMemoryBarrier(0x4000, false);
    gl.glTextureBarrier();
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glMemoryBarrier(0x10000, false);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glMemoryBarrier(0x1, true);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'not a region barrier');

    gl.glEnable(GL.SAMPLE_SHADING);
    gl.glMinSampleShading(2);
    assert.equal(gl.glIsEnabled(GL.SAMPLE_SHADING), GL.TRUE);
    assert.deepEqual(gl.glGetFloatv(GL.MIN_SAMPLE_SHADING_VALUE), [1], 'clamped');
    gl.glPushAttrib(GL.MULTISAMPLE_BIT);
    gl.glMinSampleShading(0.25);
    gl.glPopAttrib();
    assert.deepEqual(gl.glGetFloatv(GL.MIN_SAMPLE_SHADING_VALUE), [1]);
});

test('a format answers its sample counts up to the most there are', ()=>{
    const gl = context();
    assert.deepEqual(gl.glGetInternalformativ(GL.RENDERBUFFER, GL.RGBA8, 0x80a9), [4, 2]);
    assert.deepEqual(gl.glGetInternalformativ(GL.RENDERBUFFER, GL.RGBA8, 0x9380), [2]);
    assert.deepEqual(gl.glGetInternalformativ(GL.TEXTURE_2D, GL.RGBA8, 0x9380), [0],
        'a texture is single-sampled');
    assert.deepEqual(gl.glGetInternalformativ(GL.TEXTURE_2D, GL.RGBA8, 0x826f), [GL.TRUE]);
    assert.deepEqual(gl.glGetInternalformativ(GL.TEXTURE_2D, 0x1234, 0x826f), [GL.FALSE]);
    gl.glGetInternalformativ(GL.ARRAY_BUFFER, GL.RGBA8, 0x9380);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
});

test('robust reads refuse a buffer too small, and no reset is ever told (4.5)', ()=>{
    const gl = context();
    assert.equal(gl.glGetGraphicsResetStatus(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegerv(GL.RESET_NOTIFICATION_STRATEGY), [GL.NO_RESET_NOTIFICATION]);
    assert.equal(gl.glReadnPixels(0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, 15), null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'sixteen bytes do not fit fifteen');
    const read = gl.glReadnPixels(0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, 16);
    assert.equal(read.length, 16);
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    const vs = gl.glCreateShader(GL.VERTEX_SHADER);
    gl.glShaderSource(vs, ['uniform vec4 tint; void main() { gl_Position = tint; }']);
    gl.glCompileShader(vs);
    const program = gl.glCreateProgram();
    gl.glAttachShader(program, vs);
    gl.glLinkProgram(program);
    const tint = gl.glGetUniformLocation(program, 'tint');
    assert.equal(gl.getnUniform(program, tint, 12), null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'four floats do not fit twelve bytes');
    assert.deepEqual(gl.getnUniform(program, tint, 16).values, [0, 0, 0, 0]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_ELEMENT_INDEX), [-1]);
});

test('glBindBuffers reaches the storage points, checked against their limit', ()=>{
    const gl = context();
    const [buffer] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, buffer);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 1024, 0, GL.STATIC_DRAW);
    gl.glBindBuffers(GL.SHADER_STORAGE_BUFFER, 0, 2, [buffer, buffer], null);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegeri_v(GL.SHADER_STORAGE_BUFFER_BINDING, 1), [buffer]);
    const most = gl.glGetIntegerv(GL.MAX_SHADER_STORAGE_BUFFER_BINDINGS)[0];
    gl.glBindBuffers(GL.SHADER_STORAGE_BUFFER, most - 1, 2, [buffer, buffer], null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'past the last point');
    gl.glBindBuffers(GL.ATOMIC_COUNTER_BUFFER, 0, 1, [buffer], null);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});
