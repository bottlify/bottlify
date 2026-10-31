/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The maths the Universal CRT adds to msvcrt's: C99's functions (`trunc`,
 * `round`, `expm1`, `log1p`, `exp2`, `log2`, `fmax`, `fmin`, `copysign`) and
 * their float forms, the classifiers `<math.h>`'s macros call (`_dclass`,
 * `_dtest`, `_dsign` and the float ones), `_except1`, which a 32-bit
 * compiler's inline maths calls when an x87 operation raised, and the SSE2
 * entries (`__libm_sse2_sin` and the rest) a 32-bit program built for SSE2
 * calls with its argument and its answer in XMM0.
 *
 * errno is set as msvcrt's maths sets it (`math.js`): EDOM for a NaN out of
 * arguments that were none, ERANGE for an infinity out of finite ones.
 */

import { guestException } from '../common/raise.js';
import { readDouble, readSingle, returningDouble, returningSingle } from './float.js';
import { EDOM, ERANGE } from './globals.js';

/**
 * @typedef {Object} UcrtMathHost
 * @property {import('./float.js').FloatHost} fpu
 * @property {(code: number) => void} errno
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {number} pointerSize
 * @property {(index: number) => Uint32Array} [readXmm]
 * @property {(index: number, words: Uint32Array) => void} [writeXmm]
 */

const ONE_DOUBLE = Object.freeze({ 0: /** @type {'f64'} */ ('f64') });
const TWO_DOUBLES = Object.freeze({ 0: /** @type {'f64'} */ ('f64'),
    2: /** @type {'f64'} */ ('f64') });
const ONE_FLOAT = Object.freeze({ 0: /** @type {'f32'} */ ('f32') });
const TWO_FLOATS = Object.freeze({ 0: /** @type {'f32'} */ ('f32'),
    1: /** @type {'f32'} */ ('f32') });

/** `_dclass`'s answers: FP_INFINITE, FP_NAN, FP_NORMAL, FP_SUBNORMAL, FP_ZERO. */
const FP_INFINITE = 1;
const FP_NAN = 2;
const FP_NORMAL = -1;
const FP_SUBNORMAL = -2;
const FP_ZERO = 0;

/** C's round: halves away from zero, which Math.round is not for negatives. */
const roundAway = (/** @type {number} */ x)=>(Number.isFinite(x) ? Math.sign(x)
    * Math.round(Math.abs(x)) || x * 0 : x);

/** fmax and fmin: a NaN argument loses to a number. */
const larger = (/** @type {number} */ a, /** @type {number} */ b)=>(Number.isNaN(a) ? b
    : Number.isNaN(b) ? a : Math.max(a, b));
const smaller = (/** @type {number} */ a, /** @type {number} */ b)=>(Number.isNaN(a) ? b
    : Number.isNaN(b) ? a : Math.min(a, b));

/** @param {number} x @param {number} y  x with y's sign, -0 and NaN's included. */
const copySign = (x, y)=>{
    const view = new DataView(new ArrayBuffer(16));
    view.setFloat64(0, x);
    view.setFloat64(8, y);
    view.setUint8(0, view.getUint8(0) & 0x7f | view.getUint8(8) & 0x80);
    return view.getFloat64(0);
};

/** The C99 functions of one double, and what each computes. */
const UNARY = {
    trunc: Math.trunc,
    round: roundAway,
    expm1: Math.expm1,
    log1p: Math.log1p,
    exp2: (/** @type {number} */ x)=>2 ** x,
    log2: Math.log2,
};

/** And of two. */
const BINARY = { fmax: larger, fmin: smaller, copysign: copySign };

/**
 * The SSE2 entries of a 32-bit runtime, argument and answer in XMM0 (and
 * `pow`'s and `atan2`'s second argument in XMM1), each but `atan2` with its
 * float form beside it, `_libm_sse2_*_precise` naming the same functions.
 */
const SSE2_UNARY = {
    acos: Math.acos, asin: Math.asin, atan: Math.atan, cos: Math.cos, exp: Math.exp,
    log: Math.log, log10: Math.log10, sin: Math.sin, tan: Math.tan,
};
const SSE2_BINARY = { pow: Math.pow, atan2: Math.atan2 };
const SSE2_PRECISE = ['acos', 'asin', 'atan', 'cos', 'exp', 'log10', 'log', 'pow', 'sin', 'tan'];

