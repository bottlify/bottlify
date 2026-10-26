/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The long-mode translator's emitter: a region of x86-64 code -- blocks, each
 * a straight run of instructions up to a branch, joined by the jumps between
 * them whose targets are known -- as one wasm function over cork's 64-bit
 * state block (`ownLayout({ bits: 64 })`).
 *
 * The function returns `retired << 2 | code`. The sixteen registers live in
 * i64 locals, loaded at entry where the region touches them and stored at its
 * one exit where it wrote them; RIP and the flags word are locals too. The
 * flags are lazy: an arithmetic instruction leaves a record (kind, width,
 * operands, result, carry in, the flags it writes) that a helper turns into
 * the word only where something reads it, and at the exit; a record crosses
 * from block to block. A jump to a block of the region goes on inside the
 * function, through a dispatch loop, until the instructions it retired reach
 * the module's `budget` global; any other leaves with RIP at the target.
 *
 * What the block cannot do itself it leaves before the instruction, with the
 * state exactly as the interpreter (`interp64.js`) wants it: an instruction it
 * has no case for, an address at or past 4 GiB, a page the program cannot
 * reach, a store into translated code or a watched page, a stack word of 16
 * bits. Every check an instruction needs is made before anything it writes, so
 * an exit never leaves half an instruction behind. `ir64.js` is the
 * reference: each case here computes what its case there computes, the flags
 * it leaves undefined kept as they were.
 */

import { Body, EMPTY, ModuleBuilder, ValType } from '../wasm/encoder.js';
import { pageFlagsAt } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { AF, CF, OF, PF, SF, ZF } from '../decode/table.js';

const ARITH = CF | PF | AF | ZF | SF | OF;

/** What a region function answers in its low two bits. */
export const LongExit = Object.freeze({
    /** It left by a jump or its budget: RIP is where the program goes next. */
    NEXT: 0,
    /** It stopped before the instruction at RIP, which the interpreter runs. */
    INTERPRET: 1,
});

/** Lazy flag kinds, the helper's (`flagsHelper`). */
const Kind = Object.freeze({ ADD: 1, ADC: 2, SUB: 3, SBB: 4, LOGIC: 5, INC: 6, DEC: 7, IMUL: 8 });
/** Shift kinds, the shift helper's. */
const Shift = Object.freeze({ shl: 0, sal: 0, shr: 1, sar: 2, rol: 3, ror: 4 });

// Locals: the sixteen registers first, by number.
const RIP = 16;
const FL = 17;
const PK = 18;
const PS = 19;
const PA = 20;
const PB = 21;
const PR = 22;
const PC = 23;
const PW = 24;
const T0 = 25;
const T1 = 26;
const T2 = 27;
const T3 = 28;
const A = 29;
const K = 30;
const CODE = 31;
/** The block of the region the dispatch loop goes to. */
const IDX = 32;
const LOCALS = [
    ...new Array(16).fill(ValType.i64), ValType.i64, ValType.i32,
    ValType.i32, ValType.i32, ValType.i64, ValType.i64, ValType.i64, ValType.i32, ValType.i32,
    ValType.i64, ValType.i64, ValType.i64, ValType.i64, ValType.i32, ValType.i32, ValType.i32,
    ValType.i32,
];
/** The module's one global: instructions a call may retire before it leaves. */
const BUDGET = 0;

/** The wasm opcodes this emitter writes, by name. */
const Op = Object.freeze({
    i32eqz: 0x45, i32eq: 0x46, i32ne: 0x47, i32ltu: 0x49, i32gtu: 0x4b, i32leu: 0x4d,
    i32geu: 0x4f, i64eqz: 0x50, i64eq: 0x51, i64ne: 0x52, i64lts: 0x53, i64ltu: 0x54,
    i64gtu: 0x56, i32add: 0x6a, i32sub: 0x6b, i32and: 0x71, i32or: 0x72, i32xor: 0x73,
    i32shl: 0x74, i32shru: 0x76, i32remu: 0x70, i32popcnt: 0x69, i64popcnt: 0x7b,
    i64add: 0x7c, i64sub: 0x7d, i64mul: 0x7e, i64divs: 0x7f, i64and: 0x83, i64or: 0x84,
    i64xor: 0x85, i64shl: 0x86, i64shrs: 0x87, i64shru: 0x88, i64rotl: 0x89, i64rotr: 0x8a,
    i32wrap: 0xa7, i64extends: 0xac, i64extendu: 0xad, i64ext8: 0xc2, i64ext16: 0xc3,
    i64ext32: 0xc4, select: 0x1b,
});

/** @param {number} size */
const maskOf = size=>(size === 8 ? -1n : (1n << BigInt(size * 8)) - 1n);

/**
 * The instructions this emitter translates; anything else ends a block before
 * it, for the interpreter.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
export function translates(instruction){
    const { op, operands, size, prefixes } = instruction;
    // A repeat prefix on a branch is a hint (`rep ret`, `bnd jmp`); on anything
    // translated here but a string instruction it means nothing either.
    if (prefixes.lock
        || operands.some(operand=>operand.kind !== 'reg' && operand.kind !== 'mem'
            && operand.kind !== 'imm' && operand.kind !== 'rel'))
    {
        return false;
    }
    switch (op)
    {
        case 'nop': case 'mov': case 'movzx': case 'movsx': case 'movsxd': case 'lea':
        case 'add': case 'adc': case 'sub': case 'sbb': case 'cmp': case 'and': case 'or':
        case 'xor': case 'test': case 'inc': case 'dec': case 'neg': case 'not':
        case 'jmp': case 'ret': case 'cwde': case 'cdq': case 'bswap': case 'call':
            return true;
        case 'imul':
            return operands.length > 1;
        case 'xchg':
            return operands.every(operand=>operand.kind === 'reg');
        case 'shl': case 'sal': case 'shr': case 'sar': case 'rol': case 'ror':
            return true;
        case 'push':
            return (operands[0].kind === 'imm' ? size : operands[0].size) === 8;
        case 'pop':
            return operands[0].kind === 'reg' && operands[0].size === 8;
        default:
            return instruction.cc !== undefined
                && (op.startsWith('j') || op.startsWith('set') || op.startsWith('cmov'));
    }
}

/** Whether the instruction ends a block: control leaves the straight line. @param {string} op */
export const endsBlock = op=>op === 'jmp' || op === 'call' || op === 'ret' || op.startsWith('j')
    || op === 'loop' || op === 'loope' || op === 'loopne';

