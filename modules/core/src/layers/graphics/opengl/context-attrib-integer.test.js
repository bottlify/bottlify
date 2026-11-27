/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createOpengl } from './exports.js';

/** @returns {any} */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 8, height: 4, doubleBuffered: true });
    return context;
}

test('glVertexAttribIPointer takes integer types alone, and the array says it is read as '
    + 'integers until glVertexAttribPointer sets it again', ()=>{
    const gl = fixture();
    gl.glVertexAttribIPointer(3, 2, GL.FLOAT, 0, 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glVertexAttribIPointer(16, 2, GL.INT, 0, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glVertexAttribIPointer(3, 5, GL.INT, 0, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glVertexAttribIPointer(3, 3, GL.UNSIGNED_SHORT, 12, 0x40);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    /** @param {number} pname */
    const ask = pname=>gl.glGetVertexAttribfvARB(3, pname)[0];
    assert.equal(ask(GL.VERTEX_ATTRIB_ARRAY_INTEGER), 1);
    assert.equal(ask(GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB), 3);
    assert.equal(ask(GL.VERTEX_ATTRIB_ARRAY_TYPE_ARB), GL.UNSIGNED_SHORT);
    assert.equal(ask(GL.VERTEX_ATTRIB_ARRAY_NORMALIZED_ARB), 0);
    assert.equal(ask(GL.VERTEX_ATTRIB_ARRAY_STRIDE_ARB), 12);
    gl.glVertexAttribPointerARB(3, 3, GL.UNSIGNED_SHORT, 1, 12, 0x40);
    assert.equal(ask(GL.VERTEX_ATTRIB_ARRAY_INTEGER), 0);
});

test('an integer current value is kept as the integers given, and answered as them', ()=>{
    const gl = fixture();
    gl.vertexAttribI(5, 'uint', -1, 2, 3, 4);
    assert.deepEqual(gl.getVertexAttribI(5, GL.CURRENT_VERTEX_ATTRIB_ARB, 'uint'),
        [0xffffffff, 2, 3, 4]);
    gl.vertexAttribI(5, 'int', -7, 2.9, 3, 4);
    assert.deepEqual(gl.getVertexAttribI(5, GL.CURRENT_VERTEX_ATTRIB_ARB, 'int'), [-7, 2, 3, 4]);
    assert.deepEqual(gl.glGetVertexAttribfvARB(5, GL.CURRENT_VERTEX_ATTRIB_ARB), [-7, 2, 3, 4],
        'kept as integers, whatever reads it');
    gl.vertexAttribI(16, 'int', 0, 0, 0, 1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glBegin(GL.POINTS);
    gl.vertexAttribI(5, 'int', 1, 1, 1, 1);
    gl.glEnd();
    assert.equal(gl.glGetError(), GL.NO_ERROR,
        'a current value may be set between glBegin and glEnd');
});

test('the integer attribute forms fill what they lack with (0, 0, 1), and read their arrays as '
    + 'their types', ()=>{
    const bytes = new Uint8Array(0x1000);
    const opengl = createOpengl({
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
        screen: ()=>({ width: 4, height: 4 }),
        scratch: { allocate: ()=>0x800 },
        describeDrawable: (/** @type {number} */ hdc)=>({ key: `dc:${hdc}`, width: 4, height: 4 }),
    });
    const table = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        opengl.table);
    assert.equal(table.wglSetPixelFormat.handler([0x900d, 1, 0]), 1);
    assert.equal(table.wglMakeCurrent.handler([0x900d, table.wglCreateContext.handler([0x900d])]),
        1);
    /** @param {number} index */
    const current = index=>opengl.withContext((/** @type {any} */ context)=>
        context.getVertexAttribI(index, GL.CURRENT_VERTEX_ATTRIB_ARB, 'int'));
    table.glVertexAttribI2ui.handler([1, 9, 8]);
    assert.deepEqual(current(1), [9, 8, 0, 1]);
    bytes.set([0xff, 2, 3, 4], 0x100);
    table.glVertexAttribI4bv.handler([2, 0x100]);
    assert.deepEqual(current(2), [-1, 2, 3, 4], 'signed bytes');
    table.glVertexAttribI4ubv.handler([2, 0x100]);
    assert.deepEqual(current(2), [255, 2, 3, 4], 'unsigned bytes');
    new DataView(bytes.buffer).setInt32(0x200, -5, true);
    table.glVertexAttribI1iv.handler([3, 0x200]);
    assert.deepEqual(current(3), [-5, 0, 0, 1]);
    table.glGetVertexAttribIuiv.handler([2, GL.CURRENT_VERTEX_ATTRIB_ARB, 0x300]);
    assert.deepEqual([...new Uint32Array(bytes.buffer, 0x300, 4)], [255, 2, 3, 4]);
});
