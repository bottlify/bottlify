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
 * from block to block, and a condition is read from it directly where its
 * kind gives one (a compare and branch). A jump to a block of the region goes
 * on inside the function, a jump back only until the instructions it retired
 * reach the module's `budget` global; any other leaves with RIP at the target.
 * A direct call is a wasm call of the callee's region (`callOut`), which
 * returns into the caller's block after the call when the callee's `ret`
 * lands there.
 *
 * What the block cannot do itself it leaves before the instruction, with the
 * state exactly as the interpreter (`interp64.js`) wants it: an instruction it
 * has no case for, an address at or past 4 GiB, a page the program cannot
 * reach, a store into translated code or a watched page, a stack word of 16
 * bits. A read is not tested unless `checkReads`: its address is wrapped into
 * RAM, as the 32-bit translator wraps its reads (`wrapIntoRam`), and reads
 * there where the interpreter would fault. Every check an instruction needs
 * is made before anything it writes, so an exit never leaves half an
 * instruction behind. `ir64.js` is the reference: each case here computes
 * what its case there computes, the flags it leaves undefined kept as they
 * were.
 */

import { Body, EMPTY, ModuleBuilder, ValType } from '../wasm/encoder.js';
import { Tables, hashSlotsOf, pageFlagsAt } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { AF, CF, OF, PF, SF, ZF } from '../decode/table.js';
import { XMM, emitSimd, translatesSimd } from './simd.js';
import { wrapIntoRam } from '../emit/memory.js';

const ARITH = CF | PF | AF | ZF | SF | OF;

/** What a region function answers in its low two bits. */
export const LongExit = Object.freeze({
    /** It left by a jump or its budget: RIP is where the program goes next. */
    NEXT: 0,
    /** It stopped before the instruction at RIP, which the interpreter runs. */
    INTERPRET: 1,
    /**
     * It went to the address the wasm call waiting for it expects (`callOut`):
     * the caller goes on there. The host never sees it.
     */
    RETURNED: 2,
    /** Nothing ran: the table slot called holds no region yet (`missFunction`). */
    MISS: 3,
});

/**
 * Calls a region makes into others as wasm calls, nested at most this deep:
 * deeper, a call leaves for the host, which starts again from the top. The
 * engine's stack holds a frame a level, and iOS's is small.
 */
export const CALL_DEPTH = 64;

/** Lazy flag kinds, the helper's (`flagsHelper`). */
const Kind = Object.freeze({ ADD: 1, ADC: 2, SUB: 3, SBB: 4, LOGIC: 5, INC: 6, DEC: 7, IMUL: 8,
    SHL: 9, SHR: 10, SAR: 11 });
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
/** Scratch: an i32, and two more i64s for a wide product. */
const U = 33;
const T4 = 34;
const T5 = 35;
const LOCALS = [
    ...new Array(16).fill(ValType.i64), ValType.i64, ValType.i32,
    ValType.i32, ValType.i32, ValType.i64, ValType.i64, ValType.i64, ValType.i32, ValType.i32,
    ValType.i64, ValType.i64, ValType.i64, ValType.i64, ValType.i32, ValType.i32, ValType.i32,
    // Local 36 is unused, kept so the ones after it keep their numbers.
    ValType.i32, ValType.i32, ValType.i64, ValType.i64, ValType.i32,
    // XMM0..15 and three scratch vectors (simd.js), two f32s and two f64s.
    ...new Array(19).fill(ValType.v128), ValType.f32, ValType.f32, ValType.f64, ValType.f64,
    // The address the wasm call waiting for this one expects it to return to.
    ValType.i64,
];
/** The float scratch locals, past the vectors. */
const F32 = XMM + 19;
/** The `expect` global as the region was entered with it. */
const EXPECTED = XMM + 23;
/** The direction flag, which no record holds. */
const DF = 1 << 10;
/**
 * What `lock` may prefix here: one executor runs a long-mode process, so a
 * locked access is a plain one.
 */
const LOCKABLE = new Set(['add', 'adc', 'sub', 'sbb', 'and', 'or', 'xor', 'inc', 'dec', 'neg',
    'not', 'xadd', 'cmpxchg', 'bts', 'btr', 'btc', 'xchg']);
/**
 * The globals every region module imports, shared: the instructions left to
 * run before the host takes over again, which every region charges with what
 * it retired as it leaves or calls; how deep the calls from region to region
 * are nested now; the label of the block a region is entered at (0 its
 * entry, `i + 1` its block `i`); and the address the wasm call waiting for
 * the region expects it to return to, -1 for none.
 */
const BUDGET = 0;
const DEPTH = 1;
const LABEL = 2;
const EXPECT = 3;

