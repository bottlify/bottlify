/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * C99's rounding and comparing functions in the guest (`round`, `trunc`,
 * `lround`, `copysign`, `fmax`, `fmin` and their float forms): their x86 and
 * x86-64 against their JavaScript under every precision and rounding the
 * x87 can be set to -- the answers the same under single precision as under
 * double, since nothing in them rounds -- and the JavaScript against C's
 * definition of each.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest-math.x86.js';
import * as sources from './inguest-math.js';
import { doubleWords, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest-math.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-math.js', url: SOURCE.href, values: sources,
});
const { same } = equivalence(COMPILED, sources, model);

/** Double, single and extended precision, and the roundings down, up and toward zero. */
const CONTROLS = [0x27f, 0x07f, 0x37f, 0x67f, 0xa7f, 0xe7f];

/** The doubles every function meets: halves, the edges of 52 bits and of a long, the specials. */
const EDGES = [0, -0, 0.5, -0.5, 1.5, -2.5, 0.49999999999999994, -0.49999999999999994,
    2 ** 52 - 0.5, -(2 ** 52) + 0.5, 2 ** 52, 2 ** 53 + 2, 1e-310, -1e-310, 2147483647.4,
    2147483647.5, -2147483648.4, -2147483648.5, 2147483646.5, 1e300, Infinity, -Infinity, NaN,
    3.75, -3.25];

/** A float's bits. @param {number} value */
const floatWord = value=>new Uint32Array(new Float32Array([value]).buffer)[0];

/** What the handler answers a call handed to it: lround's 0. */
const handed = { host: ()=>0 };

test('round, trunc, lround, copysign, fmax and fmin under every x87 control word', ()=>{
    const next = random(61);
    const values = [...EDGES, ...Array.from({ length: 30 },
        ()=>((next() / 2 ** 31) - 1) * 2 ** (next() % 34) + (next() % 2) * 0.5)];
    /** Each answer under double precision, held to the same under every other word. */
    const first = new Map();
    /** @param {string} key @param {{ st: number[], eax: number }} js */
    const sameEverywhere = (key, js)=>{
        const answer = js.st.length > 0 ? js.st[0] : js.eax;
        if (!first.has(key))
        {
            first.set(key, answer);
        }
        assert.ok(Object.is(first.get(key), answer)
            || Number.isNaN(first.get(key)) && Number.isNaN(answer), `${key}: as under 0x27f`);
    };
    for (const control of CONTROLS)
    {
        for (const [i, x] of values.entries())
        {
            const y = values[(i * 7 + 3) % values.length];
            const pair = [...doubleWords(x), ...doubleWords(y)];
            sameEverywhere(`round ${i}`, same('round', { stack: doubleWords(x), control }));
            sameEverywhere(`trunc ${i}`, same('trunc', { stack: doubleWords(x), control }));
            sameEverywhere(`lround ${i}`, same('lround', { stack: doubleWords(x), control },
                handed));
            sameEverywhere(`copysign ${i}`, same('copysign', { stack: pair, control }));
            sameEverywhere(`fmax ${i}`, same('fmax', { stack: pair, control }));
            sameEverywhere(`fmin ${i}`, same('fmin', { stack: pair, control }));
            const fx = floatWord(x);
            const fy = floatWord(y);
            sameEverywhere(`roundf ${i}`, same('roundf', { stack: [fx], control }));
            sameEverywhere(`truncf ${i}`, same('truncf', { stack: [fx], control }));
            sameEverywhere(`lroundf ${i}`, same('lroundf', { stack: [fx], control }, handed));
            sameEverywhere(`copysignf ${i}`, same('copysignf', { stack: [fx, fy], control }));
            sameEverywhere(`fmaxf ${i}`, same('fmaxf', { stack: [fx, fy], control }));
            sameEverywhere(`fminf ${i}`, same('fminf', { stack: [fx, fy], control }));
        }
    }
});

test('the answers are C\'s: halves away from zero, toward zero, a NaN losing, signed zeros', ()=>{
    const view = new DataView(new ArrayBuffer(8));
    const guest = /** @type {any} */ ({ host: ()=>Number.NaN,
        doubleHigh: (/** @type {number} */ v)=>{
            view.setFloat64(0, v, true);
            return view.getUint32(4, true);
        },
        floatBits: (/** @type {number} */ v)=>{
            view.setFloat32(0, v, true);
            return view.getUint32(0, true);
        } });
    assert.equal(sources.round(guest, 0.49999999999999994), 0);
    assert.equal(sources.round(guest, 2.5), 3);
    assert.equal(sources.round(guest, -2.5), -3);
    assert.ok(Object.is(sources.round(guest, -0.3), -0));
    assert.ok(Object.is(sources.trunc(-0.7), -0));
    assert.equal(sources.lround(guest, -2147483647.6), -2147483648);
    assert.ok(Number.isNaN(sources.lround(guest, 2147483647.5)), 'past a long: the handler\'s');
    assert.ok(Object.is(sources.copysign(guest, 3, -0), -3));
    assert.equal(sources.fmax(guest, Number.NaN, 1), 1);
    assert.ok(Object.is(sources.fmax(guest, -0, 0), 0));
    assert.ok(Object.is(sources.fmin(guest, 0, -0), -0));
});