/**
 * How a block ended: on into the next instruction (`true`), or by a jump --
 * to `to`, known, or to wherever RIP was set (`to` null); a conditional one
 * goes to `next` when `cc` does not hold.
 *
 * @typedef {true | { to: number | null, cc?: number, next?: number }} Ending
 */

/**
 * Emits a region's function body, a block at a time.
 */
class BlockEmitter {
    /**
     * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
     * @param {{ flags: number, shift: number }} helpers  function indices
     */
    constructor(layout, helpers){
        this.layout = layout;
        this.helpers = helpers;
        this.b = new Body(1024);
        /** Ifs opened inside the block being emitted. */
        this.nest = 0;
        /** Labels between the block's code and the exit block, ifs aside. */
        this.outer = 1;
        this.flagTable = pageFlagsAt(layout);
    }

    /** The depth of a branch to the exit block from here. */
    get exitDepth(){
        return this.outer + this.nest;
    }

    // --- structure ---

    /** @param {number} [type] */
    open(type = EMPTY){
        this.b.if(type);
        this.nest++;
    }

    close(){
        this.b.end();
        this.nest--;
    }

    /**
     * Leaves before the instruction: what the block retired before it added to
     * the count, and RIP at it.
     *
     * @param {number} index @param {number} address
     */
    exitBefore(index, address){
        const { b } = this;
        if (index > 0)
        {
            b.localGet(K).i32const(index).op(Op.i32add).localSet(K);
        }
        b.i32const(LongExit.INTERPRET).localSet(CODE)
            .i64const(BigInt(address)).localSet(RIP).br(this.exitDepth);
    }

    /** With an i32 condition on the stack: leave before the instruction when it holds. */
    exitIf(/** @type {number} */ index, /** @type {number} */ address){
        this.open();
        this.exitBefore(index, address);
        this.close();
    }

    // --- registers and operands ---

    /** @param {number} reg @param {number} size @param {boolean} [high] */
    readReg(reg, size, high = false){
        const { b } = this;
        b.localGet(reg);
        if (high)
        {
            b.i64const(8n).op(Op.i64shru).i64const(0xffn).op(Op.i64and);
        }
        else if (size < 8)
        {
            b.i64const(maskOf(size)).op(Op.i64and);
        }
    }

    /** Writes the i64 on the stack to a register by long mode's rule. @param {number} reg
     * @param {number} size @param {boolean} [high] */
    writeReg(reg, size, high = false){
        const { b } = this;
        if (size === 8)
        {
            b.localSet(reg);
            return;
        }
        if (size === 4)
        {
            b.i64const(0xffffffffn).op(Op.i64and).localSet(reg);
            return;
        }
        const shift = high ? 8n : 0n;
        const mask = maskOf(size) << shift;
        b.i64const(maskOf(size)).op(Op.i64and);
        if (high)
        {
            b.i64const(8n).op(Op.i64shl);
        }
        b.localSet(T3).localGet(reg).i64const(BigInt.asIntN(64, ~mask)).op(Op.i64and)
            .localGet(T3).op(Op.i64or).localSet(reg);
    }

    /**
     * The effective address of a memory operand, an i64, before the window
     * check.
     *
     * @param {import('../decode/decoder.js').Operand} operand
     * @param {boolean} [segmented]  FS's or GS's base added, as an access does and `lea` does not
     */
    effective(operand, segmented = true){
        const { b, layout } = this;
        if (operand.rip)
        {
            b.i64const(BigInt.asUintN(64, BigInt(/** @type {number} */ (operand.disp))));
        }
        else if (operand.upper !== undefined)
        {
            b.i64const(BigInt.asIntN(64, BigInt(operand.upper) << 32n
                | BigInt(/** @type {number} */ (operand.disp) >>> 0)));
        }
        else
        {
            b.i64const(BigInt(operand.disp ?? 0));
            if ((operand.base ?? -1) >= 0)
            {
                b.localGet(/** @type {number} */ (operand.base)).op(Op.i64add);
            }
            if ((operand.index ?? -1) >= 0)
            {
                b.localGet(/** @type {number} */ (operand.index));
                const scale = operand.scale ?? 1;
                if (scale > 1)
                {
                    b.i64const(BigInt(Math.log2(scale))).op(Op.i64shl);
                }
                b.op(Op.i64add);
            }
        }
        if (operand.addressSize === 32)
        {
            b.i64const(0xffffffffn).op(Op.i64and);
        }
        if (segmented && (operand.segment === 4 || operand.segment === 5))
        {
            b.i32const(0).load('i64',
                { offset: operand.segment === 4 ? layout.fsBase : layout.gsBase })
                .op(Op.i64add);
        }
    }

    /**
     * The operand's address into A, checked: below 4 GiB, and every page the
     * access reaches open to it -- or the block leaves before the instruction.
     *
     * @param {import('../decode/decoder.js').Operand} operand
     * @param {boolean} store @param {number} index @param {number} address
     */
    place(operand, store, index, address){
        const { b } = this;
        this.effective(operand);
        b.localTee(T0).i64const(32n).op(Op.i64shru).op(Op.i64eqz).op(Op.i32eqz);
        this.exitIf(index, address);
        b.localGet(T0).op(Op.i32wrap).localSet(A);
        this.checkPage(store, index, address, operand.size);
    }

