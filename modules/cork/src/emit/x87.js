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
 * plan names and counts (the emulator computes in f64 as well). Rounding
 * control and the transcendentals are later steps; `fldcw`, `fprem` and
 * their kin end a region here.
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
    add: 0xa0, sub: 0xa1, mul: 0xa2, div: 0xa3,
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
    'fldcw', 'fldenv', 'fnstenv', 'fnsave', 'frstor', 'fxsave', 'fxrstor', 'fbld', 'fbstp',
    'fprem', 'fprem1', 'fsin', 'fcos', 'fsincos', 'fptan', 'fpatan', 'f2xm1', 'fyl2x', 'fyl2xp1',
    'fscale', 'frndint', 'fxtract', 'fnclex',
]);

/**
 * @typedef {Object} StackState
 * @property {number} top
 * @property {number[]} slot   architectural register k -> which of the eight locals holds it
 */

/** @param {StackState} state */
const cloneState = state=>({ top: state.top, slot: [...state.slot] });
/** @param {StackState} a @param {StackState} b */
const sameState = (a, b)=>a.top === b.top && a.slot.every((s, i)=>s === b.slot[i]);

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
        case 'fldln2': case 'fldlg2': case 'fldl2t':
            push();
            return next;
        case 'fstp': case 'fistp': case 'fisttp': case 'faddp': case 'fsubp': case 'fsubrp':
        case 'fmulp': case 'fdivp': case 'fdivrp': case 'fcomp': case 'fucomp': case 'fcomip':
        case 'fucomip': case 'ffreep':
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
        case 'fninit':
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
    const index = new Map(region.blocks.map((block, i)=>[block.start, i]));
    /** @type {(StackState | null)[]} */
    const states = new Array(region.blocks.length).fill(null);
    /** @type {(StackState | null)[]} */
    const ends = new Array(region.blocks.length).fill(null);
    /** @type {Set<number>} */
    const cut = new Set();
    const seen = new Set();
    states[0] = { top: entryTop, slot: [0, 1, 2, 3, 4, 5, 6, 7] };
    const work = [0];
    while (work.length > 0)
    {
        const i = /** @type {number} */ (work.shift());
        if (seen.has(i) || cut.has(i))
        {
            continue;
        }
        seen.add(i);
        let state = states[i];
        const block = region.blocks[i];
        for (const instruction of block.instructions)
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
        const targets = [...block.exit.targets];
        if (block.exit.kind === 'fallthrough' || block.exit.kind === 'jcc'
            || block.exit.kind === 'loop')
        {
            targets.push(block.exit.next);
        }
        for (const target of targets)
        {
            const j = index.get(target);
            if (j === undefined)
            {
                continue;
            }
            const known = states[j];
            if (known === null)
            {
                states[j] = cloneState(state);
                work.push(j);
            }
            else if (known.top !== state.top)
            {
                // Two tops meet: the block cannot be compiled for both.
                cut.add(j);
                states[j] = null;
            }
            // A different permutation with the same top is fixed on the edge.
        }
    }
    return { states, cut, ends };
}

/**
 * The emitter's x87 state for one region.
 *
 * @typedef {Object} X87Emit
 * @property {boolean} active            the region has x87 instructions and they are emitted
 * @property {number} base               the first of the eight f64 locals
 * @property {number} temp               an f64 scratch local
 * @property {number} temp2
 * @property {(StackState | null)[]} states
 * @property {Set<number>} cut
 * @property {StackState | null} current   the state at the current point of emission
 * @property {boolean} controlWritten
 */

/**
 * Sets up the region's x87 emission: decides whether the region uses x87
 * (and no MMX -- a region with both leaves x87 to the other executor), runs
 * the tracker and allocates the locals.
 *
 * @param {E} e @param {number} entryTop
 * @returns {X87Emit}
 */
