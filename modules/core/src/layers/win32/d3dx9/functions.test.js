/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD3dxFunctions } from './functions.js';
import { COMPILED } from './inguest.x86.js';

const E_NOTIMPL = 0x80004001;

function machine(){
    const memory = new Uint8Array(0x1000);
    const fns = createD3dxFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    /** @param {number} address @param {number[]} values */
    const putFloats = (address, values)=>
        new Float32Array(memory.buffer, address, values.length).set(values);
    /** @param {number} address @param {number} count */
    const getFloats = (address, count)=>
        [...new Float32Array(memory.buffer.slice(address, address + count * 4))];
    /** Expected values, rounded to the single precision the store keeps. */
    const f32 = (/** @type {number[]} */ values)=>[...Float32Array.from(values)];
    /** @param {number} value  A FLOAT argument, as the raw dword the bridge reads. */
    const asArg = value=>{
        const view = new DataView(new ArrayBuffer(4));
        view.setFloat32(0, value, true);
        return view.getUint32(0, true);
    };
    return { fns: /** @type {any} */ (fns), putFloats, getFloats, asArg, f32 };
}

const OUT = 0x100;
const A = 0x200;
const B = 0x300;

test('the maths functions declare the stdcall bytes they pop -- the whole point of the file', ()=>{
    const { fns } = machine();
    const expected = {
        D3DXMatrixMultiply: 12, D3DXMatrixTranspose: 8, D3DXMatrixInverse: 12,
        D3DXMatrixTranslation: 16, D3DXMatrixOrthoLH: 20, D3DXMatrixPerspectiveLH: 20,
        D3DXVec4Transform: 12, D3DXVec3Transform: 12, D3DXVec3TransformNormal: 12,
        D3DXVec3TransformCoord: 12, D3DXVec3TransformCoordArray: 24, D3DXVec3Normalize: 8,
        D3DXCreateEffectPool: 4, D3DXCreateEffectFromResourceA: 36,
    };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fns[name].argBytes, argBytes, name);
    }
});

test('a transpose swaps rows and columns and answers the output pointer', ()=>{
    const { fns, putFloats, getFloats } = machine();
    putFloats(A, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.equal(fns.D3DXMatrixTranspose.handler([OUT, A]), OUT);
    assert.deepEqual(getFloats(OUT, 16), [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]);
});

test('multiplying by the identity is the matrix itself', ()=>{
    const { fns, putFloats, getFloats } = machine();
    const m = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    putFloats(A, m);
    putFloats(B, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    fns.D3DXMatrixMultiply.handler([OUT, A, B]);
    assert.deepEqual(getFloats(OUT, 16), m);
});

test('a translation carries a point, and its inverse carries it back', ()=>{
    const { fns, putFloats, getFloats, asArg } = machine();
    fns.D3DXMatrixTranslation.handler([A, asArg(10), asArg(-5), asArg(3)]);
    // v * T moves the point by the translation row.
    putFloats(B, [1, 2, 3, 1]);
    fns.D3DXVec4Transform.handler([OUT, B, A]);
    assert.deepEqual(getFloats(OUT, 4), [11, -3, 6, 1]);

    const determinant = 0x40;
    assert.equal(fns.D3DXMatrixInverse.handler([0x400, determinant, A]), 0x400);
    fns.D3DXVec4Transform.handler([OUT, OUT, 0x400]);
    assert.deepEqual(getFloats(OUT, 4), [1, 2, 3, 1], 'through the inverse, back to the start');
});

test('a singular matrix inverts to NULL and its determinant is zero', ()=>{
    const { fns, putFloats, getFloats } = machine();
    putFloats(A, new Array(16).fill(0));
    assert.equal(fns.D3DXMatrixInverse.handler([OUT, 0x40, A]), 0);
    assert.deepEqual(getFloats(0x40, 1), [0]);
});

test('normalising makes a unit vector and leaves a zero vector zero', ()=>{
    const { fns, putFloats, getFloats, f32 } = machine();
    putFloats(A, [0, 3, 4]);
    fns.D3DXVec3Normalize.handler([OUT, A]);
    assert.deepEqual(getFloats(OUT, 3), f32([0, 0.6, 0.8]));
    putFloats(A, [0, 0, 0]);
    fns.D3DXVec3Normalize.handler([OUT, A]);
    assert.deepEqual(getFloats(OUT, 3), [0, 0, 0]);
});

test('a normal ignores translation where a coordinate does not', ()=>{
    const { fns, putFloats, getFloats, asArg } = machine();
    fns.D3DXMatrixTranslation.handler([A, asArg(10), asArg(0), asArg(0)]);
    putFloats(B, [1, 0, 0]);
    fns.D3DXVec3TransformNormal.handler([OUT, B, A]);
    assert.deepEqual(getFloats(OUT, 3), [1, 0, 0], 'a normal is unmoved by a translation');
});

test('the effect facilities report E_NOTIMPL and leave a null pointer behind', ()=>{
    const { fns, getFloats } = machine();
    assert.equal(fns.D3DXCreateEffectPool.handler([OUT]) >>> 0, E_NOTIMPL);
    assert.deepEqual(getFloats(OUT, 1), [0]);
    assert.equal(fns.D3DXCreateEffectFromResourceA.handler([0, 0, 0, 0, 0, 0, 0, OUT, 0]) >>> 0,
        E_NOTIMPL);
    assert.deepEqual(getFloats(OUT, 1), [0]);
});

test('the arithmetic is code in the guest, stdcall, its handler the same JavaScript', ()=>{
    const { fns } = machine();
    for (const name of Object.keys(COMPILED))
    {
        assert.equal(fns[name].convention, 'stdcall', name);
        assert.deepEqual(fns[name].code(), COMPILED[/** @type {keyof typeof COMPILED} */ (name)]
            .code, name);
    }
});

test('a normal takes no part of the translation row, whatever it holds', ()=>{
    const { fns, putFloats, getFloats } = machine();
    putFloats(A, [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, Infinity, NaN, -Infinity, 1]);
    putFloats(B, [1, 1, 1]);
    fns.D3DXVec3TransformNormal.handler([OUT, B, A]);
    assert.deepEqual(getFloats(OUT, 3), [2, 3, 4]);
});

test('a point transformed to a w of zero is divided by one', ()=>{
    const { fns, putFloats, getFloats } = machine();
    putFloats(A, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 0]);
    putFloats(B, [1, 2, 3]);
    fns.D3DXVec3TransformCoord.handler([OUT, B, A]);
    assert.deepEqual(getFloats(OUT, 3), [6, 8, 10]);
});
