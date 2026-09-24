/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 in a region: the stack as eight f64 locals, the top a compile-time
 * value, every value a double.
 *
 * A region is compiled for the top it is entered with (`entryTop`, part of
 * the entry key); the tracker follows the top through the region's blocks
 * and records, per block, the top and the permutation `fxch` left (an
 * exchange costs no code: two registers swap the locals that hold them,
 * and an edge into a block that expects them the other way round moves
 * them). A block reached with two different tops is cut: it leaves for
 * the other executor before running anything.
 *
 * What is dynamic: the empty mask (a push clears a bit, a pop sets one),
 * the status word's condition and exception bits, and a dirty mask of the
 * registers written, which the epilogue stores back -- as f64 in cork's own
 * layout, as the emulator's tagged double in its. A register read at entry
 * that the emulator kept as a true 80-bit value is converted inline.
 *
 * Every arithmetic result is the f64 result; where the processor's 80-bit
 * arithmetic would differ the difference is the `x87.precision` class the
 * plan names and counts (the emulator computes in f64 as well). The control
 * word is honoured at run time: its rounding control rounds the integer
 * stores and `frndint`, and precision control set to single rounds every
 * arithmetic result to a float (extended is treated as double). Exception
 * masks are not honoured: an exception behaves as masked. The
 * transcendentals go through the host's `Math`, as the emulator's do, so
 * the two agree bit for bit on one engine; the environment forms end a
 * region.
 */

import { CF, PF, ZF, AF, SF, OF } from '../decode/table.js';
import { Body, EMPTY, ValType } from '../wasm/encoder.js';
import { I32 } from './flags.js';
import { Local, Exit } from './region.js';
import { prepare, writeReg, readOp } from './integer.js';
import { noteStore } from './memory.js';

/** @typedef {import('./region.js').RegionEmitter} E */
/** @typedef {import('../decode/decoder.js').Instruction} Instruction */
/** @typedef {import('../decode/decoder.js').Operand} Operand */

/** f64 and conversion opcodes. */
const F64 = Object.freeze({
    eq: 0x61, ne: 0x62, lt: 0x63, gt: 0x64, le: 0x65, ge: 0x66,
    abs: 0x99, neg: 0x9a, trunc: 0x9d, nearest: 0x9e, sqrt: 0x9f,
    add: 0xa0, sub: 0xa1, mul: 0xa2, div: 0xa3, copysign: 0xa6,
    convertI32S: 0xb7, convertI64S: 0xb9, convertI64U: 0xba, promoteF32: 0xbb,
    reinterpretI64: 0xbf,
});
const I64 = Object.freeze({
    eqz: 0x50, eq: 0x51, ne: 0x52, ltS: 0x53, gtS: 0x55, add: 0x7c, sub: 0x7d, and: 0x83,
    or: 0x84, shl: 0x86, shrU: 0x88, clz: 0x79, wrap: 0xa7, extendS: 0xac, extendU: 0xad,
    reinterpretF64: 0xbd,
});
const F32 = Object.freeze({ demoteF64: 0xb6 });
/** i32.trunc_sat_f64_s / i64.trunc_sat_f64_s */
const TRUNC_SAT_I32 = [0xfc, 0x02];
const TRUNC_SAT_I64 = [0xfc, 0x06];

/** Status word bits. */
const Status = Object.freeze({
    IE: 0x1, ZE: 0x4, UE: 0x10, SF: 0x40, C0: 0x100, C1: 0x200, C2: 0x400, C3: 0x4000,
    CONDITION: 0x100 | 0x200 | 0x400 | 0x4000,
});
/** The emulator's tag for a register holding a double in its mantissa word. */
const RELAXED_TAG = 0x7ffe;
/** The default control word `fninit` leaves. */
const DEFAULT_CONTROL = 0x37f;

/** The x87 opcodes: the eight escape bytes and the wait. */
const X87_OPCODE = /^(9b$|d[89a-f] )/;

/** @param {Instruction} instruction */
export function isX87(instruction){
    return X87_OPCODE.test(instruction.opcode);
}

/** The instructions this step leaves to the other executor. */
const LEFT_OUT = new Set([
    'fxsave', 'fxrstor', 'fbld',
]);

/**
 * @typedef {Object} StackState
 * @property {number} top
 * @property {number[]} slot   architectural register k -> which of the eight locals holds it
 */

/** @param {StackState} state */
const cloneState = state=>({ top: state.top, slot: [...state.slot] });
/** @param {StackState} a @param {StackState} b */
export const sameState = (a, b)=>a.top === b.top && a.slot.every((s, i)=>s === b.slot[i]);

/**
 * The stack after one instruction, or null when the instruction ends the
 * tracking (left out, or unknown).
 *
 * @param {Instruction} instruction @param {StackState} state
 * @returns {StackState | null}
 */
export function step(instruction, state){
    const { op, operands } = instruction;
    if (!isX87(instruction))
    {
        // An MMX instruction puts the stack in the MMX state, as the processor
        // does: the top at zero and every register held. The hold is the run-time
        // empty mask the instruction's own emission sets; the top is the tracker's,
        // so the x87 after it in the region is compiled for a top of zero.
        if (operands.some(operand=>operand.kind === 'mm'))
        {
            return { top: 0, slot: [...state.slot] };
        }
        return state;
    }
    if (LEFT_OUT.has(op))
    {
        return null;
    }
    const next = cloneState(state);
    const push = ()=>{
        next.top = (next.top - 1) & 7;
    };
    const pop = ()=>{
        next.top = (next.top + 1) & 7;
    };
    switch (op)
    {
        case 'fld': case 'fild': case 'fld1': case 'fldz': case 'fldpi': case 'fldl2e':
        case 'fldln2': case 'fldlg2': case 'fldl2t': case 'fxtract': case 'fsincos':
        case 'fptan':
            push();
            return next;
        case 'fpatan': case 'fyl2x': case 'fyl2xp1':
            pop();
            return next;
        case 'fstp': case 'fistp': case 'fisttp': case 'fbstp': case 'faddp': case 'fsubp':
        case 'fsubrp': case 'fmulp': case 'fdivp': case 'fdivrp': case 'fcomp': case 'fucomp':
        case 'fcomip': case 'fucomip': case 'ffreep': case 'ficomp':
            pop();
            return next;
        case 'fcompp': case 'fucompp':
            pop();
            pop();
            return next;
        case 'fxch':
        {
            const i = /** @type {number} */ (operands[1].reg);
            const a = next.top;
            const c = (next.top + i) & 7;
            [next.slot[a], next.slot[c]] = [next.slot[c], next.slot[a]];
            return next;
        }
        case 'fincstp':
            pop();
            return next;
        case 'fdecstp':
            push();
            return next;
        case 'fninit': case 'fnsave':
            next.top = 0;
            return next;
        default:
            return next;
    }
}

/**
 * The tracker over a region: the state at each block's start, propagated
 * from the entry along the region's edges; a block met with two different
 * states is cut (null). The entry block's state is the identity mapping at
 * `entryTop`.
 *
 * @param {import('../region.js').Region} region
 * @param {number} entryTop
 * @returns {{ states: (StackState | null)[], cut: Set<number>, ends: (StackState | null)[] }}
 *     `ends`: the state at each block's end (null when the block is cut or tracking stops in it)
 */
export function trackRegion(region, entryTop){
    const blocks = region.blocks;
    const count = blocks.length;
    const index = new Map(blocks.map((block, i)=>[block.start, i]));
    // The entry's block by its address, not by its place: the blocks are in
    // address order, and a region formed at a return address has the call
    // site's block below it -- seeding the first block left the entry's own
    // x87 with no state and every form in it refused.
    const entry = index.get(region.entry) ?? 0;
    /** @type {(StackState | null)[]} */
    let states = new Array(count).fill(null);
    /** @type {(StackState | null)[]} */
    let ends = new Array(count).fill(null);
    /** @type {Set<number>} */
    const cut = new Set();

    /** The blocks an edge leaves this one by, as indices.
     * @param {number} i
     */
    const successors = i=>{
        const block = blocks[i];
        const targets = [...block.exit.targets];
        if (block.exit.kind === 'fallthrough' || block.exit.kind === 'jcc'
            || block.exit.kind === 'loop')
        {
            targets.push(block.exit.next);
        }
        /** @type {number[]} */
        const out = [];
        for (const target of targets)
        {
            const j = index.get(target);
            if (j !== undefined && !out.includes(j))
            {
                out.push(j);
            }
        }
        return out;
    };

    // A fixed point rather than one forward sweep. A block met with two
    // different tops is cut, and a cut block seeds nothing -- so the sweep is
    // repeated whenever a cut is found, this time not letting the cut block
    // hand its state to a successor that another, agreeing predecessor should
    // decide. Without the repetition the first predecessor to arrive poisoned
    // the join: a block was cut after it had already propagated, and the join
    // kept a state the region could no longer justify. At most one round per
    // block, since every round that does not stop the loop adds a cut.
    for (let round = 0; round <= count; round++)
    {
        /** @type {(StackState | null | undefined)[]} */
        const pending = new Array(count).fill(undefined);
        const seen = new Set();
        pending[entry] = { top: entryTop, slot: [0, 1, 2, 3, 4, 5, 6, 7] };
        const work = [entry];
        ends = new Array(count).fill(null);
        let addedCut = false;
        while (work.length > 0)
        {
            const i = /** @type {number} */ (work.shift());
            if (seen.has(i) || cut.has(i) || pending[i] === undefined)
            {
                continue;
            }
            seen.add(i);
            let state = /** @type {StackState | null} */ (pending[i]);
            for (const instruction of blocks[i].instructions)
            {
                if (state === null)
                {
                    break;
                }
                state = step(instruction, state);
            }
            ends[i] = state;
            if (state === null)
            {
                // Tracking stopped inside the block: its successors are not
                // reached from here with a known state; whatever else reaches
                // them decides. (The block itself exits before the instruction.)
                continue;
            }
            for (const j of successors(i))
            {
                const known = pending[j];
                if (known === undefined)
                {
                    pending[j] = cloneState(state);
                    work.push(j);
                }
                else if (known !== null && known.top !== state.top)
                {
                    if (j === entry)
                    {
                        // The region's own entry block is compiled for the
                        // top the region was formed at, whatever other path
                        // reaches it: the edge that arrives with a different
                        // top leaves at the entry (see `x87Edge`), and the
                        // runtime forms a region there for the top it has.
                        // Cutting the entry instead would publish no entry at
                        // all and the miss would repeat forever.
                        continue;
                    }
                    // Two tops meet: the block cannot be compiled for both.
                    cut.add(j);
                    pending[j] = null;
                    addedCut = true;
                }
                // A different permutation with the same top is fixed on the edge.
            }
        }
        states = pending.map((state, i)=>cut.has(i) ? null : state ?? null);
        if (!addedCut)
        {
            break;
        }
    }
    return { states, cut, ends };
}

