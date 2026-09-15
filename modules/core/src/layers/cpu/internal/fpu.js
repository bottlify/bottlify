/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87 stack, as something outside the emulator can read and write.
 *
 * A 32-bit function that returns a `double` does not return it in a register
 * pair. It leaves it in ST(0), and the caller's next instruction stores it
 * from there. So a handler written in JavaScript that answers such a call has
 * to reach into the emulated FPU: returning a number sets EAX, which that
 * caller never reads, and it stores whatever was already on the stack --
 * usually one of its own operands, which is why the mistake reads as maths
 * that is nearly right rather than as a crash.
 *
 * The same door serves the entry points whose *arguments* arrive on the FPU
 * stack rather than on the caller's.
 *
 * The layout below is the emulator's, not the processor's: it keeps the stack
 * as eight registers plus a top index and a bitmap of which are empty, rather
 * than as the tag word a real x87 has, and a register holds either an
 * extended-precision value or the double the compiler tagged as one. The
 * addresses come from its own table of global offsets and are the one thing
 * here that a change in the vendored emulator could invalidate.
 */

/** Byte offsets into the emulator's linear memory, from its `global_pointers`. */
const STACK_EMPTY = 816;
const STACK_PTR = 1032;
const CONTROL_WORD = 1036;
const ST = 1152;

/** An extended-precision register: a 64-bit mantissa, a sign and exponent, padding. */
const REGISTER_SIZE = 16;

/** The exponent of an extended value equal to one, and of a double equal to one. */
const F80_BIAS = 16383;
const F64_BIAS = 1023;

/**
 * What the emulator's exponent word says when the register is not an extended
 * value at all, but a whole double sitting in the mantissa word.
 *
 * Its compiler keeps every x87 register it can in that form -- one load and one
 * store instead of a software 80-bit operation -- and its own readers canonicalise
 * it back before use. A register read raw, from outside, sees the double's bits as
 * a mantissa with a huge exponent, which is a number no program ever meant: an
 * enormous value or an infinity, and truncating either to an integer is zero. The
 * value is unrecoverable any other way, so every read through this door has to
 * know the tag.
 */
const RELAXED_TAG = 0x7ffe;

/**
 * A double as the two halves of an extended-precision register.
 *
 * The mantissa is left-aligned with an explicit leading bit -- the bit a double
 * leaves implied -- which is why every case here shifts by eleven: 63 bits of
 * significand where a double keeps 52.
 *
 * @param {number} value
 * @returns {{ low: number, high: number, signExponent: number }}
 */
export function encodeExtended(value){
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, value, true);
    const low = bits.getUint32(0, true);
    const high = bits.getUint32(4, true);

    const sign = high >>> 31;
    const exponent = high >>> 20 & 0x7ff;
    let fractionHigh = high & 0xfffff;
    let fractionLow = low;

    if (exponent === 0 && fractionHigh === 0 && fractionLow === 0)
    {
        return { low: 0, high: 0, signExponent: sign << 15 };
    }

    if (exponent === 0x7ff)
    {
        // Infinity and every NaN keep the leading bit set here, where a double
        // has none: an extended value without it is a shape the processor
        // treats as invalid rather than as the infinity that was meant.
        return {
            low: fractionLow << 11 >>> 0,
            high: (0x80000000 | fractionHigh << 11 | fractionLow >>> 21) >>> 0,
            signExponent: sign << 15 | 0x7fff,
        };
    }

    let unbiased = exponent - F64_BIAS;
    if (exponent === 0)
    {
        // A subnormal double has no leading bit to make explicit, so it is
        // shifted up until it has one. Extended precision has the range to
        // hold every one of these as an ordinary normal value.
        unbiased = 1 - F64_BIAS;
        while ((fractionHigh & 0x100000) === 0)
        {
            fractionHigh = fractionHigh << 1 | fractionLow >>> 31;
            fractionLow = fractionLow << 1 >>> 0;
            unbiased--;
        }
        fractionHigh &= 0xfffff;
    }

    return {
        low: fractionLow << 11 >>> 0,
        high: (0x80000000 | fractionHigh << 11 | fractionLow >>> 21) >>> 0,
        signExponent: sign << 15 | unbiased + F80_BIAS & 0x7fff,
    };
}

/**
 * The reverse, to the nearest double the value fits in.
 *
 * The low eleven bits of the mantissa have nowhere to go and are dropped
 * rather than rounded, because everything read back through here was a double
 * before the guest pushed it and those bits are zero.
 *
 * @param {number} low @param {number} high @param {number} signExponent
 * @returns {number}
 */
