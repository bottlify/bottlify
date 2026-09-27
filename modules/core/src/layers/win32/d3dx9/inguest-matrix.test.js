/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's matrix builders answer the same as their x86, input by input, on
 * cork's test machine (`scripts/guest-code/equivalence.mjs`): random floats
 * of every size, angles past the x87's reduction, zero vectors and planes,
 * NULL for every pointer that may be one, an output over its inputs -- under
 * three control words, and under single precision against the x87's model
 * of the source.
 */

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest-matrix.x86.js';
import * as sources from './inguest-matrix.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest-matrix.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-matrix.js', url: SOURCE.href, values: sources,
});
const { same } = equivalence(COMPILED, sources, model);

/** Double, single, and a rounding toward zero, which the float stores keep to nearest. */
const CONTROLS = [0x27f, 0x07f, 0xf7f];

/** Where the inputs go, and the output. */
const A = DATA;
const B = DATA + 0x100;
const C = DATA + 0x200;
const D = DATA + 0x300;
const E = DATA + 0x400;
const F = DATA + 0x500;
const OUT = DATA + 0x600;

/**
 * Floats a program's matrices and vectors hold: of every size but no
 * infinity or NaN (a NaN's payload is not JavaScript's to keep), zeros and
 * ones among them.
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

/**
 * An angle: small, a turn or two, or anywhere a float reaches -- past 2^63
 * the source reduces it by 2π itself.
 *
 * @param {() => number} next
 */
const angleOf = next=>{
    const pick = next() % 4;
    return pick === 0 ? floats(next, 1)[0] : pick === 1 ? Math.fround(((next() % 20000) - 10000)
        / 1000) : pick === 2 ? Math.fround(2 ** (60 + next() % 60) * (next() % 2 ? 1 : -1))
        : Math.fround((next() % 628) / 100);
};

/** @param {() => number} next @param {number} count */
const memoryOf = (next, count)=>/** @type {[number, ArrayLike<number>][]} */ (
    [A, B, C, D, E, F].slice(0, count).map(at=>[at, bytesOf(floats(next, 16))]));

test('determinant, transposed product, scaling and the rotations about an axis', ()=>{
    const next = random(11);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 16; i++)
        {
            const memory = memoryOf(next, 3);
            if (i === 0)
            {
                // A zero axis: the rotation about it is the identity's cosine and sine terms.
                memory.push([C, bytesOf([0, 0, 0])]);
            }
            same('D3DXMatrixDeterminant', { stack: [A], memory, control });
            for (const out of [OUT, A, B, A + 4])
            {
                same('D3DXMatrixMultiplyTranspose', { stack: [out, A, B], memory, control });
                same('D3DXMatrixRotationAxis', { stack: [out, C, floatArg(angleOf(next))], memory,
                    control });
                same('D3DXMatrixRotationQuaternion', { stack: [out, C], memory, control });
            }
            const [x, y, z] = floats(next, 3).map(floatArg);
            same('D3DXMatrixScaling', { stack: [OUT, x, y, z], control });
            for (const name of ['D3DXMatrixRotationX', 'D3DXMatrixRotationY',
                'D3DXMatrixRotationZ'])
            {
                same(name, { stack: [OUT, floatArg(angleOf(next))], control });
            }
            same('D3DXMatrixRotationYawPitchRoll', { stack: [OUT, floatArg(angleOf(next)),
                floatArg(angleOf(next)), floatArg(angleOf(next))], control });
        }
    }
});