/**
 * The emitter's x87 state for one region.
 *
 * @typedef {Object} X87Emit
 * @property {boolean} active            the region has x87 instructions and they are emitted
 * @property {boolean} hasMmx            the region also translates MMX, so the eight registers
 *     are the two views of one set: an MMX register's mantissa in its `i64` local, its x87 value
 *     in the `f64` local, kept equal at every write and told apart at the exit by the form mask
 * @property {number} base               the first of the eight f64 locals
 * @property {number} form               the i32 mask of registers an MMX write left in the MMX
 *     form (the exponent and sign all ones), or -1 when the region translates no MMX
 * @property {number} temp               an f64 scratch local
 * @property {number} temp2
 * @property {number} temp3
 * @property {(StackState | null)[]} states
 * @property {(StackState | null)[]} ends   the state at each block's end, for a loop onto itself
 * @property {Set<number>} cut
 * @property {StackState | null} current   the state at the current point of emission
 * @property {boolean} controlWritten
 */

/**
 * Whether a region translates an MMX instruction: one with an mm operand that
 * the run does not leave out. Such a region, when it also has x87, is the one
 * the two register views meet inside.
 *
 * @param {import('../region.js').Region} region
 * @param {Set<string>} leaveOut
 */
export function regionHasMmx(region, leaveOut){
    return !leaveOut.has('mmx') && region.blocks.some(block=>block.instructions.some(
        instruction=>instruction.operands.some(operand=>operand.kind === 'mm')));
}

/**
 * Sets up the region's x87 emission: decides whether the region uses x87,
 * runs the tracker and allocates the locals. A region with MMX in it keeps
 * x87 too -- the two are the mantissa and the value of one set of eight
 * registers, reconciled at every write (see `hasMmx`) -- rather than leaving
 * x87 to the other executor at the first instruction that has both.
 *
 * @param {E} e @param {number} entryTop
 * @returns {X87Emit}
 */
export function prepareX87(e, entryTop){
    const region = e.region;
    const uses = !e.context.leaveOut.has('x87')
        && region.blocks.some(block=>block.instructions.some(isX87));
    if (!uses)
    {
        return {
            active: false, hasMmx: false, base: 0, form: -1, temp: 0, temp2: 0, temp3: 0,
            states: [], ends: [], cut: new Set(), current: null, controlWritten: false,
        };
    }
    const hasMmx = regionHasMmx(region, e.context.leaveOut);
    const { states, cut, ends } = trackRegion(region, entryTop);
    const base = e.localTypes.length + 2;
    for (let k = 0; k < 11; k++)
    {
        e.localTypes.push(ValType.f64);
    }
    let form = -1;
    if (hasMmx)
    {
        e.localTypes.push(ValType.i32);
        form = base + 11;
    }
    return {
        active: true, hasMmx, base, form, temp: base + 8, temp2: base + 9, temp3: base + 10,
        states, ends, cut, current: null, controlWritten: false,
    };
}


/**
 * The prologue: the empty mask, the status and control words, and every
 * held register into its local.
 *
 * @param {E} e
 */
export function x87Prologue(e){
    const { b, layout } = e;
    const x = e.x87;
    // The top as the machine has it: a block whose stack shape the tracking
    // does not know sets no top of its own, and writes this one back.
    b.i32const(0).load('i32_8u', { offset: layout.x87Top }).localSet(Local.x87Top);
    b.i32const(0).load('i32_8u', { offset: layout.x87Empty }).localSet(Local.x87Empty);
    b.i32const(0).load('i32_16u', { offset: layout.x87Status }).localSet(Local.x87Status);
    b.i32const(0).load('i32_16u', { offset: layout.x87Control }).localSet(Local.x87Control);
    b.i32const(0).localSet(Local.x87Dirty);
    if (x.hasMmx)
    {
        b.i32const(0).localSet(x.form);
    }
    for (let k = 0; k < 8; k++)
    {
        const at = layout.x87 + k * 16;
        // A region with MMX loads every register, not only the held ones: an
        // MMX instruction holds the whole stack, so the x87 after it may read a
        // register the machine had empty, and its value is then whatever the
        // mantissa the state block holds decodes to -- the emulator reads the
        // same bytes, so the two agree.
        if (!x.hasMmx)
        {
            b.localGet(Local.x87Empty).i32const(1 << k).op(I32.and).op(I32.eqz);
            e.openIf(`held${k}`, EMPTY);
        }
        if (layout.x87Format === 'tagged80')
        {
            b.i32const(0).load('i32_16u', { offset: at + 8 }).i32const(RELAXED_TAG).op(I32.eq);
            e.openIf('tagged', EMPTY);
            b.i32const(0).load('i64', { offset: at }).op(F64.reinterpretI64).localSet(x.base + k);
            b.else();
            b.i32const(at).call(/** @type {number} */ (e.context.f80ToF64)).localSet(x.base + k);
            e.close();
            if (x.hasMmx)
            {
                // The form the register enters in: an MMX write before this
                // region left the exponent and sign all ones, which the exit
                // writes back as it found it rather than as a relaxed double.
                b.i32const(0).load('i32_16u', { offset: at + 8 }).i32const(0xffff).op(I32.eq);
                e.openIf(`mmxform${k}`, EMPTY);
                b.localGet(x.form).i32const(1 << k).op(I32.or).localSet(x.form);
                e.close();
            }
        }
        else
        {
            b.i32const(0).load('f64', { offset: at }).localSet(x.base + k);
        }
        if (!x.hasMmx)
        {
            e.close();
        }
    }
}

/**
 * The epilogue: top, the masks and words, and every dirty register back
 * into the state block. The current top is in its local, set at every
 * block start and kept by every push and pop. A region that also translated
 * MMX writes only the words here; its registers go back from the mantissas
 * the mm locals hold, in the form each is in (`storeMixedRegisters`).
 *
 * @param {E} e
 */
export function x87Epilogue(e){
    const { b, layout } = e;
    const x = e.x87;
    b.i32const(0).localGet(Local.x87Top).store('i32_8', { offset: layout.x87Top });
    b.i32const(0).localGet(Local.x87Empty).store('i32_8', { offset: layout.x87Empty });
    b.i32const(0).localGet(Local.x87Status).store('i32_16', { offset: layout.x87Status });
    if (x.controlWritten)
    {
        b.i32const(0).localGet(Local.x87Control).store('i32_16', { offset: layout.x87Control });
    }
    if (x.hasMmx)
    {
        return;
    }
    for (let k = 0; k < 8; k++)
    {
        const at = layout.x87 + k * 16;
        b.localGet(Local.x87Dirty).i32const(1 << k).op(I32.and);
        e.openIf(`dirty${k}`, EMPTY);
        if (layout.x87Format === 'tagged80')
        {
            b.i32const(0).localGet(x.base + k).op(I64.reinterpretF64).store('i64', { offset: at });
            b.i32const(0).i32const(RELAXED_TAG).store('i32_16', { offset: at + 8 });
        }
        else
        {
            b.i32const(0).localGet(x.base + k).store('f64', { offset: at });
        }
        e.close();
    }
}

/**
 * At a block's start: the tracked state becomes current, and the top local
 * is set. A cut block answers false: the caller leaves before it.
 *
 * @param {E} e @param {number} index
 */
export function x87BlockStart(e, index){
    const x = e.x87;
    if (x.cut.has(index))
    {
        x.current = null;
        return false;
    }
    x.current = x.states[index] === null ? null : cloneState(/** @type {StackState} */ (x.states[index]));
    if (x.current !== null)
    {
        e.b.i32const(x.current.top).localSet(Local.x87Top);
    }
    return true;
}

/**
 * Before a jump to another block whose registers are held in other locals
 * than the current state's: moves them, as a permutation, through the
 * scratch local.
 *
 * Answers false when the edge cannot be taken inside the region: the target
 * is compiled for a top the stack arriving here does not have. That is the
 * edge into a region's own entry -- always built for the region's top -- when
 * another path reaches the entry with a different top. The caller leaves
 * instead, and the runtime enters the target at the top the machine has.
 *
 * @param {E} e @param {number} targetIndex
 * @returns {boolean}
 */
export function x87Edge(e, targetIndex){
    const x = e.x87;
    const to = x.states[targetIndex];
    if (!to || x.cut.has(targetIndex))
    {
        return true;
    }
    if (x.current !== null && to.top !== x.current.top)
    {
        return false;
    }
    x87MoveTo(e, to);
    return true;
}

/**
 * Before an exit: the registers back in their own locals, so the epilogue
 * stores local k into register k.
 *
 * @param {E} e
 */
export function x87Normalise(e){
    const x = e.x87;
    if (x.current !== null)
    {
        x87MoveTo(e, { top: x.current.top, slot: [0, 1, 2, 3, 4, 5, 6, 7] });
    }
}

