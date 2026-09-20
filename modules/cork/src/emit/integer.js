/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The general-purpose instructions, each as a few wasm operations on the
 * region's locals.
 *
 * An operand is read with `readOp` (pushing its zero-extended value) and
 * written with `writeOp` (taking a callback that pushes the new value), so
 * an instruction reads as it does in the manual. A memory operand's address
 * is computed once into the `addr` local by `prepare`, so a read-modify-
 * write like `add [mem], reg` addresses memory once. Narrow registers are
 * merged into their dword on write. Arithmetic flags go through the region
 * emitter's record; the widths' masks are applied where the architecture
 * would truncate.
 *
 * An instruction this file has no case for -- x87, SIMD, the rare forms --
 * is answered `false`, and the region emitter leaves the function at it for
 * the other executor to run.
 */

import { AF, CF, DF, OF, PF, SF, ZF } from '../decode/table.js';
import { EMPTY, ValType } from '../wasm/encoder.js';
import { I32, Kind, MASKS, SIGN_BITS, widthCode } from './flags.js';
import { Exit, Local } from './region.js';
import { checkAccess, noteStore, stackAccess } from './memory.js';
import { emitSimd } from './simd.js';

/** i64 opcodes. */
const I64 = Object.freeze({
    eqz: 0x50, eq: 0x51, ne: 0x52, ltS: 0x53, ltU: 0x54, gtS: 0x55, gtU: 0x56, add: 0x7c, sub: 0x7d,
    mul: 0x7e, divS: 0x7f, divU: 0x80, remS: 0x81, remU: 0x82, and: 0x83, or: 0x84, xor: 0x85,
    shl: 0x86, shrS: 0x87, shrU: 0x88, wrap: 0xa7, extendS: 0xac, extendU: 0xad,
});
const I32_EXTRA = Object.freeze({
    clz: 0x67, ctz: 0x68, mul: 0x6c, divS: 0x6d, divU: 0x6e, remS: 0x6f, remU: 0x70,
    rotl: 0x77, rotr: 0x78, extend8s: 0xc0, extend16s: 0xc1,
});

/** Every arithmetic flag. */
const ARITH_ALL = CF | PF | AF | ZF | SF | OF;

/** The selector values the flat segments carry, by segment index. */
const SELECTORS = [0x10, 0x08, 0x10, 0x10, 0x18, 0x10];

/**
 * @typedef {import('./region.js').RegionEmitter} E
 * @typedef {import('../decode/decoder.js').Instruction} Instruction
 * @typedef {import('../decode/decoder.js').Operand} Operand
 */

/**
 * Emits one instruction. Answers false when it is not one this file
 * translates; nothing is emitted then.
 *
 * @param {E} e
 * @param {Instruction} instruction
 * @param {boolean} flagsLive  whether the flags it writes are read afterwards
 * @returns {boolean}
 */
