/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How a C function hands a `double` back to guest code.
 *
 * There is no register pair for this. A 32-bit function returning a double
 * leaves it in ST(0), the top of the x87 stack, and the caller's very next
 * instruction is an `fstp` that stores it somewhere. A handler that returns a
 * JavaScript number sets EAX and nothing else, so the caller stores whatever
 * happened to be on the FPU stack already -- usually one of its own operands,
 * which is why the mistake reads as "the maths is nearly right".
 *
 * Everything that returns a double therefore needs a seam into the emulated
 * FPU. The seam is optional: a runtime assembled without one simply does not
 * export these functions, and an unresolved import is a message that names the
 * function. Exporting them and returning a wrong number is the worse failure,
 * because nothing reports it.
 *
 * @typedef {Object} FloatHost
 * @property {(value: number) => void} setResult  Leaves a double in ST(0).
 * @property {(value: number) => void} [setSingleResult]  Leaves a float where
 *           the caller reads one: the same ST(0) at 32 bits, XMM0's low lane in
 *           a 64-bit process, where a float and a double are returned apart.
 * @property {(index: number) => number} get      Reads ST(index), for the `_CI*`
 *           entry points, whose arguments arrive on the FPU stack rather than
 *           on the caller's stack.
 * @property {() => void} pop                     Discards ST(0).
 * @property {() => number} [controlWord]         The x87 control word.
 * @property {(word: number) => void} [setControlWord]
 * @property {() => number} [statusWord]          The x87 status word, without the top.
 * @property {() => void} [clearExceptions]       The exception flags cleared, as `fnclex`.
 * @property {() => number} [mxcsr]                SSE's control and status register.
 * @property {(word: number) => void} [setMxcsr]   MXCSR loaded, as `ldmxcsr`.
 */

/**
 * A double built from the two stack slots it occupies.
 *
 * Little-endian, low half first: the same order the guest pushed them in, and
 * the reason a variadic reader that treats a double as one slot misreads every
 * argument after it as well.
 *
 * @param {number[]} args
 * @param {number} at   Index of the low half.
 */
export function readDouble(args, at){
    SCRATCH.setUint32(0, (args[at] ?? 0) >>> 0, true);
    SCRATCH.setUint32(4, (args[at + 1] ?? 0) >>> 0, true);
    return SCRATCH.getFloat64(0, true);
}

/** The eight bytes a double is put together in: one, not a buffer made at every call. */
const SCRATCH = new DataView(new ArrayBuffer(8));

/**
 * Builds a cdecl entry whose result is a double.
 *
 * EAX is left at zero, which is what a compiler's own call sequence expects:
 * it reads the result off the FPU stack and never looks at EAX at all.
 *
 * @param {FloatHost} fpu
 * @param {number} argBytes
 * @param {(args: number[]) => number} compute
 * @param {Record<number, 'f32' | 'f64'>} [floats]  Its floating-point
 *     arguments by their first dword (the bridge's `floats`), which a 64-bit
 *     caller passes in XMM registers.
 */
export function returningDouble(fpu, argBytes, compute, floats){
    return {
        convention: 'cdecl',
        argBytes,
        ...floats ? { floats } : {},
        /** @param {number[]} args */
        handler: args=>{
            fpu.setResult(compute(args));
            return 0;
        },
    };
}

/**
 * The same for a float result.
 *
 * @param {FloatHost} fpu
 * @param {number} argBytes
 * @param {(args: number[]) => number} compute
 * @param {Record<number, 'f32' | 'f64'>} [floats]
 */
export function returningSingle(fpu, argBytes, compute, floats){
    return {
        convention: 'cdecl',
        argBytes,
        ...floats ? { floats } : {},
        /** @param {number[]} args */
        handler: args=>{
            setSingle(fpu, compute(args));
            return 0;
        },
    };
}

/**
 * Leaves a float result where the caller reads one: ST(0) as a double is
 * left at 32 bits, where the caller's store rounds it.
 *
 * @param {FloatHost} fpu @param {number} value
 */
export function setSingle(fpu, value){
    if (fpu.setSingleResult)
    {
        fpu.setSingleResult(value);
        return;
    }
    fpu.setResult(value);
}

/**
 * A float read from the dword it occupies.
 *
 * @param {number[]} args @param {number} at
 */
export function readSingle(args, at){
    SCRATCH.setUint32(0, (args[at] ?? 0) >>> 0, true);
    return SCRATCH.getFloat32(0, true);
}

/**
 * Where a 64-bit process's C functions answer a floating-point value: XMM0,
 * a double in its low quadword and a float in its low lane, the lanes above
 * cleared. What the x64 convention returns them in, in place of ST(0).
 *
 * @param {(index: number, words: Uint32Array) => void} writeXmm
 * @returns {Pick<FloatHost, 'setResult' | 'setSingleResult'>}
 */
export function longFloatResults(writeXmm){
    return {
        setResult(value){
            SCRATCH.setFloat64(0, value, true);
            writeXmm(0, Uint32Array.of(SCRATCH.getUint32(0, true), SCRATCH.getUint32(4, true),
                0, 0));
        },
        setSingleResult(value){
            SCRATCH.setFloat32(0, value, true);
            writeXmm(0, Uint32Array.of(SCRATCH.getUint32(0, true), 0, 0, 0));
        },
    };
}
