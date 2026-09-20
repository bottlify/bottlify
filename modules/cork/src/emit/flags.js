/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Lazy flags: how translated code remembers an arithmetic result instead
 * of computing six flags after every instruction.
 *
 * An instruction that writes the arithmetic flags records four things in
 * locals -- what kind of operation it was (with its width), its result and
 * its two operands -- and sets nothing else. A later instruction that reads
 * a flag computes it from the record: `cmp` followed by `jl` becomes one
 * signed compare of the two operands; `dec` followed by `jnz` a test of
 * the result against zero. Only where the record must become a real flags
 * word -- a `pushf`, an instruction that writes some flags and keeps the
 * others, the end of the region -- are all six computed, by one helper
 * function the module carries.
 *
 * Kinds are numbered with the width folded in (`kind * 4 + widthCode`), so
 * the helper's dispatch is one `br_table` and a kind's formula knows its
 * sign bit. The flags word in the `flags` local holds DF and the rest of
 * EFLAGS always, and the six arithmetic flags only while the kind is
 * EAGER; a partially lazy kind (INC keeps CF; SHIFT keeps CF and OF in
 * the word) says which of them the word still owns.
 */

import { AF, CF, OF, PF, SF, ZF } from '../decode/table.js';
import { Body, ValType } from '../wasm/encoder.js';

/** The operation kinds, before the width is folded in. */
export const Kind = Object.freeze({
    EAGER: 0,  // the six flags are in the word
    ADD: 1,    // res = op1 + op2
    ADC: 2,    // res = op1 + op2 + cin
    SUB: 3,    // res = op1 - op2
    SBB: 4,    // res = op1 - op2 - cin
    LOGIC: 5,  // res; CF = OF = AF = 0
    INC: 6,    // res = op1 + 1; CF stays in the word
    DEC: 7,    // res = op1 - 1; CF stays in the word
    NEG: 8,    // res = -op2; CF = op2 != 0
    SHIFT: 9,  // res; CF and OF stay in the word; AF undefined
});

/** @param {number} size */
export const widthCode = size=>(size === 1 ? 0 : size === 2 ? 1 : 2);

/** A kind with its width folded in. @param {number} kind @param {number} size */
export const kindOf = (kind, size)=>kind * 4 + widthCode(size);

/**
 * Which of the six flags a kind leaves in the word rather than in the record.
 * @param {number} kind
 */
export function eagerFlagsOf(kind){
    switch (kind)
    {
        case Kind.EAGER: return CF | PF | AF | ZF | SF | OF;
        case Kind.INC: case Kind.DEC: return CF;
        case Kind.SHIFT: return CF | OF;
        default: return 0;
    }
}

export const ARITH = CF | PF | AF | ZF | SF | OF;

/** i32 opcodes the formulas use. */
const OP = Object.freeze({
    eqz: 0x45, eq: 0x46, ne: 0x47, ltS: 0x48, ltU: 0x49, gtS: 0x4a, gtU: 0x4b,
    leS: 0x4c, leU: 0x4d, geS: 0x4e, geU: 0x4f, popcnt: 0x69,
    add: 0x6a, sub: 0x6b, and: 0x71, or: 0x72, xor: 0x73, shl: 0x74, shrS: 0x75, shrU: 0x76,
});
export { OP as I32 };

/** The sign bit and the mask by width code. */
const SIGN_BITS = [0x80, 0x8000, 0x80000000];
const MASKS = [0xff, 0xffff, 0xffffffff];

/**
 * The locals a region function keeps the record in, by index; the emitter
 * allocates them and tells the formulas where they are.
 *
 * @typedef {Object} FlagLocals
 * @property {number} kind   i32: `kindOf(kind, size)`, EAGER (0) when the word is whole
 * @property {number} res    i32: the result, masked to its width
 * @property {number} op1    i32: the first operand, masked
 * @property {number} op2    i32: the second operand, masked
 * @property {number} cin    i32: the carry in, 0 or 1, for ADC and SBB
 * @property {number} flags  i32: the flags word
 */

/**
 * Emits the value 0/1 of one flag from a record whose kind is known
 * statically (the common case: a read right after the write, in the same
 * block). Pushes an i32.
 *
 * @param {Body} b
 * @param {FlagLocals} l
 * @param {number} kind      an unfolded Kind
 * @param {number} width     the width code
 * @param {number} flag      CF, PF, AF, ZF, SF or OF
 */
