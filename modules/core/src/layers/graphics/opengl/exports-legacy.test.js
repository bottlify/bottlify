/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `exports-legacy.js`: the stipple's, the pixel maps' and the evaluators'
 * entry points as a 32-bit caller pushes their arguments.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpengl } from './exports.js';
import { GL } from './constants.js';
import { LEGACY } from './legacy-state.js';

/** @param {number} value */
function floatBits(value){
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
}

/** @param {number} value @returns {[number, number]} */
function doubleBits(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
}

/** A library with a context current over a 4 by 4 window, and its memory. */
function library(){
    const bytes = new Uint8Array(0x10000);
    let next = 0x8000;
    const opengl = createOpengl({
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
            bytes.set(value, at),
        screen: ()=>({ width: 4, height: 4 }),
        scratch: { allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += size + 16 & ~15;
            return at;
        } },
    });
    /** @type {Record<string, { handler: (args: number[]) => number }>} */
    const table = /** @type {any} */ (opengl.table);
    const hdc = 0x900d;
    table.wglSetPixelFormat.handler([hdc, 1, 0]);
    table.wglMakeCurrent.handler([hdc, table.wglCreateContext.handler([hdc])]);
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>table[name].handler(args);
    return { bytes, view: new DataView(bytes.buffer), call };
}

test('glMap1d reads its points at the stride given, not a point after another', ()=>{
    const { view, call } = library();
    // Two points of three doubles, five doubles apart; the gap holds noise.
    [1, 2, 3, 99, 99, 4, 5, 6].forEach((value, k)=>view.setFloat64(0x100 + k * 8, value, true));
    call('glMap1d', [LEGACY.MAP1_VERTEX_3, ...doubleBits(0), ...doubleBits(1), 5, 2, 0x100]);
    call('glGetMapdv', [LEGACY.MAP1_VERTEX_3, LEGACY.COEFF, 0x400]);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(k=>view.getFloat64(0x400 + k * 8, true)),
        [1, 2, 3, 4, 5, 6]);
    assert.equal(call('glGetError', []), GL.NO_ERROR);

    call('glGetnMapfv', [LEGACY.MAP1_VERTEX_3, LEGACY.COEFF, 23, 0x500]);
    assert.equal(call('glGetError', []), GL.INVALID_OPERATION, 'six floats are 24 bytes');
    call('glGetnMapiv', [LEGACY.MAP1_VERTEX_3, LEGACY.DOMAIN, 8, 0x500]);
    assert.deepEqual([view.getInt32(0x500, true), view.getInt32(0x504, true)], [0, 1]);
});

test('glMap2f takes u as its outer index, each at its own stride', ()=>{
    const { view, call } = library();
    // A 2 by 2 net of one-coordinate points: u stride 4 floats, v stride 1.
    [10, 11, 0, 0, 20, 21].forEach((value, k)=>view.setFloat32(0x100 + k * 4, value, true));
    call('glMap2f', [LEGACY.MAP1_TEXTURE_COORD_1 + LEGACY.MAP2, floatBits(0), floatBits(1), 4,
        2, floatBits(0), floatBits(1), 1, 2, 0x100]);
    call('glGetMapfv', [LEGACY.MAP1_TEXTURE_COORD_1 + LEGACY.MAP2, LEGACY.COEFF, 0x400]);
    assert.deepEqual([0, 1, 2, 3].map(k=>view.getFloat32(0x400 + k * 4, true)),
        [10, 11, 20, 21]);
    call('glGetMapiv', [LEGACY.MAP1_TEXTURE_COORD_1 + LEGACY.MAP2, LEGACY.ORDER, 0x400]);
    assert.deepEqual([view.getInt32(0x400, true), view.getInt32(0x404, true)], [2, 2]);
});

test('the stipple, pixel transfer and the maps through their entry points', ()=>{
    const { bytes, view, call } = library();
    bytes.fill(0xf0, 0x100, 0x180);
    call('glPolygonStipple', [0x100]);
    call('glGetnPolygonStipple', [127, 0x200]);
    assert.equal(call('glGetError', []), GL.INVALID_OPERATION);
    call('glGetnPolygonStipple', [128, 0x200]);
    assert.deepEqual(bytes.slice(0x200, 0x280), bytes.slice(0x100, 0x180));

    call('glPixelTransferi', [LEGACY.INDEX_OFFSET, -3]);
    call('glPixelTransferf', [LEGACY.ALPHA_SCALE, floatBits(0.25)]);
    call('glGetIntegerv', [LEGACY.INDEX_OFFSET, 0x300]);
    call('glGetFloatv', [LEGACY.ALPHA_SCALE, 0x304]);
    assert.deepEqual([view.getInt32(0x300, true), view.getFloat32(0x304, true)], [-3, 0.25]);

    view.setUint16(0x100, 0xffff, true);
    view.setUint16(0x102, 0, true);
    call('glPixelMapusv', [LEGACY.PIXEL_MAP_A_TO_A, 2, 0x100]);
    call('glGetnPixelMapfv', [LEGACY.PIXEL_MAP_A_TO_A, 8, 0x400]);
    assert.deepEqual([view.getFloat32(0x400, true), view.getFloat32(0x404, true)], [1, 0]);
    call('glGetnPixelMapuiv', [LEGACY.PIXEL_MAP_A_TO_A, 7, 0x400]);
    assert.equal(call('glGetError', []), GL.INVALID_OPERATION);
});

test('the evaluation calls reach the context, and the imaging getters refuse', ()=>{
    const { view, call } = library();
    view.setFloat32(0x100, 0.5, true);
    view.setFloat32(0x104, 0.25, true);
    call('glMapGrid2d', [3, ...doubleBits(0), ...doubleBits(1), 2, ...doubleBits(-1),
        ...doubleBits(1)]);
    call('glGetDoublev', [LEGACY.MAP2_GRID_DOMAIN, 0x400]);
    assert.deepEqual([0, 1, 2, 3].map(k=>view.getFloat64(0x400 + k * 8, true)), [0, 1, -1, 1]);
    call('glEvalCoord2fv', [0x100]);
    call('glEvalMesh2', [GL.FILL, 0, 3, 0, 2]);
    call('glEvalPoint2', [1, 1]);
    assert.equal(call('glGetError', []), GL.NO_ERROR);
    call('glEvalMesh1', [GL.FILL, 0, 1]);
    assert.equal(call('glGetError', []), GL.INVALID_ENUM, 'a curve is no filled mesh');

    call('glGetnColorTable', [GL.TEXTURE_2D, GL.RGBA, GL.UNSIGNED_BYTE, 16, 0x400]);
    assert.equal(call('glGetError', []), GL.INVALID_ENUM);
    call('glGetnMinmax', [0x802e, 0, GL.RGBA, GL.UNSIGNED_BYTE, 16, 0x400]);
    assert.equal(call('glGetError', []), GL.INVALID_ENUM, 'GL_MINMAX is the subset\'s');
});
