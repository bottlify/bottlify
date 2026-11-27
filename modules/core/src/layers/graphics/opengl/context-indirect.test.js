/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Indirect draws (OpenGL 4.0 section 10.4, 4.3's multiple draws, 4.6's
 * counted ones): what each command draws, read from the bound
 * DRAW_INDIRECT_BUFFER or the program's memory, and the errors.
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

/** @param {number[]} values @returns {Uint8Array} the words' bytes */
const wordBytes = values=>new Uint8Array(new Uint32Array(values).buffer);

/** @param {any} gl @param {number} target @param {number[]} values @returns {number} its name */
function bufferOf(gl, target, values){
    const [name] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(target, name);
    gl.glBufferDataARB(target, values.length * 4, wordBytes(values), GL.STATIC_DRAW);
    return name;
}

/** @param {any} gl @returns {number[][]} each primitive's first position */
const firsts = gl=>gl.submittedPrimitives.map((/** @type {any} */ p)=>
    p.vertices[0].position.slice(0, 2));

/**
 * Six vertices at x = 0..5 (y 0), colours by instance from a divided array.
 *
 * @param {ReturnType<typeof fixture>} f
 */
function arrays(f){
    f.floats(0x100, [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0]);
    f.floats(0x200, [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
    f.gl.glVertexPointer(2, GL.FLOAT, 0, 0x100);
    f.gl.glColorPointer(4, GL.FLOAT, 0, 0x200);
    f.gl.glEnableClientState(GL.VERTEX_ARRAY);
    f.gl.glEnableClientState(GL.COLOR_ARRAY);
    f.gl.glVertexAttribDivisor(3, 1);
}

test('an arrays command draws its count from its first, its instances from its base one', ()=>{
    const f = fixture();
    const { gl } = f;
    arrays(f);
    // count 3, instances 2, first 1, base instance 1, after a word of padding.
    const name = bufferOf(gl, GL.DRAW_INDIRECT_BUFFER, [0, 3, 2, 1, 1]);
    assert.deepEqual(gl.glGetIntegerv(GL.DRAW_INDIRECT_BUFFER_BINDING), [name]);
    gl.glDrawArraysIndirect(GL.TRIANGLES, 4);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(firsts(gl), [[1, 0], [1, 0]], 'from the first');
    assert.deepEqual(gl.submittedPrimitives.map((/** @type {any} */ p)=>p.vertices[0].color),
        [[0, 1, 0, 1], [0, 0, 1, 1]], 'each instance from the base one');

    gl.glDrawArraysIndirect(GL.TRIANGLES, 2);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'an offset not of whole words');
    gl.glDrawArraysIndirect(GL.TRIANGLES, 8);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a command past the store');
    gl.glDrawArraysIndirect(0x77, 4);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.equal(gl.submittedPrimitives.length, 2, 'nothing more drawn');

    // With no buffer bound, the compatibility profile reads the program's memory.
    gl.glBindBufferARB(GL.DRAW_INDIRECT_BUFFER, 0);
    f.words(0x400, [3, 1, 2, 0]);
    gl.glDrawArraysIndirect(GL.TRIANGLES, 0x400);
    assert.deepEqual(firsts(gl).at(-1), [2, 0]);

    gl.glDeleteBuffersARB([name]);
    gl.glBindBufferARB(GL.DRAW_INDIRECT_BUFFER, name);
    gl.glDeleteBuffersARB([name]);
    assert.deepEqual(gl.glGetIntegerv(GL.DRAW_INDIRECT_BUFFER_BINDING), [0],
        'deleting unbinds it');
});

test('elements commands read their first index and base vertex, apart by their stride', ()=>{
    const f = fixture();
    const { gl } = f;
    arrays(f);
    gl.glVertexAttribDivisor(3, 0);
    // Indices 0 1 2 3 4 5 in shorts.
    const indices = gl.glGenBuffersARB(1)[0];
    gl.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, indices);
    gl.glBufferDataARB(GL.ELEMENT_ARRAY_BUFFER, 12,
        new Uint8Array(new Uint16Array([0, 1, 2, 3, 4, 5]).buffer), GL.STATIC_DRAW);
    // Two commands six words apart: (3, 1, first index 2, base vertex -1, 0)
    // and (3, 1, 0, 2, 0).
    bufferOf(gl, GL.DRAW_INDIRECT_BUFFER, [3, 1, 2, -1 >>> 0, 0, 99, 3, 1, 0, 2, 0, 99]);
    gl.glMultiDrawElementsIndirect(GL.TRIANGLES, GL.UNSIGNED_SHORT, 0, 2, 24);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(firsts(gl), [[1, 0], [2, 0]], 'index 2 less one, index 0 and two more');
    gl.glDrawElementsIndirect(GL.TRIANGLES, GL.UNSIGNED_SHORT, 24);
    assert.deepEqual(firsts(gl).at(-1), [2, 0], 'one at an offset');

    gl.glMultiDrawElementsIndirect(GL.TRIANGLES, GL.UNSIGNED_SHORT, 0, 2, 6);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a stride not of whole words');
    gl.glMultiDrawElementsIndirect(GL.TRIANGLES, GL.UNSIGNED_SHORT, 0, -1, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a negative count');
    gl.glMultiDrawElementsIndirect(GL.TRIANGLES, GL.FLOAT, 0, 1, 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not an index type');
    gl.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, 0);
    gl.glDrawElementsIndirect(GL.TRIANGLES, GL.UNSIGNED_SHORT, 0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'indices only from a buffer');
    assert.equal(gl.submittedPrimitives.length, 3);
});

test('the packed arrays commands follow one another, and a counted call takes no more than'
    + ' the parameter buffer says', ()=>{
    const f = fixture();
    const { gl } = f;
    arrays(f);
    gl.glVertexAttribDivisor(3, 0);
    bufferOf(gl, GL.DRAW_INDIRECT_BUFFER, [3, 1, 0, 0, 3, 1, 3, 0, 3, 1, 1, 0]);
    gl.glMultiDrawArraysIndirect(GL.TRIANGLES, 0, 3, 0);
    assert.deepEqual(firsts(gl), [[0, 0], [3, 0], [1, 0]], 'stride zero is packed');

    gl.glMultiDrawArraysIndirectCount(GL.TRIANGLES, 0, 0, 3, 0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no parameter buffer');
    const parameters = bufferOf(gl, GL.PARAMETER_BUFFER, [7, 2]);
    assert.deepEqual(gl.glGetIntegerv(GL.PARAMETER_BUFFER_BINDING), [parameters]);
    gl.glMultiDrawArraysIndirectCount(GL.TRIANGLES, 0, 4, 3, 0);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(firsts(gl).slice(3), [[0, 0], [3, 0]], 'the count read');
    gl.glMultiDrawArraysIndirectCount(GL.TRIANGLES, 0, 0, 1, 0);
    assert.deepEqual(firsts(gl).slice(5), [[0, 0]], 'no more than the most');
    gl.glMultiDrawArraysIndirectCount(GL.TRIANGLES, 0, 2, 3, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a count offset not of whole words');
    gl.glMultiDrawArraysIndirectCount(GL.TRIANGLES, 0, 8, 3, 0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a count past the store');

    const indices = gl.glGenBuffersARB(1)[0];
    gl.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, indices);
    gl.glBufferDataARB(GL.ELEMENT_ARRAY_BUFFER, 6,
        new Uint8Array(new Uint16Array([4, 5, 0]).buffer), GL.STATIC_DRAW);
    bufferOf(gl, GL.DRAW_INDIRECT_BUFFER, [3, 1, 0, 0, 0, 3, 1, 0, 1, 0]);
    const before = gl.submittedPrimitives.length;
    gl.glMultiDrawElementsIndirectCount(GL.TRIANGLES, GL.UNSIGNED_SHORT, 0, 4, 5, 0);
    assert.deepEqual(firsts(gl).slice(before), [[4, 0], [5, 0]]);
});

test('an indirect draw is made at once while a list is compiled', ()=>{
    const f = fixture();
    const { gl } = f;
    arrays(f);
    gl.glVertexAttribDivisor(3, 0);
    bufferOf(gl, GL.DRAW_INDIRECT_BUFFER, [3, 1, 0, 0]);
    const list = gl.glGenLists(1);
    gl.glNewList(list, GL.COMPILE);
    gl.glDrawArraysIndirect(GL.TRIANGLES, 0);
    gl.glEndList();
    assert.equal(gl.submittedPrimitives.length, 1);
    gl.glCallList(list);
    assert.equal(gl.submittedPrimitives.length, 1, 'the list holds nothing of it');
});