export function emitInstruction(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, src] = operands;
    const next = (instruction.eip + instruction.length) >>> 0;
    if (instruction.prefixes.address && instruction.memory && !instruction.op.startsWith('lea'))
    {
        // 16-bit addressing outside `lea` is rare in 32-bit code and not worth
        // a wrapped address path here.
        return false;
    }
    switch (op)
    {
        case 'nop': case 'fwait': case 'fnop': case 'prefetch': case 'prefetchw':
        case 'prefetchnta': case 'prefetcht0': case 'prefetcht1': case 'prefetcht2':
        case 'lfence': case 'mfence': case 'sfence': case 'pause':
            return true;
        case 'hlt':
            e.exitAt(next, Exit.HALT);
            e.dead = true;
            return true;
        case 'mov':
            if (dst.kind === 'seg')
            {
                return true;
            }
            if (src.kind === 'seg')
            {
                // A segment register read into a register clears the upper half
                // unless the operand-size prefix asks for a word; into memory it
                // writes its word.
                const target = dst.kind === 'reg' && !instruction.prefixes.operand
                    ? { ...dst, size: 4 } : dst;
                prepare(e, dst);
                writeOp(e, target, ()=>b.i32const(SELECTORS[/** @type {number} */ (src.reg)]));
                return true;
            }
            prepare(e, dst.kind === 'mem' ? dst : src);
            writeOp(e, dst, ()=>readOp(e, src));
            return true;
        case 'movzx':
            prepare(e, src);
            writeOp(e, dst, ()=>readOp(e, src));
            return true;
        case 'movsx':
            prepare(e, src);
            writeOp(e, dst, ()=>{
                readOp(e, src);
                b.op(src.size === 1 ? I32_EXTRA.extend8s : I32_EXTRA.extend16s);
            });
            return true;
        case 'lea':
            writeOp(e, dst, ()=>emitAddress(e, src, false));
            return true;
        case 'xchg':
            prepare(e, dst.kind === 'mem' ? dst : src);
            readOp(e, dst);
            b.localSet(Local.t1);
            writeOp(e, dst, ()=>readOp(e, src));
            writeOp(e, src, ()=>b.localGet(Local.t1));
            return true;
        case 'add': case 'adc': case 'sub': case 'sbb': case 'cmp': case 'xadd':
            arithmetic(e, instruction, flagsLive);
            return true;
        case 'and': case 'or': case 'xor': case 'test':
            logic(e, instruction, flagsLive);
            return true;
        case 'inc': case 'dec':
        {
            // CF stays: with the flags live the word is made whole first and
            // the record takes op1; with them dead a pending record (whose CF
            // a later reader may still fold) must keep its operands, so the
            // value goes through a scratch local instead.
            const value = flagsLive ? Local.op1 : Local.t1;
            if (flagsLive)
            {
                e.materialise();
            }
            prepare(e, dst);
            readOp(e, dst);
            b.localSet(value);
            writeOp(e, dst, ()=>{
                b.localGet(value).i32const(1).op(op === 'inc' ? I32.add : I32.sub);
                mask(e, size);
                if (flagsLive)
                {
                    e.record(op === 'inc' ? Kind.INC : Kind.DEC, size);
                }
            });
            return true;
        }
        case 'neg':
            prepare(e, dst);
            readOp(e, dst);
            b.localSet(Local.op2);
            writeOp(e, dst, ()=>{
                b.i32const(0).localGet(Local.op2).op(I32.sub);
                mask(e, size);
                if (flagsLive)
                {
                    e.record(Kind.NEG, size);
                }
            });
            return true;
        case 'not':
            prepare(e, dst);
            writeOp(e, dst, ()=>{
                readOp(e, dst);
                b.i32const(-1).op(I32.xor);
                mask(e, size);
            });
            return true;
        case 'shl': case 'sal': case 'shr': case 'sar':
            return shift(e, instruction, flagsLive);
        case 'rol': case 'ror':
            return rotate(e, instruction, flagsLive);
        case 'rcl': case 'rcr':
            return rotateCarry(e, instruction, flagsLive);
        case 'shld': case 'shrd':
            return shiftDouble(e, instruction, flagsLive);
        case 'popcnt':
            prepare(e, src);
            readOp(e, src);
            b.op(I32.popcnt);
            b.localSet(Local.t1);
            b.localGet(Local.t1);
            writeReg(e, /** @type {number} */ (dst.reg), size, false);
            if (flagsLive)
            {
                e.eagerWrite(ARITH_ALL);
                b.localGet(Local.t1).op(I32.eqz);
                e.orFlag(ZF);
            }
            return true;
        case 'imul':
            return imul(e, instruction, flagsLive);
        case 'mul':
            return mul(e, instruction, flagsLive);
        case 'div': case 'idiv':
            return divide(e, instruction);
        case 'cwde':
            if (size === 2)
            {
                b.localGet(Local.reg).op(I32_EXTRA.extend8s).i32const(0xffff).op(I32.and);
                writeReg(e, 0, 2, false);
            }
            else
            {
                b.localGet(Local.reg).op(I32_EXTRA.extend16s).localSet(Local.reg);
            }
            return true;
        case 'cdq':
            if (size === 2)
            {
                b.localGet(Local.reg).op(I32_EXTRA.extend16s).i32const(31).op(I32.shrS)
                    .i32const(0xffff).op(I32.and);
                writeReg(e, 2, 2, false);
            }
            else
            {
                b.localGet(Local.reg).i32const(31).op(I32.shrS).localSet(Local.reg + 2);
            }
            return true;
        case 'push':
            if (dst.kind === 'mem')
            {
                prepare(e, dst);
            }
            if (dst.kind === 'seg')
            {
                push(e, size, ()=>b.i32const(SELECTORS[/** @type {number} */ (dst.reg)]));
            }
            else
            {
                push(e, dst.kind === 'imm' ? dst.size : dst.size, ()=>readOp(e, dst));
            }
            return true;
        case 'pop':
            if (dst.kind === 'seg')
            {
                b.localGet(Local.reg + 4).i32const(size).op(I32.add).localSet(Local.reg + 4);
                return true;
            }
            // The value is read before the increment, and the write comes
            // after it: `pop esp` then holds the value, `pop [esp+x]`
            // addresses with the incremented esp.
            stackAccess(e, dst.size);
            b.localGet(Local.addr)
                .load(dst.size === 2 ? 'i32_16u' : 'i32', { offset: e.layout.ramBase })
                .localSet(Local.t1);
            b.localGet(Local.reg + 4).i32const(dst.size).op(I32.add).localSet(Local.reg + 4);
            prepare(e, dst);
            writeOp(e, dst, ()=>b.localGet(Local.t1));
            return true;
        case 'pushad':
        {
            // The original esp is pushed in its slot; `push` scratches t2, so it
            // is kept in t1. With a 66 prefix the eight are words. The whole
            // span is checked first so a fault leaves nothing pushed.
            b.localGet(Local.reg + 4).localSet(Local.t1);
            b.localGet(Local.reg + 4).i32const(8 * size).op(I32.sub).localSet(Local.addr);
            checkAccess(e, 8 * size);
            for (let r = 0; r < 8; r++)
            {
                push(e, size, ()=>b.localGet(r === 4 ? Local.t1 : Local.reg + r));
            }
            return true;
        }
        case 'popad':
            // The whole span checked once: a fault leaves nothing popped.
            stackAccess(e, 8 * size);
            for (let r = 7; r >= 0; r--)
            {
                b.localGet(Local.reg + 4)
                    .load(size === 2 ? 'i32_16u' : 'i32', { offset: e.layout.ramBase });
                if (r === 4)
                {
                    b.drop();
                }
                else if (size === 2)
                {
                    writeReg(e, r, 2, false);
                }
                else
                {
                    b.localSet(Local.reg + r);
                }
                b.localGet(Local.reg + 4).i32const(size).op(I32.add).localSet(Local.reg + 4);
            }
            return true;
        case 'pushf':
            e.materialise();
            push(e, size, ()=>b.localGet(Local.flags).i32const(2).op(I32.or));
            return true;
        case 'popf':
        {
            const writable = 0xcd5 | DF | 1 << 11;
            e.materialise();
            stackAccess(e, size);
            b.localGet(Local.addr)
                .load(size === 2 ? 'i32_16u' : 'i32', { offset: e.layout.ramBase })
                .i32const(writable).op(I32.and);
            b.localGet(Local.flags).i32const(~writable).op(I32.and).op(I32.or)
                .i32const(2).op(I32.or);
            b.localSet(Local.flags);
            b.localGet(Local.reg + 4).i32const(size).op(I32.add).localSet(Local.reg + 4);
            return true;
        }
        case 'lahf':
            e.materialise();
            b.localGet(Local.flags).i32const(0xd5).op(I32.and).i32const(2).op(I32.or);
            writeReg(e, 0, 1, true);
            return true;
        case 'sahf':
            e.eagerWrite(0xd5);
            b.localGet(Local.reg).i32const(8).op(I32.shrU).i32const(0xd5).op(I32.and)
                .localGet(Local.flags).op(I32.or).localSet(Local.flags);
            return true;
        case 'clc':
            e.eagerWrite(CF);
            return true;
        case 'stc':
            e.eagerWrite(CF);
            b.i32const(1);
            e.orFlag(CF);
            return true;
        case 'cmc':
            e.materialise();
            b.localGet(Local.flags).i32const(CF).op(I32.xor).localSet(Local.flags);
            return true;
        case 'cld': case 'std':
            b.localGet(Local.flags).i32const(op === 'cld' ? ~DF : DF)
                .op(op === 'cld' ? I32.and : I32.or).localSet(Local.flags);
            return true;
        case 'jmp':
            if (dst.kind === 'rel')
            {
                return true; // the block's exit does the jump
            }
            prepare(e, dst);
            readOp(e, dst);
            b.localSet(Local.eip);
            e.exitDynamic(Exit.UNTRANSLATED);
            e.dead = true;
            return true;
        case 'call':
            if (dst.kind !== 'rel')
            {
                prepare(e, dst);
                readOp(e, dst);
                b.localSet(Local.t2);
            }
            push(e, 4, ()=>b.i32const(next));
            if (dst.kind === 'rel')
            {
                e.exitAt(/** @type {number} */ (dst.target), Exit.UNTRANSLATED);
            }
            else
            {
                b.localGet(Local.t2).localSet(Local.eip);
                e.exitDynamic(Exit.UNTRANSLATED);
            }
            e.dead = true;
            return true;
        case 'ret':
            stackAccess(e, 4);
            b.localGet(Local.addr).load('i32', { offset: e.layout.ramBase }).localSet(Local.eip);
            b.localGet(Local.reg + 4).i32const(4 + (dst ? /** @type {number} */ (dst.value) : 0))
                .op(I32.add).localSet(Local.reg + 4);
            e.exitDynamic(Exit.UNTRANSLATED);
            e.dead = true;
            return true;
        case 'leave':
            // esp <- ebp, then bp or ebp popped: a word pop merges into ebp.
            // The pop's access is checked before esp moves.
            b.localGet(Local.reg + 5).localSet(Local.addr);
            checkAccess(e, size);
            b.localGet(Local.addr).i32const(size).op(I32.add).localSet(Local.reg + 4);
            b.localGet(Local.addr)
                .load(size === 2 ? 'i32_16u' : 'i32', { offset: e.layout.ramBase });
            writeReg(e, 5, size, false);
            return true;
        case 'enter':
        {
            if (/** @type {number} */ (src.value) !== 0)
            {
                return false;
            }
            // With a 66 prefix: bp is pushed as a word and only bp is written.
            // (The instruction's own size is its imm16's; the prefix decides.)
            const width = instruction.prefixes.operand ? 2 : 4;
            push(e, width, ()=>b.localGet(Local.reg + 5));
            b.localGet(Local.reg + 4);
            writeReg(e, 5, width, false);
            b.localGet(Local.reg + 4).i32const(/** @type {number} */ (dst.value)).op(I32.sub)
                .localSet(Local.reg + 4);
            return true;
        }
        case 'loop': case 'loope': case 'loopne':
            if (instruction.prefixes.address)
            {
                b.localGet(Local.reg + 1).i32const(1).op(I32.sub).i32const(0xffff).op(I32.and);
                writeReg(e, 1, 2, false);
            }
            else
            {
                b.localGet(Local.reg + 1).i32const(1).op(I32.sub).localSet(Local.reg + 1);
            }
            return true;
        case 'jecxz':
            return true;
        case 'bt': case 'bts': case 'btr': case 'btc':
            return bitTest(e, instruction);
        case 'bsf': case 'bsr':
            prepare(e, src);
            readOp(e, src);
            b.localSet(Local.t1);
            e.eagerWrite(ZF);
            b.localGet(Local.t1).op(I32.eqz);
            e.openIf('zero', EMPTY);
            b.localGet(Local.flags).i32const(ZF).op(I32.or).localSet(Local.flags);
            b.op(0x05); // else
            writeOp(e, dst, ()=>{
                b.localGet(Local.t1);
                if (op === 'bsf')
                {
                    b.op(I32_EXTRA.ctz);
                }
                else
                {
                    b.op(I32_EXTRA.clz).i32const(31).op(I32.xor);
                }
            });
            e.close();
            return true;
        case 'bswap':
            b.localGet(Local.reg + /** @type {number} */ (dst.reg));
            b.localSet(Local.t1);
            b.localGet(Local.t1).i32const(24).op(I32.shrU);
            b.localGet(Local.t1).i32const(8).op(I32.shrU).i32const(0xff00).op(I32.and).op(I32.or);
            b.localGet(Local.t1).i32const(8).op(I32.shl).i32const(0xff0000).op(I32.and).op(I32.or);
            b.localGet(Local.t1).i32const(24).op(I32.shl).op(I32.or);
            b.localSet(Local.reg + /** @type {number} */ (dst.reg));
            return true;
        case 'cmpxchg':
            prepare(e, dst);
            b.localGet(Local.reg);
            mask(e, size);
            b.localSet(Local.op1);
            readOp(e, dst);
            b.localSet(Local.op2);
            b.localGet(Local.op1).localGet(Local.op2).op(I32.sub);
            mask(e, size);
            e.record(Kind.SUB, size);
            b.op(I32.eqz);
            e.openIf('equal', EMPTY);
            writeOp(e, dst, ()=>readOp(e, src));
            b.op(0x05);
            b.localGet(Local.op2);
            writeReg(e, 0, size, false);
            e.close();
            return true;
        case 'movs': case 'stos': case 'lods': case 'cmps': case 'scas':
            return stringInstruction(e, instruction);
        case 'int3':
            // A trap: EIP past the instruction, as the frame reader expects.
            e.exitAt(next, Exit.FAULT, 3);
            e.dead = true;
            return true;
        case 'int':
            e.exitAt(next, Exit.FAULT, /** @type {number} */ (dst.value));
            e.dead = true;
            return true;
        case 'ud2': case 'ud1':
            e.exitBefore(instruction.eip, Exit.FAULT, 6);
            e.dead = true;
            return true;
        case 'salc':
            e.pushFlag(CF);
            b.localSet(Local.t1);
            b.i32const(0).localGet(Local.t1).op(I32.sub).i32const(0xff).op(I32.and);
            writeReg(e, 0, 1, false);
            return true;
        default:
            if (instruction.cc !== undefined)
            {
                if (op.startsWith('set'))
                {
                    prepare(e, dst);
                    writeOp(e, dst, ()=>e.pushCondition(/** @type {number} */ (instruction.cc)));
                    return true;
                }
                if (op.startsWith('cmov'))
                {
                    prepare(e, src);
                    readOp(e, src);
                    b.localSet(Local.t1);
                    e.pushCondition(/** @type {number} */ (instruction.cc));
                    e.openIf('move', EMPTY);
                    writeOp(e, dst, ()=>b.localGet(Local.t1));
                    e.close();
                    return true;
                }
                if (op.startsWith('j'))
                {
                    return true; // the block's exit branches
                }
            }
            return emitSimd(e, instruction, flagsLive);
    }
}

