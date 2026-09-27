/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's quaternions answer the same as their x86, input by input, on
 * cork's test machine (`scripts/guest-code/equivalence.mjs`): unit
 * quaternions and ones of every length, the identity and zero, real parts
 * past 1, opposite and equal pairs for the slerps, NULL outputs of
 * D3DXQuaternionToAxisAngle, outputs over inputs -- under three control
 * words, and under single precision against the x87's model of the source.
 */

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest-quaternion.x86.js';
import * as sources from './inguest-quaternion.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest-quaternion.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-quaternion.js', url: SOURCE.href, values: sources,
});
const { same } = equivalence(COMPILED, sources, model);

/** Double, single, and a rounding toward zero, which the float stores keep to nearest. */
const CONTROLS = [0x27f, 0x07f, 0xf7f];

/** Where the inputs go, and the outputs. */
const A = DATA;
const B = DATA + 0x100;
const C = DATA + 0x200;
const D = DATA + 0x300;
const OUT = DATA + 0x400;

/** A FLOAT argument, as the dword it is on the stack. @param {number} value */
const floatArg = value=>{
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
};

/** Floats' bytes. @param {number[]} values */
const bytesOf = values=>new Uint8Array(Float32Array.from(values).buffer);

/**
 * A quaternion: a unit one mostly, as a program's rotations are, or one of
 * any length up to a few thousand, the identity, or zero.
 *
 * @param {() => number} next
 */
function quaternionOf(next){
    const pick = next() % 8;
    const q = Array.from({ length: 4 }, ()=>((next() % 20001) - 10000) / 1000);
    if (pick === 0)
    {
        return [0, 0, 0, 1];
    }
    if (pick === 1)
    {
        return q.map(v=>v * 300);
    }
    if (pick === 2)
    {
        return q;
    }
    const length = Math.hypot(...q) || 1;
    return q.map(v=>Math.fround(v / length));
}

/**
 * A parameter: a fraction mostly, sometimes past 0 and 1 either way.
 *
 * @param {() => number} next
 */
const fractionOf = next=>Math.fround(next() % 4 === 0 ? ((next() % 4001) - 2000) / 1000
    : (next() % 1001) / 1000);

test('products, inverses, logarithms, exponentials and normals', ()=>{
    const next = random(31);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 40; i++)
        {
            const a = i === 0 ? [0, 0, 0, 0] : quaternionOf(next);
            const b = i === 1 ? [0.5, -0.25, 1, -1] : quaternionOf(next);
            const memory = /** @type {[number, ArrayLike<number>][]} */ ([[A, bytesOf(a)],
                [B, bytesOf(b)]]);
            for (const out of [OUT, A, B])
            {
                same('D3DXQuaternionMultiply', { stack: [out, A, B], memory, control });
                same('D3DXQuaternionNormalize', { stack: [out, A], memory, control });
                same('D3DXQuaternionLn', { stack: [out, A], memory, control });
                same('D3DXQuaternionExp', { stack: [out, B], memory, control });
                if (i !== 0)
                {
                    same('D3DXQuaternionInverse', { stack: [out, A], memory, control });
                }
            }
        }
    }
});

test('rotations from an axis, three angles and a matrix, and back to an axis', ()=>{
    const next = random(32);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 40; i++)
        {
            const axis = i === 0 ? [0, 0, 0] : quaternionOf(next).slice(0, 3);
            const angles = Array.from({ length: 3 }, ()=>(next() % 3 === 0
                ? Math.fround(2 ** (62 + next() % 40)) : Math.fround(((next() % 20001) - 10000)
                / 1000)));
            const m = Array.from({ length: 16 }, ()=>((next() % 2001) - 1000) / 100);
            // Each of the four branches: a positive trace, and each diagonal the largest.
            const branch = i % 4;
            m[0] = branch === 1 ? 30 : branch === 0 ? 10 : -10;
            m[5] = branch === 2 ? 30 : branch === 0 ? 10 : -20;
            m[10] = branch === 3 ? 30 : branch === 0 ? 10 : -25;
            if (i === 4)
            {
                // A diagonal that sums to exactly 0, and equal diagonals.
                m.splice(0, 11, 5, 1, 2, 0, 3, -5, 4, 0, 6, 7, 0);
            }
            const q = quaternionOf(next);
            q[3] = i % 5 === 0 ? 0 : Math.max(-1, Math.min(1, q[3]));
            const memory = /** @type {[number, ArrayLike<number>][]} */ ([[A, bytesOf(axis)],
                [B, bytesOf(m)], [C, bytesOf(q)]]);
            same('D3DXQuaternionRotationAxis', { stack: [OUT, A, floatArg(angles[0])], memory,
                control });
            same('D3DXQuaternionRotationYawPitchRoll', { stack: [OUT, ...angles.map(floatArg)],
                control });
            for (const out of [OUT, B, B + 12])
            {
                same('D3DXQuaternionRotationMatrix', { stack: [out, B], memory, control });
            }
            same('D3DXQuaternionToAxisAngle', { stack: [C, OUT, OUT + 12], memory, control });
            same('D3DXQuaternionToAxisAngle', { stack: [C, 0, OUT + 12], memory, control });
            same('D3DXQuaternionToAxisAngle', { stack: [C, C, 0], memory, control });
            same('D3DXQuaternionToAxisAngle', { stack: [C, OUT, C + 12], memory, control });
        }
    }
});

test('slerp, squad and the barycentric slerp: near, opposite, equal and scaled pairs', ()=>{
    const next = random(33);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 40; i++)
        {
            const q = [quaternionOf(next), quaternionOf(next), quaternionOf(next),
                quaternionOf(next)];
            if (i % 6 === 1)
            {
                q[1] = q[0].slice();
            }
            if (i % 6 === 2)
            {
                q[1] = q[0].map(v=>-v);
            }
            if (i % 6 === 3)
            {
                q[1] = q[0].map((v, k)=>Math.fround(v + (k === 0 ? 1e-4 : 0)));
            }
            const memory = /** @type {[number, ArrayLike<number>][]} */ (q.map((value, k)=>[
                [A, B, C, D][k], bytesOf(value)]));
            const t = floatArg(fractionOf(next));
            const [f, g] = [fractionOf(next), fractionOf(next)];
            for (const out of [OUT, A, B])
            {
                same('D3DXQuaternionSlerp', { stack: [out, A, B, t], memory, control });
                same('D3DXQuaternionSquad', { stack: [out, A, B, C, D, t], memory, control });
                same('D3DXQuaternionBaryCentric', { stack: [out, A, B, C, floatArg(f),
                    floatArg(i % 7 === 0 ? -f : g)], memory, control });
            }
        }
    }
});

test('squad\'s control points, the outputs apart and over the inputs', ()=>{
    const next = random(34);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 30; i++)
        {
            const q = [quaternionOf(next), quaternionOf(next), quaternionOf(next),
                quaternionOf(next)];
            if (i === 0)
            {
                q.splice(0, 4, [-1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [-1, 0, 0, 0]);
            }
            const memory = /** @type {[number, ArrayLike<number>][]} */ (q.map((value, k)=>[
                [A, B, C, D][k], bytesOf(value)]));
            same('D3DXQuaternionSquadSetup', { stack: [OUT, OUT + 16, OUT + 32, A, B, C, D],
                memory, control });
            same('D3DXQuaternionSquadSetup', { stack: [B, C, D, A, B, C, D], memory, control });
            same('D3DXQuaternionSquadSetup', { stack: [D, A, OUT, A, B, C, D], memory, control });
        }
    }
});