/**
 * Moves the registers from the current state's locals to the target's.
 *
 * @param {E} e @param {StackState} to
 */
function x87MoveTo(e, to){
    const x = e.x87;
    const from = x.current;
    if (!from || sameState(from, to))
    {
        return;
    }
    const { b } = e;
    // Register k is in local from.slot[k] and must be in local to.slot[k]:
    // a permutation of the locals, moved cycle by cycle.
    /** @type {Map<number, number>} destination local -> source local */
    const moves = new Map();
    for (let k = 0; k < 8; k++)
    {
        if (from.slot[k] !== to.slot[k])
        {
            moves.set(to.slot[k], from.slot[k]);
        }
    }
    const done = new Set();
    for (const start of moves.keys())
    {
        if (done.has(start))
        {
            continue;
        }
        // Walk the cycle: save start, then dest <- source along it.
        b.localGet(x.base + start).localSet(x.temp);
        let dest = start;
        for (;;)
        {
            const source = /** @type {number} */ (moves.get(dest));
            done.add(dest);
            if (source === start)
            {
                b.localGet(x.temp).localSet(x.base + dest);
                break;
            }
            b.localGet(x.base + source).localSet(x.base + dest);
            dest = source;
        }
    }
}

/**
 * The x87 view of a physical register an MMX instruction has just written, so
 * the two views of it agree inside the region. On the processor mm<i> is the
 * mantissa of R<i> and an MMX write leaves its exponent and sign all ones, so
 * the value the x87 side reads is what that decodes to: in the emulator's
 * tagged form the negative infinity of a zero mantissa and the positive QNaN
 * indefinite of any other (as `decodeRegister` has it), and in cork's own f64
 * form the mantissa's bits read straight as a double. The form bit is set, so
 * the exit writes the register back in the MMX form -- the mantissa the MMX
 * side holds and the exponent all ones -- and not as a relaxed double.
 *
 * @param {E} e @param {number} physical  the register mm<i> aliases
 * @param {number} mm  the i64 local holding the mantissa just written
 */
export function x87FromMmx(e, physical, mm){
    const x = e.x87;
    if (!x.active || !x.hasMmx || x.current === null)
    {
        return;
    }
    const { b } = e;
    const local = x.base + x.current.slot[physical];
    if (e.layout.x87Format === 'tagged80')
    {
        b.localGet(mm).op(I64.eqz);
        e.openIf('mmxZero', EMPTY);
        b.f64const(-Infinity).localSet(local);
        b.else();
        b.i64const(0x7ff8000000000000n).op(F64.reinterpretI64).localSet(local);
        e.close();
    }
    else
    {
        b.localGet(mm).op(F64.reinterpretI64).localSet(local);
    }
    b.localGet(x.form).i32const(1 << physical).op(I32.or).localSet(x.form);
}

// --- the instruction lowerings ---


/**
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 * @returns {boolean}  false leaves the instruction to the other executor
 */
