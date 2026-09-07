/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The maths library, in the two shapes a compiler emits calls to it.
 *
 * `sin` and friends are ordinary cdecl functions: the double arrives as two
 * stack slots and leaves in ST(0). The `_CI` variants beside them are the same
 * mathematics reached by a different calling convention -- the argument is
 * already on the FPU stack, nothing is on the caller's stack at all, and the
 * result replaces the argument. A compiler picks between them by optimisation
 * setting, not by source code, so a program links whichever half its build
 * chose and the other name never appears.
 *
 * Both shapes need the FPU seam, so this whole table is conditional on it.
 */

import { readDouble, returningDouble } from './float.js';

/**
 * @typedef {Object} MathHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {import('./float.js').FloatHost} fpu
 */

/** @param {number} value */
function doubleBytes(value){
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return bytes;
}

/**
 * The one-argument functions, by name, shared between both calling shapes.
 *
 * @type {Record<string, (value: number) => number>}
 */
const UNARY = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    exp: Math.exp,
    log: Math.log,
    log10: Math.log10,
    sqrt: Math.sqrt,
    fabs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
};

/** @type {Record<string, (left: number, right: number) => number>} */
const BINARY = {
    pow: Math.pow,
    atan2: Math.atan2,
    // C's fmod keeps the sign of the dividend, and so does the % operator here.
    fmod: (left, right)=>left % right,
    _hypot: Math.hypot,
    hypot: Math.hypot,
};

/**
 * @param {MathHost} host
 */
export function createMathFunctions(host){
    const fpu = host.fpu;

    /** @type {Record<string, { convention: string, argBytes: number, handler: Function }>} */
    const table = {};

    for (const [name, compute] of Object.entries(UNARY))
    {
        table[name] = returningDouble(fpu, 8, args=>compute(readDouble(args, 0)));

        // The FPU-stack form: one argument, consumed, replaced by the result.
        table[`_CI${name}`] = {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                const value = fpu.get(0);
                fpu.pop();
                fpu.setResult(compute(value));
                return 0;
            },
        };
    }

    for (const [name, compute] of Object.entries(BINARY))
    {
        table[name] = returningDouble(fpu, 16,
            args=>compute(readDouble(args, 0), readDouble(args, 2)));

        // ST(1) is the left operand and ST(0) the right, because the left was
        // pushed first. Getting these the wrong way round is undetectable for
        // atan2 near the diagonal and wrong everywhere else.
        table[`_CI${name}`] = {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                const right = fpu.get(0);
                const left = fpu.get(1);
                fpu.pop();
                fpu.pop();
                fpu.setResult(compute(left, right));
                return 0;
            },
        };
    }

    /**
     * long _ftol(double value)
     *
     * The cast every `(int)` in compiled C goes through. It truncates towards
     * zero -- not the rounding the FPU's own control word asks for, which is
     * exactly why the compiler calls a function instead of emitting `fistp`.
     *
     * It is declared as returning __int64, in EDX:EAX. Only EAX is set here,
     * because a handler has no way to reach EDX; a program casting to `int`
     * reads EAX alone and is right, and one casting to `__int64` reads a high
     * half that is whatever EDX already held. Widening the return path is the
     * fix, and it belongs in the bridge rather than here.
     */
    const ftol = {
        convention: 'cdecl',
        argBytes: 0,
        handler: ()=>{
            const value = fpu.get(0);
            fpu.pop();
            return Math.trunc(value) | 0;
        },
    };

    return {
        ...table,

        _ftol: ftol,
        _ftol2: ftol,
        _ftol2_sse: ftol,

        /** double ldexp(double value, int exponent) */
        ldexp: returningDouble(fpu, 12,
            args=>readDouble(args, 0) * Math.pow(2, args[2] | 0)),

        /**
         * double frexp(double value, int *exponent)
         *
         * Splits into a mantissa in [0.5, 1) and a power of two. Zero is the
         * case that has no such mantissa, and C answers it with both halves
         * zero rather than with a special value.
         */
        frexp: returningDouble(fpu, 12, args=>{
            const value = readDouble(args, 0);
            if (value === 0 || !Number.isFinite(value))
            {
                host.writeMemory(args[2], new Uint8Array(4));
                return value;
            }
            const exponent = Math.ceil(Math.log2(Math.abs(value)));
            let mantissa = value / Math.pow(2, exponent);
            let power = exponent;
            // log2 is inexact at the boundaries; nudge until the mantissa is in
            // range rather than trusting it to land there.
            while (Math.abs(mantissa) >= 1)
            {
                mantissa /= 2;
                power++;
            }
            while (Math.abs(mantissa) < 0.5)
            {
                mantissa *= 2;
                power--;
            }
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setInt32(0, power, true);
            host.writeMemory(args[2], bytes);
            return mantissa;
        }),

        /**
         * double modf(double value, double *integerPart)
         *
         * Both halves keep the sign of the original, which is what makes
         * modf(-1.5) answer -0.5 and -1 rather than -0.5 and -2.
         */
        modf: returningDouble(fpu, 12, args=>{
            const value = readDouble(args, 0);
            const whole = Math.trunc(value);
            host.writeMemory(args[2], doubleBytes(whole));
            return value - whole;
        }),
    };
}
