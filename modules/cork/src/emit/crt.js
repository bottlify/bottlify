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
 * What the operation cannot do here it does not start: a span reaching a
 * closed page, translated code itself or past RAM, a copy of `memcpy` whose
 * source and destination overlap, an address past 4 GiB outside a wide
 * window, a size past `CRT_LIMIT`. Then the block leaves before the call with
 * nothing written, and the call is made as it was: the function's own body,
 * wherever it runs, does it, faults included. A wide window (`wideLayout`)
 * forms the copies, fills, string lengths, comparisons and searches, its
 * pointers the whole of rcx and rdx and its RAM the memory of its own.
 */

import { EMPTY } from '../wasm/encoder.js';
import { I32, I64 } from './flags.js';
import { Exit, Local } from './region.js';
import { registerLocal } from './width.js';
import { pageFlagsAt } from '../runtime/layout.js';
import { atState } from './bases.js';
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
const RBX = 3;
const ESP = 4;
const R8 = 8;

/**
 * @param {E} e
 * @param {Instruction} instruction
 * @returns {boolean} false where the region's build cannot take it
 */
export function emitCrt(e, instruction){
    const operation = instruction.crt;
    if (e.context.undo !== undefined || isWide(e) && !WIDE_OPERATIONS.has(String(operation)))
    {
        // A build that logs every store for an undo: the call is made as it was.
        return false;
    }
    const { b } = e;
    // The RAM's memory: a wide window's own (`wideLayout`), else the one.
    const ram = e.layout.ramMemory ?? 0;
    switch (operation)
    {
        case 'memmove': case 'memcpy': case 'memset':
        {
            arguments3(e, operation === 'memset');
            const [dst, src] = pointers(e);
            spans(e, operation, dst, src);
            leaveUnless(e, instruction);
            charge(e);
            guestAddress(e, dst);
            if (operation === 'memset')
            {
                if (isWide(e))
                {
                    b.localGet(registerLocal(e, RDX)).op(I64.wrap);
                }
                else
                {
                    b.localGet(Local.t1);
                }
                size(e);
                b.op(0xfc, [0x0b, ram]); // memory.fill
            }
            else
            {
                guestAddress(e, src);
                size(e);
                b.op(0xfc, [0x0a, ram, ram]); // memory.copy
            }
            result(e, dst);
            return true;
        }
        case 'strlen':
        {
            b.i32const(0).localSet(Local.addr);
            if (!isWide(e))
            {
                argument(e, 0, Local.t0);
            }
            const [string] = pointers(e);
            length(e, string);
            leaveUnless(e, instruction);
            b.localGet(Local.t1).localSet(Local.t2);
            charge(e);
            b.localGet(Local.t1);
            if (isLong(e))
            {
                b.op(I64.extendU);
            }
            b.localSet(registerLocal(e, RAX));
            return true;
        }
        case 'sqrt':
            sqrtArgument(e);
            leaveUnless(e, instruction);
            return true;
        case 'floor': case 'ceil':
            finiteArgument(e);
            leaveUnless(e, instruction);
            return true;
        case 'ftol2sse':
            if (isLong(e) || instruction.crtWord === undefined)
            {
                return false;
            }
            flagSet(e, instruction.crtWord);
            leaveUnless(e, instruction);
            return true;
        case 'chkstk64':
            return isLong(e) && chkstk64(e, instruction);
        case 'memcmp': case 'strcmp':
            compare(e, instruction, operation);
            return true;
        case 'memchr': case 'strchr':
            find(e, instruction, operation);
            return true;
        default:
            return !isLong(e) && helper32(e, instruction);
    }
}

/** The compiler's quadword helpers that take their operands on the stack and pop them. */
const QUAD_OPERATIONS = new Map([
    ['allmul', I64.mul], ['alldiv', I64.divS], ['aulldiv', I64.divU], ['allrem', I64.remS],
    ['aullrem', I64.remU], ['alldvrm', I64.divS], ['aulldvrm', I64.divU],
]);