/** `_except1`'s exception bits, and the status each raises when it is unmasked. */
const EXCEPT1 = [
    { bit: 0x1, mask: 0x08, status: 0xc0000091, errno: ERANGE }, //  overflow
    { bit: 0x2, mask: 0x10, status: 0xc0000093, errno: 0 }, //       underflow
    { bit: 0x4, mask: 0x04, status: 0xc000008e, errno: ERANGE }, //  zero divide
    { bit: 0x8, mask: 0x01, status: 0xc0000090, errno: EDOM }, //    invalid
    { bit: 0x10, mask: 0x20, status: 0xc000008f, errno: 0 }, //      inexact
];

/** @param {number} value */
function classOf(value){
    if (Number.isNaN(value))
    {
        return FP_NAN;
    }
    if (!Number.isFinite(value))
    {
        return FP_INFINITE;
    }
    if (value === 0)
    {
        return FP_ZERO;
    }
    return Math.abs(value) < 2.2250738585072014e-308 ? FP_SUBNORMAL : FP_NORMAL;
}

/** @param {number} value  A float's value, read as one. */
function floatClassOf(value){
    const kind = classOf(value);
    return kind === FP_NORMAL && Math.abs(value) < 1.1754943508222875e-38 ? FP_SUBNORMAL : kind;
}

/**
 * @param {UcrtMathHost} host
 * @returns {Record<string, any>}
 */
