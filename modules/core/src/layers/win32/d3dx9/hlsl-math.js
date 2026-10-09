/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The transcendental functions the HLSL compiler folds constants with, built
 * from IEEE 754's basic operations alone.
 *
 * ECMAScript leaves Math.sin, exp, log, pow and the rest "implementation-
 * approximated": one engine ports fdlibm, another calls the platform's libm,
 * and the last bit differs between an x86 and an ARM machine. A folded
 * constant lands in the bytecode a program is handed, so a shader compiled on
 * one machine would not be byte-for-byte the shader compiled on another.
 * Addition, multiplication, division and square root are correctly rounded
 * everywhere, and JavaScript never fuses them, so a function made of them
 * answers the same bits on every engine and processor.
 *
 * Accuracy is a few units in the last place of a double, far inside the float
 * the compiler rounds every result to. The special values (signed zeros,
 * infinities, NaN, the poles) follow Math's, so what the compiler folded
 * before is what it folds now, to the last float bit save a rare near-tie.
 */

const scratch = new DataView(new ArrayBuffer(8));

/** pi/2 in three parts, the first two with trailing zero bits, for range reduction. */
const PIO2_1 = 1.5707963267341256;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_3 = 2.0222662487111665e-21;
const TWO_OVER_PI = 0.6366197723675814;
const PI = 3.141592653589793;
const PI_LO = 1.2246467991473532e-16;
const PIO2 = 1.5707963267948966;
const PIO2_LO = 6.123233995736766e-17;
/** ln 2 split so that k * LN2_HI is exact for every exponent k. */
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;
const LOG10_2 = 0.3010299956639812;
const INV_LN10 = 0.4342944819032518;
const SQRT2 = 1.4142135623730951;
const SQRT3 = 1.7320508075688772;
const PIO6 = 0.5235987755982988;
const PIO6_LO = 5.74182141399611e-17;
const TAN_PIO12 = 0.2679491924311227;

/**
 * 2 to an integer power, built from its bits: exact wherever it is
 * representable, and never through Math.pow.
 *
 * @param {number} k
 */
function twoTo(k){
    if (k > 1023)
    {
        return Infinity;
    }
    if (k >= -1022)
    {
        scratch.setUint32(0, (k + 1023) << 20, false);
        scratch.setUint32(4, 0, false);
        return scratch.getFloat64(0, false);
    }
    if (k >= -1074)
    {
        // A subnormal power: a mantissa bit alone.
        const bit = k + 1074;
        scratch.setUint32(0, bit >= 32 ? 1 << (bit - 32) : 0, false);
        scratch.setUint32(4, bit < 32 ? (1 << bit) >>> 0 : 0, false);
        return scratch.getFloat64(0, false);
    }
    return 0;
}

/**
 * x times 2^k, in steps that keep every intermediate representable.
 *
 * @param {number} x @param {number} k
 */
function scale(x, k){
    let value = x;
    let left = k;
    while (left > 1000)
    {
        value *= twoTo(1000);
        left -= 1000;
    }
    while (left < -1000)
    {
        value *= twoTo(-1000);
        left += 1000;
    }
    return value * twoTo(left);
}

/**
 * e^r for |r| at most ln 2 / 2: Taylor's series, summed small terms first.
 *
 * @param {number} r
 */
function expKernel(r){
    let sum = 0;
    for (let n = 17; n >= 1; n--)
    {
        sum = (sum + 1) * r / n;
    }
    return 1 + sum;
}

/** @param {number} x */
export function exp(x){
    if (Number.isNaN(x))
    {
        return NaN;
    }
    if (x > 709.782712893384)
    {
        return Infinity;
    }
    if (x < -745.1332191019412)
    {
        return 0;
    }
    if (x === 0)
    {
        return 1;
    }
    const k = Math.round(x * INV_LN2);
    const r = (x - k * LN2_HI) - k * LN2_LO;
    return scale(expKernel(r), k);
}

/** @param {number} x */
export function exp2(x){
    if (Number.isNaN(x))
    {
        return NaN;
    }
    if (x >= 1024)
    {
        return Infinity;
    }
    if (x < -1080)
    {
        return 0;
    }
    // The integer part goes into the exponent exactly; only the fraction is
    // approximated, so a whole power of two comes out whole.
    const k = Math.round(x);
    const fraction = x - k;
    return fraction === 0 ? scale(1, k) : scale(expKernel(fraction * LN2), k);
}

/**
 * e^x - 1, without the cancellation near zero.
 *
 * @param {number} x
 */
