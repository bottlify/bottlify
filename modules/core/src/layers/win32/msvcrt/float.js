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
 * @property {(index: number) => number} get      Reads ST(index), for the `_CI*`
 *           entry points, whose arguments arrive on the FPU stack rather than
 *           on the caller's stack.
 * @property {() => void} pop                     Discards ST(0).
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
 */
export function returningDouble(fpu, argBytes, compute){
    return {
        convention: 'cdecl',
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            fpu.setResult(compute(args));
            return 0;
        },
    };
}