// --- operands ---

/**
 * Computes a memory operand's address into the `addr` local, once.
 *
 * @param {E} e @param {Operand} operand
 */
export function prepare(e, operand){
    if (operand.kind === 'mem')
    {
        emitAddress(e, operand, true);
        e.b.localSet(Local.addr);
        checkAccess(e, operand.size);
    }
}

/**
 * Pushes the guest address of a memory operand.
 *
 * @param {E} e @param {Operand} operand
 * @param {boolean} withSegment  add the fs base for an `fs:` operand
 */
export function emitAddress(e, operand, withSegment){
    const { b } = e;
    let pushed = false;
    if ((operand.base ?? -1) >= 0)
    {
        b.localGet(Local.reg + /** @type {number} */ (operand.base));
        pushed = true;
    }
    if ((operand.index ?? -1) >= 0)
    {
        b.localGet(Local.reg + /** @type {number} */ (operand.index));
        const scale = operand.scale ?? 1;
        if (scale > 1)
        {
            b.i32const(Math.log2(scale)).op(I32.shl);
        }
        if (pushed)
        {
            b.op(I32.add);
        }
        pushed = true;
    }
    const disp = operand.disp ?? 0;
    if (disp !== 0 || !pushed)
    {
        b.i32const(disp);
        if (pushed)
        {
            b.op(I32.add);
        }
    }
    if (operand.addressSize === 16)
    {
        b.i32const(0xffff).op(I32.and);
    }
    if (withSegment && operand.segment === 4)
    {
        b.i32const(0).load('i32', { offset: e.layout.fsBase }).op(I32.add);
    }
}