/**
 * The compiler's own helpers of 32-bit code: quadword arithmetic on two
 * operands it pops (`ret 16`), edx:eax the result -- and for the divide and
 * remainder helpers ebx:ecx the remainder; quadword shifts of edx:eax by cl,
 * the whole of cl counted; and `__chkstk`, which moves esp down by eax past
 * the call's return. A divide by zero, and a signed divide of the least
 * quadword by -1 (whose quotient the helper's own unsigned way answers and
 * wasm traps on), make the call as it was, as does a stack not open the
 * whole way down.
 *
 * @param {E} e @param {Instruction} instruction
 */
function helper32(e, instruction){
    const { b } = e;
    const operation = String(instruction.crt);
    const eax = registerLocal(e, RAX);
    const edx = registerLocal(e, RDX);
    const esp = registerLocal(e, ESP);
    /** edx:eax from the i64 on the stack. */
    const resultInEdxEax = ()=>{
        b.localTee(Local.t64).op(I64.wrap).localSet(eax);
        b.localGet(Local.t64).i64const(32n).op(I64.shrU).op(I64.wrap).localSet(edx);
    };
    /** The quadword at [esp + offset]. @param {number} offset */
    const quad = offset=>b.localGet(esp).load('i64', { guest: true,
        offset: e.layout.ramBase + offset });
    const arithmetic = QUAD_OPERATIONS.get(operation);
    if (arithmetic !== undefined)
    {
        const divides = arithmetic !== I64.mul;
        b.i32const(0).localSet(Local.addr);
        if (divides)
        {
            quad(8).op(I64.eqz);
            if (operation === 'alldiv' || operation === 'alldvrm')
            {
                quad(0).i64const(-(1n << 63n)).op(I64.eq);
                quad(8).i64const(-1n).op(I64.eq).op(I32.and).op(I32.or);
            }
            b.if(EMPTY);
            b.i32const(-1).localSet(Local.addr);
            b.end();
            leaveUnless(e, instruction);
        }
        if (operation === 'alldvrm' || operation === 'aulldvrm')
        {
            quad(0);
            quad(8);
            b.op(operation === 'alldvrm' ? I64.remS : I64.remU).localTee(Local.t64b)
                .op(I64.wrap).localSet(registerLocal(e, RCX));
            b.localGet(Local.t64b).i64const(32n).op(I64.shrU).op(I64.wrap)
                .localSet(registerLocal(e, RBX));
        }
        quad(0);
        quad(8);
        b.op(arithmetic);
        resultInEdxEax();
        b.localGet(esp).i32const(16).op(I32.add).localSet(esp);
        return true;
    }
    if (operation === 'allshl' || operation === 'allshr' || operation === 'aullshr')
    {
        // edx:eax, and the count: cl whole, 64 and past it all out.
        b.localGet(edx).op(I64.extendU).i64const(32n).op(I64.shl)
            .localGet(eax).op(I64.extendU).op(I64.or).localSet(Local.t64);
        b.localGet(registerLocal(e, RCX)).i32const(0xff).op(I32.and).localSet(Local.t0);
        b.localGet(Local.t64);
        b.localGet(Local.t0).i32const(63).localGet(Local.t0).i32const(63).op(I32.ltU).select()
            .op(I64.extendU);
        b.op(operation === 'allshl' ? I64.shl : operation === 'allshr' ? I64.shrS : I64.shrU);
        if (operation !== 'allshr')
        {
            // 63 is a shift too few for a count past it: nothing is left.
            b.i64const(0n).localGet(Local.t0).i32const(64).op(I32.ltU).select();
        }
        resultInEdxEax();
        // A count from 32 to 63 the helper takes as cl & 31, which it leaves in cl.
        b.localGet(Local.t0).i32const(32).op(I32.sub).i32const(32).op(I32.ltU);
        b.if(EMPTY);
        b.localGet(registerLocal(e, RCX)).i32const(~0xe0).op(I32.and)
            .localSet(registerLocal(e, RCX));
        b.end();
        return true;
    }
    if (operation === 'chkstk')
    {
        // The stack from esp less eax to esp open: else the helper's own probe.
        b.localGet(esp).localGet(eax).op(I32.sub).localSet(Local.t0);
        b.localGet(eax).localSet(Local.t2);
        b.i32const(0).localSet(Local.addr);
        b.localGet(eax).localGet(esp).op(I32.gtU);
        b.if(EMPTY);
        b.i32const(-1).localSet(Local.addr);
        b.end();
        span(e, Local.t0, PageFlag.INACCESSIBLE);
        leaveUnless(e, instruction);
        b.localGet(Local.t0).localSet(esp);
        // eax: the call's return address, as the helper leaves it.
        b.i32const((instruction.eip + instruction.length) | 0).localSet(eax);
        return true;
    }
    return false;
}

