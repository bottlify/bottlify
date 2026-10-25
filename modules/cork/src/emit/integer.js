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
import { SYSTEM_TABLES, cpuidLeaves, topologyOf } from '../cpuid.js';
import { EMPTY, ValType } from '../wasm/encoder.js';
import { I32, Kind, MASKS, SIGN_BITS, widthCode } from './flags.js';
import { CallStack, Exit, Local, STATE_PARAMS } from './region.js';
import { checkAccess, emitStaleExit, looseStackStore, noteStore, stackAccess } from './memory.js';
import { CALL_STRIDE, Mechanism, Tables, pageFlagsAt } from '../runtime/layout.js';
import { PageFlag, STORE_FLAGS } from '../runtime/pages.js';
import { emitSimd } from './simd.js';
import { atState, atTables, intoState, intoTables } from './bases.js';
import { ANY_TOP, slotOf } from '../runtime/entries.js';
import { emitLocked, isLocked } from './locked.js';
import { emitX87, isX87, topAfterCall, x87AfterCall, x87Normalise, x87Reloaded } from './x87.js';

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
 * After the host's handler, which answered 2 (`TRAP_END_TURN`): the region
 * leaves for the host's loop rather than going on in the region a transfer
 * would find for EIP. The handler asked for the turn to end -- a thread of
 * higher priority made ready, the machine halted -- and only the loop can
 * give the processor to anyone else; with budget left, an untranslated exit
 * tail-calls the next region and the thread runs out its quantum instead.
 * The budget given up is not charged as retired (`endBudget`). The answer is
 * in `t1`.
 *
 * @param {any} e
 */
function endTurnIfAsked(e){
    const { b } = e;
    b.localGet(Local.t1).i32const(TRAP_END_TURN).op(I32.eq);
    e.openIf('endTurn');
    e.endBudget();
    e.close();
}

/** What the trap import answers when the turn is to end there. */
export const TRAP_END_TURN = 2;

/**
 * The class a run may leave out: x87, MMX (an mm operand) or SSE (an xmm operand),
 * or '' for the integer core.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
export function classOf(instruction){
    if (isX87(instruction))
    {
        return 'x87';
    }
    if (instruction.operands.some(operand=>operand.kind === 'mm'))
    {
        return 'mmx';
    }
    if (instruction.operands.some(operand=>operand.kind === 'xmm'))
    {
        return 'sse';
    }
    return '';
}

/**
 * An indirect call's address and target into the layout's call profile while
 * the runtime has it on (`callProfile`: a flag, a count, and sixteen calls as
 * pairs), which is how the runtime learns the callees to form into the caller
 * (`callTargets`). About one call in `CALL_STRIDE` is kept, so the sixteen are
 * spread over the last thousand calls rather than the last sixteen: those are
 * the calls just before the slice left for the host, the same few sites every
 * time, and a site deep in the frame was sampled a hundred thousand times
 * less often than one beside a `Present`. Which calls is the count's golden
 * ratio hash, not every n-th: a loop over sixteen objects sampled every
 * sixty-fourth call would see one object only. Off, one load and a branch,
 * at every call: a `quiet` call, sampled enough to know there is nothing to
 * form in, has none. The call's target is in `count`.
 *
 * @param {E} e @param {number} site
 */
function profileCall(e, site){
    if (e.context.profileCalls !== true || e.region.blocks[e.blockIndex].exit.quiet === true)
    {
        return;
    }
    const at = /** @type {number} */ (e.layout.callProfile);
    const { b, context } = e;
    atState(context, b).load('i32', { offset: at });
    e.openIf('profile');
    atState(context, atState(context, b)).load('i32', { offset: at + 4 }).localTee(Local.t1)
        .i32const(1).op(I32.add).store('i32', { offset: at + 4 });
    b.localGet(Local.t1).i32const(0x9e3779b1 | 0).op(I32.mul)
        .i32const(32 - Math.log2(CALL_STRIDE)).op(I32.shrU).op(I32.eqz);
    e.openIf('sampled');
    b.localGet(Local.t1).i32const(Math.log2(CALL_STRIDE)).op(I32.shrU).i32const(15).op(I32.and)
        .i32const(3).op(I32.shl);
    intoState(context, b).localTee(Local.t1)
        .i32const(site | 0).store('i32', { offset: at + 8 });
    b.localGet(Local.t1).localGet(Local.count).store('i32', { offset: at + 12 });
    e.close();
    e.close();
}

/** The `Mechanism` a call out of its region counts by why its callee stayed apart. */
const APART = Object.freeze({
    blocks: Mechanism.APART_BLOCKS, bytes: Mechanism.APART_BYTES, shape: Mechanism.APART_SHAPE,
    nested: Mechanism.APART_NESTED, unpredicted: Mechanism.APART_UNPREDICTED,
});

/**
 * A call out of the block's region, counted by why its callee was not formed
 * in: a predicted call's target none of the callees formed in, or else a
 * callee that would have been, the region full.
 *
 * @param {E} e
 */
function countApart(e){
    const { apart, predicted } = e.region.blocks[e.blockIndex].exit;
    e.countMechanism(apart !== undefined ? APART[apart]
        : predicted === true ? Mechanism.APART_MISSED : Mechanism.APART_FULL);
}

/**
 * A call out of the region as a wasm call (`callReturn`): the return address
 * on the call stack, what the parameters do not carry written back, the
 * module's transfer called -- not tail-called -- with the target, and the
 * region going on after the call, on the budget the `ret` that pops that
 * address left (`CallStack.BUDGET`) when it answers `RETURNED`. The transfer then
 * ran every region in between inside the call, and the host's return stack
 * predicts the way back where the entry hash and its indirect jump did not.
 * Any other answer is an exit the state block already holds: it goes up as it
 * came, this call's entry taken off the stack. Past the module's depth
 * (`callDepth`, the stack's limit at most), or with the budget spent, the call
 * leaves as any call does: every call waiting below it comes back through the
 * entry hash, and the host's stack holds no more than that many calls' frames.
 *
 * With `emptySites`, outside x87 code, the target's first slot in the entry hash
 * is read first: a function that does nothing there (`emptyCode`, the slot's
 * byte 11) is returned from in place -- the address just pushed popped, with
 * the bytes its `ret` pops, and its instructions charged -- with nothing
 * written back and no transfer called. A target held further along the probe
 * goes through the transfer, which returns from it as well (`finishModule`).
 *
 * A direct call's target is known here, and so is the first slot of the entry
 * hash its address takes (`slotOf`): where that slot holds the target for the
 * machine's top and not a function that does nothing -- what the transfer
 * would take at its first look and call the same way -- its function is called
 * from here, with the slot's label, and the transfer's hashing and probe are
 * not run (`linkedCall`, unless `linkedCalls` is off). Anything else goes
 * through the transfer as before.
 *
 * @param {import('./region.js').RegionEmitter} e
 * @param {number} next  the return address, a block of the region
 * @param {number | null} target  a direct call's callee, null for one held in `count`
 * @param {number} mechanism  what a profiling run counts it as (`Mechanism`)
 */
