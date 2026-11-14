/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C runtime's mathematics as code in the guest's own msvcrt, written
 * once: each `@guestCode` function here is compiled by the build
 * (`scripts/guest-code/compile.mjs`) into `inguest-math.x86.js`, and is
 * itself the export's handler and the reference its x86 is held to.
 *
 * The runtime a program links computes on the x87, under the precision
 * control the program set -- a program under Direct3D computes its square
 * roots and its exponentials to 24 bits -- and so does this: each function
 * is the x87's instructions for it, and never touches the precision
 * control. A case the runtime answers with errno -- a square root of a
 * negative, a logarithm of zero, a result past a double's range -- is the
 * host handler's (`math.js`), which answers it as it answered every call
 * before, and sets errno; `return host()` hands it the call as it came.
 *
 * Where the x87's own sequence is not JavaScript's under an engine's f64
 * x87 -- the power of two `exp` scales by, the logarithms -- the function is
 * written with the instructions it is made of (`X87`), so the handler
 * computes what the x86 does. `exp` reduces its argument as Cody and Waite
 * do, by ln 2 in two parts, where the runtime multiplies by log2(e) in the
 * x87's 64 bits: in a double's 53 that product alone costs up to two
 * hundred units in the last place, where the reduction costs one. `pow`
 * answers what is exact in any precision -- the square, the square root,
 * the argument, its reciprocal, one -- and leaves the rest to the handler:
 * 2^(y log2 x) in doubles is not the power a program gets on Windows
 * (pow(10, 2) came to 99.99999999999997 that way).
 */

import { X87 } from './x87.js';

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').f64} f64 */
/** @typedef {import('./guest-code.js').f32} f32 */
/** @typedef {import('./guest-code.js').x87} x87 */
/** @typedef {import('./guest-code.js').i32} i32 */
/** @typedef {import('./guest-code.js').u32} u32 */

/** The largest double: a result above it is an overflow. */
const MAX = 1.7976931348623157e308;

/** Where `fsin`, `fcos` and `fptan` stop reducing their argument. */
const REDUCED = 2 ** 63;

/** Beyond it e^x leaves the normal doubles, one way or the other. */
const EXP_RANGE = 708;

/** ln 2 in two parts, the first's 32 bits making n times it exact for |n| below 2^21. */
const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;

/**
 * log10(2), the double nearest it, as `fldlg2` loads it.
 */
const LOG10_2 = 0.3010299956639812;

/** Below it 2^(x log2 e) - 1 is `f2xm1`'s own, x log2 e being under 1. */
const EXPM1_RANGE = 0.69;

/**
 * e^x for |x| below EXP_RANGE, n the nearest integer to x log2(e): the
 * remainder x - n ln 2 taken in two parts, 2 to its measure less one by
 * `f2xm1`, one added, and n applied by `fscale`.
 */
const scaled = (/** @type {number} */ x, /** @type {number} */ n)=>
    X87.scale(X87.f2xm1(((x - n * LN2_HI) - n * LN2_LO) * X87.L2E) + 1, n);

/** e^x for |x| below EXP_RANGE. */
const expOf = (/** @type {number} */ x)=>scaled(x, X87.rint(x * X87.L2E));

/** Below it in magnitude 2^t is a normal double. */
const POW_RANGE = 1022;

/** From it on in magnitude every double is a whole even number. */
const WHOLE = 2 ** 53;

/**
 * Whole powers below it in magnitude are taken by squaring in two doubles:
 * 32 squarings at most.
 */
const POWER_STEPS = 2 ** 32;

/** Veltkamp's constant: a double times it splits into halves whose products are exact. */
const SPLIT = 134217729;

/** A double's upper 26 bits, by Veltkamp's split. */
const highOf = (/** @type {number} */ a)=>SPLIT * a - (SPLIT * a - a);

/** A positive's exponent, `fxtract`'s: scaled by its negative, it is in [1, 2). */
const exponentOf = (/** @type {number} */ a)=>X87.exponent(a);

/** 2^t, n the nearest integer to t: `f2xm1` of the rest, one added, and n applied by `fscale`. */
const twoTo = (/** @type {number} */ t, /** @type {number} */ n)=>X87.scale(X87.f2xm1(t - n) + 1, n);

/** 2^t for |t| below POW_RANGE. */
const pow2Of = (/** @type {number} */ t)=>twoTo(t, X87.rint(t));

/** e^a - 1 for a in [0, EXP_RANGE): `f2xm1` where it reaches, e^a less one above it. */
const expm1Of = (/** @type {number} */ a)=>(a < EXPM1_RANGE ? X87.f2xm1(a * X87.L2E)
    : expOf(a) - 1);

/** asin as the runtime computes it: atan2(x, sqrt((1 + x)(1 - x))). */
const asinOf = (/** @type {number} */ x)=>Math.atan2(x, Math.sqrt((1 + x) * (1 - x)));

/** acos: atan2(sqrt((1 + x)(1 - x)), x). */
const acosOf = (/** @type {number} */ x)=>Math.atan2(Math.sqrt((1 + x) * (1 - x)), x);

/** sinh of |x| from e^|x| - 1: (E + E / (E + 1)) / 2, which keeps a small one's digits. */
const sinhOf = (/** @type {number} */ e)=>(e + e / (e + 1)) / 2;

