/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's vectors, planes, colours and halves answer the same as their x86,
 * input by input, on cork's test machine (`scripts/guest-code/equivalence.mjs`):
 * random floats of every size, zero vectors, a w of 0, strides of 0, 12, 16
 * and 20 and counts of 0, NULL matrices and viewports, a singular product,
 * an output over its inputs -- under three control words, and under single
 * precision against the x87's model of the source; every float and every
 * half through the conversions' edges.
 */

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest-vector.x86.js';
import * as sources from './inguest-vector.js';
import { DATA, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest-vector.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-vector.js', url: SOURCE.href, values: sources,
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
 * Floats a program's vectors hold: of every size but no infinity or NaN,
 * zeros and ones among them.
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

/** Dwords' bytes. @param {number[]} values */
const wordsOf = values=>new Uint8Array(Uint32Array.from(values).buffer);

/** A FLOAT argument, as the dword it is on the stack. @param {number} value */
const floatArg = value=>{
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
};

/** @param {() => number} next @param {number} count */
const memoryOf = (next, count)=>/** @type {[number, ArrayLike<number>][]} */ (
    [A, B, C, D, E, F].slice(0, count).map(at=>[at, bytesOf(floats(next, 64))]));

test('normalised, splined, barycentric and crossed vectors, over their inputs too', ()=>{
    const next = random(21);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 16; i++)
        {
            const memory = memoryOf(next, 4);
            if (i === 0)
            {
                memory.push([A, bytesOf([0, 0, 0, 0])]);
            }
            const [s, f, g] = floats(next, 3).map(floatArg);
            for (const out of [OUT, A, B + 4])
            {
                same('D3DXVec2Normalize', { stack: [out, A], memory, control });
                same('D3DXVec4Normalize', { stack: [out, A], memory, control });
                same('D3DXVec4Cross', { stack: [out, A, B, C], memory, control });
                for (const n of [2, 3, 4])
                {
                    same(`D3DXVec${n}Hermite`, { stack: [out, A, B, C, D, s], memory, control });
                    same(`D3DXVec${n}CatmullRom`, { stack: [out, A, B, C, D, s], memory, control });
                    same(`D3DXVec${n}BaryCentric`, { stack: [out, A, B, C, f, g], memory,
                        control });
                }
            }
        }
    }
});

test('two-vectors transformed, one at a time and in arrays of every stride', ()=>{
    const next = random(22);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 12; i++)
        {
            const memory = memoryOf(next, 2);
            if (i % 4 === 0)
            {
                // A w of zero for every point: divided by one.
                const m = floats(next, 16);
                m[3] = 0;
                m[7] = 0;
                m[15] = 0;
                memory.push([A, bytesOf(m)]);
            }
            for (const out of [OUT, B])
            {
                same('D3DXVec2Transform', { stack: [out, B, A], memory, control });
                same('D3DXVec2TransformCoord', { stack: [out, B, A], memory, control });
                same('D3DXVec2TransformNormal', { stack: [out, B, A], memory, control });
            }
            for (const [outStride, inStride, count] of [[16, 8, 6], [8, 8, 5], [8, 16, 4],
                [8, 8, 0], [0, 8, 3], [20, 12, 4]])
            {
                for (const name of ['D3DXVec2TransformArray', 'D3DXVec2TransformCoordArray',
                    'D3DXVec2TransformNormalArray'])
                {
                    same(name, { stack: [OUT, outStride, B, inStride, A, count], memory,
                        control });
                }
            }
            // The points written over the ones still to come.
            same('D3DXVec2TransformCoordArray', { stack: [B + 8, 8, B, 8, A, 4], memory,
                control });
        }
    }
});

test('three- and four-vectors and planes transformed in arrays, and planes one at a time', ()=>{
    const next = random(23);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 12; i++)
        {
            const memory = memoryOf(next, 2);
            for (const [outStride, inStride, count] of [[16, 12, 5], [12, 16, 4], [16, 16, 0],
                [0, 16, 3], [20, 20, 3]])
            {
                for (const name of ['D3DXVec3TransformArray', 'D3DXVec3TransformNormalArray',
                    'D3DXVec4TransformArray', 'D3DXPlaneTransformArray'])
                {
                    same(name, { stack: [OUT, outStride, B, inStride, A, count], memory,
                        control });
                }
            }
            same('D3DXVec4TransformArray', { stack: [A, 16, B, 16, A, 4], memory, control });
            for (const out of [OUT, B, A])
            {
                same('D3DXPlaneTransform', { stack: [out, B, A], memory, control });
                same('D3DXPlaneNormalize', { stack: [out, B], memory, control });
            }
        }
    }
});

