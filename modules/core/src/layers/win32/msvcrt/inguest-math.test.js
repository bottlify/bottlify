/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's mathematics answers the same as its x86, input by input, on
 * cork's test machine (`scripts/guest-code/equivalence.mjs` says what is
 * held equal): the edges of each function's domain and random doubles,
 * under five control words -- under single precision against the x87's
 * model of the source (`model.mjs`), each double's arithmetic and square
 * root rounded to 24 bits. The cases a function hands the host are answered
 * by a stand-in with JavaScript's value, and each function is seen to take
 * both ways.
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

/**
 * The control words a call is made under: double, single, and a rounding
 * the functions set aside (the others of the five the compiler's own tests
 * take add nothing here but time: the translation of each input's run).
 */
const CONTROLS = [0x27f, 0x07f, 0xf7f];

/**
 * The edges every function meets -- zeros, ones, the reductions' and the
 * ranges' ends, denormals, the infinities and NaN -- and random doubles of
 * every exponent and of small ones, no NaN among those (a NaN's payload is
 * not JavaScript's to keep).
 *
 * @param {number} seed @param {number} count @param {number[]} [more]
 */
function inputs(seed, count, more = []){
    const next = random(seed);
    const values = [0, -0, 1, -1, 0.5, -0.5, 2, 3, Math.PI / 2, -Math.PI, 1e-310, 5e-324, 1e-10,
        1e10, 1e300, -1e300, 2 ** 63, -(2 ** 63), 2 ** 62 * 1.9, 700, -700, 707.9, 708, 710, -745,
        22, -22, 0.34, 0.69, -0.7, Infinity, -Infinity, NaN, ...more];
    const view = new DataView(new ArrayBuffer(8));
    while (values.length < count + 33 + more.length)
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

/** What the handler answers for a case handed to it: JavaScript's value. */
const ANSWERS = /** @type {Record<string, (...args: number[]) => number>} */ ({
    sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin,
    acos: Math.acos, atan: Math.atan, exp: Math.exp, log: Math.log, log10: Math.log10,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, pow: Math.pow, _hypot: Math.hypot,
    _CI_hypot: Math.hypot, ldexp: (x, n)=>x * 2 ** n,
});

/**
 * The stand-in for a function's handler: the arguments read as it reads
 * them, JavaScript's value in ST0.
 *
 * @param {string} name
 */
const handOver = name=>({
    /** @type {(memory: Uint8Array, args: number[], x87: number[]) => { st0: number }} */
    host: (memory, args, x87)=>{
        const compute = ANSWERS[name.replace(/^_CI(?!_)/, '')];
        if (x87.length > 0)
        {
            return { st0: compute(...x87) };
        }
        const view = new DataView(new ArrayBuffer(16));
        args.forEach((word, i)=>view.setUint32(i * 4, word, true));
        return { st0: name === 'ldexp' ? compute(view.getFloat64(0, true), args[2] | 0)
            : compute(view.getFloat64(0, true), view.getFloat64(8, true)) };
    },
});

/**
 * Runs a function of doubles both ways over every input and control word,
 * as cdecl stack slots and, for its `_CI` form, on the x87 stack -- the
 * `_CI` form over every other input, the same code but for how it is given
 * them.
 *
 * @param {string} name @param {number[][]} cases  Each call's doubles.
 */
function both(name, cases){
    let handed = 0;
    for (const control of CONTROLS)
    {
        for (const [i, args] of cases.entries())
        {
            for (const form of [name, `_CI${name}`])
            {
                if (!COMPILED[/** @type {keyof typeof COMPILED} */ (form)]
                    || form !== name && i % 2 === 1)
                {
                    continue;
                }
                const input = form === name
                    ? { stack: args.flatMap(doubleWords), control } : { x87: args, control };
                handed += same(form, input, handOver(form)).handedOver ? 1 : 0;
            }
        }
    }
    return handed;
}

test('sqrt, sin, cos and tan: the x87\'s own, the rest the handler\'s', ()=>{
    for (const name of ['sqrt', 'sin', 'cos', 'tan'])
    {
        const handed = both(name, inputs(1, 40).map(x=>[x]));
        assert.ok(handed > 0, `${name}: some calls handed over`);
    }
});

test('asin, acos and atan, over their domains', ()=>{
    const next = random(2);
    const within = Array.from({ length: 24 }, ()=>next() / 2 ** 31 - 1);
    for (const name of ['asin', 'acos', 'atan'])
    {
        both(name, inputs(3, 16, [...within, 1 - 2 ** -53, -1 + 2 ** -53, 1 + 2 ** -52])
            .map(x=>[x]));
    }
});

test('exp, log, log10, sinh, cosh and tanh, across their ranges', ()=>{
    const next = random(4);
    const moderate = Array.from({ length: 16 }, ()=>(next() / 2 ** 31 - 1) * 40);
    for (const name of ['exp', 'log', 'log10', 'sinh', 'cosh', 'tanh'])
    {
        both(name, inputs(5, 16, [...moderate, 1e-5, -1e-7, 1000, 100, 0.001])
            .map(x=>[x]));
    }
});

test('pow: the exact powers, and any finite power of a finite base, in the guest; the edges'
    + ' handed over', ()=>{
    const next = random(12);
    const bases = inputs(6, 6, [4, 10, 0.25, 1e154, -1e154, 1e-160, -3, -0.5, 1.0001, 2 ** 52]);
    const exponents = [0, 1, -1, 2, 0.5, 3, -2, 1.5, NaN, Infinity, -0, 2.2, -7, 1 / 3, 1e10,
        -1e10, 2 ** 53, 2 ** 53 + 2, 0.75, 21, -0.25];
    // Every base to the exact powers, and to three others.
    const cases = bases.flatMap(x=>[0, 1, -1, 2, 0.5, exponents[next() % exponents.length],
        exponents[next() % exponents.length], exponents[next() % exponents.length]]
        .map(y=>[x, y]));
    const handed = both('pow', cases);
    assert.ok(handed > 0, 'pow: some calls handed over');
    // Each case under every control word, and every other one as _CIpow besides.
    const runs = CONTROLS.length * (cases.length + Math.ceil(cases.length / 2));
    assert.ok(handed < runs / 2, `pow: ${handed} of ${runs} handed over, the general powers kept`);
});

test('atan2, fmod and _hypot of pairs', ()=>{
    const next = random(7);
    const values = inputs(8, 14);
    const pairs = [];
    for (let i = 0; i < 70; i++)
    {
        pairs.push([values[next() % values.length], values[next() % values.length]]);
    }
    both('atan2', pairs);
    both('fmod', pairs);
    both('_hypot', [...pairs, [1e308, 1e308], [3, 4], [-0, -0], [Infinity, NaN]]);
});

test('ldexp, frexp and modf, their integer and double outputs in memory', ()=>{
    const values = inputs(9, 16);
    const next = random(10);
    let handed = 0;
    for (const control of CONTROLS)
    {
        for (const x of values)
        {
            for (const n of [1, -1074, 2000, -2000, next() % 4000 - 2000])
            {
                handed += same('ldexp', { stack: [...doubleWords(x), n >>> 0], control },
                    handOver('ldexp')).handedOver ? 1 : 0;
            }
            same('frexp', { stack: [...doubleWords(x), DATA], control });
            same('modf', { stack: [...doubleWords(x), DATA + 8], control });
        }
    }
    assert.ok(handed > 0, 'ldexp: overflows handed over');
});

test('_CIfabs, _CIfloor and _CIceil on the x87 stack', ()=>{
    for (const control of CONTROLS)
    {
        for (const x of inputs(11, 20))
        {
            for (const name of ['_CIfabs', '_CIfloor', '_CIceil'])
            {
                same(name, { x87: [x], control });
            }
        }
    }
});

test('pow to a whole power is the power correctly rounded, in the guest and the handler alike',
    ()=>{
        // Wine's msvcrt test__atodbl holds 10^n against _atodbl's answer to
        // two units in the last place; 2 to y log2 x in doubles was hundreds
        // out (10^100 by 117). By squaring in two doubles every one is the
        // double nearest the power.
        const guest = /** @type {any} */ ({ host: ()=>Number.NaN });
        for (let n = -307; n <= 308; n++)
        {
            assert.equal(sources.pow(guest, 10, n), Number(`1e${n}`), `10^${n}`);
        }
        assert.equal(sources.pow(guest, 3, 40), 12157665459056929000, 'the double nearest 3^40');
        assert.equal(sources.pow(guest, -2, 7), -128);
        assert.equal(sources.pow(guest, -1.5, 4), 5.0625);
        assert.equal(sources.pow(guest, 7, -3), 1 / 343);

        // And the x86 computes it bit for bit, under every control word.
        const next = random(21);
        const cases = Array.from({ length: 40 }, ()=>[
            (next() / 2 ** 31 - 1) * 2 ** ((next() % 60) - 30),
            (next() % 400) - 200,
        ]);
        both('pow', [...cases, [10, 308], [10, -307], [0.1, 300], [-3, 41], [1.0000001, 1e9]]);
    });
