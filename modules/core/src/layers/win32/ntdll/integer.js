/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 64-bit helpers a 32-bit compiler calls instead of emitting the arithmetic.
 *
 * A `long long` multiply, divide or remainder is a function call on this target,
 * and the compiler writes that call itself -- so the convention is the
 * compiler's, not one anybody chose or can look up in a header. Two things about
 * it are settled by what the call site does:
 *
 * - Both operands are pushed as two words each, low half first, so the argument
 *   list is sixteen bytes.
 * - Nothing adjusts the stack pointer after the CALL, so the callee pops all
 *   sixteen. That is stdcall's rule, and it is why these are declared with the
 *   same argBytes a stdcall function would use despite being spelled like C.
 *
 * The result is a 64-bit value, which on this processor means EDX:EAX. The
 * dispatcher places a handler's return value in EAX and touches nothing else,
 * which is the whole answer for every other function in this library and half of
 * one here -- so the high word is written to EDX directly, and the low word is
 * returned in the ordinary way.
 *
 * The shift helpers of the same family are deliberately absent. They take their
 * operand in EDX:EAX and their count in CL rather than on the stack, and the
 * call stub loads both EAX and EDX with its own values before the host sees the
 * call: by the time a handler could run, the operand is gone. Exporting them
 * would mean shifting whatever the stub happened to leave behind.
 */

/**
 * @typedef {Object} IntegerHost
 * @property {(values: Record<string, number>) => void} setRegisters
 */

/**
 * Builds the arithmetic half of the table: name -> { argBytes, handler }.
 *
 * @param {IntegerHost} host
 */
export function createIntegerFunctions(host){
    /**
     * One operand: two argument slots, low half first. The slots arrive signed,
     * so each has to be read back as the unsigned word it was on the stack
     * before the halves are joined.
     *
     * @param {number[]} args @param {number} slot
     */
    const operand = (args, slot)=>
        BigInt(args[slot] >>> 0) | BigInt(args[slot + 1] >>> 0) << 32n;

    /**
     * Places a 64-bit answer where the caller reads it from.
     *
     * @param {bigint} value
     * @returns {number} the low half, for the dispatcher to put in EAX
     */
    const wide = value=>{
        const bits = BigInt.asUintN(64, value);
        host.setRegisters({ edx: Number(bits >> 32n) });
        return Number(bits & 0xffffffffn);
    };

    /**
     * Dividing by zero traps on the processor, and this is the routine the trap
     * would have come from. There is no divisor to substitute that would not be
     * an answer the program never computed, so the failure is reported.
     *
     * @param {string} name @param {bigint} divisor
     */
    const nonZero = (name, divisor)=>{
        if (divisor === 0n)
        {
            throw new Error(`${name}: the guest divided a 64-bit value by zero`);
        }
        return divisor;
    };

    /**
     * @param {string} name
     * @param {(a: bigint, b: bigint) => bigint} arithmetic
     * @param {boolean} signed
     */
    const binary = (name, arithmetic, signed)=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            const a = operand(args, 0);
            const b = operand(args, 2);
            return wide(signed
                ? arithmetic(BigInt.asIntN(64, a), BigInt.asIntN(64, b))
                : arithmetic(a, b));
        },
    });

    return {
        /**
         * __int64 _allmul(__int64 a, __int64 b)
         *
         * One multiply for both signednesses, because the low 64 bits of the
         * product are the same either way -- which is why the compiler emits this
         * for a signed and an unsigned multiply alike.
         */
        _allmul: binary('_allmul', (a, b)=>a * b, false),

        /**
         * __int64 _alldiv(__int64 a, __int64 b)
         *
         * BigInt division truncates towards zero and its remainder takes the sign
         * of the dividend, which is what C requires of both.
         */
        _alldiv: binary('_alldiv', (a, b)=>a / nonZero('_alldiv', b), true),

        /** __int64 _allrem(__int64 a, __int64 b) */
        _allrem: binary('_allrem', (a, b)=>a % nonZero('_allrem', b), true),

        /** unsigned __int64 _aulldiv(unsigned __int64 a, unsigned __int64 b) */
        _aulldiv: binary('_aulldiv', (a, b)=>a / nonZero('_aulldiv', b), false),

        /** unsigned __int64 _aullrem(unsigned __int64 a, unsigned __int64 b) */
        _aullrem: binary('_aullrem', (a, b)=>a % nonZero('_aullrem', b), false),
    };
}
