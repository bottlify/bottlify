/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU32's arithmetic answers the same as its x86, input by input, on cork's
 * test machine (`scripts/guest-code/equivalence.mjs`): random doubles, the
 * degenerate cases each function refuses, outputs over inputs -- under a
 * double-precision control word, a rounding toward zero, and under single
 * precision against the x87's model of the source.
 */

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest.x86.js';
import * as sources from './inguest.js';
import {
    DATA, doubleWords, equivalence, random,
} from '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest.js', url: SOURCE.href, values: sources,
});
const { same } = equivalence(COMPILED, sources, model);

const CONTROLS = [0x27f, 0x07f, 0xf7f];

const MODEL = DATA;
const PROJ = DATA + 0x100;
const VIEWPORT = DATA + 0x200;
const OUT = DATA + 0x300;
const WIN = DATA + 0x400;
const TEXT = DATA + 0x500;

/** @param {() => number} next */
const value = next=>{
    const pick = next() % 6;
    return pick === 0 ? next() % 3 - 1 : pick < 4 ? (next() % 4000 - 2000) / 16
        : (next() % 2000000 - 1000000) / 997;
};

/** @param {number[]} values */
const doubles = values=>new Uint8Array(Float64Array.from(values).buffer);
/** @param {number[]} values */
const ints = values=>new Uint8Array(Int32Array.from(values).buffer);
/** @param {number[]} values */
const args = values=>values.flatMap(doubleWords);

test('the perspective, the camera and the pick region, and what each refuses', ()=>{
    const next = random(11);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 20; i++)
        {
            const fovy = i === 0 ? 0 : i === 1 ? 360 : (next() % 1700) / 10;
            const aspect = i === 2 ? 0 : (next() % 300 + 1) / 97;
            const near = (next() % 1000 + 1) / 64;
            const far = i === 3 ? near : near + (next() % 100000) / 8;
            same('gluPerspectiveMatrix', { stack: [OUT, ...args([fovy, aspect, near, far])],
                control });
            const eye = [value(next), value(next), value(next)];
            const centre = i === 4 ? eye : [value(next), value(next), value(next)];
            const up = i === 5 ? [0, 0, 0] : [value(next), value(next), value(next)];
            same('gluLookAtMatrix', { stack: [OUT, ...args([...eye, ...centre, ...up])],
                control });
            const viewport = [next() % 100, next() % 100, next() % 1000 + 1, next() % 800 + 1];
            const width = i === 6 ? 0 : i === 7 ? -2 : (next() % 64 + 1) / 4;
            same('gluPickMatrixArgs', {
                stack: [OUT, ...args([value(next), value(next), width, (next() % 64 + 1) / 4]),
                    VIEWPORT],
                memory: [[VIEWPORT, ints(viewport)]], control,
            });
        }
    }
});

test('project and unproject: random matrices, a singular one, a w of zero', ()=>{
    const next = random(12);
    for (const control of CONTROLS)
    {
        for (let i = 0; i < 16; i++)
        {
            const model_ = Array.from({ length: 16 }, ()=>value(next));
            const proj = i === 0 ? new Array(16).fill(0)
                : Array.from({ length: 16 }, ()=>value(next));
            if (i === 1)
            {
                // A singular product: two rows of the projection alike.
                for (let c = 0; c < 4; c++)
                {
                    proj[c * 4 + 1] = proj[c * 4];
                }
            }
            const viewport = [next() % 50, next() % 50, next() % 900 + 1, next() % 700 + 1];
            const memory = /** @type {[number, ArrayLike<number>][]} */ ([
                [MODEL, doubles(model_)], [PROJ, doubles(proj)], [VIEWPORT, ints(viewport)]]);
            const point = [value(next), value(next), value(next)];
            same('gluProject', { stack: [...args(point), MODEL, PROJ, VIEWPORT, WIN, WIN + 8,
                WIN + 16], memory, control });
            same('gluUnProjectPoint', { stack: [OUT, MODEL, PROJ, VIEWPORT,
                ...args([...point, i === 2 ? 0 : 1, i === 3 ? 0.25 : 0, i === 3 ? 0.75 : 1])],
            memory, control });
            const w = i === 4 ? 0 : value(next);
            const stored = /** @type {[number, ArrayLike<number>][]} */ (
                [[OUT, doubles([...point, w])]]);
            same('gluUnProjectDivide', { stack: [OUT, WIN, WIN + 8, WIN + 16], memory: stored,
                control });
            same('gluUnProjectStore', { stack: [OUT, WIN, WIN + 8, WIN + 16, WIN + 24],
                memory: stored, control });
        }
    }
});

test('gluCheckExtension: whole words only, the ends, null pointers and an empty name', ()=>{
    const text = (/** @type {string} */ s)=>new TextEncoder().encode(`${s}\0`);
    const string = 'GL_EXT_bgra  GL_ARB_multitexture GL_ARB_multitexture_x GL_EXT';
    for (const name of ['GL_EXT_bgra', 'GL_ARB_multitexture', 'GL_ARB_multi', 'GL_EXT',
        'GL_ARB_multitexture_x', 'GL_EXT_bgra ', '', 'x'])
    {
        same('gluCheckExtension', { stack: [TEXT, TEXT + 0x80],
            memory: [[TEXT, text(name)], [TEXT + 0x80, text(string)]] });
    }
    same('gluCheckExtension', { stack: [0, TEXT + 0x80], memory: [[TEXT + 0x80, text(string)]] });
    same('gluCheckExtension', { stack: [TEXT, 0], memory: [[TEXT, text('GL_EXT')]] });
});
