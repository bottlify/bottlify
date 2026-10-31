/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87's own operations, for `@guestCode` sources: what an instruction no
 * JavaScript operator or `Math` function is computes, as the engines compute
 * it. The engine keeps an x87 register as a double (translated code and the
 * interpreter alike), so each is the double the instruction leaves there:
 * `fldl2e` is `Math.LOG2E`, `f2xm1` the host's `expm1` of the argument's
 * natural measure, `fyl2x` a product with the host's `log2`. The compiler
 * (`scripts/guest-code/compile.mjs`) emits the one instruction for each, and
 * the source that names them is the handler whose answers the x86 is held
 * to, bit for bit.
 *
 * A source reaches them through one import, of `X87` from this module.
 */

const view = new DataView(new ArrayBuffer(8));

/**
 * `frndint` under round-to-nearest: an integer, a tie to the even one, the
 * sign of zero kept. The compiler sets the rounding control around it and
 * puts the program's back, as the runtime's maths runs under nearest.
 *
 * @param {number} x
 */
function rint(x){
    const rounded = Math.round(x);
    return rounded - x === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
}

/**
 * `f2xm1`: 2^x - 1, for x in [-1, 1] -- the host's `expm1` of x ln 2, as the
 * translator computes it.
 *
 * @param {number} x
 */
function f2xm1(x){
    return Math.expm1(x * Math.LN2);
}

/**
 * `fyl2x`: y log2(x).
 *
 * @param {number} y @param {number} x
 */
function yl2x(y, x){
    return y * Math.log2(x);
}

/**
 * `fscale`: x times two to n truncated, a NaN n taken as 0 and n held to
 * +-2100, applied in two steps of at most a double's own range each, so
 * that a result a double holds is reached from a power one does not.
 *
 * @param {number} x @param {number} n
 */
function scale(x, n){
    let count = Math.trunc(Math.min(Math.max(n, -2100), 2100)) || 0;
    let value = x;
    for (let pass = 0; pass < 2; pass++)
    {
        const step = Math.min(Math.max(count, -1022), 1023);
        view.setBigUint64(0, BigInt(step + 1023) << 52n);
        value *= view.getFloat64(0);
        count -= step;
    }
    return value;
}

/**
 * `fxtract`'s two halves of a finite nonzero x: its exponent, unbiased, a
 * denormal's as if normalised; and its significand in [1, 2), signed. Zero's
 * exponent is -Infinity and its significand the zero. An infinity or a NaN
 * is itself in both, as on the processor, where the translator answers an
 * exponent of 1024 and a significand of 1 or 1.5: a source keeps them from
 * it.
 *
 * @param {number} x
 * @returns {[number, number]}
 */
function extract(x){
    if (x === 0)
    {
        return [-Infinity, x];
    }
    if (!Number.isFinite(x))
    {
        return [x, x];
    }
    let value = x;
    let exponent = 0;
    if (Math.abs(value) < 2 ** -1022)
    {
        value *= 2 ** 54;
        exponent = -54;
    }
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    exponent += Number(bits >> 52n & 0x7ffn) - 1023;
    view.setBigUint64(0, bits & 0x800fffffffffffffn | 0x3ff0000000000000n);
    return [exponent, view.getFloat64(0)];
}

/**
 * @type {Readonly<{
 *     L2E: number, L2T: number, LG2: number, LN2: number, PI: number,
 *     rint: (x: number) => number, f2xm1: (x: number) => number,
 *     yl2x: (y: number, x: number) => number, scale: (x: number, n: number) => number,
 *     exponent: (x: number) => number, significand: (x: number) => number,
 * }>}
 */
export const X87 = Object.freeze({
    /** `fldl2e`: log2(e). */
    L2E: Math.LOG2E,
    /** `fldl2t`: log2(10). */
    L2T: Math.log2(10),
    /** `fldlg2`: log10(2). */
    LG2: Math.log10(2),
    /** `fldln2`: ln(2). */
    LN2: Math.LN2,
    /** `fldpi`. */
    PI: Math.PI,
    rint,
    f2xm1,
    yl2x,
    scale,
    /** `fxtract`, the exponent kept. */
    exponent: x=>extract(x)[0],
    /** `fxtract`, the significand kept. */
    significand: x=>extract(x)[1],
});