function callAndReturn(e, next, target, mechanism){
    const { b, layout, context } = e;
    const depth = layout.regs + CallStack.DEPTH;
    e.countMechanism(mechanism);
    countApart(e);
    e.charge();
    if (target === null)
    {
        b.localGet(Local.count);
    }
    else
    {
        b.i32const(target | 0);
    }
    b.localSet(Local.eip);
    if (e.staleCheck)
    {
        // The push stored into a page holding code: leave at the callee, as a
        // call that leaves by itself does.
        e.staleCheck = false;
        b.localGet(Local.stale);
        e.openGuard('stale');
        e.exitDynamic(Exit.STALE);
        e.close();
    }
    const site = e.context.emptySites === true && !e.x87.active;
    if (site)
    {
        const hash = layout.tables + Tables.HASH;
        b.localGet(Local.eip).i32const(0x9e3779b1 | 0).op(I32.mul)
            .i32const(layout.hashShift ?? 16).op(I32.shrU).i32const(Tables.HASH_SLOT).op(I32.mul);
        intoTables(context, b).localTee(Local.t1).load('i32_8u', { offset: hash + 11 });
        b.i32const(0);
        b.localGet(Local.t1).load('i32', { offset: hash }).localGet(Local.eip).op(I32.eq);
        b.select().localTee(Local.t1);
        e.openIf('empty');
        e.countMechanism(Mechanism.EMPTY_SITE);
        // The low six bits are the dwords popped plus one, the top two the jumps before the `ret`.
        b.localGet(Local.reg + 4).localGet(Local.t1).i32const(63).op(I32.and).i32const(2)
            .op(I32.shl).op(I32.add).localSet(Local.reg + 4);
        b.localGet(Local.budget).localGet(Local.t1).i32const(6).op(I32.shrU).i32const(1)
            .op(I32.add).op(I32.sub).localSet(Local.budget);
        b.else();
    }
    atState(context, b).load('i32', { offset: depth }).localTee(Local.t1)
        .i32const(context.callDepth ?? CallStack.LIMIT).op(I32.geU)
        .localGet(Local.budget).i32const(0).op(I32.leS).op(I32.or);
    e.openGuard('plain');
    e.exitDynamic(Exit.UNTRANSLATED);
    e.close();
    b.localGet(Local.t1).i32const(2).op(I32.shl);
    intoState(context, b).i32const(next)
        .store('i32', { offset: layout.regs + CallStack.STACK });
    atState(context, b).localGet(Local.t1).i32const(1).op(I32.add)
        .store('i32', { offset: depth });
    // What the callee does not take in its parameters goes through the state
    // block; the count is left alone, the callee answering what is left of
    // the budget when it returns.
    const top = topAfterCall(e.region.blocks[/** @type {number} */ (e.labels.get(next))],
        e.x87.current?.top ?? 0);
    if (e.x87.active)
    {
        x87Normalise(e);
    }
    // What the block wrote so far: the stores wait for the whole body, and a
    // local no way to this call wrote since the state block last held it is
    // left out (`fillDeferred`).
    const call = e.b.written === null ? undefined
        : { block: e.blockIndex, written: new Set(e.b.written), empty: site };
    if (call !== undefined)
    {
        e.callSites.set(e.blockIndex, call);
    }
    e.storeMemoryState(call);
    e.storeUncarriedState(call);
    // An empty slot's key is 0 and a removed one's all ones: a call to either
    // address would take such a slot for its own.
    if (target !== null && target !== 0 && target >>> 0 !== 0xffffffff
        && context.placed === undefined && context.linkedCalls !== false)
    {
        linkedCall(e, target);
    }
    else
    {
        b.localGet(Local.eip);
        for (let local = Local.budget; local < STATE_PARAMS; local++)
        {
            b.localGet(local);
        }
        b.call(/** @type {number} */ (e.context.transfer));
    }
    b.localTee(Local.t0).i32const(Exit.RETURNED).op(I32.ne);
    e.openGuard('elsewhere');
    e.countMechanism(Mechanism.CALL_ELSEWHERE);
    // Left for the host somewhere inside: the state block holds it all.
    atState(context, b).localGet(Local.t1).store('i32', { offset: depth });
    b.localGet(Local.t0).return();
    e.close();
    atState(context, b).load('i32', { offset: layout.regs + CallStack.BUDGET })
        .localSet(Local.budget);
    e.loadState();
    if (e.x87.active)
    {
        x87AfterCall(e, next, top);
    }
    if (site)
    {
        e.close();
    }
    b.i32const(next).localSet(Local.eip);
    e.returned = true;
}

/**
 * A direct call's wasm call, the parameters and the state block as the
 * transfer takes them: the first slot of the target's address read, and where
 * it holds the target compiled for any top or for the one the machine has,
 * and not as a function that does nothing, the slot's function called through
 * the table with the slot's label, as the transfer would call it at its first
 * look. Anything else -- a slot that holds another address or none, an entry
 * compiled for another top, a function that does nothing -- goes through the
 * transfer, out of the way, which looks further and answers each of those as
 * before. Leaves the call's answer on the stack.
 *
 * @param {E} e @param {number} target
 */
function linkedCall(e, target){
    const { b, layout, context } = e;
    const slot = layout.tables + Tables.HASH
        + slotOf(target, layout.hashShift ?? 16) * Tables.HASH_SLOT;
    // The index, the label, the top and the empty code in one word, the call
    // taking two of them: with an empty code of 0 the top two bytes are the top.
    intoTables(context, b.i32const(slot)).localTee(Local.t2)
        .load('i64', { offset: 4, align: 2 }).localTee(Local.t64)
        .i64const(48n).op(I64.shrU).op(I64.wrap).localTee(Local.t0);
    b.i32const(ANY_TOP).op(I32.eq).localGet(Local.t0);
    atState(context, b).load('i32_8u', { offset: layout.x87Top });
    b.op(I32.eq).op(I32.or);
    b.localGet(Local.t2).load('i32').i32const(target | 0).op(I32.eq).op(I32.and).op(I32.eqz);
    e.openGuard('unlinked', ValType.i32);
    b.localGet(Local.eip);
    for (let local = Local.budget; local < STATE_PARAMS; local++)
    {
        b.localGet(local);
    }
    b.call(/** @type {number} */ (context.transfer));
    b.else();
    e.countMechanism(Mechanism.CALL_LINKED);
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && context.countTransfers)
    {
        // Counted as the transfer it stands in for.
        const at = layout.tables + Tables.TRANSFERS;
        atTables(context, atTables(context, b)).load('i32', { offset: at }).i32const(1)
            .op(I32.add).store('i32', { offset: at });
    }
    b.localGet(Local.t64).i64const(32n).op(I64.shrU).op(I64.wrap).i32const(0xffff).op(I32.and);
    for (let local = Local.budget; local < STATE_PARAMS; local++)
    {
        b.localGet(local);
    }
    b.localGet(Local.t64).op(I64.wrap);
    b.callIndirect(context.regionType, 0);
    e.close();
}

/**
 * A `ret` whose address is the one the innermost call made as a wasm call
 * waits at: that entry off the stack, and the region answers `RETURNED` and
 * what is left of the budget, the registers back in the state block, for the
 * caller to go on.
 *
 * @param {import('./region.js').RegionEmitter} e
 */
function returnToCall(e){
    const { b, layout, context } = e;
    const depth = layout.regs + CallStack.DEPTH;
    atState(context, b).load('i32', { offset: depth }).localTee(Local.t1);
    e.openIf('called');
    b.localGet(Local.t1).i32const(2).op(I32.shl);
    intoState(context, b).load('i32', { offset: layout.regs + CallStack.STACK - 4 })
        .localGet(Local.eip).op(I32.eq);
    e.openIf('returns');
    e.countMechanism(Mechanism.RET_TO_CALL);
    atState(context, b).localGet(Local.t1).i32const(1).op(I32.sub)
        .store('i32', { offset: depth });
    e.returnToCaller();
    e.close();
    e.close();
}

/**
 * An indirect call whose callees the runtime predicted, with the ones formed
 * into the region: the target compared with each, a match a jump to the
 * callee's block -- the return address is pushed, and the callee's `ret`
 * comes back to the block after the call as a direct call's does
 * (`inlineReturns`). Anything else leaves as before. Charged once here, at
 * the block's depth, for every way out below; a push into a code page leaves
 * `stale` before any of it.
 *
 * @param {E} e
 */