export function emitX87(e, instruction, flagsLive){
    const x = e.x87;
    if (!x.active || x.current === null)
    {
        if (x.active)
        {
            e.x87RefusalReason = x.cut.has(e.blockIndex) ? 'cut-second-top' : 'no-known-state';
        }
        return false;
    }
    const { b } = e;
    const { op, operands } = instruction;
    const state = x.current;
    const next = step(instruction, state);
    if (next === null)
    {
        // The tracker cannot follow this form (`fxsave`/`fbld` and kin).
        e.x87RefusalReason = 'step-null';
        return false;
    }
    /** The local holding ST(i). @param {number} i */
    const st = i=>x.base + state.slot[(state.top + i) & 7];
    /**
     * Keeps the MMX view of a physical register equal to the x87 view just
     * written into `stLocal`: the mantissa is the double's bits and the form is
     * the relaxed one, so an MMX read of it after this gets what the x87 wrote.
     * Only a region that translates both has the mm locals and the form mask.
     *
     * @param {number} physical @param {number} stLocal
     */
    const syncMm = (physical, stLocal)=>{
        if (!x.hasMmx)
        {
            return;
        }
        b.localGet(stLocal).op(I64.reinterpretF64).localSet(e.mmLocal(physical));
        b.localGet(x.form).i32const(~(1 << physical)).op(I32.and).localSet(x.form);
    };
    /** Marks ST(i) written. @param {number} i */
    const dirty = i=>{
        const physical = (state.top + i) & 7;
        b.localGet(Local.x87Dirty).i32const(1 << physical).op(I32.or)
            .localSet(Local.x87Dirty);
        syncMm(physical, st(i));
    };
    const [dst, src] = operands;
    const push = ()=>{
        // The new top's slot is held and dirty; the value is on the stack.
        const top = (state.top - 1) & 7;
        const local = x.base + state.slot[top];
        b.localSet(local);
        b.localGet(Local.x87Empty).i32const(~(1 << top)).op(I32.and).localSet(Local.x87Empty);
        b.localGet(Local.x87Dirty).i32const(1 << top).op(I32.or).localSet(Local.x87Dirty);
        syncMm(top, local);
        b.i32const(top).localSet(Local.x87Top);
    };

    /** @param {number} times */
    const popN = times=>{
        let top = state.top;
        for (let n = 0; n < times; n++)
        {
            b.localGet(Local.x87Empty).i32const(1 << top).op(I32.or).localSet(Local.x87Empty);
            top = (top + 1) & 7;
        }
        b.i32const(top).localSet(Local.x87Top);
    };
    const finish = ()=>{
        x.current = next;
        return true;
    };
    /** Sets the status bits given. @param {number} mask */
    const setStatus = mask=>{
        b.localGet(Local.x87Status).i32const(mask).op(I32.or).localSet(Local.x87Status);
    };
    /** Pushes the QNaN indefinite. */
    const indefinite = ()=>b.i64const(-0x0008000000000000n).op(F64.reinterpretI64);
    /**
     * The stack-fault check: t1 is set when a source ST(i) is empty or a
     * push finds its register held, and IE and SF are raised. The
     * instruction then produces the indefinite where it would a value. A
     * push that overflowed -- its register already held -- also sets C1, as
     * the processor does to say which way the stack faulted; a region that
     * translated an MMX instruction meets it, since MMX holds every register
     * and the x87 push after it overflows.
     *
     * @param {number[]} sources @param {boolean} pushes
     */
    const guard = (sources, pushes)=>{
        let read = 0;
        for (const i of sources)
        {
            read |= 1 << ((state.top + i) & 7);
        }
        if (read !== 0)
        {
            b.localGet(Local.x87Empty).i32const(read).op(I32.and).i32const(0).op(I32.ne);
        }
        else
        {
            b.i32const(0);
        }
        if (pushes)
        {
            b.localGet(Local.x87Empty).i32const(1 << ((state.top - 1) & 7)).op(I32.and).op(I32.eqz)
                .op(I32.or);
        }
        b.localSet(Local.t1);
        b.localGet(Local.t1);
        e.openIf('fault', EMPTY);
        setStatus(Status.IE | Status.SF);
        e.close();
        if (pushes)
        {
            // C1 is this push's overflow indicator: set when the register it
            // would take is held, cleared when the push succeeds -- the
            // processor leaves C1 saying which way the last push faulted, so a
            // later successful push clears an earlier overflow's mark.
            b.localGet(Local.x87Empty).i32const(1 << ((state.top - 1) & 7)).op(I32.and)
                .op(I32.eqz);
            e.openIf('overflow', EMPTY);
            setStatus(Status.C1);
            b.else();
            b.localGet(Local.x87Status).i32const(~Status.C1).op(I32.and)
                .localSet(Local.x87Status);
            e.close();
        }
    };
    /**
     * Rounds the f64 on the stack to a float when precision control says
     * single (PC = 00): the processor's 24-bit results, as a program that
     * set them expects. Extended is treated as double. Only the arithmetic
     * and the square root are subject to it, as on the processor.
     */
    const byPrecision = ()=>{
        // The mantissa rounded to 24 bits, to nearest even, in the double's
        // own bits: the exponent range stays the extended one, which a demote
        // would not keep. Infinity and NaN pass through.
        // Only under single precision: a branch the common control words
        // never take, where computing both and selecting paid the rounding on
        // every operation.
        b.localSet(x.temp3);
        b.localGet(Local.x87Control).i32const(0x300).op(I32.and).op(I32.eqz);
        e.openIf('single', EMPTY);
        b.localGet(x.temp3).op(I64.reinterpretF64).localSet(Local.t64);
        b.localGet(Local.t64).localGet(Local.t64).i64const(29n).op(I64.shrU).i64const(1n)
            .op(I64.and).op(I64.add).i64const(0x0fffffffn).op(I64.add)
            .i64const(-0x20000000n).op(I64.and).localSet(Local.t64b);
        b.localGet(Local.t64).localGet(Local.t64b);
        b.localGet(Local.t64).i64const(0x7ff0000000000000n).op(I64.and)
            .i64const(0x7ff0000000000000n).op(I64.eq);
        b.select().op(F64.reinterpretI64).localSet(x.temp3);
        e.close();
        b.localGet(x.temp3);
    };
    /** Rounds the f64 on the stack by the control word's rounding control. */
    const byRounding = ()=>{
        b.localGet(Local.x87Control).call(/** @type {number} */ (e.context.round));
    };
    /** Replaces the f64 on the stack by the indefinite when the guard fired. */
    const orIndefinite = ()=>{
        // select keeps the first value when the condition holds: the result
        // when the guard did not fire.
        indefinite();
        b.localGet(Local.t1).op(I32.eqz);
        b.select();
    };

    /**
     * The result on the stack, a NaN the operation itself made given the
     * processor's sign: x86 hands out the negative indefinite, a host whose
     * default NaN is positive hands out the other, and the corpus tells
     * them apart through a store. A NaN that came in as an operand is
     * propagated as it was.
     *
     * @param {number[]} inputs  the locals holding the operands
     */
    const hostNaN = inputs=>{
        if (e.context.features.defaultNaNNegative)
        {
            return;
        }
        // Only when the result is a NaN at all: the common path is one compare.
        b.localSet(x.temp3);
        b.localGet(x.temp3).localGet(x.temp3).op(F64.ne);
        e.openIf('nan', EMPTY);
        b.localGet(x.temp3).f64const(-1).op(F64.copysign);
        b.localGet(x.temp3);
        b.i32const(1);
        for (const input of inputs)
        {
            b.localGet(input).localGet(input).op(F64.eq).op(I32.and);
        }
        b.select().localSet(x.temp3);
        e.close();
        b.localGet(x.temp3);
    };

    switch (op)
    {
        case 'fwait': case 'fnop':
            return finish();
        case 'fnclex':
            // The exception flags, the stack fault, the summary and the busy
            // bit cleared; the condition bits and the top stay.
            b.localGet(Local.x87Status).i32const(0x7f00).op(I32.and).localSet(Local.x87Status);
            return finish();
        case 'fninit':
            b.i32const(0).localSet(Local.x87Top);
            b.i32const(0xff).localSet(Local.x87Empty);
            b.i32const(0).localSet(Local.x87Status);
            b.i32const(DEFAULT_CONTROL).localSet(Local.x87Control);
            x.controlWritten = true;
            return finish();
        case 'fld':
            if (src.kind === 'x87')
            {
                guard([Number(src.reg)], true);
                b.localGet(st(/** @type {number} */ (src.reg)));
            }
            else
            {
                guard([], true);
                loadFloat(e, src);
            }
            orIndefinite();
            push();
            return finish();
        case 'fild':
            guard([], true);
            prepare(e, src);
            b.localGet(Local.addr);
            b.load(src.size === 2 ? 'i64_16s' : src.size === 4 ? 'i64_32s' : 'i64',
                { offset: e.layout.ramBase });
            b.op(F64.convertI64S);
            orIndefinite();
            push();
            return finish();
        case 'fld1': case 'fldz': case 'fldpi': case 'fldl2e': case 'fldln2': case 'fldlg2':
        case 'fldl2t':
            guard([], true);
            b.f64const({
                fld1: 1, fldz: 0, fldpi: Math.PI, fldl2e: Math.LOG2E, fldln2: Math.LN2,
                fldlg2: Math.log10(2), fldl2t: Math.log2(10),
            }[op] ?? 0);
            orIndefinite();
            push();
            return finish();
        case 'fst': case 'fstp':
            guard([0], false);
            if (dst.kind === 'x87')
            {
                const i = /** @type {number} */ (dst.reg);
                b.localGet(st(0));
                orIndefinite();
                b.localSet(st(i));
                dirty(i);
                // The destination is held from here on, whatever it was.
                b.localGet(Local.x87Empty).i32const(~(1 << ((state.top + i) & 7))).op(I32.and)
                    .localSet(Local.x87Empty);
            }
            else
            {
                storeFloat(e, dst, ()=>{
                    b.localGet(st(0));
                    orIndefinite();
                });
            }
            if (op === 'fstp')
            {
                popN(1);
            }
            return finish();
        case 'fist': case 'fistp': case 'fisttp':
            guard([0], false);
            b.localGet(st(0));
            orIndefinite();
            b.localSet(x.temp2);
            storeInt(e, dst, x.temp2, op === 'fisttp');
            if (op !== 'fist')
            {
                popN(1);
            }
            return finish();
        case 'fbstp':
        {
            guard([0], false);
            prepare(e, dst);
            noteStore(e, 10);
            b.localGet(st(0));
            orIndefinite();
            b.localGet(Local.x87Control).call(/** @type {number} */ (e.context.round));
            b.localSet(x.temp2);
            // A NaN or a magnitude past 18 digits raises the invalid operation
            // too.
            b.localGet(x.temp2).op(F64.abs).f64const(1e18).op(F64.ge);
            b.localGet(x.temp2).localGet(x.temp2).op(F64.ne).op(I32.or);
            e.openIf('invalid', EMPTY);
            setStatus(Status.IE);
            e.close();
            b.localGet(x.temp2);
            b.localGet(Local.addr).i32const(e.layout.ramBase).op(I32.add);
            b.call(/** @type {number} */ (e.context.f64ToBcd));
            popN(1);
            return finish();
        }
        case 'fxch':
        {
            // The two registers exchange their values: the tracker relabels the
            // x87 locals, which costs no code. In a region that translates MMX
            // the mantissas and the forms of the two physical registers move with
            // the values, so the mm locals and the form bits swap -- re-deriving
            // them from the x87 locals (as a write does) would lose an MMX-form
            // mantissa, whose x87 local is the indefinite it decodes to. Both
            // registers count as written.
            const i = /** @type {number} */ (src.reg);
            const a = state.top;
            const c = (state.top + i) & 7;
            // An empty register faults, and the registers keep their values.
            guard([0, i], false);
            b.localGet(Local.x87Dirty).i32const((1 << a) | (1 << c)).op(I32.or)
                .localSet(Local.x87Dirty);
            if (x.hasMmx)
            {
                const ma = e.mmLocal(a);
                const mc = e.mmLocal(c);
                b.localGet(ma).localSet(Local.t64);
                b.localGet(mc).localSet(ma);
                b.localGet(Local.t64).localSet(mc);
                b.localGet(x.form).i32const(a).op(I32.shrU).i32const(1).op(I32.and)
                    .localSet(Local.t1);
                b.localGet(x.form).i32const(c).op(I32.shrU).i32const(1).op(I32.and)
                    .localSet(Local.t2);
                b.localGet(x.form).i32const(~((1 << a) | (1 << c))).op(I32.and)
                    .localGet(Local.t1).i32const(c).op(I32.shl).op(I32.or)
                    .localGet(Local.t2).i32const(a).op(I32.shl).op(I32.or).localSet(x.form);
            }
            return finish();
        }

        case 'ffree': case 'ffreep':
        {
            const k = (state.top + /** @type {number} */ (dst.reg)) & 7;
            b.localGet(Local.x87Empty).i32const(1 << k).op(I32.or).localSet(Local.x87Empty);
            if (op === 'ffreep')
            {
                popN(1);
            }
            return finish();
        }
        case 'fincstp': case 'fdecstp':
            b.i32const(next.top).localSet(Local.x87Top);
            return finish();
        case 'fchs':
            guard([0], false);
            b.localGet(st(0)).op(F64.neg);
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        case 'fabs':
            guard([0], false);
            b.localGet(st(0)).op(F64.abs);
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        case 'fsqrt':
            guard([0], false);
            // A negative other than -0 is invalid: IE, and the result is a NaN.
            b.localGet(st(0)).f64const(0).op(F64.lt);
            e.openIf('negative', EMPTY);
            setStatus(Status.IE);
            e.close();
            b.localGet(st(0)).localTee(x.temp).op(F64.sqrt);
            hostNaN([x.temp]);
            byPrecision();
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        case 'fldcw':
            prepare(e, src ?? dst);
            b.localGet(Local.addr).load('i32_16u', { offset: e.layout.ramBase })
                .localSet(Local.x87Control);
            x.controlWritten = true;
            return finish();
        case 'frndint':
            guard([0], false);
            b.localGet(st(0));
            byRounding();
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        case 'fscale':
        {
            // ST0 * 2^trunc(ST1), the power applied in two clamped steps so an
            // exponent past a double's range still lands where it should.
            guard([0, 1], false);
            // The guard's flag is t1: the scratch here is t0 and count.
            // n = trunc(ST1) clamped to ±2100 (a NaN becomes 0 through the saturation).
            b.localGet(st(1)).op(F64.trunc).f64const(2100).op(0xa4).f64const(-2100).op(0xa5)
                .op(TRUNC_SAT_I32[0], [TRUNC_SAT_I32[1]]).localSet(Local.count);
            b.localGet(st(0));
            for (let pass = 0; pass < 2; pass++)
            {
                // k = clamp(n, -1022, 1023); value *= 2^k; n -= k
                b.i32const(-1022).localGet(Local.count).localGet(Local.count).i32const(-1022)
                    .op(0x4c).select().localSet(Local.t0);
                b.i32const(1023).localGet(Local.t0).localGet(Local.t0).i32const(1023).op(0x4e)
                    .select().localSet(Local.t0);
                b.localGet(Local.t0).i32const(1023).op(I32.add).op(I64.extendU).i64const(52n)
                    .op(I64.shl).op(F64.reinterpretI64).op(F64.mul);
                b.localGet(Local.count).localGet(Local.t0).op(I32.sub).localSet(Local.count);
            }
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        }
        case 'fxtract':
        {
            // ST0 becomes the exponent and the significand is pushed: for a
            // normal, from the double's fields; zero gives -inf and ZE; a
            // denormal is scaled up first.
            guard([0], true);
            b.localGet(st(0)).localSet(x.temp);
            b.localGet(x.temp).f64const(0).op(F64.eq);
            e.openIf('zero', EMPTY);
            setStatus(Status.ZE);
            b.f64const(-Infinity).localSet(x.temp2);
            b.else();
            b.localGet(x.temp).op(F64.abs).f64const(2 ** -1022).op(F64.lt);
            e.openIf('denormal', EMPTY);
            b.localGet(x.temp).f64const(2 ** 54).op(F64.mul).localSet(x.temp);
            b.f64const(-54).localSet(x.temp2);
            b.else();
            b.f64const(0).localSet(x.temp2);
            e.close();
            b.localGet(x.temp).op(I64.reinterpretF64).i64const(52n).op(I64.shrU).op(I64.wrap)
                .i32const(0x7ff).op(I32.and).i32const(1023).op(I32.sub).op(F64.convertI32S);
            b.localGet(x.temp2).op(F64.add).localSet(x.temp2);
            // The significand: the exponent field set to 1023.
            b.localGet(x.temp).op(I64.reinterpretF64).i64const(-0x7ff0000000000001n).op(I64.and)
                .i64const(0x3ff0000000000000n).op(I64.or).op(F64.reinterpretI64).localSet(x.temp);
            e.close();
            // Infinity and NaN keep their value in both.
            b.localGet(x.temp).localGet(x.temp).op(F64.ne);
            b.localGet(x.temp).op(F64.abs).f64const(Infinity).op(F64.eq).op(I32.or);
            e.openIf('special', EMPTY);
            b.localGet(st(0)).localSet(x.temp);
            b.localGet(st(0)).localSet(x.temp2);
            e.close();
            b.localGet(x.temp2);
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            b.localGet(x.temp);
            orIndefinite();
            push();
            return finish();
        }
        case 'fsin': case 'fcos': case 'fsincos': case 'fptan':
        {
            // Out of the reduction range (|x| >= 2^63) the register is left
            // and C2 says so; the emulator has no such limit, and a program
            // that meets it is past the point of a meaningful answer.
            const math = e.context.math;
            guard([0], op === 'fsincos' || op === 'fptan');
            b.localGet(Local.x87Status).i32const(~Status.C2).op(I32.and).localSet(Local.x87Status);
            b.localGet(st(0)).localSet(x.temp);
            b.localGet(x.temp).op(F64.abs).f64const(2 ** 63).op(F64.lt);
            b.localGet(x.temp).localGet(x.temp).op(F64.eq).op(I32.and); // and not a NaN
            b.localGet(Local.t1).op(I32.eqz).op(I32.and);
            e.openIf('reduced', EMPTY);
            if (op === 'fsincos')
            {
                b.localGet(x.temp).call(math.sin);
                b.localSet(st(0));
                dirty(0);
                b.localGet(x.temp).call(math.cos);
                push();
            }
            else if (op === 'fptan')
            {
                b.localGet(x.temp).call(math.tan);
                b.localSet(st(0));
                dirty(0);
                b.f64const(1);
                push();
            }
            else
            {
                b.localGet(x.temp).call(op === 'fsin' ? math.sin : math.cos);
                b.localSet(st(0));
                dirty(0);
            }
            b.else();
            // A NaN or an empty register: the indefinite in ST0 (and a push of
            // it); out of range: C2 and nothing else.
            b.localGet(x.temp).localGet(x.temp).op(F64.ne).localGet(Local.t1).op(I32.or);
            e.openIf('invalid', EMPTY);
            indefinite();
            b.localSet(st(0));
            dirty(0);
            if (op === 'fsincos' || op === 'fptan')
            {
                indefinite();
                push();
            }
            b.else();
            setStatus(Status.C2);
            e.close();
            e.close();
            // The tracker's state is the one with the push; the no-push path
            // is left on an exit with C2, which a program does not take.
            if (op === 'fsincos' || op === 'fptan')
            {
                b.i32const(next.top).localSet(Local.x87Top);
            }
            return finish();
        }
        case 'fpatan':
        {
            // ST1 = atan2(ST1, ST0), then a pop.
            guard([0, 1], false);
            b.localGet(st(1)).localGet(st(0)).call(e.context.math.atan2);
            orIndefinite();
            b.localSet(st(1));
            dirty(1);
            popN(1);
            return finish();
        }
        case 'f2xm1':
            guard([0], false);
            b.localGet(st(0)).call(e.context.math.exp2m1);
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        case 'fyl2x': case 'fyl2xp1':
        {
            // ST1 = ST1 * log2(ST0) (or of ST0 + 1), then a pop: a zero
            // argument is a zero-divide, a negative one invalid.
            const math = e.context.math;
            guard([0, 1], false);
            b.localGet(st(0)).localSet(x.temp);
            if (op === 'fyl2x')
            {
                b.localGet(x.temp).f64const(0).op(F64.eq);
                b.localGet(st(1)).op(F64.abs).f64const(Infinity).op(F64.lt).op(I32.and);
                b.localGet(st(1)).f64const(0).op(F64.ne).op(I32.and);
                e.openIf('zero', EMPTY);
                setStatus(Status.ZE);
                e.close();
                b.localGet(x.temp).f64const(0).op(F64.lt);
                e.openIf('negative', EMPTY);
                setStatus(Status.IE);
                e.close();
                b.localGet(st(1)).localGet(x.temp).call(math.log2).op(F64.mul);
            }
            else
            {
                b.localGet(x.temp).f64const(-1).op(F64.lt);
                e.openIf('negative', EMPTY);
                setStatus(Status.IE);
                e.close();
                b.localGet(st(1)).localGet(x.temp).call(math.log1p).f64const(Math.LN2).op(F64.div)
                    .op(F64.mul);
            }
            orIndefinite();
            b.localSet(st(1));
            dirty(1);
            popN(1);
            return finish();
        }
        case 'fprem': case 'fprem1':
        {
            // The partial remainder: ST0 - Q * ST1 with Q the quotient rounded
            // toward zero (fprem) or to nearest (fprem1); when the quotient
            // would not fit 64 bits only a partial reduction is done and C2
            // says so. C0, C3 and C1 carry the quotient's bits 2, 1 and 0.
            guard([0, 1], false);
            b.localGet(st(0)).localSet(x.temp);
            b.localGet(st(1)).localSet(x.temp2);
            // Invalid: a NaN, an infinite dividend, a zero divisor: the
            // indefinite, IE, and the condition bits left as they were.
            b.localGet(x.temp).localGet(x.temp).op(F64.ne);
            b.localGet(x.temp2).localGet(x.temp2).op(F64.ne).op(I32.or);
            b.localGet(x.temp).op(F64.abs).f64const(Infinity).op(F64.eq).op(I32.or);
            b.localGet(x.temp2).f64const(0).op(F64.eq).op(I32.or);
            b.localGet(Local.t1).op(I32.or);
            e.openIf('invalid', EMPTY);
            setStatus(Status.IE);
            indefinite();
            b.localSet(st(0));
            b.else();
            b.localGet(Local.x87Status).i32const(~(Status.C2 | Status.C0 | Status.C3 | Status.C1))
                .op(I32.and).localSet(Local.x87Status);
            // The quotient, and whether its magnitude fits.
            b.localGet(x.temp).localGet(x.temp2).op(F64.div).localSet(x.temp3);
            b.localGet(x.temp3).op(F64.abs).f64const(2 ** 63).op(F64.lt);
            e.openIf('fits', EMPTY);
            b.localGet(x.temp3).op(op === 'fprem' ? F64.trunc : F64.nearest).localSet(x.temp3);
            b.localGet(x.temp).localGet(x.temp3).localGet(x.temp2).op(F64.mul).op(F64.sub)
                .localSet(st(0));
            // The low three bits of the quotient into C0 (bit 2), C3 (bit 1), C1 (bit 0).
            b.localGet(x.temp3).op(F64.abs).op(TRUNC_SAT_I64[0], [TRUNC_SAT_I64[1]]).op(I64.wrap)
                .localSet(Local.t2);
            b.localGet(Local.t2).i32const(4).op(I32.and).i32const(Status.C0 / 4).op(0x6c);
            b.localGet(Local.t2).i32const(2).op(I32.and).i32const(Status.C3 / 2).op(0x6c)
                .op(I32.or);
            b.localGet(Local.t2).i32const(1).op(I32.and).i32const(Status.C1).op(0x6c).op(I32.or);
            b.localGet(Local.x87Status).op(I32.or).localSet(Local.x87Status);
            b.else();
            // Partial: reduce by the quotient scaled down to fit, C2 set.
            b.localGet(x.temp3).f64const(2 ** -32).op(F64.mul).op(F64.trunc).f64const(2 ** 32)
                .op(F64.mul).localSet(x.temp3);
            b.localGet(x.temp).localGet(x.temp3).localGet(x.temp2).op(F64.mul).op(F64.sub)
                .localSet(st(0));
            setStatus(Status.C2);
            e.close();
            e.close();
            dirty(0);
            return finish();
        }
        case 'fadd': case 'fsub': case 'fsubr': case 'fmul': case 'fdiv': case 'fdivr':
        case 'faddp': case 'fsubp': case 'fsubrp': case 'fmulp': case 'fdivp': case 'fdivrp':
        case 'fiadd': case 'fisub': case 'fisubr': case 'fimul': case 'fidiv': case 'fidivr':
        {
            const base = op.replace(/^fi/, 'f').replace(/p$/, '');
            const reversed = base.endsWith('r');
            const kind = reversed ? base.slice(0, -1) : base;
            const target = dst.kind === 'x87' ? /** @type {number} */ (dst.reg) : 0;
            guard(src.kind === 'x87' ? [target, /** @type {number} */ (src.reg)] : [target], false);
            // Operands: the destination register, and the source (a register,
            // a float in memory, or an integer in memory).
            b.localGet(st(target)).localSet(x.temp);
            if (src.kind === 'x87')
            {
                b.localGet(st(/** @type {number} */ (src.reg)));
            }
            else if (op.startsWith('fi'))
            {
                prepare(e, src);
                b.localGet(Local.addr);
                b.load(src.size === 2 ? 'i32_16s' : 'i32', { offset: e.layout.ramBase });
                b.op(F64.convertI32S);
            }
            else
            {
                loadFloat(e, src);
            }
            b.localSet(x.temp2);
            const [a, c] = reversed ? [x.temp2, x.temp] : [x.temp, x.temp2];
            b.localGet(a).localGet(c).op(/** @type {number} */ ({
                fadd: F64.add, fsub: F64.sub, fmul: F64.mul, fdiv: F64.div,
            }[kind]));
            byPrecision();
            hostNaN([x.temp, x.temp2]);
            orIndefinite();
            b.localSet(st(target));
            // The exceptions of a sound operation: a zero-divide of a finite
            // nonzero, and an invalid NaN out of inputs that were not NaN.
            b.localGet(Local.t1).op(I32.eqz);
            e.openIf('sound', EMPTY);
            if (kind === 'fdiv')
            {
                b.localGet(c).f64const(0).op(F64.eq);
                b.localGet(a).f64const(0).op(F64.ne);
                b.localGet(a).op(F64.abs).f64const(Infinity).op(F64.lt);
                b.op(I32.and).op(I32.and);
                e.openIf('zero', EMPTY);
                setStatus(Status.ZE);
                e.close();
            }
            // The result a NaN first -- one compare on the common path -- and
            // only then whether the inputs were not.
            b.localGet(st(target)).localGet(st(target)).op(F64.ne);
            e.openIf('nan', EMPTY);
            b.localGet(x.temp).localGet(x.temp).op(F64.eq);
            b.localGet(x.temp2).localGet(x.temp2).op(F64.eq).op(I32.and);
            e.openIf('invalid', EMPTY);
            setStatus(Status.IE);
            e.close();
            e.close();
            e.close();
            dirty(target);
            if (op.endsWith('p'))
            {
                popN(1);
            }
            return finish();
        }
        case 'fcom': case 'fcomp': case 'fcompp': case 'fucom': case 'fucomp': case 'fucompp':
        case 'ftst': case 'ficom': case 'ficomp':
        {
            if (op === 'ficom' || op === 'ficomp')
            {
                guard([0], false);
                prepare(e, src);
                b.localGet(Local.addr);
                b.load(src.size === 2 ? 'i32_16s' : 'i32', { offset: e.layout.ramBase });
                b.op(F64.convertI32S).localSet(x.temp2);
            }
            else if (op === 'ftst')
            {
                guard([0], false);
                b.f64const(0).localSet(x.temp2);
            }
            else if (op === 'fcompp' || op === 'fucompp')
            {
                guard([0, 1], false);
                b.localGet(st(1)).localSet(x.temp2);
            }
            else if (src.kind === 'x87')
            {
                guard([0, /** @type {number} */ (src.reg)], false);
                b.localGet(st(/** @type {number} */ (src.reg))).localSet(x.temp2);
            }
            else
            {
                guard([0], false);
                loadFloat(e, src);
                b.localSet(x.temp2);
            }
            conditionBits(e, st(0), x.temp2, !op.startsWith('fu'));
            popN(op.endsWith('pp') ? 2 : op.endsWith('p') ? 1 : 0);
            return finish();
        }
        case 'fcomi': case 'fcomip': case 'fucomi': case 'fucomip':
        {
            guard([0, /** @type {number} */ (src.reg)], false);
            b.localGet(st(/** @type {number} */ (src.reg))).localSet(x.temp2);
            const a = st(0);
            const c = x.temp2;
            // Unordered (a NaN, or an empty register): ZF = PF = CF = 1; and
            // invalid for fcomi, or an SNaN.
            b.localGet(a).localGet(a).op(F64.ne).localGet(c).localGet(c).op(F64.ne).op(I32.or);
            b.localGet(Local.t1).op(I32.or);
            b.localSet(Local.t1);
            if (flagsLive)
            {
                e.eagerWrite(CF | PF | AF | ZF | SF | OF);
                b.localGet(Local.t1);
                e.orFlag(PF);
                b.localGet(Local.t1).localGet(a).localGet(c).op(F64.eq).op(I32.or);
                e.orFlag(ZF);
                b.localGet(Local.t1).localGet(a).localGet(c).op(F64.lt).op(I32.or);
                e.orFlag(CF);
            }
            b.localGet(Local.t1);
            if (op.startsWith('fu'))
            {
                signalling(e, a, c);
                b.op(I32.and);
            }
            e.openIf('invalid', EMPTY);
            setStatus(Status.IE);
            e.close();
            b.localGet(Local.x87Status).i32const(~Status.C1).op(I32.and).localSet(Local.x87Status);
            popN(op.endsWith('p') ? 1 : 0);
            return finish();
        }
        case 'fcmovb': case 'fcmove': case 'fcmovbe': case 'fcmovu':
        case 'fcmovnb': case 'fcmovne': case 'fcmovnbe': case 'fcmovnu':
            guard([0, /** @type {number} */ (src.reg)], false);
            b.localGet(st(/** @type {number} */ (src.reg)));
            b.localGet(st(0));
            e.pushCondition(/** @type {number} */ (instruction.cc));
            b.select();
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        case 'fxam':
        {
            // C3 C2 C0: empty 101, NaN 001, infinity 011, zero 100, normal 010; C1 the sign.
            const v = st(0);
            b.localGet(Local.x87Status).i32const(~Status.CONDITION).op(I32.and)
                .localSet(Local.x87Status);
            b.localGet(v).op(I64.reinterpretF64).i64const(0n).op(I64.ltS);
            e.openIf('negative', EMPTY);
            setStatus(Status.C1);
            e.close();
            b.localGet(Local.x87Empty).i32const(1 << state.top).op(I32.and);
            e.openIf('empty', EMPTY);
            setStatus(Status.C3 | Status.C0);
            b.else();
            b.localGet(v).localGet(v).op(F64.ne);
            e.openIf('nan', EMPTY);
            setStatus(Status.C0);
            b.else();
            b.localGet(v).op(F64.abs).f64const(Infinity).op(F64.eq);
            e.openIf('infinite', EMPTY);
            setStatus(Status.C2 | Status.C0);
            b.else();
            b.localGet(v).f64const(0).op(F64.eq);
            e.openIf('zero', EMPTY);
            setStatus(Status.C3);
            b.else();
            setStatus(Status.C2);
            e.close();
            e.close();
            e.close();
            e.close();
            return finish();
        }
        case 'fnstsw':
            b.localGet(Local.x87Status).i32const(~0x3800).op(I32.and)
                .i32const(state.top << 11).op(I32.or);
            if (dst.kind === 'reg')
            {
                writeReg(e, 0, 2, false);
            }
            else
            {
                b.localSet(Local.t1);
                prepare(e, dst);
                noteStore(e, 2);
                b.localGet(Local.addr).localGet(Local.t1)
                    .store('i32_16', { offset: e.layout.ramBase });
            }
            return finish();
        case 'fnstcw':
            prepare(e, dst);
            noteStore(e, 2);
            b.localGet(Local.addr).localGet(Local.x87Control)
                .store('i32_16', { offset: e.layout.ramBase });
            return finish();
        case 'fnstenv': case 'fnsave':
        {
            // The 32-bit protected-mode environment: control, status with
            // the top, the tag word, and the instruction and data pointers,
            // which this engine does not keep (zero, as the other executor
            // has them). fnsave follows with the eight registers in stack
            // order as ten-byte values, and leaves the unit as fninit does.
            const save = op === 'fnsave';
            prepare(e, { ...dst, size: save ? 108 : 28 });
            noteStore(e, save ? 108 : 28);
            const ram = e.layout.ramBase;
            b.localGet(Local.addr).localGet(Local.x87Control).i32const(0xffff0000 | 0)
                .op(I32.or).store('i32', { offset: ram });
            b.localGet(Local.addr).localGet(Local.x87Status).i32const(~0x3800).op(I32.and)
                .i32const((state.top << 11) | (0xffff0000 | 0)).op(I32.or)
                .store('i32', { offset: ram + 4 });
            // The tag word, two bits per physical register: valid 0, zero 1,
            // special (infinite or NaN) 2, empty 3.
            b.i32const(0xffff0000 | 0).localSet(Local.t1);
            for (let k = 0; k < 8; k++)
            {
                const local = x.base + state.slot[k];
                b.i32const(3);
                b.i32const(1);
                b.i32const(2);
                b.i32const(0);
                b.localGet(local).localGet(local).op(F64.sub).f64const(0).op(F64.ne);
                b.select();
                b.localGet(local).f64const(0).op(F64.eq);
                b.select();
                b.localGet(Local.x87Empty).i32const(1 << k).op(I32.and);
                b.select();
                b.i32const(2 * k).op(I32.shl).localGet(Local.t1).op(I32.or).localSet(Local.t1);
            }
            b.localGet(Local.addr).localGet(Local.t1).store('i32', { offset: ram + 8 });
            b.localGet(Local.addr).i32const(0).store('i32', { offset: ram + 12 });
            b.localGet(Local.addr).i32const(0).store('i32', { offset: ram + 16 });
            b.localGet(Local.addr).i32const(0).store('i32', { offset: ram + 20 });
            b.localGet(Local.addr).i32const(0xffff0000 | 0).store('i32', { offset: ram + 24 });
            if (save)
            {
                for (let i = 0; i < 8; i++)
                {
                    b.localGet(st(i));
                    b.localGet(Local.addr).i32const(ram + 28 + 10 * i).op(I32.add);
                    b.call(/** @type {number} */ (e.context.f64ToF80));
                }
                b.i32const(0).localSet(Local.x87Top);
                b.i32const(0xff).localSet(Local.x87Empty);
                b.i32const(0).localSet(Local.x87Status);
                b.i32const(DEFAULT_CONTROL).localSet(Local.x87Control);
                x.controlWritten = true;
            }
            return finish();
        }
        case 'fldenv': case 'frstor':
        {
            // The environment back, and for frstor the eight registers in
            // stack order into their physical locals. The top it sets is
            // known only at run time, and every block here is compiled for
            // one: the instruction leaves for the next block, which the
            // entry hash enters compiled for whatever the top now is.
            const restore = op === 'frstor';
            prepare(e, { ...(src ?? dst), size: restore ? 108 : 28 });
            const ram = e.layout.ramBase;
            b.localGet(Local.addr).load('i32_16u', { offset: ram }).localSet(Local.x87Control);
            x.controlWritten = true;
            b.localGet(Local.addr).load('i32_16u', { offset: ram + 4 }).localSet(Local.t1);
            b.localGet(Local.t1).i32const(~0x3800).op(I32.and).localSet(Local.x87Status);
            b.localGet(Local.t1).i32const(11).op(I32.shrU).i32const(7).op(I32.and)
                .localSet(Local.x87Top);
            b.localGet(Local.addr).load('i32_16u', { offset: ram + 8 }).localSet(Local.t2);
            b.i32const(0).localSet(Local.x87Empty);
            for (let k = 0; k < 8; k++)
            {
                b.localGet(Local.t2).i32const(2 * k).op(I32.shrU).i32const(3).op(I32.and)
                    .i32const(3).op(I32.eq).i32const(k).op(I32.shl)
                    .localGet(Local.x87Empty).op(I32.or).localSet(Local.x87Empty);
            }
            if (restore)
            {
                // Physical register k holds ST((k - top) & 7), the value at
                // 28 + 10 * that in the block.
                for (let k = 0; k < 8; k++)
                {
                    b.i32const(k).localGet(Local.x87Top).op(I32.sub).i32const(7).op(I32.and)
                        .i32const(10).op(I32.mul);
                    b.localGet(Local.addr).op(I32.add).i32const(ram + 28).op(I32.add);
                    b.call(/** @type {number} */ (e.context.f80ToF64));
                    b.localSet(x.base + state.slot[k]);
                }
                b.i32const(0xff).localSet(Local.x87Dirty);
            }
            finish();
            e.exitAt(instruction.eip + instruction.length, Exit.UNTRANSLATED);
            e.dead = true;
            return true;
        }
        default:
            e.x87RefusalReason = 'unhandled-form';
            return false;
    }
}