/**
 * Long mode's `__chkstk`: the stack rax bytes below rsp at the call already
 * the thread's (`rsp - rax`, 0 past the bottom, not below the thread block's
 * StackLimit at gs:[0x10]), it does nothing a program sees -- the registers it
 * saves it puts back, under rsp where the call left its return address. A
 * stack to grow is the function's own to probe, page by page: then, or where
 * the thread block's limit cannot be read, the call is made as it was.
 *
 * @param {E} e @param {Instruction} instruction
 */
function chkstk64(e, instruction){
    const { b } = e;
    const flags = pageFlagsAt(e.layout);
    const rsp = registerLocal(e, ESP);
    const rax = registerLocal(e, RAX);
    b.i32const(0).localSet(Local.addr);
    // The limit's address, in RAM and its quadword in an open page.
    atState(e.context, b).load('i64', { offset: /** @type {number} */ (e.layout.gsBase) })
        .i64const(0x10n).op(I64.add).localTee(Local.t64)
        .i64const(BigInt(e.layout.ramSize - 8)).op(I64.gtU);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.else();
    for (const delta of [0n, 7n])
    {
        b.localGet(Local.t64).i64const(delta).op(I64.add).i64const(12n).op(I64.shrU).op(I64.wrap)
            .load('i32_8u', { offset: flags }).i32const(PageFlag.INACCESSIBLE).op(I32.and)
            .localGet(Local.addr).op(I32.or).localSet(Local.addr);
    }
    b.localGet(Local.addr);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.else();
    // rsp - rax, or 0 where rax is past rsp, below the limit: to grow.
    b.i64const(0n).localGet(rsp).localGet(rax).op(I64.sub)
        .localGet(rax).localGet(rsp).op(I64.gtU).select();
    b.localGet(Local.t64);
    if (isWide(e))
    {
        b.load('i64', { memory: e.layout.ramMemory });
    }
    else
    {
        b.op(I64.wrap).load('i64', { guest: true, offset: e.layout.ramBase });
    }
    b.op(I64.ltU);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.end();
    b.end();
    b.end();
    leaveUnless(e, instruction);
    return true;
}

/**
 * The locals a comparison's or search's two pointers are walked in: t0 and
 * t1, or in a wide window the i64 t64 and t64b.
 * @param {E} e @returns {[number, number]}
 */
const walkers = e=>(isWide(e) ? [Local.t64, Local.t64b] : [Local.t0, Local.t1]);

/**
 * The argument `index` taken as a pointer into `local` (`walkers`): a wide
 * window's register whole.
 * @param {E} e @param {number} index @param {number} local
 */
function pointerArgument(e, index, local){
    if (isWide(e))
    {
        e.b.localGet(registerLocal(e, [RCX, RDX][index])).localSet(local);
    }
    else
    {
        argument(e, index, local);
    }
}