    /**
     * Tests the pages A and the access's last byte lie on.
     *
     * @param {boolean} store @param {number} index @param {number} address @param {number} size
     */
    checkPage(store, index, address, size){
        const { b } = this;
        const flags = PageFlag.INACCESSIBLE | (store ? PageFlag.HAS_CODE | PageFlag.WATCH : 0);
        b.localGet(A).i32const(12).op(Op.i32shru).load('i32_8u', { offset: this.flagTable })
            .i32const(flags).op(Op.i32and);
        this.exitIf(index, address);
        if (size > 1)
        {
            // Across a page: the last byte's page as well.
            b.localGet(A).i32const(0xfff).op(Op.i32and).i32const(0x1000 - size)
                .op(Op.i32gtu);
            this.open();
            b.localGet(A).i32const(size - 1).op(Op.i32add).i32const(12).op(Op.i32shru)
                .load('i32_8u', { offset: this.flagTable }).i32const(flags).op(Op.i32and);
            this.exitIf(index, address);
            this.close();
        }
    }

    /** Loads `size` bytes at A, zero-extended to an i64. @param {number} size */
    loadAt(size){
        const offset = this.layout.ramBase;
        this.b.localGet(A).load(size === 8 ? 'i64' : size === 4 ? 'i64_32u'
            : size === 2 ? 'i64_16u' : 'i64_8u', { offset, align: 0 });
    }

    /** Stores the i64 on the stack, `size` bytes, at A. @param {number} size */
    storeAt(size){
        const { b } = this;
        b.localSet(T3).localGet(A).localGet(T3).store(size === 8 ? 'i64' : size === 4 ? 'i64_32'
            : size === 2 ? 'i64_16' : 'i64_8', { offset: this.layout.ramBase, align: 0 });
    }

    /**
     * An operand's value as an i64, zero-extended from its size; a memory one
     * read at A, which `place` has set.
     *
     * @param {import('../decode/decoder.js').Operand} operand
     */
    read(operand){
        const { b } = this;
        switch (operand.kind)
        {
            case 'reg':
                this.readReg(/** @type {number} */ (operand.reg), operand.size, operand.high);
                return;
            case 'imm':
                b.i64const(operand.upper !== undefined
                    ? BigInt.asIntN(64, BigInt(operand.upper) << 32n
                        | BigInt(/** @type {number} */ (operand.value) >>> 0))
                    : BigInt.asUintN(operand.size * 8,
                        BigInt(/** @type {number} */ (operand.value))));
                return;
            case 'mem':
                this.loadAt(operand.size);
                return;
            default:
                throw new Error(`long emit: no read of ${operand.kind}`);
        }
    }

    /** Writes the i64 on the stack to an operand (a memory one at A). @param {import('../decode/decoder.js').Operand} operand */
    write(operand){
        if (operand.kind === 'reg')
        {
            this.writeReg(/** @type {number} */ (operand.reg), operand.size, operand.high);
            return;
        }
        this.storeAt(operand.size);
    }

    // --- flags ---

    /** The pending record, if any, folded into FL. */
    settle(){
        const { b } = this;
        b.localGet(PK);
        this.open();
        b.localGet(PK).localGet(PS).localGet(PA).localGet(PB).localGet(PR).localGet(PC)
            .localGet(PW).localGet(FL).call(this.helpers.flags).localSet(FL)
            .i32const(0).localSet(PK);
        this.close();
    }

    /**
     * Leaves a record: the operands and result as i64 locals T0, T1, T2.
     *
     * @param {number} kind @param {number} size @param {number} written
     * @param {boolean} [carried]  the carry in is FL's CF, settled before
     */
    record(kind, size, written, carried = false){
        const { b } = this;
        if ((written & ARITH) !== ARITH)
        {
            // The record before holds flags this one leaves as they were.
            this.settle();
        }
        b.i32const(kind).localSet(PK).i32const(size).localSet(PS).localGet(T0).localSet(PA)
            .localGet(T1).localSet(PB).localGet(T2).localSet(PR).i32const(written).localSet(PW);
        if (carried)
        {
            b.localGet(FL).i32const(CF).op(Op.i32and).localSet(PC);
        }
        else
        {
            b.i32const(0).localSet(PC);
        }
    }

    /** Whether condition `cc` holds under FL, an i32 0 or 1. @param {number} cc */
    condition(cc){
        const { b } = this;
        /** @param {number} bit */
        const flag = bit=>b.localGet(FL).i32const(Math.log2(bit)).op(Op.i32shru)
            .i32const(1).op(Op.i32and);
        switch (cc >> 1)
        {
            case 0: flag(OF); break;
            case 1: flag(CF); break;
            case 2: flag(ZF); break;
            case 3: flag(CF); flag(ZF); b.op(Op.i32or); break;
            case 4: flag(SF); break;
            case 5: flag(PF); break;
            case 6: flag(SF); flag(OF); b.op(Op.i32xor); break;
            default: flag(ZF); flag(SF); flag(OF); b.op(Op.i32xor); b.op(Op.i32or);
        }
        if ((cc & 1) !== 0)
        {
            b.op(Op.i32eqz);
        }
    }

    // --- the stack ---

    /** RSP less eight into A, checked as a store; the new RSP in T1. @param {number} index @param {number} address */
    placePush(index, address){
        const { b } = this;
        b.localGet(4).i64const(8n).op(Op.i64sub).localTee(T1)
            .i64const(32n).op(Op.i64shru).op(Op.i64eqz).op(Op.i32eqz);
        this.exitIf(index, address);
        b.localGet(T1).op(Op.i32wrap).localSet(A);
        this.checkPage(true, index, address, 8);
    }