/** tanh of |x| from e^2|x| - 1. */
const tanhOf = (/** @type {number} */ e)=>e / (e + 2);

/** cosh from e^|x|. */
const coshOf = (/** @type {number} */ e)=>(e + 1 / e) / 2;

/**
 * double sqrt(double x) -- `fsqrt`; a negative, -Infinity among them, the
 * handler's (EDOM).
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function sqrt({ host }, x){
    if (x < 0)
    {
        return host();
    }
    return Math.sqrt(x);
}

/**
 * _CIsqrt: sqrt of ST0, into ST0.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIsqrt({ host }, x){
    if (x < 0)
    {
        return host();
    }
    return Math.sqrt(x);
}

/**
 * double sin(double x) -- `fsin`; past its reduction, an infinity (EDOM)
 * and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function sin({ host }, x){
    if (!(Math.abs(x) < REDUCED))
    {
        return host();
    }
    return Math.sin(x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIsin({ host }, x){
    if (!(Math.abs(x) < REDUCED))
    {
        return host();
    }
    return Math.sin(x);
}

/**
 * double cos(double x) -- `fcos`, as sin.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function cos({ host }, x){
    if (!(Math.abs(x) < REDUCED))
    {
        return host();
    }
    return Math.cos(x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIcos({ host }, x){
    if (!(Math.abs(x) < REDUCED))
    {
        return host();
    }
    return Math.cos(x);
}

/**
 * double tan(double x) -- `fptan`, as sin.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function tan({ host }, x){
    if (!(Math.abs(x) < REDUCED))
    {
        return host();
    }
    return Math.tan(x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CItan({ host }, x){
    if (!(Math.abs(x) < REDUCED))
    {
        return host();
    }
    return Math.tan(x);
}

/**
 * double asin(double x) -- `fpatan` of x and sqrt((1 + x)(1 - x)); past
 * +-1 the handler's (EDOM).
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function asin({ host }, x){
    if (Math.abs(x) > 1)
    {
        return host();
    }
    return asinOf(x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIasin({ host }, x){
    if (Math.abs(x) > 1)
    {
        return host();
    }
    return asinOf(x);
}

/**
 * double acos(double x) -- as asin, the two exchanged.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function acos({ host }, x){
    if (Math.abs(x) > 1)
    {
        return host();
    }
    return acosOf(x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIacos({ host }, x){
    if (Math.abs(x) > 1)
    {
        return host();
    }
    return acosOf(x);
}

/**
 * double atan(double x) -- `fpatan` of x and 1; a NaN the handler's (EDOM).
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function atan({ host }, x){
    if (Number.isNaN(x))
    {
        return host();
    }
    return Math.atan(x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIatan({ host }, x){
    if (Number.isNaN(x))
    {
        return host();
    }
    return Math.atan(x);
}

/**
 * double atan2(double y, double x) -- `fpatan`.
 *
 * @guestCode cdecl
 * @param {f64} y @param {f64} x
 * @returns {f64}
 */
export function atan2(y, x){
    return Math.atan2(y, x);
}

/**
 * _CIatan2: ST1 the y, ST0 the x, pushed in that order.
 *
 * @guestCode cdecl
 * @param {x87} y @param {x87} x
 * @returns {f64}
 */
export function _CIatan2(y, x){
    return Math.atan2(y, x);
}