function predictCall(e){
    const { exit } = e.region.blocks[e.blockIndex];
    const callees = exit.kind === 'indirect' && exit.predicted
        ? exit.targets.filter(target=>e.labels.has(target)) : [];
    if (callees.length === 0)
    {
        return;
    }
    const { b } = e;
    e.charge();
    if (e.staleCheck)
    {
        b.localGet(Local.stale).op(I32.eqz);
        e.openIf('clean');
    }
    for (const callee of callees)
    {
        b.localGet(Local.count).i32const(callee | 0).op(I32.eq);
        e.openIf('predicted');
        e.countMechanism(Mechanism.CALL_PREDICTED);
        e.jumpTo(callee);
        e.close();
    }
    if (e.staleCheck)
    {
        e.close();
    }
}

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
    if (e.context.leaveOut.size > 0 && e.context.leaveOut.has(classOf(instruction)))
    {
        // Left to the other executor by the run's configuration.
        return false;
    }
    if (instruction.prefixes.address && instruction.memory && !instruction.op.startsWith('lea'))
    {
        // 16-bit addressing outside `lea` is rare in 32-bit code and not worth
        // a wrapped address path here.
        return false;
    }
    if (e.context.atomic === true && isLocked(instruction))
    {
        return emitLocked(e, instruction, flagsLive);
    }
    switch (op)
    {
        case 'nop': case 'fwait': case 'fnop': case 'prefetch': case 'prefetchw':
        case 'prefetchnta': case 'prefetcht0': case 'prefetcht1': case 'prefetcht2':
        case 'lfence': case 'mfence': case 'sfence': case 'pause':
            return true;
        // The emulator's decoder consumes BOUND and neither checks the bounds
        // nor raises #BR, so translated code does the same. A guest that runs
        // data (a return into the entry vector) reaches it and must go on.
        case 'bound':
            return true;
        case 'hlt':
            e.exitAt(next, Exit.HALT);
            e.dead = true;
            return true;
        case 'xlat':
        {
            // AL = [EBX + AL], through DS unless an fs: override says
            // otherwise (the address-size form is refused above, as every
            // 16-bit memory form is).
            b.localGet(Local.reg + 3);
            b.localGet(Local.reg).i32const(0xff).op(I32.and).op(I32.add);
            if (instruction.operands[0].segment === 4)
            {
                atState(e.context, b).load('i32', { offset: e.layout.fsBase }).op(I32.add);
            }
            b.localSet(Local.addr);
            checkAccess(e, 1);
            b.localGet(Local.reg).i32const(0xffffff00).op(I32.and);
            b.localGet(Local.addr).load('i32_8u', { offset: e.layout.ramBase }).op(I32.or);
            b.localSet(Local.reg);
            return true;
        }
        case 'cpuid':
        {
            if (e.context.stateBase !== undefined)
            {
                // Under the shared layout one translation runs on every
                // executor, and each is a processor of its own (its APIC id):
                // the interpreter answers, with the executor's own layout.
                return false;
            }
            // The leaves the pinned emulator answers, as constants -- with the
            // processors of the executor the code is translated for, whose
            // layout it is -- and a leaf with no entry answers four zeros. The
            // leaf in eax and the subleaf in ecx are saved before the four
            // registers are cleared and the known ones set.
            b.localGet(Local.reg).localSet(Local.t1);
            b.localGet(Local.reg + 1).localSet(Local.t2);
            for (let index = 0; index < 4; index++)
            {
                b.i32const(0).localSet(Local.reg + index);
            }
            for (const [leaf, entry] of Object.entries(cpuidLeaves(topologyOf(e.layout))))
            {
                /** @type {[string | null, import('../cpuid.js').CpuidAnswer][]} */
                const answers = 'eax' in entry
                    ? [[null, /** @type {import('../cpuid.js').CpuidAnswer} */ (entry)]]
                    : Object.entries(entry);
                for (const [subleaf, answer] of answers)
                {
                    b.localGet(Local.t1).i32const(Number(leaf)).op(I32.eq);
                    if (subleaf !== null)
                    {
                        b.localGet(Local.t2).i32const(Number(subleaf)).op(I32.eq).op(I32.and);
                    }
                    e.openIf('cpuid', EMPTY);
                    b.i32const(answer.eax).localSet(Local.reg);
                    b.i32const(answer.ecx).localSet(Local.reg + 1);
                    b.i32const(answer.edx).localSet(Local.reg + 2);
                    b.i32const(answer.ebx).localSet(Local.reg + 3);
                    e.close();
                }
            }
            return true;
        }
        case 'sgdt':
        case 'sidt':
        {
            // Six bytes: the limit, then the base.
            const table = instruction.op === 'sgdt' ? SYSTEM_TABLES.gdt : SYSTEM_TABLES.idt;
            prepare(e, dst);
            noteStore(e, 6);
            b.localGet(Local.addr).i32const(table.limit)
                .store('i32_16', { offset: e.layout.ramBase });
            b.localGet(Local.addr).i32const(table.base | 0)
                .store('i32', { offset: e.layout.ramBase + 2 });
            return true;
        }
        case 'sldt':
        case 'str':
        case 'smsw':
        {
            const value = instruction.op === 'sldt' ? SYSTEM_TABLES.ldt
                : instruction.op === 'str' ? SYSTEM_TABLES.tr : SYSTEM_TABLES.cr0 & 0xffff;
            prepare(e, dst);
            writeOp(e, dst, ()=>b.i32const(value));
            return true;
        }
        case 'rdtsc':
            // The time-stamp counter, read through the host's import (the
            // emulator's own under hybrid, cork's clock under cork): the low
            // word to eax, the high word to edx.
            e.countMechanism(Mechanism.RDTSC);
            b.call(e.context.rdtsc).localSet(Local.t64);
            b.localGet(Local.t64).op(I64.wrap).localSet(Local.reg);
            b.localGet(Local.t64).i64const(32n).op(I64.shrU).op(I64.wrap)
                .localSet(Local.reg + 2);
            return true;
        case 'mov':
            if (dst.kind === 'seg')
            {
                // Flat segments: a load of a segment register changes no base
                // this engine keeps (fs's is the thread block's, set by the
                // host), and the selector reads back as the constant below.
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
            if (dst.kind === 'mem')
            {
                prepare(e, dst, { store: true });
            }
            else
            {
                prepare(e, src);
            }
            writeOp(e, dst, ()=>readOp(e, src), src.kind === 'reg' || src.kind === 'mem');
            return true;
        case 'movzx':
            prepare(e, src);
            writeOp(e, dst, ()=>readOp(e, src), true);
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
            writeOp(e, dst, ()=>readOp(e, src), true);
            writeOp(e, src, ()=>b.localGet(Local.t1), true);
            return true;
        case 'add': case 'adc': case 'sub': case 'sbb': case 'cmp': case 'xadd':
            arithmetic(e, instruction, flagsLive);
            return true;
        case 'and': case 'or': case 'xor': case 'test':
            logic(e, instruction, flagsLive);
            return true;
        case 'inc': case 'dec':
        {
            // CF stays: with the flags live the word takes the CF of the record
            // before (the rest the record replaces) and the record takes op1 --
            // nothing between the two leaves; with them dead a pending record
            // (whose CF a later reader may still fold) must keep its operands,
            // so the value goes through a scratch local instead.
            const value = flagsLive ? Local.op1 : Local.t1;
            // Only when CF itself is read before something writes it again.
            if (flagsLive && (e.flagsAfter & CF) !== 0)
            {
                e.carryIntoWord();
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
                // As `mov` to a segment register: the value goes nowhere.
                b.localGet(Local.reg + 4).i32const(size).op(I32.add).localSet(Local.reg + 4);
                return true;
            }
            // The value is read before the increment, and the write comes
            // after it: `pop esp` then holds the value, `pop [esp+x]`
            // addresses with the incremented esp -- folded into the
            // displacement, so the destination is checked before esp moves
            // and a fault on it leaves the pop undone.
            stackAccess(e, dst.size);
            b.localGet(Local.addr)
                .load(dst.size === 2 ? 'i32_16u' : 'i32', { offset: e.layout.ramBase })
                .localSet(Local.t1);
            if (dst.kind === 'mem')
            {
                prepare(e, dst.base === 4 ? { ...dst, disp: ((dst.disp ?? 0) + dst.size) | 0 }
                    : dst, { store: true });
                writeOp(e, dst, ()=>b.localGet(Local.t1));
                b.localGet(Local.reg + 4).i32const(dst.size).op(I32.add).localSet(Local.reg + 4);
                return true;
            }
            b.localGet(Local.reg + 4).i32const(dst.size).op(I32.add).localSet(Local.reg + 4);
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
            // As the model's: NT, AC and ID too, which the 386, 486 and CPUID
            // probes flip; the word form writes the low sixteen bits alone.
            const writable = (0xcd5 | DF | 1 << 11 | 1 << 14 | 1 << 18 | 1 << 21)
                & (size === 2 ? 0xffff : -1);
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
        // The four below write flags and nothing else, so with none of theirs read
        // they emit nothing: a write of some flags folds the record into the word first.
        case 'sahf':
            if (!flagsLive)
            {
                return true;
            }
            e.eagerWrite(0xd5);
            b.localGet(Local.reg).i32const(8).op(I32.shrU).i32const(0xd5).op(I32.and)
                .localGet(Local.flags).op(I32.or).localSet(Local.flags);
            return true;
        case 'clc':
            if (flagsLive)
            {
                e.eagerWrite(CF);
            }
            return true;
        case 'stc':
            if (!flagsLive)
            {
                return true;
            }
            e.eagerWrite(CF);
            b.i32const(1);
            e.orFlag(CF);
            return true;
        case 'cmc':
            if (!flagsLive)
            {
                return true;
            }
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
            switchCases(e);
            e.exitDynamic(Exit.UNTRANSLATED);
            e.dead = true;
            return true;
        case 'call':
            if (dst.kind !== 'rel')
            {
                // The target is read before the push moves esp (`call [esp+8]`
                // names the caller's frame) and held in a local the push does
                // not use: `count` is a shift's or a string instruction's own
                // and free between instructions; t2 is the push's scratch.
                prepare(e, dst);
                readOp(e, dst);
                b.localSet(Local.count);
            }
            push(e, 4, ()=>b.i32const(next));
            if (dst.kind === 'rel' && dst.target === next && !instruction.prefixes.operand)
            {
                // `call $+5`: the push, and the block goes on (`exitOf`).
                return true;
            }
            if (dst.kind === 'rel' && e.labels.has(/** @type {number} */ (dst.target)))
            {
                // The callee is a block of this region: the block's exit jumps
                // there. A push into code leaves first, at the callee.
                e.countMechanism(Mechanism.CALL_FORMED);
                if (e.staleCheck)
                {
                    e.staleCheck = false;
                    emitStaleExit(e, /** @type {number} */ (dst.target));
                }
                return true;
            }
            if (e.callReturn && e.labels.has(next)
                && !(dst.kind !== 'rel' && e.region.blocks[e.blockIndex].exit.predicted)
                && (!e.x87.active || e.x87.current !== null))
            {
                if (dst.kind !== 'rel')
                {
                    profileCall(e, instruction.eip);
                }
                callAndReturn(e, next,
                    dst.kind === 'rel' ? /** @type {number} */ (dst.target) : null,
                    dst.kind === 'rel' ? Mechanism.CALL_REL : Mechanism.CALL_INDIRECT);
                return true;
            }
            if (dst.kind === 'rel')
            {
                e.countMechanism(Mechanism.CALL_LEFT);
                countApart(e);
                e.exitAt(/** @type {number} */ (dst.target), Exit.UNTRANSLATED);
            }
            else
            {
                // Sampled past the prediction: a call it takes costs nothing more,
                // and the samples are the calls that still leave.
                predictCall(e);
                profileCall(e, instruction.eip);
                e.countMechanism(Mechanism.CALL_LEFT);
                countApart(e);
                b.localGet(Local.count).localSet(Local.eip);
                e.exitDynamic(Exit.UNTRANSLATED);
            }
            e.dead = true;
            return true;
        case 'ret':
            stackAccess(e, 4);
            b.localGet(Local.addr).load('i32', { offset: e.layout.ramBase }).localSet(Local.eip);
            b.localGet(Local.reg + 4).i32const(4 + (dst ? /** @type {number} */ (dst.value) : 0))
                .op(I32.add).localSet(Local.reg + 4);
            // Back to a call of this region whose callee it formed in: a jump.
            // Charged once, here at the block's depth, for every way out below:
            // a charge inside the `if` left the block's count standing, and the
            // jump's own budget or untranslated exit charged it a second time
            // (+2 a spent budget for `inc edx; ret`).
            e.charge();
            for (const at of e.returns.get(e.region.blocks[e.blockIndex].start) ?? [])
            {
                b.localGet(Local.eip).i32const(at).op(I32.eq);
                e.openIf('return');
                e.countMechanism(Mechanism.RET_FORMED);
                e.jumpTo(at);
                e.close();
            }
            if (e.context.callReturn)
            {
                returnToCall(e);
            }
            e.countMechanism(Mechanism.RET_LEFT);
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
            return bitTest(e, instruction, flagsLive);
        case 'bsf': case 'bsr':
            prepare(e, src);
            readOp(e, src);
            b.localSet(Local.t1);
            if (flagsLive)
            {
                e.eagerWrite(ZF);
                b.localGet(Local.t1).op(I32.eqz);
                e.openIf('zero', EMPTY);
                b.localGet(Local.flags).i32const(ZF).op(I32.or).localSet(Local.flags);
                b.op(0x05); // else
            }
            else
            {
                // A zero source leaves the destination as it was.
                b.localGet(Local.t1);
                e.openIf('nonzero', EMPTY);
            }
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
            writeOp(e, dst, ()=>readOp(e, src), true);
            b.op(0x05);
            b.localGet(Local.op2);
            writeReg(e, 0, size, false, true);
            e.close();
            return true;
        case 'movs': case 'stos': case 'lods': case 'cmps': case 'scas':
            return stringInstruction(e, instruction);
        case 'out':
            if (instruction.opcode === 'ef' && src.size === 4 && e.context.trapPort !== undefined)
            {
                // To the trap port: the host's own call channel. The state
                // block is written back complete by the exit, the host runs
                // the handler the port write would have reached, and the
                // program resumes past the instruction -- or wherever the
                // handler put EIP. Any other port is the other executor's.
                b.localGet(Local.reg + 2).i32const(0xffff).op(I32.and)
                    .i32const(e.context.trapPort).op(I32.ne);
                e.openIf('port');
                e.exitBefore(instruction.eip, Exit.UNTRANSLATED);
                e.close();
                // Without the import, or in a region where the x87 and MMX
                // views of the registers meet, the exit past the instruction,
                // which the host answers the same.
                if (e.context.trap === undefined || e.x87.hasMmx)
                {
                    e.exitAt(next, Exit.TRAP);
                    e.dead = true;
                    return true;
                }
                if (e.x87.active)
                {
                    // The x87 registers back in their own locals and written
                    // back with the rest, the handler run, everything taken
                    // back -- and the region leaves for wherever EIP is, past
                    // the write or where the handler moved it: the handler may
                    // have popped or pushed (a double handed back in ST0), and
                    // the code after the write is compiled for the top the
                    // tracker followed. The transfer finds the code for the top
                    // the machine has, where the exit to the host's loop cost
                    // a round of it for every call.
                    e.charge();
                    b.i32const(next).localSet(Local.eip);
                    x87Normalise(e);
                    e.storeState();
                    e.resetRun();
                    b.localGet(Local.reg).call(e.context.trap).localSet(Local.t1);
                    e.loadState();
                    x87Reloaded(e);
                    atState(e.context, b).load('i32', { offset: e.layout.eip }).localSet(Local.eip);
                    endTurnIfAsked(e);
                    e.exitDynamic(Exit.UNTRANSLATED);
                    e.dead = true;
                    return true;
                }
                // From here: the state block written back with EIP past the
                // instruction and the count charged, the host's handler run,
                // the state taken back -- the handler's answer is in it --
                // and the program going on after the write unless the
                // handler moved EIP, in which case the region leaves there.
                e.charge();
                b.i32const(next).localSet(Local.eip);
                e.storeState();
                e.resetRun();
                b.localGet(Local.reg).call(e.context.trap).localTee(Local.t1);
                e.openGuard('moved');
                e.loadState();
                atState(e.context, b).load('i32', { offset: e.layout.eip }).localSet(Local.eip);
                endTurnIfAsked(e);
                e.exitDynamic(Exit.UNTRANSLATED);
                e.close();
                e.loadState();
                e.trapped = true;
                return true;
            }
            return false;
        case 'movnti':
            // A non-temporal store is a store.
            prepare(e, dst);
            writeOp(e, dst, ()=>readOp(e, src));
            return true;
        case 'cmpxchg8b':
            return cmpxchg8b(e, instruction, flagsLive);
        case 'arpl':
        {
            // If the destination selector's RPL is below the source's, it is
            // raised to it and ZF is set; otherwise ZF is clear.
            prepare(e, dst);
            readOp(e, dst);
            b.localSet(Local.t1);
            readOp(e, src);
            b.i32const(3).op(I32.and).localSet(Local.t2);
            e.eagerWrite(ZF);
            b.localGet(Local.t1).i32const(3).op(I32.and).localGet(Local.t2).op(I32.ltU);
            e.openIf('raise', EMPTY);
            writeOp(e, dst, ()=>b.localGet(Local.t1).i32const(~3).op(I32.and)
                .localGet(Local.t2).op(I32.or));
            b.localGet(Local.flags).i32const(ZF).op(I32.or).localSet(Local.flags);
            e.close();
            return true;
        }
        case 'daa': case 'das': case 'aaa': case 'aas': case 'aam': case 'aad':
            return decimal(e, instruction);
        case 'int3': case 'int': case 'into':
            // Left to the other executor, before the instruction: a trap
            // taken past it would be skipped by a host that re-executes the
            // instruction to raise it, and the software interrupt goes
            // through the emulator's own vector table. A trap exit of this
            // engine's own returns with the engine that delivers it.
            e.exitBefore(instruction.eip, Exit.UNTRANSLATED);
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
            if (isX87(instruction))
            {
                return emitX87(e, instruction, flagsLive);
            }
            return emitSimd(e, instruction, flagsLive);
    }
}

// --- operands ---

/**
 * Computes a memory operand's address into the `addr` local, once.
 *
 * @param {E} e @param {Operand} operand
 * @param {{ store?: boolean }} [options]  `store` when the operand is only
 *     written and its `writeOp` follows with no exit between
 */
export function prepare(e, operand, options){
    if (operand.kind === 'mem')
    {
        emitAddress(e, operand, true);
        e.b.localSet(Local.addr);
        checkAccess(e, operand.size, options);
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
    // Only fs has a base, the thread block's; gs adds none, as in the
    // interpreter: nothing here gives it one.
    if (withSegment && operand.segment === 4)
    {
        atState(e.context, b).load('i32', { offset: e.layout.fsBase }).op(I32.add);
    }
}

/** The load kind for a zero-extended read of `size` bytes. @param {number} size */
const loadKind = size=>(size === 1 ? 'i32_8u' : size === 2 ? 'i32_16u' : 'i32');
/** The store kind for `size` bytes. @param {number} size */
const storeKind = size=>(size === 1 ? 'i32_8' : size === 2 ? 'i32_16' : 'i32');

/**
 * Whether the ordered variant makes an access to this operand atomic.
 *
 * On an x86 host the engine's plain loads and stores are the processor's,
 * in its order, and a program that writes its data and then a flag with
 * plain `mov`s -- what x86 lets it do -- has another thread see the flag
 * after the data. A host that reorders plain accesses (arm64) does not keep
 * that: a thread may see the flag first, or read the data before the flag
 * it waits for. The ordered variant makes an integer operand's load an
 * atomic load and its store an atomic store, each ordered with every other
 * atomic access and with the plain ones on either side of it -- the data a
 * thread stored before the flag, and the data it reads after. An address not
 * a multiple of the width stays plain (a wasm atomic traps there), and so do
 * an access through esp, a thread's own stack, the x87's and the vector
 * registers' operands, and the string instructions: data around a flag, not
 * the flag.
 *
 * @param {E} e @param {Operand} operand
 */
const ordered = (e, operand)=>e.context.ordered === true && operand.base !== 4;

/**
 * The ordered variant's load of `size` bytes at `Local.addr`, zero-extended
 * (an atomic kind is named by the store kind of its width).
 *
 * @param {E} e @param {number} size
 */
function orderedLoad(e, size){
    const { b } = e;
    const offset = e.layout.ramBase;
    if (size === 1)
    {
        b.localGet(Local.addr).atomic(`load_${storeKind(size)}`, { offset });
        return;
    }
    b.localGet(Local.addr).i32const(size - 1).op(I32.and);
    e.openGuard('misread', ValType.i32);
    b.localGet(Local.addr).load(loadKind(size), { offset });
    b.else();
    b.localGet(Local.addr).atomic(`load_${storeKind(size)}`, { offset });
    e.close();
}

/**
 * The ordered variant's store of `size` bytes at `Local.addr` of what
 * `pushValue` pushes.
 *
 * @param {E} e @param {number} size @param {() => void} pushValue
 */
function orderedStore(e, size, pushValue){
    const { b } = e;
    const offset = e.layout.ramBase;
    if (size === 1)
    {
        b.localGet(Local.addr);
        pushValue();
        b.atomic(`store_${storeKind(size)}`, { offset });
        return;
    }
    const value = e.orderedLocal();
    pushValue();
    b.localSet(value);
    b.localGet(Local.addr).i32const(size - 1).op(I32.and);
    e.openGuard('miswrite', EMPTY);
    b.localGet(Local.addr).localGet(value).store(storeKind(size), { offset });
    b.else();
    b.localGet(Local.addr).localGet(value).atomic(`store_${storeKind(size)}`, { offset });
    e.close();
}

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
            if (ordered(e, operand))
            {
                orderedLoad(e, operand.size);
                return;
            }
            b.localGet(Local.addr).load(loadKind(operand.size), { offset: e.layout.ramBase });
            return;
        default:
            throw new Error(`emit: cannot read a ${operand.kind} operand`);
    }
}