export function emitFlag(b, l, kind, width, flag){
    const sign = SIGN_BITS[width];
    const eager = eagerFlagsOf(kind);
    if ((eager & flag) !== 0)
    {
        b.localGet(l.flags).i32const(flag).op(OP.and).i32const(0).op(OP.ne);
        return;
    }
    switch (flag)
    {
        case ZF:
            b.localGet(l.res).op(OP.eqz);
            return;
        case SF:
            b.localGet(l.res).i32const(sign).op(OP.and).i32const(0).op(OP.ne);
            return;
        case PF:
            // Even parity of the low byte: an even number of ones.
            b.localGet(l.res).i32const(0xff).op(OP.and).op(OP.popcnt).i32const(1).op(OP.and)
                .op(OP.eqz);
            return;
        case AF:
            if (kind === Kind.LOGIC || kind === Kind.SHIFT)
            {
                b.i32const(0);
                return;
            }
            // (op1 ^ op2 ^ res) & 0x10, with op2 = 1 for INC/DEC and 0 for NEG's op1.
            if (kind === Kind.INC || kind === Kind.DEC)
            {
                b.localGet(l.op1).i32const(1).op(OP.xor);
            }
            else if (kind === Kind.NEG)
            {
                b.localGet(l.op2);
            }
            else
            {
                b.localGet(l.op1).localGet(l.op2).op(OP.xor);
            }
            b.localGet(l.res).op(OP.xor).i32const(0x10).op(OP.and).i32const(0).op(OP.ne);
            return;
        case CF:
            switch (kind)
            {
                case Kind.ADD:
                    // Unsigned overflow: the sum wrapped below its first operand.
                    b.localGet(l.res).localGet(l.op1).op(OP.ltU);
                    return;
                case Kind.ADC:
                    // Wrapped, or equal with a carry in (op2 was all ones).
                    b.localGet(l.res).localGet(l.op1).op(OP.ltU);
                    b.localGet(l.res).localGet(l.op1).op(OP.eq).localGet(l.cin).op(OP.and);
                    b.op(OP.or);
                    return;
                case Kind.SUB:
                    b.localGet(l.op1).localGet(l.op2).op(OP.ltU);
                    return;
                case Kind.SBB:
                    b.localGet(l.op1).localGet(l.op2).op(OP.ltU);
                    b.localGet(l.op1).localGet(l.op2).op(OP.eq).localGet(l.cin).op(OP.and);
                    b.op(OP.or);
                    return;
                case Kind.NEG:
                    b.localGet(l.op2).i32const(0).op(OP.ne);
                    return;
                default: // LOGIC
                    b.i32const(0);
                    return;
            }
        default: // OF
            switch (kind)
            {
                case Kind.ADD: case Kind.ADC:
                    // The operands agree in sign and the result disagrees.
                    b.localGet(l.op1).localGet(l.res).op(OP.xor);
                    b.localGet(l.op2).localGet(l.res).op(OP.xor);
                    b.op(OP.and).i32const(sign).op(OP.and).i32const(0).op(OP.ne);
                    return;
                case Kind.SUB: case Kind.SBB:
                    b.localGet(l.op1).localGet(l.op2).op(OP.xor);
                    b.localGet(l.op1).localGet(l.res).op(OP.xor);
                    b.op(OP.and).i32const(sign).op(OP.and).i32const(0).op(OP.ne);
                    return;
                case Kind.INC:
                    b.localGet(l.res).i32const(sign).op(OP.eq);
                    return;
                case Kind.DEC:
                    b.localGet(l.res).i32const((sign - 1) >>> 0).op(OP.eq);
                    return;
                case Kind.NEG:
                    b.localGet(l.res).i32const(sign).op(OP.eq);
                    return;
                default: // LOGIC
                    b.i32const(0);
                    return;
            }
    }
}

/**
 * Emits the value 0/1 of a condition code from a statically known record:
 * one compare where the record is a subtraction, the flag formulas
 * otherwise. Pushes an i32.
 *
 * @param {Body} b
 * @param {FlagLocals} l
 * @param {number} kind
 * @param {number} width
 * @param {number} cc
 */
