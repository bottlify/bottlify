/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The packed attribute types (OpenGL 3.3, GL_ARB_vertex_type_2_10_10_10_rev):
 * the word's unpacking, the arrays that take it, and the immediate forms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { unpackWord } from './arrays.js';
import { planLayout } from './gpu-layout.js';

/** x, y, z in ten bits each from the low end, w in the top two. */
const word = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z,
    /** @type {number} */ w)=>((w & 3) << 30 | (z & 0x3ff) << 20 | (y & 0x3ff) << 10 | x & 0x3ff)
    >>> 0;

test('a packed word unpacks into its four components, signed and normalised as asked', ()=>{
    const packed = word(1023, 0, 512, 3);
    assert.deepEqual(unpackWord(packed, GL.UNSIGNED_INT_2_10_10_10_REV, false), [1023, 0, 512, 3]);
    assert.deepEqual(unpackWord(packed, GL.UNSIGNED_INT_2_10_10_10_REV, true),
        [1, 0, 512 / 1023, 1]);
    assert.deepEqual(unpackWord(packed, GL.INT_2_10_10_10_REV, false), [-1, 0, -512, -1],
        'the top bit of each field is its sign');
    assert.deepEqual(unpackWord(word(511, -512 & 0x3ff, 0, 1), GL.INT_2_10_10_10_REV, true),
        [1, -1, 1 / 1023, 1], '(2c + 1) / (2^b - 1), as the other signed types');
    // The one packed vertex format WebGPU reads.
    assert.equal(planLayout([{ name: 'color', normalised: true, pointer: { size: 4,
        type: GL.UNSIGNED_INT_2_10_10_10_REV, stride: 4, pointer: 0, buffer: 1 } }])
        ?.attributes[0].format, 'unorm10-10-10-2');
    assert.equal(planLayout([{ name: 'color', normalised: true, pointer: { size: 4,
        type: GL.INT_2_10_10_10_REV, stride: 4, pointer: 0, buffer: 1 } }]), null,
    'a signed one is read on the processor');
    assert.equal(planLayout([{ name: 'texCoord0', normalised: false, pointer: { size: 4,
        type: GL.UNSIGNED_INT_2_10_10_10_REV, stride: 4, pointer: 0, buffer: 1 } }]), null,
    'as is one read as integers');
});

test('packed arrays take four components, and draw what their words hold', ()=>{
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    const gl = /** @type {any} */ (createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
    }, keepPrimitives: true }));
    gl.attach({ width: 8, height: 8, doubleBuffered: false });
    gl.glColorPointer(3, GL.UNSIGNED_INT_2_10_10_10_REV, 0, 0x100);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'three components of a packed word');
    gl.glVertexAttribPointerARB(2, 2, GL.INT_2_10_10_10_REV, 0, 0, 0x100);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    [0, 1, 2].forEach(k=>{
        view.setUint32(0x100 + k * 4, word(k * 100, 1, 2, 0), true);
        view.setUint32(0x200 + k * 4, word(1023, 0, 0, 3), true);
    });
    gl.glVertexPointer(4, GL.INT_2_10_10_10_REV, 0, 0x100);
    gl.glColorPointer(4, GL.UNSIGNED_INT_2_10_10_10_REV, 0, 0x200);
    gl.glEnableClientState(GL.VERTEX_ARRAY);
    gl.glEnableClientState(GL.COLOR_ARRAY);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    const [primitive] = gl.submittedPrimitives;
    assert.deepEqual(primitive.vertices.map((/** @type {any} */ v)=>v.position),
        [[0, 1, 2, 0], [100, 1, 2, 0], [200, 1, 2, 0]], 'positions as the integers they are');
    assert.deepEqual(primitive.vertices[0].color, [1, 0, 0, 1], 'colours normalised');
});

test('the immediate packed forms set what their unpacked forms do', ()=>{
    const gl = /** @type {any} */ (createGlContext({}));
    gl.attach({ width: 8, height: 8, doubleBuffered: false });
    gl.packedAttribute('color', 0, GL.UNSIGNED_INT_2_10_10_10_REV, true, 4, word(1023, 0, 0, 0));
    assert.deepEqual(gl.glGetFloatv(GL.CURRENT_COLOR), [1, 0, 0, 0]);
    gl.packedAttribute('color', 0, GL.UNSIGNED_INT_2_10_10_10_REV, true, 3, word(0, 1023, 0, 0));
    assert.deepEqual(gl.glGetFloatv(GL.CURRENT_COLOR), [0, 1, 0, 1], 'three, alpha one');
    gl.packedAttribute('attrib', 3, GL.INT_2_10_10_10_REV, false, 2, word(-5 & 0x3ff, 7, 9, 1));
    assert.deepEqual(gl.glGetVertexAttribfvARB(3, GL.CURRENT_VERTEX_ATTRIB_ARB), [-5, 7, 0, 1]);
    gl.packedAttribute('texCoord', GL.TEXTURE0 + 1, GL.UNSIGNED_INT_2_10_10_10_REV, false, 1,
        word(4, 5, 6, 2));
    gl.glActiveTextureARB(GL.TEXTURE0 + 1);
    assert.deepEqual(gl.glGetFloatv(GL.CURRENT_TEXTURE_COORDS), [4, 0, 0, 1]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.packedAttribute('normal', 0, GL.FLOAT, true, 3, 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'only the packed types');
});
