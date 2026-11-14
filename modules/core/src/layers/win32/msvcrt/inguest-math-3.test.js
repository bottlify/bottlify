/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * C99's base-two and near-one logarithms and exponentials, the inverse
 * hyperbolics, ilogb and modff in the guest: their x86 against their
 * JavaScript on cork's test machine under double and single precision (the
 * x86-64 is held to the same JavaScript by `scripts/guest-code/long.test.js`),
 * and the JavaScript against the host's answers, which the handlers give:
 * a float within one step of the host's float, a double within a few units
 * in the last place of the host's double.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPILED } from './inguest-math.x86.js';
import * as sources from './inguest-math.js';
import { DATA, doubleWords, equivalence, random } from '../../../../scripts/guest-code/equivalence.mjs';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

const SOURCE = new URL('./inguest-math.js', import.meta.url);
const model = await loadModel(await readFile(SOURCE, 'utf8'), {
    file: 'inguest-math.js', url: SOURCE.href, values: sources,
});
const { same } = equivalence(COMPILED, sources, model);

/** Double and single precision. */
const CONTROLS = [0x27f, 0x07f];

/** The host's answer of each function, as its handler computes it. */
const HOST = /** @type {Record<string, (x: number) => number>} */ ({
    log2: Math.log2, exp2: x=>2 ** x, log1p: Math.log1p, expm1: Math.expm1,
    asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
});

const DOUBLES = Object.keys(HOST);

/** A float's bits. @param {number} value */
const floatWord = value=>new Uint32Array(new Float32Array([value]).buffer)[0];

/**
 * The edges -- zeros, the domains' ends, the ranges' ends, the switches
 * between ways of computing, denormals, the specials -- and random doubles of
 * every exponent and of small ones.
 *
 * @param {number} seed @param {number} count
 */
function inputs(seed, count){
    const next = random(seed);
    const values = [0, -0, 1, -1, 0.5, -0.5, 2, 3, 1e-310, 5e-324, 1e-10, -1e-10, 1e10, 1e300,
        -1e300, 0.69, -0.69, 0.7, -0.7, -40, -41, 707.9, 708, 1021.9, -1021.9, 1022, -1022, 125.9,
        126, -126, 2 ** 28, 2 ** 28 - 1, 1 - 2 ** -53, -1 + 2 ** -53, -1, 1 + 2 ** -52,
        Infinity, -Infinity, NaN];
    const view = new DataView(new ArrayBuffer(8));
    while (values.length < count + 39)
    {
        view.setUint32(0, next(), true);
        view.setUint32(4, next(), true);
        const bits = view.getFloat64(0, true);
        const value = values.length % 2 === 0 ? bits : (next() - 2 ** 31) / 2 ** (next() % 36);
        if (!Number.isNaN(value))
        {
            values.push(value);
        }
    }
    return values;
}

/** A handler's stand-in: one value, the same for both runs. */
const handedDouble = { host: ()=>({ st0: 0 }) };
const handedInt = { host: ()=>0 };

test('log2, exp2, log1p, expm1, asinh, acosh, atanh and their float forms: x86 as JavaScript',
    ()=>{
        const values = inputs(31, 48);
        /** @type {Record<string, number>} */
        const handed = {};
        for (const control of CONTROLS)
        {
            for (const x of values)
            {
                for (const name of DOUBLES)
                {
                    const run = same(name, { stack: doubleWords(x), control }, handedDouble);
                    handed[name] = (handed[name] ?? 0) + (run.handedOver ? 1 : 0);
                    same(`${name}f`, { stack: [floatWord(x)], control }, handedDouble);
                }
                same('ilogb', { stack: doubleWords(x), control }, handedInt);
                same('ilogbf', { stack: [floatWord(x)], control }, handedInt);
                same('modff', { stack: [floatWord(x), DATA + 8], control }, handedDouble);
            }
        }
        for (const name of DOUBLES)
        {
            assert.ok(handed[name] > 0, `${name}: the edges handed over`);
            assert.ok(handed[name] < values.length * CONTROLS.length,
                `${name}: answered in the guest`);
        }
    });

/** A double's position on the line of doubles, for counting units in the last place. */
const view = new DataView(new ArrayBuffer(8));
/** @param {number} x */
const ordinal = x=>{
    view.setFloat64(0, x, true);
    const bits = view.getBigInt64(0, true);
    return bits < 0n ? -(bits & 0x7fffffffffffffffn) : bits;
};

/** What the guest code computes, its hand-overs marked. */
const MARK = Symbol('host');
const guest = /** @type {any} */ ({ host: ()=>MARK });

test('the JavaScript is the host\'s answer: floats within a step, doubles within a few units', ()=>{
    const next = random(37);
    const values = [...inputs(41, 4000),
        ...Array.from({ length: 4000 }, ()=>(next() / 2 ** 32) * 2 - 1),
        ...Array.from({ length: 4000 }, ()=>1 + (next() / 2 ** 32) * 30)];
    for (const name of DOUBLES)
    {
        let worst = 0n;
        let worstFloat = 0;
        let answered = 0;
        for (const x of values)
        {
            const got = /** @type {any} */ (sources)[name](guest, x);
            if (got !== MARK)
            {
                answered++;
                const exact = HOST[name](x);
                const ulps = ordinal(got) - ordinal(exact);
                worst = ulps > worst ? ulps : -ulps > worst ? -ulps : worst;
            }
            const xf = Math.fround(x);
            const gotFloat = /** @type {any} */ (sources)[`${name}f`](guest, xf);
            if (gotFloat !== MARK)
            {
                worstFloat = Math.max(worstFloat, Math.abs(floatWord(gotFloat)
                    - floatWord(Math.fround(HOST[name](xf)))));
            }
        }
        assert.ok(answered > values.length / 3, `${name}: answered ${answered}`);
        assert.ok(worst <= 4n, `${name}: worst ${worst} units in the last place`);
        assert.ok(worstFloat <= 1, `${name}f: worst ${worstFloat} steps`);
    }
});

test('ilogb and modff answer as their handlers do', ()=>{
    const written = new DataView(new ArrayBuffer(4));
    const memory = { setF32: (/** @type {number} */ at, /** @type {number} */ v)=>{
        written.setFloat32(0, v, true);
    }, host: ()=>MARK };
    for (const x of inputs(43, 400))
    {
        const xf = Math.fround(x);
        const e = /** @type {any} */ (sources.ilogb)(guest, x);
        if (e !== MARK)
        {
            assert.equal(e, Math.floor(Math.log2(Math.abs(x))) | 0, `ilogb(${x})`);
        }
        const fraction = /** @type {any} */ (sources.modff)(memory, xf, 0);
        if (fraction !== MARK)
        {
            const whole = Math.trunc(xf);
            assert.ok(Object.is(written.getFloat32(0, true), whole), `modff(${xf}) whole`);
            assert.ok(Object.is(fraction, Math.fround(xf - whole)), `modff(${xf}) fraction`);
        }
    }
});