/**
 * double exp(double x) -- e^x below EXP_RANGE in magnitude; beyond it, where
 * the result overflows (ERANGE) or leaves the normal doubles, and an
 * infinity or a NaN, the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function exp({ host }, x){
    if (!(Math.abs(x) < EXP_RANGE))
    {
        return host();
    }
    return expOf(x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIexp({ host }, x){
    if (!(Math.abs(x) < EXP_RANGE))
    {
        return host();
    }
    return expOf(x);
}

/**
 * double log(double x) -- `fyl2x` of ln 2 and x; zero (ERANGE), a negative
 * (EDOM) and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function log({ host }, x){
    if (!(x > 0))
    {
        return host();
    }
    return X87.yl2x(X87.LN2, x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIlog({ host }, x){
    if (!(x > 0))
    {
        return host();
    }
    return X87.yl2x(X87.LN2, x);
}

/**
 * double log10(double x) -- `fyl2x` of log10(2) and x, as log.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function log10({ host }, x){
    if (!(x > 0))
    {
        return host();
    }
    return X87.yl2x(LOG10_2, x);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIlog10({ host }, x){
    if (!(x > 0))
    {
        return host();
    }
    return X87.yl2x(LOG10_2, x);
}

/**
 * double pow(double x, double y) -- the powers exact in any precision: x
 * squared, the square root of a positive, x itself, its reciprocal, and 1
 * for a y of zero; any other finite power of a finite base but zero by the
 * x87's logarithm and exponent; a result past the normal doubles (ERANGE),
 * a negative to a fraction (EDOM), zero, an infinity and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function pow({ host }, x, y){
    if (y === 2)
    {
        const square = x * x;
        if (square <= MAX)
        {
            return square;
        }
        return host();
    }
    if (y === 0.5 && x > 0 && x <= MAX)
    {
        return Math.sqrt(x);
    }
    if (y === 0.5 && x === 0)
    {
        return 0;
    }
    if (y === 1 && !Number.isNaN(x))
    {
        return x;
    }
    if (y === -1)
    {
        const reciprocal = 1 / x;
        if (Math.abs(reciprocal) <= MAX)
        {
            return reciprocal;
        }
        return host();
    }
    if (y === 0 && !Number.isNaN(x))
    {
        return 1;
    }
    // A whole power of a finite base but zero, by squaring in two doubles,
    // hi + lo times 2^e, brought back into [1, 2) after each product so neither
    // overflows on the way: what the runtime's x87 gets in its 64 bits, where
    // 2 to y log2 x in doubles is hundreds of units in the last place out
    // (10^100). A result past the normal doubles is the handler's.
    if (Math.floor(y) === y && Math.abs(y) < POWER_STEPS && x !== 0 && Math.abs(x) <= MAX)
    {
        const magnitude = Math.abs(x);
        const k0 = exponentOf(magnitude);
        let bh = X87.scale(magnitude, -k0);
        /** @type {f64} */
        let bl = 0;
        /** @type {f64} */
        let be = k0;
        /** @type {f64} */
        let rh = 1;
        /** @type {f64} */
        let rl = 0;
        /** @type {f64} */
        let re = 0;
        /** @type {f64} */
        let n = Math.abs(y);
        const odd = n - 2 * Math.floor(n * 0.5);
        while (n > 0)
        {
            const half = Math.floor(n * 0.5);
            if (n - 2 * half === 1)
            {
                const p = rh * bh;
                // What rh times bh lost when rounded to p, exactly (Dekker), a step a line.
                const ah = highOf(rh);
                const al = rh - ah;
                const bh2 = highOf(bh);
                const bl2 = bh - bh2;
                const lost = (((ah * bh2 - p) + ah * bl2) + al * bh2) + al * bl2;
                const e = lost + (rh * bl + rl * bh);
                const h = p + e;
                const k = exponentOf(h);
                rh = X87.scale(h, -k);
                rl = X87.scale(e - (h - p), -k);
                re = re + be + k;
            }
            n = half;
            if (n > 0)
            {
                const p = bh * bh;
                // What bh times bh lost when rounded to p, exactly (Dekker), a step a line.
                const ah = highOf(bh);
                const al = bh - ah;
                const bh2 = highOf(bh);
                const bl2 = bh - bh2;
                const lost = (((ah * bh2 - p) + ah * bl2) + al * bh2) + al * bl2;
                const e = lost + 2 * bh * bl;
                const h = p + e;
                const k = exponentOf(h);
                bh = X87.scale(h, -k);
                bl = X87.scale(e - (h - p), -k);
                be = be + be + k;
            }
        }
        if (y < 0)
        {
            // 1 / (rh + rl): a first quotient, and its correction from what
            // it leaves of one, taken exactly.
            const q = 1 / rh;
            const p = q * rh;
            // What q times rh lost when rounded to p, exactly (Dekker), a step a line.
            const ah = highOf(q);
            const al = q - ah;
            const bh2 = highOf(rh);
            const bl2 = rh - bh2;
            const lost = (((ah * bh2 - p) + ah * bl2) + al * bh2) + al * bl2;
            const r = ((1 - p) - lost) - q * rl;
            rh = q + q * r;
            rl = 0;
            re = -re;
        }
        // The significand rounded once, and the power normal only if its
        // exponent, that rounding's included, is a normal double's.
        const significand = rh + rl;
        const exponent = re + exponentOf(significand);
        if (exponent < -1022 || exponent > 1023)
        {
            return host();
        }
        const power = X87.scale(significand, re);
        if (x < 0 && odd === 1)
        {
            return -power;
        }
        return power;
    }
    // Any other finite power of a finite base but zero, as the runtime takes
    // it: 2 to y log2|x|, by `fyl2x`, `f2xm1` and `fscale`; a negative base
    // to a whole power, the sign an odd power gives. A result that leaves the
    // normal doubles, a negative base to a fraction (EDOM), zero, an infinity
    // and a NaN are the handler's.
    if (!(Math.abs(y) <= MAX))
    {
        return host();
    }
    if (x > 0 && x <= MAX)
    {
        const t = X87.yl2x(y, x);
        if (Math.abs(t) < POW_RANGE)
        {
            return pow2Of(t);
        }
        return host();
    }
    if (x < 0 && x >= -MAX && (Math.abs(y) >= WHOLE || Math.floor(y) === y))
    {
        const t = X87.yl2x(y, -x);
        if (Math.abs(t) < POW_RANGE)
        {
            const r = pow2Of(t);
            if (Math.abs(y) < WHOLE && y % 2 !== 0)
            {
                return -r;
            }
            return r;
        }
        return host();
    }
    return host();
}

/**
 * _CIpow: ST1 the x, ST0 the y.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x @param {x87} y
 * @returns {f64}
 */
