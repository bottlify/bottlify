/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A call to a C runtime function the dictionary knows (`helpers.js`), made as
 * the operation it is: a copy is one `memory.copy`, a fill one `memory.fill`,
 * a string's length a loop over its bytes -- in place of the function's body,
 * translated block by block, which a program's own copy of the runtime runs
 * in its hottest loops.
 *
 * The call's arguments are where the call would have handed them: on the
 * stack at esp in 32-bit code (cdecl, the call not yet made), in rcx, rdx and
 * r8 in long mode. Its result goes where the function leaves it, eax or rax;
 * no other register is written, the volatile ones the function would have
 * changed left as they were, which a compiled caller cannot tell from any
 * value.
 *
 * What the operation cannot do here it does not start: a span reaching a page
 * that is not plain -- inaccessible, holding translated code, watched for
 * writes -- or past RAM, a copy of `memcpy` whose source and destination
 * overlap, an address past 4 GiB, a size past `CRT_LIMIT`. Then the block
 * leaves before the call with nothing written, and the call is made as it
 * was: the function's own body, wherever it runs, does it, faults included.
 */

import { EMPTY } from '../wasm/encoder.js';
import { I32, I64 } from './flags.js';
import { Exit, Local } from './region.js';
import { registerLocal } from './width.js';
import { pageFlagsAt } from '../runtime/layout.js';
import { PageFlag, STORE_FLAGS } from '../runtime/pages.js';

/** @typedef {import('./region.js').RegionEmitter} E */
/** @typedef {import('../decode/decoder.js').Instruction} Instruction */

/**
 * The most bytes one operation copies, fills or reads: past it the call is
 * made as it was. The budget is charged a unit for every 16 bytes, as a `rep`
 * is (`bulkString`), and a run of this many is a few milliseconds of a slice.
 */
export const CRT_LIMIT = 16 << 20;

/** The budget's unit, in bytes, as `bulkString` charges it. */
const UNIT_SHIFT = 4;

const RAX = 0;
const RCX = 1;
const RDX = 2;
const ESP = 4;
const R8 = 8;

/**
 * @param {E} e
 * @param {Instruction} instruction
 * @returns {boolean} false where the region's build cannot take it
 */
export function emitCrt(e, instruction){
    if (e.context.undo !== undefined || e.layout.window !== undefined)
    {
        // A build that logs every store for an undo, and a wide window's
        // addresses past 4 GiB: the call is made as it was.
        return false;
    }
    const operation = instruction.crt;
    switch (operation)
    {
        case 'memmove': case 'memcpy': case 'memset':
            arguments3(e);
            spans(e, operation);
            leaveUnless(e, instruction);
            charge(e);
            if (operation === 'memset')
            {
                guestAddress(e, Local.t0);
                e.b.localGet(Local.t1).localGet(Local.t2).op(0xfc, [0x0b, 0x00]); // memory.fill
            }
            else
            {
                guestAddress(e, Local.t0);
                guestAddress(e, Local.t1);
                e.b.localGet(Local.t2).op(0xfc, [0x0a, 0x00, 0x00]); // memory.copy
            }
            result(e, Local.t0);
            return true;
        case 'strlen':
            e.b.i32const(0).localSet(Local.addr);
            argument(e, 0, Local.t0);
            length(e);
            leaveUnless(e, instruction);
            e.b.localGet(Local.t1).localSet(Local.t2);
            charge(e);
            result(e, Local.t1);
            return true;
        case 'sqrt':
            sqrtArgument(e);
            leaveUnless(e, instruction);
            return true;
        default:
            return false;
    }
}

/** Whether the region is long mode's. @param {E} e */
const isLong = e=>e.width.bits === 64;

/**
 * An argument into an i32 local: the stack's dword `index` (32-bit code) or a
 * register (long mode); a register's high half not zero marks the call as one
 * to make as it was (`Local.addr` -1).
 *
 * @param {E} e @param {number} index @param {number} local
 */
function argument(e, index, local){
    const { b } = e;
    if (!isLong(e))
    {
        b.localGet(registerLocal(e, ESP)).load('i32', { guest: true,
            offset: e.layout.ramBase + 4 * index }).localSet(local);
        return;
    }
    const reg = registerLocal(e, [RCX, RDX, R8][index]);
    b.localGet(reg).op(I64.wrap).localSet(local);
    b.localGet(reg).i64const(32n).op(I64.shrU).op(I64.wrap);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.end();
}

/** The three arguments in t0, t1 and t2; `Local.addr` 0 unless one cannot be taken. @param {E} e */
function arguments3(e){
    e.b.i32const(0).localSet(Local.addr);
    argument(e, 0, Local.t0);
    argument(e, 1, Local.t1);
    argument(e, 2, Local.t2);
}

/**
 * Tests the spans of a copy or fill, setting `Local.addr` to -1 where the
 * call is to be made as it was: the destination `[t0, t0 + t2)` plain for a
 * store, the source `[t1, t1 + t2)` accessible, both in RAM, the size within
 * `CRT_LIMIT`, and for `memcpy` the two apart.
 *
 * @param {E} e @param {string} operation
 */
function spans(e, operation){
    const { b } = e;
    b.localGet(Local.t2).i32const(CRT_LIMIT).op(I32.gtU);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.end();
    if (operation === 'memcpy')
    {
        // Apart: dst - src >=u n and src - dst >=u n.
        b.localGet(Local.t0).localGet(Local.t1).op(I32.sub).localGet(Local.t2).op(I32.ltU);
        b.localGet(Local.t1).localGet(Local.t0).op(I32.sub).localGet(Local.t2).op(I32.ltU);
        b.op(I32.or);
        b.if(EMPTY);
        b.i32const(-1).localSet(Local.addr);
        b.end();
    }
    span(e, Local.t0, PageFlag.INACCESSIBLE | STORE_FLAGS);
    if (operation !== 'memset')
    {
        span(e, Local.t1, PageFlag.INACCESSIBLE);
    }
}