export function createUcrtMathFunctions(host){
    const { fpu } = host;
    const scratch = new DataView(new ArrayBuffer(8));

    /**
     * The answer, and errno as msvcrt's maths sets it for the arguments.
     *
     * @param {number[]} args @param {number} result
     */
    const answer = (args, result)=>{
        if (Number.isNaN(result) && !args.some(Number.isNaN))
        {
            host.errno(EDOM);
        }
        else if (!Number.isFinite(result) && args.every(Number.isFinite))
        {
            host.errno(ERANGE);
        }
        return result;
    };

    /** A short's answer, as the caller reads AX. @param {number} value */
    const short = value=>value & 0xffff;

    /** @type {Record<string, any>} */
    const table = {};

    for (const [name, compute] of Object.entries(UNARY))
    {
        table[name] = returningDouble(fpu, 8, args=>{
            const x = readDouble(args, 0);
            return answer([x], compute(x));
        }, ONE_DOUBLE);
        table[`${name}f`] = returningSingle(fpu, 4, args=>{
            const x = readSingle(args, 0);
            return answer([x], compute(x));
        }, ONE_FLOAT);
    }
    for (const [name, compute] of Object.entries(BINARY))
    {
        table[name] = returningDouble(fpu, 16, args=>
            compute(readDouble(args, 0), readDouble(args, 2)), TWO_DOUBLES);
        table[`${name}f`] = returningSingle(fpu, 8, args=>
            compute(readSingle(args, 0), readSingle(args, 1)), TWO_FLOATS);
    }

    /** float modff(float x, float *integral): the fraction, the whole part stored. */
    table.modff = returningSingle(fpu, 8, ([bits, out])=>{
        const x = readSingle([bits], 0);
        const whole = Number.isFinite(x) ? Math.trunc(x) : x;
        scratch.setFloat32(0, whole, true);
        host.writeMemory(out >>> 0, new Uint8Array(scratch.buffer.slice(0, 4)));
        return Number.isNaN(x) ? x : Number.isFinite(x) ? x - whole : copySign(0, x);
    }, ONE_FLOAT);

    /** short _dclass(double x), short _fdclass(float x) */
    table._dclass = { convention: 'cdecl', argBytes: 8, floats: ONE_DOUBLE,
        handler: (/** @type {number[]} */ args)=>short(classOf(readDouble(args, 0))) };
    table._fdclass = { convention: 'cdecl', argBytes: 4, floats: ONE_FLOAT,
        handler: (/** @type {number[]} */ args)=>short(floatClassOf(readSingle(args, 0))) };

    /** short _dtest(double *x), short _fdtest(float *x): the class of what they point at. */
    table._dtest = { convention: 'cdecl', argBytes: 4,
        handler: (/** @type {number[]} */ [at])=>short(classOf(new DataView(
            host.readMemory(at >>> 0, 8).slice().buffer).getFloat64(0, true))) };
    table._fdtest = { convention: 'cdecl', argBytes: 4,
        handler: (/** @type {number[]} */ [at])=>short(floatClassOf(new DataView(
            host.readMemory(at >>> 0, 4).slice().buffer).getFloat32(0, true))) };

    /** int _dsign(double x), int _fdsign(float x): the sign bit, as 0x8000 or zero. */
    table._dsign = { convention: 'cdecl', argBytes: 8, floats: ONE_DOUBLE,
        handler: (/** @type {number[]} */ args)=>((args[1] >>> 31) === 1 ? 0x8000 : 0) };
    table._fdsign = { convention: 'cdecl', argBytes: 4, floats: ONE_FLOAT,
        handler: (/** @type {number[]} */ args)=>((args[0] >>> 31) === 1 ? 0x8000 : 0) };

    /**
     * double _except1(DWORD fpe, _FP_OPERATION_CODE op, double arg,
     *     double result, DWORD cw, void *unknown)
     *
     * What an x87 operation the program's own code ran raised: the first
     * exception of `fpe` the control word masks is answered -- errno set,
     * an overflow's result an infinity of its sign -- and the control word
     * the caller had restored; one it leaves unmasked is raised. At 64 bits
     * the word is MXCSR's, its masks at bits 7 to 12.
     */
    table._except1 = returningDouble(fpu, 32, args=>{
        const fpe = args[0] >>> 0;
        let result = readDouble(args, 4);
        const word = args[6] >>> 0;
        const masks = host.pointerSize === 8 ? word >>> 7 & 0x3f : word;
        const first = EXCEPT1.find(({ bit })=>(fpe & bit) !== 0);
        if (first && (masks & first.mask) === 0)
        {
            throw guestException(first.status);
        }
        if (first?.errno)
        {
            host.errno(first.errno);
        }
        if (first?.bit === 0x1)
        {
            result = copySign(Infinity, result);
        }
        if (host.pointerSize !== 8)
        {
            fpu.setControlWord?.(word & 0xffff);
        }
        return result;
    }, { 2: 'f64', 4: 'f64' });

    if (host.pointerSize === 4 && host.readXmm && host.writeXmm)
    {
        const { readXmm, writeXmm } = host;
        /** @param {number} index */
        const xmmDouble = index=>{
            const words = readXmm(index);
            scratch.setUint32(0, words[0], true);
            scratch.setUint32(4, words[1], true);
            return scratch.getFloat64(0, true);
        };
        /** @param {number} index */
        const xmmSingle = index=>{
            scratch.setUint32(0, readXmm(index)[0], true);
            return scratch.getFloat32(0, true);
        };
        /** @param {number} value */
        const answerDouble = value=>{
            scratch.setFloat64(0, value, true);
            writeXmm(0, Uint32Array.of(scratch.getUint32(0, true), scratch.getUint32(4, true),
                0, 0));
            return 0;
        };
        /** @param {number} value */
        const answerSingle = value=>{
            scratch.setFloat32(0, value, true);
            writeXmm(0, Uint32Array.of(scratch.getUint32(0, true), 0, 0, 0));
            return 0;
        };
        /** @param {() => number} compute */
        const entry = compute=>({ convention: 'cdecl', argBytes: 0, handler: compute });
        for (const [name, compute] of Object.entries(SSE2_UNARY))
        {
            table[`__libm_sse2_${name}`] = entry(()=>{
                const x = xmmDouble(0);
                return answerDouble(answer([x], compute(x)));
            });
            table[`__libm_sse2_${name}f`] = entry(()=>{
                const x = xmmSingle(0);
                return answerSingle(answer([x], compute(x)));
            });
        }
        for (const [name, compute] of Object.entries(SSE2_BINARY))
        {
            table[`__libm_sse2_${name}`] = entry(()=>{
                const x = xmmDouble(0);
                const y = xmmDouble(1);
                return answerDouble(answer([x, y], compute(x, y)));
            });
        }
        table.__libm_sse2_powf = entry(()=>{
            const x = xmmSingle(0);
            const y = xmmSingle(1);
            return answerSingle(answer([x, y], Math.pow(x, y)));
        });
        table.__libm_sse2_sqrt_precise = entry(()=>{
            const x = xmmDouble(0);
            return answerDouble(answer([x], Math.sqrt(x)));
        });
        for (const name of SSE2_PRECISE)
        {
            table[`_libm_sse2_${name}_precise`] = table[`__libm_sse2_${name}`];
        }
        table._libm_sse2_sqrt_precise = table.__libm_sse2_sqrt_precise;
    }
    return table;
}