export function _CIpow({ host }, x, y){
    if (y === 2)
    {
        const square = x * x;
        if (square <= MAX)
        {
            return square;
        }
        return host();
    }
    if (y === 0.5 && x > 0 && x <= MAX)
    {
        return Math.sqrt(x);
    }
    if (y === 0.5 && x === 0)
    {
        return 0;
    }
    if (y === 1 && !Number.isNaN(x))
    {
        return x;
    }
    if (y === -1)
    {
        const reciprocal = 1 / x;
        if (Math.abs(reciprocal) <= MAX)
        {
            return reciprocal;
        }
        return host();
    }
    if (y === 0 && !Number.isNaN(x))
    {
        return 1;
    }
    // A whole power of a finite base but zero, by squaring in two doubles,
    // hi + lo times 2^e, brought back into [1, 2) after each product so neither
    // overflows on the way: what the runtime's x87 gets in its 64 bits, where
    // 2 to y log2 x in doubles is hundreds of units in the last place out
    // (10^100). A result past the normal doubles is the handler's.
    if (Math.floor(y) === y && Math.abs(y) < POWER_STEPS && x !== 0 && Math.abs(x) <= MAX)
    {
        const magnitude = Math.abs(x);
        const k0 = exponentOf(magnitude);
        let bh = X87.scale(magnitude, -k0);
        /** @type {f64} */
        let bl = 0;
        /** @type {f64} */
        let be = k0;
        /** @type {f64} */
        let rh = 1;
        /** @type {f64} */
        let rl = 0;
        /** @type {f64} */
        let re = 0;
        /** @type {f64} */
        let n = Math.abs(y);
        const odd = n - 2 * Math.floor(n * 0.5);
        while (n > 0)
        {
            const half = Math.floor(n * 0.5);
            if (n - 2 * half === 1)
            {
                const p = rh * bh;
                // What rh times bh lost when rounded to p, exactly (Dekker), a step a line.
                const ah = highOf(rh);
                const al = rh - ah;
                const bh2 = highOf(bh);
                const bl2 = bh - bh2;
                const lost = (((ah * bh2 - p) + ah * bl2) + al * bh2) + al * bl2;
                const e = lost + (rh * bl + rl * bh);
                const h = p + e;
                const k = exponentOf(h);
                rh = X87.scale(h, -k);
                rl = X87.scale(e - (h - p), -k);
                re = re + be + k;
            }
            n = half;
            if (n > 0)
            {
                const p = bh * bh;
                // What bh times bh lost when rounded to p, exactly (Dekker), a step a line.
                const ah = highOf(bh);
                const al = bh - ah;
                const bh2 = highOf(bh);
                const bl2 = bh - bh2;
                const lost = (((ah * bh2 - p) + ah * bl2) + al * bh2) + al * bl2;
                const e = lost + 2 * bh * bl;
                const h = p + e;
                const k = exponentOf(h);
                bh = X87.scale(h, -k);
                bl = X87.scale(e - (h - p), -k);
                be = be + be + k;
            }
        }
        if (y < 0)
        {
            // 1 / (rh + rl): a first quotient, and its correction from what
            // it leaves of one, taken exactly.
            const q = 1 / rh;
            const p = q * rh;
            // What q times rh lost when rounded to p, exactly (Dekker), a step a line.
            const ah = highOf(q);
            const al = q - ah;
            const bh2 = highOf(rh);
            const bl2 = rh - bh2;
            const lost = (((ah * bh2 - p) + ah * bl2) + al * bh2) + al * bl2;
            const r = ((1 - p) - lost) - q * rl;
            rh = q + q * r;
            rl = 0;
            re = -re;
        }
        // The significand rounded once, and the power normal only if its
        // exponent, that rounding's included, is a normal double's.
        const significand = rh + rl;
        const exponent = re + exponentOf(significand);
        if (exponent < -1022 || exponent > 1023)
        {
            return host();
        }
        const power = X87.scale(significand, re);
        if (x < 0 && odd === 1)
        {
            return -power;
        }
        return power;
    }
    // Any other finite power of a finite base but zero, as the runtime takes
    // it: 2 to y log2|x|, by `fyl2x`, `f2xm1` and `fscale`; a negative base
    // to a whole power, the sign an odd power gives. A result that leaves the
    // normal doubles, a negative base to a fraction (EDOM), zero, an infinity
    // and a NaN are the handler's.
    if (!(Math.abs(y) <= MAX))
    {
        return host();
    }
    if (x > 0 && x <= MAX)
    {
        const t = X87.yl2x(y, x);
        if (Math.abs(t) < POW_RANGE)
        {
            return pow2Of(t);
        }
        return host();
    }
    if (x < 0 && x >= -MAX && (Math.abs(y) >= WHOLE || Math.floor(y) === y))
    {
        const t = X87.yl2x(y, -x);
        if (Math.abs(t) < POW_RANGE)
        {
            const r = pow2Of(t);
            if (Math.abs(y) < WHOLE && y % 2 !== 0)
            {
                return -r;
            }
            return r;
        }
        return host();
    }
    return host();
}

/**
 * double fmod(double x, double y) -- `fprem` until the remainder is whole:
 * x's sign, exact; a zero y or an infinite x NaN.
 *
 * @guestCode cdecl
 * @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function fmod(x, y){
    return x % y;
}

/**
 * @guestCode cdecl
 * @param {x87} x @param {x87} y
 * @returns {f64}
 */
export function _CIfmod(x, y){
    return x % y;
}