test('look-at, perspective and orthographic matrices', ()=>{
    const next = random(12);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 24; i++)
        {
            const memory = memoryOf(next, 3);
            if (i === 1)
            {
                // The eye on the point looked at, and an up along the view.
                memory.push([B, bytesOf(floats(next, 3))]);
                memory.push([A, Array.from(memory[memory.length - 1][1])]);
            }
            for (const out of [OUT, A, B, C])
            {
                same('D3DXMatrixLookAtLH', { stack: [out, A, B, C], memory, control });
                same('D3DXMatrixLookAtRH', { stack: [out, A, B, C], memory, control });
            }
            const args = floats(next, 6);
            if (i % 5 === 0)
            {
                args[5] = args[4];
            }
            const words = args.map(floatArg);
            const fov = floatArg(i % 3 === 0 ? angleOf(next) : Math.fround((next() % 300) / 100));
            for (const name of ['D3DXMatrixPerspectiveFovLH', 'D3DXMatrixPerspectiveFovRH'])
            {
                same(name, { stack: [OUT, fov, ...words.slice(1, 4)], control });
            }
            same('D3DXMatrixPerspectiveRH', { stack: [OUT, ...words.slice(0, 4)], control });
            same('D3DXMatrixOrthoRH', { stack: [OUT, ...words.slice(0, 4)], control });
            for (const name of ['D3DXMatrixPerspectiveOffCenterLH',
                'D3DXMatrixPerspectiveOffCenterRH', 'D3DXMatrixOrthoOffCenterLH',
                'D3DXMatrixOrthoOffCenterRH'])
            {
                same(name, { stack: [OUT, ...words], control });
            }
        }
    }
});

test('reflection and shadow in a plane, a zero plane among them', ()=>{
    const next = random(13);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 20; i++)
        {
            const memory = memoryOf(next, 2);
            if (i === 0)
            {
                memory.push([B, bytesOf([0, 0, 0, floats(next, 1)[0]])]);
            }
            for (const out of [OUT, A, B])
            {
                same('D3DXMatrixReflect', { stack: [out, B], memory, control });
                same('D3DXMatrixShadow', { stack: [out, A, B], memory, control });
            }
        }
    }
});

test('the affine and full transformations, every pointer NULL or not', ()=>{
    const next = random(14);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 4; i++)
        {
            const memory = memoryOf(next, 6);
            const scaling = floatArg(floats(next, 1)[0]);
            for (let mask = 0; mask < 64; mask++)
            {
                const [sc, sr, s, rc, r, t] = [A, B, C, D, E, F].map((at, k)=>
                    ((mask & 1 << k) !== 0 ? at : 0));
                same('D3DXMatrixTransformation', { stack: [mask % 3 === 0 ? OUT : A, sc, sr, s,
                    rc, r, t], memory, control });
                if (mask < 8)
                {
                    same('D3DXMatrixAffineTransformation', { stack: [mask % 2 === 0 ? OUT : B,
                        scaling, rc, r, t], memory, control });
                }
                if (mask < 16)
                {
                    const [sc2, s2, rc2, t2] = [A, C, D, F].map((at, k)=>
                        ((mask & 1 << k) !== 0 ? at : 0));
                    same('D3DXMatrixTransformation2D', { stack: [mask % 3 === 0 ? OUT : C, sc2,
                        floatArg(angleOf(next)), s2, rc2, floatArg(angleOf(next)), t2], memory,
                    control });
                    same('D3DXMatrixAffineTransformation2D', { stack: [OUT, scaling, mask & 1 ? A
                        : 0, floatArg(angleOf(next)), mask & 2 ? F : 0], memory, control });
                }
            }
        }
    }
});

test('decomposition: scales, rotations of each case, a zero row, outputs over the matrix', ()=>{
    const next = random(15);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 40; i++)
        {
            const m = floats(next, 16);
            if (i % 8 === 1)
            {
                m[4 * (i % 3)] = 0;
                m[4 * (i % 3) + 1] = 0;
                m[4 * (i % 3) + 2] = 0;
            }
            if (i % 8 === 2)
            {
                // A rotation scaled: each branch of the quaternion's by the diagonal.
                const turned = [[1, 0, 0], [0, -1, 0], [0, 0, -1]][i % 3];
                m.splice(0, 12, turned[0] * 3, 0.5, 0, 0, 0.25, turned[1] * 2, 0, 0, 0, 0,
                    turned[2] * 5, 0);
            }
            const memory = /** @type {[number, ArrayLike<number>][]} */ ([[A, bytesOf(m)]]);
            same('D3DXMatrixDecompose', { stack: [OUT, OUT + 16, OUT + 32, A], memory, control });
            same('D3DXMatrixDecompose', { stack: [A + 12, A + 32, A, A], memory, control });
        }
    }
});