/**
 * Pushes the f64 at a float memory operand: m32, m64 or m80.
 *
 * @param {E} e @param {Operand} operand
 */
function loadFloat(e, operand){
    const { b } = e;
    prepare(e, operand);
    // A signalling NaN read from memory is an invalid operand: IE, and the
    // value goes on quiet. The quiet bit is the top fraction bit of each width.
    if (operand.size === 10)
    {
        b.localGet(Local.addr).load('i32_16u', { offset: e.layout.ramBase + 8 })
            .i32const(0x7fff).op(I32.and).i32const(0x7fff).op(I32.eq);
        b.localGet(Local.addr).load('i64', { offset: e.layout.ramBase })
            .i64const(0x7fffffffffffffffn).op(I64.and).i64const(0x4000000000000000n)
            .op(I64.gtS).op(I32.and);
        e.openIf('signalling', EMPTY);
        b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
        e.close();
        b.localGet(Local.addr).i32const(e.layout.ramBase).op(I32.add)
            .call(/** @type {number} */ (e.context.f80ToF64));
        return;
    }
    if (operand.size === 4)
    {
        // All-ones exponent with the quiet bit clear first (an infinity or a
        // signalling NaN), one compare on the common path; the fraction after.
        b.localGet(Local.addr).load('i32', { offset: e.layout.ramBase }).localSet(Local.t2);
        b.localGet(Local.t2).i32const(0x7fc00000).op(I32.and).i32const(0x7f800000).op(I32.eq);
        e.openIf('signalling', EMPTY);
        b.localGet(Local.t2).i32const(0x3fffff).op(I32.and);
        e.openIf('nan', EMPTY);
        b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
        b.localGet(Local.t2).i32const(0x400000).op(I32.or).localSet(Local.t2);
        e.close();
        e.close();
        b.localGet(Local.t2).op(0xbe).op(F64.promoteF32); // f32.reinterpret_i32
        return;
    }
    b.localGet(Local.addr).load('i64', { offset: e.layout.ramBase }).localSet(Local.t64);
    b.localGet(Local.t64).i64const(0x7ff8000000000000n).op(I64.and)
        .i64const(0x7ff0000000000000n).op(I64.eq);
    e.openIf('signalling', EMPTY);
    b.localGet(Local.t64).i64const(0x0007ffffffffffffn).op(I64.and).i64const(0n).op(I64.ne);
    e.openIf('nan', EMPTY);
    b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
    b.localGet(Local.t64).i64const(0x0008000000000000n).op(I64.or).localSet(Local.t64);
    e.close();
    e.close();
    b.localGet(Local.t64).op(F64.reinterpretI64);
}

