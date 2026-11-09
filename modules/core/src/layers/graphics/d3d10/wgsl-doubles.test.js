/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The double-precision helpers a shader module is given, run as the WGSL
 * they are (`wgsl-run.js`) on seeded random doubles and held against
 * JavaScript's own binary64: every operation, bit for bit, the sign of a
 * zero included; any NaN for a NaN. A fused multiply-add has no JavaScript
 * counterpart, so its answer is worked out exactly in BigInt and rounded
 * here, by a rounding written apart from the helpers'.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOUBLE_HELPERS } from './wgsl-doubles.js';
import { runWgsl } from './wgsl-run.js';

const helpers = runWgsl(Object.values(DOUBLE_HELPERS).map(entry=>entry.text.join('\n'))
    .join('\n'));

const view = new DataView(new ArrayBuffer(8));
/** @param {number} value @returns {[number, number]} the low and high dwords */
const toWords = value=>{
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
};
/** @param {number[]} words */
const fromWords = ([low, high])=>{
    view.setUint32(0, low >>> 0, true);
    view.setUint32(4, high >>> 0, true);
    return view.getFloat64(0, true);
};
/** @param {number} value */
const floatWord = value=>{
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
};
/** @param {number} word */
const wordFloat = word=>{
    view.setUint32(0, word >>> 0, true);
    return view.getFloat32(0, true);
};

/** xorshift32, so a failure names a seed that repeats it. @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state;
    };
}

const SPECIAL = [0, -0, 1, -1, 0.5, 2, 3, Infinity, -Infinity, NaN, Number.MIN_VALUE,
    -Number.MIN_VALUE, 2.2250738585072014e-308, 2.225073858507201e-308, Number.MAX_VALUE,
    -Number.MAX_VALUE, 1 + Number.EPSILON, 1 - Number.EPSILON / 2, 2 ** 1023, 2 ** -1022,
    2 ** -1074 * 3, 4294967295, 2147483647, -2147483648, 2147483648, -2147483649, 4294967296,
    0.49999999999999994, 1e300, 1e-300];

/**
 * A double from one of several shapes: any bits, a small exponent spread
 * around 1, denormals, near the ends of the range, special values, and a
 * significand of runs of ones or zeros, where rounding ties live.
 *
 * @param {() => number} next
 */
function anyDouble(next){
    const kind = next() % 8;
    const sign = next() & 0x80000000;
    switch (kind)
    {
        case 0:
            return fromWords([next(), next()]);
        case 1:
        case 2:
            return fromWords([next(), sign | ((1023 - 40 + next() % 80) << 20)
                | (next() & 0xfffff)]);
        case 3:
            return fromWords([next(), sign | (next() & 0xfffff)]);
        case 4:
            return fromWords([next(), sign
                | ((next() % 2 ? 2046 - next() % 4 : 1 + next() % 4) << 20) | (next() & 0xfffff)]);
        case 5:
            return SPECIAL[next() % SPECIAL.length];
        case 6: {
            const ones = next() % 53;
            const low = ones >= 32 ? 0xffffffff : ((2 ** ones) - 1) >>> 0;
            const high = ones > 32 ? (2 ** (ones - 32)) - 1 : 0;
            const shifted = next() % 2 ? [low, high & 0xfffff] : [~low >>> 0, ~high & 0xfffff];
            return fromWords([shifted[0], sign | ((1000 + next() % 50) << 20) | shifted[1]]);
        }
        default:
            return (next() % 2 ? 1 : -1) * (next() % 100000) / (1 + next() % 1000);
    }
}

/**
 * @param {number} expected @param {number[]} got @param {string} what
 * @param {boolean} [eitherZero]  either zero right, as for the min of two zeros
 */
function sameDouble(expected, got, what, eitherZero = false){
    const value = fromWords(got);
    if (Number.isNaN(expected))
    {
        assert.ok(Number.isNaN(value), `${what}: ${value}, expected NaN`);
        return;
    }
    if (eitherZero && expected === 0 && value === 0)
    {
        return;
    }
    assert.deepEqual(got, toWords(expected),
        `${what}: ${value} (${got.map(word=>word.toString(16))}), expected ${expected}`);
}