    /** RSP into A, checked as a load. @param {number} index @param {number} address */
    placePop(index, address){
        const { b } = this;
        b.localGet(4).localTee(T1).i64const(32n).op(Op.i64shru).op(Op.i64eqz).op(Op.i32eqz);
        this.exitIf(index, address);
        b.localGet(T1).op(Op.i32wrap).localSet(A);
        this.checkPage(false, index, address, 8);
    }

    // --- instructions ---

    /**
     * One instruction, and how it ended the block if it did (`Ending`).
     *
     * @param {import('../decode/decoder.js').Instruction} instruction
     * @param {number} index  its place in the block, what is retired before it
     */
    instruction(instruction, index){
        const { b } = this;
        const { op, operands, size } = instruction;
        const at = instruction.eip;
        const next = at + instruction.length;
        const defined = instruction.flagsWritten & ~instruction.flagsUndefined;
        const [dst, src] = operands;
        /** Places a memory operand, if the instruction has one. @param {boolean} store */
        const placeMemory = store=>{
            const memory = operands.find(operand=>operand.kind === 'mem');
            if (memory !== undefined && op !== 'lea')
            {
                this.place(memory, store, index, at);
            }
        };
        switch (op)
        {
            case 'nop':
                return true;
            case 'mov': case 'movzx':
                placeMemory(dst.kind === 'mem');
                this.read(src);
                this.write(dst);
                return true;
            case 'movsx': case 'movsxd':
                placeMemory(false);
                this.read(src);
                b.op(src.size === 1 ? Op.i64ext8 : src.size === 2 ? Op.i64ext16 : Op.i64ext32);
                this.write(dst);
                return true;
            case 'lea':
                this.effective(src, false);
                this.write(dst);
                return true;
            case 'add': case 'adc': case 'sub': case 'sbb': case 'cmp':
            {
                const carried = op === 'adc' || op === 'sbb';
                placeMemory(dst.kind === 'mem' && op !== 'cmp');
                if (carried)
                {
                    this.settle();
                }
                this.read(dst);
                b.localSet(T0);
                this.read(src);
                b.localSet(T1).localGet(T0).localGet(T1);
                const adding = op === 'add' || op === 'adc';
                b.op(adding ? Op.i64add : Op.i64sub);
                if (carried)
                {
                    b.localGet(FL).i32const(CF).op(Op.i32and).op(Op.i64extendu)
                        .op(adding ? Op.i64add : Op.i64sub);
                }
                b.i64const(maskOf(size)).op(Op.i64and).localSet(T2);
                if (op !== 'cmp')
                {
                    b.localGet(T2);
                    this.write(dst);
                }
                this.record(op === 'add' ? Kind.ADD : op === 'adc' ? Kind.ADC
                    : op === 'sbb' ? Kind.SBB : Kind.SUB, size, defined, carried);
                return true;
            }
            case 'and': case 'or': case 'xor': case 'test':
            {
                placeMemory(dst.kind === 'mem' && op !== 'test');
                this.read(dst);
                b.localSet(T0);
                this.read(src);
                b.localSet(T1).localGet(T0).localGet(T1)
                    .op(op === 'and' || op === 'test' ? Op.i64and : op === 'or' ? Op.i64or
                        : Op.i64xor).localSet(T2);
                if (op !== 'test')
                {
                    b.localGet(T2);
                    this.write(dst);
                }
                this.record(Kind.LOGIC, size, ARITH);
                return true;
            }
            case 'inc': case 'dec': case 'neg':
            {
                placeMemory(dst.kind === 'mem');
                if (op !== 'neg')
                {
                    // CF stays as it was: the record before is folded first.
                    this.settle();
                }
                if (op === 'neg')
                {
                    b.i64const(0n).localSet(T0);
                    this.read(dst);
                    b.localSet(T1);
                }
                else
                {
                    this.read(dst);
                    b.localSet(T0).i64const(1n).localSet(T1);
                }
                b.localGet(T0).localGet(T1).op(op === 'inc' ? Op.i64add : Op.i64sub)
                    .i64const(maskOf(size)).op(Op.i64and).localTee(T2);
                this.write(dst);
                this.record(op === 'inc' ? Kind.INC : op === 'dec' ? Kind.DEC : Kind.SUB, size,
                    defined);
                return true;
            }
            case 'not':
                placeMemory(dst.kind === 'mem');
                this.read(dst);
                b.i64const(-1n).op(Op.i64xor).i64const(maskOf(size)).op(Op.i64and);
                this.write(dst);
                return true;
            case 'imul':
            {
                const [left, right] = operands.length === 3 ? [src, operands[2]] : [dst, src];
                placeMemory(false);
                // Both factors signed at the operand size: their whole product
                // is what the flags helper tests for overflow.
                this.read(left);
                if (size < 8)
                {
                    b.op(size === 4 ? Op.i64ext32 : Op.i64ext16);
                }
                b.localSet(T0);
                this.read(right);
                if (size < 8)
                {
                    b.op(size === 4 ? Op.i64ext32 : Op.i64ext16);
                }
                b.localTee(T1).localGet(T0).op(Op.i64mul).localTee(T2);
                this.write(dst);
                this.record(Kind.IMUL, size, defined);
                return true;
            }
            case 'shl': case 'sal': case 'shr': case 'sar': case 'rol': case 'ror':
            {
                placeMemory(dst.kind === 'mem');
                this.settle();
                b.i32const(Shift[op]).i32const(size);
                this.read(dst);
                this.read(src);
                b.op(Op.i32wrap).localGet(FL).call(this.helpers.shift).localSet(FL);
                this.write(dst);
                return true;
            }
            case 'xchg':
                this.read(dst);
                b.localSet(T0);
                this.read(src);
                this.write(dst);
                b.localGet(T0);
                this.write(src);
                return true;
            case 'bswap':
                this.read(dst);
                if (size === 8)
                {
                    this.bswap64();
                }
                else
                {
                    this.bswap64();
                    b.i64const(32n).op(Op.i64shru);
                }
                this.write(dst);
                return true;
            case 'cwde':
                // cbw, cwde, cdqe: the lower half of the accumulator widened.
                b.localGet(0).op(size === 8 ? Op.i64ext32 : size === 4 ? Op.i64ext16 : Op.i64ext8);
                this.writeReg(0, size);
                return true;
            case 'cdq':
                // cwd, cdq, cqo: the accumulator's sign into rdx.
                b.localGet(0);
                if (size < 8)
                {
                    b.op(size === 4 ? Op.i64ext32 : Op.i64ext16);
                }
                b.i64const(63n).op(Op.i64shrs);
                this.writeReg(2, size);
                return true;
            case 'push':
                // The value read before the stack moves: `push rsp` pushes the old one.
                if (dst.kind === 'mem')
                {
                    this.place(dst, false, index, at);
                }
                this.read(dst);
                b.localSet(T2);
                this.placePush(index, at);
                b.localGet(T2);
                this.storeAt(8);
                b.localGet(T1).localSet(4);
                return true;
            case 'pop':
                this.placePop(index, at);
                this.loadAt(8);
                b.localSet(T2).localGet(4).i64const(8n).op(Op.i64add).localSet(4).localGet(T2);
                this.write(dst);
                return true;
            case 'jmp':
                if (dst.kind === 'rel')
                {
                    return { to: /** @type {number} */ (dst.target) };
                }
                placeMemory(false);
                this.read(dst);
                b.localSet(RIP);
                return { to: null };
            case 'call':
                if (dst.kind === 'rel')
                {
                    b.i64const(BigInt(/** @type {number} */ (dst.target))).localSet(T2);
                }
                else
                {
                    placeMemory(false);
                    this.read(dst);
                    b.localSet(T2);
                }
                this.placePush(index, at);
                b.i64const(BigInt(next));
                this.storeAt(8);
                b.localGet(T1).localSet(4);
                if (dst.kind === 'rel')
                {
                    return { to: /** @type {number} */ (dst.target) };
                }
                b.localGet(T2).localSet(RIP);
                return { to: null };
            case 'ret':
                this.placePop(index, at);
                this.loadAt(8);
                b.localSet(RIP).localGet(4)
                    .i64const(8n + BigInt(operands.length === 1 ? /** @type {number} */ (dst.value) : 0))
                    .op(Op.i64add).localSet(4);
                return { to: null };
            default:
                break;
        }
        const cc = /** @type {number} */ (instruction.cc);
        if (op.startsWith('set'))
        {
            placeMemory(true);
            this.settle();
            this.condition(cc);
            b.op(Op.i64extendu);
            this.write(dst);
            return true;
        }
        if (op.startsWith('cmov'))
        {
            placeMemory(false);
            this.settle();
            // The source is read and a dword destination zero-extended whether or not it moves.
            this.read(src);
            this.read(dst);
            this.condition(cc);
            b.op(Op.select);
            this.write(dst);
            return true;
        }
        // jcc: the region emitter branches on the condition.
        this.settle();
        return { to: /** @type {number} */ (dst.target), cc, next };
    }