/**
 * Stores the f64 `pushValue` pushes at a float memory operand.
 *
 * @param {E} e @param {Operand} operand @param {() => void} pushValue
 */
function storeFloat(e, operand, pushValue){
    const { b } = e;
    prepare(e, operand);
    noteStore(e, operand.size);
    if (operand.size === 10)
    {
        pushValue();
        b.localGet(Local.addr).i32const(e.layout.ramBase).op(I32.add);
        b.call(/** @type {number} */ (e.context.f64ToF80));
        return;
    }
    if (operand.size === 4)
    {
        // A nonzero value below the smallest normal single underflows: UE
        // (masked: the store still happens, denormal or zero).
        pushValue();
        b.localSet(e.x87.temp);
        b.localGet(e.x87.temp).op(F64.abs).f64const(2 ** -126).op(F64.lt);
        b.localGet(e.x87.temp).f64const(0).op(F64.ne).op(I32.and);
        e.openIf('underflow', EMPTY);
        b.localGet(Local.x87Status).i32const(Status.UE).op(I32.or).localSet(Local.x87Status);
        e.close();
        b.localGet(Local.addr).localGet(e.x87.temp).op(F32.demoteF64)
            .store('f32', { offset: e.layout.ramBase });
        return;
    }
    b.localGet(Local.addr);
    pushValue();
    b.store('f64', { offset: e.layout.ramBase });
}