export function decodeExtended(low, high, signExponent){
    const sign = signExponent >>> 15 ? -1 : 1;
    const exponent = signExponent & 0x7fff;

    if (exponent === 0x7fff)
    {
        return (high & 0x7fffffff) === 0 && low === 0 ? sign * Infinity : NaN;
    }
    if (exponent === 0 && high === 0 && low === 0)
    {
        return sign * 0;
    }

    const shifted = exponent - F80_BIAS + F64_BIAS;
    if (shifted >= 0x7ff)
    {
        return sign * Infinity;
    }
    if (shifted <= 0)
    {
        // Below what a double holds as a normal number. Scaling is exact
        // enough here and the alternative is a second subnormal encoder for
        // values a program is not going to hand back through this door. The
        // scale is applied in two steps because in one it is a power of two
        // smaller than any double, which is zero, and the product with it is
        // zero however large the mantissa.
        const scale = exponent - F80_BIAS - 63;
        return sign * (high * 0x100000000 + low) * Math.pow(2, scale + 64) * Math.pow(2, -64);
    }

    const bits = new DataView(new ArrayBuffer(8));
    bits.setUint32(0, (high << 21 | low >>> 11) >>> 0, true);
    bits.setUint32(4, ((sign < 0 ? 0x80000000 : 0) | shifted << 20 | high >>> 11 & 0xfffff) >>> 0,
        true);
    return bits.getFloat64(0, true);
}

/**
 * A register as the number it holds, in whichever of the emulator's two forms
 * it was left: the extended one described above, or the tagged double.
 *
 * @param {number} low @param {number} high @param {number} signExponent
 * @returns {number}
 */
export function decodeRegister(low, high, signExponent){
    if (signExponent === RELAXED_TAG)
    {
        const bits = new DataView(new ArrayBuffer(8));
        bits.setUint32(0, low, true);
        bits.setUint32(4, high, true);
        return bits.getFloat64(0, true);
    }
    return decodeExtended(low, high, signExponent);
}

/**
 * @param {any} cpu  The emulator's CPU object, which owns the linear memory.
 * @returns {{ setResult: (value: number) => void, get: (index: number) => number,
 *             pop: () => void, depth: () => number, controlWord: () => number }}
 */
export function createFpu(cpu){
    /** @returns {DataView} A fresh view: the memory is grown and replaced under us. */
    const view = ()=>new DataView(cpu.wasm_memory.buffer);

    /** @param {DataView} memory @param {number} index Absolute register, not ST(n). */
    const readRegister = (memory, index)=>decodeRegister(
        memory.getUint32(ST + index * REGISTER_SIZE, true),
        memory.getUint32(ST + index * REGISTER_SIZE + 4, true),
        memory.getUint16(ST + index * REGISTER_SIZE + 8, true));

    return {
        /**
         * Leaves a double where a caller expecting one will look.
         *
         * The emulator's own push refuses when the slot is occupied and leaves
         * an indefinite value instead, which is what a real overflow does. This
         * does the same rather than overwriting: a full stack means the guest
         * lost track of its own pushes, and hiding that turns a diagnosable
         * fault into arithmetic that is quietly wrong from then on.
         *
         * @param {number} value
         */
        setResult(value){
            const memory = view();
            const top = memory.getUint8(STACK_PTR) - 1 & 7;
            memory.setUint8(STACK_PTR, top);
            const empty = memory.getUint8(STACK_EMPTY);
            const { low, high, signExponent } = (empty >>> top & 1) === 1
                ? encodeExtended(value)
                : { low: 0, high: 0xc0000000, signExponent: 0xffff };
            memory.setUint8(STACK_EMPTY, empty & ~(1 << top));
            memory.setUint32(ST + top * REGISTER_SIZE, low, true);
            memory.setUint32(ST + top * REGISTER_SIZE + 4, high, true);
            memory.setUint16(ST + top * REGISTER_SIZE + 8, signExponent, true);
        },

        /** @param {number} index ST(index), counted down from the top. */
        get(index){
            const memory = view();
            return readRegister(memory, memory.getUint8(STACK_PTR) + index & 7);
        },

        pop(){
            const memory = view();
            const top = memory.getUint8(STACK_PTR);
            memory.setUint8(STACK_EMPTY, memory.getUint8(STACK_EMPTY) | 1 << top);
            memory.setUint8(STACK_PTR, top + 1 & 7);
        },

        /** How many registers hold a value, for diagnostics and for tests. */
        depth(){
            const empty = view().getUint8(STACK_EMPTY);
            let held = 0;
            for (let index = 0; index < 8; index++)
            {
                held += empty >>> index & 1 ? 0 : 1;
            }
            return held;
        },

        controlWord: ()=>view().getUint16(CONTROL_WORD, true),
    };
}