    /**
     * Goes to `to`: on to its block when the region holds it and the budget
     * is not spent, else out with RIP there.
     *
     * @param {number} to @param {Map<number, number>} indexOf  block starts to indices
     * @param {number} topDepth  the dispatch loop's depth from the block, ifs aside
     */
    go(to, indexOf, topDepth){
        const { b } = this;
        const index = indexOf.get(to);
        if (index !== undefined)
        {
            b.localGet(K).globalGet(BUDGET).op(Op.i32ltu);
            this.open();
            b.i32const(index).localSet(IDX).br(topDepth + this.nest);
            this.close();
        }
        b.i64const(BigInt(to)).localSet(RIP).br(this.exitDepth);
    }

    /** Reverses the bytes of the i64 on the stack. */
    bswap64(){
        const { b } = this;
        b.localSet(T0).i64const(0n).localSet(T1);
        for (let i = 0; i < 8; i++)
        {
            b.localGet(T0).i64const(BigInt(i * 8)).op(Op.i64shru).i64const(0xffn).op(Op.i64and)
                .i64const(BigInt((7 - i) * 8)).op(Op.i64shl).localGet(T1).op(Op.i64or)
                .localSet(T1);
        }
        b.localGet(T1);
    }
}

/**
 * The flags helper: a record's kind, width, operands, result, carry in and
 * the flags it writes, into the word -- `ir64.js`'s addFlags64, subFlags64
 * and resultFlags, once.
 *
 * (kind i32, size i32, a i64, b i64, r i64, cin i32, written i32, fl i32) -> i32
 */