/** A double as sign * significand * 2^exponent, all exact. @param {number} value */
function exact(value){
    const [low, high] = toWords(value);
    const field = (high >>> 20) & 0x7ff;
    const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
    return {
        negative: high >>> 31 === 1,
        significand: field === 0 ? fraction : fraction | (1n << 52n),
        exponent: (field === 0 ? 1 : field) - 1075,
    };
}

/**
 * The double nearest signed * 2^exponent, ties to even, with denormals: the
 * reference rounding, independent of the helpers'.
 *
 * @param {bigint} signed @param {number} exponent
 */
function nearest(signed, exponent){
    if (signed === 0n)
    {
        return 0;
    }
    const negative = signed < 0n;
    const magnitude = negative ? -signed : signed;
    const length = magnitude.toString(2).length;
    // The weight of the last bit kept: 53 bits, but never below 2^-1074.
    const lowest = Math.max(exponent + length - 53, -1074);
    const drop = lowest - exponent;
    let kept;
    if (drop > 0)
    {
        const unit = 1n << BigInt(drop);
        kept = magnitude >> BigInt(drop);
        const rest = magnitude - (kept << BigInt(drop));
        if (rest * 2n > unit || (rest * 2n === unit && (kept & 1n) === 1n))
        {
            kept += 1n;
        }
    }
    else
    {
        kept = magnitude << BigInt(-drop);
    }
    const value = Number(kept) * 2 ** (drop > 0 ? lowest : exponent + drop);
    return negative ? -value : value;
}

/** a * b + c, rounded once. @param {number} a @param {number} b @param {number} c */
function fusedMultiplyAdd(a, b, c){
    if ([a, b, c].some(value=>!Number.isFinite(value)) || a === 0 || b === 0 || c === 0)
    {
        // Infinities, NaNs and zeros round nothing: the plain expression
        // answers them, but a zero product added to a zero keeps the sign
        // rule of an exact sum.
        if ((a === 0 || b === 0) && Number.isFinite(a) && Number.isFinite(b)
            && Number.isFinite(c))
        {
            return c === 0 ? (a * b) + c : c;
        }
        if (c === 0 && Number.isFinite(a) && Number.isFinite(b))
        {
            return a * b;
        }
        // The product of two finite doubles is finite, however large.
        if (Number.isFinite(a) && Number.isFinite(b) && !Number.isNaN(c))
        {
            return c;
        }
        return a * b + c;
    }
    const x = exact(a);
    const y = exact(b);
    const z = exact(c);
    const productExponent = x.exponent + y.exponent;
    const low = Math.min(productExponent, z.exponent);
    const product = (x.significand * y.significand) << BigInt(productExponent - low);
    const addend = z.significand << BigInt(z.exponent - low);
    return nearest((x.negative !== y.negative ? -product : product)
        + (z.negative ? -addend : addend), low);
}

const CASES = 20000;

test('the reference rounding agrees with JavaScript\'s own on products and sums', ()=>{
    const next = random(7);
    for (let index = 0; index < CASES; index++)
    {
        const a = anyDouble(next);
        const b = anyDouble(next);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0)
        {
            continue;
        }
        const x = exact(a);
        const y = exact(b);
        const product = nearest((x.negative !== y.negative ? -1n : 1n) * x.significand
            * y.significand, x.exponent + y.exponent);
        if (Number.isFinite(a * b) && a * b !== 0)
        {
            assert.equal(product, a * b, `${a} * ${b}`);
        }
    }
});