/** The load kind for a zero-extended read of `size` bytes. @param {number} size */
const loadKind = size=>(size === 1 ? 'i32_8u' : size === 2 ? 'i32_16u' : 'i32');
/** The store kind for `size` bytes. @param {number} size */
const storeKind = size=>(size === 1 ? 'i32_8' : size === 2 ? 'i32_16' : 'i32');

/**
 * Pushes an operand's value, zero-extended to i32.
 *
 * @param {E} e @param {Operand} operand
 */
export function readOp(e, operand){
    const { b } = e;
    switch (operand.kind)
    {
        case 'reg':
        {
            const reg = /** @type {number} */ (operand.reg);
            b.localGet(Local.reg + reg);
            if (operand.size === 1)
            {
                if (operand.high)
                {
                    b.i32const(8).op(I32.shrU);
                }
                b.i32const(0xff).op(I32.and);
            }
            else if (operand.size === 2)
            {
                b.i32const(0xffff).op(I32.and);
            }
            return;
        }
        case 'imm':
            b.i32const(/** @type {number} */ (operand.value));
            return;
        case 'mem':
            b.localGet(Local.addr).load(loadKind(operand.size), { offset: e.layout.ramBase });
            return;
        default:
            throw new Error(`emit: cannot read a ${operand.kind} operand`);
    }
}

/**
 * Writes an operand: `pushValue` pushes the new value (any high bits are
 * masked here).
 *
 * @param {E} e @param {Operand} operand @param {() => void} pushValue
 */
export function writeOp(e, operand, pushValue){
    const { b } = e;
    switch (operand.kind)
    {
        case 'reg':
            pushValue();
            writeReg(e, /** @type {number} */ (operand.reg), operand.size, operand.high === true);
            return;
        case 'mem':
            noteStore(e, operand.size);
            b.localGet(Local.addr);
            pushValue();
            b.store(storeKind(operand.size), { offset: e.layout.ramBase });
            return;
        default:
            throw new Error(`emit: cannot write a ${operand.kind} operand`);
    }
}

/**
 * Writes the value on the stack into a register, merging a narrow write
 * into the dword.
 *
 * @param {E} e @param {number} reg @param {number} size @param {boolean} high
 */
export function writeReg(e, reg, size, high){
    const { b } = e;
    const local = Local.reg + reg;
    if (size === 4)
    {
        b.localSet(local);
        return;
    }
    b.localSet(Local.t0);
    b.localGet(local);
    if (size === 2)
    {
        b.i32const(0xffff0000 | 0).op(I32.and).localGet(Local.t0).i32const(0xffff).op(I32.and);
    }
    else if (high)
    {
        b.i32const(0xffff00ff | 0).op(I32.and).localGet(Local.t0).i32const(0xff).op(I32.and)
            .i32const(8).op(I32.shl);
    }
    else
    {
        b.i32const(0xffffff00 | 0).op(I32.and).localGet(Local.t0).i32const(0xff).op(I32.and);
    }
    b.op(I32.or).localSet(local);
}

/**
 * Masks the value on the stack to `size` bytes (nothing for a dword).
 * @param {E} e @param {number} size
 */
export function mask(e, size){
    if (size < 4)
    {
        e.b.i32const(MASKS[widthCode(size)]).op(I32.and);
    }
}

/**
 * Pushes `size` bytes onto the guest stack.
 *
 * @param {E} e @param {number} size @param {() => void} pushValue
 */
export function push(e, size, pushValue){
    const { b } = e;
    // The value first: `push esp` pushes the value before the decrement,
    // which itself waits for the access check so a fault leaves esp as it was.
    pushValue();
    b.localSet(Local.t2);
    b.localGet(Local.reg + 4).i32const(size).op(I32.sub).localSet(Local.addr);
    checkAccess(e, size);
    noteStore(e, size);
    b.localGet(Local.addr).localGet(Local.t2)
        .store(storeKind(size), { offset: e.layout.ramBase });
    b.localGet(Local.addr).localSet(Local.reg + 4);
}

// --- arithmetic ---

/**
 * add/adc/sub/sbb/cmp/xadd.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function arithmetic(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, src] = operands;
    const withCarry = op === 'adc' || op === 'sbb';
    if (withCarry)
    {
        e.pushFlag(CF);
        b.localSet(Local.cin);
    }
    prepare(e, dst.kind === 'mem' ? dst : src);
    readOp(e, dst);
    b.localSet(Local.op1);
    readOp(e, src);
    b.localSet(Local.op2);
    const compute = ()=>{
        b.localGet(Local.op1).localGet(Local.op2);
        b.op(op === 'add' || op === 'adc' || op === 'xadd' ? I32.add : I32.sub);
        if (withCarry)
        {
            b.localGet(Local.cin).op(op === 'adc' ? I32.add : I32.sub);
        }
        mask(e, size);
        if (flagsLive || op === 'cmp')
        {
            const kind = op === 'add' || op === 'xadd' ? Kind.ADD : op === 'adc' ? Kind.ADC
                : op === 'sbb' ? Kind.SBB : Kind.SUB;
            e.record(kind, size);
        }
    };
    if (op === 'cmp')
    {
        compute();
        b.drop();
        return;
    }
    if (op === 'xadd')
    {
        writeOp(e, src, ()=>b.localGet(Local.op1));
    }
    writeOp(e, dst, compute);
}

/**
 * and/or/xor/test.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function logic(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, src] = operands;
    prepare(e, dst.kind === 'mem' ? dst : src);
    const compute = ()=>{
        readOp(e, dst);
        readOp(e, src);
        b.op(op === 'and' || op === 'test' ? I32.and : op === 'or' ? I32.or : I32.xor);
        if (flagsLive || op === 'test')
        {
            e.record(Kind.LOGIC, size);
        }
    };
    if (op === 'test')
    {
        compute();
        b.drop();
        return;
    }
    writeOp(e, dst, compute);
}

/**
 * shl/shr/sar by an immediate or by cl. Flags: ZF/SF/PF lazily from the
 * result, CF and OF eagerly in the word; a count of zero changes nothing,
 * which for `cl` is a branch.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function shift(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, count] = operands;
    const bits = size * 8;
    const sign = SIGN_BITS[widthCode(size)];
    const staticCount = count.kind === 'imm' ? (/** @type {number} */ (count.value) & 31) : -1;
    if (staticCount === 0)
    {
        return true;
    }
    prepare(e, dst);
    const arith = op === 'sar';
    if (staticCount < 0)
    {
        // A count of zero at run time leaves the pending record to be folded
        // later, so its operands must survive: the word is made whole first.
        e.materialise();
    }
    // The value, sign-extended for sar.
    readOp(e, dst);
    if (arith && size < 4)
    {
        b.op(size === 1 ? I32_EXTRA.extend8s : I32_EXTRA.extend16s);
    }
    b.localSet(Local.op1);
    if (staticCount < 0)
    {
        readOp(e, count);
        b.i32const(31).op(I32.and).localSet(Local.count);
        b.localGet(Local.count).i32const(0).op(I32.ne);
        e.openIf('shifting', EMPTY);
    }
    else
    {
        b.i32const(staticCount).localSet(Local.count);
    }
    const pushCount = ()=>b.localGet(Local.count);
    writeOp(e, dst, ()=>{
        b.localGet(Local.op1);
        pushCount();
        if (op === 'shl' || op === 'sal')
        {
            b.op(I32.shl);
            // A count of the width or more leaves zero (i32.shl wraps the count).
            if (size < 4)
            {
                // select(val1, val2, cond): the mask is 0 when the count reaches the width.
                b.i32const(0);
                b.i32const(-1);
                pushCount();
                b.i32const(bits).op(I32.geU);
                b.op(0x1b);
                b.op(I32.and);
            }
        }
        else
        {
            b.op(arith ? I32.shrS : I32.shrU);
        }
        mask(e, size);
        if (flagsLive)
        {
            e.record(Kind.SHIFT, size);
        }
    });
    if (flagsLive)
    {
        // CF: the last bit shifted out. OF: shl -> msb(result) ^ CF; shr -> msb(original);
        // sar -> 0.
        b.localGet(Local.flags).i32const(~(CF | OF)).op(I32.and).localSet(Local.flags);
        if (op === 'shl' || op === 'sal')
        {
            b.localGet(Local.op1).i32const(bits).localGet(Local.count).op(I32.sub).op(I32.shrU)
                .i32const(1).op(I32.and);
        }
        else
        {
            b.localGet(Local.op1).localGet(Local.count).i32const(1).op(I32.sub)
                .op(arith ? I32.shrS : I32.shrU).i32const(1).op(I32.and);
        }
        b.localSet(Local.t1);
        b.localGet(Local.t1);
        e.orFlag(CF);
        if (op === 'shl' || op === 'sal')
        {
            b.localGet(Local.res).i32const(sign).op(I32.and).i32const(0).op(I32.ne)
                .localGet(Local.t1).op(I32.xor);
            e.orFlag(OF);
        }
        else if (op === 'shr')
        {
            b.localGet(Local.op1).i32const(sign).op(I32.and).i32const(0).op(I32.ne);
            e.orFlag(OF);
        }
    }
    if (staticCount < 0)
    {
        e.close();
        // Whether the shift happened is dynamic: the record is unknown here.
        e.pending = null;
    }
    return true;
}

