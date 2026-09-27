/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The rest of the C runtime's floating point as code in the guest's own
 * msvcrt, written once: each `@guestCode` function here is compiled by the
 * build (`scripts/guest-code/compile.mjs`) into `inguest-float.x86.js`, and
 * is itself the export's handler and the reference its x86 is held to.
 *
 * The floating-point environment is the x87's own: `_control87` and
 * `_controlfp` read the control word the thread runs under, translate it
 * into the runtime's portable bits (`float.h`'s `_MCW_EM`, `_MCW_RC`,
 * `_MCW_PC`, `_MCW_IC`), change the ones the mask names and load the word
 * back -- a precision a program sets is the precision its arithmetic then
 * rounds to -- and `_statusfp` and `_clearfp` read and clear the status
 * word's exception flags. The runtime of a machine with SSE2 changes MXCSR
 * alongside and folds its bits into the answer; this one, as the handler
 * before it, keeps to the x87.
 *
 * The classifications read a double's bits, as integers: no x87 load, so a
 * signalling NaN raises nothing. `strtod` and `atof` read the text here and
 * compute what Clinger's fast path computes exactly -- up to 15 significant
 * digits scaled by a power of ten up to 10^22, one multiplication or
 * division under double precision and rounding to nearest, the program's
 * control word put back after -- and hand the host the rest: more digits, a
 * larger scale, and every overflow and underflow, where errno is set.
 */

import { X87 } from './x87.js';

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').f64} f64 */
/** @typedef {import('./guest-code.js').i32} i32 */
/** @typedef {import('./guest-code.js').u32} u32 */

/** The largest double. */
const MAX = 1.7976931348623157e308;

/** The smallest subnormal double, 2^-1074. */
const TINY = 5e-324;

/** `_EM_DENORMAL`, which `_controlfp` leaves out of its mask. */
const EM_DENORMAL = 0x80000;

/** The bits `_control87` changes: `_MCW_EM`, `_MCW_IC`, `_MCW_RC` and `_MCW_PC`. */
const CHANGEABLE = 0x0008001f | 0x40000 | 0x300 | 0x30000;

/** The x87 control word's bits the translation keeps as they are: the reserved ones. */
const RESERVED = 0xe0c0;

/** `_fpclass`'s answers. */
const FPCLASS_SNAN = 0x1;
const FPCLASS_QNAN = 0x2;
const FPCLASS_NINF = 0x4;
const FPCLASS_NN = 0x8;
const FPCLASS_ND = 0x10;
const FPCLASS_NZ = 0x20;
const FPCLASS_PZ = 0x40;
const FPCLASS_PD = 0x80;
const FPCLASS_PN = 0x100;
const FPCLASS_PINF = 0x200;

/**
 * The x87's six exception bits -- a mask in the control word, a flag in the
 * status word -- as the runtime numbers them: invalid 0x10, denormal
 * 0x80000, zero-divide 0x8, overflow 0x4, underflow 0x2, inexact 0x1.
 */
const exceptionsOf = (/** @type {number} */ word)=>(word & 0x1) << 4 | (word & 0x2) << 18
    | (word & 0x4) << 1 | (word & 0x8) >>> 1 | (word & 0x10) >>> 3 | (word & 0x20) >>> 5;

/** The runtime's exception bits as the x87's. */
const hardwareExceptions = (/** @type {number} */ bits)=>(bits & 0x10) >>> 4
    | (bits & 0x80000) >>> 18 | (bits & 0x8) >>> 1 | (bits & 0x4) << 1 | (bits & 0x2) << 3
    | (bits & 0x1) << 5;

/**
 * An x87 control word as the runtime reads it: the exception masks, the
 * rounding (the x87's two bits two places down), the precision -- 24 bits
 * `_PC_24` 0x20000, 53 `_PC_53` 0x10000, 64 `_PC_64` 0, the reserved setting
 * none -- and the infinity control, affine `_IC_AFFINE` 0x40000.
 */