/**
 * Stores the register as an integer of the operand's width, rounded to
 * nearest (or truncated); a NaN or a value out of range stores the integer
 * indefinite and raises IE.
 *
 * @param {E} e @param {Operand} operand @param {number} local @param {boolean} truncate
 */
function storeInt(e, operand, local, truncate){
    const { b } = e;
    prepare(e, operand);
    noteStore(e, operand.size);
    b.localGet(local);
    if (truncate)
    {
        b.op(F64.trunc);
    }
    else
    {
        b.localGet(Local.x87Control).call(/** @type {number} */ (e.context.round));
    }
    b.localSet(e.x87.temp);
    const rounded = e.x87.temp;
    const limit = operand.size === 2 ? 32768
        : operand.size === 4 ? 2147483648 : 9223372036854775808;
    // In range: -limit <= v < limit; a NaN fails both compares.
    b.localGet(rounded).f64const(-limit).op(F64.ge);
    b.localGet(rounded).f64const(limit).op(F64.lt);
    b.op(I32.and).op(I32.eqz);
    e.openIf('indefinite', EMPTY);
    b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
    b.localGet(Local.addr);
    if (operand.size === 8)
    {
        b.i64const(-0x8000000000000000n).store('i64', { offset: e.layout.ramBase });
    }
    else
    {
        b.i32const(operand.size === 2 ? 0x8000 : -0x80000000)
            .store(operand.size === 2 ? 'i32_16' : 'i32', { offset: e.layout.ramBase });
    }
    b.else();
    b.localGet(Local.addr).localGet(rounded);
    if (operand.size === 8)
    {
        b.op(TRUNC_SAT_I64[0], [TRUNC_SAT_I64[1]]).store('i64', { offset: e.layout.ramBase });
    }
    else
    {
        b.op(TRUNC_SAT_I32[0], [TRUNC_SAT_I32[1]])
            .store(operand.size === 2 ? 'i32_16' : 'i32', { offset: e.layout.ramBase });
    }
    e.close();
}

/**
 * Compares two locals into C3 C2 C0 (equal, unordered, less): unordered
 * sets all three; C1 is cleared. IE on any NaN for the ordered compare, on
 * a signalling NaN for the unordered one.
 *
 * @param {E} e @param {number} a @param {number} c @param {boolean} ordered
 */
function conditionBits(e, a, c, ordered){
    const { b } = e;
    b.localGet(Local.x87Status).i32const(~Status.CONDITION).op(I32.and).localSet(Local.x87Status);
    // Unordered: a NaN, or the guard's empty register already in t1.
    b.localGet(a).localGet(a).op(F64.ne).localGet(c).localGet(c).op(F64.ne).op(I32.or);
    b.localGet(Local.t1).op(I32.or);
    b.localSet(Local.t1);
    b.localGet(Local.t1);
    e.openIf('unordered', EMPTY);
    b.localGet(Local.x87Status).i32const(Status.C3 | Status.C2 | Status.C0).op(I32.or)
        .localSet(Local.x87Status);
    if (ordered)
    {
        b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
    }
    else
    {
        signalling(e, a, c);
        e.openIf('signalling', EMPTY);
        b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
        e.close();
    }
    b.else();
    b.localGet(a).localGet(c).op(F64.eq).i32const(Status.C3).op(0x6c); // i32.mul
    b.localGet(a).localGet(c).op(F64.lt).i32const(Status.C0).op(0x6c);
    b.op(I32.or).localGet(Local.x87Status).op(I32.or).localSet(Local.x87Status);
    e.close();
}

/**
 * Pushes 1 when either local is a signalling NaN (a NaN with bit 51 clear).
 *
 * @param {E} e @param {number} a @param {number} c
 */
function signalling(e, a, c){
    const { b } = e;
    for (const local of [a, c])
    {
        b.localGet(local).localGet(local).op(F64.ne);
        b.localGet(local).op(I64.reinterpretF64).i64const(1n << 51n).op(I64.and).op(I64.eqz);
        b.op(I32.and);
    }
    b.op(I32.or);
}