/**
 * double sinh(double x) -- from e^|x| - 1, the sign put back; below
 * EXP_RANGE in magnitude, the rest -- an overflow (ERANGE) -- the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function sinh({ host }, x){
    if (!(Math.abs(x) < EXP_RANGE))
    {
        return host();
    }
    if (x === 0)
    {
        return x;
    }
    const s = sinhOf(expm1Of(Math.abs(x)));
    return x < 0 ? -s : s;
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIsinh({ host }, x){
    if (!(Math.abs(x) < EXP_RANGE))
    {
        return host();
    }
    if (x === 0)
    {
        return x;
    }
    const s = sinhOf(expm1Of(Math.abs(x)));
    return x < 0 ? -s : s;
}

/**
 * double cosh(double x) -- (e^|x| + e^-|x|) / 2, as sinh.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function cosh({ host }, x){
    if (!(Math.abs(x) < EXP_RANGE))
    {
        return host();
    }
    return coshOf(expOf(Math.abs(x)));
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CIcosh({ host }, x){
    if (!(Math.abs(x) < EXP_RANGE))
    {
        return host();
    }
    return coshOf(expOf(Math.abs(x)));
}

/**
 * double tanh(double x) -- (e^2|x| - 1) / (e^2|x| + 1), the sign put back;
 * 1 from 22 on, where the difference from 1 is below a double's reach; a
 * NaN the handler's (EDOM).
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function tanh({ host }, x){
    if (Number.isNaN(x))
    {
        return host();
    }
    if (!(Math.abs(x) < 22))
    {
        return x < 0 ? -1 : 1;
    }
    if (x === 0)
    {
        return x;
    }
    const t = tanhOf(expm1Of(2 * Math.abs(x)));
    return x < 0 ? -t : t;
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x
 * @returns {f64}
 */
export function _CItanh({ host }, x){
    if (Number.isNaN(x))
    {
        return host();
    }
    if (!(Math.abs(x) < 22))
    {
        return x < 0 ? -1 : 1;
    }
    if (x === 0)
    {
        return x;
    }
    const t = tanhOf(expm1Of(2 * Math.abs(x)));
    return x < 0 ? -t : t;
}

/**
 * double _hypot(double x, double y) -- the larger magnitude times the
 * square root of one and the smaller's ratio to it squared, which
 * overflows only where the result does; an infinity or a NaN, and an
 * overflow (ERANGE), the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function _hypot({ host }, x, y){
    const a = Math.abs(x);
    const b = Math.abs(y);
    if (!(a <= MAX) || !(b <= MAX))
    {
        return host();
    }
    const large = a > b ? a : b;
    if (large === 0)
    {
        return 0;
    }
    const ratio = (a > b ? b : a) / large;
    const length = large * Math.sqrt(1 + ratio * ratio);
    if (length <= MAX)
    {
        return length;
    }
    return host();
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {x87} x @param {x87} y
 * @returns {f64}
 */
export function _CI_hypot({ host }, x, y){
    const a = Math.abs(x);
    const b = Math.abs(y);
    if (!(a <= MAX) || !(b <= MAX))
    {
        return host();
    }
    const large = a > b ? a : b;
    if (large === 0)
    {
        return 0;
    }
    const ratio = (a > b ? b : a) / large;
    const length = large * Math.sqrt(1 + ratio * ratio);
    if (length <= MAX)
    {
        return length;
    }
    return host();
}

/**
 * double ldexp(double x, int exponent) -- `fscale`, exact but where the
 * result leaves the normal doubles; an overflow of a finite x (ERANGE) the
 * handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x @param {i32} exponent
 * @returns {f64}
 */
export function ldexp({ host }, x, exponent){
    const scaledBy = X87.scale(x, exponent);
    if (Math.abs(scaledBy) <= MAX || !(Math.abs(x) <= MAX))
    {
        return scaledBy;
    }
    return host();
}

/**
 * double frexp(double x, int *exponent) -- `fxtract`: the significand
 * halved into [0.5, 1) and the exponent one up; zero, an infinity and a NaN
 * answer themselves and an exponent of 0.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x @param {u32} exponent
 * @returns {f64}
 */
export function frexp({ setU32 }, x, exponent){
    if (x === 0 || !(Math.abs(x) <= MAX))
    {
        setU32(exponent, 0);
        return x;
    }
    setU32(exponent, (X87.exponent(x) + 1) | 0);
    return X87.significand(x) / 2;
}

/**
 * double modf(double x, double *whole) -- the whole part truncated, both
 * parts with x's sign but a zero fraction's, which is x less its whole.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x @param {u32} whole
 * @returns {f64}
 */
export function modf({ setF64 }, x, whole){
    const truncated = Math.trunc(x);
    setF64(whole, truncated);
    return x - truncated;
}

/**
 * _CIfabs, _CIfloor and _CIceil: the x87's forms of fabs, floor and ceil,
 * which the runtime's handlers answered as well.
 *
 * @guestCode cdecl
 * @param {x87} x
 * @returns {f64}
 */
export function _CIfabs(x){
    return Math.abs(x);
}

/**
 * @guestCode cdecl
 * @param {x87} x
 * @returns {f64}
 */
export function _CIfloor(x){
    return Math.floor(x);
}

/**
 * @guestCode cdecl
 * @param {x87} x
 * @returns {f64}
 */
export function _CIceil(x){
    return Math.ceil(x);
}