export function emitCondition(b, l, kind, width, cc){
    const test = cc >> 1;
    const negate = (cc & 1) === 1;
    const sign = SIGN_BITS[width];
    const shift = 32 - 8 * (1 << width);
    /** Both operands sign-extended from their width, for a signed compare. */
    const signedOperands = ()=>{
        b.localGet(l.op1).i32const(shift).op(OP.shl).i32const(shift).op(OP.shrS);
        b.localGet(l.op2).i32const(shift).op(OP.shl).i32const(shift).op(OP.shrS);
    };
    if (kind === Kind.SUB)
    {
        // cmp a, b: every condition is a compare of the operands themselves.
        switch (test)
        {
            case 1: b.localGet(l.op1).localGet(l.op2).op(negate ? OP.geU : OP.ltU); return;
            case 2:
                b.localGet(l.res).op(OP.eqz);
                if (negate)
                {
                    b.op(OP.eqz);
                }
                return;
            case 3: b.localGet(l.op1).localGet(l.op2).op(negate ? OP.gtU : OP.leU); return;
            case 6: signedOperands(); b.op(negate ? OP.geS : OP.ltS); return;
            case 7: signedOperands(); b.op(negate ? OP.gtS : OP.leS); return;
            default: break;
        }
    }
    switch (test)
    {
        case 0: emitFlag(b, l, kind, width, OF); break;
        case 1: emitFlag(b, l, kind, width, CF); break;
        case 2: emitFlag(b, l, kind, width, ZF); break;
        case 3:
            emitFlag(b, l, kind, width, CF);
            emitFlag(b, l, kind, width, ZF);
            b.op(OP.or);
            break;
        case 4: emitFlag(b, l, kind, width, SF); break;
        case 5: emitFlag(b, l, kind, width, PF); break;
        case 6:
            emitFlag(b, l, kind, width, SF);
            emitFlag(b, l, kind, width, OF);
            b.op(OP.ne);
            break;
        default:
            emitFlag(b, l, kind, width, ZF);
            emitFlag(b, l, kind, width, SF);
            emitFlag(b, l, kind, width, OF);
            b.op(OP.ne);
            b.op(OP.or);
    }
    void sign;
    if (negate)
    {
        b.op(OP.eqz);
    }
}

/**
 * The module's flag helper: `(kind, res, op1, op2, cin, flags) → flags`,
 * the whole word with the six arithmetic flags computed from the record.
 * A region calls it wherever the record must become a word -- at exits,
 * before a partial flag write, for a `pushf` -- and wherever it reads a
 * flag whose record it does not know statically (a block entered from
 * elsewhere), taking the flag out of the word it returns.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @returns {number} the function index
 */
export function addMaterialiseHelper(m){
    const type = m.type({
        params: [ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32],
        results: [ValType.i32],
    });
    /** @type {FlagLocals} */
    const l = { kind: 0, res: 1, op1: 2, op2: 3, cin: 4, flags: 5 };
    const b = new Body();
    // One block per (kind, width): br_table on the folded kind, each case
    // building the word from the formulas above and returning it.
    const cases = [];
    for (let kind = 1; kind < 10; kind++)
    {
        for (let width = 0; width < 3; width++)
        {
            cases.push([kind, width]);
        }
    }
    // Outer block for EAGER (and any unknown kind): the word as it is.
    b.block(ValType.i32);
    // The dispatch: cases are numbered kind*4+width; a width code 3 does not
    // exist and lands with EAGER.
    const labels = [];
    for (let folded = 0; folded < 40; folded++)
    {
        const kind = folded >> 2;
        const width = folded & 3;
        labels.push(kind >= 1 && width <= 2
            ? cases.findIndex(c=>c[0] === kind && c[1] === width) + 1
            : 0);
    }
    // Blocks nested: the innermost is case 0; label n = case n-1 (1-based),
    // label 0 = "no case" -> falls to the eager answer. br_table depths are
    // relative to the point of the br_table, which sits inside every block.
    for (let i = cases.length - 1; i >= 0; i--)
    {
        b.block(ValType.i32);
    }
    // A block starts with an empty stack, so the word every label carries
    // is pushed here, inside the innermost block, under the index.
    b.localGet(l.flags);
    b.localGet(l.kind);
    b.brTable(labels.map(label=>(label === 0 ? cases.length : label - 1)), cases.length);
    // Each case: drop the pushed word, build a new one, br out to the outer block.
    for (let i = 0; i < cases.length; i++)
    {
        b.end();
        const [kind, width] = cases[i];
        b.drop();
        // flags & ~ARITH, then each flag or'ed in.
        b.localGet(l.flags).i32const(~ARITH).op(OP.and);
        for (const flag of [CF, PF, AF, ZF, SF, OF])
        {
            emitFlag(b, l, kind, width, flag);
            b.i32const(flag).op(0x6c); // i32.mul: 0/1 * flag
            b.op(OP.or);
        }
        b.br(cases.length - i - 1);
    }
    b.end();
    return m.function(type, [], b.toBytes());
}

/** The widths' masks, for the emitter. */
export { MASKS, SIGN_BITS };