/**
 * The rounding helper a module carries: `round(value, control) → f64`
 * rounds to an integer by the control word's rounding control: nearest
 * (even), down, up, toward zero.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @returns {number} the function index
 */
export function addRoundHelper(m){
    const type = m.type({ params: [ValType.f64, ValType.i32], results: [ValType.f64] });
    const b = new Body();
    // locals: 0 value, 1 control, 2 rc
    b.localGet(1).i32const(10).op(I32.shrU).i32const(3).op(I32.and).localSet(2);
    // select keeps the first value when the condition holds: the value so far
    // unless the mode is the one just pushed.
    b.localGet(0).op(F64.nearest);
    b.localGet(0).op(0x9c); // f64.floor
    b.localGet(2).i32const(1).op(I32.ne);
    b.select();
    b.localGet(0).op(0x9b); // f64.ceil
    b.localGet(2).i32const(2).op(I32.ne);
    b.select();
    b.localGet(0).op(F64.trunc);
    b.localGet(2).i32const(3).op(I32.ne);
    b.select();
    return m.function(type, [ValType.i32], b.toBytes());
}

/**
 * The two conversion helpers a module carries: `f80ToF64(wasmAddress) →
 * f64` reads a ten-byte extended value; `f64ToF80(value, wasmAddress)`
 * writes one. The mantissa's low eleven bits have no place in a double
 * and go with the rounding of the conversion.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @returns {{ f80ToF64: number, f64ToF80: number }}
 */
export function addF80Helpers(m){
    const f80ToF64 = (()=>{
        const type = m.type({ params: [ValType.i32], results: [ValType.f64] });
        // locals: 0 address; 1 mantissa (i64); 2 signExponent (i32); 3 value (f64); 4 e (i32)
        const b = new Body();
        b.localGet(0).load('i64', { offset: 0 }).localSet(1);
        b.localGet(0).load('i32_16u', { offset: 8 }).localSet(2);
        b.block(EMPTY);
        // infinity or NaN
        b.localGet(2).i32const(0x7fff).op(I32.and).i32const(0x7fff).op(I32.eq);
        b.if(EMPTY);
        b.localGet(1).i64const(1n).op(I64.shl).op(I64.eqz);
        b.if(EMPTY);
        b.f64const(Infinity).localSet(3);
        b.else();
        b.f64const(NaN).localSet(3);
        b.end();
        b.br(1);
        b.end();
        // zero
        b.localGet(1).op(I64.eqz);
        b.if(EMPTY);
        b.f64const(0).localSet(3);
        b.br(1);
        b.end();
        // mantissa as f64 (rounded to 53 bits) times 2^(exponent - 16383 - 63), in two scalings
        b.localGet(1).op(F64.convertI64U).localSet(3);
        b.localGet(2).i32const(0x7fff).op(I32.and).i32const(16446).op(I32.sub).localSet(4);
        for (let pass = 0; pass < 2; pass++)
        {
            // k = clamp(e, -1022, 1023); value *= 2^k; e -= k
            b.i32const(-1022).localGet(4).localGet(4).i32const(-1022).op(0x4c).select(); // i32.le_s
            b.localSet(5);
            b.i32const(1023).localGet(5).localGet(5).i32const(1023).op(0x4e).select(); // i32.ge_s
            b.localSet(5);
            b.localGet(3).localGet(5).i32const(1023).op(I32.add).op(I64.extendU)
                .i64const(52n).op(I64.shl).op(F64.reinterpretI64).op(F64.mul).localSet(3);
            b.localGet(4).localGet(5).op(I32.sub).localSet(4);
        }
        b.end();
        // the sign
        b.localGet(2).i32const(0x8000).op(I32.and);
        b.if(EMPTY);
        b.localGet(3).op(F64.neg).localSet(3);
        b.end();
        b.localGet(3);
        return m.function(type, [ValType.i64, ValType.i32, ValType.f64, ValType.i32, ValType.i32],
            b.toBytes());
    })();
    const f64ToF80 = (()=>{
        const type = m.type({ params: [ValType.f64, ValType.i32], results: [] });
        // locals: 0 value; 1 address; 2 bits (i64); 3 fraction (i64); 4 e (i32); 5 mantissa (i64);
        // 6 signExponent (i32); 7 lz (i32)
        const b = new Body();
        b.localGet(0).op(I64.reinterpretF64).localSet(2);
        b.localGet(2).i64const(0xfffffffffffffn).op(I64.and).localSet(3);
        b.localGet(2).i64const(52n).op(I64.shrU).op(I64.wrap).i32const(0x7ff).op(I32.and)
            .localSet(4);
        b.localGet(2).i64const(63n).op(I64.shrU).op(I64.wrap).i32const(15).op(I32.shl).localSet(6);
        b.block(EMPTY);
        // infinity or NaN: the explicit leading bit, the fraction, exponent all ones
        b.localGet(4).i32const(0x7ff).op(I32.eq);
        b.if(EMPTY);
        b.localGet(3).i64const(11n).op(I64.shl).i64const(-0x8000000000000000n).op(I64.or)
            .localSet(5);
        b.localGet(6).i32const(0x7fff).op(I32.or).localSet(6);
        b.br(1);
        b.end();
        // zero
        b.localGet(4).op(I32.eqz).localGet(3).op(I64.eqz).op(I32.and);
        b.if(EMPTY);
        b.i64const(0n).localSet(5);
        b.br(1);
        b.end();
        // subnormal: the leading bit found by the count of leading zeros
        b.localGet(4).op(I32.eqz);
        b.if(EMPTY);
        b.localGet(3).op(I64.clz).op(I64.wrap).localSet(7);
        b.localGet(3).localGet(7).op(I64.extendU).op(I64.shl).localSet(5);
        b.localGet(6).i32const(15372).localGet(7).op(I32.sub).op(I32.or).localSet(6);
        b.br(1);
        b.end();
        // normal
        b.localGet(3).i64const(11n).op(I64.shl).i64const(-0x8000000000000000n).op(I64.or)
            .localSet(5);
        b.localGet(6).localGet(4).i32const(15360).op(I32.add).op(I32.or).localSet(6);
        b.end();
        b.localGet(1).localGet(5).store('i64', { offset: 0 });
        b.localGet(1).localGet(6).store('i32_16', { offset: 8 });
        return m.function(type, [ValType.i64, ValType.i64, ValType.i32, ValType.i64, ValType.i32,
            ValType.i32], b.toBytes());
    })();
    return { f80ToF64, f64ToF80 };
}

/**
 * The BCD store helper a module carries: `f64ToBcd(value, wasmAddress)`
 * writes the ten bytes `fbstp` writes -- an 18-digit packed BCD integer,
 * least significant digit first, the sign byte 0x80 for a negative value --
 * and the 80-bit integer indefinite for a NaN or a value past 18 digits. The
 * value is already rounded by the control word by the caller.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @returns {number} the function index
 */
export function addBcdHelper(m){
    const type = m.type({ params: [ValType.f64, ValType.i32], results: [] });
    // locals: 0 value, 1 address, 2 bits (i64), 3 sign (i32), 4 magnitude (f64),
    // 5 rest (i64), 6 packed (i64), 7 index (i32), 8 digit (i64), 9 high (i64)
    const b = new Body();
    b.localGet(0).op(I64.reinterpretF64).localSet(2);
    b.localGet(2).i64const(63n).op(I64.shrU).op(I64.wrap).i32const(1).op(I32.and)
        .localSet(3);
    b.localGet(0).op(F64.abs).localSet(4);
    // A NaN or a value at or past 10^18 stores the integer indefinite.
    b.localGet(4).f64const(1e18).op(F64.ge);
    b.localGet(4).localGet(4).op(F64.ne);
    b.op(I32.or);
    b.if(EMPTY);
    b.localGet(1).i64const(0n).store('i64', { offset: 0 });
    b.localGet(1).i32const(0xc0).store('i32_8', { offset: 7 });
    b.localGet(1).i32const(0xff).store('i32_8', { offset: 8 });
    b.localGet(1).i32const(0xff).store('i32_8', { offset: 9 });
    b.return();
    b.end();
    b.localGet(4).op(0xb0).localSet(5); // i64.trunc_f64_s
    b.i64const(0n).localSet(6);
    b.i64const(0n).localSet(9);
    b.i32const(0).localSet(7);
    b.block(EMPTY);
    b.loop(EMPTY);
    b.localGet(7).i32const(18).op(I32.eq).brIf(1);
    b.localGet(5).i64const(10n).op(0x82).localSet(8); // i64.rem_u
    b.localGet(5).i64const(10n).op(0x80).localSet(5); // i64.div_u
    b.localGet(7).i32const(16).op(I32.ltU);
    b.if(EMPTY);
    b.localGet(6).localGet(8).localGet(7).i32const(4).op(I32.mul).op(I64.extendU)
        .op(I64.shl).op(I64.or).localSet(6);
    b.else();
    b.localGet(9).localGet(8).localGet(7).i32const(16).op(I32.sub).i32const(4)
        .op(I32.mul).op(I64.extendU).op(I64.shl).op(I64.or).localSet(9);
    b.end();
    b.localGet(7).i32const(1).op(I32.add).localSet(7);
    b.br(0);
    b.end();
    b.end();
    b.localGet(1).localGet(6).store('i64', { offset: 0 });
    b.localGet(1).localGet(9).op(I64.wrap).store('i32_8', { offset: 8 });
    b.localGet(1).localGet(3).i32const(7).op(I32.shl).store('i32_8', { offset: 9 });
    return m.function(type,
        [ValType.i64, ValType.i32, ValType.f64, ValType.i64, ValType.i64, ValType.i32,
            ValType.i64, ValType.i64], b.toBytes());
}

export { Exit, readOp };
