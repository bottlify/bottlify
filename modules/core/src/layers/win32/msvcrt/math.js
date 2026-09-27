/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 * Each is code in the guest's own library (`inguest-math.js`), the x87's
 * instructions under the program's control word, as the runtime computes; a
 * case it leaves to the host -- one msvcrt answers with errno, or a power
 * that is not exact -- comes to the handler here, which answers it with
 * JavaScript's value and sets errno as msvcrt does: EDOM for a NaN out of
 * arguments that were none (a square root or a logarithm of a negative, an
 * arcsine past one, a sine of an infinity), ERANGE for an infinity out of
 * finite ones (a logarithm of zero, an overflow); an underflow sets nothing.
 * `atan`, `tanh` and `exp` answer a NaN with that NaN and EDOM as well
 * (Wine's msvcrt test_math_errors).
 *
 * Both shapes need the FPU seam, so this whole table is conditional on it.
 */

import { readDouble, returningDouble } from './float.js';
import { EDOM, ERANGE } from './globals.js';
import { guestEntry, guestExport } from './guest-code.js';
import * as inGuest from './inguest.js';
import * as inGuestMath from './inguest-math.js';
import * as inGuestFloat from './inguest-float.js';
import { COMPILED } from './inguest.x86.js';
import { COMPILED as MATH_CODE } from './inguest-math.x86.js';
import { COMPILED as FLOAT_CODE } from './inguest-float.x86.js';

/**
 * div_t div(int numerator, int denominator), and ldiv, its long twin: the
 * quotient in EAX and the remainder in EDX, where a compiler takes an
 * eight-byte structure, from the one `idiv` -- which faults, as the
 * runtime's own does, dividing by zero or INT_MIN by -1.
 *
 *   mov eax, [esp+4]; cdq; idiv dword [esp+8]; ret
 */
const DIVIDE_CODE = Uint8Array.of(0x8b, 0x44, 0x24, 0x04, 0x99, 0xf7, 0x7c, 0x24, 0x08, 0xc3);

/**
 * The double next to x toward y, from its bits: what `_nextafter`'s code
 * hands over, a step past the largest double.
 *
 * @param {number} x @param {number} y
 */
function nextAfter(x, y){
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
        return y > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
    }
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    const bits = view.getBigUint64(0);
    view.setBigUint64(0, y > x === x > 0 ? bits + 1n : bits - 1n);
    return view.getFloat64(0);
}

/**
 * @typedef {Object} MathHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {import('./float.js').FloatHost} fpu
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *     Where `_ftol`'s handler puts EDX; without it `_ftol` is its x86 alone.
 * @property {(code: number) => void} [errno]  The calling thread's errno.
 */

/**
 * The one-argument functions, by name, shared between both calling shapes:
 * what the handler answers for the cases the code hands it.
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

/**
 * The ones whose NaN argument is a domain error, answered with the NaN
 * itself -- its payload kept, as the x87 hands an operand NaN through.
 */
const NAN_IS_DOMAIN = new Set(['atan', 'tanh', 'exp']);

/** @type {Record<string, (left: number, right: number) => number>} */
const BINARY = {
    pow: Math.pow,
    atan2: Math.atan2,
    // C's fmod keeps the sign of the dividend, and so does the % operator here.
    fmod: (left, right)=>left % right,
    _hypot: Math.hypot,
    hypot: Math.hypot,
};

/** The code each name is, where two names share one: `hypot` is `_hypot`, `_scalb` `ldexp`. */
const CODE_OF = /** @type {Record<string, string>} */ ({ hypot: '_hypot', _CIhypot: '_CI_hypot',
    _scalb: 'ldexp' });

/**
 * @param {MathHost} host
 */
