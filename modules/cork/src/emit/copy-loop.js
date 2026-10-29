/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The byte copy loop a compiler makes of a freestanding memcpy, `movs; cmp;
 * jne` back to itself, run whole before the loop when it is short and its
 * pages are plain: one test of the run, the bytes moved eight at a time, the
 * pointers, the budget and the compare's flags left as the loop's last turn
 * leaves them. The loop itself stays for every other case.
 *
 * Measured on cork-bench sort (a 12-byte record swap through such a loop), the
 * loop's turns were not where its cost was: each call of the copy paid the
 * hoisted loop's window test and the register moves V8 makes around it (63
 * machine instructions) before the first byte, and 13 to 16 a byte after. An
 * earlier attempt that ran every element but the last at once and left the
 * last to the loop kept the window test and gained nothing; this one leaves the
 * loop out of the run altogether.
 */

import { DF } from '../decode/table.js';
import { EMPTY, ValType } from '../wasm/encoder.js';
import { I32 } from './flags.js';
import { Local, STATE_PARAMS } from './region.js';
import { registerLocal } from './width.js';
import { pageFlagsAt } from '../runtime/layout.js';
import { PageFlag, STORE_FLAGS } from '../runtime/pages.js';

/** @typedef {import('./region.js').RegionEmitter} E */
/** @typedef {import('../region.js').Block} Block */

const ESI = 6;
const EDI = 7;
/** `jne`'s condition code. */
const NOT_EQUAL = 5;
/**
 * The longest run done at once, in bytes: its source and its destination each
 * lie on at most two pages, so four flag loads test it. A longer copy runs the
 * hoisted loop, whose window test is paid once a page there.
 */
export const COPY_RUN_LIMIT = 4096;

/**
 * @typedef {object} CopyLoop
 * @property {number} size     the element's bytes
 * @property {number} pointer  the register the loop compares: edi or esi
 * @property {number} end      the register it compares it with, which the loop does not write
 */

/**
 * A block that is the whole of a byte (or word, or doubleword) copy loop:
 * `movs` with no prefix, a compare of one of its pointers with a register
 * neither pointer is, and a `jne` back to the block's start. Null for any
 * other block.
 *
 * @param {Block} block
 * @returns {CopyLoop | null}
 */
export function copyLoopOf(block){
    if (block.instructions.length !== 3 || block.exit.kind !== 'jcc'
        || block.exit.targets[0] !== block.start)
    {
        return null;
    }
    const [move, compare, branch] = block.instructions;
    const { prefixes } = move;
    if (move.op !== 'movs' || prefixes.rep || prefixes.repne || prefixes.lock
        || prefixes.address || prefixes.segment !== -1 || compare.op !== 'cmp'
        || branch.op !== 'jne' || branch.cc !== NOT_EQUAL)
    {
        return null;
    }
    const [a, c] = compare.operands;
    if (a?.kind !== 'reg' || c?.kind !== 'reg' || a.size !== 4 || c.size !== 4
        || a.high === true || c.high === true)
    {
        return null;
    }
    const pointer = a.reg === EDI || a.reg === ESI ? a.reg : c.reg;
    const end = pointer === a.reg ? c.reg : a.reg;
    if ((pointer !== EDI && pointer !== ESI) || end === undefined || end === EDI || end === ESI
        || end === 4)
    {
        return null;
    }
    return { size: move.size, pointer, end };
}

/**
 * The copy loop run whole, ahead of the loop's own code: when the direction
 * flag is clear, the run (end - pointer) is a whole number of elements, at
 * least one and at most `COPY_RUN_LIMIT` bytes, the budget pays for every turn
 * with more than a back edge's test left over, the destination is not 1 to 7
 * bytes ahead of the source (where a byte loop reads what it has just written
 * and an eight-byte move would not), and the source's pages are readable and
 * the destination's writable, with no code and no watch. Then the bytes go
 * forward eight at a time and the rest by four, two and one -- the same bytes
 * the loop writes, as a destination eight or more ahead of its source reads
 * every byte after it was written either way -- esi and edi move past the run,
 * the budget is charged the loop's instructions for every turn, the compare
 * (`emitCompare`) sets the flags as the last turn's does, and the code
 * branches to `doneLabel`, past the loop. Any other case falls through to the
 * loop.
 *
 * @param {E} e @param {Block} block @param {CopyLoop} loop
 * @param {string} doneLabel  the label past the loop
 * @param {() => void} emitCompare  the block's compare, its flags as live as the block has them
 * @param {((turns: number) => void) | null} profile  adds the turns (the local given) to the
 *     block's profile slot
 */