function expm1(x){
    if (Math.abs(x) < 0.5)
    {
        let sum = 0;
        for (let n = 22; n >= 1; n--)
        {
            sum = (sum + 1) * x / n;
        }
        return sum;
    }
    return exp(x) - 1;
}

/**
 * The parts of a positive finite x: x = m * 2^e with m in [sqrt(1/2), sqrt(2)).
 *
 * @param {number} x
 * @returns {{ m: number, e: number }}
 */
function split(x){
    let value = x;
    let bias = 0;
    if (value < 2.2250738585072014e-308)
    {
        value *= twoTo(54);
        bias = -54;
    }
    scratch.setFloat64(0, value, false);
    const high = scratch.getUint32(0, false);
    let e = ((high >>> 20) & 0x7ff) - 1023 + bias;
    scratch.setUint32(0, (high & 0x800fffff) | (1023 << 20), false);
    let m = scratch.getFloat64(0, false);
    if (m >= SQRT2)
    {
        m /= 2;
        e += 1;
    }
    return { m, e };
}

/**
 * log(m) for m in [sqrt(1/2), sqrt(2)): 2 atanh(s), s = (m - 1) / (m + 1).
 *
 * @param {number} m
 */
function logKernel(m){
    const f = m - 1;
    const s = f / (2 + f);
    const z = s * s;
    let sum = 0;
    for (let n = 12; n >= 1; n--)
    {
        sum = (sum + 1 / (2 * n + 1)) * z;
    }
    return 2 * s * (1 + sum);
}

/** @param {number} x @returns {number | null} the answer for a value outside the kernel's reach */
function logSpecial(x){
    if (Number.isNaN(x) || x < 0)
    {
        return NaN;
    }
    if (x === 0)
    {
        return -Infinity;
    }
    if (x === Infinity)
    {
        return Infinity;
    }
    return null;
}

/** @param {number} x */
export function log(x){
    const special = logSpecial(x);
    if (special !== null)
    {
        return special;
    }
    const { m, e } = split(x);
    return (e * LN2_HI + logKernel(m)) + e * LN2_LO;
}

/** @param {number} x */
export function log2(x){
    const special = logSpecial(x);
    if (special !== null)
    {
        return special;
    }
    // The exponent stays whole, so a power of two answers an exact integer.
    const { m, e } = split(x);
    return e + logKernel(m) * INV_LN2;
}

/** @param {number} x */
export function log10(x){
    const special = logSpecial(x);
    if (special !== null)
    {
        return special;
    }
    const { m, e } = split(x);
    return e * LOG10_2 + logKernel(m) * INV_LN10;
}

/** @param {number} y */
function isOddInteger(y){
    return Number.isInteger(y) && Math.abs(y) < 9007199254740992 && Math.abs(y % 2) === 1;
}

/**
 * x^y with Math.pow's special values (ECMAScript's Number::exponentiate).
 *
 * @param {number} x @param {number} y
 */
export function pow(x, y){
    if (Number.isNaN(y))
    {
        return NaN;
    }
    if (y === 0)
    {
        return 1;
    }
    if (Number.isNaN(x))
    {
        return NaN;
    }
    const ax = Math.abs(x);
    if (y === Infinity)
    {
        return ax > 1 ? Infinity : ax === 1 ? NaN : 0;
    }
    if (y === -Infinity)
    {
        return ax > 1 ? 0 : ax === 1 ? NaN : Infinity;
    }
    const odd = isOddInteger(y);
    if (x === Infinity)
    {
        return y > 0 ? Infinity : 0;
    }
    if (x === -Infinity)
    {
        return y > 0 ? (odd ? -Infinity : Infinity) : (odd ? -0 : 0);
    }
    if (x === 0)
    {
        const negative = Object.is(x, -0) && odd;
        return y > 0 ? (negative ? -0 : 0) : (negative ? -Infinity : Infinity);
    }
    if (x < 0 && !Number.isInteger(y))
    {
        return NaN;
    }
    // A small whole exponent multiplies out: exact where the product is, and
    // what a compiler folding x*x*x would produce.
    if (Number.isInteger(y) && Math.abs(y) <= 64)
    {
        let result = 1;
        let base = ax;
        let n = Math.abs(y);
        while (n > 0)
        {
            if (n & 1)
            {
                result *= base;
            }
            base *= base;
            n >>>= 1;
        }
        const magnitude = y < 0 ? 1 / result : result;
        return x < 0 && odd ? -magnitude : magnitude;
    }
    // y log2 x near a thousand has an ulp of 1e-13, which the power would
    // carry as relative error. The exponent's part is multiplied exactly into
    // two doubles, so only the logarithm's small fraction is rounded.
    if (ax === 1)
    {
        return x < 0 && odd ? -1 : 1;
    }
    const { m, e } = split(ax);
    // Past 2^60 the power is out of a double's range whichever way it goes,
    // and Dekker's split would overflow.
    const [high, low] = e === 0 ? [0, 0]
        : Math.abs(y) > 1152921504606846976 ? [y * e, 0] : twoProduct(y, e);
    if (high > 2000)
    {
        return x < 0 && odd ? -Infinity : Infinity;
    }
    if (high < -2200)
    {
        return x < 0 && odd ? -0 : 0;
    }
    let k = Math.round(high);
    let r = (high - k) + low + y * (logKernel(m) * INV_LN2);
    if (!(Math.abs(r) < 4096))
    {
        return r > 0 ? (x < 0 && odd ? -Infinity : Infinity) : (x < 0 && odd ? -0 : 0);
    }
    const carry = Math.round(r);
    k += carry;
    r -= carry;
    const magnitude = scale(expKernel(r * LN2), k);
    return x < 0 && odd ? -magnitude : magnitude;
}