/** The third argument, a size, into t2; past `CRT_LIMIT` the call is made as it was. @param {E} e */
function sizeArgument(e){
    const { b } = e;
    if (isWide(e))
    {
        const n = registerLocal(e, R8);
        b.localGet(n).op(I64.wrap).localSet(Local.t2);
        b.localGet(n).i64const(BigInt(CRT_LIMIT)).op(I64.gtU);
    }
    else
    {
        argument(e, 2, Local.t2);
        b.localGet(Local.t2).i32const(CRT_LIMIT).op(I32.gtU);
    }
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.end();
}

/**
 * Pushes 1 where the byte at the guest address in `local` (`walkers`) is past
 * RAM or in a closed page.
 * @param {E} e @param {number} local
 */
function closedAt(e, local){
    const { b } = e;
    const ops = isWide(e) ? I64 : I32;
    b.localGet(local);
    constant(e, e.layout.ramSize);
    b.op(ops.geU).localGet(local);
    constant(e, 12);
    b.op(ops.shrU);
    if (isWide(e))
    {
        b.op(I64.wrap);
    }
    b.load('i32_8u', { offset: pageFlagsAt(e.layout) })
        .i32const(PageFlag.INACCESSIBLE).op(I32.and).op(I32.or);
}

/**
 * Pushes 1 at the first byte and at each page's of the bytes at `locals`
 * (`walkers`), the t2-th of them: where the pages are to be tested again.
 * @param {E} e @param {number[]} locals
 */
function pageStart(e, locals){
    const { b } = e;
    b.localGet(Local.t2).op(I32.eqz);
    for (const local of locals)
    {
        b.localGet(local);
        if (isWide(e))
        {
            b.op(I64.wrap);
        }
        b.i32const(0xfff).op(I32.and).op(I32.eqz).op(I32.or);
    }
}

/** The guest's byte at the address in `local` (`walkers`). @param {E} e @param {number} local */
function byteAt(e, local){
    e.b.localGet(local);
    if (isWide(e))
    {
        e.b.load('i32_8u', { memory: e.layout.ramMemory });
    }
    else
    {
        e.b.load('i32_8u', { guest: true, offset: e.layout.ramBase });
    }
    return e.b;
}

/** The pointer in `local` (`walkers`) one byte on. @param {E} e @param {number} local */
function stepOn(e, local){
    e.b.localGet(local);
    constant(e, 1);
    e.b.op(isWide(e) ? I64.add : I32.add).localSet(local);
}

/**
 * memcmp and strcmp: the bytes at the two pointers compared up to the first
 * that differ -- or, for memcmp, t2 of them, for strcmp to the first zero --
 * the answer -1, 0 or 1 by the first pair's unsigned order. memcmp's spans
 * are tested whole before; strcmp's pages as the bytes reach them, the call
 * made as it was past `CRT_LIMIT` or at a closed page.
 *
 * @param {E} e @param {Instruction} instruction @param {string} operation
 */