const abstractOf = (/** @type {number} */ word)=>exceptionsOf(word) | (word & 0xc00) >>> 2
    | ((word & 0x300) === 0 ? 0x20000 : (word & 0x300) === 0x200 ? 0x10000 : 0)
    | (word & 0x1000) << 6;

/**
 * The runtime's bits as an x87 control word's: `_PC_64` and a precision
 * both bits name are the x87's 64 and 24 bits.
 */
const hardwareOf = (/** @type {number} */ bits)=>hardwareExceptions(bits) | (bits & 0x300) << 2
    | ((bits & 0x30000) === 0 ? 0x300 : (bits & 0x30000) === 0x10000 ? 0x200 : 0)
    | (bits & 0x40000) >>> 6;

/*
 * The translations above as the guest's code makes them: a table read for
 * each group of bits a translation moves apart, where the shifts and masks
 * cost the code two and a half times the instructions and cork twice the
 * translation. The tables are the functions' own answers.
 */

/** The runtime's exception bits for each value of the x87's six. */
export const EXCEPTIONS = Uint32Array.from({ length: 64 }, (_, word)=>exceptionsOf(word));

/** The runtime's rounding and precision bits for each value of a control word's bits 8-11. */
export const ROUNDING_PRECISION = Uint32Array.from({ length: 16 },
    (_, bits)=>abstractOf(bits << 8) & 0x30300);

/** The x87's exception masks for the runtime's bits 0-4 and, as bit 5, its bit 19. */
export const HARDWARE_EXCEPTIONS = Uint8Array.from({ length: 64 },
    (_, index)=>hardwareExceptions(index & 0x1f | (index & 0x20) << 14));

/** The x87's precision bits for each value of `_MCW_PC`'s two. */
export const HARDWARE_PRECISION = Uint16Array.from({ length: 4 },
    (_, index)=>hardwareOf(index << 16) & 0x300);

/** `abstractOf`, through the tables. */
const readBack = (/** @type {number} */ word)=>EXCEPTIONS[word & 0x3f]
    | ROUNDING_PRECISION[word >>> 8 & 0xf] | (word & 0x1000) << 6;

/** `hardwareOf`, through the tables. */
const loadable = (/** @type {number} */ bits)=>HARDWARE_EXCEPTIONS[bits & 0x1f | bits >>> 14 & 0x20]
    | (bits & 0x300) << 2 | HARDWARE_PRECISION[bits >>> 16 & 3] | (bits & 0x40000) >>> 6;

/** The control word Clinger's step runs under: double precision, to nearest. */
const exactly = (/** @type {number} */ word)=>word & 0xf0ff | 0x0200;

/**
 * unsigned int _control87(unsigned int newControl, unsigned int mask)
 *
 * The control word the thread runs under, the bits the mask names changed
 * (within `_MCW_EM`, `_MCW_IC`, `_MCW_RC` and `_MCW_PC`), loaded, and
 * answered as the runtime reads it back.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} newControl @param {u32} mask
 * @returns {u32}
 */
export function _control87({ controlWord, setControlWord }, newControl, mask){
    const word = controlWord();
    const changed = mask & CHANGEABLE;
    const wanted = readBack(word) & ~changed | newControl & changed;
    const loaded = word & RESERVED | loadable(wanted);
    setControlWord(loaded);
    return readBack(loaded) >>> 0;
}

/**
 * unsigned int _controlfp(unsigned int newControl, unsigned int mask) --
 * `_control87` with `_EM_DENORMAL` taken out of the mask.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} newControl @param {u32} mask
 * @returns {u32}
 */
export function _controlfp({ controlWord, setControlWord }, newControl, mask){
    const word = controlWord();
    const changed = mask & CHANGEABLE & ~EM_DENORMAL;
    const wanted = readBack(word) & ~changed | newControl & changed;
    const loaded = word & RESERVED | loadable(wanted);
    setControlWord(loaded);
    return readBack(loaded) >>> 0;
}

