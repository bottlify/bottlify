/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex array objects against OpenGL 3.0 section 2.10 and table 6.6/6.7:
 * what an object holds, what stays the context's, and the object model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {any} */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 16, height: 16, doubleBuffered: true, depthBits: 24 });
    return context;
}

test('a vertex array object is a name until it is bound, and only a generated name binds', ()=>{
    const gl = fixture();
    const [a, b] = gl.glGenVertexArrays(2);
    assert.deepEqual([a, b], [1, 2]);
    assert.equal(gl.glIsVertexArray(a), GL.FALSE, 'generated, not yet an object');
    gl.glBindVertexArray(a);
    assert.equal(gl.glIsVertexArray(a), GL.TRUE);
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY_BINDING), [a]);
    gl.glBindVertexArray(7);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a name never generated');
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY_BINDING), [a]);
    assert.equal(gl.glIsVertexArray(0), GL.FALSE);
    assert.deepEqual(gl.glGenVertexArrays(1), [3], 'a generated name is not handed out again');
});

test('the arrays, their enables and the element array binding are the object\'s; the array'
    + ' buffer binding and the client-active unit are the context\'s', ()=>{
    const gl = fixture();
    const [vao] = gl.glGenVertexArrays(1);
    const [elements, vertices] = gl.glGenBuffersARB(2);
    gl.glBindVertexArray(vao);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, vertices);
    gl.glVertexPointer(3, GL.FLOAT, 12, 0x40);
    gl.glEnableClientState(GL.VERTEX_ARRAY);
    gl.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, elements);
    gl.glVertexAttribPointerARB(6, 2, GL.FLOAT, 0, 8, 0x80);
    gl.glEnableVertexAttribArrayARB(6);
    gl.glClientActiveTextureARB(GL.TEXTURE1);

    gl.glBindVertexArray(0);
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY), [0], 'the default object\'s enable');
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY_SIZE), [4]);
    assert.deepEqual(gl.glGetIntegerv(GL.ELEMENT_ARRAY_BUFFER_BINDING), [0]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB), [0]);
    assert.deepEqual(gl.glGetIntegerv(GL.ARRAY_BUFFER_BINDING), [vertices],
        'the array buffer binding stays');
    assert.deepEqual(gl.glGetIntegerv(GL.CLIENT_ACTIVE_TEXTURE), [GL.TEXTURE1]);

    gl.glBindVertexArray(vao);
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY), [1], 'the object kept its own');
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY_SIZE), [3]);
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY_STRIDE), [12]);
    assert.deepEqual(gl.glGetPointerv(GL.VERTEX_ARRAY_POINTER), [0x40]);
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY_BUFFER_BINDING), [vertices]);
    assert.deepEqual(gl.glGetIntegerv(GL.ELEMENT_ARRAY_BUFFER_BINDING), [elements]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB), [1]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(6, GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB), [2]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('a new object starts from the initial state, not the one bound before', ()=>{
    const gl = fixture();
    gl.glEnableClientState(GL.COLOR_ARRAY);
    gl.glColorPointer(3, GL.UNSIGNED_BYTE, 0, 0x10);
    const [vao] = gl.glGenVertexArrays(1);
    gl.glBindVertexArray(vao);
    assert.deepEqual(gl.glGetIntegerv(GL.COLOR_ARRAY), [0]);
    assert.deepEqual(gl.glGetIntegerv(GL.COLOR_ARRAY_SIZE), [4]);
    gl.glBindVertexArray(0);
    assert.deepEqual(gl.glGetIntegerv(GL.COLOR_ARRAY), [1], 'the default object kept its own');
    assert.deepEqual(gl.glGetIntegerv(GL.COLOR_ARRAY_SIZE), [3]);
});

test('deleting the bound object leaves the default one bound', ()=>{
    const gl = fixture();
    gl.glEnableClientState(GL.NORMAL_ARRAY);
    const [vao] = gl.glGenVertexArrays(1);
    gl.glBindVertexArray(vao);
    gl.glDeleteVertexArrays([vao, 0, 55]);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'zero and unknown names are ignored');
    assert.deepEqual(gl.glGetIntegerv(GL.VERTEX_ARRAY_BINDING), [0]);
    assert.deepEqual(gl.glGetIntegerv(GL.NORMAL_ARRAY), [1], 'the default object\'s state');
    assert.equal(gl.glIsVertexArray(vao), GL.FALSE);
    gl.glBindVertexArray(vao);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a deleted name no longer binds');
});
