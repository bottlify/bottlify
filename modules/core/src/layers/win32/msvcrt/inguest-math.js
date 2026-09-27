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
 * log10(2), the double nearest it: `fldlg2` loads it under cork, and a unit
 * short of it under the emulator, whose log10(1000) was 2.999999999999999.
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
 * double atan(double x) -- `fpatan` of x and 1.
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function atan(x){
    return Math.atan(x);
}

/**
 * @guestCode cdecl
 * @param {x87} x
 * @returns {f64}
 */
export function _CIatan(x){
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
 * for a y of zero; the rest, and an overflow (ERANGE), a negative to a
 * fraction (EDOM) and a NaN, the handler's.
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
 * 1 from 22 on, where the difference from 1 is below a double's reach.
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function tanh(x){
    if (!(Math.abs(x) < 22))
    {
        return Number.isNaN(x) ? x : x < 0 ? -1 : 1;
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
 * @param {x87} x
 * @returns {f64}
 */
export function _CItanh(x){
    if (!(Math.abs(x) < 22))
    {
        return Number.isNaN(x) ? x : x < 0 ? -1 : 1;
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