test('dadd, dmul, ddiv and drcp are binary64\'s, rounded to nearest, denormals kept', ()=>{
    const next = random(1);
    for (let index = 0; index < CASES; index++)
    {
        const a = anyDouble(next);
        const b = anyDouble(next);
        const [wa, wb] = [toWords(a), toWords(b)];
        sameDouble(a + b, helpers.dblAdd(wa, wb), `${a} + ${b}`);
        sameDouble(a - b, helpers.dblAdd(wa, toWords(-b)), `${a} - ${b}`);
        sameDouble(a * b, helpers.dblMul(wa, wb), `${a} * ${b}`);
        sameDouble(a / b, helpers.dblDiv(wa, wb), `${a} / ${b}`);
        sameDouble(1 / b, helpers.dblDiv(toWords(1), wb), `1 / ${b}`);
    }
});

test('a sum that cancels, one that carries into a new top bit, and one a single bit from a tie'
    + ' round as binary64\'s do', ()=>{
    const next = random(3);
    for (let index = 0; index < CASES; index++)
    {
        const a = anyDouble(next);
        if (!Number.isFinite(a))
        {
            continue;
        }
        const ulp = toWords(a);
        const neighbour = fromWords([(ulp[0] + 1 + next() % 3) >>> 0, ulp[1]]);
        const half = a * 2 ** -(53 + next() % 3);
        // A significand of all ones and an addend a few places below it:
        // the sum carries, and the bit it carries out decides a tie.
        const field = (ulp[1] >>> 20) & 0x7ff;
        // Eleven or twelve places below, an addend whose last bit lands on or
        // just past the carried sum's last place, the ten above it clear.
        const below = field - 11 - next() % 2;
        const full = fromWords([0xffffffff - next() % 4, (ulp[1] & 0xfff00000) | 0xfffff]);
        const addend = below < 1 ? 0 : fromWords([((next() & 0xfffff000) | 1) >>> 0,
            (ulp[1] & 0x80000000) | (below << 20) | (next() & 0xfffff)]);
        sameDouble(full + addend, helpers.dblAdd(toWords(full), toWords(addend)),
            `${full} + ${addend}`);
        for (const b of [-neighbour, -a, half, -half, a * (1 + 2 ** -52)])
        {
            sameDouble(a + b, helpers.dblAdd(toWords(a), toWords(b)), `${a} + ${b}`);
        }
    }
});

test('dfma rounds a * b + c once', ()=>{
    const next = random(5);
    for (let index = 0; index < CASES; index++)
    {
        const a = anyDouble(next);
        const b = anyDouble(next);
        // An addend near the product makes the cancellations worth testing.
        const c = next() % 3 === 0 ? -(a * b) * (1 + (next() % 5 - 2) * 2 ** -52)
            : anyDouble(next);
        sameDouble(fusedMultiplyAdd(a, b, c),
            helpers.dblFma(toWords(a), toWords(b), toWords(c)), `fma(${a}, ${b}, ${c})`);
    }
});

test('the comparisons are ordered, NaN equal to nothing, the zeros equal; min and max pass a'
    + ' NaN over', ()=>{
    const next = random(9);
    for (let index = 0; index < CASES; index++)
    {
        const a = anyDouble(next);
        const b = next() % 4 === 0 ? a : anyDouble(next);
        const [wa, wb] = [toWords(a), toWords(b)];
        assert.equal(helpers.dblEqual(wa, wb), a === b, `${a} == ${b}`);
        assert.equal(helpers.dblLess(wa, wb), a < b, `${a} < ${b}`);
        const smaller = Number.isNaN(a) ? b : Number.isNaN(b) ? a : a < b ? a : b;
        const larger = Number.isNaN(a) ? b : Number.isNaN(b) ? a : a > b ? a : b;
        sameDouble(smaller, helpers.dblMin(wa, wb), `min(${a}, ${b})`, true);
        sameDouble(larger, helpers.dblMax(wa, wb), `max(${a}, ${b})`, true);
        const saturated = Number.isNaN(a) ? 0 : Math.min(Math.max(a, 0), 1) || 0;
        sameDouble(saturated, helpers.dblSaturate(wa), `sat(${a})`);
    }
});