/**
 * `[pointer, pointer + t2)`'s pages tested for `bits`, unless `Local.addr` is
 * already -1, which it is set to when one has any or the span leaves RAM. A
 * span of no bytes is plain.
 *
 * @param {E} e @param {number} pointer @param {number} bits
 */
function span(e, pointer, bits){
    const { b } = e;
    const table = pageFlagsAt(e.layout);
    const { ramSize } = e.layout;
    b.localGet(Local.addr).i32const(-1).op(I32.ne)
        .localGet(Local.t2).i32const(0).op(I32.ne).op(I32.and);
    b.if(EMPTY);
    // In RAM: pointer <=u ramSize and t2 <=u ramSize - pointer.
    b.localGet(pointer).i32const(ramSize).op(I32.gtU)
        .localGet(Local.t2).i32const(ramSize).localGet(pointer).op(I32.sub).op(I32.gtU)
        .op(I32.or);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.else();
    b.localGet(pointer).i32const(12).op(I32.shrU).localSet(Local.addr);
    b.block(EMPTY);
    b.loop(EMPTY);
    b.localGet(Local.addr).load('i32_8u', { offset: table }).i32const(bits).op(I32.and);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.br(2);
    b.end();
    // The last page: (pointer + t2 - 1) >> 12.
    b.localGet(Local.addr)
        .localGet(pointer).localGet(Local.t2).op(I32.add).i32const(1).op(I32.sub)
        .i32const(12).op(I32.shrU).op(I32.eq).brIf(1);
    b.localGet(Local.addr).i32const(1).op(I32.add).localSet(Local.addr);
    b.br(0);
    b.end();
    b.end();
    b.end();
    b.end();
}

/**
 * The length of the string at t0 into t1, its bytes read up to the first
 * zero; `Local.addr` -1 where a page it reaches is inaccessible or past RAM,
 * or it runs past `CRT_LIMIT`.
 *
 * @param {E} e
 */
function length(e){
    const { b } = e;
    const table = pageFlagsAt(e.layout);
    const { ramBase, ramSize } = e.layout;
    b.i32const(0).localSet(Local.t1);
    b.localGet(Local.addr).i32const(-1).op(I32.ne);
    b.if(EMPTY);
    b.block(EMPTY);
    b.loop(EMPTY);
    // At the string's first byte and at each page's: the page tested.
    b.localGet(Local.t1).i32const(0).op(I32.eq)
        .localGet(Local.t0).localGet(Local.t1).op(I32.add).i32const(0xfff).op(I32.and)
        .i32const(0).op(I32.eq).op(I32.or);
    b.if(EMPTY);
    b.localGet(Local.t0).localGet(Local.t1).op(I32.add).localTee(Local.t2)
        .i32const(ramSize).op(I32.geU)
        .localGet(Local.t1).i32const(CRT_LIMIT).op(I32.geU).op(I32.or)
        .localGet(Local.t2).i32const(12).op(I32.shrU).load('i32_8u', { offset: table })
        .i32const(PageFlag.INACCESSIBLE).op(I32.and).op(I32.or);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.br(3);
    b.end();
    b.end();
    b.localGet(Local.t0).localGet(Local.t1).op(I32.add)
        .load('i32_8u', { guest: true, offset: ramBase }).op(I32.eqz).brIf(1);
    b.localGet(Local.t1).i32const(1).op(I32.add).localSet(Local.t1);
    b.br(0);
    b.end();
    b.end();
    b.end();
}

/**
 * The square root's argument tested: a number not below zero (-0 is one), or
 * `Local.addr` -1. Its double is the stack's first qword (32-bit code: the
 * `body` after this takes the root and returns it in ST0).
 *
 * @param {E} e
 */
function sqrtArgument(e){
    const { b } = e;
    b.i32const(0).i32const(-1);
    b.localGet(registerLocal(e, ESP)).load('f64', { guest: true, offset: e.layout.ramBase })
        .f64const(0).op(0x66); // f64.ge: false for a NaN
    b.select().localSet(Local.addr);
}

/**
 * Leaves before the call, with nothing written, where `Local.addr` is -1.
 *
 * @param {E} e @param {Instruction} instruction
 */
function leaveUnless(e, instruction){
    e.b.localGet(Local.addr).i32const(-1).op(I32.eq);
    e.openGuard('crt', EMPTY);
    e.exitBefore(instruction.eip, Exit.UNTRANSLATED);
    e.close();
}

/** The wasm address of the guest address in `local`. @param {E} e @param {number} local */
function guestAddress(e, local){
    e.b.localGet(local);
    if (e.layout.ramBase !== 0)
    {
        e.b.i32const(e.layout.ramBase).op(I32.add);
    }
}

/** The budget charged a unit for every 16 bytes of t2, a begun one whole. @param {E} e */
function charge(e){
    const { b } = e;
    b.localGet(Local.budget)
        .localGet(Local.t2).i32const((1 << UNIT_SHIFT) - 1).op(I32.add)
        .i32const(UNIT_SHIFT).op(I32.shrU).op(I32.sub).localSet(Local.budget);
}

/** eax (rax) given the i32 in `local`. @param {E} e @param {number} local */
function result(e, local){
    const { b } = e;
    b.localGet(local);
    if (isLong(e))
    {
        b.op(I64.extendU);
    }
    b.localSet(registerLocal(e, RAX));
}