/** The wasm opcodes this emitter writes, by name. */
const Op = Object.freeze({
    i32eqz: 0x45, i32eq: 0x46, i32ne: 0x47, i32ltu: 0x49, i32gtu: 0x4b, i32leu: 0x4d,
    i32geu: 0x4f, i32mul: 0x6c, i32lts: 0x48, i32gts: 0x4a, i32les: 0x4c, i64eqz: 0x50,
    i64eq: 0x51, i64ne: 0x52, i64lts: 0x53, i64ltu: 0x54,
    i64gtu: 0x56, i64les: 0x57, i64leu: 0x58, i32add: 0x6a, i32sub: 0x6b, i32and: 0x71,
    i32or: 0x72, i32xor: 0x73,
    i32shl: 0x74, i32shru: 0x76, i32remu: 0x70, i32popcnt: 0x69, i64popcnt: 0x7b,
    i64add: 0x7c, i64sub: 0x7d, i64mul: 0x7e, i64divs: 0x7f, i64divu: 0x80, i64rems: 0x81,
    i64remu: 0x82, i64clz: 0x79, i64ctz: 0x7a, i64and: 0x83, i64or: 0x84,
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
    if (translatesSimd(instruction))
    {
        return !prefixes.lock;
    }
    // A repeat prefix on a branch is a hint (`rep ret`, `bnd jmp`); on anything
    // translated here but a string instruction it means nothing either.
    if ((prefixes.lock && !LOCKABLE.has(op))
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
        case 'imul': case 'mul': case 'div': case 'idiv': case 'xadd': case 'cmpxchg':
        case 'bsf': case 'bsr': case 'popcnt': case 'xchg': case 'clc': case 'stc': case 'cmc':
        case 'cld': case 'std': case 'lahf': case 'sahf':
            return true;
        case 'leave':
            return size === 8;
        case 'bt': case 'bts': case 'btr': case 'btc':
            // A register's bit offset into memory reaches past the operand.
            return operands[0].kind === 'reg' || operands[1].kind === 'imm';
        case 'pause': case 'lfence': case 'mfence': case 'sfence': case 'prefetch':
        case 'prefetchw': case 'prefetchnta': case 'prefetcht0': case 'prefetcht1':
        case 'prefetcht2': case 'movnti':
            return true;
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
 * goes to `next` when `cc` does not hold; a direct call (`call`) returns to
 * `next`.
 *
 * @typedef {true | { to: number | null, cc?: number, next?: number, call?: boolean }} Ending
 */

/**
 * Emits a region's function body, a block at a time.
 */
class BlockEmitter {
    /**
     * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
     * @param {{ flags: number, shift: number }} helpers  function indices
     * @param {boolean} checkReads  reads test their pages, rather than wrap into RAM
     */
    constructor(layout, helpers, checkReads){
        this.layout = layout;
        this.helpers = helpers;
        this.checkReads = checkReads;
        this.b = new Body(1024);
        /** Ifs opened inside the block being emitted. */
        this.nest = 0;
        // The locals simd.js reaches through the emitter.
        this.A = A;
        this.F32 = F32;
        this.G32 = F32 + 1;
        this.F64 = F32 + 2;
        this.G64 = F32 + 3;
        /**
         * Where calls store the registers before and take them back after,
         * filled in once the region's whole use of them is known.
         * @type {{ at: number, reload: boolean }[]}
         */
        this.spills = [];
        /** Labels between the block's code and the exit block, ifs aside. */
        this.outer = 1;
        /**
         * The flag record pending where the code being emitted runs: none
         * (null, FL is whole), one of a known kind, or not known (undefined,
         * a block's start, which the dispatch loop enters from anywhere).
         * @type {{ kind: number, size: number } | null | undefined}
         */
        this.pending = undefined;
        /**
         * `pending` where each branch `open` began.
         * @type {Array<{ kind: number, size: number } | null | undefined>}
         */
        this.branches = [];
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
        this.branches.push(this.pending);
    }

    /** The other way of the branch `open` began. */
    otherwise(){
        this.unchanged();
        this.b.else();
    }

    close(){
        this.unchanged();
        this.branches.pop();
        this.b.end();
        this.nest--;
    }

    /**
     * What the emitter knows of the pending record holds for the code after
     * a branch only if the branch did not change it: a record folded on one
     * way is still pending on the other.
     */
    unchanged(){
        if (this.pending !== this.branches[this.branches.length - 1])
        {
            throw new Error('long emit: the flag record folded or left inside a branch');
        }
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
        if (!store && !this.checkReads)
        {
            b.op(Op.i32wrap).localSet(A);
            wrapIntoRam(b, this.layout.ramSize, A);
            return;
        }
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

    /**
     * The pending record, if any, folded into FL. Nothing to emit where the
     * emitter knows none is pending.
     */
    settle(){
        const { b } = this;
        if (this.pending === null)
        {
            return;
        }
        b.localGet(PK);
        this.open();
        b.localGet(PK).localGet(PS).localGet(PA).localGet(PB).localGet(PR).localGet(PC)
            .localGet(PW).localGet(FL).call(this.helpers.flags).localSet(FL)
            .i32const(0).localSet(PK);
        this.close();
        this.pending = null;
    }

    /** The pending record dropped unfolded: whatever was pending, the next write replaces. */
    drop(){
        if (this.pending !== null)
        {
            this.b.i32const(0).localSet(PK);
            this.pending = null;
        }
    }

    /**
     * FL made whole for an instruction that writes every status flag but CF:
     * only CF is folded, straight from a pending record whose kind gives it,
     * and the record dropped; any other record folded whole.
     */
    keepCarry(){
        const { b } = this;
        if (!this.pending)
        {
            this.settle();
            return;
        }
        b.localGet(FL).i32const(~CF).op(Op.i32and);
        if (!this.direct(this.pending, 1))
        {
            b.drop();
            this.settle();
            return;
        }
        b.op(Op.i32or).localSet(FL);
        this.drop();
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
        this.pending = { kind, size };
    }

    /** Whether condition `cc` holds, an i32 0 or 1. @param {number} cc */
    condition(cc){
        const { b } = this;
        if (this.pending && this.direct(this.pending, cc >> 1))
        {
            if ((cc & 1) !== 0)
            {
                b.op(Op.i32eqz);
            }
            return;
        }
        this.settle();
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

    /**
     * A condition's even half (`B`, `E`, `BE`, `L`, ...) straight from the
     * pending record's operands, as a compare-and-branch does, where the
     * record's kind decides it: answers false, emitting nothing, where it
     * does not.
     *
     * @param {{ kind: number, size: number }} pending @param {number} half  cc >> 1
     */
    direct({ kind, size }, half){
        const { b } = this;
        const bits = BigInt(size * 8);
        const zero = ()=>b.localGet(PR).op(Op.i64eqz);
        const sign = ()=>b.localGet(PR).i64const(bits - 1n).op(Op.i64shru).i64const(1n)
            .op(Op.i64and).op(Op.i32wrap);
        /** The local sign-extended from the operand size. @param {number} local */
        const signed = local=>{
            b.localGet(local);
            if (size < 8)
            {
                b.i64const(64n - bits).op(Op.i64shl).i64const(64n - bits).op(Op.i64shrs);
            }
        };
        if (kind === Kind.SUB)
        {
            switch (half)
            {
                case 1: b.localGet(PA).localGet(PB).op(Op.i64ltu); return true;
                case 2: zero(); return true;
                case 3: b.localGet(PA).localGet(PB).op(Op.i64leu); return true;
                case 4: sign(); return true;
                case 6: signed(PA); signed(PB); b.op(Op.i64lts); return true;
                case 7: signed(PA); signed(PB); b.op(Op.i64les); return true;
                default: return false;
            }
        }
        if (kind === Kind.LOGIC)
        {
            switch (half)
            {
                case 0: case 1: b.i32const(0); return true;
                case 2: case 3: zero(); return true;
                case 4: case 6: sign(); return true;
                case 7: zero(); sign(); b.op(Op.i32or); return true;
                default: return false;
            }
        }
        if (kind === Kind.SHL || kind === Kind.SHR || kind === Kind.SAR)
        {
            switch (half)
            {
                case 1:
                    if (kind !== Kind.SHR)
                    {
                        return false;
                    }
                    b.localGet(PA).localGet(PB).i64const(1n).op(Op.i64sub).op(Op.i64shru)
                        .op(Op.i32wrap).i32const(1).op(Op.i32and);
                    return true;
                case 2: zero(); return true;
                case 4: sign(); return true;
                default: return false;
            }
        }
        if (kind === Kind.ADD || kind === Kind.INC || kind === Kind.DEC)
        {
            switch (half)
            {
                case 1:
                    if (kind !== Kind.ADD)
                    {
                        return false;
                    }
                    b.localGet(PR).localGet(PA).op(Op.i64ltu);
                    return true;
                case 2: zero(); return true;
                case 4: sign(); return true;
                default: return false;
            }
        }
        return false;
    }

    /**
     * The flags in `written` from the i32 on the stack, the rest as they were:
     * a record pending folded first, whose flags this leaves.
     *
     * @param {number} written
     */
    setFlags(written){
        const { b } = this;
        b.localSet(U);
        if ((written & ARITH) === ARITH)
        {
            this.drop();
        }
        else
        {
            this.settle();
        }
        b.localGet(FL).i32const(~written).op(Op.i32and).localGet(U).i32const(written)
            .op(Op.i32and).op(Op.i32or).localSet(FL);
    }

    /**
     * One-operand mul and imul: the accumulator by the operand, the product
     * into AX or rdx:rax; CF and OF where the high half is more than the low
     * half's extension.
     *
     * @param {boolean} signed @param {number} size
     * @param {import('../decode/decoder.js').Operand} operand @param {number} defined
     */
    multiply(signed, size, operand, defined){
        const { b } = this;
        const bits = BigInt(size * 8);
        /** The i64 on the stack sign-extended from the operand size. */
        const extend = ()=>{
            if (size < 8)
            {
                b.i64const(64n - bits).op(Op.i64shl).i64const(64n - bits).op(Op.i64shrs);
            }
        };
        this.readReg(0, size);
        if (signed)
        {
            extend();
        }
        b.localSet(T0);
        this.read(operand);
        if (signed)
        {
            extend();
        }
        b.localSet(T1);
        if (size < 8)
        {
            // The whole product fits a quadword.
            b.localGet(T0).localGet(T1).op(Op.i64mul).localSet(T2);
            if (size === 1)
            {
                b.localGet(T2);
                this.writeReg(0, 2);
            }
            else
            {
                b.localGet(T2);
                this.writeReg(0, size);
                b.localGet(T2).i64const(bits).op(signed ? Op.i64shrs : Op.i64shru);
                this.writeReg(2, size);
            }
            // Overflow: the product is not its own low half extended.
            b.localGet(T2);
            if (signed)
            {
                extend();
            }
            else
            {
                b.i64const(maskOf(size)).op(Op.i64and);
            }
            b.localGet(T2).op(Op.i64ne);
        }
        else
        {
            // 64 by 64: the high half from 32-bit pieces, unsigned, then
            // corrected for the signs.
            const lo32 = (/** @type {number} */ local)=>b.localGet(local).i64const(0xffffffffn)
                .op(Op.i64and);
            const hi32 = (/** @type {number} */ local)=>b.localGet(local).i64const(32n).op(Op.i64shru);
            lo32(T0); lo32(T1); b.op(Op.i64mul).i64const(32n).op(Op.i64shru);
            hi32(T0); lo32(T1); b.op(Op.i64mul).op(Op.i64add).localSet(T4);
            lo32(T0); hi32(T1); b.op(Op.i64mul);
            b.localGet(T4).i64const(0xffffffffn).op(Op.i64and).op(Op.i64add).localSet(T5);
            hi32(T0); hi32(T1); b.op(Op.i64mul).localGet(T4).i64const(32n).op(Op.i64shru)
                .op(Op.i64add).localGet(T5).i64const(32n).op(Op.i64shru).op(Op.i64add)
                .localSet(T2);
            if (signed)
            {
                b.localGet(T2).localGet(T1).i64const(0n).localGet(T0).i64const(0n).op(Op.i64lts)
                    .op(Op.select).op(Op.i64sub)
                    .localGet(T0).i64const(0n).localGet(T1).i64const(0n).op(Op.i64lts)
                    .op(Op.select).op(Op.i64sub).localSet(T2);
            }
            b.localGet(T0).localGet(T1).op(Op.i64mul).localTee(T4);
            this.writeReg(0, 8);
            b.localGet(T2);
            this.writeReg(2, 8);
            b.localGet(T2);
            if (signed)
            {
                b.localGet(T4).i64const(63n).op(Op.i64shrs).op(Op.i64ne);
            }
            else
            {
                b.i64const(0n).op(Op.i64ne);
            }
        }
        b.localSet(U).i32const(CF | OF).i32const(0).localGet(U).op(Op.select);
        this.setFlags(defined);
    }

    /**
     * One-operand div and idiv: rdx:rax (AX for a byte) by the operand, the
     * quotient and remainder back; flags untouched. Where the dividend is
     * wider than a quadword, the divisor zero or the quotient too big, the
     * block leaves before it: the interpreter divides, or raises #DE.
     *
     * @param {boolean} signed @param {number} size
     * @param {import('../decode/decoder.js').Operand} operand
     * @param {number} index @param {number} address
     */
    divide(signed, size, operand, index, address){
        const { b } = this;
        const bits = BigInt(size * 8);
        const mask = maskOf(size);
        /** The i64 on the stack sign-extended from `width` bits. @param {bigint} width */
        const extend = width=>{
            if (width < 64n)
            {
                b.i64const(64n - width).op(Op.i64shl).i64const(64n - width).op(Op.i64shrs);
            }
        };
        this.read(operand);
        if (signed)
        {
            extend(bits);
        }
        b.localTee(T1).op(Op.i64eqz);
        this.exitIf(index, address);
        // The dividend in T0, as a quadword.
        if (size === 1)
        {
            this.readReg(0, 2);
            if (signed)
            {
                extend(16n);
            }
            b.localSet(T0);
        }
        else if (size < 8)
        {
            this.readReg(2, size);
            b.i64const(bits).op(Op.i64shl);
            this.readReg(0, size);
            b.op(Op.i64or);
            if (signed)
            {
                extend(bits * 2n);
            }
            b.localSet(T0);
        }
        else
        {
            // Only a dividend that is rax extended: rdx zero, or rax's sign.
            b.localGet(2);
            if (signed)
            {
                b.localGet(0).i64const(63n).op(Op.i64shrs);
            }
            else
            {
                b.i64const(0n);
            }
            b.op(Op.i64ne);
            this.exitIf(index, address);
            b.localGet(0).localSet(T0);
        }
        if (signed)
        {
            // The one quotient wasm traps on, and an overflow the processor raises anyway.
            b.localGet(T0).i64const(-(1n << 63n)).op(Op.i64eq).localGet(T1).i64const(-1n)
                .op(Op.i64eq).op(Op.i32and);
            this.exitIf(index, address);
        }
        b.localGet(T0).localGet(T1).op(signed ? Op.i64divs : Op.i64divu).localSet(T2);
        // A quotient that does not fit the operand size is #DE.
        if (size < 8)
        {
            b.localGet(T2);
            if (signed)
            {
                extend(bits);
            }
            else
            {
                b.i64const(mask).op(Op.i64and);
            }
            b.localGet(T2).op(Op.i64ne);
            this.exitIf(index, address);
        }
        b.localGet(T0).localGet(T1).op(signed ? Op.i64rems : Op.i64remu).localSet(T4);
        if (size === 1)
        {
            b.localGet(T4).i64const(0xffn).op(Op.i64and).i64const(8n).op(Op.i64shl)
                .localGet(T2).i64const(0xffn).op(Op.i64and).op(Op.i64or);
            this.writeReg(0, 2);
            return;
        }
        b.localGet(T2).i64const(mask).op(Op.i64and);
        this.writeReg(0, size);
        b.localGet(T4).i64const(mask).op(Op.i64and);
        this.writeReg(2, size);
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

    /** RSP into A, as a read is placed. @param {number} index @param {number} address */
    placePop(index, address){
        this.b.localGet(4).localSet(T1);
        this.placeRead(index, address);
    }

    /**
     * The address in T1 into A for a read of eight bytes: wrapped into RAM,
     * or with `checkReads` checked as `place` checks one.
     *
     * @param {number} index @param {number} address
     */
    placeRead(index, address){
        const { b } = this;
        if (!this.checkReads)
        {
            b.localGet(T1).op(Op.i32wrap).localSet(A);
            wrapIntoRam(b, this.layout.ramSize, A);
            return;
        }
        b.localGet(T1).i64const(32n).op(Op.i64shru).op(Op.i64eqz).op(Op.i32eqz);
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
        if (translatesSimd(instruction))
        {
            emitSimd(this, instruction, index, at);
            return true;
        }
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
                    this.keepCarry();
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
                if (operands.length === 1)
                {
                    placeMemory(false);
                    this.multiply(true, size, dst, defined);
                    return true;
                }
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
                const count = src.kind === 'imm'
                    ? /** @type {number} */ (src.value) & (size === 8 ? 63 : 31) : 0;
                if (count !== 0 && (op === 'shl' || op === 'sal' || op === 'shr' || op === 'sar'))
                {
                    // By a count known not to be zero: the result here, and a
                    // record for the six flags it writes.
                    this.read(dst);
                    b.localTee(T0);
                    if (op === 'sar' && size < 8)
                    {
                        const spare = BigInt(64 - size * 8);
                        b.i64const(spare).op(Op.i64shl).i64const(spare).op(Op.i64shrs);
                    }
                    b.i64const(BigInt(count))
                        .op(op === 'shr' ? Op.i64shru : op === 'sar' ? Op.i64shrs : Op.i64shl)
                        .i64const(maskOf(size)).op(Op.i64and).localTee(T2);
                    this.write(dst);
                    b.i64const(BigInt(count)).localSet(T1);
                    this.record(op === 'shr' ? Kind.SHR : op === 'sar' ? Kind.SAR : Kind.SHL, size,
                        ARITH);
                    return true;
                }
                this.settle();
                b.i32const(Shift[op]).i32const(size);
                this.read(dst);
                this.read(src);
                b.op(Op.i32wrap).localGet(FL).call(this.helpers.shift).localSet(FL);
                this.write(dst);
                return true;
            }
            case 'xchg':
            {
                placeMemory(true);
                this.read(dst);
                b.localSet(T0);
                this.read(src);
                b.localSet(T1);
                // The memory side first: with one executor the lock is nothing more.
                const [first, second] = src.kind === 'mem' ? [src, dst] : [dst, src];
                b.localGet(first === dst ? T1 : T0);
                this.write(first);
                b.localGet(second === dst ? T1 : T0);
                this.write(second);
                return true;
            }
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
                    return { to: /** @type {number} */ (dst.target), call: true, next };
                }
                // The target in RIP, for the call (`callOut`) or the exit.
                b.localGet(T2).localSet(RIP);
                return { to: null, call: true, next };
            case 'ret':
                this.placePop(index, at);
                this.loadAt(8);
                b.localSet(RIP).localGet(4)
                    .i64const(8n + BigInt(operands.length === 1 ? /** @type {number} */ (dst.value) : 0))
                    .op(Op.i64add).localSet(4);
                return { to: null };
            case 'pause': case 'lfence': case 'mfence': case 'sfence': case 'prefetch':
            case 'prefetchw': case 'prefetchnta': case 'prefetcht0': case 'prefetcht1':
            case 'prefetcht2':
                return true;
            case 'movnti':
                placeMemory(true);
                this.read(src);
                this.write(dst);
                return true;
            case 'mul':
                placeMemory(false);
                this.multiply(false, size, dst, defined);
                return true;
            case 'div': case 'idiv':
                placeMemory(false);
                this.divide(op === 'idiv', size, dst, index, at);
                return true;
            case 'xadd':
                placeMemory(dst.kind === 'mem');
                this.read(dst);
                b.localSet(T0);
                this.read(src);
                b.localTee(T1).localGet(T0).op(Op.i64add).i64const(maskOf(size)).op(Op.i64and)
                    .localSet(T2);
                // The memory side first; between registers the destination
                // last, so `xadd rax, rax` keeps the sum.
                if (dst.kind === 'mem')
                {
                    b.localGet(T2);
                    this.write(dst);
                    b.localGet(T0);
                    this.write(src);
                }
                else
                {
                    b.localGet(T0);
                    this.write(src);
                    b.localGet(T2);
                    this.write(dst);
                }
                this.record(Kind.ADD, size, defined);
                return true;
            case 'cmpxchg':
                placeMemory(dst.kind === 'mem');
                this.readReg(0, size);
                b.localSet(T0);
                this.read(dst);
                b.localTee(T1).localGet(T0).localGet(T1).op(Op.i64sub).i64const(maskOf(size))
                    .op(Op.i64and).localSet(T2);
                b.localGet(T0).op(Op.i64eq);
                this.open();
                this.read(src);
                this.write(dst);
                this.otherwise();
                // A memory destination is written back with what it held; a
                // register one is left whole.
                if (dst.kind === 'mem')
                {
                    b.localGet(T1);
                    this.write(dst);
                }
                b.localGet(T1);
                this.writeReg(0, size);
                this.close();
                this.record(Kind.SUB, size, defined);
                return true;
            case 'bsf': case 'bsr':
                placeMemory(false);
                // Folded before the branch, whose ways both write ZF.
                this.settle();
                this.read(src);
                b.localTee(T0).op(Op.i64eqz);
                this.open();
                b.i32const(ZF);
                this.setFlags(defined);
                this.otherwise();
                // The destination is written only from a source with a bit set.
                if (op === 'bsf')
                {
                    b.localGet(T0).op(Op.i64ctz);
                }
                else
                {
                    b.i64const(63n).localGet(T0).op(Op.i64clz).op(Op.i64sub);
                }
                this.write(dst);
                b.i32const(0);
                this.setFlags(defined);
                this.close();
                return true;
            case 'popcnt':
                placeMemory(false);
                this.read(src);
                b.localTee(T0).op(Op.i64popcnt);
                this.write(dst);
                b.localGet(T0).op(Op.i64eqz).i32const(6).op(Op.i32shl);
                this.setFlags(ARITH);
                return true;
            case 'bt': case 'bts': case 'btr': case 'btc':
            {
                placeMemory(dst.kind === 'mem' && op !== 'bt');
                this.read(dst);
                b.localSet(T0);
                this.read(src);
                b.i64const(BigInt(size * 8 - 1)).op(Op.i64and).localSet(T1);
                if (op !== 'bt')
                {
                    b.localGet(T0).i64const(1n).localGet(T1).op(Op.i64shl);
                    if (op === 'btr')
                    {
                        b.i64const(-1n).op(Op.i64xor).op(Op.i64and);
                    }
                    else
                    {
                        b.op(op === 'bts' ? Op.i64or : Op.i64xor);
                    }
                    this.write(dst);
                }
                b.localGet(T0).localGet(T1).op(Op.i64shru).op(Op.i32wrap).i32const(1).op(Op.i32and);
                this.setFlags(defined);
                return true;
            }
            case 'clc': case 'stc': case 'cmc':
                this.settle();
                b.localGet(FL);
                if (op === 'cmc')
                {
                    b.i32const(CF).op(Op.i32xor);
                }
                else
                {
                    b.i32const(~CF).op(Op.i32and);
                    if (op === 'stc')
                    {
                        b.i32const(CF).op(Op.i32or);
                    }
                }
                b.localSet(FL);
                return true;
            case 'cld': case 'std':
                // DF is no record's: FL holds it whatever is pending.
                b.localGet(FL).i32const(~DF).op(Op.i32and);
                if (op === 'std')
                {
                    b.i32const(DF).op(Op.i32or);
                }
                b.localSet(FL);
                return true;
            case 'lahf':
                this.settle();
                b.localGet(FL).i32const(0xd5).op(Op.i32and).i32const(2).op(Op.i32or)
                    .op(Op.i64extendu);
                this.writeReg(0, 1, true);
                return true;
            case 'sahf':
                this.settle();
                b.localGet(FL).i32const(~0xd5).op(Op.i32and);
                this.readReg(0, 1, true);
                b.op(Op.i32wrap).i32const(0xd5).op(Op.i32and).op(Op.i32or).localSet(FL);
                return true;
            case 'leave':
                // rsp from rbp, then rbp popped from there.
                b.localGet(5).localSet(T1);
                this.placeRead(index, at);
                this.loadAt(8);
                b.localGet(T1).i64const(8n).op(Op.i64add).localSet(4).localSet(5);
                return true;
            default:
                break;
        }
        const cc = /** @type {number} */ (instruction.cc);
        if (op.startsWith('set'))
        {
            placeMemory(true);
            this.condition(cc);
            b.op(Op.i64extendu);
            this.write(dst);
            return true;
        }
        if (op.startsWith('cmov'))
        {
            placeMemory(false);
            // The source is read and a dword destination zero-extended whether or not it moves.
            this.read(src);
            this.read(dst);
            this.condition(cc);
            b.op(Op.select);
            this.write(dst);
            return true;
        }
        // jcc: the region emitter branches on the condition.
        return { to: /** @type {number} */ (dst.target), cc, next };
    }

    /**
     * Goes to `to` from the end of block `here`: on to its block when the
     * region holds it -- forward by a branch to the block's label, or by
     * falling into it when it is the next one; backward through the dispatch
     * loop while the budget lasts -- else out with RIP there.
     *
     * @param {number} to @param {Map<number, number>} indexOf  block starts to indices
     * @param {number} here @param {number} count  the region's blocks
     */
    go(to, indexOf, here, count){
        const { b } = this;
        const index = indexOf.get(to);
        if (index !== undefined && index > here)
        {
            if (index !== here + 1 || this.nest !== 0)
            {
                b.br(index - here - 1 + this.nest);
            }
            return;
        }
        if (index !== undefined)
        {
            // A jump back is what can loop: the budget bounds it.
            b.localGet(K).globalGet(BUDGET).op(Op.i32lts);
            this.open();
            b.i32const(index).localSet(IDX).br(count - 1 - here + this.nest);
            this.close();
        }
        b.i64const(BigInt(to)).localSet(RIP).br(this.exitDepth);
    }

    /**
     * A call as a wasm call: what the block retired charged, the registers
     * and flags to the block, the callee called expecting `next` -- a direct
     * call's region at `to` through its table slot at its entry, an indirect
     * call's (`to` null, the target in RIP) through the module's transfer, as
     * the 32-bit translator's `callAndReturn` calls it; everything taken back
     * from the block after, and on into the block at `next` when the callee
     * returned there (`LongExit.RETURNED`), else out as it left. Too deep, out
     * of budget, or no region at the target yet, leaves with RIP at the
     * target, the return address already pushed.
     *
     * @param {number | null} to @param {number} next @param {number} slot
     * @param {number} regionType @param {Map<number, number>} indexOf
     * @param {number} here @param {number} count
     */
    callOut(to, next, slot, regionType, indexOf, here, count){
        const { b, layout } = this;
        const transfer = this.helpers.transfer;
        if (to === null && transfer === null)
        {
            b.br(this.exitDepth);
            return;
        }
        /** RIP at the target: a direct call's constant, an indirect call's kept in T2. */
        const atTarget = ()=>{
            (to === null ? b.localGet(T2) : b.i64const(BigInt(to))).localSet(RIP);
        };
        if (to === null)
        {
            b.localGet(RIP).localSet(T2);
        }
        this.settle();
        this.spills.push({ at: b.length, reload: false });
        b.i32const(0).localGet(FL).store('i32', { offset: layout.eflags });
        b.globalGet(BUDGET).localGet(K).op(Op.i32sub).globalSet(BUDGET);
        b.i32const(0).localSet(K);
        b.globalGet(DEPTH).i32const(CALL_DEPTH).op(Op.i32geu)
            .globalGet(BUDGET).i32const(0).op(Op.i32les).op(Op.i32or);
        this.open();
        atTarget();
        b.br(this.exitDepth);
        this.close();
        b.globalGet(DEPTH).i32const(1).op(Op.i32add).globalSet(DEPTH);
        b.i64const(BigInt(next)).globalSet(EXPECT);
        if (to === null)
        {
            b.localGet(T2).i32const(LongExit.MISS).call(/** @type {number} */ (transfer));
        }
        else
        {
            b.i32const(0).globalSet(LABEL).i32const(slot).callIndirect(regionType);
        }
        b.localSet(U);
        b.globalGet(DEPTH).i32const(1).op(Op.i32sub).globalSet(DEPTH);
        this.spills.push({ at: b.length, reload: true });
        b.i32const(0).load('i32', { offset: layout.eflags }).localSet(FL);
        b.i32const(0).load('i64', { offset: layout.eip }).localSet(RIP);
        b.localGet(U).i32const(LongExit.MISS).op(Op.i32eq);
        this.open();
        atTarget();
        b.br(this.exitDepth);
        this.close();
        b.localGet(U).i32const(LongExit.RETURNED).op(Op.i32ne);
        this.open();
        b.localGet(U).localSet(CODE).br(this.exitDepth);
        this.close();
        this.go(next, indexOf, here, count);
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
    // AF for every kind but LOGIC and the shifts, which clear it.
    b.localGet(KIND).i32const(Kind.LOGIC).op(Op.i32ne).localGet(KIND).i32const(Kind.SHL)
        .op(Op.i32ltu).op(Op.i32and);
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
    b.localGet(KIND).i32const(Kind.LOGIC).op(Op.i32ne).localGet(KIND).i32const(Kind.SHL)
        .op(Op.i32ltu).op(Op.i32and);
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
    // A shift by `b` (not zero, masked), `shift64` in ir64.js: CF the last bit
    // out, OF by kind.
    const CARRY = 12;
    b.localGet(KIND).i32const(Kind.SHL).op(Op.i32geu);
    b.if();
    b.localGet(KIND).i32const(Kind.SHL).op(Op.i32eq);
    b.if(ValType.i32);
    // count <= bits ? a >> (bits - count) & 1 : 0
    b.localGet(AA).localGet(SIZE).i32const(3).op(Op.i32shl).op(Op.i64extendu).localGet(BB)
        .op(Op.i64sub).op(Op.i64shru).op(Op.i32wrap).i32const(1).op(Op.i32and).i32const(0)
        .localGet(BB).localGet(SIZE).i32const(3).op(Op.i32shl).op(Op.i64extendu).op(Op.i64leu)
        .op(Op.select);
    b.else();
    b.localGet(KIND).i32const(Kind.SHR).op(Op.i32eq);
    b.if(ValType.i64);
    b.localGet(AA);
    b.else();
    // a sign-extended from the width
    b.localGet(AA).i64const(64n).localGet(SIZE).i32const(3).op(Op.i32shl).op(Op.i64extendu)
        .op(Op.i64sub).localTee(OV).op(Op.i64shl).localGet(OV).op(Op.i64shrs);
    b.end();
    b.localGet(BB).i64const(1n).op(Op.i64sub).op(Op.i64shrs).op(Op.i32wrap).i32const(1)
        .op(Op.i32and);
    b.end();
    b.localTee(CARRY).localGet(OUT).op(Op.i32or).localSet(OUT);
    // OF: shl the result's top bit against CF, shr the operand's top bit, sar none.
    b.localGet(RR).localGet(SIGN).op(Op.i64and).op(Op.i64eqz).op(Op.i32eqz).localGet(CARRY)
        .op(Op.i32xor)
        .localGet(AA).localGet(SIGN).op(Op.i64and).op(Op.i64eqz).op(Op.i32eqz).i32const(0)
        .localGet(KIND).i32const(Kind.SHR).op(Op.i32eq).op(Op.select)
        .localGet(KIND).i32const(Kind.SHL).op(Op.i32eq).op(Op.select)
        .i32const(11).op(Op.i32shl).localGet(OUT).op(Op.i32or).localSet(OUT);
    b.end();
    b.localGet(FLW).localGet(WR).i32const(-1).op(Op.i32xor).op(Op.i32and)
        .localGet(OUT).localGet(WR).op(Op.i32and).op(Op.i32or);
    b.end();
    return { params: [ValType.i32, ValType.i32, ValType.i64, ValType.i64, ValType.i64,
        ValType.i32, ValType.i32, ValType.i32], results: [ValType.i32],
    locals: [ValType.i64, ValType.i64, ValType.i32, ValType.i64, ValType.i32], body: b };
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
 * A module of region functions over the memory, exported as `r<index>`. It
 * imports, from `env`, the memory, the table of regions by slot that its
 * calls and transfers go through, and the globals every region module shares
 * (`BUDGET`, `DEPTH`, `LABEL`, `EXPECT`).
 *
 * With `transfers`, a region that leaves for an address with budget left
 * goes on there without the host where the entry hash (`entries.js`, in the
 * layout's tables) names a block: the module's transfer function probes it
 * and tail-calls that region at the block's label.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout  64-bit
 * @param {{ min: number, max?: number, shared?: boolean }} memoryLimits  the memory's, in pages
 * @param {LongRegion[]} regions
 * @param {(address: number) => number} slotOf  the table slot of the region at an address,
 *     which holds `missFunction` until there is one
 * @param {{ transfers?: boolean, checkReads?: boolean }} [options]  `checkReads`: reads
 *     test their pages, rather than wrap into RAM
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function emitRegions(layout, memoryLimits, regions, slotOf, options = {}){
    const { transfers = false, checkReads = false } = options;
    if (layout.bits !== 64)
    {
        throw new Error('long emit: a 64-bit layout');
    }
    const m = new ModuleBuilder();
    m.importMemory('env', 'memory', memoryLimits);
    m.importTable('env', 'table', 1);
    m.importGlobal('env', 'budget', ValType.i32, true);
    m.importGlobal('env', 'depth', ValType.i32, true);
    m.importGlobal('env', 'label', ValType.i32, true);
    m.importGlobal('env', 'expect', ValType.i64, true);
    const flags = flagsHelper();
    const shift = shiftHelper();
    const flagsType = m.type({ params: flags.params, results: flags.results });
    const shiftType = m.type({ params: shift.params, results: shift.results });
    const regionType = m.type({ params: [], results: [ValType.i32] });
    const helpers = {
        flags: m.function(flagsType, flags.locals, flags.body.toBytes()),
        shift: m.function(shiftType, shift.locals, shift.body.toBytes()),
        /** @type {number | null} */
        transfer: null,
    };
    if (transfers)
    {
        const transfer = transferFunction(layout, regionType);
        helpers.transfer = m.function(m.type({ params: [ValType.i64, ValType.i32],
            results: [ValType.i32] }), transfer.locals, transfer.body.toBytes());
    }
    regions.forEach((region, index)=>{
        const body = emitRegion(layout, helpers, region, { slotOf, regionType, checkReads });
        m.function(regionType, LOCALS, body.toBytes(), { exportAs: `r${index}` });
    });
    return m.toBytes();
}

/**
 * The transfer: RIP (its first parameter) looked up in the entry hash as the
 * 32-bit translator's transfer probes it (`finishModule`), the slot's region
 * tail-called at the slot's label; a miss answers the second parameter --
 * `LongExit.NEXT` from a region's exit, which has left RIP in the state for
 * the host, `LongExit.MISS` from a call, which goes on to leave at its
 * target. Every entry here is under `ANY_TOP`: long mode keeps no x87 top in
 * its regions' keys.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {number} regionType
 */
function transferFunction(layout, regionType){
    const hash = layout.tables + Tables.HASH;
    const rip = 0;
    const missed = 1;
    const index = 2;
    const at = 3;
    const key = 4;
    const eip = 5;
    const b = new Body(256);
    b.block();
    // Past the window, or EIP 0 -- an empty slot's key -- is in no slot.
    b.localGet(rip).i64const(32n).op(Op.i64shru).op(Op.i64eqz).op(Op.i32eqz).brIf(0);
    b.localGet(rip).op(Op.i32wrap).localTee(eip).op(Op.i32eqz).brIf(0);
    b.localGet(eip).i32const(0x9e3779b1 | 0).op(Op.i32mul).i32const(layout.hashShift ?? 16)
        .op(Op.i32shru).localSet(index);
    b.loop();
    b.localGet(index).i32const(Tables.HASH_SLOT).op(Op.i32mul).i32const(hash).op(Op.i32add)
        .localTee(at).load('i32').localTee(key).localGet(eip).op(Op.i32eq);
    b.if();
    b.localGet(at).load('i32_16u', { offset: 8 }).globalSet(LABEL);
    b.localGet(at).load('i32', { offset: 4 }).returnCallIndirect(regionType);
    b.end();
    b.localGet(key).op(Op.i32eqz).brIf(1);
    b.localGet(index).i32const(1).op(Op.i32add).i32const(hashSlotsOf(layout) - 1)
        .op(Op.i32and).localSet(index);
    b.br(0);
    b.end();
    b.end();
    b.localGet(missed);
    return { body: b, locals: [ValType.i32, ValType.i32, ValType.i32, ValType.i32] };
}

/** A module whose `miss` answers `LongExit.MISS` having run nothing: an empty table slot. */
export function missFunction(){
    const m = new ModuleBuilder();
    const type = m.type({ params: [], results: [ValType.i32] });
    const body = new Body(8);
    body.i32const(LongExit.MISS);
    m.function(type, [], body.toBytes(), { exportAs: 'miss' });
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
 * the blocks in address order, so a jump forward is a branch out to the
 * target's label (or no branch, into the next block) and only a jump back
 * goes round the loop, with IDX set, while the budget lasts; anything else
 * leaves for the exit with RIP set. Then the epilogue storing what it wrote,
 * charging the budget with what it retired, and going on: back to the call
 * waiting at RIP, into the region the entry hash names there, or out.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ flags: number, shift: number, transfer: number | null }} helpers
 * @param {LongRegion} region
 * @param {{ slotOf: (address: number) => number, regionType: number, checkReads: boolean }}
 *     link
 */
function emitRegion(layout, helpers, region, { slotOf, regionType, checkReads }){
    const e = new BlockEmitter(layout, helpers, checkReads);
    const { b } = e;
    // In address order: a jump forward, most of them, is a branch out to the
    // target's label, or no branch at all.
    const blocks = [...region.blocks].sort((x, y)=>x.entry - y.entry);
    const count = blocks.length;
    /** @type {Map<number, number>} */
    const indexOf = new Map(blocks.map((block, index)=>[block.entry, index]));
    const first = /** @type {number} */ (indexOf.get(region.blocks[0].entry));
    // Label 0 is the region's entry, label i + 1 its block i.
    b.globalGet(LABEL).i32const(1).op(Op.i32sub).i32const(first).globalGet(LABEL)
        .op(Op.select).localSet(IDX);
    b.globalGet(EXPECT).localSet(EXPECTED);
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
        e.pending = undefined;
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
            e.go(last.eip + last.length, indexOf, index, count);
        }
        else if (ending.call)
        {
            e.callOut(ending.to, /** @type {number} */ (ending.next),
                ending.to === null ? -1 : slotOf(ending.to), regionType, indexOf, index, count);
        }
        else if (ending.to === null)
        {
            b.br(e.exitDepth);
        }
        else if (ending.cc === undefined)
        {
            e.go(ending.to, indexOf, index, count);
        }
        else if (indexOf.get(/** @type {number} */ (ending.next)) === index + 1)
        {
            // Not taken falls into the next block.
            e.condition(ending.cc);
            e.open();
            e.go(ending.to, indexOf, index, count);
            e.close();
        }
        else
        {
            e.condition(ending.cc);
            e.open();
            e.go(ending.to, indexOf, index, count);
            e.otherwise();
            e.go(/** @type {number} */ (ending.next), indexOf, index, count);
            e.close();
            // Both ways branched: nothing falls into the next block.
            b.unreachable();
        }
    });
    b.end();
    b.end();
    // Every register the region writes, stored, and every one it uses, loaded:
    // at its exit and entry, and around each call it makes.
    const written = [...Array(32).keys()].filter(i=>b.writes(i < 16 ? i : XMM + i - 16));
    const used = [...Array(32).keys()].filter(i=>b.uses(i < 16 ? i : XMM + i - 16));
    /** @param {Body} body @param {number[]} which */
    const store = (body, which)=>{
        for (const i of which)
        {
            body.i32const(0);
            if (i < 16)
            {
                body.localGet(i).store('i64', { offset: layout.regs + i * 8 });
            }
            else
            {
                body.localGet(XMM + i - 16).storeV128({ offset: layout.xmm + (i - 16) * 16 });
            }
        }
        return body;
    };
    /** @param {Body} body @param {number[]} which */
    const load = (body, which)=>{
        for (const i of which)
        {
            body.i32const(0);
            if (i < 16)
            {
                body.load('i64', { offset: layout.regs + i * 8 }).localSet(i);
            }
            else
            {
                body.loadV128({ offset: layout.xmm + (i - 16) * 16 }).localSet(XMM + i - 16);
            }
        }
        return body;
    };
    if (e.spills.length > 0)
    {
        b.insertAll(e.spills.map(({ at, reload })=>({ at,
            body: reload ? load(new Body(256), used) : store(new Body(256), written) })));
    }
    // The epilogue: every register written, the record folded, the flags and RIP.
    const tail = store(new Body(256), written);
    tail.localGet(PK);
    tail.if();
    tail.localGet(PK).localGet(PS).localGet(PA).localGet(PB).localGet(PR).localGet(PC)
        .localGet(PW).localGet(FL).call(helpers.flags).localSet(FL);
    tail.end();
    tail.i32const(0).localGet(FL).store('i32', { offset: layout.eflags });
    tail.i32const(0).localGet(RIP).store('i64', { offset: layout.eip });
    tail.globalGet(BUDGET).localGet(K).op(Op.i32sub).globalSet(BUDGET);
    tail.localGet(CODE).op(Op.i32eqz);
    tail.if();
    tail.localGet(RIP).localGet(EXPECTED).op(Op.i64eq);
    tail.if();
    tail.i32const(LongExit.RETURNED).return();
    tail.end();
    if (helpers.transfer !== null)
    {
        tail.globalGet(BUDGET).i32const(0).op(Op.i32gts);
        tail.if();
        tail.localGet(EXPECTED).globalSet(EXPECT).localGet(RIP).i32const(LongExit.NEXT)
            .returnCall(helpers.transfer);
        tail.end();
    }
    tail.end();
    tail.localGet(CODE);
    // The prologue: every register the body touches, and the flags word.
    const head = load(new Body(256), used);
    head.i32const(0).load('i32', { offset: layout.eflags }).localSet(FL);
    head.insert(head.length, b);
    head.insert(head.length, tail);
    return head;
}