test('planes from points and normals, a line through one, a parallel line, a zero plane', ()=>{
    const next = random(24);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 24; i++)
        {
            const memory = memoryOf(next, 3);
            if (i === 0)
            {
                memory.push([A, bytesOf([0, 0, 0, 5])]);
            }
            if (i === 1)
            {
                // The line along the plane: its direction orthogonal to the normal.
                memory.push([A, bytesOf([1, 2, 0, 3])]);
                memory.push([B, bytesOf([1, 1, 7])]);
                memory.push([C, bytesOf([3, 0, -2])]);
            }
            for (const out of [OUT, A, B, C])
            {
                same('D3DXPlaneFromPointNormal', { stack: [out, B, C], memory, control });
                same('D3DXPlaneFromPoints', { stack: [out, A, B, C], memory, control });
                same('D3DXPlaneIntersectLine', { stack: [out, A, B, C], memory, control });
                same('D3DXPlaneNormalize', { stack: [out, A], memory, control });
            }
            same('D3DXPlaneFromPoints', { stack: [OUT, A, A, B], memory, control });
        }
    }
});

test('projected and unprojected points: each matrix NULL or not, no viewport, a singular one',
    ()=>{
        const next = random(25);
        const viewport = wordsOf([10, 5, 800, 600, floatArg(0.25), floatArg(0.75)]);
        for (const control of CONTROLS)
        {
            for (let i = 0; i < 3; i++)
            {
                const memory = memoryOf(next, 5);
                memory.push([E, viewport]);
                if (i === 2)
                {
                    memory.push([A, bytesOf(new Array(16).fill(0))]);
                }
                for (let mask = 0; mask < 16; mask++)
                {
                    const [vp, projection, view, world] = [E, A, B, C].map((at, k)=>
                        ((mask & 1 << k) !== 0 ? at : 0));
                    same('D3DXVec3Project', { stack: [OUT, D, vp, projection, view, world],
                        memory, control });
                    same('D3DXVec3Unproject', { stack: [mask % 2 ? D : OUT, D, vp, projection,
                        view, world], memory, control });
                    same('D3DXVec3ProjectArray', { stack: [OUT, 16, D, 12, vp, projection, view,
                        world, 5], memory, control });
                    same('D3DXVec3UnprojectArray', { stack: [OUT, 12, D, 16, vp, projection, view,
                        world, mask % 5], memory, control });
                }
            }
        }
    });

test('colours adjusted and the Fresnel term', ()=>{
    const next = random(26);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 40; i++)
        {
            const memory = memoryOf(next, 1);
            const s = floatArg(floats(next, 1)[0]);
            for (const out of [OUT, A])
            {
                same('D3DXColorAdjustContrast', { stack: [out, A, s], memory, control });
                same('D3DXColorAdjustSaturation', { stack: [out, A, s], memory, control });
            }
            // Where n^2 + c^2 is at least 1: below, the root is the invalid operation's NaN.
            const c = Math.fround(((next() % 2001) - 1000) / 1000);
            const n = Math.fround(1 + (next() % 3000) / 1000);
            same('D3DXFresnelTerm', { stack: [floatArg(c), floatArg(n)], control });
        }
    }
});

test('floats to halves and back: every edge, and random bits', ()=>{
    const next = random(27);
    const edges = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x7f800001,
        0x479c4000, 0x477fdf00, 0x477fe000, 0x477ff000, 0x477ff100, 0x477fff00, 0x47800000,
        0x47ffe000, 0x47fff000, 0x47fff001, 0x48000000, 0x38800000, 0x387fffff, 0x387fe000,
        0x387ff000, 0x33800000, 0x33000800, 0x330007ff, 0x33c00000, 0x00000001, 0x3f800000,
        0x3f801000, 0x3f803000, 0x3f801001, 0xc79c4000, 0xb3000800];
    const singles = [...edges, ...Array.from({ length: 480 }, ()=>next())];
    const halves = [...Array.from({ length: 64 }, (_, i)=>i), 0x03ff, 0x0400, 0x7bff, 0x7c00,
        0x7c01, 0x7e00, 0x7fff, 0x8000, 0x8001, 0x83ff, 0xfc00, 0xffff,
        ...Array.from({ length: 450 }, ()=>next() & 0xffff)];
    // Apart from each other and from the outputs, the arrays being long.
    const from = DATA + 0x1000;
    const to = DATA + 0x2000;
    const memory = /** @type {[number, ArrayLike<number>][]} */ ([[A, wordsOf(singles)],
        [from, new Uint8Array(Uint16Array.from(halves).buffer)]]);
    for (const control of [0x27f, 0x07f])
    {
        same('D3DXFloat32To16Array', { stack: [to, A, singles.length], memory, control });
        same('D3DXFloat16To32Array', { stack: [to, from, halves.length], memory, control });
        same('D3DXFloat32To16Array', { stack: [to, A, 0], memory, control });
        same('D3DXFloat16To32Array', { stack: [from + 4, from, 64], memory, control });
    }
});