/**
 * sinhf, coshf, tanhf and log10f, a 64-bit runtime's: the double form's way
 * on the float, rounded to a float as the host's handler rounds the double
 * answer (no float of the 2e6 compared rounds apart from Math's); what the
 * double form leaves to its handler, theirs.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function sinhf({ host }, x){
    if (!(Math.abs(x) < EXP_RANGE))
    {
        return host();
    }
    if (x === 0)
    {
        return Math.fround(x);
    }
    const s = sinhOf(expm1Of(Math.abs(x)));
    return Math.fround(x < 0 ? -s : s);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function coshf({ host }, x){
    if (!(Math.abs(x) < EXP_RANGE))
    {
        return host();
    }
    return Math.fround(coshOf(expOf(Math.abs(x))));
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function tanhf({ host }, x){
    if (Number.isNaN(x))
    {
        return host();
    }
    if (!(Math.abs(x) < 22))
    {
        return Math.fround(x < 0 ? -1 : 1);
    }
    if (x === 0)
    {
        return Math.fround(x);
    }
    const t = tanhOf(expm1Of(2 * Math.abs(x)));
    return Math.fround(x < 0 ? -t : t);
}

/**
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function log10f({ host }, x){
    if (!(x > 0))
    {
        return host();
    }
    return Math.fround(X87.yl2x(LOG10_2, x));
}

/** The largest float, and the least normal one: a power past them is the handler's. */
const FLOAT_MAX = 3.4028234663852886e38;
const FLOAT_LEAST = 2 ** -126;

/**
 * How near halfway between two floats, as a share of the power, a double
 * computed as powf computes it may lie and still round as x^y does: its error
 * is under 2^-45 of it (y log2 x is below 2^8 in magnitude, its rounding
 * under 2^-45 absolute), and a double nearer halfway may be on the wrong side.
 */
const FLOAT_HALFWAY = 2 ** -36;

/**
 * float powf(float x, float y), a 64-bit runtime's: a positive base to a
 * finite power as 2^(y log2 x) in doubles, rounded to a float -- the float
 * nearest x^y, which is the host's float of its double answer, wherever the
 * double lies farther than FLOAT_HALFWAY from halfway between two floats
 * (x^y exactly halfway, as the square of a float of 13 bits is, and those
 * near it are the handler's); a base of zero or below, a power past the
 * normal floats and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x @param {f32} y
 * @returns {f32}
 */
export function powf({ host }, x, y){
    if (!(x > 0 && x <= FLOAT_MAX && Math.abs(y) <= FLOAT_MAX))
    {
        return host();
    }
    const power = pow2Of(X87.yl2x(y, x));
    if (!(power >= FLOAT_LEAST && power <= FLOAT_MAX))
    {
        return host();
    }
    const nearest = Math.fround(power);
    const past = power - nearest;
    const e = exponentOf(nearest);
    // Half a unit in the last place above the float, and below it: half
    // that below a power of two.
    const up = X87.scale(1, e - 24);
    const down = X87.scale(nearest, -e) === 1 ? up * 0.5 : up;
    const room = past >= 0 ? up - past : down + past;
    if (room < power * FLOAT_HALFWAY)
    {
        return host();
    }
    return nearest;
}

/*
 * C99's rounding and comparing functions, the UCRT's. Each is made of the
 * operations exact at any x87 precision -- floor and ceil (`frndint`), the
 * remainder (`fprem`), comparisons, `fabs`, `fchs` and the bits -- so a
 * program that set the x87 to single precision, as Direct3D does, gets what
 * the runtime's SSE2 code gives it; no sum or difference rounds on the way.
 */

/** From it on in magnitude a double, or a float, is whole: rounding leaves it be. */
const ALL_WHOLE = 2 ** 52;

/** |x| rounded half away from zero, for |x| below ALL_WHOLE. */
const roundedMagnitude = (/** @type {number} */ a)=>(a % 1 >= 0.5 ? Math.ceil(a) : Math.floor(a));

/**
 * double round(double x) -- half away from zero, the sign of a zero kept.
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'doubleHigh'>} guest @param {f64} x
 * @returns {f64}
 */
export function round({ doubleHigh }, x){
    const a = Math.abs(x);
    if (!(a < ALL_WHOLE))
    {
        return x;
    }
    const whole = roundedMagnitude(a);
    return (doubleHigh(x) | 0) < 0 ? -whole : whole;
}

/**
 * float roundf(float x)
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'floatBits'>} guest @param {f32} x
 * @returns {f32}
 */
export function roundf({ floatBits }, x){
    const a = Math.abs(x);
    if (!(a < ALL_WHOLE))
    {
        return Math.fround(x);
    }
    const whole = roundedMagnitude(a);
    return Math.fround((floatBits(x) | 0) < 0 ? -whole : whole);
}

/**
 * double trunc(double x) -- toward zero.
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function trunc(x){
    return x < 0 ? Math.ceil(x) : Math.floor(x);
}

/**
 * float truncf(float x)
 *
 * @guestCode cdecl
 * @param {f32} x
 * @returns {f32}
 */
export function truncf(x){
    return Math.fround(x < 0 ? Math.ceil(x) : Math.floor(x));
}

/**
 * long lround(double x) -- rounded half away from zero; a NaN or a value no
 * long holds is the handler's (0 and EDOM).
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {i32}
 */
export function lround({ host }, x){
    const a = Math.abs(x);
    if (!(a < 2147483648))
    {
        return host();
    }
    const whole = roundedMagnitude(a);
    if (x < 0)
    {
        return (-whole) | 0;
    }
    if (whole > 2147483647)
    {
        return host();
    }
    return whole | 0;
}

/**
 * long lroundf(float x)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {i32}
 */