/**
 * a * b as an unevaluated sum of two doubles, exactly (Dekker's product, for
 * want of a fused multiply-add JavaScript does not have).
 *
 * @param {number} a @param {number} b
 * @returns {[number, number]}
 */
function twoProduct(a, b){
    const product = a * b;
    const SPLIT = 134217729;
    const ca = SPLIT * a;
    const aHigh = ca - (ca - a);
    const aLow = a - aHigh;
    const cb = SPLIT * b;
    const bHigh = cb - (cb - b);
    const bLow = b - bHigh;
    const error = ((aHigh * bHigh - product) + aHigh * bLow + aLow * bHigh) + aLow * bLow;
    return [product, error];
}

/**
 * x reduced by multiples of pi/2: the remainder in [-pi/4, pi/4] and the
 * quadrant. Cody and Waite's three-part subtraction holds a double's accuracy
 * up to about 2^20 pi/2, which covers every float a shader folds sensibly.
 *
 * @param {number} x
 * @returns {{ r: number, n: number }}
 */
function reduce(x){
    if (Math.abs(x) <= Math.PI / 4)
    {
        return { r: x, n: 0 };
    }
    const n = Math.round(x * TWO_OVER_PI);
    const r = ((x - n * PIO2_1) - n * PIO2_2) - n * PIO2_3;
    return { r, n: ((n % 4) + 4) % 4 };
}

/** sin r for |r| at most pi/4. @param {number} r */
function sinKernel(r){
    const z = r * r;
    let sum = 0;
    for (let n = 10; n >= 1; n--)
    {
        sum = (1 - sum) * z / ((2 * n) * (2 * n + 1));
    }
    return r * (1 - sum);
}

/** cos r for |r| at most pi/4. @param {number} r */
function cosKernel(r){
    const z = r * r;
    let sum = 0;
    for (let n = 10; n >= 1; n--)
    {
        sum = (1 - sum) * z / ((2 * n - 1) * (2 * n));
    }
    return 1 - sum;
}

/** sin over each quadrant of the reduction, and cos, as the kernels give them. */
const SIN_QUADRANTS = [sinKernel, cosKernel, (/** @type {number} */ t)=>-sinKernel(t),
    (/** @type {number} */ t)=>-cosKernel(t)];
const COS_QUADRANTS = [cosKernel, (/** @type {number} */ t)=>-sinKernel(t),
    (/** @type {number} */ t)=>-cosKernel(t), sinKernel];

/** @param {number} x */
export function sin(x){
    if (!Number.isFinite(x))
    {
        return NaN;
    }
    if (x === 0)
    {
        return x;
    }
    const { r, n } = reduce(x);
    return SIN_QUADRANTS[n](r);
}

/** @param {number} x */
export function cos(x){
    if (!Number.isFinite(x))
    {
        return NaN;
    }
    const { r, n } = reduce(x);
    return COS_QUADRANTS[n](r);
}

/** @param {number} x */
export function tan(x){
    if (!Number.isFinite(x))
    {
        return NaN;
    }
    if (x === 0)
    {
        return x;
    }
    const { r, n } = reduce(x);
    return n % 2 === 0 ? sinKernel(r) / cosKernel(r) : -cosKernel(r) / sinKernel(r);
}