/**
 * unsigned int _statusfp(void) -- the exception flags raised, as the
 * runtime numbers them (`_SW_INVALID` 0x10 ... `_SW_INEXACT` 0x1).
 *
 * @guestCode cdecl
 * @param {Guest} guest
 * @returns {u32}
 */
export function _statusfp({ statusWord }){
    return EXCEPTIONS[statusWord() & 0x3f] >>> 0;
}

/**
 * unsigned int _clearfp(void) -- the flags raised, and then cleared.
 *
 * @guestCode cdecl
 * @param {Guest} guest
 * @returns {u32}
 */
export function _clearfp({ statusWord, clearExceptions }){
    const flags = EXCEPTIONS[statusWord() & 0x3f];
    clearExceptions();
    return flags >>> 0;
}

/**
 * double _copysign(double x, double y) -- x's magnitude, y's sign bit,
 * which a zero and a NaN carry too.
 *
 * @guestCode cdecl
 * @param {f64} x @param {u32} low @param {i32} high
 * @returns {f64}
 */
export function _copysign(x, low, high){
    const magnitude = Math.abs(x);
    return high < 0 ? -magnitude : magnitude;
}

/**
 * double _chgsign(double x) -- the sign bit flipped.
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function _chgsign(x){
    return -x;
}

/**
 * int _finite(double x) -- nonzero unless the exponent is all ones.
 *
 * @guestCode cdecl
 * @param {u32} low @param {i32} high
 * @returns {i32}
 */
export function _finite(low, high){
    return (high & 0x7ff00000) !== 0x7ff00000 ? 1 : 0;
}

/**
 * int _isnan(double x) -- the exponent all ones and a fraction.
 *
 * @guestCode cdecl
 * @param {u32} low @param {i32} high
 * @returns {i32}
 */
export function _isnan(low, high){
    const magnitude = high & 0x7fffffff;
    return magnitude > 0x7ff00000 || magnitude === 0x7ff00000 && low !== 0 ? 1 : 0;
}

/**
 * int _fpclass(double x) -- signalling or quiet NaN, an infinity, a normal,
 * a denormal or a zero, each of either sign.
 *
 * @guestCode cdecl
 * @param {u32} low @param {i32} high
 * @returns {i32}
 */
export function _fpclass(low, high){
    const exponent = high >>> 20 & 0x7ff;
    const fraction = (high & 0xfffff) !== 0 || low !== 0 ? 1 : 0;
    if (exponent === 0x7ff)
    {
        if (fraction === 0)
        {
            return high < 0 ? FPCLASS_NINF : FPCLASS_PINF;
        }
        return (high & 0x80000) !== 0 ? FPCLASS_QNAN : FPCLASS_SNAN;
    }
    if (exponent === 0)
    {
        if (fraction === 0)
        {
            return high < 0 ? FPCLASS_NZ : FPCLASS_PZ;
        }
        return high < 0 ? FPCLASS_ND : FPCLASS_PD;
    }
    return high < 0 ? FPCLASS_NN : FPCLASS_PN;
}

/**
 * double _logb(double x) -- the exponent, unbiased, a denormal's as if it
 * were normalised (`fxtract`); an infinity's +infinity, a NaN itself; 0's
 * -infinity is the handler's, which sets errno (ERANGE).
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x
 * @returns {f64}
 */
export function _logb({ host }, x){
    if (x === 0)
    {
        return host();
    }
    if (!(Math.abs(x) <= MAX))
    {
        return Math.abs(x);
    }
    return X87.exponent(x);
}

/**
 * double _nextafter(double x, double y) -- the double next to x toward y:
 * x ± the unit in its last place on that side, half of it below a power of
 * two, 2^-1074 among the denormals, computed under double precision (the
 * sum is a double, exact); y where the two are equal, the largest double
 * from an infinity, the smallest from a zero. A NaN answers a NaN, and a
 * step past the largest double -- an infinity, ERANGE -- is the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {f64} x @param {f64} y
 * @returns {f64}
 */