export function lroundf({ host }, x){
    const a = Math.abs(x);
    if (!(a < 2147483648))
    {
        return host();
    }
    const whole = roundedMagnitude(a);
    if (x < 0)
    {
        return (-whole) | 0;
    }
    if (whole > 2147483647)
    {
        return host();
    }
    return whole | 0;
}

/**
 * double copysign(double x, double y) -- x's magnitude, y's sign bit.
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'doubleHigh'>} guest @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function copysign({ doubleHigh }, x, y){
    const magnitude = Math.abs(x);
    return (doubleHigh(y) | 0) < 0 ? -magnitude : magnitude;
}

/**
 * float copysignf(float x, float y)
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'floatBits'>} guest @param {f32} x @param {f32} y
 * @returns {f32}
 */
export function copysignf({ floatBits }, x, y){
    const magnitude = Math.abs(x);
    return Math.fround((floatBits(y) | 0) < 0 ? -magnitude : magnitude);
}

/**
 * double fmax(double x, double y) -- a NaN loses to a number; of two zeros
 * the positive.
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'doubleHigh'>} guest @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function fmax({ doubleHigh }, x, y){
    if (Number.isNaN(x))
    {
        return y;
    }
    if (Number.isNaN(y))
    {
        return x;
    }
    if (x === y)
    {
        return (doubleHigh(x) | 0) < 0 ? y : x;
    }
    return x > y ? x : y;
}

/**
 * double fmin(double x, double y) -- a NaN loses to a number; of two zeros
 * the negative.
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'doubleHigh'>} guest @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function fmin({ doubleHigh }, x, y){
    if (Number.isNaN(x))
    {
        return y;
    }
    if (Number.isNaN(y))
    {
        return x;
    }
    if (x === y)
    {
        return (doubleHigh(x) | 0) < 0 ? x : y;
    }
    return x < y ? x : y;
}

/**
 * float fmaxf(float x, float y)
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'floatBits'>} guest @param {f32} x @param {f32} y
 * @returns {f32}
 */
export function fmaxf({ floatBits }, x, y){
    if (Number.isNaN(x))
    {
        return Math.fround(y);
    }
    if (Number.isNaN(y))
    {
        return Math.fround(x);
    }
    if (x === y)
    {
        return Math.fround((floatBits(x) | 0) < 0 ? y : x);
    }
    return Math.fround(x > y ? x : y);
}

/**
 * float fminf(float x, float y)
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'floatBits'>} guest @param {f32} x @param {f32} y
 * @returns {f32}
 */
export function fminf({ floatBits }, x, y){
    if (Number.isNaN(x))
    {
        return Math.fround(y);
    }
    if (Number.isNaN(y))
    {
        return Math.fround(x);
    }
    if (x === y)
    {
        return Math.fround((floatBits(x) | 0) < 0 ? x : y);
    }
    return Math.fround(x < y ? x : y);
}

/** From it on in magnitude asinh and acosh are ln 2 past ln |x|: the rest is below a double's reach. */
const HYPERBOLIC_LARGE = 2 ** 28;

/** Below it e^x - 1 is -1 to the double: e^x is under half its last place. */
const EXPM1_FLOOR = -40;

/** The float range 2^x stays normal in. */
const FLOAT_EXP2_RANGE = 126;

/**
 * ln(1 + a) for a above -1, u being 1 + a rounded: ln u scaled by a / (u - 1),
 * which puts back what the rounding of u lost (Goldberg's way); a itself where
 * u rounds to 1.
 */
const log1pFrom = (/** @type {number} */ a, /** @type {number} */ u)=>(u === 1 ? a
    : X87.yl2x(X87.LN2, u) * (a / (u - 1)));

/** ln(1 + a) for a above -1. */
const log1pOf = (/** @type {number} */ a)=>log1pFrom(a, 1 + a);

/** What asinh takes log1p of for a below HYPERBOLIC_LARGE: a + a^2 / (1 + sqrt(1 + a^2)). */
const asinhArgument = (/** @type {number} */ a, /** @type {number} */ root)=>a
    + a * a / (1 + root);

/** acosh of 1 + t, t not negative: ln(1 + t + sqrt(2t + t^2)). */
const acoshNear = (/** @type {number} */ t)=>log1pOf(t + Math.sqrt(2 * t + t * t));

/** acosh of x, x finite and at least 1. */
const acoshOf = (/** @type {number} */ x)=>(x < HYPERBOLIC_LARGE ? acoshNear(x - 1)
    : X87.yl2x(X87.LN2, x) + X87.LN2);

/** What atanh takes half the log1p of, for a in [0, 1). */
const atanhArgument = (/** @type {number} */ a)=>2 * a / (1 - a);

/** e^x - 1 for x below EXP_RANGE and not a NaN. */
const expm1Signed = (/** @type {number} */ x)=>(x < EXPM1_FLOOR ? -1
    : Math.abs(x) < EXPM1_RANGE ? X87.f2xm1(x * X87.L2E) : expOf(x) - 1);