export function prepareX87(e, entryTop){
    const region = e.region;
    const uses = region.blocks.some(block=>block.instructions.some(isX87));
    const mmx = region.blocks.some(block=>block.instructions.some(
        instruction=>instruction.operands.some(operand=>operand.kind === 'mm')));
    if (!uses || mmx)
    {
        return {
            active: false, base: 0, temp: 0, temp2: 0, states: [], cut: new Set(), current: null,
            controlWritten: false,
        };
    }
    const { states, cut } = trackRegion(region, entryTop);
    const base = e.localTypes.length + 2;
    for (let k = 0; k < 10; k++)
    {
        e.localTypes.push(ValType.f64);
    }
    return {
        active: true, base, temp: base + 8, temp2: base + 9, states, cut, current: null,
        controlWritten: false,
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
    b.i32const(0).load('i32_8u', { offset: layout.x87Empty }).localSet(Local.x87Empty);
    b.i32const(0).load('i32_16u', { offset: layout.x87Status }).localSet(Local.x87Status);
    b.i32const(0).load('i32_16u', { offset: layout.x87Control }).localSet(Local.x87Control);
    b.i32const(0).localSet(Local.x87Dirty);
    for (let k = 0; k < 8; k++)
    {
        const at = layout.x87 + k * 16;
        b.localGet(Local.x87Empty).i32const(1 << k).op(I32.and).op(I32.eqz);
        e.openIf(`held${k}`, EMPTY);
        if (layout.x87Format === 'tagged80')
        {
            b.i32const(0).load('i32_16u', { offset: at + 8 }).i32const(RELAXED_TAG).op(I32.eq);
            e.openIf('tagged', EMPTY);
            b.i32const(0).load('i64', { offset: at }).op(F64.reinterpretI64).localSet(x.base + k);
            b.else();
            b.i32const(at).call(/** @type {number} */ (e.context.f80ToF64)).localSet(x.base + k);
            e.close();
        }
        else
        {
            b.i32const(0).load('f64', { offset: at }).localSet(x.base + k);
        }
        e.close();
    }
}

/**
 * The epilogue: top, the masks and words, and every dirty register back
 * into the state block. The current top is in its local, set at every
 * block start and kept by every push and pop.
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
 * @param {E} e @param {number} targetIndex
 */
export function x87Edge(e, targetIndex){
    const x = e.x87;
    const to = x.states[targetIndex];
    if (!to || x.cut.has(targetIndex))
    {
        return;
    }
    x87MoveTo(e, to);
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

// --- the instruction lowerings ---

/**
 * @param {E} e @param {Instruction} instruction @param {boolean} flagsLive
 * @returns {boolean}  false leaves the instruction to the other executor
 */
export function emitX87(e, instruction, flagsLive){
    const x = e.x87;
    if (!x.active || x.current === null)
    {
        return false;
    }
    const { b } = e;
    const { op, operands } = instruction;
    const state = x.current;
    const next = step(instruction, state);
    if (next === null)
    {
        return false;
    }
    /** The local holding ST(i). @param {number} i */
    const st = i=>x.base + state.slot[(state.top + i) & 7];
    /** Marks ST(i) written. @param {number} i */
    const dirty = i=>{
        b.localGet(Local.x87Dirty).i32const(1 << ((state.top + i) & 7)).op(I32.or)
            .localSet(Local.x87Dirty);
    };
    const [dst, src] = operands;
    const push = ()=>{
        // The new top's slot is held and dirty; the value is on the stack.
        const top = (state.top - 1) & 7;
        b.localSet(x.base + state.slot[top]);
        b.localGet(Local.x87Empty).i32const(~(1 << top)).op(I32.and).localSet(Local.x87Empty);
        b.localGet(Local.x87Dirty).i32const(1 << top).op(I32.or).localSet(Local.x87Dirty);
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
     * instruction then produces the indefinite where it would a value.
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
    };
    /** Replaces the f64 on the stack by the indefinite when the guard fired. */
    const orIndefinite = ()=>{
        // select keeps the first value when the condition holds: the result
        // when the guard did not fire.
        indefinite();
        b.localGet(Local.t1).op(I32.eqz);
        b.select();
    };

    switch (op)
    {
        case 'fwait': case 'fnop':
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
        case 'fxch':
        {
            // The locals swap roles: no code but the fault's, and both
            // registers count as written.
            const i = /** @type {number} */ (src.reg);
            // An empty register faults, and the registers keep their values.
            guard([0, i], false);
            dirty(0);
            dirty(i);
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
            b.localGet(st(0)).op(F64.sqrt);
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
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
            b.localGet(st(target)).localGet(st(target)).op(F64.ne);
            b.localGet(x.temp).localGet(x.temp).op(F64.eq).op(I32.and);
            b.localGet(x.temp2).localGet(x.temp2).op(F64.eq).op(I32.and);
            e.openIf('invalid', EMPTY);
            setStatus(Status.IE);
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
        case 'ftst':
        {
            if (op === 'ftst')
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
        default:
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
        b.localGet(Local.addr).load('i32', { offset: e.layout.ramBase }).localSet(Local.t2);
        b.localGet(Local.t2).i32const(0x7fffffff).op(I32.and).i32const(0x7f800000).op(I32.gtU);
        b.localGet(Local.t2).i32const(0x400000).op(I32.and).op(I32.eqz).op(I32.and);
        e.openIf('signalling', EMPTY);
        b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
        b.localGet(Local.t2).i32const(0x400000).op(I32.or).localSet(Local.t2);
        e.close();
        b.localGet(Local.t2).op(0xbe).op(F64.promoteF32); // f32.reinterpret_i32
        return;
    }
    b.localGet(Local.addr).load('i64', { offset: e.layout.ramBase }).localSet(Local.t64);
    b.localGet(Local.t64).i64const(0x7fffffffffffffffn).op(I64.and)
        .i64const(0x7ff0000000000000n).op(I64.gtS);
    b.localGet(Local.t64).i64const(0x0008000000000000n).op(I64.and).op(I64.eqz).op(I32.and);
    e.openIf('signalling', EMPTY);
    b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
    b.localGet(Local.t64).i64const(0x0008000000000000n).op(I64.or).localSet(Local.t64);
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
    b.localGet(local).op(truncate ? F64.trunc : F64.nearest).localSet(e.x87.temp);
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

export { Exit, readOp };