export function emitCopyAtOnce(e, block, loop, doneLabel, emitCompare, profile){
    const { b } = e;
    const { size } = loop;
    const shift = Math.log2(size);
    const edi = registerLocal(e, EDI);
    const esi = registerLocal(e, ESI);
    const table = pageFlagsAt(e.layout);
    const ram = e.layout.ramBase;
    const length = block.instructions.length;
    const local = ()=>{
        const made = e.localTypes.length + STATE_PARAMS;
        e.localTypes.push(ValType.i32);
        return made;
    };
    const bytes = local();
    const left = local();
    const at = local();
    const charge = local();
    /** The flags of the page holding the address on the stack. */
    const flagsOf = ()=>{
        b.i32const(12).op(I32.shrU);
        if ((table & 0xfffff) === 0)
        {
            b.i32const(table | 0).op(I32.or).load('i32_8u', { offset: 0 });
        }
        else
        {
            b.load('i32_8u', { offset: table });
        }
    };
    /** The flags of the run's first and last pages from `pointer`. @param {number} pointer */
    const rangeFlags = pointer=>{
        b.localGet(pointer);
        flagsOf();
        b.localGet(pointer).localGet(bytes).op(I32.add).i32const(1).op(I32.sub);
        flagsOf();
        b.op(I32.or);
    };
    e.open('copyLoop', EMPTY);
    const out = ()=>b.brIf(e.depthOf('copyLoop'));
    // The run's bytes: one to the limit, a whole number of elements, DF clear.
    b.localGet(registerLocal(e, loop.end)).localGet(registerLocal(e, loop.pointer)).op(I32.sub)
        .localTee(bytes).i32const(1).op(I32.sub).i32const(COPY_RUN_LIMIT).op(I32.geU);
    if (size > 1)
    {
        b.localGet(bytes).i32const(size - 1).op(I32.and).op(I32.or);
    }
    b.localGet(Local.flags).i32const(DF).op(I32.and).op(I32.or);
    // Not 1 to 7 bytes ahead of the source.
    b.localGet(edi).localGet(esi).op(I32.sub).i32const(1).op(I32.sub).i32const(7).op(I32.ltU)
        .op(I32.or);
    out();
    // The budget after every turn, which must leave more than a back edge's
    // test leaves on (`spentTest`): the loop would have left before its end.
    b.localGet(Local.budget).localGet(bytes).i32const(shift).op(I32.shrU)
        .i32const(length).op(I32.mul).localTee(charge).op(I32.sub);
    e.spentLimit();
    b.op(I32.leS);
    out();
    rangeFlags(esi);
    b.i32const(PageFlag.INACCESSIBLE).op(I32.and);
    rangeFlags(edi);
    b.i32const(PageFlag.INACCESSIBLE | STORE_FLAGS).op(I32.and).op(I32.or);
    out();
    // Eight bytes at a time while eight are left.
    b.i32const(0).localSet(at);
    b.localGet(bytes).localSet(left);
    e.open('words', EMPTY);
    e.openLoop('word');
    b.localGet(left).i32const(8).op(I32.ltU);
    b.brIf(e.depthOf('words'));
    b.localGet(edi).localGet(at).op(I32.add);
    b.localGet(esi).localGet(at).op(I32.add).load('i64', { offset: ram, align: 0 });
    b.store('i64', { offset: ram, align: 0 });
    b.localGet(at).i32const(8).op(I32.add).localSet(at);
    b.localGet(left).i32const(8).op(I32.sub).localSet(left);
    b.br(e.depthOf('word'));
    e.close();
    e.close();
    for (const [step, load, store] of /** @type {const} */ ([[4, 'i32', 'i32'],
        [2, 'i32_16u', 'i32_16'], [1, 'i32_8u', 'i32_8']]))
    {
        if (step < size)
        {
            continue;
        }
        b.localGet(left).i32const(step).op(I32.and);
        e.openIf('copyRest');
        b.localGet(edi).localGet(at).op(I32.add);
        b.localGet(esi).localGet(at).op(I32.add).load(load, { offset: ram, align: 0 });
        b.store(store, { offset: ram, align: 0 });
        if (step > 1)
        {
            b.localGet(at).i32const(step).op(I32.add).localSet(at);
        }
        e.close();
    }
    b.localGet(esi).localGet(bytes).op(I32.add).localSet(esi);
    b.localGet(edi).localGet(bytes).op(I32.add).localSet(edi);
    b.localGet(Local.budget).localGet(charge).op(I32.sub).localSet(Local.budget);
    if (profile !== null)
    {
        b.localGet(bytes).i32const(shift).op(I32.shrU).localSet(left);
        profile(left);
    }
    emitCompare();
    b.br(e.depthOf(doneLabel));
    e.close();
}