/**
 * Writes an operand: `pushValue` pushes the new value (any high bits are
 * masked here, unless `exact` says it has none: a load of the operand's size,
 * or a register's bytes, read as they are).
 *
 * @param {E} e @param {Operand} operand @param {() => void} pushValue
 */
export function writeOp(e, operand, pushValue, exact = false){
    const { b } = e;
    switch (operand.kind)
    {
        case 'reg':
            pushValue();
            writeReg(e, /** @type {number} */ (operand.reg), operand.size, operand.high === true,
                exact);
            return;
        case 'mem':
            noteStore(e, operand.size);
            if (ordered(e, operand))
            {
                orderedStore(e, operand.size, pushValue);
                return;
            }
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
 * into the dword. A value `exact` has no bits past `size` bytes -- a load of
 * them, zero-extended -- and is merged as it is: the compiler does not know a
 * narrow load's range and would keep the mask.
 *
 * @param {E} e @param {number} reg @param {number} size @param {boolean} high
 * @param {boolean} [exact]
 */
export function writeReg(e, reg, size, high, exact = false){
    const { b } = e;
    const local = Local.reg + reg;
    if (size === 4)
    {
        b.localSet(local);
        return;
    }
    b.localSet(Local.t0);
    b.localGet(local);
    b.i32const(size === 2 ? 0xffff0000 | 0 : high ? 0xffff00ff | 0 : 0xffffff00 | 0).op(I32.and);
    b.localGet(Local.t0);
    if (!exact)
    {
        b.i32const(size === 2 ? 0xffff : 0xff).op(I32.and);
    }
    if (size === 1 && high)
    {
        b.i32const(8).op(I32.shl);
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
    if (!looseStackStore(e, size))
    {
        checkAccess(e, size, { store: true });
        noteStore(e, size);
    }
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
    if (staticCount < 0 && flagsLive)
    {
        // A count of zero at run time leaves the pending record to be folded
        // later, so its operands must survive: the word is made whole first.
        // With the flags dead, the record is left alone and the value kept
        // apart from it.
        e.materialise();
    }
    const value = flagsLive ? Local.op1 : Local.t1;
    // The value, sign-extended for sar.
    readOp(e, dst);
    if (arith && size < 4)
    {
        b.op(size === 1 ? I32_EXTRA.extend8s : I32_EXTRA.extend16s);
    }
    b.localSet(value);
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
        b.localGet(value);
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
        if (flagsLive)
        {
            // Whether the shift happened is dynamic: the record is unknown here.
            e.pending = null;
        }
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
        // As in `shift`: whole word before the branch, record unknown after it,
        // unless the flags are dead and the record is left alone.
        if (flagsLive)
        {
            e.materialise();
        }
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
        if (flagsLive)
        {
            e.pending = null;
        }
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
    e.openGuard('zero', EMPTY);
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
        e.openGuard('overflow', EMPTY);
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
        e.openGuard('overflow', EMPTY);
        e.exitBefore(instruction.eip, Exit.FAULT, 0);
        e.close();
        b.localGet(Local.t64).localGet(Local.t1).op(I64.extendS).op(I64.divS).localSet(Local.t64b);
        // The quotient must fit a signed dword.
        b.localGet(Local.t64b).localGet(Local.t64b).op(I64.wrap).op(I64.extendS).op(I64.ne);
        e.openGuard('overflow', EMPTY);
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
            e.openGuard('overflow', EMPTY);
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
    e.openGuard('overflow', EMPTY);
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
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function bitTest(e, instruction, flagsLive){
    const { b } = e;
    const { op, operands, size } = instruction;
    const [dst, offset] = operands;
    const bits = size * 8;
    if (dst.kind === 'mem' && offset.kind !== 'imm')
    {
        // A bit string: the register names a bit anywhere from the address,
        // signed, so the operand is the word or dword that holds it.
        emitAddress(e, dst, true);
        readOp(e, offset);
        if (size === 2)
        {
            b.i32const(16).op(I32.shl).i32const(16).op(I32.shrS); // the word offset is signed
        }
        b.localTee(Local.t2);
        b.i32const(size === 2 ? 4 : 5).op(I32.shrS).i32const(size === 2 ? 1 : 2).op(I32.shl);
        b.op(I32.add).localSet(Local.addr);
        checkAccess(e, size);
        b.localGet(Local.t2).i32const(bits - 1).op(I32.and).localSet(Local.count);
    }
    else
    {
        prepare(e, dst);
        readOp(e, offset);
        b.i32const(bits - 1).op(I32.and).localSet(Local.count);
    }
    readOp(e, dst);
    b.localSet(Local.t1);
    if (flagsLive)
    {
        e.eagerWrite(CF);
        b.localGet(Local.t1).localGet(Local.count).op(I32.shrU).i32const(1).op(I32.and);
        e.orFlag(CF);
    }
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
 * cmpxchg8b m64: edx:eax compared with the qword; equal, ecx:ebx is stored
 * and ZF set; otherwise the qword is loaded into edx:eax and ZF cleared.
 *
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 */
function cmpxchg8b(e, instruction, flagsLive){
    const { b } = e;
    const [dst] = instruction.operands;
    prepare(e, dst);
    b.localGet(Local.addr).load('i32', { offset: e.layout.ramBase }).localSet(Local.t1);
    b.localGet(Local.addr).load('i32', { offset: e.layout.ramBase + 4 }).localSet(Local.t2);
    if (flagsLive)
    {
        e.eagerWrite(ZF);
    }
    b.localGet(Local.t1).localGet(Local.reg).op(I32.eq);
    b.localGet(Local.t2).localGet(Local.reg + 2).op(I32.eq);
    b.op(I32.and);
    e.openIf('equal', EMPTY);
    noteStore(e, 8);
    b.localGet(Local.addr).localGet(Local.reg + 3).store('i32', { offset: e.layout.ramBase });
    b.localGet(Local.addr).localGet(Local.reg + 1).store('i32', { offset: e.layout.ramBase + 4 });
    if (flagsLive)
    {
        b.localGet(Local.flags).i32const(ZF).op(I32.or).localSet(Local.flags);
    }
    b.op(0x05); // else
    b.localGet(Local.t1).localSet(Local.reg);
    b.localGet(Local.t2).localSet(Local.reg + 2);
    e.close();
    return true;
}

/**
 * The decimal and ASCII adjustments, on AL and AH as the processor keeps
 * them. daa/das define CF, AF and the result flags of AL; aaa/aas define AF
 * and CF and leave the rest as the result of AL gives them; aam/aad define
 * the result flags of AL and clear the others.
 *
 * @param {E} e @param {Instruction} instruction
 */
function decimal(e, instruction){
    const { b } = e;
    const { op, operands } = instruction;
    const al = ()=>b.localGet(Local.reg).i32const(0xff).op(I32.and);
    const ah = ()=>b.localGet(Local.reg).i32const(8).op(I32.shrU).i32const(0xff).op(I32.and);
    /** Writes t1 into AL, or t1 into AX when wide. @param {boolean} wide */
    const setLow = wide=>{
        b.localGet(Local.reg).i32const(wide ? ~0xffff : ~0xff).op(I32.and);
        b.localGet(Local.t1).i32const(wide ? 0xffff : 0xff).op(I32.and).op(I32.or);
        b.localSet(Local.reg);
    };
    if (op === 'aam' || op === 'aad')
    {
        const base = /** @type {number} */ (operands[0].value);
        if (op === 'aam')
        {
            if (base === 0)
            {
                e.exitBefore(instruction.eip, Exit.FAULT, 0);
                e.dead = true;
                return true;
            }
            // AH = AL / base, AL = AL % base.
            al();
            b.i32const(base).op(I32_EXTRA.remU).localSet(Local.t1);
            al();
            b.i32const(base).op(I32_EXTRA.divU).i32const(8).op(I32.shl)
                .localGet(Local.t1).op(I32.or).localSet(Local.t1);
        }
        else
        {
            // AL = AL + AH * base, AH = 0.
            al();
            ah();
            b.i32const(base).op(I32_EXTRA.mul).op(I32.add).i32const(0xff).op(I32.and)
                .localSet(Local.t1);
        }
        setLow(true);
        b.localGet(Local.t1).i32const(0xff).op(I32.and);
        e.record(Kind.LOGIC, 1);
        b.drop();
        return true;
    }
    // CF and AF as they stand, then the word made whole with the six cleared.
    // The old CF (cin) decides the high digit; t2 carries the low digit's.
    e.pushFlag(CF);
    b.localTee(Local.t2).localSet(Local.cin);
    e.pushFlag(AF);
    b.localSet(Local.op1);
    e.eagerWrite(ARITH_ALL);
    if (op === 'daa' || op === 'das')
    {
        const add = op === 'daa';
        al();
        b.localSet(Local.op2); // the old AL
        b.localGet(Local.op2).localSet(Local.t1);
        // Low digit: adjusted when above 9 or AF was set.
        b.localGet(Local.op2).i32const(0xf).op(I32.and).i32const(9).op(I32.gtU);
        b.localGet(Local.op1).op(I32.or);
        e.openIf('low', EMPTY);
        b.localGet(Local.t1).i32const(add ? 6 : -6).op(I32.add).localSet(Local.t1);
        // CF = old CF or the carry out of the addition (the borrow of the
        // subtraction: an old AL below 6).
        if (add)
        {
            b.localGet(Local.t2).localGet(Local.t1).i32const(0xff).op(I32.gtU).op(I32.or)
                .localSet(Local.t2);
        }
        else
        {
            b.localGet(Local.t2).localGet(Local.op2).i32const(6).op(I32.ltU).op(I32.or)
                .localSet(Local.t2);
        }
        b.localGet(Local.flags).i32const(AF).op(I32.or).localSet(Local.flags);
        e.close();
        // High digit: adjusted when the old AL was above 0x99 or the old CF
        // was set, and CF is then set; otherwise daa clears CF and das keeps
        // the low digit's borrow.
        if (!add)
        {
            b.localGet(Local.flags).localGet(Local.t2).i32const(CF).op(I32.mul).op(I32.or)
                .localSet(Local.flags);
        }
        b.localGet(Local.op2).i32const(0x99).op(I32.gtU);
        b.localGet(Local.cin).op(I32.or);
        e.openIf('high', EMPTY);
        b.localGet(Local.t1).i32const(add ? 0x60 : -0x60).op(I32.add).localSet(Local.t1);
        b.localGet(Local.flags).i32const(CF).op(I32.or).localSet(Local.flags);
        e.close();
        setLow(false);
    }
    else
    {
        // aaa / aas: on a low digit above 9 or AF, AX += 0x106 / AX -= 6 and
        // AH -= 1, with AF and CF set; AL keeps its low digit either way.
        const add = op === 'aaa';
        b.localGet(Local.reg).i32const(0xffff).op(I32.and).localSet(Local.t1);
        al();
        b.i32const(0xf).op(I32.and).i32const(9).op(I32.gtU);
        b.localGet(Local.op1).op(I32.or);
        e.openIf('adjust', EMPTY);
        b.localGet(Local.t1).i32const(add ? 0x106 : -0x106).op(I32.add).i32const(0xffff)
            .op(I32.and).localSet(Local.t1);
        b.localGet(Local.flags).i32const(AF | CF).op(I32.or).localSet(Local.flags);
        e.close();
        b.localGet(Local.t1).i32const(0xff0f).op(I32.and).localSet(Local.t1);
        setLow(true);
    }
    // The result flags of AL, with CF and AF kept from the word.
    b.localGet(Local.flags).i32const(CF | AF).op(I32.and).localSet(Local.op2);
    b.localGet(Local.t1).i32const(0xff).op(I32.and);
    e.record(Kind.LOGIC, 1);
    b.drop();
    e.materialise();
    b.localGet(Local.flags).localGet(Local.op2).op(I32.or).localSet(Local.flags);
    return true;
}

/** The bytes a unit of the budget pays for in the bulk paths, as a shift (`bulkTurn`). */
const BULK_UNIT_SHIFT = 4;

/**
 * What the bulk paths share (`bulkString`, `bulkScan`), with the step, +size
 * or -size, in t2: `run` leaves in t0 the elements of a turn -- as many as
 * ecx, the budget and the whole elements on each pointer's current page the
 * way the step goes allow -- and `clear` whether a pointer's page has none of
 * some flags.
 *
 * @param {E} e @param {number} size
 */
function bulkTurn(e, size){
    const { b } = e;
    const elementShift = Math.log2(size);
    const table = pageFlagsAt(e.layout);
    // t0 = min(t0, the value on the stack), unsigned.
    const minInto = ()=>{
        b.localSet(Local.t1);
        b.localGet(Local.t1).localGet(Local.t0).localGet(Local.t1).localGet(Local.t0)
            .op(I32.ltU).select().localSet(Local.t0);
    };
    /**
     * The whole elements on a pointer's page from it the way the step goes:
     * going up to the page's end, going down to its start, and none when the
     * element at the pointer crosses the page's end.
     * @param {number} pointer
     */
    const room = pointer=>{
        const offset = ()=>b.localGet(pointer).i32const(4095).op(I32.and);
        b.i32const(4096);
        offset();
        b.op(I32.sub).i32const(elementShift).op(I32.shrU);
        offset();
        b.i32const(elementShift).op(I32.shrU).i32const(1).op(I32.add);
        if (size > 1)
        {
            b.i32const(0);
            offset();
            b.i32const(4096 - size).op(I32.leU).select();
        }
        b.localGet(Local.t2).i32const(size).op(I32.eq).select();
    };
    return {
        /** @param {number[]} pointers */
        run(pointers){
            b.localGet(Local.reg + 1).localSet(Local.t0);
            // The elements the budget pays for, the budget taken at a page's
            // worth at most so the shift cannot overflow.
            const page = 4096 >> BULK_UNIT_SHIFT;
            b.localGet(Local.budget).i32const(page).localGet(Local.budget).i32const(page)
                .op(I32.ltS).select().i32const(BULK_UNIT_SHIFT - elementShift).op(I32.shl);
            minInto();
            for (const pointer of pointers)
            {
                room(pointer);
                minInto();
            }
        },
        /** @param {number} pointer @param {number} bits */
        clear(pointer, bits){
            b.localGet(pointer).i32const(12).op(I32.shrU)
                .load('i32_8u', { offset: table }).i32const(bits).op(I32.and).op(I32.eqz);
        },
    };
}

/**
 * A `rep movs` or `rep stos` takes, per turn of its loop, every element that
 * lies wholly on the current page of each pointer the way DF goes (as far as
 * ecx and the budget go) at once: one flag test of those pages --
 * inaccessible for either, code for the destination -- then one
 * `memory.copy`, or a fill, over the bytes the run spans, with ecx, the
 * pointers, the count and the budget moved by the whole run. Anything else
 * takes the per-element path after it: an element across a page, a flagged
 * page, and a copy whose destination lies just ahead of its source the way
 * the copy goes (the processor reads there what it has just written, which a
 * memmove does not). What the run leaves -- registers, memory, count, the
 * budget exit on the instruction -- is what as many single elements leave.
 *
 * The budget is charged a unit for every 16 bytes the run moves, a begun one
 * whole, where the per-element path charges an element: the quantum is how
 * long a thread may hold the machine, and a fill or a copy of 16 bytes costs
 * about what one translated instruction does. Charged an element, a `rep` of
 * bytes would end its slice sixteen times as often as its time does, and
 * each end costs a turn of the host's scheduler and the rest of the `rep` on
 * an interpreter tier.
 *
 * @param {E} e @param {Instruction} instruction
 */
function bulkString(e, instruction){
    const { b } = e;
    const { op, size } = instruction;
    const elementShift = Math.log2(size);
    const ramBase = e.layout.ramBase;
    const ecx = Local.reg + 1;
    const esi = Local.reg + 6;
    const edi = Local.reg + 7;
    const movs = op === 'movs';
    const up = ()=>b.localGet(Local.t2).i32const(size).op(I32.eq);
    const turn = bulkTurn(e, size);
    b.localGet(Local.budget).i32const(0).op(I32.gtS);
    e.openIf('bulk', EMPTY);
    turn.run(movs ? [edi, esi] : [edi]);
    b.localGet(Local.t0).i32const(elementShift).op(I32.shl).localSet(Local.t1);
    b.localGet(Local.t0).i32const(0).op(I32.ne);
    turn.clear(edi, PageFlag.INACCESSIBLE | STORE_FLAGS);
    b.op(I32.and);
    if (movs)
    {
        turn.clear(esi, PageFlag.INACCESSIBLE);
        b.op(I32.and);
        // Not 0 < the destination's lead on the source, the way the copy
        // goes, < the run's bytes: (lead - 1) >=u (bytes - 1).
        b.localGet(edi).localGet(esi).op(I32.sub).localGet(esi).localGet(edi).op(I32.sub);
        up();
        b.select().i32const(1).op(I32.sub)
            .localGet(Local.t1).i32const(1).op(I32.sub).op(I32.geU).op(I32.and);
    }
    e.openIf('bulkPages', EMPTY);
    /**
     * The run's lowest byte in memory: the pointer going up, going down the
     * pointer less the bytes before its own element.
     * @param {number} pointer
     */
    const lowest = pointer=>{
        b.localGet(pointer).localGet(pointer).i32const(size).op(I32.add).localGet(Local.t1)
            .op(I32.sub);
        up();
        b.select().i32const(ramBase).op(I32.add);
    };
    if (movs)
    {
        lowest(edi);
        lowest(esi);
        b.localGet(Local.t1).op(0xfc, [0x0a, 0x00, 0x00]); // memory.copy
    }
    else
    {
        // A value of one byte repeated is a fill; any other is stored a word
        // at a time, still with no test between.
        const lanes = size === 1 ? 1 : size === 2 ? 0x0101 : 0x01010101;
        b.localGet(Local.reg).i32const(0xff).op(I32.and).i32const(lanes).op(I32.mul)
            .localGet(Local.reg);
        mask(e, size);
        b.op(I32.eq);
        e.openIf('fill', EMPTY);
        lowest(edi);
        b.localGet(Local.reg).localGet(Local.t1).op(0xfc, [0x0b, 0x00]); // memory.fill
        b.else();
        lowest(edi);
        b.localTee(Local.addr);
        // The run's end, in the page-flags local: no access is checked
        // until the loop is done, and the next check sets it afresh.
        b.localGet(Local.t1).op(I32.add).localSet(Local.pflags);
        e.openLoop('words');
        b.localGet(Local.addr).localGet(Local.reg);
        b.store(storeKind(size), { offset: 0 });
        b.localGet(Local.addr).i32const(size).op(I32.add).localTee(Local.addr)
            .localGet(Local.pflags).op(I32.ne);
        b.brIf(e.depthOf('words'));
        e.close();
        e.close();
    }
    // The pointers move by the elements times the step.
    for (const pointer of movs ? [edi, esi] : [edi])
    {
        b.localGet(pointer).localGet(Local.t0).localGet(Local.t2).op(I32_EXTRA.mul).op(I32.add)
            .localSet(pointer);
    }
    b.localGet(ecx).localGet(Local.t0).op(I32.sub).localSet(ecx);
    b.localGet(Local.budget).localGet(Local.t1).i32const((1 << BULK_UNIT_SHIFT) - 1).op(I32.add)
        .i32const(BULK_UNIT_SHIFT).op(I32.shrU).op(I32.sub).localSet(Local.budget);
    b.localGet(Local.budget).i32const(0).op(I32.leS);
    e.openGuard('bulkSpent', EMPTY);
    e.exitAt(instruction.eip, Exit.BUDGET);
    e.close();
    b.br(e.depthOf('again'));
    e.close();
    e.close();
}

/**
 * A `repe` or `repne` `cmps` or `scas` passes over, per turn of its loop, the
 * elements that do not stop it among those that lie wholly on the pointers'
 * current pages the way DF goes (as far as ecx and the budget go), all but
 * the last of them: a loop of a load, or two, and a compare, with ecx and
 * the pointers moved past them and the budget charged by their bytes as
 * `bulkString` charges. The element after them -- the one that stops the
 * instruction, or the last of the pages or of the count -- then takes the
 * per-element path, which sets the flags from it, tests the stop condition
 * and the budget, and faults on its page: however the instruction leaves --
 * done, out of budget, at a fault on the next page -- it leaves with the
 * flags of the last element it ran, as the processor does. A page that
 * cannot be read, an element across a page, and the last element on the way
 * take the per-element path alone.
 *
 * @param {E} e @param {Instruction} instruction
 */
function bulkScan(e, instruction){
    const { b } = e;
    const { op, size, prefixes } = instruction;
    const elementShift = Math.log2(size);
    const ramBase = e.layout.ramBase;
    const ecx = Local.reg + 1;
    const esi = Local.reg + 6;
    const edi = Local.reg + 7;
    const cmps = op === 'cmps';
    const turn = bulkTurn(e, size);
    b.localGet(Local.budget).i32const(0).op(I32.gtS);
    e.openIf('passing', EMPTY);
    turn.run(cmps ? [edi, esi] : [edi]);
    b.localGet(Local.t0).i32const(1).op(I32.gtU);
    turn.clear(edi, PageFlag.INACCESSIBLE);
    b.op(I32.and);
    if (cmps)
    {
        turn.clear(esi, PageFlag.INACCESSIBLE);
        b.op(I32.and);
    }
    e.openIf('passPages', EMPTY);
    // addr walks the destination, the end it stops short of in the
    // page-flags local; a compare's source is addr + (esi - edi), in t1, and
    // a scan's value is in the count local.
    b.localGet(edi).localTee(Local.addr).localGet(Local.t0).i32const(1).op(I32.sub)
        .localGet(Local.t2).op(I32_EXTRA.mul).op(I32.add).localSet(Local.pflags);
    if (cmps)
    {
        b.localGet(esi).localGet(edi).op(I32.sub).localSet(Local.t1);
    }
    else
    {
        b.localGet(Local.reg);
        mask(e, size);
        b.localSet(Local.count);
    }
    e.open('stops', EMPTY);
    e.openLoop('pass');
    if (cmps)
    {
        b.localGet(Local.addr).localGet(Local.t1).op(I32.add)
            .load(loadKind(size), { offset: ramBase });
    }
    else
    {
        b.localGet(Local.count);
    }
    b.localGet(Local.addr).load(loadKind(size), { offset: ramBase });
    // repe stops on a difference, repne on an equal pair.
    b.op(prefixes.rep ? I32.ne : I32.eq);
    b.brIf(e.depthOf('stops'));
    b.localGet(Local.addr).localGet(Local.t2).op(I32.add).localTee(Local.addr)
        .localGet(Local.pflags).op(I32.ne);
    b.brIf(e.depthOf('pass'));
    e.close();
    e.close();
    // The bytes passed, signed the way the step goes, then their magnitude.
    b.localGet(Local.addr).localGet(edi).op(I32.sub).localSet(Local.t0);
    if (cmps)
    {
        b.localGet(esi).localGet(Local.t0).op(I32.add).localSet(esi);
    }
    b.localGet(Local.addr).localSet(edi);
    b.localGet(Local.t0).localGet(Local.t2).i32const(31).op(I32.shrS).localTee(Local.t1)
        .op(I32.xor).localGet(Local.t1).op(I32.sub).localSet(Local.t0);
    b.localGet(ecx).localGet(Local.t0).i32const(elementShift).op(I32.shrU).op(I32.sub)
        .localSet(ecx);
    b.localGet(Local.budget).localGet(Local.t0).i32const((1 << BULK_UNIT_SHIFT) - 1).op(I32.add)
        .i32const(BULK_UNIT_SHIFT).op(I32.shrU).op(I32.sub).localSet(Local.budget);
    e.close();
    e.close();
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
    const repeat = prefixes.rep || prefixes.repne;
    // The source, [esi], takes a segment override; the destination, es:[edi],
    // does not. Of the segments only fs has a base.
    const fsSource = instruction.operands.some(operand=>operand.kind === 'mem'
        && operand.base === 6 && operand.segment === 4);
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
        // Each iteration is counted as one instruction, and the instruction
        // itself once more when it completes: N + 1 for N iterations, where a
        // slice that stops it has charged the iterations it ran alone (and the
        // interpreter counts a whole rep as one). The budget is looked at every
        // iteration, and a slice that runs out in the middle leaves with EIP on
        // the instruction, whose remaining count is what ecx, esi and edi then
        // hold.
        e.blockRetired--;
        e.open('done', EMPTY);
        e.openLoop('again');
        b.localGet(ecx).op(I32.eqz);
        b.brIf(e.depthOf('done'));
        if ((op === 'movs' || op === 'stos') && e.context.undo === undefined
            && e.layout.codePages < 0 && !fsSource)
        {
            bulkString(e, instruction);
        }
        if (compare && e.layout.codePages < 0 && !fsSource)
        {
            bulkScan(e, instruction);
        }
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
        b.localGet(pointer);
        if (pointer === esi && fsSource)
        {
            atState(e.context, b).load('i32', { offset: e.layout.fsBase }).op(I32.add);
        }
        b.localSet(Local.addr);
        checkAccess(e, size, { counted });
        b.localGet(Local.addr).load(loadKind(size), { offset: e.layout.ramBase });
    };
    /**
     * A checked store at the pointer of the value `pushValue` pushes.
     * @param {number} pointer @param {() => void} pushValue
     */
    const checkedStore = (pointer, pushValue)=>{
        b.localGet(pointer).localSet(Local.addr);
        checkAccess(e, size, { counted, store: true });
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
            writeReg(e, 0, size, false, true);
            advance(esi);
            break;
        case 'cmps':
            // The source's element waits in t1 until the destination's is
            // read: a fault there leaves the record of the compare before,
            // whose first operand the flags are folded from.
            checkedLoad(esi);
            b.localSet(Local.t1);
            checkedLoad(edi);
            b.localSet(Local.op2);
            b.localGet(Local.t1).localTee(Local.op1).localGet(Local.op2).op(I32.sub);
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
        b.localGet(Local.budget).i32const(1).op(I32.sub).localSet(Local.budget);
        if (compare)
        {
            // rep: stop when not equal; repne: stop when equal. Before the
            // budget: an iteration that met its stop has ended the
            // instruction, and a slice leaving on it would resume the scan.
            b.localGet(Local.res).op(I32.eqz);
            if (prefixes.rep)
            {
                b.op(I32.eqz);
            }
            b.brIf(e.depthOf('done'));
        }
        b.localGet(Local.budget).i32const(0).op(I32.leS);
        e.openGuard('spent', EMPTY);
        e.exitAt(instruction.eip, Exit.BUDGET);
        e.close();
        b.br(e.depthOf('again'));
        e.close();
        e.close();
        e.blockRetired++;
        e.pending = null;
    }
    return true;
}

/**
 * A switch's jump (`SwitchTable`, the target already in `eip`): the index picks
 * its case by a `br_table`, and a case whose table entry still names the
 * target it was formed with is a jump inside the region. Anything else -- an
 * index past the table, an entry written since, a case the region did not
 * take in -- falls out to the jump's own exit.
 *
 * @param {E} e
 */
function switchCases(e){
    const { b } = e;
    const table = e.region.blocks[e.blockIndex].exit.table;
    if (table === undefined)
    {
        return;
    }
    const cases = [...new Set(table.entries)].filter(target=>e.labels.has(target));
    if (cases.length === 0)
    {
        return;
    }
    // Charged once, at the block's depth, for every way out below.
    e.charge();
    e.open('switchOut', EMPTY);
    for (let k = cases.length - 1; k >= 0; k--)
    {
        e.open(`case${k}`, EMPTY);
    }
    b.localGet(Local.reg + table.index);
    b.brTable(table.entries.map(target=>{
        const k = cases.indexOf(target);
        return k < 0 ? e.depthOf('switchOut') : e.depthOf(`case${k}`);
    }), e.depthOf('switchOut'));
    for (let k = 0; k < cases.length; k++)
    {
        e.close();
        b.localGet(Local.eip).i32const(cases[k]).op(I32.eq);
        e.openIf('case');
        e.jumpTo(cases[k]);
        e.close();
        b.br(e.depthOf('switchOut'));
    }
    e.close();
}