function flagsHelper(){
    const b = new Body(512);
    const [KIND, SIZE, AA, BB, RR, CIN, WR, FLW] = [0, 1, 2, 3, 4, 5, 6, 7];
    const MASK = 8;
    const SIGN = 9;
    const OUT = 10;
    const OV = 11;
    // mask = size 8 ? -1 : (1 << bits) - 1; sign = 1 << (bits - 1)
    b.i64const(-1n).i64const(1n).localGet(SIZE).i32const(3).op(Op.i32shl).op(Op.i64extendu)
        .op(Op.i64shl).i64const(1n).op(Op.i64sub).localGet(SIZE).i32const(8).op(Op.i32eq)
        .op(Op.select).localSet(MASK);
    b.i64const(1n).localGet(SIZE).i32const(3).op(Op.i32shl).i32const(1).op(Op.i32sub)
        .op(Op.i64extendu).op(Op.i64shl).localSet(SIGN);
    // An IMUL record's result is the whole product (a and b sign-extended): it overflowed
    // where the product does not fit the width, which for a quadword is a divide.
    b.localGet(KIND).i32const(Kind.IMUL).op(Op.i32eq);
    b.if(ValType.i32);
    b.localGet(SIZE).i32const(8).op(Op.i32eq);
    b.if(ValType.i32);
    // b == -1: overflow iff a is the most negative; b == 0: none; else r / b != a.
    b.localGet(BB).i64const(-1n).op(Op.i64eq);
    b.if(ValType.i32);
    b.localGet(AA).i64const(-(1n << 63n)).op(Op.i64eq);
    b.else();
    b.localGet(BB).op(Op.i64eqz);
    b.if(ValType.i32);
    b.i32const(0);
    b.else();
    b.localGet(RR).localGet(BB).op(Op.i64divs).localGet(AA).op(Op.i64ne);
    b.end();
    b.end();
    b.else();
    // sign-extend r from the width and compare with r
    b.localGet(RR).i64const(64n).localGet(SIZE).i32const(3).op(Op.i32shl)
        .op(Op.i64extendu).op(Op.i64sub).localTee(OV).op(Op.i64shl).localGet(OV)
        .op(Op.i64shrs).localGet(RR).op(Op.i64ne);
    b.end();
    b.if(ValType.i32);
    b.i32const(CF | OF);
    b.else();
    b.i32const(0);
    b.end();
    b.localSet(OUT);
    b.localGet(FLW).localGet(WR).i32const(-1).op(Op.i32xor).op(Op.i32and)
        .localGet(OUT).localGet(WR).op(Op.i32and).op(Op.i32or);
    b.else();
    b.localGet(AA).localGet(MASK).op(Op.i64and).localSet(AA);
    b.localGet(BB).localGet(MASK).op(Op.i64and).localSet(BB);
    b.localGet(RR).localGet(MASK).op(Op.i64and).localSet(RR);
    // ZF, SF, PF
    b.localGet(RR).op(Op.i64eqz).i32const(6).op(Op.i32shl)
        .localGet(RR).localGet(SIGN).op(Op.i64and).op(Op.i64eqz).op(Op.i32eqz)
        .i32const(7).op(Op.i32shl).op(Op.i32or)
        .localGet(RR).i64const(0xffn).op(Op.i64and).op(Op.i64popcnt).op(Op.i32wrap)
        .i32const(1).op(Op.i32and).op(Op.i32eqz).i32const(2).op(Op.i32shl).op(Op.i32or)
        .localSet(OUT);
    // AF for every kind but LOGIC
    b.localGet(KIND).i32const(Kind.LOGIC).op(Op.i32ne);
    b.if();
    b.localGet(OUT).localGet(AA).localGet(BB).op(Op.i64xor).localGet(RR).op(Op.i64xor)
        .i64const(0x10n).op(Op.i64and).op(Op.i32wrap).op(Op.i32or).localSet(OUT);
    b.end();
    // CF and OF by kind
    const adding = ()=>{
        b.localGet(KIND).i32const(Kind.ADD).op(Op.i32eq).localGet(KIND).i32const(Kind.ADC)
            .op(Op.i32eq).op(Op.i32or).localGet(KIND).i32const(Kind.INC).op(Op.i32eq)
            .op(Op.i32or);
    };
    adding();
    b.if();
    // CF = r < a || (cin && r == a); OF = (a ^ r) & (b ^ r) & sign
    b.localGet(RR).localGet(AA).op(Op.i64ltu)
        .localGet(CIN).localGet(RR).localGet(AA).op(Op.i64eq).op(Op.i32and).op(Op.i32or)
        .localGet(OUT).op(Op.i32or).localSet(OUT);
    b.localGet(AA).localGet(RR).op(Op.i64xor).localGet(BB).localGet(RR).op(Op.i64xor)
        .op(Op.i64and).localGet(SIGN).op(Op.i64and).op(Op.i64eqz).op(Op.i32eqz)
        .i32const(11).op(Op.i32shl).localGet(OUT).op(Op.i32or).localSet(OUT);
    b.else();
    b.localGet(KIND).i32const(Kind.LOGIC).op(Op.i32ne);
    b.if();
    // CF = a < b || (cin && a == b); OF = (a ^ b) & (a ^ r) & sign
    b.localGet(AA).localGet(BB).op(Op.i64ltu)
        .localGet(CIN).localGet(AA).localGet(BB).op(Op.i64eq).op(Op.i32and).op(Op.i32or)
        .localGet(OUT).op(Op.i32or).localSet(OUT);
    b.localGet(AA).localGet(BB).op(Op.i64xor).localGet(AA).localGet(RR).op(Op.i64xor)
        .op(Op.i64and).localGet(SIGN).op(Op.i64and).op(Op.i64eqz).op(Op.i32eqz)
        .i32const(11).op(Op.i32shl).localGet(OUT).op(Op.i32or).localSet(OUT);
    b.end();
    b.end();
    b.localGet(FLW).localGet(WR).i32const(-1).op(Op.i32xor).op(Op.i32and)
        .localGet(OUT).localGet(WR).op(Op.i32and).op(Op.i32or);
    b.end();
    return { params: [ValType.i32, ValType.i32, ValType.i64, ValType.i64, ValType.i64,
        ValType.i32, ValType.i32, ValType.i32], results: [ValType.i32],
    locals: [ValType.i64, ValType.i64, ValType.i32, ValType.i64], body: b };
}

/**
 * The shift helper: `ir64.js`'s shift64 for shl, shr, sar, rol and ror. A
 * count of zero (after the mask) answers the value and the flags as they were.
 *
 * (kind i32, size i32, a i64, count i32, fl i32) -> (i64, i32)
 */
