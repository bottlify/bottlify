/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fpremStatus, fpremValue } from './ir-x87.js';

const C0 = 0x100;
const C1 = 0x200;
const C2 = 0x400;
const C3 = 0x4000;

const view = new DataView(new ArrayBuffer(8));
/**
 * A finite double as an integer times a power of two.
 *
 * @param {number} value @returns {[bigint, number]}
 */
function decompose(value){
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const field = Number(bits >> 52n & 0x7ffn);
    let mantissa = bits & 0xfffffffffffffn;
    if (field !== 0)
    {
        mantissa |= 1n << 52n;
    }
    return [bits >> 63n !== 0n ? -mantissa : mantissa, (field === 0 ? 1 : field) - 1075];
}
/** @param {bigint} value */
const abs = value=>value < 0n ? -value : value;
/** @param {bigint} value */
const bitLength = value=>abs(value).toString(2).length;

/**
 * The partial remainder in integers, as the architecture defines it: the
 * quotient truncated (or rounded to nearest, even on a tie) exactly, the
 * remainder exact; past an exponent difference of 63, a reduction by a
 * power-of-two multiple of `c`, 32 plus the difference mod 32 below it.
 *
 * @param {number} a @param {number} c @param {boolean} nearest
 * @returns {{ remainder: [bigint, number], status: number }}
 */
function reference(a, c, nearest){
    const [ma, ea] = decompose(a);
    const [mc, ec] = decompose(c);
    const e = Math.min(ea, ec);
    const A = ma << BigInt(ea - e);
    let C = mc << BigInt(ec - e);
    const d = (ea + bitLength(ma)) - (ec + bitLength(mc));
    if (d >= 64)
    {
        C <<= BigInt(d - 32 - d % 32);
        return { remainder: [A - A / C * C, e], status: C2 };
    }
    let q = A / C;
    let r = A - q * C;
    if (nearest && (2n * abs(r) > abs(C) || 2n * abs(r) === abs(C) && (abs(q) & 1n) === 1n))
    {
        q += (A < 0n) === (C < 0n) ? 1n : -1n;
        r = A - q * C;
    }
    const low = Number(abs(q) & 7n);
    return {
        remainder: [r, e],
        status: ((low & 4) !== 0 ? C0 : 0) | ((low & 2) !== 0 ? C3 : 0)
            | ((low & 1) !== 0 ? C1 : 0),
    };
}

/**
 * Whether a double is the integer-scaled value exactly.
 *
 * @param {number} value @param {[bigint, number]} exact
 */
function same(value, [r, e]){
    const [m, f] = decompose(value);
    return f >= e ? m << BigInt(f - e) === r : r << BigInt(e - f) === m;
}

test('fprem and fprem1 on doubles are the exact remainder with the quotient\'s low bits', ()=>{
    let seed = 7;
    const random = ()=>{
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed / 2 ** 32;
    };
    /** @type {[number, number][]} */
    const cases = [
        [3736.3244596153145, 7.049668791727009], [517.3000099683646, 0.1], [100, 2 * Math.PI],
        [Math.PI, 1], [Math.log2(10), 1], [5, 2], [7, 2], [-7, 2], [7, -2], [-7, -2],
        [3, 4], [2, 4], [6, 4], [1e300, 1e-300], [2 ** 63 + 2 ** 11, 3], [2 ** 64 - 2 ** 11, 3],
        [Number.MAX_VALUE, Number.MAX_VALUE / 3], [Number.MAX_VALUE, Number.MAX_VALUE * 0.9],
        [5e-324, 3e-323], [1e-310, 3e-315], [-0, 3], [0, -3], [7, Infinity], [-7, -Infinity],
    ];
    for (let i = 0; i < 20000; i++)
    {
        // A spread of magnitudes, quotients from below one to past 2^64, and
        // dividends a step below a multiple of the divisor, where a quotient
        // in doubles rounds up.
        const c = (random() + 0.5) * 2 ** Math.floor(random() * 40 - 20)
            * (random() < 0.5 ? -1 : 1);
        const scale = 2 ** Math.floor(random() * 80 - 4);
        let a = Math.floor(random() * 1000 + 1) * c * (random() < 0.3 ? 1 : random()) * scale;
        if (i % 3 === 0)
        {
            view.setFloat64(0, a);
            view.setBigUint64(0, view.getBigUint64(0) - 1n);
            a = view.getFloat64(0);
        }
        cases.push([random() < 0.5 ? a : -a, c]);
    }
    for (const [a, c] of cases)
    {
        for (const nearest of [false, true])
        {
            const got = fpremValue(a, c, nearest ? 1 : 0);
            if (Number.isFinite(c))
            {
                const want = reference(a, c, nearest);
                assert.ok(same(got, want.remainder),
                    `${nearest ? 'fprem1' : 'fprem'}(${a}, ${c}) = ${got}`);
                assert.equal(fpremStatus(a, c, nearest ? 1 : 0), want.status,
                    `${nearest ? 'fprem1' : 'fprem'}(${a}, ${c}) status`);
            }
            else
            {
                assert.ok(Object.is(got, a), 'an infinite divisor leaves the dividend');
                assert.equal(fpremStatus(a, c, nearest ? 1 : 0), 0);
            }
            if (got === 0)
            {
                assert.equal(Object.is(got, -0), Object.is(a, -0) || a < 0,
                    'a zero remainder has the dividend\'s sign');
            }
        }
    }
});

test('partial remainders repeated reach the exact remainder', ()=>{
    // A loop of fprem until C2 clears, as a program reduces an argument.
    for (const [a, c] of [[1e300, 3], [2 ** 200 + 2 ** 150, Math.PI], [1e30, 1e-30]])
    {
        let value = a;
        let turns = 0;
        while ((fpremStatus(value, c, 0) & C2) !== 0)
        {
            value = fpremValue(value, c, 0);
            turns++;
        }
        value = fpremValue(value, c, 0);
        assert.ok(turns > 0, 'the first was partial');
        assert.equal(value, a % c, `${a} mod ${c}`);
    }
});
