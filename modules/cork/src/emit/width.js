/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The register width a region is emitted for: what of the emitter depends on
 * whether the guest runs 32-bit code or long mode's, decided once per module
 * from its layout. The 32-bit width is the emitter as it always was -- its
 * modules come out byte for byte the same (`tools/emit-digest.mjs`) -- and
 * long mode's keeps every one of its techniques, its registers sixteen i64
 * locals:
 *
 *   - a dword operation is i32 over the low half (`i32.wrap_i64` on the way in,
 *     `i64.extend_i32_u` on the way out), which machine code at either host's
 *     64-bit registers does for nothing;
 *   - the parameters carry Win64's argument registers (rcx, rdx, r8, r9) across
 *     a call or a transfer, as the 32-bit width carries eax..ebx;
 *   - the flag record's result and operands are i64 (`FlagLocals.wide`).
 */

import { ValType } from '../wasm/encoder.js';

/**
 * @typedef {Object} Width
 * @property {32 | 64} bits
 * @property {number} regs        general registers
 * @property {4 | 8} slot         a register's bytes in the state block, a push's and a pop's
 * @property {number} regType     a register local's wasm type
 * @property {readonly number[]} carried  the guest registers the parameters carry, in order
 * @property {readonly number[]} regLocal by guest register, its local
 * @property {readonly number[]} locals   the region function's locals past its parameters,
 *     as every region has them, before the vector scratch
 * @property {readonly number[]} upper    locals past the vector scratch every region has:
 *     long mode's registers that do not fit before the flag record
 * @property {number} recordType  the flag record's result and operands
 */

/** The locals past the parameters every region function has, 32-bit layout's. */
const LOCALS_32 = Object.freeze([
    // esp, ebp, esi, edi, the record, the flags word and the run's budget: the
    // parameters they once were, locals of the function now.
    ...new Array(11).fill(ValType.i32),
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // eip..addr
    ValType.i64, ValType.i64,
    ValType.i32, // count
    ValType.f32, ValType.f32, ValType.f64, ValType.f64, // f0 f1 d0 d1
    ValType.i32, // mmxTouched
    ValType.i32, ValType.i32, // pflags stale
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // x87Top..x87Dirty
]);

/** @type {Width} */
export const WIDTH_32 = Object.freeze({
    bits: 32, regs: 8, slot: 4, regType: ValType.i32,
    carried: Object.freeze([0, 1, 2, 3]),
    regLocal: Object.freeze([2, 3, 4, 5, 6, 7, 8, 9]),
    locals: LOCALS_32,
    upper: Object.freeze([]),
    recordType: ValType.i32,
});

/**
 * Long mode's: rcx, rdx, r8 and r9 carried in locals 2..5, rax, rbx, rsp and
 * rbp in 6..9, the others (rsi, rdi, r10..r15) past the vector scratch, 40..47.
 * @type {Width}
 */
export const WIDTH_64 = Object.freeze({
    bits: 64, regs: 16, slot: 8, regType: ValType.i64,
    carried: Object.freeze([1, 2, 8, 9]),
    regLocal: Object.freeze([6, 2, 3, 7, 8, 9, 40, 41, 4, 5, 42, 43, 44, 45, 46, 47]),
    locals: Object.freeze([
        ValType.i64, ValType.i64, ValType.i64, ValType.i64, // rax rbx rsp rbp
        ValType.i32, ValType.i64, ValType.i64, ValType.i64, ValType.i32, // the record
        ValType.i32, ValType.i32, // flags, origin
        ...LOCALS_32.slice(11),
    ]),
    upper: Object.freeze(new Array(8).fill(ValType.i64)),
    recordType: ValType.i64,
});

/**
 * @param {{ bits?: 32 | 64 }} layout
 * @returns {Width}
 */
export const widthOf = layout=>(layout.bits === 64 ? WIDTH_64 : WIDTH_32);
