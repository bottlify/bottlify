/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's matrices and vectors answer the same as their x86, input by input,
 * on cork's test machine (`scripts/guest-code/equivalence.mjs`): random
 * floats of every size, the identity, a singular matrix, an output over its
 * inputs whole and in part, a null determinant, strides -- under three
 * control words, and under single precision against the x87's model of the
 * source, each float's product and sum rounded to 24 bits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest.js', url: SOURCE.href, values: sources,
});
const { same } = equivalence(COMPILED, sources, model);

/** Double, single, and a rounding toward zero, which the float stores keep to nearest. */
const CONTROLS = [0x27f, 0x07f, 0xf7f];

/** Where the matrices and vectors go: A, B, the output, a determinant. */
const A = DATA;
const B = DATA + 0x100;
const OUT = DATA + 0x200;
const DET = DATA + 0x300;

/**
 * Floats a program's matrices hold: of every size but no infinity or NaN
 * (a NaN's payload is not JavaScript's to keep), zeros and ones among them.
 *
 * @param {() => number} next @param {number} count
 */
function floats(next, count){
    const view = new DataView(new ArrayBuffer(4));
    return Array.from({ length: count }, ()=>{
        const pick = next() % 8;
        if (pick === 0)
        {
            return next() % 3 - 1;
        }
        if (pick < 4)
        {
            return (next() % 2000 - 1000) / 64;
        }
        const bits = next();
        view.setUint32(0, (bits & 0x7f800000) === 0x7f800000 ? bits & 0xbfffffff : bits, true);
        const value = view.getFloat32(0, true);
        // Products of floats past 2^60 overflow nothing, but their sums are
        // cancelled away; keep most of them where a matrix's are.
        return pick === 7 ? value : Math.fround(value % 1e6);
    });
}

/** Floats' bytes. @param {number[]} values */
const bytesOf = values=>new Uint8Array(Float32Array.from(values).buffer);

/** A FLOAT argument, as the dword it is on the stack. @param {number} value */
const floatArg = value=>{
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
};

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('multiply, transpose and inverse: random, the identity, singular, over themselves',
    ()=>{
        const next = random(1);
        for (const control of CONTROLS)
        {
            for (let i = 0; i < 16; i++)
            {
                const a = i === 0 ? IDENTITY : floats(next, 16);
                const b = i === 1 ? IDENTITY : i === 2 ? new Array(16).fill(0) : floats(next, 16);
                const memory = /** @type {[number, ArrayLike<number>][]} */ ([[A, bytesOf(a)],
                    [B, bytesOf(b)]]);
                // Out apart, over the left, over the right, and a float into either.
                for (const out of [OUT, A, B, A + 4, B - 8])
                {
                    same('D3DXMatrixMultiply', { stack: [out, A, B], memory, control });
                    same('D3DXMatrixTranspose', { stack: [out, B], memory, control });
                }
                // A singular one, a null determinant, and the determinant over the matrix.
                const singular = [...a.slice(0, 4), ...a.slice(0, 4), ...a.slice(8)];
                const cases = /** @type {[number[], number][]} */ ([[a, DET], [b, 0],
                    [singular, DET], [a, A + 60]]);
                for (const [m, det] of cases)
                {
                    same('D3DXMatrixInverse', { stack: [OUT, det, A],
                        memory: [[A, bytesOf(m)]], control });
                }
            }
        }
    });

test('a flexible vertex format: its position, the optional parts, and texture sets', ()=>{
    // XYZ | NORMAL | TEX1 is 12 + 12 + 8; texture sets take two, three, four
    // or one float by their two bits, and no more than eight are counted.
    const cases = [[0, 0], [0x002, 12], [0x004, 16], [0x006, 16], [0x008, 20], [0x00e, 32],
        [0x4002, 16], [0x002 | 0x010 | 0x100, 32], [0x004 | 0x040 | 0x080 | 0x200, 40],
        [0x002 | 0x020, 16], [0x002 | 0x300 | 1 << 16 | 2 << 18 | 3 << 20, 44],
        [0x002 | 0xf00, 76]];
    for (const [fvf, size] of cases)
    {
        assert.equal(sources.D3DXGetFVFVertexSize(fvf), size, `0x${fvf.toString(16)}`);
        same('D3DXGetFVFVertexSize', { stack: [fvf] });
    }
    const next = random(9);
    for (let i = 0; i < 200; i++)
    {
        same('D3DXGetFVFVertexSize', { stack: [next()] });
    }
});

test('translation, orthographic and perspective matrices from their float arguments', ()=>{
    const next = random(2);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 30; i++)
        {
            const [w, h, near, far] = floats(next, 4);
            const args = [w, h, near, i % 5 === 0 ? near : far].map(floatArg);
            same('D3DXMatrixTranslation', { stack: [OUT, ...args.slice(0, 3)], control });
            same('D3DXMatrixOrthoLH', { stack: [OUT, ...args], control });
            same('D3DXMatrixPerspectiveLH', { stack: [OUT, ...args], control });
        }
    }
});

test('vectors transformed, the output over the vector, and normalised', ()=>{
    const next = random(3);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 24; i++)
        {
            const m = i === 0 ? IDENTITY : floats(next, 16);
            const v = i === 1 ? [0, 0, 0, 0] : floats(next, 4);
            const memory = /** @type {[number, ArrayLike<number>][]} */ ([[A, bytesOf(m)],
                [B, bytesOf(v)]]);
            for (const out of [OUT, B])
            {
                same('D3DXVec4Transform', { stack: [out, B, A], memory, control });
                same('D3DXVec3Transform', { stack: [out, B, A], memory, control });
                same('D3DXVec3TransformNormal', { stack: [out, B, A], memory, control });
                same('D3DXVec3TransformCoord', { stack: [out, B, A], memory, control });
                same('D3DXVec3Normalize', { stack: [out, B], memory, control });
            }
        }
    }
});

test('an array of points: strides, none, and the matrix read once', ()=>{
    const next = random(4);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 12; i++)
        {
            const m = floats(next, 16);
            if (i % 3 === 0)
            {
                // A w of zero for every point: divided by one.
                m[3] = 0;
                m[7] = 0;
                m[11] = 0;
                m[15] = 0;
            }
            const points = floats(next, 48);
            const memory = /** @type {[number, ArrayLike<number>][]} */ ([[A, bytesOf(m)],
                [B, bytesOf(points)]]);
            for (const [outStride, inStride, count] of [[12, 12, 8], [16, 12, 5], [12, 16, 6],
                [12, 12, 0], [0, 12, 3]])
            {
                same('D3DXVec3TransformCoordArray',
                    { stack: [OUT, outStride, B, inStride, A, count], memory, control });
            }
            // The points written over the matrix they are transformed by.
            same('D3DXVec3TransformCoordArray', { stack: [A, 12, B, 12, A, 4], memory, control });
        }
    }
});