/**
 * rol/ror: CF and OF eagerly, the rest untouched.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function rotate(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, count] = operands;
    const bits = size * 8;
    const sign = SIGN_BITS[widthCode(size)];
    prepare(e, dst);
    if (!rotationCount(e, count))
    {
        return true;
    }
    if (flagsLive)
    {
        e.materialise();
    }
    // The rotation is by the count modulo the width -- none at all for a
    // count of the width, though the flags are still written from the value.
    const pushN = ()=>{
        b.localGet(Local.count);
        if (size < 4)
        {
            b.i32const(bits).op(I32_EXTRA.remU);
        }
    };
    writeOp(e, dst, ()=>{
        readOp(e, dst);
        if (size === 4)
        {
            pushN();
            b.op(op === 'rol' ? I32_EXTRA.rotl : I32_EXTRA.rotr);
        }
        else
        {
            b.localSet(Local.t2);
            b.localGet(Local.t2);
            pushN();
            b.op(op === 'rol' ? I32.shl : I32.shrU);
            b.localGet(Local.t2).i32const(bits);
            pushN();
            b.op(I32.sub).op(op === 'rol' ? I32.shrU : I32.shl);
            b.op(I32.or);
            mask(e, size);
        }
        b.localSet(Local.t1);
        b.localGet(Local.t1);
    });
    if (flagsLive)
    {
        b.localGet(Local.count).i32const(0).op(I32.ne);
        e.openIf('rotated', EMPTY);
        b.localGet(Local.flags).i32const(~(CF | OF)).op(I32.and).localSet(Local.flags);
        if (op === 'rol')
        {
            b.localGet(Local.t1).i32const(1).op(I32.and);
            e.orFlag(CF);
            b.localGet(Local.t1).i32const(sign).op(I32.and).i32const(0).op(I32.ne)
                .localGet(Local.t1).i32const(1).op(I32.and).op(I32.xor);
            e.orFlag(OF);
        }
        else
        {
            b.localGet(Local.t1).i32const(sign).op(I32.and).i32const(0).op(I32.ne);
            e.orFlag(CF);
            b.localGet(Local.t1).i32const(sign).op(I32.and).i32const(0).op(I32.ne)
                .localGet(Local.t1).i32const(sign >>> 1).op(I32.and).i32const(0).op(I32.ne)
                .op(I32.xor);
            e.orFlag(OF);
        }
        e.close();
    }
    return true;
}

/**
 * Leaves the rotation count masked to five bits in `count`; answers false
 * when it is a constant zero, which leaves everything as it is.
 *
 * @param {E} e @param {Operand} count
 */
function rotationCount(e, count){
    const { b } = e;
    if (count.kind === 'imm')
    {
        const raw = /** @type {number} */ (count.value) & 31;
        if (raw === 0)
        {
            return false;
        }
        b.i32const(raw).localSet(Local.count);
        return true;
    }
    readOp(e, count);
    b.i32const(31).op(I32.and).localSet(Local.count);
    return true;
}