export function createMathFunctions(host){
    const fpu = host.fpu;

    /**
     * JavaScript's answer, and errno as msvcrt sets it for the arguments.
     *
     * @param {number[]} args @param {number} result
     */
    const answer = (args, result)=>{
        if (Number.isNaN(result) && !args.some(Number.isNaN))
        {
            host.errno?.(EDOM);
        }
        else if (!Number.isFinite(result) && args.every(Number.isFinite))
        {
            host.errno?.(ERANGE);
        }
        return result;
    };

    /**
     * The handlers the code hands its rare cases to, by export name.
     *
     * @type {Record<string, { convention: string, argBytes: number,
     *     handler: (args: number[]) => number }>}
     */
    const handlers = {};

    /** @param {string} name @param {(value: number) => number} compute */
    const unary = (name, compute)=>(/** @type {number} */ value)=>{
        if (Number.isNaN(value) && NAN_IS_DOMAIN.has(name))
        {
            host.errno?.(EDOM);
            return value;
        }
        return answer([value], compute(value));
    };

    for (const [name, compute] of Object.entries(UNARY))
    {
        const respond = unary(name, compute);
        handlers[name] = returningDouble(fpu, 8, args=>respond(readDouble(args, 0)));

        // The FPU-stack form: one argument, consumed, replaced by the result.
        handlers[`_CI${name}`] = {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                const value = fpu.get(0);
                fpu.pop();
                fpu.setResult(respond(value));
                return 0;
            },
        };
    }

    for (const [name, compute] of Object.entries(BINARY))
    {
        handlers[name] = returningDouble(fpu, 16, args=>{
            const left = readDouble(args, 0);
            const right = readDouble(args, 2);
            return answer([left, right], compute(left, right));
        });

        // ST(1) is the left operand and ST(0) the right, because the left was
        // pushed first. Getting these the wrong way round is undetectable for
        // atan2 near the diagonal and wrong everywhere else.
        handlers[`_CI${name}`] = {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                const right = fpu.get(0);
                const left = fpu.get(1);
                fpu.pop();
                fpu.pop();
                fpu.setResult(answer([left, right], compute(left, right)));
                return 0;
            },
        };
    }

    /** double ldexp(double value, int exponent): only an overflow comes here. */
    handlers.ldexp = returningDouble(fpu, 12, args=>{
        const value = readDouble(args, 0);
        return answer([value], value * Math.pow(2, args[2] | 0));
    });

    /** double _scalb(double value, long exponent): ldexp under another name. */
    handlers._scalb = handlers.ldexp;

    /** double _logb(double x): only a zero comes here, -infinity and ERANGE. */
    handlers._logb = returningDouble(fpu, 8, args=>{
        const value = readDouble(args, 0);
        return answer([value], value === 0 ? -Infinity : value);
    });

    /** double _nextafter(double x, double y): only a step to an infinity, ERANGE. */
    handlers._nextafter = returningDouble(fpu, 16, args=>{
        const x = readDouble(args, 0);
        const y = readDouble(args, 2);
        return answer([x, y], nextAfter(x, y));
    });

    const guest = {
        readMemory: host.readMemory,
        writeMemory: host.writeMemory,
        fpu,
        ...host.setRegisters ? { setRegisters: host.setRegisters } : {},
    };

    /** @type {Record<string, ReturnType<typeof guestEntry>>} */
    const inTheGuest = {};
    for (const name of [...Object.keys(handlers), 'frexp', 'modf'])
    {
        const code = CODE_OF[name] ?? name;
        const source = /** @type {Record<string, Function>} */ (inGuestMath)[code]
            ?? /** @type {Record<string, Function>} */ (inGuestFloat)[code];
        const compiled = /** @type {Record<string, any>} */ (MATH_CODE)[code]
            ?? /** @type {Record<string, any>} */ (FLOAT_CODE)[code];
        if (source && compiled)
        {
            inTheGuest[name] = guestEntry(source, compiled, guest, handlers[name]);
        }
    }

    /**
     * __int64 _ftol(double value)
     *
     * Code in the guest's own module (`inguest.js`), so a cast costs a few
     * instructions, not a crossing, and the high half is there.
     */
    const ftol = host.setRegisters
        ? guestEntry(inGuest._ftol, COMPILED._ftol, host) : guestExport(COMPILED._ftol);

    const { setRegisters } = host;
    /** div and ldiv: the code, and a handler where the host can set EDX. */
    const divide = {
        convention: 'cdecl',
        argBytes: 8,
        code: ()=>DIVIDE_CODE,
        ...setRegisters ? {
            /** @param {number[]} args */
            handler: ([numerator, denominator])=>{
                const n = numerator | 0;
                const d = denominator | 0;
                if (d === 0 || n === -0x80000000 && d === -1)
                {
                    throw new Error('div: the guest divided by zero, or INT_MIN by -1');
                }
                const quotient = Math.trunc(n / d);
                setRegisters({ edx: (n - quotient * d) >>> 0 });
                return quotient >>> 0;
            },
        } : {},
    };

    return {
        ...handlers,
        ...inTheGuest,

        /** double floor(double x) -- in the guest */
        floor: guestEntry(inGuest.floor, COMPILED.floor, host),

        /** double ceil(double x) -- in the guest */
        ceil: guestEntry(inGuest.ceil, COMPILED.ceil, host),

        /** double fabs(double x) -- in the guest */
        fabs: guestEntry(inGuest.fabs, COMPILED.fabs, host),

        _ftol: ftol,
        _ftol2: ftol,
        _ftol2_sse: ftol,

        div: divide,
        ldiv: divide,

        /** double _copysign(double x, double y) -- in the guest */
        _copysign: guestEntry(inGuestFloat._copysign, FLOAT_CODE._copysign, guest),

        /** double _chgsign(double x) -- in the guest */
        _chgsign: guestEntry(inGuestFloat._chgsign, FLOAT_CODE._chgsign, guest),
    };
}