/**
 * double log2(double x) -- `fyl2x` of 1 and x; zero, a negative, an infinity
 * and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function log2({ host }, x){
    if (!(x > 0 && x <= MAX))
    {
        return host();
    }
    return X87.yl2x(1, x);
}

/**
 * float log2f(float x), as log2.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function log2f({ host }, x){
    if (!(x > 0 && x <= MAX))
    {
        return host();
    }
    return Math.fround(X87.yl2x(1, x));
}

/**
 * double exp2(double x) -- 2^x by `f2xm1` and `fscale`, a whole x exact; past
 * the normal doubles, an infinity and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function exp2({ host }, x){
    if (!(Math.abs(x) < POW_RANGE))
    {
        return host();
    }
    return pow2Of(x);
}

/**
 * float exp2f(float x), as exp2 within the normal floats.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function exp2f({ host }, x){
    if (!(Math.abs(x) < FLOAT_EXP2_RANGE))
    {
        return host();
    }
    return Math.fround(pow2Of(x));
}

/**
 * double log1p(double x) -- ln(1 + x) (`log1pOf`); -1 and below, an infinity
 * and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function log1p({ host }, x){
    if (!(x > -1 && x <= MAX))
    {
        return host();
    }
    return log1pOf(x);
}

/**
 * float log1pf(float x), as log1p.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function log1pf({ host }, x){
    if (!(x > -1 && x <= MAX))
    {
        return host();
    }
    return Math.fround(log1pOf(x));
}

/**
 * double expm1(double x) -- e^x - 1: `f2xm1` near zero, e^x less one beyond,
 * -1 far below; EXP_RANGE and above (an overflow there) and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function expm1({ host }, x){
    if (!(x < EXP_RANGE))
    {
        return host();
    }
    return expm1Signed(x);
}

/**
 * float expm1f(float x), as expm1.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function expm1f({ host }, x){
    if (!(x < EXP_RANGE))
    {
        return host();
    }
    return Math.fround(expm1Signed(x));
}

/**
 * double asinh(double x) -- ln(|x| + sqrt(x^2 + 1)) by log1p, the sign put
 * back; an infinity and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function asinh({ host }, x){
    if (!(Math.abs(x) <= MAX))
    {
        return host();
    }
    if (x === 0)
    {
        return x;
    }
    const a = Math.abs(x);
    if (!(a < HYPERBOLIC_LARGE))
    {
        const large = X87.yl2x(X87.LN2, a) + X87.LN2;
        return x < 0 ? -large : large;
    }
    const root = Math.sqrt(1 + a * a);
    const v = asinhArgument(a, root);
    const s = log1pOf(v);
    return x < 0 ? -s : s;
}

/**
 * float asinhf(float x), as asinh.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function asinhf({ host }, x){
    if (!(Math.abs(x) <= MAX))
    {
        return host();
    }
    if (x === 0)
    {
        return x;
    }
    const a = Math.abs(x);
    if (!(a < HYPERBOLIC_LARGE))
    {
        const large = X87.yl2x(X87.LN2, a) + X87.LN2;
        return Math.fround(x < 0 ? -large : large);
    }
    const root = Math.sqrt(1 + a * a);
    const v = asinhArgument(a, root);
    const s = log1pOf(v);
    return Math.fround(x < 0 ? -s : s);
}

/**
 * double acosh(double x) -- ln(x + sqrt(x^2 - 1)) by log1p of x - 1; below 1
 * (EDOM), an infinity and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function acosh({ host }, x){
    if (!(x >= 1 && x <= MAX))
    {
        return host();
    }
    return acoshOf(x);
}

/**
 * float acoshf(float x), as acosh.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function acoshf({ host }, x){
    if (!(x >= 1 && x <= MAX))
    {
        return host();
    }
    return Math.fround(acoshOf(x));
}

/**
 * double atanh(double x) -- ln((1 + |x|) / (1 - |x|)) / 2 by log1p, the sign
 * put back; 1 and beyond in magnitude (ERANGE, EDOM) and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function atanh({ host }, x){
    if (!(Math.abs(x) < 1))
    {
        return host();
    }
    if (x === 0)
    {
        return x;
    }
    const v = atanhArgument(Math.abs(x));
    const t = log1pOf(v) * 0.5;
    return x < 0 ? -t : t;
}

/**
 * float atanhf(float x), as atanh.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {f32}
 */
export function atanhf({ host }, x){
    if (!(Math.abs(x) < 1))
    {
        return host();
    }
    if (x === 0)
    {
        return x;
    }
    const v = atanhArgument(Math.abs(x));
    const t = log1pOf(v) * 0.5;
    return Math.fround(x < 0 ? -t : t);
}

/**
 * int ilogb(double x) -- the unbiased exponent, `fxtract`'s, a subnormal's as
 * though normalised; zero, an infinity and a NaN the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {i32}
 */
export function ilogb({ host }, x){
    if (!(Math.abs(x) <= MAX && x !== 0))
    {
        return host();
    }
    return exponentOf(Math.abs(x)) | 0;
}

/**
 * int ilogbf(float x), as ilogb.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x
 * @returns {i32}
 */
export function ilogbf({ host }, x){
    if (!(Math.abs(x) <= MAX && x !== 0))
    {
        return host();
    }
    return exponentOf(Math.abs(x)) | 0;
}

/**
 * float modff(float x, float *whole) -- as modf; an infinity and a NaN the
 * handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f32} x @param {u32} whole
 * @returns {f32}
 */
export function modff({ host, setF32 }, x, whole){
    if (!(Math.abs(x) <= MAX))
    {
        return host();
    }
    const truncated = x < 0 ? Math.ceil(x) : Math.floor(x);
    setF32(whole, truncated);
    return Math.fround(x - truncated);
}