/**
 * atan x for x in [0, 1]: past tan(pi/12) it is moved down by pi/6, then
 * Taylor's series converges fast.
 *
 * @param {number} x
 */
function atanKernel(x){
    let offset = 0;
    let offsetLow = 0;
    let t = x;
    if (t > TAN_PIO12)
    {
        t = (t * SQRT3 - 1) / (SQRT3 + t);
        offset = PIO6;
        offsetLow = PIO6_LO;
    }
    const z = t * t;
    let sum = 0;
    for (let n = 16; n >= 1; n--)
    {
        sum = (1 / (2 * n + 1) - sum) * z;
    }
    return offset + (t * (1 - sum) + offsetLow);
}

/** @param {number} x */
export function atan(x){
    if (Number.isNaN(x))
    {
        return NaN;
    }
    if (x === 0)
    {
        return x;
    }
    const ax = Math.abs(x);
    let result;
    if (ax === Infinity)
    {
        result = PIO2;
    }
    else if (ax > 1)
    {
        result = PIO2 - (atanKernel(1 / ax) - PIO2_LO);
    }
    else
    {
        result = atanKernel(ax);
    }
    return x < 0 ? -result : result;
}

/**
 * atan2 with Math.atan2's answers for the zeros and infinities.
 *
 * @param {number} y @param {number} x
 */
export function atan2(y, x){
    if (Number.isNaN(x) || Number.isNaN(y))
    {
        return NaN;
    }
    const negativeY = y < 0 || Object.is(y, -0);
    const sign = (/** @type {number} */ value)=>(negativeY ? -value : value);
    const negativeX = x < 0 || Object.is(x, -0);
    if (y === 0)
    {
        return negativeX ? sign(PI) : y;
    }
    if (x === 0)
    {
        return sign(PIO2);
    }
    if (!Number.isFinite(x))
    {
        if (!Number.isFinite(y))
        {
            return sign(negativeX ? 3 * PI / 4 : PI / 4);
        }
        return negativeX ? sign(PI) : (negativeY ? -0 : 0);
    }
    if (!Number.isFinite(y))
    {
        return sign(PIO2);
    }
    const base = atan(Math.abs(y / x));
    if (!negativeX)
    {
        return sign(base);
    }
    return sign((PI - base) + PI_LO);
}

/** @param {number} x */
export function asin(x){
    if (Number.isNaN(x) || Math.abs(x) > 1)
    {
        return NaN;
    }
    if (x === 0)
    {
        return x;
    }
    return atan2(x, Math.sqrt((1 - x) * (1 + x)));
}

/** @param {number} x */
export function acos(x){
    if (Number.isNaN(x) || Math.abs(x) > 1)
    {
        return NaN;
    }
    return atan2(Math.sqrt((1 - x) * (1 + x)), x);
}

/** @param {number} x */
export function sinh(x){
    if (Number.isNaN(x) || x === 0)
    {
        return x;
    }
    const ax = Math.abs(x);
    const result = ax < 1 ? (expm1(ax) + expm1(ax) / (expm1(ax) + 1)) / 2
        : ax > 710 ? scale(exp(ax - 2 * LN2), 1) : (exp(ax) - 1 / exp(ax)) / 2;
    return x < 0 ? -result : result;
}

/** @param {number} x */
export function cosh(x){
    if (Number.isNaN(x))
    {
        return NaN;
    }
    const ax = Math.abs(x);
    if (ax > 710)
    {
        return scale(exp(ax - 2 * LN2), 1);
    }
    const e = exp(ax);
    return (e + 1 / e) / 2;
}

/** @param {number} x */
export function tanh(x){
    if (Number.isNaN(x) || x === 0)
    {
        return x;
    }
    const ax = Math.abs(x);
    let result;
    if (ax > 22)
    {
        result = 1;
    }
    else
    {
        const e = expm1(2 * ax);
        result = e / (e + 2);
    }
    return x < 0 ? -result : result;
}

const floatScratch = new DataView(new ArrayBuffer(4));

/**
 * A float's bits as the compiler writes them. ECMAScript lets a NaN stored
 * into a float32 take any NaN pattern, and x86 and ARM engines differ in the
 * sign; one quiet NaN is written for all of them.
 *
 * @param {number} value
 */
export function float32Bits(value){
    if (Number.isNaN(value))
    {
        return 0x7fc00000;
    }
    floatScratch.setFloat32(0, value, true);
    return floatScratch.getUint32(0, true);
}
