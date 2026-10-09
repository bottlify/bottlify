/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeshFunctions } from './mesh.js';

const D3DERR_INVALIDCALL = 0x8876086c;
const VERTICES = 0x100;
const OUT = 0x800;
const OUT2 = 0x900;

/** Flat guest memory and the mesh functions over it. */
function flat(){
    const memory = new Uint8Array(0x10000);
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
    };
    /** @param {number} at @param {number[]} values */
    const putFloats = (at, values)=>new Float32Array(memory.buffer, at, values.length)
        .set(values);
    /** @param {number} at @param {number} count */
    const floats = (at, count)=>[...new Float32Array(memory.buffer.slice(at, at + count * 4))];
    return { api: /** @type {any} */ (createMeshFunctions(host)), memory, putFloats, floats };
}

/**
 * Positions written `stride` bytes apart, with something else between them
 * that must not be read as a position.
 *
 * @param {ReturnType<typeof flat>} m @param {number[][]} positions @param {number} stride
 */
function place(m, positions, stride){
    positions.forEach((p, i)=>{
        m.putFloats(VERTICES + i * stride, p);
        if (stride >= 16)
        {
            m.putFloats(VERTICES + i * stride + 12, [1e9]);
        }
    });
}

const POSITIONS = [[1, -2, 3], [-4, 5, 0.5], [2, 2, -6], [0, 0, 0]];

test('D3DXComputeBoundingBox takes the extremes of each axis over the strided run', ()=>{
    const m = flat();
    place(m, POSITIONS, 24);
    assert.equal(m.api.D3DXComputeBoundingBox.argBytes, 20);
    assert.equal(m.api.D3DXComputeBoundingBox.handler([VERTICES, 4, 24, OUT, OUT2]), 0);
    assert.deepEqual(m.floats(OUT, 3), [-4, -2, -6]);
    assert.deepEqual(m.floats(OUT2, 3), [2, 5, 3]);
    // One vertex: both corners on it.
    assert.equal(m.api.D3DXComputeBoundingBox.handler([VERTICES, 1, 24, OUT, OUT2]), 0);
    assert.deepEqual([m.floats(OUT, 3), m.floats(OUT2, 3)], [[1, -2, 3], [1, -2, 3]]);
});

test('D3DXComputeBoundingSphere is centred on the mean, out to the farthest position', ()=>{
    const m = flat();
    place(m, [[0, 0, 0], [2, 0, 0], [0, 4, 0], [2, 4, 0]], 12);
    assert.equal(m.api.D3DXComputeBoundingSphere.argBytes, 20);
    assert.equal(m.api.D3DXComputeBoundingSphere.handler([VERTICES, 4, 12, OUT, OUT2]), 0);
    assert.deepEqual(m.floats(OUT, 3), [1, 2, 0]);
    assert.deepEqual(m.floats(OUT2, 1), [Math.fround(Math.sqrt(5))]);
    // Not the smallest sphere: a far-off point drags the mean, not just the radius.
    const n = flat();
    place(n, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [8, 0, 0]], 16);
    n.api.D3DXComputeBoundingSphere.handler([VERTICES, 4, 16, OUT, OUT2]);
    assert.deepEqual(n.floats(OUT, 3), [2, 0, 0]);
    assert.deepEqual(n.floats(OUT2, 1), [6]);
});

test('the bounds refuse a null position, corner, centre or radius pointer', ()=>{
    const m = flat();
    place(m, POSITIONS, 12);
    for (const name of ['D3DXComputeBoundingBox', 'D3DXComputeBoundingSphere'])
    {
        for (const args of [[0, 4, 12, OUT, OUT2], [VERTICES, 4, 12, 0, OUT2],
            [VERTICES, 4, 12, OUT, 0]])
        {
            assert.equal(m.api[name].handler(args), D3DERR_INVALIDCALL, `${name} ${args}`);
        }
    }
});