function compare(e, instruction, operation){
    const { b } = e;
    const strings = operation === 'strcmp';
    const [one, two] = walkers(e);
    b.i32const(0).localSet(Local.addr);
    pointerArgument(e, 0, one);
    pointerArgument(e, 1, two);
    if (strings)
    {
        b.i32const(0).localSet(Local.t2);
    }
    else
    {
        sizeArgument(e);
        span(e, one, PageFlag.INACCESSIBLE);
        span(e, two, PageFlag.INACCESSIBLE);
        leaveUnless(e, instruction);
        charge(e);
    }
    // pflags: the first pair's difference; count: the first pointer's byte.
    b.i32const(0).localSet(Local.pflags);
    b.block(EMPTY);
    b.loop(EMPTY);
    if (strings)
    {
        pageStart(e, [one, two]);
        b.if(EMPTY);
        closedAt(e, one);
        closedAt(e, two);
        b.op(I32.or).localGet(Local.t2).i32const(CRT_LIMIT).op(I32.geU).op(I32.or);
        b.if(EMPTY);
        b.i32const(-1).localSet(Local.addr);
        b.br(3);
        b.end();
        b.end();
    }
    else
    {
        b.localGet(Local.t2).op(I32.eqz).brIf(1);
    }
    byteAt(e, one).localTee(Local.count);
    byteAt(e, two).op(I32.sub).localTee(Local.pflags).brIf(1);
    if (strings)
    {
        b.localGet(Local.count).op(I32.eqz).brIf(1);
    }
    stepOn(e, one);
    stepOn(e, two);
    b.localGet(Local.t2).i32const(strings ? 1 : -1).op(I32.add).localSet(Local.t2);
    b.br(0);
    b.end();
    b.end();
    if (strings)
    {
        leaveUnless(e, instruction);
        charge(e);
    }
    // The sign: 1, 0 or -1, an int (rax's high half zero).
    b.localGet(Local.pflags).i32const(0).op(I32.gtS)
        .localGet(Local.pflags).i32const(0).op(I32.ltS).op(I32.sub);
    if (isLong(e))
    {
        b.op(I64.extendU);
    }
    b.localSet(registerLocal(e, RAX));
}

/**
 * memchr and strchr: the first byte from the pointer that is the argument's
 * low byte -- among t2 of them (memchr, its span tested whole before), or up
 * to and with the string's zero (strchr, the pages tested as the bytes reach
 * them, the call made as it was past `CRT_LIMIT` or at a closed page) -- its
 * address the answer, else 0.
 *
 * @param {E} e @param {Instruction} instruction @param {string} operation
 */
function find(e, instruction, operation){
    const { b } = e;
    const string = operation === 'strchr';
    const [at] = walkers(e);
    b.i32const(0).localSet(Local.addr);
    pointerArgument(e, 0, at);
    // The argument's low byte, whatever the high half of its register.
    if (isLong(e))
    {
        b.localGet(registerLocal(e, RDX)).op(I64.wrap).localSet(Local.t1);
    }
    else
    {
        argument(e, 1, Local.t1);
    }
    b.localGet(Local.t1).i32const(0xff).op(I32.and).localSet(Local.t1);
    if (string)
    {
        b.i32const(0).localSet(Local.t2);
    }
    else
    {
        sizeArgument(e);
        span(e, at, PageFlag.INACCESSIBLE);
        leaveUnless(e, instruction);
        charge(e);
    }
    // pflags: 1 where found.
    b.i32const(0).localSet(Local.pflags);
    b.block(EMPTY);
    b.loop(EMPTY);
    if (string)
    {
        pageStart(e, [at]);
        b.if(EMPTY);
        closedAt(e, at);
        b.localGet(Local.t2).i32const(CRT_LIMIT).op(I32.geU).op(I32.or);
        b.if(EMPTY);
        b.i32const(-1).localSet(Local.addr);
        b.br(3);
        b.end();
        b.end();
    }
    else
    {
        b.localGet(Local.t2).op(I32.eqz).brIf(1);
    }
    byteAt(e, at).localTee(Local.count).localGet(Local.t1).op(I32.eq)
        .localTee(Local.pflags).brIf(1);
    if (string)
    {
        b.localGet(Local.count).op(I32.eqz).brIf(1);
    }
    stepOn(e, at);
    b.localGet(Local.t2).i32const(string ? 1 : -1).op(I32.add).localSet(Local.t2);
    b.br(0);
    b.end();
    b.end();
    if (string)
    {
        leaveUnless(e, instruction);
        charge(e);
    }
    b.localGet(at);
    constant(e, 0);
    b.localGet(Local.pflags).select().localSet(at);
    result(e, at);
}

/** Whether the region is long mode's. @param {E} e */
const isLong = e=>e.width.bits === 64;

