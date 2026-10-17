/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The atomic variant's locked instructions: where more
 * than one executor runs a process's threads at once, an x86 `lock`-prefixed
 * read-modify-write -- and `xchg` with memory, locked whether it says so or
 * not -- must be one indivisible access, as the processor makes it.
 *
 * Each is a value memory held (`old`) and the value to put there in its place,
 * a function of it (`next`), then what the instruction does with the two --
 * its flags, a register it writes. On an address that is a multiple of the
 * access's width the swap is a wasm atomic: the read-modify-write the threads
 * proposal has where there is one (add, sub, and, or, xor, xchg, cmpxchg),
 * otherwise a compare-and-swap loop (adc, sbb, neg). A wasm atomic traps on any
 * other address, where x86 does not, and an exit there would leave a block that
 * begins with the instruction with no entry -- a spin lock's loop head is one:
 * such an access inside one aligned qword is a compare-and-swap of the whole
 * qword, as indivisible as the processor's; one across a qword's boundary (a
 * split lock, which hardware too makes the slow exception) is a plain
 * read-modify-write, not indivisible against another executor.
 *
 * Plain loads and stores stay plain. On an x86 host the engine's ordinary
 * loads and stores are the processor's, in its order; elsewhere what a
 * program's plain stores promise another thread is the open question of the
 * atomic tax.
 */

import { CF, ZF } from '../decode/table.js';
import { EMPTY } from '../wasm/encoder.js';
import { I32, Kind } from './flags.js';
import { Local } from './region.js';
import { checkAccess, noteStore } from './memory.js';
import { emitAddress, mask, prepare, readOp, writeOp, writeReg } from './integer.js';

/** @typedef {import('./region.js').RegionEmitter} E */
/** @typedef {import('../decode/decoder.js').Instruction} Instruction */

const I32_LE_U = 0x4d;
const ELSE = 0x05;
const I64 = Object.freeze({ eq: 0x51, ne: 0x52, and: 0x83, or: 0x84, xor: 0x85, shl: 0x86,
    shrU: 0x88, wrap: 0xa7, extendU: 0xad });

/** The atomic kinds' width suffix for an operand of `size` bytes. @param {number} size */
const width = size=>(size === 1 ? 'i32_8' : size === 2 ? 'i32_16' : 'i32');
/** The plain load and store kinds of `size` bytes. @param {number} size */
const plainLoad = size=>(size === 1 ? 'i32_8u' : size === 2 ? 'i32_16u' : 'i32');
const plainStore = (/** @type {number} */ size)=>(size === 1 ? 'i32_8' : size === 2 ? 'i32_16'
    : 'i32');
/** Every bit of an operand of `size` bytes. @param {number} size */
const allBits = size=>(size === 1 ? 0xff : size === 2 ? 0xffff : -1);

/**
 * Whether the instruction is one the atomic variant emits here: a `lock`
 * prefix on a memory form, or `xchg` with a memory operand.
 *
 * @param {Instruction} instruction
 */
export function isLocked(instruction){
    return instruction.memory === true && (instruction.prefixes.lock || instruction.op === 'xchg');
}

/**
 * The indivisible swap at `Local.addr`: `old` takes what memory held and
 * memory what `next()` pushes from it.
 *
 * @param {E} e @param {number} size
 * @param {number} old  the local that takes the value memory held
 * @param {() => void} next  pushes the value to store, from `old`
 * @param {(() => void) | null} native  where the threads proposal has the operation: pushes
 *     its operands after the address, emits it and sets `old`, as one atomic
 */
function swap(e, size, old, next, native){
    const { b } = e;
    if (size > 1)
    {
        b.localGet(Local.addr).i32const(size - 1).op(I32.and);
        e.openGuard('splitLock', EMPTY);
        unaligned(e, size, old, next);
        b.op(ELSE);
    }
    if (native !== null)
    {
        native();
    }
    else
    {
        swapLoop(e, size, old, next);
    }
    if (size > 1)
    {
        e.close();
    }
}

/**
 * A compare-and-swap loop at the access's own width.
 *
 * @param {E} e @param {number} size @param {number} old @param {() => void} next
 */