/**
 * rcl/rcr: a rotation of the value with the carry as its top bit, one bit
 * wider than the operand, done in i64 for every width. The count is taken
 * modulo the width plus one; a nonzero count that comes to zero still
 * writes CF (unchanged) and OF.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function rotateCarry(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, count] = operands;
    const bits = size * 8;
    const sign = SIGN_BITS[widthCode(size)];
    const left = op === 'rcl';
    prepare(e, dst);
    if (!rotationCount(e, count))
    {
        return true;
    }
    e.pushFlag(CF);
    b.localSet(Local.t2);
    if (flagsLive)
    {
        e.materialise();
    }
    // n, as an i64 shift count
    b.localGet(Local.count).i32const(bits + 1).op(I32_EXTRA.remU).op(I64.extendU)
        .localSet(Local.t64b);
    writeOp(e, dst, ()=>{
        // V = carry:value
        readOp(e, dst);
        b.op(I64.extendU).localGet(Local.t2).op(I64.extendU).i64const(BigInt(bits)).op(I64.shl)
            .op(I64.or).localSet(Local.t64);
        if (!left)
        {
            // rcr's OF is from the value before: msb(value) ^ carry in.
            b.localGet(Local.t64).op(I64.wrap).i32const(sign).op(I32.and).i32const(0).op(I32.ne)
                .localGet(Local.t2).op(I32.xor).localSet(Local.t2);
        }
        b.localGet(Local.t64).localGet(Local.t64b).op(left ? I64.shl : I64.shrU);
        b.localGet(Local.t64).i64const(BigInt(bits + 1)).localGet(Local.t64b).op(I64.sub)
            .op(left ? I64.shrU : I64.shl);
        b.op(I64.or).i64const((1n << BigInt(bits + 1)) - 1n).op(I64.and).localSet(Local.t64);
        b.localGet(Local.t64).op(I64.wrap);
        mask(e, size);
        b.localSet(Local.t1);
        b.localGet(Local.t1);
    });
    if (flagsLive)
    {
        b.localGet(Local.count).i32const(0).op(I32.ne);
        e.openIf('rotated', EMPTY);
        b.localGet(Local.flags).i32const(~(CF | OF)).op(I32.and).localSet(Local.flags);
        b.localGet(Local.t64).i64const(BigInt(bits)).op(I64.shrU).op(I64.wrap).i32const(1)
            .op(I32.and);
        e.orFlag(CF);
        if (left)
        {
            b.localGet(Local.t1).i32const(sign).op(I32.and).i32const(0).op(I32.ne);
            b.localGet(Local.t64).i64const(BigInt(bits)).op(I64.shrU).op(I64.wrap).i32const(1)
                .op(I32.and).op(I32.xor);
        }
        else
        {
            b.localGet(Local.t2);
        }
        e.orFlag(OF);
        e.close();
    }
    return true;
}

/**
 * shld/shrd of a dword or a word: the destination shifted with the source's
 * bits coming in. The word form's count may exceed the width; the pair as
 * one 32-bit value shifted by the count gives the processor's answer for
 * every count, carry included.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function shiftDouble(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, src, count] = operands;
    const sign = SIGN_BITS[widthCode(size)];
    const left = op === 'shld';
    prepare(e, dst);
    if (!rotationCount(e, count))
    {
        return true;
    }
    const dynamic = count.kind !== 'imm';
    if (dynamic)
    {
        // As in `shift`: whole word before the branch, record unknown after it.
        e.materialise();
        b.localGet(Local.count).i32const(0).op(I32.ne);
        e.openIf('shifting', EMPTY);
    }
    writeOp(e, dst, ()=>{
        if (size === 4)
        {
            readOp(e, dst);
            b.localSet(Local.t2);
            b.localGet(Local.t2).localGet(Local.count).op(left ? I32.shl : I32.shrU);
            readOp(e, src);
            b.i32const(32).localGet(Local.count).op(I32.sub).op(left ? I32.shrU : I32.shl);
            b.op(I32.or);
        }
        else
        {
            // shld: dst:src, the result in the high half; shrd: src:dst, in the low.
            readOp(e, left ? dst : src);
            b.i32const(16).op(I32.shl);
            readOp(e, left ? src : dst);
            b.op(I32.or).localSet(Local.t2);
            b.localGet(Local.t2).localGet(Local.count).op(left ? I32.shl : I32.shrU);
            if (left)
            {
                b.i32const(16).op(I32.shrU);
            }
            mask(e, size);
        }
        if (flagsLive)
        {
            e.record(Kind.SHIFT, size);
        }
    });
    if (flagsLive)
    {
        b.localGet(Local.flags).i32const(~(CF | OF)).op(I32.and).localSet(Local.flags);
        if (left)
        {
            b.localGet(Local.t2).i32const(32).localGet(Local.count).op(I32.sub).op(I32.shrU);
        }
        else
        {
            b.localGet(Local.t2).localGet(Local.count).i32const(1).op(I32.sub).op(I32.shrU);
        }
        b.i32const(1).op(I32.and);
        e.orFlag(CF);
        // OF: the sign changed.
        b.localGet(Local.t2);
        if (size === 2 && left)
        {
            b.i32const(16).op(I32.shrU);
        }
        b.i32const(sign).op(I32.and).i32const(0).op(I32.ne);
        b.localGet(Local.res).i32const(sign).op(I32.and).i32const(0).op(I32.ne).op(I32.xor);
        e.orFlag(OF);
    }
    if (dynamic)
    {
        e.close();
        e.pending = null;
    }
    return true;
}

/**
 * imul in its three forms: CF and OF say whether the signed product fit.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function imul(e, instruction, flagsLive){
    const { b } = e;
    const { operands, size } = instruction;
    const bits = size * 8;
    /** Pushes an operand sign-extended from its width. @param {Operand} operand */
    const readSigned = operand=>{
        readOp(e, operand);
        if (size === 1)
        {
            b.op(I32_EXTRA.extend8s);
        }
        else if (size === 2)
        {
            b.op(I32_EXTRA.extend16s);
        }
    };
    if (operands.length === 1)
    {
        if (size !== 4)
        {
            // Signed al * r/m8 -> ax, ax * r/m16 -> dx:ax; CF and OF say the
            // product does not fit its low half.
            prepare(e, operands[0]);
            b.localGet(Local.reg);
            b.op(size === 1 ? I32_EXTRA.extend8s : I32_EXTRA.extend16s);
            readSigned(operands[0]);
            b.op(I32_EXTRA.mul).localSet(Local.t1);
            wideResult(e, size, ()=>b.localGet(Local.t1));
            if (flagsLive)
            {
                e.eagerWrite(CF | OF);
                b.localGet(Local.t1);
                b.op(size === 1 ? I32_EXTRA.extend8s : I32_EXTRA.extend16s);
                b.localGet(Local.t1).op(I32.ne).localSet(Local.t2);
                b.localGet(Local.t2);
                e.orFlag(CF);
                b.localGet(Local.t2);
                e.orFlag(OF);
            }
            return true;
        }
        prepare(e, operands[0]);
        b.localGet(Local.reg).op(I64.extendS);
        readSigned(operands[0]);
        b.op(I64.extendS).op(I64.mul).localSet(Local.t64);
        b.localGet(Local.t64).op(I64.wrap).localSet(Local.reg);
        b.localGet(Local.t64).i64const(32n).op(I64.shrS).op(I64.wrap).localSet(Local.reg + 2);
        if (flagsLive)
        {
            e.eagerWrite(CF | OF);
            // Fits when the high half is the sign extension of the low half.
            b.localGet(Local.t64).localGet(Local.reg).op(I64.extendS).op(I64.ne);
            b.localSet(Local.t1);
            b.localGet(Local.t1);
            e.orFlag(CF);
            b.localGet(Local.t1);
            e.orFlag(OF);
        }
        return true;
    }
    const [dst, a, c] = operands.length === 3 ? operands : [operands[0], operands[0], operands[1]];
    prepare(e, a.kind === 'mem' ? a : c);
    readSigned(a);
    b.op(I64.extendS);
    readSigned(c);
    b.op(I64.extendS).op(I64.mul).localSet(Local.t64);
    writeOp(e, dst, ()=>{
        b.localGet(Local.t64).op(I64.wrap);
        mask(e, size);
    });
    if (flagsLive)
    {
        e.eagerWrite(CF | OF);
        // Fits when the product equals its own truncation, sign-extended back.
        b.localGet(Local.t64).i64const(BigInt(64 - bits)).op(I64.shl).i64const(BigInt(64 - bits))
            .op(I64.shrS).localGet(Local.t64).op(I64.ne);
        b.localSet(Local.t1);
        b.localGet(Local.t1);
        e.orFlag(CF);
        b.localGet(Local.t1);
        e.orFlag(OF);
    }
    return true;
}