/**
 * Whether the region is a wide window's (`wideLayout`): its pointers are the
 * whole i64 registers, the RAM a `memory64` memory of its own.
 * @param {E} e
 */
const isWide = e=>e.layout.window !== undefined;

/** What a wide window forms: the operations on its RAM, not the 32-bit helpers. */
const WIDE_OPERATIONS = new Set(['memmove', 'memcpy', 'memset', 'strlen', 'chkstk64', 'memcmp',
    'strcmp', 'memchr', 'strchr']);

/**
 * The locals the destination and the source (or the string) are read from:
 * t0 and t1, or in a wide window rcx and rdx themselves, i64.
 * @param {E} e @returns {[number, number]}
 */
const pointers = e=>(isWide(e) ? [registerLocal(e, RCX), registerLocal(e, RDX)]
    : [Local.t0, Local.t1]);

/** The size in t2 as the memory's addresses are: i64 in a wide window. @param {E} e */
function size(e){
    e.b.localGet(Local.t2);
    if (isWide(e))
    {
        e.b.op(I64.extendU);
    }
}

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

/**
 * The three arguments in t0, t1 and t2; `Local.addr` 0 unless one cannot be
 * taken. A wide window's pointers stay in rcx and rdx (`pointers`), its size
 * in t2 where it is within `CRT_LIMIT`. With `value`, the second is an int
 * (memset's byte), whose register's high half is no part of it.
 *
 * @param {E} e @param {boolean} [value]
 */
function arguments3(e, value = false){
    const { b } = e;
    b.i32const(0).localSet(Local.addr);
    if (isWide(e))
    {
        const n = registerLocal(e, R8);
        b.localGet(n).op(I64.wrap).localSet(Local.t2);
        b.localGet(n).i64const(BigInt(CRT_LIMIT)).op(I64.gtU);
        b.if(EMPTY);
        b.i32const(-1).localSet(Local.addr);
        b.end();
        return;
    }
    argument(e, 0, Local.t0);
    if (value && isLong(e))
    {
        b.localGet(registerLocal(e, RDX)).op(I64.wrap).localSet(Local.t1);
    }
    else
    {
        argument(e, 1, Local.t1);
    }
    argument(e, 2, Local.t2);
}

/**
 * Tests the spans of a copy or fill, setting `Local.addr` to -1 where the
 * call is to be made as it was: the source `[t1, t1 + t2)` accessible, the
 * destination `[t0, t0 + t2)` too, both in RAM, the size within `CRT_LIMIT`,
 * for `memcpy` the two apart -- and where a page of the destination holds
 * translated code or is watched, the span tested to the granule (`spanHit`),
 * which marks a watched page written as a store to it does: only a span
 * reaching code itself makes the call.
 *
 * @param {E} e @param {string} operation @param {number} dst @param {number} src
 */
function spans(e, operation, dst, src){
    const { b } = e;
    const ops = isWide(e) ? I64 : I32;
    b.localGet(Local.t2).i32const(CRT_LIMIT).op(I32.gtU);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.end();
    if (operation === 'memcpy')
    {
        // Apart: dst - src >=u n and src - dst >=u n.
        b.localGet(dst).localGet(src).op(ops.sub);
        size(e);
        b.op(ops.ltU);
        b.localGet(src).localGet(dst).op(ops.sub);
        size(e);
        b.op(ops.ltU);
        b.op(I32.or);
        b.if(EMPTY);
        b.i32const(-1).localSet(Local.addr);
        b.end();
    }
    if (operation !== 'memset')
    {
        span(e, src, PageFlag.INACCESSIBLE);
    }
    b.i32const(0).localSet(Local.pflags);
    span(e, dst, PageFlag.INACCESSIBLE, true);
    // The destination's pages held code or a watch: tested to the granule.
    b.localGet(Local.addr).i32const(-1).op(I32.ne)
        .localGet(Local.pflags).i32const(STORE_FLAGS).op(I32.and).i32const(0).op(I32.ne)
        .op(I32.and);
    b.if(EMPTY);
    b.localGet(dst).localGet(dst);
    size(e);
    b.op(ops.add);
    constant(e, 1);
    b.op(ops.sub).call(e.context.spanHit);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.end();
    b.end();
}