function swapLoop(e, size, old, next){
    const { b } = e;
    const offset = e.layout.ramBase;
    e.openLoop('locked');
    b.localGet(Local.addr).atomic(`load_${width(size)}`, { offset }).localSet(old);
    b.localGet(Local.addr).localGet(old);
    next();
    b.atomic(`cmpxchg_${width(size)}`, { offset });
    b.localGet(old).op(I32.ne);
    b.brIf(e.depthOf('locked'));
    e.close();
}

/**
 * An access not a multiple of its width: inside one aligned qword, a
 * compare-and-swap of the qword; across two, a plain read-modify-write.
 *
 * @param {E} e @param {number} size @param {number} old @param {() => void} next
 */
function unaligned(e, size, old, next){
    const { b } = e;
    const offset = e.layout.ramBase;
    const bits = size === 4 ? 0xffffffffn : BigInt(allBits(size));
    /** Pushes the access's bit offset in its qword, as an i64. */
    const shift = ()=>b.localGet(Local.addr).i32const(7).op(I32.and).i32const(3).op(I32.shl)
        .op(I64.extendU);
    /** Pushes the qword's address. */
    const qword = ()=>b.localGet(Local.addr).i32const(-8).op(I32.and);
    b.localGet(Local.addr).i32const(7).op(I32.and).i32const(8 - size).op(I32_LE_U);
    e.openIf('inQword', EMPTY);
    e.openLoop('qwordLocked');
    qword();
    b.atomic('load_i64', { offset }).localSet(Local.t64);
    b.localGet(Local.t64);
    shift();
    b.op(I64.shrU).op(I64.wrap).i32const(allBits(size)).op(I32.and).localSet(old);
    qword();
    b.localGet(Local.t64);
    b.localGet(Local.t64).i64const(bits);
    shift();
    b.op(I64.shl).i64const(-1n).op(I64.xor).op(I64.and);
    next();
    b.op(I64.extendU);
    if (size < 4)
    {
        b.i64const(bits).op(I64.and);
    }
    shift();
    b.op(I64.shl).op(I64.or);
    b.atomic('cmpxchg_i64', { offset });
    b.localGet(Local.t64).op(I64.ne);
    b.brIf(e.depthOf('qwordLocked'));
    e.close();
    b.op(ELSE);
    b.localGet(Local.addr).load(plainLoad(size), { offset }).localSet(old);
    b.localGet(Local.addr);
    next();
    b.store(plainStore(size), { offset });
    e.close();
}

/**
 * The memory operand's address and checks, as the plain form makes them, and
 * the note of a store into code.
 *
 * @param {E} e @param {import('../decode/decoder.js').Operand} mem @param {number} size
 */
function addressOf(e, mem, size){
    prepare(e, mem, { store: true });
    noteStore(e, size);
}

/**
 * Emits a locked instruction of the atomic variant.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 * @returns {boolean} false where it is not one (the interpreter raises #UD)
 */