function shiftHelper(){
    const b = new Body(1024);
    const [KIND, SIZE, AA, COUNT, FLW] = [0, 1, 2, 3, 4];
    const MASK = 5;
    const SIGN = 6;
    const R = 7;
    const BITS = 8;
    const CARRY = 9;
    const OVER = 10;
    const N = 11;
    const OUT = 12;
    b.localGet(COUNT).i32const(63).i32const(31).localGet(SIZE).i32const(8).op(Op.i32eq)
        .op(Op.select).op(Op.i32and).localTee(COUNT).op(Op.i32eqz);
    b.if();
    b.localGet(AA).localGet(FLW).return();
    b.end();
    b.localGet(SIZE).i32const(3).op(Op.i32shl).localSet(BITS);
    b.i64const(-1n).i64const(1n).localGet(BITS).op(Op.i64extendu).op(Op.i64shl).i64const(1n)
        .op(Op.i64sub).localGet(SIZE).i32const(8).op(Op.i32eq).op(Op.select).localSet(MASK);
    b.i64const(1n).localGet(BITS).i32const(1).op(Op.i32sub).op(Op.i64extendu).op(Op.i64shl)
        .localSet(SIGN);
    b.localGet(AA).localGet(MASK).op(Op.i64and).localSet(AA);
    b.localGet(COUNT).op(Op.i64extendu).localSet(N);
    /** top(v): (v & sign) != 0 as i32. @param {() => void} value */
    const top = value=>{
        value();
        b.localGet(SIGN).op(Op.i64and).op(Op.i64eqz).op(Op.i32eqz);
    };
    // shl
    b.localGet(KIND).i32const(0).op(Op.i32eq);
    b.if();
    b.localGet(AA).localGet(N).op(Op.i64shl).localGet(MASK).op(Op.i64and).localSet(R);
    // carry = count <= bits ? (a >> (bits - count)) & 1 : 0
    b.localGet(AA).localGet(BITS).localGet(COUNT).op(Op.i32sub).op(Op.i64extendu)
        .op(Op.i64shru).op(Op.i32wrap).i32const(1).op(Op.i32and).i32const(0)
        .localGet(COUNT).localGet(BITS).op(Op.i32leu).op(Op.select).localSet(CARRY);
    top(()=>b.localGet(R));
    b.localGet(CARRY).op(Op.i32xor).localSet(OVER);
    b.end();
    // shr
    b.localGet(KIND).i32const(1).op(Op.i32eq);
    b.if();
    b.localGet(AA).localGet(N).op(Op.i64shru).localSet(R);
    b.localGet(AA).localGet(N).i64const(1n).op(Op.i64sub).op(Op.i64shru).op(Op.i32wrap)
        .i32const(1).op(Op.i32and).localSet(CARRY);
    top(()=>b.localGet(AA));
    b.localSet(OVER);
    b.end();
    // sar
    b.localGet(KIND).i32const(2).op(Op.i32eq);
    b.if();
    // signed = a sign-extended from the width
    b.localGet(AA).i64const(64n).localGet(BITS).op(Op.i64extendu).op(Op.i64sub)
        .op(Op.i64shl).i64const(64n).localGet(BITS).op(Op.i64extendu).op(Op.i64sub)
        .op(Op.i64shrs).localTee(R)
        .localGet(N).op(Op.i64shrs).localGet(MASK).op(Op.i64and);
    b.localGet(R).localGet(N).i64const(1n).op(Op.i64sub).op(Op.i64shrs).op(Op.i32wrap)
        .i32const(1).op(Op.i32and).localSet(CARRY);
    b.localSet(R);
    b.i32const(0).localSet(OVER);
    b.end();
    // rol, ror: by = count % bits
    b.localGet(KIND).i32const(3).op(Op.i32geu);
    b.if();
    b.localGet(COUNT).localGet(BITS).op(Op.i32remu).op(Op.i64extendu).localSet(N);
    b.localGet(KIND).i32const(3).op(Op.i32eq);
    b.if();
    // (a << by | a >> (bits - by)) & mask, which is a itself at by 0: wasm
    // takes a quadword's shift by 64 as one by 0, and a narrower one's
    // bits shifted past the width are masked off.
    b.localGet(AA).localGet(N).op(Op.i64shl).localGet(AA).localGet(BITS)
        .op(Op.i64extendu).localGet(N).op(Op.i64sub).op(Op.i64shru).op(Op.i64or)
        .localGet(MASK).op(Op.i64and).localSet(R);
    b.localGet(R).op(Op.i32wrap).i32const(1).op(Op.i32and).localSet(CARRY);
    top(()=>b.localGet(R));
    b.localGet(CARRY).op(Op.i32xor).localSet(OVER);
    b.else();
    b.localGet(AA).localGet(N).op(Op.i64shru).localGet(AA).localGet(BITS)
        .op(Op.i64extendu).localGet(N).op(Op.i64sub).op(Op.i64shl).op(Op.i64or)
        .localGet(MASK).op(Op.i64and).localSet(R);
    top(()=>b.localGet(R));
    b.localSet(CARRY);
    b.localGet(CARRY).localGet(R).localGet(SIGN).i64const(1n).op(Op.i64shru)
        .op(Op.i64and).op(Op.i64eqz).op(Op.i32eqz).op(Op.i32xor).localSet(OVER);
    b.end();
    // CF and OF alone
    b.localGet(R)
        .localGet(FLW).i32const(~(CF | OF)).op(Op.i32and)
        .localGet(CARRY).localGet(OVER).i32const(11).op(Op.i32shl).op(Op.i32or).op(Op.i32or)
        .return();
    b.end();
    // The shifts write the six arithmetic flags, AF clear.
    b.localGet(R).op(Op.i64eqz).i32const(6).op(Op.i32shl);
    top(()=>b.localGet(R));
    b.i32const(7).op(Op.i32shl).op(Op.i32or)
        .localGet(R).i64const(0xffn).op(Op.i64and).op(Op.i64popcnt).op(Op.i32wrap)
        .i32const(1).op(Op.i32and).op(Op.i32eqz).i32const(2).op(Op.i32shl).op(Op.i32or)
        .localGet(CARRY).op(Op.i32or).localGet(OVER).i32const(11).op(Op.i32shl).op(Op.i32or)
        .localSet(OUT);
    b.localGet(R).localGet(FLW).i32const(~ARITH).op(Op.i32and).localGet(OUT).op(Op.i32or);
    return { params: [ValType.i32, ValType.i32, ValType.i64, ValType.i32, ValType.i32],
        results: [ValType.i64, ValType.i32],
        locals: [ValType.i64, ValType.i64, ValType.i64, ValType.i32, ValType.i32, ValType.i32,
            ValType.i64, ValType.i32], body: b };
}