/**
 * mul: the unsigned wide product; CF and OF say whether the high half is nonzero.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function mul(e, instruction, flagsLive){
    const { b } = e;
    const { operands, size } = instruction;
    if (size !== 4)
    {
        // al * r/m8 -> ax; ax * r/m16 -> dx:ax. The product fits an i32.
        prepare(e, operands[0]);
        b.localGet(Local.reg).i32const(MASKS[widthCode(size)]).op(I32.and);
        readOp(e, operands[0]);
        b.op(I32_EXTRA.mul).localSet(Local.t1);
        wideResult(e, size, ()=>b.localGet(Local.t1));
        if (flagsLive)
        {
            e.eagerWrite(CF | OF);
            b.localGet(Local.t1).i32const(size * 8).op(I32.shrU).i32const(0).op(I32.ne)
                .localSet(Local.t2);
            b.localGet(Local.t2);
            e.orFlag(CF);
            b.localGet(Local.t2);
            e.orFlag(OF);
        }
        return true;
    }
    prepare(e, operands[0]);
    b.localGet(Local.reg).op(I64.extendU);
    readOp(e, operands[0]);
    b.op(I64.extendU).op(I64.mul).localSet(Local.t64);
    b.localGet(Local.t64).op(I64.wrap).localSet(Local.reg);
    b.localGet(Local.t64).i64const(32n).op(I64.shrU).op(I64.wrap).localSet(Local.reg + 2);
    if (flagsLive)
    {
        e.eagerWrite(CF | OF);
        b.localGet(Local.reg + 2).i32const(0).op(I32.ne).localSet(Local.t1);
        b.localGet(Local.t1);
        e.orFlag(CF);
        b.localGet(Local.t1);
        e.orFlag(OF);
    }
    return true;
}

/**
 * div/idiv of a dword: edx:eax by the operand, a divide fault where the
 * processor raises one. Flags are undefined and left alone.
 *
 * @param {E} e @param {Instruction} instruction
 */
function divide(e, instruction){
    const { b } = e;
    const { op, operands, size } = instruction;
    prepare(e, operands[0]);
    readOp(e, operands[0]);
    b.localSet(Local.t1);
    // Divisor zero: the fault is raised at the instruction, state untouched.
    b.localGet(Local.t1).op(I32.eqz);
    e.openIf('zero', EMPTY);
    e.exitBefore(instruction.eip, Exit.FAULT, 0);
    e.close();
    if (size !== 4)
    {
        return divideNarrow(e, instruction);
    }
    b.localGet(Local.reg + 2).op(I64.extendU).i64const(32n).op(I64.shl)
        .localGet(Local.reg).op(I64.extendU).op(I64.or).localSet(Local.t64);
    if (op === 'div')
    {
        b.localGet(Local.t64).localGet(Local.t1).op(I64.extendU).op(I64.divU).localSet(Local.t64b);
        // A quotient past 32 bits is a fault too.
        b.localGet(Local.t64b).i64const(0xffffffffn).op(I64.gtU);
        e.openIf('overflow', EMPTY);
        e.exitBefore(instruction.eip, Exit.FAULT, 0);
        e.close();
        b.localGet(Local.t64).localGet(Local.t1).op(I64.extendU).op(I64.remU).op(I64.wrap)
            .localSet(Local.reg + 2);
    }
    else
    {
        // INT64_MIN / -1 would trap in wasm; on the processor it is a fault as well.
        b.localGet(Local.t1).i32const(-1).op(I32.eq);
        b.localGet(Local.t64).i64const(-0x8000000000000000n).op(I64.eq).op(I32.and);
        e.openIf('overflow', EMPTY);
        e.exitBefore(instruction.eip, Exit.FAULT, 0);
        e.close();
        b.localGet(Local.t64).localGet(Local.t1).op(I64.extendS).op(I64.divS).localSet(Local.t64b);
        // The quotient must fit a signed dword.
        b.localGet(Local.t64b).localGet(Local.t64b).op(I64.wrap).op(I64.extendS).op(I64.ne);
        e.openIf('overflow', EMPTY);
        e.exitBefore(instruction.eip, Exit.FAULT, 0);
        e.close();
        b.localGet(Local.t64).localGet(Local.t1).op(I64.extendS).op(I64.remS).op(I64.wrap)
            .localSet(Local.reg + 2);
    }
    b.localGet(Local.t64b).op(I64.wrap).localSet(Local.reg);
    return true;
}

/**
 * div/idiv of a byte or a word: ax by r/m8 into al (quotient) and ah
 * (remainder), dx:ax by r/m16 into ax and dx. The dividend fits an i32,
 * so the arithmetic is i32 with the divisor already in `t1` and checked
 * for zero.
 *
 * @param {E} e @param {Instruction} instruction
 */
function divideNarrow(e, instruction){
    const { b } = e;
    const { op, size } = instruction;
    const bits = size * 8;
    const signed = op === 'idiv';
    const extend = size === 1 ? I32_EXTRA.extend8s : I32_EXTRA.extend16s;
    // The dividend.
    if (size === 1)
    {
        b.localGet(Local.reg).i32const(0xffff).op(I32.and);
        if (signed)
        {
            b.op(I32_EXTRA.extend16s);
        }
    }
    else
    {
        b.localGet(Local.reg + 2).i32const(16).op(I32.shl)
            .localGet(Local.reg).i32const(0xffff).op(I32.and).op(I32.or);
    }
    b.localSet(Local.t2);
    if (signed)
    {
        b.localGet(Local.t1).op(extend).localSet(Local.t1);
        if (size === 2)
        {
            // INT32_MIN / -1 would trap in wasm; the processor faults, as the
            // quotient does not fit either way.
            b.localGet(Local.t1).i32const(-1).op(I32.eq);
            b.localGet(Local.t2).i32const(-0x80000000).op(I32.eq).op(I32.and);
            e.openIf('overflow', EMPTY);
            e.exitBefore(instruction.eip, Exit.FAULT, 0);
            e.close();
        }
    }
    b.localGet(Local.t2).localGet(Local.t1).op(signed ? I32_EXTRA.divS : I32_EXTRA.divU)
        .localSet(Local.t0);
    // The quotient must fit the width.
    b.localGet(Local.t0);
    if (signed)
    {
        b.op(extend).localGet(Local.t0).op(I32.ne);
    }
    else
    {
        b.i32const(MASKS[widthCode(size)]).op(I32.gtU);
    }
    e.openIf('overflow', EMPTY);
    e.exitBefore(instruction.eip, Exit.FAULT, 0);
    e.close();
    b.localGet(Local.t2).localGet(Local.t1).op(signed ? I32_EXTRA.remS : I32_EXTRA.remU)
        .localSet(Local.t2);
    // quotient low, remainder high: as one value of twice the width.
    b.localGet(Local.t0).i32const(MASKS[widthCode(size)]).op(I32.and)
        .localGet(Local.t2).i32const(bits).op(I32.shl).op(I32.or).localSet(Local.t1);
    wideResult(e, size, ()=>b.localGet(Local.t1));
    return true;
}