export function emitLocked(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, src] = operands;
    const offset = e.layout.ramBase;
    /** A native read-modify-write of `kind` with `operand`'s value, its answer into `old`.
     * @param {string} kind @param {() => void} operand @param {number} old */
    const native = (kind, operand, old)=>()=>{
        b.localGet(Local.addr);
        operand();
        b.atomic(`${kind}_${width(size)}`, { offset }).localSet(old);
    };
    switch (op)
    {
        case 'xchg':
        {
            const mem = dst.kind === 'mem' ? dst : src;
            const reg = dst.kind === 'mem' ? src : dst;
            addressOf(e, mem, size);
            // No flags: the locals a lazy record reads stay the previous instruction's.
            readOp(e, reg);
            b.localSet(Local.t2);
            swap(e, size, Local.t1, ()=>b.localGet(Local.t2),
                native('xchg', ()=>b.localGet(Local.t2), Local.t1));
            writeOp(e, reg, ()=>b.localGet(Local.t1));
            return true;
        }
        case 'add': case 'sub': case 'and': case 'or': case 'xor': case 'xadd':
        {
            const operation = op === 'xadd' ? 'add' : op;
            const opcode = operation === 'add' ? I32.add : operation === 'sub' ? I32.sub
                : operation === 'and' ? I32.and : operation === 'or' ? I32.or : I32.xor;
            addressOf(e, dst, size);
            readOp(e, src);
            b.localSet(Local.op2);
            const next = ()=>{
                b.localGet(Local.op1).localGet(Local.op2).op(opcode);
                mask(e, size);
            };
            swap(e, size, Local.op1, next, native(operation, ()=>b.localGet(Local.op2), Local.op1));
            if (op === 'xadd')
            {
                writeOp(e, src, ()=>b.localGet(Local.op1));
            }
            if (flagsLive)
            {
                next();
                e.record(operation === 'add' ? Kind.ADD : operation === 'sub' ? Kind.SUB
                    : Kind.LOGIC, size);
                b.drop();
            }
            return true;
        }
        case 'adc': case 'sbb':
        {
            e.pushFlag(CF);
            b.localSet(Local.cin);
            addressOf(e, dst, size);
            readOp(e, src);
            b.localSet(Local.op2);
            const next = ()=>{
                b.localGet(Local.op1).localGet(Local.op2).op(op === 'adc' ? I32.add : I32.sub);
                b.localGet(Local.cin).op(op === 'adc' ? I32.add : I32.sub);
                mask(e, size);
            };
            swap(e, size, Local.op1, next, null);
            if (flagsLive)
            {
                next();
                e.record(op === 'adc' ? Kind.ADC : Kind.SBB, size);
                b.drop();
            }
            return true;
        }
        case 'inc': case 'dec':
        {
            // As the plain form: CF stays, folded into the word first where it
            // is read before something writes it again.
            const value = flagsLive ? Local.op1 : Local.t1;
            if (flagsLive && (e.flagsAfter & CF) !== 0)
            {
                e.carryIntoWord();
            }
            addressOf(e, dst, size);
            const next = ()=>{
                b.localGet(value).i32const(1).op(op === 'inc' ? I32.add : I32.sub);
                mask(e, size);
            };
            swap(e, size, value, next,
                native(op === 'inc' ? 'add' : 'sub', ()=>b.i32const(1), value));
            if (flagsLive)
            {
                next();
                e.record(op === 'inc' ? Kind.INC : Kind.DEC, size);
                b.drop();
            }
            return true;
        }
        case 'neg':
        {
            addressOf(e, dst, size);
            const next = ()=>{
                b.i32const(0).localGet(Local.op2).op(I32.sub);
                mask(e, size);
            };
            swap(e, size, Local.op2, next, null);
            if (flagsLive)
            {
                next();
                e.record(Kind.NEG, size);
                b.drop();
            }
            return true;
        }
        case 'not':
        {
            addressOf(e, dst, size);
            const next = ()=>{
                b.localGet(Local.t1).i32const(allBits(size)).op(I32.xor);
                mask(e, size);
            };
            swap(e, size, Local.t1, next, native('xor', ()=>b.i32const(allBits(size)), Local.t1));
            return true;
        }
        case 'bts': case 'btr': case 'btc':
        {
            const bits = size * 8;
            if (src.kind !== 'imm')
            {
                // A bit string, as the plain form: the register names a bit
                // anywhere from the address, signed.
                emitAddress(e, dst, true);
                readOp(e, src);
                if (size === 2)
                {
                    b.i32const(16).op(I32.shl).i32const(16).op(I32.shrS);
                }
                b.localTee(Local.t2);
                b.i32const(size === 2 ? 4 : 5).op(I32.shrS).i32const(size === 2 ? 1 : 2)
                    .op(I32.shl);
                b.op(I32.add).localSet(Local.addr);
                checkAccess(e, size, { store: true });
                noteStore(e, size);
                b.localGet(Local.t2).i32const(bits - 1).op(I32.and).localSet(Local.count);
            }
            else
            {
                addressOf(e, dst, size);
                readOp(e, src);
                b.i32const(bits - 1).op(I32.and).localSet(Local.count);
            }
            /** Pushes the bit's mask, inverted for `btr`. */
            const bit = ()=>{
                b.i32const(1).localGet(Local.count).op(I32.shl);
                if (op === 'btr')
                {
                    b.i32const(-1).op(I32.xor);
                }
            };
            const operation = op === 'bts' ? 'or' : op === 'btr' ? 'and' : 'xor';
            const next = ()=>{
                b.localGet(Local.t1);
                bit();
                b.op(operation === 'or' ? I32.or : operation === 'and' ? I32.and : I32.xor);
                mask(e, size);
            };
            swap(e, size, Local.t1, next, native(operation, bit, Local.t1));
            if (flagsLive)
            {
                e.eagerWrite(CF);
                b.localGet(Local.t1).localGet(Local.count).op(I32.shrU).i32const(1).op(I32.and);
                e.orFlag(CF);
            }
            return true;
        }
        case 'cmpxchg':
        {
            addressOf(e, dst, size);
            b.localGet(Local.reg);
            mask(e, size);
            b.localSet(Local.op1);
            readOp(e, src);
            b.localSet(Local.t2);
            // Memory keeps what it held unless it held the accumulator.
            const next = ()=>{
                b.localGet(Local.t2).localGet(Local.op2).localGet(Local.op2).localGet(Local.op1)
                    .op(I32.eq).op(0x1b); // select
            };
            swap(e, size, Local.op2, next, ()=>{
                b.localGet(Local.addr).localGet(Local.op1).localGet(Local.t2);
                b.atomic(`cmpxchg_${width(size)}`, { offset }).localSet(Local.op2);
            });
            b.localGet(Local.op1).localGet(Local.op2).op(I32.sub);
            mask(e, size);
            e.record(Kind.SUB, size);
            // Not equal: the accumulator takes what memory held.
            e.openIf('differs', EMPTY);
            b.localGet(Local.op2);
            writeReg(e, 0, size, false);
            e.close();
            return true;
        }
        case 'cmpxchg8b':
        {
            addressOf(e, dst, 8);
            // edx:eax, the value expected, and ecx:ebx, the one stored.
            b.localGet(Local.reg + 2).op(I64.extendU).i64const(32n).op(I64.shl);
            b.localGet(Local.reg).op(I64.extendU).op(I64.or).localSet(Local.t64b);
            b.localGet(Local.addr).i32const(7).op(I32.and);
            e.openGuard('splitLock', EMPTY);
            // Across two qwords: a plain read and, if it matched, a plain write.
            b.localGet(Local.addr).load('i64', { offset }).localSet(Local.t64);
            b.localGet(Local.t64).localGet(Local.t64b).op(I64.eq);
            e.openIf('plainEqual', EMPTY);
            b.localGet(Local.addr);
            b.localGet(Local.reg + 1).op(I64.extendU).i64const(32n).op(I64.shl);
            b.localGet(Local.reg + 3).op(I64.extendU).op(I64.or);
            b.store('i64', { offset });
            e.close();
            b.op(ELSE);
            b.localGet(Local.addr).localGet(Local.t64b);
            b.localGet(Local.reg + 1).op(I64.extendU).i64const(32n).op(I64.shl);
            b.localGet(Local.reg + 3).op(I64.extendU).op(I64.or);
            b.atomic('cmpxchg_i64', { offset }).localSet(Local.t64);
            e.close();
            if (flagsLive)
            {
                e.eagerWrite(ZF);
            }
            b.localGet(Local.t64).localGet(Local.t64b).op(I64.eq);
            e.openIf('equal', EMPTY);
            if (flagsLive)
            {
                b.localGet(Local.flags).i32const(ZF).op(I32.or).localSet(Local.flags);
            }
            b.op(ELSE);
            b.localGet(Local.t64).op(I64.wrap).localSet(Local.reg);
            b.localGet(Local.t64).i64const(32n).op(I64.shrU).op(I64.wrap).localSet(Local.reg + 2);
            e.close();
            return true;
        }
        default:
            return false;
    }
}