export function _nextafter({ controlWord, setControlWord, host }, x, y){
    if (Number.isNaN(x) || Number.isNaN(y))
    {
        return x + y;
    }
    if (x === y)
    {
        return y;
    }
    if (x === 0)
    {
        return y > 0 ? TINY : -TINY;
    }
    if (!(Math.abs(x) <= MAX))
    {
        return x > 0 ? MAX : -MAX;
    }
    const exponent = X87.exponent(x) | 0;
    const upward = y > x ? 1 : 0;
    const positive = x > 0 ? 1 : 0;
    const halved = upward !== positive && exponent > -1022
        && Math.abs(X87.significand(x)) === 1 ? 1 : 0;
    const step = X87.scale(1, exponent < -1022 ? -1074 : (exponent - 52 - halved) | 0);
    const word = controlWord();
    setControlWord(word | 0x200);
    const next = upward !== 0 ? x + step : x - step;
    setControlWord(word);
    if (!(Math.abs(next) <= MAX))
    {
        return host();
    }
    if (next === 0)
    {
        // The step from the smallest denormal: a zero of x's sign, as its bits have it.
        return x < 0 ? -0 : 0;
    }
    return next;
}

/**
 * double strtod(const char *text, char **end)
 *
 * White space, a sign, digits with a point among them, an exponent after
 * `e`, `E`, `d` or `D` (msvcrt's, Wine's test reads "12.1d2" as 1210) where
 * digits follow it; `*end` where the number stopped, or the text itself when
 * no digit was read -- "INF" and "NAN" among them. Fifteen significant
 * digits are kept as two integers and the value computed here where the
 * scale is 10^22 or less (Clinger's fast path, exact); a sixteenth digit or
 * a larger scale is the handler's, which reads the text again.
 *
 * One loop reads the digits on both sides of the point, and the powers of
 * ten are multiplied up a ten at a time -- every one to 10^22 is exact --
 * rather than assembled from branches: cork translates a function like this
 * as many regions, each over most of it, so every branch is paid for many
 * times over before the first call returns.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} end
 * @returns {f64}
 */
export function strtod({ u8, setU32, controlWord, setControlWord, host }, text, end){
    let at = text;
    let c = u8(at);
    while (c === 0x20 || c >= 0x09 && c <= 0x0d)
    {
        at++;
        c = u8(at);
    }
    let negative = 0;
    if (c === 0x2d || c === 0x2b)
    {
        negative = c === 0x2d ? 1 : 0;
        at++;
        c = u8(at);
    }
    let seen = 0;
    let point = 0;
    let digits = 0;
    let high = 0;
    let low = 0;
    let scale = 0;
    for (;;)
    {
        if (c >= 0x30 && c <= 0x39)
        {
            seen = 1;
            // A leading zero is no significant digit; after the point it
            // moves the scale as any digit there does.
            if (digits !== 0 || c !== 0x30)
            {
                if (digits < 9)
                {
                    high = (Math.imul(high, 10) + (c - 0x30)) | 0;
                }
                else if (digits < 15)
                {
                    low = (Math.imul(low, 10) + (c - 0x30)) | 0;
                }
                else
                {
                    // A sixteenth significant digit, past the fast path.
                    return host();
                }
                digits++;
            }
            scale = (scale - point) | 0;
        }
        else if (c === 0x2e && point === 0)
        {
            point = 1;
        }
        else
        {
            break;
        }
        at++;
        c = u8(at);
    }
    if (seen === 0)
    {
        if (end !== 0)
        {
            setU32(end, text);
        }
        return 0;
    }
    if ((c | 0x20) === 0x65 || (c | 0x20) === 0x64)
    {
        let after = (at + 1) >>> 0;
        let d = u8(after);
        let minus = 0;
        if (d === 0x2d || d === 0x2b)
        {
            minus = d === 0x2d ? 1 : 0;
            after++;
            d = u8(after);
        }
        if (d >= 0x30 && d <= 0x39)
        {
            let exponent = 0;
            while (d >= 0x30 && d <= 0x39)
            {
                exponent = exponent < 100000 ? (Math.imul(exponent, 10) + (d - 0x30)) | 0
                    : exponent;
                after++;
                d = u8(after);
            }
            scale = minus !== 0 ? (scale - exponent) | 0 : (scale + exponent) | 0;
            at = after;
        }
    }
    if (digits === 0)
    {
        if (end !== 0)
        {
            setU32(end, at);
        }
        return negative !== 0 ? -0 : 0;
    }
    if (scale > 22 || scale < -22)
    {
        return host();
    }
    const word = controlWord();
    setControlWord(exactly(word));
    /** @type {f64} */
    let whole = +high;
    let k = (digits - 9) | 0;
    while (k > 0)
    {
        whole = whole * 10;
        k--;
    }
    whole = whole + low;
    /** @type {f64} */
    let power = 1;
    k = scale < 0 ? (0 - scale) | 0 : scale;
    while (k > 0)
    {
        power = power * 10;
        k--;
    }
    const value = scale < 0 ? whole / power : whole * power;
    setControlWord(word);
    if (end !== 0)
    {
        setU32(end, at);
    }
    return negative !== 0 ? -value : value;
}