/**
 * `[pointer, pointer + t2)`'s pages tested for `bits`, unless `Local.addr` is
 * already -1, which it is set to when one has any or the span leaves RAM. A
 * span of no bytes is plain. With `collect`, every page's flags are or'd
 * into `Local.pflags`. The pointer is i64 in a wide window (`pointers`).
 *
 * @param {E} e @param {number} pointer @param {number} bits @param {boolean} [collect]
 */
function span(e, pointer, bits, collect = false){
    const { b } = e;
    const table = pageFlagsAt(e.layout);
    const { ramSize } = e.layout;
    const ops = isWide(e) ? I64 : I32;
    /** The page of the pointer, or of the span's last byte. @param {boolean} last */
    const page = last=>{
        b.localGet(pointer);
        if (last)
        {
            size(e);
            b.op(ops.add);
            constant(e, 1);
            b.op(ops.sub);
        }
        constant(e, 12);
        b.op(ops.shrU);
        if (isWide(e))
        {
            b.op(I64.wrap);
        }
    };
    b.localGet(Local.addr).i32const(-1).op(I32.ne)
        .localGet(Local.t2).i32const(0).op(I32.ne).op(I32.and);
    b.if(EMPTY);
    // In RAM: pointer <=u ramSize and t2 <=u ramSize - pointer.
    b.localGet(pointer);
    constant(e, ramSize);
    b.op(ops.gtU);
    size(e);
    constant(e, ramSize);
    b.localGet(pointer).op(ops.sub).op(ops.gtU)
        .op(I32.or);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.else();
    page(false);
    b.localSet(Local.addr);
    b.block(EMPTY);
    b.loop(EMPTY);
    if (collect)
    {
        b.localGet(Local.addr).load('i32_8u', { offset: table })
            .localGet(Local.pflags).op(I32.or).localSet(Local.pflags);
    }
    b.localGet(Local.addr).load('i32_8u', { offset: table }).i32const(bits).op(I32.and);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.br(2);
    b.end();
    // The last page: (pointer + t2 - 1) >> 12.
    b.localGet(Local.addr);
    page(true);
    b.op(I32.eq).brIf(1);
    b.localGet(Local.addr).i32const(1).op(I32.add).localSet(Local.addr);
    b.br(0);
    b.end();
    b.end();
    b.end();
    b.end();
}

/**
 * The length of the string at `string` into t1, its bytes read up to the
 * first zero; `Local.addr` -1 where a page it reaches is inaccessible or past
 * RAM, or it runs past `CRT_LIMIT`. A wide window's string is at an i64
 * address, its byte's address kept in t64.
 *
 * @param {E} e @param {number} string
 */