test('dtof rounds to the nearest float, ftod, itod and utod are exact, dtoi and dtou truncate'
    + ' and hold to their range', ()=>{
    const next = random(11);
    for (let index = 0; index < CASES; index++)
    {
        const a = anyDouble(next);
        const wa = toWords(a);
        const float = Math.fround(a);
        const got = wordFloat(helpers.dblToFloat(wa));
        if (Number.isNaN(float))
        {
            assert.ok(Number.isNaN(got), `dtof(${a})`);
        }
        else
        {
            assert.equal(helpers.dblToFloat(wa), floatWord(float), `dtof(${a}): ${got}`);
        }
        const truncated = Math.trunc(a);
        const asInt = Number.isNaN(a) ? 0 : Math.min(Math.max(truncated, -2147483648), 2147483647);
        assert.equal(helpers.dblToInt(wa) | 0, asInt || 0, `dtoi(${a})`);
        const asUint = Number.isNaN(a) ? 0 : Math.min(Math.max(truncated, 0), 4294967295);
        assert.equal(helpers.dblToUint(wa), asUint || 0, `dtou(${a})`);
        const word = next();
        const fromFloat = wordFloat(word);
        sameDouble(fromFloat, helpers.dblFromFloat(word), `ftod(${fromFloat})`);
        const small = next() % 2 ? word & 0x807fffff : word;
        sameDouble(wordFloat(small), helpers.dblFromFloat(small), `ftod(${wordFloat(small)})`);
        sameDouble(word | 0, helpers.dblFromInt(word), `itod(${word | 0})`);
        sameDouble(word, helpers.dblFromUint(word), `utod(${word})`);
    }
});

test('the 64- and 128-bit integers under them are BigInt\'s: shifts, sticky shifts,'
    + ' differences, leading zeros, the full product', ()=>{
    const next = random(13);
    /** @param {number[]} limbs low first */
    const big = limbs=>limbs.reduceRight((sum, limb)=>(sum << 32n) | BigInt(limb >>> 0), 0n);
    /** @param {bigint} value @param {number} count */
    const limbsOf = (value, count)=>Array.from({ length: count },
        (_, index)=>Number((value >> BigInt(32 * index)) & 0xffffffffn));
    /** @param {bigint} value @param {number} count  value >> count, the bits lost or-ed in */
    const jammed = (value, count)=>{
        const kept = value >> BigInt(count);
        return kept | ((kept << BigInt(count)) === value ? 0n : 1n);
    };
    const all64 = (1n << 64n) - 1n;
    const all128 = (1n << 128n) - 1n;
    for (let index = 0; index < CASES; index++)
    {
        // Runs of zeros make the leading zeros and the lost bits worth it.
        const word = ()=>(next() % 4 === 0 ? 0 : next() >>> (next() % 32));
        const a = [word(), word(), word(), word()];
        const b = [word(), word(), word(), word()];
        const s = next() % 140;
        const [wide, other] = [big(a), big(b)];
        const [narrow, short] = [big(a.slice(0, 2)), big(b.slice(0, 2))];
        assert.deepEqual(helpers.u128ShrJam(a, s), limbsOf(jammed(wide, s), 4), `${wide} >> ${s}`);
        assert.deepEqual(helpers.u128Shl(a, s % 128), limbsOf((wide << BigInt(s % 128)) & all128,
            4), `${wide} << ${s % 128}`);
        assert.equal(helpers.u128Clz(a), 128 - (wide === 0n ? 0 : wide.toString(2).length));
        assert.deepEqual(helpers.u128Sub(a, b), limbsOf((wide - other) & all128, 4));
        assert.deepEqual(helpers.u128Add(a, b), limbsOf((wide + other) & all128, 4));
        assert.deepEqual(helpers.u64ShrJam(a.slice(0, 2), s), limbsOf(jammed(narrow, s), 2));
        assert.deepEqual(helpers.u64Shl(a.slice(0, 2), s), limbsOf((narrow << BigInt(s)) & all64,
            2));
        assert.deepEqual(helpers.u64Wide(a.slice(0, 2), b.slice(0, 2)),
            limbsOf(narrow * short, 4), `${narrow} * ${short}`);
    }
});