/**
 * double atof(const char *text) -- strtod's reading, and its value, with
 * no end to report.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {f64}
 */
export function atof({ u8, controlWord, setControlWord, host }, text){
    let at = text;
    let c = u8(at);
    while (c === 0x20 || c >= 0x09 && c <= 0x0d)
    {
        at++;
        c = u8(at);
    }
    let negative = 0;
    if (c === 0x2d || c === 0x2b)
    {
        negative = c === 0x2d ? 1 : 0;
        at++;
        c = u8(at);
    }
    let seen = 0;
    let point = 0;
    let digits = 0;
    let high = 0;
    let low = 0;
    let scale = 0;
    for (;;)
    {
        if (c >= 0x30 && c <= 0x39)
        {
            seen = 1;
            if (digits !== 0 || c !== 0x30)
            {
                if (digits < 9)
                {
                    high = (Math.imul(high, 10) + (c - 0x30)) | 0;
                }
                else if (digits < 15)
                {
                    low = (Math.imul(low, 10) + (c - 0x30)) | 0;
                }
                else
                {
                    return host();
                }
                digits++;
            }
            scale = (scale - point) | 0;
        }
        else if (c === 0x2e && point === 0)
        {
            point = 1;
        }
        else
        {
            break;
        }
        at++;
        c = u8(at);
    }
    if (digits === 0)
    {
        return negative !== 0 && seen !== 0 ? -0 : 0;
    }
    if ((c | 0x20) === 0x65 || (c | 0x20) === 0x64)
    {
        at++;
        c = u8(at);
        let minus = 0;
        if (c === 0x2d || c === 0x2b)
        {
            minus = c === 0x2d ? 1 : 0;
            at++;
            c = u8(at);
        }
        let exponent = 0;
        while (c >= 0x30 && c <= 0x39)
        {
            exponent = exponent < 100000 ? (Math.imul(exponent, 10) + (c - 0x30)) | 0
                : exponent;
            at++;
            c = u8(at);
        }
        scale = minus !== 0 ? (scale - exponent) | 0 : (scale + exponent) | 0;
    }
    if (scale > 22 || scale < -22)
    {
        return host();
    }
    const word = controlWord();
    setControlWord(exactly(word));
    /** @type {f64} */
    let whole = +high;
    let k = (digits - 9) | 0;
    while (k > 0)
    {
        whole = whole * 10;
        k--;
    }
    whole = whole + low;
    /** @type {f64} */
    let power = 1;
    k = scale < 0 ? (0 - scale) | 0 : scale;
    while (k > 0)
    {
        power = power * 10;
        k--;
    }
    const value = scale < 0 ? whole / power : whole * power;
    setControlWord(word);
    return negative !== 0 ? -value : value;
}