function length(e, string){
    const { b } = e;
    const table = pageFlagsAt(e.layout);
    const { ramBase, ramSize } = e.layout;
    const wide = isWide(e);
    const ops = wide ? I64 : I32;
    const at = wide ? Local.t64 : Local.t2;
    b.i32const(0).localSet(Local.t1);
    b.localGet(Local.addr).i32const(-1).op(I32.ne);
    b.if(EMPTY);
    b.block(EMPTY);
    b.loop(EMPTY);
    // The byte's address, t1 past the string's.
    b.localGet(string).localGet(Local.t1);
    if (wide)
    {
        b.op(I64.extendU);
    }
    b.op(ops.add).localSet(at);
    // At the string's first byte and at each page's: the page tested.
    b.localGet(Local.t1).i32const(0).op(I32.eq)
        .localGet(at);
    if (wide)
    {
        b.op(I64.wrap);
    }
    b.i32const(0xfff).op(I32.and).i32const(0).op(I32.eq).op(I32.or);
    b.if(EMPTY);
    b.localGet(at);
    constant(e, ramSize);
    b.op(ops.geU)
        .localGet(Local.t1).i32const(CRT_LIMIT).op(I32.geU).op(I32.or)
        .localGet(at);
    constant(e, 12);
    b.op(ops.shrU);
    if (wide)
    {
        b.op(I64.wrap);
    }
    b.load('i32_8u', { offset: table })
        .i32const(PageFlag.INACCESSIBLE).op(I32.and).op(I32.or);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.br(3);
    b.end();
    b.end();
    b.localGet(at);
    if (wide)
    {
        b.load('i32_8u', { memory: e.layout.ramMemory });
    }
    else
    {
        b.load('i32_8u', { guest: true, offset: ramBase });
    }
    b.op(I32.eqz).brIf(1);
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
 * The runtime's flag at `address` (`crtWord`) read: `Local.addr` -1 where it is
 * 0, or its page is closed or past RAM -- the function's own other way.
 *
 * @param {E} e @param {number} address
 */
function flagSet(e, address){
    const { b } = e;
    const page = address >>> 12;
    if (address + 4 > e.layout.ramSize || (address & 0xfff) > 0xffc)
    {
        b.i32const(-1).localSet(Local.addr);
        return;
    }
    b.i32const(0).localSet(Local.addr);
    b.i32const(page).load('i32_8u', { offset: pageFlagsAt(e.layout) })
        .i32const(PageFlag.INACCESSIBLE).op(I32.and);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.else();
    b.i32const(address).load('i32', { guest: true, offset: e.layout.ramBase }).op(I32.eqz);
    b.if(EMPTY);
    b.i32const(-1).localSet(Local.addr);
    b.end();
    b.end();
}

/**
 * floor's and ceil's argument tested: a finite number, or `Local.addr` -1 --
 * an infinity or a NaN is the function's own to answer (`_handle_qnan1`).
 * The `body` after this rounds it with SSE4.1's `roundsd`, which is exact.
 *
 * @param {E} e
 */
function finiteArgument(e){
    const { b } = e;
    b.i32const(0).i32const(-1);
    b.localGet(registerLocal(e, ESP)).load('f64', { guest: true, offset: e.layout.ramBase })
        .op(0x99) // f64.abs
        .f64const(Infinity).op(0x63); // f64.lt: false for a NaN and an infinity
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

/**
 * The RAM's address of the guest address in `local`: a wide window's is the
 * i64 itself, in its own memory.
 * @param {E} e @param {number} local
 */
function guestAddress(e, local){
    e.b.localGet(local);
    if (e.layout.ramBase !== 0)
    {
        e.b.i32const(e.layout.ramBase).op(I32.add);
    }
}

/** A constant as the pointers are: i64 in a wide window. @param {E} e @param {number} value */
function constant(e, value){
    if (isWide(e))
    {
        e.b.i64const(BigInt(value));
    }
    else
    {
        e.b.i32const(value);
    }
}

/** The budget charged a unit for every 16 bytes of t2, a begun one whole. @param {E} e */
function charge(e){
    const { b } = e;
    b.localGet(Local.budget)
        .localGet(Local.t2).i32const((1 << UNIT_SHIFT) - 1).op(I32.add)
        .i32const(UNIT_SHIFT).op(I32.shrU).op(I32.sub).localSet(Local.budget);
}

/**
 * eax (rax) given the pointer in `local`: an i32, or a wide window's i64.
 * @param {E} e @param {number} local
 */
function result(e, local){
    const { b } = e;
    b.localGet(local);
    if (isLong(e) && !isWide(e))
    {
        b.op(I64.extendU);
    }
    b.localSet(registerLocal(e, RAX));
}