/**
 * @typedef {Object} LongBlock
 * @property {number} entry
 * @property {import('../decode/decoder.js').Instruction[]} instructions  what it runs; the
 *     last a branch, or not when the block was cut short, and then it goes on past it
 */

/**
 * @typedef {Object} LongRegion
 * @property {LongBlock[]} blocks  the first entered from outside
 */

/**
 * A module of region functions over the memory, exported as `r<index>`, and
 * the `budget` global they read.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout  64-bit
 * @param {{ min: number, max?: number, shared?: boolean }} memoryLimits  the memory's, in pages
 * @param {LongRegion[]} regions
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function emitRegions(layout, memoryLimits, regions){
    if (layout.bits !== 64)
    {
        throw new Error('long emit: a 64-bit layout');
    }
    const m = new ModuleBuilder();
    m.importMemory('env', 'memory', memoryLimits);
    m.exportGlobal('budget', m.global(ValType.i32, true, 0));
    const flags = flagsHelper();
    const shift = shiftHelper();
    const flagsType = m.type({ params: flags.params, results: flags.results });
    const shiftType = m.type({ params: shift.params, results: shift.results });
    const regionType = m.type({ params: [], results: [ValType.i32] });
    const helpers = {
        flags: m.function(flagsType, flags.locals, flags.body.toBytes()),
        shift: m.function(shiftType, shift.locals, shift.body.toBytes()),
    };
    regions.forEach((region, index)=>{
        const body = emitRegion(layout, helpers, region);
        m.function(regionType, LOCALS, body.toBytes(), { exportAs: `r${index}` });
    });
    return m.toBytes();
}

/**
 * One region's function body: the prologue loading what it touches; the
 * blocks inside a dispatch loop inside the exit block,
 *
 *     block $exit
 *       loop $top
 *         block $b(n-1) ... block $b0
 *           br_table IDX        ;; to the end of $b(IDX), where block IDX's code is
 *         end  <block 0>  end  <block 1> ...  end  <block n-1>
 *       end
 *     end
 *
 * each block ending in a branch to the loop with IDX set or to the exit with
 * RIP set; then the epilogue storing what it wrote.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ flags: number, shift: number }} helpers @param {LongRegion} region
 */
function emitRegion(layout, helpers, region){
    const e = new BlockEmitter(layout, helpers);
    const { b } = e;
    const { blocks } = region;
    const count = blocks.length;
    /** @type {Map<number, number>} */
    const indexOf = new Map(blocks.map((block, index)=>[block.entry, index]));
    b.block();
    b.loop();
    for (let i = 0; i < count; i++)
    {
        b.block();
    }
    b.localGet(IDX).brTable(blocks.map((_, index)=>index), count - 1);
    blocks.forEach((block, index)=>{
        b.end();
        // Inside block `index`'s code: the labels of the blocks after it, the
        // loop, the exit.
        e.outer = count - index;
        const topDepth = count - 1 - index;
        /** @type {Ending} */
        let ending = true;
        let retired = 0;
        for (const instruction of block.instructions)
        {
            ending = e.instruction(instruction, retired);
            retired++;
            if (ending !== true)
            {
                break;
            }
        }
        b.localGet(K).i32const(retired).op(Op.i32add).localSet(K);
        if (ending === true)
        {
            const last = block.instructions[block.instructions.length - 1];
            e.go(last.eip + last.length, indexOf, topDepth);
        }
        else if (ending.to === null)
        {
            b.br(e.exitDepth);
        }
        else if (ending.cc === undefined)
        {
            e.go(ending.to, indexOf, topDepth);
        }
        else
        {
            e.condition(ending.cc);
            e.open();
            e.go(ending.to, indexOf, topDepth);
            b.else();
            e.go(/** @type {number} */ (ending.next), indexOf, topDepth);
            e.close();
        }
    });
    b.end();
    b.end();
    // The epilogue: every register written, the record folded, the flags and RIP.
    const tail = new Body(256);
    for (let reg = 0; reg < 16; reg++)
    {
        if (b.writes(reg))
        {
            tail.i32const(0).localGet(reg).store('i64', { offset: layout.regs + reg * 8 });
        }
    }
    tail.localGet(PK);
    tail.if();
    tail.localGet(PK).localGet(PS).localGet(PA).localGet(PB).localGet(PR).localGet(PC)
        .localGet(PW).localGet(FL).call(helpers.flags).localSet(FL);
    tail.end();
    tail.i32const(0).localGet(FL).store('i32', { offset: layout.eflags });
    tail.i32const(0).localGet(RIP).store('i64', { offset: layout.eip });
    tail.localGet(K).i32const(2).op(Op.i32shl).localGet(CODE).op(Op.i32or);
    // The prologue: every register the body touches, and the flags word.
    const head = new Body(256);
    for (let reg = 0; reg < 16; reg++)
    {
        if (b.uses(reg))
        {
            head.i32const(0).load('i64', { offset: layout.regs + reg * 8 }).localSet(reg);
        }
    }
    head.i32const(0).load('i32', { offset: layout.eflags }).localSet(FL);
    head.insert(head.length, b);
    head.insert(head.length, tail);
    return head;
}