/**
 * Writes a value twice the width of `size` where the processor puts it: ax
 * for a byte (al low, ah high), dx:ax for a word.
 *
 * @param {E} e @param {number} size @param {() => void} pushValue
 */
function wideResult(e, size, pushValue){
    const { b } = e;
    if (size === 1)
    {
        pushValue();
        writeReg(e, 0, 2, false);
        return;
    }
    pushValue();
    writeReg(e, 0, 2, false);
    pushValue();
    b.i32const(16).op(I32.shrU);
    writeReg(e, 2, 2, false);
}

/**
 * bt/bts/btr/btc with a register destination, or a memory one and an
 * immediate offset. A memory destination with a register offset addresses
 * beyond the operand and is left to the other executor for now.
 *
 * @param {E} e @param {Instruction} instruction
 */
function bitTest(e, instruction){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, offset] = operands;
    const bits = size * 8;
    if (dst.kind === 'mem' && offset.kind !== 'imm')
    {
        return false;
    }
    prepare(e, dst);
    readOp(e, offset);
    b.i32const(bits - 1).op(I32.and).localSet(Local.count);
    readOp(e, dst);
    b.localSet(Local.t1);
    e.eagerWrite(CF);
    b.localGet(Local.t1).localGet(Local.count).op(I32.shrU).i32const(1).op(I32.and);
    e.orFlag(CF);
    if (op !== 'bt')
    {
        writeOp(e, dst, ()=>{
            b.localGet(Local.t1);
            b.i32const(1).localGet(Local.count).op(I32.shl);
            if (op === 'bts')
            {
                b.op(I32.or);
            }
            else if (op === 'btr')
            {
                b.i32const(-1).op(I32.xor).op(I32.and);
            }
            else
            {
                b.op(I32.xor);
            }
        });
    }
    return true;
}

/**
 * The string instructions, with and without a repeat prefix: a loop over
 * ecx with the direction from DF, each iteration counted as one
 * instruction against the budget.
 *
 * @param {E} e @param {Instruction} instruction
 */
function stringInstruction(e, instruction){
    const { b } = e;
    const { op, size, prefixes } = instruction;
    if (prefixes.address)
    {
        return false;
    }
    const repeat = prefixes.rep || prefixes.repne;
    // The step: -size when DF is set, +size otherwise, in t2 (select takes
    // its two values first and the condition last).
    b.i32const(-size).i32const(size);
    b.localGet(Local.flags).i32const(DF).op(I32.and).i32const(0).op(I32.ne);
    b.op(0x1b).localSet(Local.t2);
    const esi = Local.reg + 6;
    const edi = Local.reg + 7;
    const ecx = Local.reg + 1;
    /** @param {number} local */
    const advance = local=>b.localGet(local).localGet(Local.t2).op(I32.add).localSet(local);
    const compare = op === 'cmps' || op === 'scas';
    if (repeat)
    {
        // Each iteration is counted as one instruction, the instruction itself
        // as none: the budget is looked at every iteration, and a slice that
        // runs out in the middle leaves with EIP on the instruction, whose
        // remaining count is what ecx, esi and edi then hold.
        e.blockRetired--;
        e.open('done', EMPTY);
        e.openLoop('again');
        b.localGet(ecx).op(I32.eqz);
        b.brIf(e.depthOf('done'));
    }
    if (compare)
    {
        e.pending = null;
    }
    // Each access is checked where it happens; a fault inside a `rep` leaves
    // EIP on the instruction with the count and the pointers as far as they
    // got, which is what the processor does too.
    const counted = !repeat;
    /** @param {number} pointer */
    const checkedLoad = pointer=>{
        b.localGet(pointer).localSet(Local.addr);
        checkAccess(e, size, { counted });
        b.localGet(Local.addr).load(loadKind(size), { offset: e.layout.ramBase });
    };
    /**
     * A checked store at the pointer of the value `pushValue` pushes.
     * @param {number} pointer @param {() => void} pushValue
     */
    const checkedStore = (pointer, pushValue)=>{
        b.localGet(pointer).localSet(Local.addr);
        checkAccess(e, size, { counted });
        noteStore(e, size);
        b.localGet(Local.addr);
        pushValue();
        b.store(storeKind(size), { offset: e.layout.ramBase });
    };
    switch (op)
    {
        case 'movs':
            checkedLoad(esi);
            b.localSet(Local.t1);
            checkedStore(edi, ()=>b.localGet(Local.t1));
            advance(esi);
            advance(edi);
            break;
        case 'stos':
            checkedStore(edi, ()=>{
                b.localGet(Local.reg);
                mask(e, size);
            });
            advance(edi);
            break;
        case 'lods':
            checkedLoad(esi);
            writeReg(e, 0, size, false);
            advance(esi);
            break;
        case 'cmps':
            checkedLoad(esi);
            b.localSet(Local.op1);
            checkedLoad(edi);
            b.localSet(Local.op2);
            b.localGet(Local.op1).localGet(Local.op2).op(I32.sub);
            mask(e, size);
            e.record(Kind.SUB, size);
            b.drop();
            advance(esi);
            advance(edi);
            break;
        default: // scas
            b.localGet(Local.reg);
            mask(e, size);
            b.localSet(Local.op1);
            checkedLoad(edi);
            b.localSet(Local.op2);
            b.localGet(Local.op1).localGet(Local.op2).op(I32.sub);
            mask(e, size);
            e.record(Kind.SUB, size);
            b.drop();
            advance(edi);
    }
    if (repeat)
    {
        b.localGet(ecx).i32const(1).op(I32.sub).localSet(ecx);
        b.localGet(Local.retired).i32const(1).op(I32.add).localSet(Local.retired);
        b.localGet(Local.budget).i32const(1).op(I32.sub).localSet(Local.budget);
        b.localGet(Local.budget).i32const(0).op(I32.leS);
        e.openIf('spent', EMPTY);
        e.exitAt(instruction.eip, Exit.BUDGET);
        e.close();
        if (compare)
        {
            // rep: stop when not equal; repne: stop when equal.
            b.localGet(Local.res).op(I32.eqz);
            if (prefixes.rep)
            {
                b.op(I32.eqz);
            }
            b.brIf(e.depthOf('done'));
        }
        b.br(e.depthOf('again'));
        e.close();
        e.close();
        e.blockRetired++;
        e.pending = null;
    }
    return true;
}

export { AF, PF, SF, ValType };
