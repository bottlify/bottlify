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
 * them). A block reached with two different tops, or with none the tracker
 * knows, is compiled for a top it guesses and tests the machine's at its
 * start, leaving for the other executor when the top is another
 * (`trackRegion`).
 *
 * What is dynamic: the empty mask (a push clears a bit, a pop sets one),
 * the status word's condition and exception bits, and a dirty mask of the
 * registers written, which the epilogue stores back -- as f64 in cork's own
 * layout, as the emulator's tagged double in its. A register read at entry
 * that the emulator kept as a true 80-bit value is converted inline.
 *
 * The stack-fault checks are decided at translation wherever the mask is
 * known there (`planStack`): what a block's predecessors in the region left
 * of it, and at a block the region can be entered at, the shape the block
 * and what follows it need -- which the entry tests once, leaving for the
 * host (`SHAPE`) when the machine's stack is not in it. Compiled code keeps
 * the stack in one shape at each place, so the test passes and the blocks
 * run with no check; a region whose test keeps failing is translated again
 * `checked`, its entries needing nothing.
 *
 * Every arithmetic result is the f64 result; where the processor's 80-bit
 * arithmetic would differ the difference is the `x87.precision` class the
 * plan names and counts (the emulator computes in f64 as well). The control
 * word is honoured at run time: its rounding control rounds the integer
 * stores and `frndint` -- the arithmetic itself rounds to nearest whatever
 * it says, as the host's f64 operations do -- and precision control set to
 * single rounds every arithmetic result to a float (extended is treated as
 * double); a region compiled for single (`narrow`) or for the others (`wide`)
 * tests the word once a block and rounds, or does not, with no test of its
 * own. Exception masks are not honoured: an exception behaves as masked. The
 * transcendentals go through the host's `Math`, as the emulator's do, so the
 * two agree bit for bit on one engine; the environment forms end a region.
 *
 * Unless the module is `precise`, the sticky exception flags are not
 * computed -- no IE from an invalid operation, a NaN compared or a signalling
 * NaN read (whose load does not quiet an m64 either), no ZE, no UE -- and C1
 * is not cleared by a push or `fcomi`: a test and a branch per operation
 * that split the block at every one, where a program reads the words only in
 * `fnstsw` and the environment saves, and practically never the exception
 * bits. What stays exact is every value, C0, C2 and C3, the stack and its
 * faults, and precision and rounding control.
 */

import { CF, PF, ZF, AF, SF, OF } from '../decode/table.js';
import { isX87Opcode } from '../decode/decoder.js';
import { Body, EMPTY, ValType } from '../wasm/encoder.js';
import { I32 } from './flags.js';
import { Local, Exit, STATE_PARAMS } from './region.js';
import { prepare, writeReg } from './integer.js';
import { PRECISION, noteStore } from './memory.js';
import { callsOut, inlineReturns } from '../region.js';
import { exactWrites } from '../ir-x87.js';
import { atState } from './bases.js';

/** @typedef {import('./region.js').RegionEmitter} E */
/** @typedef {import('../decode/decoder.js').Instruction} Instruction */
/** @typedef {import('../decode/decoder.js').Operand} Operand */

/** f64 and conversion opcodes. */
const F64 = Object.freeze({
    eq: 0x61, ne: 0x62, lt: 0x63, gt: 0x64, le: 0x65, ge: 0x66,
    abs: 0x99, neg: 0x9a, ceil: 0x9b, floor: 0x9c, trunc: 0x9d, nearest: 0x9e, sqrt: 0x9f,
    add: 0xa0, sub: 0xa1, mul: 0xa2, div: 0xa3, copysign: 0xa6,
    convertI32S: 0xb7, convertI64S: 0xb9, convertI64U: 0xba, promoteF32: 0xbb,
    reinterpretI64: 0xbf,
});
const I64 = Object.freeze({
    eqz: 0x50, eq: 0x51, ne: 0x52, ltS: 0x53, gtS: 0x55, gtU: 0x56, add: 0x7c, sub: 0x7d,
    mul: 0x7e, divU: 0x80, and: 0x83, or: 0x84, shl: 0x86, shrU: 0x88, clz: 0x79, wrap: 0xa7,
    extendS: 0xac, extendU: 0xad, reinterpretF64: 0xbd,
});
const F32 = Object.freeze({
    eq: 0x5b, gt: 0x5e, le: 0x5f, abs: 0x8b, neg: 0x8c, sqrt: 0x91,
    add: 0x92, sub: 0x93, mul: 0x94, div: 0x95, demoteF64: 0xb6,
    /** i32.reinterpret_f32 */
    bits: 0xbc,
});
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

/** The instructions that write the control word. */
const CONTROL_WRITERS = new Set(['fldcw', 'fninit', 'fnsave', 'fldenv', 'frstor']);


/**
 * The vector of an untranslated exit a region takes at its entry when the
 * machine's stack is not in the shape the entered block was compiled for:
 * back to the host, as `HELD` and `PRECISION` (`memory.js`) go, whose
 * interpreter runs the block and raises its stack fault; the runtime counts
 * it against the region.
 */
export const SHAPE = 3;

/**
 * The vector of an untranslated exit a region compiled for single precision
 * with its arithmetic in floats (`floats`) takes before an operation whose
 * float result is not the 24-bit one the processor makes: past a float's
 * range, where the processor keeps its wider exponent, below its smallest
 * normal from a product or a quotient, or a NaN. The host's interpreter runs
 * it; the runtime counts it against the region, and one that keeps leaving is
 * translated again rounding every result from a double.
 */
export const RANGE = 4;

/** @param {Instruction} instruction */
export function isX87(instruction){
    return isX87Opcode(instruction.opcode);
}

/** The instructions this step leaves to the other executor. */
const LEFT_OUT = new Set([
    'fxsave', 'fxrstor', 'fbld',
]);

/** The forms precision control rounds (`byPrecision`): the arithmetic and the square root. */
const ROUNDS = new Set([
    'fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr',
    'faddp', 'fsubp', 'fsubrp', 'fmulp', 'fdivp', 'fdivrp',
    'fiadd', 'fisub', 'fisubr', 'fimul', 'fidiv', 'fidivr', 'fsqrt',
]);

/** x87 operations whose only effect on the empty mask is their pushes and pops
 * (the emitter's push and popN), so what a block knows of the mask survives them. */
const MASK_SAFE = new Set([
    'fld', 'fild', 'fld1', 'fldz', 'fldpi', 'fldl2e', 'fldln2', 'fldlg2', 'fldl2t',
    'fst', 'fstp', 'fist', 'fistp', 'fisttp',
    'fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr', 'faddp', 'fsubp', 'fsubrp', 'fmulp',
    'fdivp', 'fdivrp', 'fiadd', 'fisub', 'fisubr', 'fimul', 'fidiv', 'fidivr',
    'fcom', 'fcomp', 'fcompp', 'fucom', 'fucomp', 'fucompp', 'ftst', 'ficom', 'ficomp',
    'fcomi', 'fcomip', 'fucomi', 'fucomip',
    'fchs', 'fabs', 'fsqrt', 'frndint', 'fxam', 'fnstsw', 'fnstcw', 'fldcw', 'fwait', 'fnop',
]);

/** Forms that read no register's value: the float path's floats stay as they are (`Singles`). */
const FLOAT_NEUTRAL = new Set(['fxch', 'fwait', 'fnop', 'fnstsw', 'fnstcw', 'fldcw']);

/** The arithmetic the float path computes in f32. */
const FLOAT_ARITHMETIC = new Set(['fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr', 'faddp',
    'fsubp', 'fsubrp', 'fmulp', 'fdivp', 'fdivrp']);

/**
 * Whether the float path (`Singles`) takes a form with these operands: a float
 * load or a constant 0 or 1 pushed, a copy of a float, a float stored (one
 * known not to be a NaN, to memory), a sign or a magnitude, a square root, and
 * the four operations on two floats, a register's or a float in memory.
 *
 * @param {string} op @param {Operand | undefined} dst @param {Operand | undefined} src
 * @param {(i: number) => boolean} isSingle @param {(i: number) => boolean} isNumeric
 */
function floatForm(op, dst, src, isSingle, isNumeric){
    switch (op)
    {
        case 'fld':
            return src?.kind === 'mem' ? src.size === 4
                : src?.kind === 'x87' && isSingle(Number(src.reg));
        case 'fld1': case 'fldz':
            return true;
        case 'fst': case 'fstp':
            return dst?.kind === 'x87' ? isSingle(0)
                : dst?.kind === 'mem' && dst.size === 4 && isSingle(0) && isNumeric(0);
        case 'fchs': case 'fabs': case 'fsqrt':
            return isSingle(0);
        default:
        {
            if (!FLOAT_ARITHMETIC.has(op) || src === undefined)
            {
                return false;
            }
            const target = dst?.kind === 'x87' ? Number(dst.reg) : 0;
            return isSingle(target) && (src.kind === 'x87' ? isSingle(Number(src.reg))
                : src.kind === 'mem' && src.size === 4);
        }
    }
}

/**
 * The floats (`Singles`) a form leaves behind it, as a mask of locals: one the
 * float path took (`taken`) wrote its own and forgets the registers it pops; any
 * other ran on the f64 locals and forgets the ones it writes besides, and one
 * `exactWrites` does not know (an exchange of all of them, a transcendental),
 * every one. A popped register's float would otherwise outlive it into a test
 * at an entry (`x87EntryCheck`) of whatever its double was left as.
 *
 * @param {Instruction} instruction
 * @param {StackState} state  before it
 * @param {boolean} taken
 */
function floatsGone(instruction, state, taken){
    const writes = exactWrites(instruction, state.top, state.slot);
    if (writes === null)
    {
        return taken ? 0 : 0xff;
    }
    return (taken ? 0 : writes.written) | writes.popped;
}

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
 * The top a call leaves, as the code after it takes it: one below the call's
 * when the first x87 instruction there reads a register before anything
 * pushes -- a function returns its float in ST0, the caller's stack empty at
 * the call, as the x87 calling conventions have it -- and the call's
 * otherwise. The code after a call made as a wasm call tests the top the
 * callee left against this one (`x87AfterCall`).
 *
 * @param {import('../region.js').Block} block  the return address's
 * @param {number} top  the top at the call
 */
export function topAfterCall(block, top){
    const state = { top, slot: [0, 1, 2, 3, 4, 5, 6, 7] };
    for (const instruction of block.instructions)
    {
        if (!isX87(instruction))
        {
            continue;
        }
        const use = stackUse(instruction, state);
        if (use.sources.length > 0)
        {
            return (top - 1) & 7;
        }
        if (use.pushes || use.whole !== null || use.marks.length > 0)
        {
            break;
        }
    }
    return top;
}

/**
 * The tracker over a region: the state at each block's start, propagated
 * from the entry along the region's edges. The entry block's state is the
 * identity mapping at `entryTop`.
 *
 * A block met with two different tops is not given up: it keeps the state
 * that reached it first -- which it has already handed on -- and an edge
 * that arrives with another top leaves at the block instead (`x87Edge`), as
 * one into the entry does. A block reached with no state known -- past a
 * call that leaves the region, past an instruction the tracker cannot
 * follow -- is compiled for a top it guesses: the one a call's return is
 * taken to leave (`topAfterCall`), or else the entry's, with the registers in
 * their own locals. Both are `guarded`: each tests the top the machine has at
 * its start and leaves for the host when it is another (`x87BlockStart`), as
 * the code after a wasm call does, and seeds its successors as the entry
 * does. Only when `guess` is off is such a block cut (null), left to the
 * other executor whole.
 *
 * With `callReturn` a call that leaves the region (`callsOut`) is a wasm call
 * the region goes on after: an edge to its return address, the top the
 * callee is taken to leave (`topAfterCall`) and the registers in their own
 * locals, which the state block hands back -- the code after the call tests
 * that the callee left the top so.
 *
 * @param {import('../region.js').Region} region
 * @param {number} entryTop
 * @param {boolean} [callReturn]
 * @param {boolean} [guess]
 * @returns {{ states: (StackState | null)[], cut: Set<number>, ends: (StackState | null)[],
 *     guarded: Map<number, number> }}
 *     `ends`: the state at each block's end (null when the block is cut or tracking stops in
 *     it); `guarded`: the blocks compiled for a guessed top, by index, with that top
 */
export function trackRegion(region, entryTop, callReturn = false, guess = true){
    const blocks = region.blocks;
    const count = blocks.length;
    const index = new Map(blocks.map((block, i)=>[block.start, i]));
    // The entry's block by its address, not by its place: the blocks are in
    // address order, and a region formed at a return address has the call
    // site's block below it -- seeding the first block left the entry's own
    // x87 with no state and every form in it refused.
    const entry = index.get(region.entry) ?? 0;
    // Where a return of the region may jump inside it: a leaf callee's.
    const returns = inlineReturns(region);
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
        else if (block.exit.kind === 'ret')
        {
            targets.push(...returns.get(block.start) ?? []);
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
    /** By call block, its return address's block when the call is a wasm call. */
    const returnOf = blocks.map(block=>(callReturn && callsOut(block, index)
        ? index.get(block.exit.next) ?? -1 : -1));
    /**
     * The blocks the propagation starts from, each with its state: the entry,
     * and every block guarded. None of them is cut by an edge that arrives
     * with another top.
     *
     * @type {Map<number, StackState>}
     */
    const seeds = new Map([[entry, { top: entryTop, slot: [0, 1, 2, 3, 4, 5, 6, 7] }]]);
    /** @type {Map<number, number>} */
    const guarded = new Map();
    /** By block, the call block whose return address it is, or -1. */
    const callerOf = new Array(count).fill(-1);
    blocks.forEach((block, i)=>{
        const j = block.exit.kind === 'call' ? index.get(block.exit.next) : undefined;
        if (j !== undefined && callerOf[j] < 0)
        {
            callerOf[j] = i;
        }
    });
    // A block met with two tops is guarded as the propagation meets it. What
    // no tracked edge reaches is guessed after, and the propagation run again
    // from it: a pass for each such block in a chain of them, at most.
    for (let pass = 0; pass <= count; pass++)
    {
        ({ states, ends } = propagate(seeds));
        if (!guess)
        {
            break;
        }
        let added = false;
        for (let j = 0; j < count; j++)
        {
            if (states[j] !== null || seeds.has(j) || blocks[j].instructions.length === 0)
            {
                continue;
            }
            const caller = callerOf[j];
            const end = caller < 0 ? null : ends[caller];
            const top = end === null ? entryTop : topAfterCall(blocks[j], end.top);
            guarded.set(j, top);
            seeds.set(j, { top, slot: [0, 1, 2, 3, 4, 5, 6, 7] });
            added = true;
        }
        if (!added)
        {
            break;
        }
    }
    return { states, cut, ends, guarded };

    /**
     * Every state the seeds reach, as a fixed point. With `guess`, a block
     * two tops meet at joins the seeds (`from`) with the first.
     *
     * @param {Map<number, StackState>} from
     */
    function propagate(from){
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
            for (const [at, state] of from)
            {
                pending[at] = cloneState(state);
            }
            const work = [...from.keys()];
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
                const after = returnOf[i];
                for (const j of after >= 0 ? [...successors(i), after] : successors(i))
                {
                    const known = pending[j];
                    const arriving = j === after ? { top: topAfterCall(blocks[j], state.top),
                        slot: [0, 1, 2, 3, 4, 5, 6, 7] } : state;
                    if (known === undefined)
                    {
                        pending[j] = cloneState(arriving);
                        work.push(j);
                    }
                    else if (known !== null && known.top !== state.top)
                    {
                        if (from.has(j))
                        {
                            // The region's own entry block is compiled for the
                            // top the region was formed at, whatever other path
                            // reaches it: the edge that arrives with a different
                            // top leaves at the entry (see `x87Edge`), and the
                            // runtime forms a region there for the top it has.
                            // Cutting the entry instead would publish no entry at
                            // all and the miss would repeat forever. A guarded
                            // block keeps its top the same way.
                            continue;
                        }
                        if (guess)
                        {
                            // The state that came first is the block's, and was
                            // handed on already: the block tests the top instead.
                            from.set(j, cloneState(known));
                            guarded.set(j, known.top);
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
        return { states, ends };
    }
}

/**
 * What is known of the stack words at a point of a region: the physical
 * registers known held and known empty, and whether C1 is known clear.
 *
 * @typedef {{ held: number, empty: number, c1: boolean }} Shape
 */

/** @type {Shape} */
const NOTHING = Object.freeze({ held: 0, empty: 0, c1: false });

/**
 * What one x87 instruction does to the stack words, as its lowering has it:
 * the ST(i) it reads (checked for an empty register, `guard`), whether it
 * pushes (checked for a held one, C1 cleared), and the physical registers it
 * leaves held (1), empty (0) or either (-1), in order.
 *
 * @typedef {Object} StackUse
 * @property {number[]} sources
 * @property {boolean} pushes
 * @property {[number, number][]} marks
 * @property {'empty' | 'unknown' | null} whole  every register left empty, or unknown
 * @property {'keep' | 'clear' | 'lost'} c1  C1 after it, beside its push's clear
 */

/**
 * @param {Instruction} instruction @param {StackState} state
 * @returns {StackUse}
 */
export function stackUse(instruction, state){
    const { op, operands } = instruction;
    const [dst, src] = operands;
    const at = (/** @type {number} */ i)=>(state.top + i) & 7;
    /** @type {StackUse} */
    const use = { sources: [], pushes: false, marks: [], whole: null, c1: 'keep' };
    const push = (held = 1)=>{
        use.pushes = true;
        use.marks.push([at(-1), held]);
    };
    const pop = (times = 1)=>{
        for (let k = 0; k < times; k++)
        {
            use.marks.push([at(k), 0]);
        }
    };
    const reg = (/** @type {Operand} */ operand)=>Number(operand.reg);
    switch (op)
    {
        case 'fwait': case 'fnop': case 'fnclex': case 'fldcw': case 'fnstsw': case 'fnstcw':
        case 'fnstenv': case 'fincstp': case 'fdecstp':
            return use;
        case 'fninit': case 'fnsave':
            use.whole = 'empty';
            use.c1 = 'clear';
            return use;
        case 'fld':
            use.sources = src.kind === 'x87' ? [reg(src)] : [];
            push();
            return use;
        case 'fild': case 'fld1': case 'fldz': case 'fldpi': case 'fldl2e': case 'fldln2':
        case 'fldlg2': case 'fldl2t':
            push();
            return use;
        case 'fst': case 'fstp':
            use.sources = [0];
            if (dst.kind === 'x87')
            {
                use.marks.push([at(reg(dst)), 1]);
            }
            pop(op === 'fstp' ? 1 : 0);
            return use;
        case 'fist': case 'fistp': case 'fisttp':
            use.sources = [0];
            pop(op === 'fist' ? 0 : 1);
            return use;
        case 'fbstp':
            use.sources = [0];
            pop();
            return use;
        case 'fxch':
            // Both held after it: an empty one is the indefinite first.
            use.sources = [0, reg(src)];
            use.marks.push([at(0), 1], [at(reg(src)), 1]);
            return use;
        case 'fcmovb': case 'fcmove': case 'fcmovbe': case 'fcmovu':
        case 'fcmovnb': case 'fcmovne': case 'fcmovnbe': case 'fcmovnu':
            // ST0 held after it: a stack fault leaves the indefinite there.
            use.sources = [0, reg(src)];
            use.marks.push([at(0), 1]);
            return use;
        case 'ffree': case 'ffreep':
            use.marks.push([at(reg(dst)), 0]);
            pop(op === 'ffreep' ? 1 : 0);
            return use;
        case 'fchs': case 'fabs': case 'fsqrt': case 'frndint': case 'f2xm1': case 'fsin':
        case 'fcos':
            use.sources = [0];
            return use;
        case 'fsincos': case 'fptan':
            // The push is on the paths that compute; out of the reduction
            // range the register is left as it was.
            use.sources = [0];
            push(-1);
            return use;
        case 'fxtract':
            use.sources = [0];
            push();
            return use;
        case 'fscale':
            use.sources = [0, 1];
            return use;
        case 'fprem': case 'fprem1':
            use.sources = [0, 1];
            use.c1 = 'lost';
            return use;
        case 'fpatan': case 'fyl2x': case 'fyl2xp1':
            use.sources = [0, 1];
            pop();
            return use;
        case 'fadd': case 'fsub': case 'fsubr': case 'fmul': case 'fdiv': case 'fdivr':
        case 'faddp': case 'fsubp': case 'fsubrp': case 'fmulp': case 'fdivp': case 'fdivrp':
        case 'fiadd': case 'fisub': case 'fisubr': case 'fimul': case 'fidiv': case 'fidivr':
        {
            const target = dst.kind === 'x87' ? reg(dst) : 0;
            use.sources = src.kind === 'x87' ? [target, reg(src)] : [target];
            pop(op.endsWith('p') ? 1 : 0);
            return use;
        }
        case 'fcom': case 'fcomp': case 'fcompp': case 'fucom': case 'fucomp': case 'fucompp':
        case 'ftst': case 'ficom': case 'ficomp':
            use.sources = op === 'fcompp' || op === 'fucompp' ? [0, 1]
                : op !== 'ftst' && op !== 'ficom' && op !== 'ficomp' && src.kind === 'x87'
                    ? [0, reg(src)] : [0];
            pop(op.endsWith('pp') ? 2 : op.endsWith('p') ? 1 : 0);
            use.c1 = 'clear';
            return use;
        case 'fcomi': case 'fcomip': case 'fucomi': case 'fucomip':
            use.sources = [0, reg(src)];
            pop(op.endsWith('p') ? 1 : 0);
            use.c1 = 'clear';
            return use;
        case 'fxam':
            use.c1 = 'lost';
            return use;
        default:
            // fldenv, frstor, and whatever else: nothing is known after it.
            use.whole = 'unknown';
            use.c1 = 'lost';
            return use;
    }
}

/**
 * What is known after an instruction of the given use, from what was known
 * before it. A push leaves C1 clear unless its overflow was checked, whose
 * failing path sets it; a check that fails leaves the registers it read as
 * they were, so a read teaches nothing.
 *
 * @param {Shape} known @param {StackUse} use @param {StackState} state
 * @returns {Shape}
 */
export function advance(known, use, state){
    let { held, empty, c1 } = known;
    if (use.pushes)
    {
        c1 = (empty & 1 << ((state.top - 1) & 7)) !== 0;
    }
    for (const [k, mark] of use.marks)
    {
        held &= ~(1 << k);
        empty &= ~(1 << k);
        held |= mark === 1 ? 1 << k : 0;
        empty |= mark === 0 ? 1 << k : 0;
    }
    if (use.whole !== null)
    {
        held = 0;
        empty = use.whole === 'empty' ? 0xff : 0;
    }
    c1 = use.c1 === 'clear' ? true : use.c1 === 'lost' ? false : c1;
    return { held, empty, c1 };
}

/** @param {Shape} a @param {Shape} b @returns {Shape} */
const meet = (a, b)=>({ held: a.held & b.held, empty: a.empty & b.empty, c1: a.c1 && b.c1 });
/** @param {Shape} a @param {Shape} b */
const sameShape = (a, b)=>a.held === b.held && a.empty === b.empty && a.c1 === b.c1;

/**
 * Whether an instruction of another class changes the stack words: an MMX
 * instruction holds every register, `emms` empties them.
 *
 * @param {Instruction} instruction
 */
const movesMask = instruction=>instruction.op === 'emms'
    || instruction.operands.some(operand=>operand.kind === 'mm');

/**
 * The stack words over a region, for the checks translation can decide.
 *
 * A block is entered from outside only through the function's head (the
 * host, or another region through the entry hash), and only at a block
 * compiled for the entry's shape (`shapedBlocks` in `region.js`); from inside
 * the region, only along its edges. So what is known at a block's start is
 * what every predecessor in the region left, met with -- where the block can
 * be entered -- what the entry tests: nothing when `speculate` is off, and
 * otherwise the shape the block needs on every path from it before the
 * path itself pushes or pops the register (read: held; pushed into: empty).
 * Compiled code keeps the stack in one shape at each place, so that test
 * passes; a program that faults on purpose fails it before the block and is
 * run by the host.
 *
 * With `callReturn` a call that leaves the region comes back to its return
 * address inside it (`trackRegion`), and the callee may have left the stack
 * words in any shape: the return knows nothing of them, but what the block
 * tests as an entry, which the return tests as well (`x87AfterCall`); and no
 * need of the code after the call is the call's.
 *
 * @param {import('../region.js').Region} region
 * @param {(StackState | null)[]} states  the tracker's, a cut block's null
 * @param {Set<number>} cut
 * @param {boolean} speculate
 * @param {boolean} [callReturn]
 * @returns {{ known: Shape[], needs: (Shape | null)[] }}  `known`: at each block's start;
 *     `needs`: what each block the region can be entered at tests, null where it tests nothing
 */
export function planStack(region, states, cut, speculate, callReturn = false){
    const blocks = region.blocks;
    const index = new Map(blocks.map((block, i)=>[block.start, i]));
    const entryState = states[index.get(region.entry) ?? 0];
    const returns = inlineReturns(region);
    // The edges `trackRegion` follows, which are every way the emitter goes
    // from one block to another without leaving the function.
    const successors = blocks.map(block=>{
        const { kind, targets, next } = block.exit;
        const to = [...targets];
        if (kind === 'fallthrough' || kind === 'jcc' || kind === 'loop')
        {
            to.push(next);
        }
        else if (kind === 'ret')
        {
            to.push(...returns.get(block.start) ?? []);
        }
        return [...new Set(to.map(target=>index.get(target) ?? -1))];
    });
    // The calls made as wasm calls, each by the block its return comes back to.
    /** @type {number[][]} */
    const returnedFrom = blocks.map(()=>[]);
    blocks.forEach((block, p)=>{
        const at = callReturn && callsOut(block, index) ? index.get(block.exit.next) : undefined;
        if (at !== undefined)
        {
            returnedFrom[at].push(p);
        }
    });
    /** @type {number[][]} */
    const predecessors = blocks.map(()=>[]);
    successors.forEach((to, i)=>{
        for (const j of to)
        {
            if (j >= 0)
            {
                predecessors[j].push(i);
            }
        }
    });
    /**
     * Walks a block's instructions from its tracked state: what it leaves
     * known from `known`, what it reads or pushes into that it has not set
     * itself (`need`), what it sets (`set`), and the state it ends in -- null
     * where the block never gets to its end: its state is not known (no x87
     * of it is emitted, and nothing reaches it but through a block that
     * leaves), or the tracking stops in it, which the emitter leaves at.
     *
     * @param {number} i @param {Shape} known
     */
    const walk = (i, known)=>{
        let state = states[i];
        const need = { held: 0, empty: 0 };
        let set = 0;
        if (state === null)
        {
            return { after: NOTHING, need, set: 0xff, end: null };
        }
        for (const instruction of blocks[i].instructions)
        {
            if (!isX87(instruction))
            {
                if (movesMask(instruction))
                {
                    known = NOTHING;
                    set = 0xff;
                }
                state = /** @type {StackState} */ (step(instruction, state));
                continue;
            }
            const next = step(instruction, state);
            if (next === null)
            {
                return { after: NOTHING, need, set: 0xff, end: null };
            }
            const use = stackUse(instruction, state);
            for (const source of use.sources)
            {
                need.held |= 1 << ((state.top + source) & 7) & ~set;
            }
            if (use.pushes)
            {
                need.empty |= 1 << ((state.top - 1) & 7) & ~set;
            }
            for (const [k] of use.marks)
            {
                set |= 1 << k;
            }
            set |= use.whole === null ? 0 : 0xff;
            known = advance(known, use, state);
            state = next;
        }
        return { after: known, need, set, end: state };
    };
    const own = blocks.map((_, i)=>walk(i, NOTHING));
    const entries = blocks.map((_, i)=>{
        const state = states[i];
        return state !== null && !cut.has(i) && entryState !== null
            && sameState(state, entryState);
    });
    /** @type {(Shape | null)[]} */
    const needs = blocks.map(()=>null);
    if (speculate)
    {
        // What an entry tests: what a path from the block needs before the
        // path itself sets the register -- read: held, pushed into: empty --
        // on any path that stays in the region (an edge into a block compiled
        // for another top leaves). Compiled code keeps the stack in one shape
        // at each place, so what one path from a place needs every run
        // through it has, and a branch that does no x87 on one side does not
        // take the need away from the other.
        const along = successors.map((to, i)=>{
            const end = own[i].end;
            return end === null ? [] : to.filter(j=>j >= 0 && states[j]?.top === end.top);
        });
        const ahead = blocks.map(()=>({ held: 0, empty: 0 }));
        for (let changed = true; changed;)
        {
            changed = false;
            for (let i = blocks.length - 1; i >= 0; i--)
            {
                let held = 0;
                let empty = 0;
                for (const j of along[i])
                {
                    held |= ahead[j].held;
                    empty |= ahead[j].empty;
                }
                const { need, set } = own[i];
                held = need.held | held & ~set;
                empty = need.empty | empty & ~set;
                if (held !== ahead[i].held || empty !== ahead[i].empty)
                {
                    ahead[i] = { held, empty };
                    changed = true;
                }
            }
        }
        blocks.forEach((_, i)=>{
            // A register one path needs held and another empty is not in
            // one shape here: its checks stay. A block a wasm call returns to
            // tests the same after the call (`x87AfterCall`), whatever top the
            // region was entered at: the callee may have left any shape.
            const { held, empty } = ahead[i];
            const both = held & empty;
            if ((entries[i] || returnedFrom[i].length > 0) && (held | empty) !== both)
            {
                needs[i] = { held: held & ~both, empty: empty & ~both, c1: false };
            }
        });
    }
    // The blocks that run: the entries, and what a block that gets to its end
    // goes on to. Only those are predecessors.
    const runs = entries.slice();
    for (let changed = true; changed;)
    {
        changed = false;
        blocks.forEach((_, i)=>{
            if (!runs[i] && [...predecessors[i], ...returnedFrom[i]]
                .some(p=>runs[p] && own[p].end !== null))
            {
                runs[i] = true;
                changed = true;
            }
        });
    }
    const arriving = predecessors.map(from=>from.filter(p=>runs[p] && own[p].end !== null));
    // What is known at each block's start: the greatest fixed point, every
    // block starting from everything, so a loop keeps what its body keeps.
    /** @type {Shape} */
    const everything = { held: 0xff, empty: 0xff, c1: true };
    const known = blocks.map(()=>everything);
    const after = blocks.map(()=>everything);
    for (let changed = true; changed;)
    {
        changed = false;
        for (let i = 0; i < blocks.length; i++)
        {
            let shape = entries[i] ? needs[i] ?? NOTHING : runs[i] ? everything : NOTHING;
            for (const p of arriving[i])
            {
                shape = meet(shape, after[p]);
            }
            if (returnedFrom[i].some(p=>runs[p] && own[p].end !== null))
            {
                shape = meet(shape, needs[i] ?? NOTHING);
            }
            if (!sameShape(shape, known[i]))
            {
                known[i] = shape;
                changed = true;
            }
            const left = walk(i, shape).after;
            if (!sameShape(left, after[i]))
            {
                after[i] = left;
                changed = true;
            }
        }
    }
    // A block no run reaches may be left knowing a register both ways.
    const sure = known.map(({ held, empty, c1 })=>({
        held: held & ~empty, empty: empty & ~held, c1,
    }));
    return { known: sure, needs };
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
 * @property {Map<number, number>} guarded  the blocks compiled for a top the tracker guessed,
 *     with that top: each tests the machine's at its start (`x87BlockStart`)
 * @property {StackState | null} current   the state at the current point of emission
 * @property {StackState | null} landed   where the registers are after the last `x87Edge`
 *     moved them: `current` describes them only until then
 * @property {boolean} controlWritten
 * @property {number} checkedPrecision  the block whose precision control a `wide` region
 *     has checked since the last write of the control word, or -1
 * @property {Known} known   what the current block's own x87 has made of the stack words
 * @property {Shape[]} shapes  what is known of the stack words at each block's start (`planStack`)
 * @property {(Shape | null)[]} needs  what each entry tests of the stack words, or null
 * @property {Shape} stack   what is known of them at the current point of emission
 * @property {number} guards  stack-fault checks emitted, for the tests
 * @property {number} relaxedReads  status-word reads through which a module that is not
 *     `precise` lets the program see what it does not keep (`readsRelaxed`)
 * @property {boolean} tracksExact  the region has a quadword `fild` and a quadword `fistp` or
 *     `fisttp`, and no MMX: the pair copies eight bytes, which a double does not hold
 * @property {number} exact  the x87 locals, by their index 0-7 (which an exchange moves with
 *     the value), holding what a quadword `fild` of this block loaded and nothing has written
 *     since: the integer itself is in the local's `shadow`
 * @property {number} exactNaN  those of them that may hold the indefinite instead, where the
 *     push or the copy that made them was not known to find its registers as it needed
 * @property {number[]} shadow  the i64 local shadowing each x87 local, -1 until one is needed
 * @property {number} dyn  in a region that tracks them, the i32 local of the locals that hold
 *     a quadword `fild`'s integer at run time, whichever block or executor loaded it: taken
 *     from the state block where the region is entered (`layout.x87Exact`), kept by every
 *     instruction as `exact` is, and left there at every exit; -1 elsewhere
 * @property {Singles} singles  what the current block holds in f32 locals (`floats`)
 * @property {number[]} single  the f32 local beside each x87 local, -1 until one is needed
 * @property {number[]} floatTemps  f32 scratch locals of the float path, made as needed
 * @property {{ held: number, numeric: number }[] | null} floatsIn  what each block starts
 *     with in floats (`planFloats`), or null where the float path is not taken
 */

/**
 * What the current block's own x87 instructions have made of the empty mask
 * and the top, known while translating: the pushes and pops of the plain
 * forms (`MASK_SAFE`) leave the mask and top locals stale, written once where
 * they are read -- before a check that needs a stale bit, at every exit and
 * edge (`x87Flush`), and at the block's end -- rather than at each, and the
 * bits they leave are `held` and `empty` here. A register the block has
 * already marked dirty is not marked again. Known only within a block, never
 * in a region with MMX (which holds every register), and forgotten around any
 * operation that changes the mask otherwise. (Which checks are decided is
 * `X87Emit.stack`'s, which knows more.)
 *
 * @typedef {Object} Known
 * @property {number} block    the block this knowledge is of, or -1
 * @property {number} held     registers known held
 * @property {number} empty    registers known empty
 * @property {number} stale    registers whose bit in the empty-mask local is not yet written
 * @property {number} dirty    registers known marked in the dirty-mask local
 * @property {number} pending  registers written on the block's straight path and not yet
 *     marked in the dirty-mask local: only the epilogue's and a call's stores read the
 *     mask, each after a flush, so the marks are one write where the block's flush is
 * @property {number} top      the top as the block's pushes and pops left it
 * @property {boolean} topStale  the top local is not yet written
 */

/** @returns {Known} */
const unknown = ()=>({
    block: -1, held: 0, empty: 0, stale: 0, dirty: 0, pending: 0, top: 0, topStale: false,
});

/**
 * Which x87 locals hold their value as a float too, in a region compiled for
 * single precision with its arithmetic in floats (`floats`): a float loaded, a
 * constant, or the result of an operation on two such that the range test
 * passed -- the processor's 24-bit result exactly, since an operation on
 * floats rounded once to 24 bits is the float operation wherever the result
 * is a normal float. A chain of such operations then runs in f32 with no
 * conversion between them; the f64 local is written from the float where
 * something else reads it: every exit and edge (in its branch), the block's
 * end, a call, and any form the float path does not take, which forgets only
 * the floats it writes or pops. An exchange moves nothing, the bits being the
 * locals'; a block starts with the floats every edge into it hands on
 * (`planFloats`).
 *
 * @typedef {Object} Singles
 * @property {number} block   the block they are of, or -1
 * @property {number} held    the x87 locals (by index 0-7) whose value their f32 local holds
 * @property {number} stale   of them, those whose f64 local does not hold it yet
 * @property {number} numeric of them, those known not to be a NaN, which a float store writes
 *     as it is (a NaN loaded goes out quieted, through the double, as the processor's does)
 */

/** @returns {Singles} */
const noSingles = ()=>({ block: -1, held: 0, stale: 0, numeric: 0 });

/**
 * The f32 local beside x87 local k, made the first time one is needed.
 *
 * @param {E} e @param {number} k
 */
function singleOf(e, k){
    const x = e.x87;
    if (x.single[k] < 0)
    {
        x.single[k] = e.localTypes.length + STATE_PARAMS;
        e.localTypes.push(ValType.f32);
    }
    return x.single[k];
}

/**
 * The float path's scratch f32 local n, made the first time.
 *
 * @param {E} e @param {number} n
 */
function floatTempOf(e, n){
    const x = e.x87;
    while (x.floatTemps.length <= n)
    {
        x.floatTemps.push(e.localTypes.length + STATE_PARAMS);
        e.localTypes.push(ValType.f32);
    }
    return x.floatTemps[n];
}

/**
 * Writes the f64 locals the float path left stale from their floats (`Singles`):
 * inside an exit's or an edge's branch (`commit` false), the straight path going
 * on as it was; on the straight path before something reads the f64 locals, after
 * which the floats are forgotten.
 *
 * @param {E} e @param {boolean} commit
 */
export function x87WriteSingles(e, commit){
    const x = e.x87;
    for (let k = 0; k < 8; k++)
    {
        if ((x.singles.stale & 1 << k) !== 0)
        {
            e.b.localGet(x.single[k]).op(F64.promoteF32).localSet(x.base + k);
        }
    }
    if (commit)
    {
        x.singles = noSingles();
    }
}

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
 * What a region's x87 emission is planned from, the same for the function of
 * its copies as for its own (`analyseX87`): whether it uses x87, whether it has
 * MMX too, whether it tracks a quadword `fild` exactly, the tracker's states at
 * each block's start and end with the blocks it cuts, and the stack words' shape
 * each block start knows and each entry tests. Null for a region with no x87.
 *
 * @typedef {{ hasMmx: boolean, tracksExact: boolean, states: (StackState | null)[],
 *     ends: (StackState | null)[], cut: Set<number>, guarded: Map<number, number>,
 *     shapes: Shape[], needs: (Shape | null)[] } | null} X87Analysis
 */

/**
 * The planning of a region's x87 (`X87Analysis`), a pure function of the region
 * in its emitting order, the classes left out, the entry's top and `checked`.
 *
 * @param {import('../region.js').Region} region
 * @param {Set<string>} leaveOut @param {number} entryTop @param {boolean} checked
 * @param {boolean} [callReturn]  a call that leaves the region is a wasm call (`trackRegion`)
 * @returns {X87Analysis}
 */
export function analyseX87(region, leaveOut, entryTop, checked, callReturn = false){
    const uses = !leaveOut.has('x87')
        && region.blocks.some(block=>block.instructions.some(isX87));
    if (!uses)
    {
        return null;
    }
    const hasMmx = regionHasMmx(region, leaveOut);
    /** @param {(instruction: Instruction) => boolean} test */
    const any = test=>region.blocks.some(block=>block.instructions.some(test));
    const tracksExact = !hasMmx
        && any(({ op, operands })=>op === 'fild' && operands[1].size === 8)
        && any(({ op, operands })=>(op === 'fistp' || op === 'fisttp') && operands[0].size === 8);
    const { states, cut, ends, guarded } = trackRegion(region, entryTop, callReturn);
    const { known: shapes, needs } = hasMmx
        ? { known: region.blocks.map(()=>NOTHING), needs: [] }
        : planStack(region, states, cut, !checked, callReturn);
    return { hasMmx, tracksExact, states, ends, cut, guarded, shapes, needs };
}

/**
 * Which x87 locals hold their value as a float at each block's start
 * (`Singles`), for a region whose single-precision arithmetic runs on floats:
 * what every edge into the block from inside the region leaves there, the
 * block's own forms followed as `emitX87` takes them -- a form the float path
 * takes with its operands as floats and its stack known clear, any other
 * forgetting the registers it writes or pops (`floatsGone`). Only a register
 * the stack's plan knows held at the block's start is one. An edge that moves
 * the registers between locals moves the floats with them (`x87MoveTo`); one
 * after a call (the callee may have written the stack), out of an indirect
 * jump or call, or onto another top hands on nothing; a block cut, entered at
 * a guessed top, or with no edge into it from the region starts with nothing.
 * An entry from outside the region fills the floats from the doubles it
 * loaded and tests them (`x87EntryCheck`). Settled from all floats down, a
 * pass at a time.
 *
 * @param {import('../region.js').Region} region  in its emitting order
 * @param {NonNullable<X87Analysis>} analysis
 * @param {Map<number, number[]>} returns  by `ret` block, the return addresses it jumps to
 * @returns {{ held: number, numeric: number }[]}
 */
export function planFloats(region, analysis, returns){
    const { states, shapes, cut, guarded } = analysis;
    const { blocks } = region;
    const indexOf = new Map(blocks.map((block, index)=>[block.start, index]));
    /** @param {number} index @param {{ held: number, numeric: number }} start */
    const across = (index, start)=>{
        const begin = states[index];
        if (begin === null || cut.has(index))
        {
            return null;
        }
        let { held, numeric } = start;
        let state = cloneState(begin);
        let stack = shapes[index] ?? NOTHING;
        for (const instruction of blocks[index].instructions)
        {
            if (!isX87(instruction))
            {
                continue;
            }
            const next = step(instruction, state);
            if (next === null)
            {
                return null;
            }
            const use = stackUse(instruction, state);
            const at = (/** @type {number} */ i)=>state.slot[(state.top + i) & 7];
            const isSingle = (/** @type {number} */ i)=>(held & 1 << at(i)) !== 0;
            const isNumeric = (/** @type {number} */ i)=>(numeric & 1 << at(i)) !== 0;
            const { op, operands: [dst, src] } = instruction;
            // As `guard` decides it: every source known held, a push's register known empty.
            let read = 0;
            for (const i of use.sources)
            {
                read |= 1 << ((state.top + i) & 7);
            }
            const clear = (read & ~stack.held) === 0
                && !(use.pushes && (stack.empty & 1 << ((state.top - 1) & 7)) === 0);
            const taken = floatForm(op, dst, src, isSingle, isNumeric) && clear;
            if (taken)
            {
                const bit = (/** @type {number} */ k)=>1 << k;
                if (op === 'fld' || op === 'fld1' || op === 'fldz')
                {
                    const into = at(-1);
                    held |= bit(into);
                    const kept = op === 'fld' ? src.kind === 'x87' && isNumeric(Number(src.reg))
                        : true;
                    numeric = kept ? numeric | bit(into) : numeric & ~bit(into);
                }
                else if ((op === 'fst' || op === 'fstp') && dst.kind === 'x87')
                {
                    const into = at(Number(dst.reg));
                    held |= bit(into);
                    numeric = isNumeric(0) ? numeric | bit(into) : numeric & ~bit(into);
                }
                else if (op === 'fsqrt')
                {
                    numeric |= bit(at(0));
                }
                else if (FLOAT_ARITHMETIC.has(op))
                {
                    const into = at(dst?.kind === 'x87' ? Number(dst.reg) : 0);
                    held |= bit(into);
                    numeric |= bit(into);
                }
            }
            const gone = floatsGone(instruction, state, taken);
            held &= ~gone;
            numeric &= ~gone;
            stack = advance(stack, use, state);
            state = next;
        }
        return { held, numeric, end: state };
    };
    /**
     * The block's edges into the region: each target, and whether the floats go along.
     * @param {import('../region.js').Block} block @returns {[number, boolean][]}
     */
    const edgesOf = block=>{
        const { exit } = block;
        const last = block.instructions[block.instructions.length - 1];
        switch (exit.kind)
        {
            case 'fallthrough': case 'jump': case 'jcc': case 'loop':
                return exit.targets.map(target=>[target, true]);
            case 'ret':
                return (returns.get(block.start) ?? []).map(target=>[target, true]);
            case 'call':
                // A callee formed in is jumped to; any other call is made and returned from.
                if (!exit.predicted && last?.op === 'call' && last.operands[0]?.kind === 'rel'
                    && indexOf.has(exit.targets[0]))
                {
                    return [[exit.targets[0], true]];
                }
                return [...exit.targets, exit.next].map(target=>[target, false]);
            default:
                return [...exit.targets, exit.next].map((/** @type {number} */ target)=>
                    [target, false]);
        }
    };
    /** @type {{ from: number, carries: boolean }[][]} */
    const into = blocks.map(()=>[]);
    blocks.forEach((block, from)=>{
        for (const [target, carries] of edgesOf(block))
        {
            const to = indexOf.get(target);
            if (to !== undefined)
            {
                into[to].push({ from, carries });
            }
        }
    });
    // Only a register the plan knows held at the block's start (`planStack`) is a float
    // there: an empty one's double is whatever was last in it.
    const holds = blocks.map((_, index)=>{
        const state = states[index];
        const shape = shapes[index] ?? NOTHING;
        let locals = 0;
        for (let physical = 0; physical < 8; physical++)
        {
            if (state !== null && (shape.held & 1 << physical) !== 0)
            {
                locals |= 1 << state.slot[physical];
            }
        }
        return locals;
    });
    const none = { held: 0, numeric: 0 };
    /** @type {{ held: number, numeric: number }[]} */
    const start = blocks.map((_, index)=>(into[index].length === 0 || guarded.has(index)
        || cut.has(index) || states[index] === null ? none
        : { held: holds[index], numeric: holds[index] }));
    for (let changed = true, passes = 0; changed && passes < blocks.length * 16 + 16; passes++)
    {
        changed = false;
        const ends = blocks.map((_, index)=>across(index, start[index]));
        start.forEach((was, index)=>{
            if (was.held === 0)
            {
                return;
            }
            let [held, numeric] = [holds[index], holds[index]];
            for (const { from, carries } of into[index])
            {
                const end = ends[from];
                const to = states[index];
                // An edge whose permutation differs moves the floats with the doubles
                // (`x87MoveTo`); one onto another top leaves.
                const goes = carries && end !== null && to !== null && end.end.top === to.top;
                /** Locals at the edge's end -> the target's. @param {number} mask */
                const moved = mask=>{
                    let there = 0;
                    for (let k = 0; k < 8; k++)
                    {
                        if (end !== null && to !== null && (mask & 1 << end.end.slot[k]) !== 0)
                        {
                            there |= 1 << to.slot[k];
                        }
                    }
                    return there;
                };
                held &= goes ? moved(end.held) : 0;
                numeric &= goes ? moved(end.numeric) : 0;
            }
            numeric &= held;
            if (held !== was.held || numeric !== was.numeric)
            {
                start[index] = { held, numeric };
                changed = true;
            }
        });
    }
    return start;
}

/**
 * Sets up the region's x87 emission: decides whether the region uses x87,
 * runs the tracker and allocates the locals. A region with MMX in it keeps
 * x87 too -- the two are the mantissa and the value of one set of eight
 * registers, reconciled at every write (see `hasMmx`) -- rather than leaving
 * x87 to the other executor at the first instruction that has both.
 *
 * A region with MMX in it knows nothing of the stack words across its
 * instructions (every register's two views meet there), and a `checked` one
 * tests nothing at its entries.
 *
 * @param {E} e @param {number} entryTop @param {boolean} [checked]
 * @param {X87Analysis} [analysis]  the region's planning, when made already
 *     (`analyseX87`): nothing of it is written while emitting
 * @returns {X87Emit}
 */
export function prepareX87(e, entryTop, checked = false,
    analysis = analyseX87(e.region, e.context.leaveOut, entryTop, checked))
{
    if (analysis === null)
    {
        return {
            active: false, hasMmx: false, base: 0, form: -1, temp: 0, temp2: 0, temp3: 0,
            states: [], ends: [], cut: new Set(), guarded: new Map(), current: null, landed: null,
            controlWritten: false, checkedPrecision: -1, known: unknown(), shapes: [], needs: [],
            stack: NOTHING,
            guards: 0, relaxedReads: 0, tracksExact: false, exact: 0, exactNaN: 0, shadow: [],
            dyn: -1, singles: noSingles(), single: [], floatTemps: [], floatsIn: null,
        };
    }
    const { hasMmx, tracksExact, states, ends, cut, guarded, shapes, needs } = analysis;
    const base = e.localTypes.length + STATE_PARAMS;
    // The eight registers, three scratch locals, and a fused compare's operands.
    for (let k = 0; k < 13; k++)
    {
        e.localTypes.push(ValType.f64);
    }
    let form = -1;
    if (hasMmx)
    {
        e.localTypes.push(ValType.i32);
        form = base + 13;
    }
    // A quadword held across a block boundary -- a copy that keeps its first and
    // last eight bytes on the stack around a loop -- or loaded before the region
    // was entered is exact only at run time.
    let dyn = -1;
    const shadow = new Array(8).fill(-1);
    if (tracksExact)
    {
        dyn = e.localTypes.length + STATE_PARAMS;
        e.localTypes.push(ValType.i32);
        for (let k = 0; k < 8; k++)
        {
            shadow[k] = e.localTypes.length + STATE_PARAMS;
            e.localTypes.push(ValType.i64);
        }
    }
    // Known before any block is compiled: blocks are compiled in their order,
    // not the order they run in, and a call compiled ahead of the block that
    // loads the word would hand its callee the word the region came in with,
    // and take that one back with the state after the call.
    const controlWritten = e.region.blocks.some(block=>block.instructions.some(
        instruction=>CONTROL_WRITERS.has(instruction.op)));
    return {
        active: true, hasMmx, base, form, temp: base + 8, temp2: base + 9, temp3: base + 10,
        states, ends, cut, guarded, current: null, landed: null, controlWritten,
        checkedPrecision: -1,
        known: unknown(), shapes, needs, stack: NOTHING, guards: 0, relaxedReads: 0,
        tracksExact, exact: 0, exactNaN: 0, shadow, dyn,
        singles: noSingles(), single: new Array(8).fill(-1), floatTemps: [],
        floatsIn: e.floats === true && !hasMmx && e.context.precise !== true
            ? planFloats(e.region, analysis, e.returns) : null,
    };
}

/**
 * At the head of the function, before its dispatch: an entry into a block
 * that needs the stack words in a shape (`needs`) tests them once, and leaves
 * before the block with `SHAPE` when they are not in it. A jump inside the
 * region comes back through the dispatch alone and tests nothing.
 *
 * @param {E} e
 */
export function x87EntryCheck(e){
    const x = e.x87;
    /** @type {{ label: number, need: Shape | null, floats: number }[]} */
    const tests = [];
    const count = e.region.blocks.length;
    for (let label = 0; label < count; label++)
    {
        const need = x.needs[label] ?? null;
        const floats = x.floatsIn?.[label]?.held ?? 0;
        if (need !== null || floats !== 0)
        {
            tests.push({ label, need, floats });
        }
    }
    if (tests.length === 0)
    {
        return;
    }
    const { b } = e;
    e.open('shaped', EMPTY);
    for (let k = tests.length - 1; k >= 0; k--)
    {
        e.open(`shape${k}`, EMPTY);
    }
    const depths = e.labelBlocks().map(index=>{
        const k = tests.findIndex(test=>test.label === index);
        return e.depthOf(k < 0 ? 'shaped' : `shape${k}`);
    });
    b.localGet(Local.label).brTable(depths, e.depthOf('shaped'));
    tests.forEach(({ label, need, floats }, k)=>{
        e.close();
        if (need !== null)
        {
            // A held register's bit is 0 and an empty one's 1: whatever is not
            // as needed survives the xor.
            b.localGet(Local.x87Empty);
            if (need.empty !== 0)
            {
                b.i32const(need.empty).op(I32.xor);
            }
            b.i32const(need.held | need.empty).op(I32.and);
            e.openGuard('unshaped', EMPTY);
            e.exitAt(e.region.blocks[label].start, Exit.UNTRANSLATED, SHAPE);
            e.close();
        }
        if (floats !== 0)
        {
            // The block takes these registers as floats (`planFloats`): each filled
            // from the double the entry loaded, which must be that float exactly --
            // a NaN, a double of more bits or past a float's range leaves for the host.
            let tested = false;
            for (let local = 0; local < 8; local++)
            {
                if ((floats & 1 << local) === 0)
                {
                    continue;
                }
                b.localGet(x.base + local).op(F32.demoteF64).localTee(singleOf(e, local))
                    .op(F64.promoteF32).localGet(x.base + local).op(F64.eq);
                if (tested)
                {
                    b.op(I32.and);
                }
                tested = true;
            }
            b.op(I32.eqz);
            e.openGuard('unfloat', EMPTY);
            e.exitAt(e.region.blocks[label].start, Exit.UNTRANSLATED, RANGE);
            e.close();
        }
        if (k < tests.length - 1)
        {
            b.br(e.depthOf('shaped'));
        }
    });
    e.close();
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
    atState(e.context, b).load('i32_8u', { offset: layout.x87Top }).localSet(Local.x87Top);
    atState(e.context, b).load('i32_8u', { offset: layout.x87Empty }).localSet(Local.x87Empty);
    atState(e.context, b).load('i32_16u', { offset: layout.x87Status }).localSet(Local.x87Status);
    atState(e.context, b).load('i32_16u', { offset: layout.x87Control }).localSet(Local.x87Control);
    b.i32const(0).localSet(Local.x87Dirty);
    if (x.hasMmx)
    {
        b.i32const(0).localSet(x.form);
        x87LoadRegisters(e, ()=>true);
    }
}

/**
 * The held registers the region names into their locals (in a region with
 * MMX, every register); the region emitter places these once the body says
 * which locals it uses.
 *
 * @param {E} e @param {(k: number) => boolean} needed
 */
export function x87LoadRegisters(e, needed){
    const { b, layout } = e;
    const x = e.x87;
    for (let k = 0; k < 8; k++)
    {
        if (!needed(k))
        {
            continue;
        }
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
            atState(e.context, b).load('i32_16u', { offset: at + 8 })
                .i32const(RELAXED_TAG).op(I32.eq);
            e.openIf('tagged', EMPTY);
            atState(e.context, b).load('i64', { offset: at }).op(F64.reinterpretI64)
                .localSet(x.base + k);
            b.else();
            b.i32const(at).call(/** @type {number} */ (e.context.f80ToF64)).localSet(x.base + k);
            e.close();
            if (x.hasMmx)
            {
                // The form the register enters in: an MMX write before this
                // region left the exponent and sign all ones, which the exit
                // writes back as it found it rather than as a relaxed double.
                atState(e.context, b).load('i32_16u', { offset: at + 8 }).i32const(0xffff)
                    .op(I32.eq);
                e.openIf(`mmxform${k}`, EMPTY);
                b.localGet(x.form).i32const(1 << k).op(I32.or).localSet(x.form);
                e.close();
            }
        }
        else
        {
            atState(e.context, b).load('f64', { offset: at }).localSet(x.base + k);
        }
        if (!x.hasMmx)
        {
            e.close();
        }
    }
    if (x.dyn >= 0)
    {
        const exactAt = exactPlace(layout);
        if (exactAt < 0)
        {
            b.i32const(0).localSet(x.dyn);
            return;
        }
        atState(e.context, b).load('i32_8u', { offset: exactAt }).localSet(x.dyn);
        for (let k = 0; k < 8; k++)
        {
            atState(e.context, b).load('i64', { offset: layout.x87 + k * 16 + 8 })
                .localSet(x.shadow[k]);
        }
    }
}

/**
 * Where the state block keeps the exact quadwords' marks, or -1: a layout of
 * doubles only, the quadword in the eight bytes past each.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 */
const exactPlace = layout=>(layout.x87Format === 'f64' ? layout.x87Exact ?? -1 : -1);

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
    atState(e.context, b).localGet(Local.x87Top).store('i32_8', { offset: layout.x87Top });
    atState(e.context, b).localGet(Local.x87Empty).store('i32_8', { offset: layout.x87Empty });
    atState(e.context, b).localGet(Local.x87Status).store('i32_16', { offset: layout.x87Status });
    if (x.controlWritten)
    {
        atState(e.context, b).localGet(Local.x87Control)
            .store('i32_16', { offset: layout.x87Control });
    }
}

/**
 * Every dirty register back from its local, for the registers the region
 * writes: a register dirty without its local written (an exchange with
 * itself) holds what the state block already has.
 *
 * @param {E} e @param {(k: number) => boolean} written
 */
export function x87StoreRegisters(e, written){
    const { b, layout } = e;
    const x = e.x87;
    for (let k = 0; k < 8; k++)
    {
        if (!written(k))
        {
            continue;
        }
        const at = layout.x87 + k * 16;
        b.localGet(Local.x87Dirty).i32const(1 << k).op(I32.and);
        e.openIf(`dirty${k}`, EMPTY);
        if (layout.x87Format === 'tagged80')
        {
            atState(e.context, b).localGet(x.base + k).op(I64.reinterpretF64)
                .store('i64', { offset: at });
            atState(e.context, b).i32const(RELAXED_TAG).store('i32_16', { offset: at + 8 });
        }
        else
        {
            atState(e.context, b).localGet(x.base + k).store('f64', { offset: at });
        }
        e.close();
    }
    if (x.dyn >= 0 && exactPlace(layout) >= 0)
    {
        // What the region knows at run time, its own quadwords and the ones
        // it came in with alike.
        atState(e.context, b).localGet(x.dyn).store('i32_8', { offset: exactPlace(layout) });
        for (let k = 0; k < 8; k++)
        {
            atState(e.context, b).localGet(x.shadow[k])
                .store('i64', { offset: layout.x87 + k * 16 + 8 });
        }
        return;
    }
    x87DropExact(e, ()=>b.localGet(Local.x87Dirty));
}

/**
 * Takes the exact-quadword marks (`layout.x87Exact`) off the registers this
 * exit stores: an interpreter's `fild` before the region left its integer in
 * the block, and a register the region wrote holds something else now. The
 * region's own exact quadwords are not left there; it stores them itself.
 *
 * @param {E} e @param {() => void} mask  Pushes the registers stored, a bit each.
 */
export function x87DropExact(e, mask){
    const { b, layout } = e;
    const at = exactPlace(layout);
    if (at < 0)
    {
        return;
    }
    atState(e.context, atState(e.context, b)).load('i32_8u', { offset: at });
    mask();
    b.i32const(-1).op(I32.xor).op(I32.and).store('i32_8', { offset: at });
}

/**
 * At a block's start: the tracked state becomes current, and the top local
 * is set. A cut block answers false: the caller leaves before it.
 *
 * @param {E} e @param {number} index
 */
export function x87BlockStart(e, index){
    const x = e.x87;
    // Whatever a block before it left stale was written on its every way out;
    // what is known of the stack words there is the plan's. A cut block too:
    // the exit it is compiled as is reached from other blocks than the one
    // emitted before it, and that one -- a block that ended in a `ret` or a
    // `hlt`, whose own exits wrote its stale words -- left them uncommitted.
    x.known = unknown();
    // What every edge into it from the region left in floats, or an entry filled
    // and tested (`planFloats`); the f64 locals hold the same, written at the
    // block before's end.
    const floatsIn = x.floatsIn?.[index];
    x.singles = floatsIn === undefined || floatsIn.held === 0 ? noSingles()
        : { block: index, held: floatsIn.held, stale: 0, numeric: floatsIn.numeric };
    x.exact = 0;
    x.exactNaN = 0;
    if (x.cut.has(index))
    {
        x.current = null;
        x.stack = NOTHING;
        return false;
    }
    const top = x.guarded.get(index);
    if (top !== undefined)
    {
        // Compiled for a top no path of the region settles (`trackRegion`).
        // An edge from tracked code with another top leaves before it jumps
        // (`x87Edge`); what reaches this test with another top -- an entry
        // through the dispatch, an edge from code whose stack the region no
        // longer follows -- has the registers in their own locals and the top
        // local the machine's. Another top leaves for the host before
        // anything of the block runs, as a call's return does (`x87AfterCall`).
        x.current = null;
        e.b.localGet(Local.x87Top).i32const(top).op(I32.ne);
        e.openGuard('otherTop', EMPTY);
        e.exitAt(e.region.blocks[index].start, Exit.UNTRANSLATED);
        e.close();
    }
    x.current = x.states[index] === null ? null : cloneState(/** @type {StackState} */ (x.states[index]));
    x.stack = x.shapes[index] ?? NOTHING;
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
    x87Flush(e, false);
    const to = x.states[targetIndex];
    if (!to || x.cut.has(targetIndex))
    {
        // A block with no tracked state -- cut, or reached with none -- reads
        // register k from local k, on the machine's own top: the registers go
        // back to their own locals first, or a permutation this block made
        // (an fxch) is read there as the wrong registers. A call into a
        // formed-in leaf that two call sites reach with different tops is
        // such an edge.
        x.landed = x.current === null
            ? null : { top: x.current.top, slot: [0, 1, 2, 3, 4, 5, 6, 7] };
        if (x.landed !== null)
        {
            x87MoveTo(e, x.landed);
        }
        return true;
    }
    if (x.current !== null && to.top !== x.current.top)
    {
        return false;
    }
    x.landed = x.current === null ? null : to;
    x87MoveTo(e, to, (x.floatsIn?.[targetIndex]?.held ?? 0) !== 0);
    return true;
}

/**
 * Before an exit: the registers back in their own locals, so the epilogue
 * stores local k into register k. `from` is where they are when the exit
 * runs: the current state's, or the one an edge just moved them to.
 *
 * @param {E} e @param {StackState | null} [from]
 */
export function x87Normalise(e, from = e.x87.current){
    const x = e.x87;
    x87Flush(e, false);
    if (from !== null)
    {
        const held = x.current;
        x.current = from;
        x87MoveTo(e, { top: from.top, slot: [0, 1, 2, 3, 4, 5, 6, 7] });
        x.current = held;
    }
}

/**
 * Writes the empty-mask, top and dirty-mask locals the block's plain forms
 * left stale (see `Known`). `commit` says the write is on the block's straight
 * path, so the locals are current from here; an exit's or an edge's write
 * inside a branch leaves them stale for the path that goes on.
 *
 * @param {E} e @param {boolean} commit
 */
function x87Flush(e, commit){
    const { b } = e;
    const known = e.x87.known;
    if (!commit)
    {
        // An exit's or an edge's: the f64 locals are what it stores or hands on.
        x87WriteSingles(e, false);
    }
    if (known.stale !== 0)
    {
        b.localGet(Local.x87Empty).i32const(~known.stale).op(I32.and);
        if ((known.empty & known.stale) !== 0)
        {
            b.i32const(known.empty & known.stale).op(I32.or);
        }
        b.localSet(Local.x87Empty);
    }
    if (known.topStale)
    {
        b.i32const(known.top).localSet(Local.x87Top);
    }
    if (known.pending !== 0)
    {
        b.localGet(Local.x87Dirty).i32const(known.pending).op(I32.or).localSet(Local.x87Dirty);
    }
    if (commit)
    {
        known.stale = 0;
        known.topStale = false;
        known.dirty |= known.pending;
        known.pending = 0;
    }
}

/**
 * At a block's end, before its exit: the stale locals written on the
 * straight path, so every way out of the block -- the fall-through too --
 * leaves with them current.
 *
 * @param {E} e
 */
export function x87BlockEnd(e){
    x87WriteSingles(e, true);
    x87Flush(e, true);
}

/**
 * After a call out of the region that wrote the state block back and took it
 * again (the trap port's handler): the locals hold the machine's registers,
 * each in its own local, and the words as the handler left them. Nothing the
 * tracker knew of this place holds any more, so the exit that follows moves no
 * register and writes no stale word over what was taken back.
 *
 * @param {E} e
 */
export function x87Reloaded(e){
    const x = e.x87;
    x.current = null;
    x.known = unknown();
    x.singles = noSingles();
    x.stack = NOTHING;
    x.exact = 0;
    x.exactNaN = 0;
}

/**
 * After a call made as a wasm call came back and the state block was taken
 * back (`callAndReturn`): the stack as the callee left it. The code after the
 * call is compiled for the top the callee is taken to leave (`topAfterCall`) and, where that
 * block is an entry, for the shape it tests as one (`planStack`); a callee
 * that left another -- a function returning a float pushes one -- has the
 * region leave at the return address, untranslated, where the runtime takes
 * the stack as it is. The registers come back in their own locals.
 *
 * @param {E} e @param {number} next  the return address, a block of the region
 * @param {number} top  the top the code after the call is compiled for
 */
export function x87AfterCall(e, next, top){
    const { b } = e;
    const x = e.x87;
    x87Reloaded(e);
    b.localGet(Local.x87Top).i32const(top).op(I32.ne);
    e.openGuard('moved', EMPTY);
    e.exitAt(next, Exit.UNTRANSLATED);
    e.close();
    const need = x.needs[/** @type {number} */ (e.labels.get(next))];
    if (need)
    {
        // As the entry's test (`x87EntryCheck`): held is 0 in the mask, empty 1.
        b.localGet(Local.x87Empty);
        if (need.empty !== 0)
        {
            b.i32const(need.empty).op(I32.xor);
        }
        b.i32const(need.held | need.empty).op(I32.and);
        e.openGuard('unshaped', EMPTY);
        e.exitAt(next, Exit.UNTRANSLATED, SHAPE);
        e.close();
    }
    x.current = { top, slot: [0, 1, 2, 3, 4, 5, 6, 7] };
}

/**
 * Before an instruction of another class writes the stack words (an MMX
 * instruction's hold, `emms`): the stale ones written first, so the flush
 * does not later overwrite what it wrote, and nothing known after it.
 *
 * @param {E} e
 */
export function x87Forget(e){
    x87WriteSingles(e, true);
    x87Flush(e, true);
    e.x87.known.block = -1;
    e.x87.stack = NOTHING;
    e.x87.exact = 0;
    e.x87.exactNaN = 0;
}

/**
 * Moves the registers from the current state's locals to the target's: with
 * `floats`, for a block that takes floats in (`planFloats`), their f32 locals
 * along with the f64 ones.
 *
 * @param {E} e @param {StackState} to @param {boolean} [floats]
 */
function x87MoveTo(e, to, floats = false){
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
    /** @param {(k: number) => number} local @param {number} temp */
    const walk = (local, temp)=>{
        const done = new Set();
        for (const start of moves.keys())
        {
            if (done.has(start))
            {
                continue;
            }
            // Walk the cycle: save start, then dest <- source along it.
            b.localGet(local(start)).localSet(temp);
            let dest = start;
            for (;;)
            {
                const source = /** @type {number} */ (moves.get(dest));
                done.add(dest);
                if (source === start)
                {
                    b.localGet(temp).localSet(local(dest));
                    break;
                }
                b.localGet(local(source)).localSet(local(dest));
                dest = source;
            }
        }
    };
    walk(k=>x.base + k, x.temp);
    if (floats)
    {
        // Every float of the permutation, the ones the target holds among them.
        walk(k=>singleOf(e, k), floatTempOf(e, 0));
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
    const precise = e.context.precise === true;
    const state = x.current;
    const next = step(instruction, state);
    if (next === null)
    {
        // The tracker cannot follow this form (`fxsave`/`fbld` and kin).
        e.x87RefusalReason = 'step-null';
        return false;
    }
    const use = stackUse(instruction, state);
    if (x.hasMmx)
    {
        x.stack = NOTHING;
    }
    // A region compiled for the wide precision controls (double, extended)
    // leaves before the block's first rounding instruction when single is set,
    // and one compiled for single when it is not: one test a block rather than
    // one an operation. Precision control changes in a block only by its own
    // fldcw/fldenv/frstor/finit, which clear the check; an x87 region's host
    // calls leave the region.
    if ((e.wide || e.narrow) && ROUNDS.has(op)
        && x.checkedPrecision !== e.blockIndex)
    {
        b.localGet(Local.x87Control).i32const(0x300).op(I32.and);
        if (e.wide)
        {
            b.op(I32.eqz);
        }
        e.openGuard(e.wide ? 'single' : 'notSingle', EMPTY);
        // Not `exitBefore`: the exit is conditional, and the block stays an entry.
        e.blockRetired--;
        e.exitAt(instruction.eip, Exit.UNTRANSLATED, PRECISION);
        e.blockRetired++;
        e.close();
        x.checkedPrecision = e.blockIndex;
    }
    // What this block's own x87 instructions have made of the stack words (see
    // `Known`). Any other form writes the stale locals first, works on them
    // directly, and leaves nothing known for the next.
    const safe = MASK_SAFE.has(op) && !x.hasMmx;
    if (!safe || x.known.block !== e.blockIndex)
    {
        x87Flush(e, true);
        x.known = { ...unknown(), block: e.blockIndex, top: state.top };
    }
    const known = x.known;
    /** The local holding ST(i). @param {number} i */
    const st = i=>x.base + state.slot[(state.top + i) & 7];
    // The float path (`Singles`): the forms it takes when their operands are floats; any
    // other reads the f64 locals, so the stale ones are written first, and the floats it
    // writes or pops are forgotten after it (`floatsGone`). An exchange and the words'
    // own forms read no register.
    const floats = e.floats === true && !precise && !x.hasMmx;
    if (x.singles.block !== e.blockIndex)
    {
        x.singles = { ...noSingles(), block: e.blockIndex };
    }
    const singles = x.singles;
    /** Whether ST(i) is a float (`Singles`). @param {number} i */
    const isSingle = i=>(singles.held & 1 << state.slot[(state.top + i) & 7]) !== 0;
    /** Whether ST(i) is a float known not to be a NaN. @param {number} i */
    const isNumeric = i=>(singles.numeric & 1 << state.slot[(state.top + i) & 7]) !== 0;
    const viaFloats = floats && floatForm(op, operands[0], operands[1], isSingle, isNumeric);
    /** The stale f64 locals written on the straight path, the floats kept beside them. */
    const writeFloats = ()=>{
        x87WriteSingles(e, false);
        singles.stale = 0;
    };
    if (!viaFloats && !FLOAT_NEUTRAL.has(op))
    {
        writeFloats();
    }
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
    /**
     * Marks a physical register dirty, unless the block has already: on the
     * block's straight path, for the block's flush to write with the others
     * (`Known`); inside a branch of the instruction's own, at once, so the mark
     * is the branch's alone -- the epilogue stores a dirty register even when
     * it is empty, and one this way did not write holds no value of its own.
     *
     * @param {number} physical
     */
    const markDirty = physical=>{
        const bit = 1 << physical;
        if (safe && ((known.dirty | known.pending) & bit) !== 0)
        {
            return;
        }
        if (safe && e.controls.length === e.blockDepth)
        {
            known.pending |= bit;
            return;
        }
        b.localGet(Local.x87Dirty).i32const(bit).op(I32.or).localSet(Local.x87Dirty);
        if (safe)
        {
            known.dirty |= bit;
        }
    };
    /** Marks ST(i) written. @param {number} i */
    const dirty = i=>{
        const physical = (state.top + i) & 7;
        markDirty(physical);
        syncMm(physical, st(i));
    };
    /**
     * A physical register becomes held (`held`) or empty: in the local at once,
     * or in what the block knows, for the flush to write.
     *
     * @param {number} physical @param {boolean} held
     */
    const mark = (physical, held)=>{
        const bit = 1 << physical;
        if (safe)
        {
            known.stale |= bit;
        }
        else
        {
            b.localGet(Local.x87Empty).i32const(held ? ~bit : bit).op(held ? I32.and : I32.or)
                .localSet(Local.x87Empty);
        }
        known.held = held ? known.held | bit : known.held & ~bit;
        known.empty = held ? known.empty & ~bit : known.empty | bit;
    };
    /** The top local, now or at the flush. @param {number} top */
    const setTop = top=>{
        if (safe)
        {
            known.top = top;
            known.topStale = true;
        }
        else
        {
            b.i32const(top).localSet(Local.x87Top);
        }
    };
    const [dst, src] = operands;
    const push = ()=>{
        // The new top's slot is held and dirty; the value is on the stack.
        const top = (state.top - 1) & 7;
        const local = x.base + state.slot[top];
        b.localSet(local);
        mark(top, true);
        markDirty(top);
        syncMm(top, local);
        setTop(top);
    };

    /** @param {number} times */
    const popN = times=>{
        let top = state.top;
        for (let n = 0; n < times; n++)
        {
            mark(top, false);
            top = (top + 1) & 7;
        }
        if (times > 0)
        {
            setTop(top);
        }
    };
    /** The index of the local ST(i) is held in. @param {number} i */
    const localOf = i=>state.slot[(state.top + i) & 7];
    /**
     * The float path's write of x87 local k: its float holds the value, its f64 local
     * is stale until written (`Singles`).
     *
     * @param {number} k @param {boolean} numeric  known not to be a NaN
     */
    const setFloat = (k, numeric)=>{
        x.singles.held |= 1 << k;
        x.singles.stale |= 1 << k;
        x.singles.numeric = numeric ? x.singles.numeric | 1 << k : x.singles.numeric & ~(1 << k);
    };
    /** A push of a value already in the new top's float. @param {boolean} numeric */
    const pushFloat = numeric=>{
        const top = (state.top - 1) & 7;
        mark(top, true);
        markDirty(top);
        setTop(top);
        setFloat(state.slot[top], numeric);
    };
    /** Whether x87 local k's float is known not to be a NaN. @param {number} k */
    const numericAt = k=>(x.singles.numeric & 1 << k) !== 0;
    /** @param {number} n */
    const floatTemp = n=>floatTempOf(e, n);
    /** Whether the f32 on the stack is finite, by its exponent's bits: not an infinity or NaN. */
    const finite = ()=>{
        b.op(F32.bits).i32const(0x7f800000).op(I32.and).i32const(0x7f800000).op(I32.ne);
    };
    /**
     * Leaves before the instruction, for the host to run it, unless the i32 on the
     * stack says its float result is the processor's (`RANGE`): nothing of it is
     * written yet, and the exit writes the stale f64 locals.
     */
    const unlessFloat = ()=>{
        b.op(I32.eqz);
        e.openGuard('range', EMPTY);
        // Not `exitBefore`: the exit is conditional, and the block stays an entry.
        e.blockRetired--;
        e.exitAt(instruction.eip, Exit.UNTRANSLATED, RANGE);
        e.blockRetired++;
        e.close();
    };
    // The exact quadwords this instruction makes, from a load or a copy.
    let madeExact = 0;
    let madeNaN = 0;
    // A copy of a register whose exactness is known only at run time: from, to.
    /** @type {[number, number] | null} */
    let copiedDyn = null;
    /** The i64 local beside x87 local k. @param {number} k */
    const shadowOf = k=>{
        if (x.shadow[k] < 0)
        {
            x.shadow[k] = e.localTypes.length + STATE_PARAMS;
            e.localTypes.push(ValType.i64);
        }
        return x.shadow[k];
    };
    /**
     * Carries an exact quadword from one local to another with its value; after
     * the guard, whose `clear` says whether the value copied may be the
     * indefinite instead.
     *
     * @param {number} from @param {number} to
     */
    const copyExact = (from, to)=>{
        if ((x.exact & 1 << from) === 0)
        {
            if (x.dyn >= 0 && from !== to)
            {
                b.localGet(x.shadow[from]).localSet(x.shadow[to]);
                copiedDyn = [from, to];
            }
            return;
        }
        b.localGet(x.shadow[from]).localSet(shadowOf(to));
        madeExact |= 1 << to;
        if ((x.exactNaN & 1 << from) !== 0 || !clear)
        {
            madeNaN |= 1 << to;
        }
    };
    const finish = ()=>{
        x.current = next;
        if (singles.held !== 0)
        {
            const gone = floatsGone(instruction, state, viaFloats && clear);
            singles.held &= ~gone;
            singles.numeric &= ~gone;
        }
        if (!safe)
        {
            // Nothing is known after it: the next form starts afresh.
            known.block = -1;
        }
        x.stack = x.hasMmx ? NOTHING : advance(x.stack, use, state);
        if (x.tracksExact)
        {
            const writes = exactWrites(instruction, state.top, state.slot);
            const kept = writes === null ? 0 : ~writes.written;
            const popped = writes === null ? 0 : writes.popped;
            x.exact = ((x.exact & kept) | madeExact) & ~popped;
            x.exactNaN = ((x.exactNaN & kept) | madeNaN) & x.exact;
            if (x.dyn >= 0 && (writes === null || ~kept !== 0 || popped !== 0 || madeExact !== 0
                || copiedDyn !== null))
            {
                // The same at run time, a copy carrying the mark its source has.
                b.localGet(x.dyn).i32const(kept).op(I32.and);
                if (copiedDyn !== null)
                {
                    const [from, to] = copiedDyn;
                    b.localGet(x.dyn).i32const(from).op(I32.shrU).i32const(1).op(I32.and)
                        .i32const(to).op(I32.shl).op(I32.or);
                }
                if (madeExact !== 0)
                {
                    b.i32const(madeExact).op(I32.or);
                }
                b.i32const(~popped).op(I32.and).localSet(x.dyn);
            }
        }
        return true;
    };
    /** Sets the status bits given. @param {number} mask */
    const setStatus = mask=>{
        b.localGet(Local.x87Status).i32const(mask).op(I32.or).localSet(Local.x87Status);
    };
    const nanAt = precise ? e.layout.nanFirst ?? -1 : -1;
    /** @param {number} slot @param {() => void} [first] */
    const noteFirst = (slot, first)=>{
        if (nanAt >= 0)
        {
            noteEvent(e, slot, first);
        }
    };
    /** Which instruction asks the invalid-operation helper, for its record (`nanFirst`). */
    const noteAsker = ()=>{
        if (nanAt >= 0)
        {
            atState(e.context, b).i32const(instruction.eip)
                .store('i32', { offset: nanAt + NanRecord.ASKER });
        }
    };
    /**
     * A NaN made from numbers where the IE is set inline: the helper asked
     * only for its record.
     *
     * @param {number} a
     * @param {number | null} c
     */
    const noteMade = (a, c)=>{
        if (nanAt >= 0)
        {
            noteAsker();
            b.localGet(a);
            if (c === null)
            {
                b.f64const(0);
            }
            else
            {
                b.localGet(c);
            }
            b.i32const(0).i32const(0).call(/** @type {number} */ (e.context.x87Invalid)).drop();
        }
    };
    /**
     * The result on the stack noted when it is a NaN made from numbers: for
     * what the host's `Math` computes, which hands its NaN out positive.
     *
     * @param {number} a
     * @param {number | null} c
     */
    const noteIfMade = (a, c)=>{
        if (nanAt < 0)
        {
            return;
        }
        b.localTee(x.temp3).localGet(x.temp3).op(F64.ne);
        b.if(EMPTY);
        noteMade(a, c);
        b.end();
        b.localGet(x.temp3);
    };
    /** Pushes the QNaN indefinite. */
    const indefinite = ()=>b.i64const(-0x0008000000000000n).op(F64.reinterpretI64);
    /** The last guard decided while translating that nothing faults (t1 is 0). */
    let clear = false;
    /**
     * The stack-fault check: t1 is set when a source ST(i) is empty or a
     * push finds its register held, and IE and SF are raised. The
     * instruction then produces the indefinite where it would a value. A
     * push that overflowed -- its register already held -- also sets C1, as
     * the processor does to say which way the stack faulted; a region that
     * translated an MMX instruction meets it, since MMX holds every register
     * and the x87 push after it overflows. What reads and pushes is the
     * instruction's `use`.
     */
    const guard = ()=>{
        const { sources, pushes } = use;
        clear = false;
        let read = 0;
        for (const i of sources)
        {
            read |= 1 << ((state.top + i) & 7);
        }
        // A source known held and a push's register known empty (see
        // `planStack`) are decided now.
        read &= ~x.stack.held;
        const into = 1 << ((state.top - 1) & 7);
        const overflowChecked = pushes && (x.stack.empty & into) === 0;
        if (pushes && !x.stack.c1 && precise)
        {
            // C1 is a push's overflow indicator: cleared here, and set below
            // when the register it would take is held -- the processor leaves
            // C1 saying which way the last push faulted, so a later successful
            // push clears an earlier overflow's mark.
            b.localGet(Local.x87Status).i32const(~Status.C1).op(I32.and)
                .localSet(Local.x87Status);
        }
        if (read === 0 && !overflowChecked)
        {
            // Nothing to check: no fault, and no indefinite to choose.
            b.i32const(0).localSet(Local.t1);
            clear = true;
            return;
        }
        x.guards++;
        if (((read | (overflowChecked ? into : 0)) & known.stale) !== 0)
        {
            // A bit the check reads is one the block has not written yet.
            x87Flush(e, true);
        }
        if (read !== 0)
        {
            b.localGet(Local.x87Empty).i32const(read).op(I32.and).i32const(0).op(I32.ne);
        }
        else
        {
            b.i32const(0);
        }
        if (overflowChecked)
        {
            b.localGet(Local.x87Empty).i32const(into).op(I32.and).op(I32.eqz)
                .op(I32.or);
        }
        b.localSet(Local.t1);
        b.localGet(Local.t1);
        e.openGuard('fault', EMPTY);
        setStatus(Status.IE | Status.SF);
        // Which region, entered at which top, and the stack as it found it.
        noteFirst(NanRecord.FAULT, ()=>{
            const at = nanAt + NanRecord.FAULT_REGION;
            atState(e.context, b).i32const(e.region.entry).store('i32', { offset: at });
            atState(e.context, b).i32const(e.entryTop).store('i32', { offset: at + 4 });
            atState(e.context, b).localGet(Local.x87Empty).store('i32', { offset: at + 8 });
            atState(e.context, b).localGet(Local.x87Top).store('i32', { offset: at + 12 });
        });
        if (overflowChecked)
        {
            b.localGet(Local.x87Empty).i32const(into).op(I32.and).op(I32.eqz);
            e.openGuard('overflow', EMPTY);
            setStatus(Status.C1);
            e.close();
        }
        e.close();
    };
    /**
     * Rounds the f64 on the stack to a float when precision control says
     * single (PC = 00): the processor's 24-bit results, as a program that
     * set them expects. Extended is treated as double. Only the arithmetic
     * and the square root are subject to it, as on the processor.
     */
    const byPrecision = ()=>{
        if (e.wide)
        {
            // Checked at the block's first rounding instruction (`emitX87`).
            return;
        }
        if (e.narrow)
        {
            // Likewise, the other way round.
            roundSingle(e);
            return;
        }
        // Only under single precision: a branch the common control words
        // never take, where computing both and selecting paid the rounding on
        // every operation.
        b.localSet(x.temp3);
        b.localGet(Local.x87Control).i32const(0x300).op(I32.and).op(I32.eqz);
        // Not `single`, the wide regions' way out: under Direct3D this one is taken.
        e.openIf('narrow', EMPTY);
        b.localGet(x.temp3);
        roundSingle(e);
        b.localSet(x.temp3);
        e.close();
        b.localGet(x.temp3);
    };
    /** Replaces the f64 on the stack by the indefinite when the guard fired. */
    const orIndefinite = ()=>{
        if (clear)
        {
            return;
        }
        // select keeps the first value when the condition holds: the result
        // when the guard did not fire.
        indefinite();
        b.localGet(Local.t1).op(I32.eqz);
        b.select();
    };

    /**
     * Two NaN operands' result into `x.temp3`, chosen as the x87 chooses it --
     * a quiet one over a signalling one, then the larger significand, then the
     * positive, quieted (the model's `twoNaN`) -- where the host's operation
     * keeps whichever its operand order put first.
     *
     * @param {number} a @param {number} c  the locals holding the operands
     */
    const twoNaN = (a, c)=>{
        const bitsOf = (/** @type {number} */ local)=>b.localGet(local).op(I64.reinterpretF64);
        const quietOf = (/** @type {number} */ local)=>bitsOf(local)
            .i64const(0x0008000000000000n).op(I64.and).i64const(0n).op(I64.ne);
        const fractionOf = (/** @type {number} */ local)=>bitsOf(local)
            .i64const(0x000fffffffffffffn).op(I64.and);
        b.localGet(a).localGet(a).op(F64.ne);
        b.localGet(c).localGet(c).op(F64.ne);
        b.op(I32.and);
        e.openGuard('twoNaN', EMPTY);
        bitsOf(a);
        bitsOf(c);
        quietOf(a);
        fractionOf(a);
        fractionOf(c);
        b.op(I64.gtU);
        bitsOf(a).i64const(0n).op(I64.ltS).op(I32.eqz);
        fractionOf(a);
        fractionOf(c);
        b.op(I64.ne);
        b.select();
        quietOf(a);
        quietOf(c);
        b.op(I32.ne);
        b.select();
        b.select();
        b.i64const(0x0008000000000000n).op(I64.or).op(F64.reinterpretI64).localSet(x.temp3);
        e.close();
    };

    /**
     * The result on the stack, a NaN the operation itself made given the
     * processor's sign: x86 hands out the negative indefinite, a host whose
     * default NaN is positive hands out the other, and the corpus tells
     * them apart through a store. A NaN that came in as an operand is
     * propagated as it was; under `precise`, of two the x87's choice
     * (`twoNaN`).
     *
     * With `invalid`, the same NaN out of operands that were not raises IE
     * too: the arithmetic's invalid operation, found by the one compare.
     *
     * With `memory`, that operand was loaded unchecked (`loadFloat`'s
     * `unchecked`): a NaN in it makes the result a NaN, so the one compare
     * here is also the load's, and the rare branch reads its bits again for
     * the IE a signalling one raises. The host quiets it in the arithmetic
     * as the processor does.
     *
     * Unless `precise`, only the sign: no IE (see the file's header).
     *
     * @param {number[]} inputs  the locals holding the operands
     * @param {boolean} [invalid]
     * @param {Operand | null} [memory]
     */
    const hostNaN = (inputs, invalid = false, memory = null)=>{
        const fix = !e.context.features.defaultNaNNegative;
        if (!precise)
        {
            invalid = false;
            memory = null;
        }
        const choose = precise && inputs.length > 1;
        if (!fix && !invalid && memory === null && !choose && nanAt < 0)
        {
            return;
        }
        // Only when the result is a NaN at all: the common path is one compare.
        b.localSet(x.temp3);
        b.localGet(x.temp3).localGet(x.temp3).op(F64.ne);
        e.openGuard('nan', EMPTY);
        noteFirst(NanRecord.RESULT);
        if (choose)
        {
            twoNaN(inputs[0], inputs[1]);
        }
        if (!fix && invalid)
        {
            // The rare branch as one call, so the hot path around it stays
            // the compare: its body inline cost half again what the compare did.
            noteAsker();
            b.localGet(inputs[0]);
            if (inputs.length > 1)
            {
                b.localGet(inputs[1]);
            }
            else
            {
                b.f64const(0);
            }
            if (memory === null)
            {
                b.i32const(0).i32const(0);
            }
            else
            {
                b.localGet(Local.addr).i32const(memory.size);
            }
            b.call(/** @type {number} */ (e.context.x87Invalid));
            b.localGet(Local.x87Status).op(I32.or).localSet(Local.x87Status);
            e.close();
            b.localGet(x.temp3);
            return;
        }
        if (memory !== null)
        {
            rawSignalling(e, memory);
            e.openGuard('signalling', EMPTY);
            setStatus(Status.IE);
            e.close();
        }
        b.i32const(1);
        for (const input of inputs)
        {
            b.localGet(input).localGet(input).op(F64.eq).op(I32.and);
        }
        e.openGuard('made', EMPTY);
        if (fix)
        {
            b.localGet(x.temp3).f64const(-1).op(F64.copysign).localSet(x.temp3);
        }
        if (invalid)
        {
            setStatus(Status.IE);
            noteMade(inputs[0], inputs.length > 1 ? inputs[1] : null);
        }
        e.close();
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
            x.checkedPrecision = -1;
            return finish();
        case 'fld':
            guard();
            if (viaFloats && clear)
            {
                const into = localOf(-1);
                if (src.kind === 'x87')
                {
                    const from = localOf(Number(src.reg));
                    b.localGet(x.single[from]).localSet(singleOf(e, into));
                    copyExact(from, into);
                    pushFloat(numericAt(from));
                }
                else
                {
                    // The float the double would be promoted from; a NaN keeps its bits
                    // here and is quieted where it leaves through the double.
                    prepare(e, src);
                    b.localGet(Local.addr).load('f32', { offset: e.layout.ramBase })
                        .localSet(singleOf(e, into));
                    pushFloat(false);
                }
                return finish();
            }
            if (viaFloats)
            {
                writeFloats();
            }
            if (src.kind === 'x87')
            {
                b.localGet(st(/** @type {number} */ (src.reg)));
                copyExact(localOf(Number(src.reg)), localOf(-1));
            }
            else
            {
                loadFloat(e, src, 'quick');
            }
            orIndefinite();
            push();
            return finish();
        case 'fild':
            guard();
            prepare(e, src);
            b.localGet(Local.addr);
            b.load(src.size === 2 ? 'i64_16s' : src.size === 4 ? 'i64_32s' : 'i64',
                { offset: e.layout.ramBase });
            if (src.size === 8 && x.tracksExact)
            {
                // The quadword beside the double it rounds to, for a quadword
                // store of it to copy the eight bytes the processor's 64-bit
                // mantissa keeps.
                b.localTee(shadowOf(localOf(-1)));
                madeExact = 1 << localOf(-1);
                madeNaN = clear ? 0 : madeExact;
            }
            b.op(F64.convertI64S);
            orIndefinite();
            push();
            return finish();
        case 'fld1': case 'fldz': case 'fldpi': case 'fldl2e': case 'fldln2': case 'fldlg2':
        case 'fldl2t':
            guard();
            if (viaFloats && clear)
            {
                b.f32const(op === 'fld1' ? 1 : 0).localSet(singleOf(e, localOf(-1)));
                pushFloat(true);
                return finish();
            }
            if (viaFloats)
            {
                writeFloats();
            }
            b.f64const({
                fld1: 1, fldz: 0, fldpi: Math.PI, fldl2e: Math.LOG2E, fldln2: Math.LN2,
                fldlg2: Math.log10(2), fldl2t: Math.log2(10),
            }[op] ?? 0);
            orIndefinite();
            push();
            return finish();
        case 'fst': case 'fstp':
            guard();
            if (viaFloats && clear)
            {
                const from = localOf(0);
                if (dst.kind === 'x87')
                {
                    const i = /** @type {number} */ (dst.reg);
                    const to = localOf(i);
                    b.localGet(x.single[from]).localSet(singleOf(e, to));
                    dirty(i);
                    mark((state.top + i) & 7, true);
                    copyExact(from, to);
                    setFloat(to, numericAt(from));
                }
                else
                {
                    prepare(e, dst);
                    noteStore(e, 4);
                    b.localGet(Local.addr).localGet(x.single[from])
                        .store('f32', { offset: e.layout.ramBase });
                }
                if (op === 'fstp')
                {
                    popN(1);
                }
                return finish();
            }
            if (viaFloats)
            {
                writeFloats();
            }
            if (dst.kind === 'x87')
            {
                const i = /** @type {number} */ (dst.reg);
                b.localGet(st(0));
                orIndefinite();
                b.localSet(st(i));
                dirty(i);
                // The destination is held from here on, whatever it was.
                mark((state.top + i) & 7, true);
                copyExact(localOf(0), localOf(i));
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
            guard();
            if (dst.size === 8 && (x.exact & 1 << localOf(0)) !== 0)
            {
                // A quadword `fild` loaded ST0 and nothing has written it: the
                // quadword itself, which needs no rounding and is in range.
                // Where ST0 may be the indefinite -- the guard's fault, or one
                // that came with the value -- that is stored instead, as the
                // rounding path does.
                const checkNaN = (x.exactNaN & 1 << localOf(0)) !== 0;
                const exact = ()=>{
                    if (!clear)
                    {
                        b.localGet(Local.t1).op(I32.eqz);
                    }
                    if (checkNaN)
                    {
                        b.localGet(st(0)).localGet(st(0)).op(F64.eq);
                        if (!clear)
                        {
                            b.op(I32.and);
                        }
                    }
                };
                prepare(e, dst);
                noteStore(e, 8);
                b.localGet(Local.addr).localGet(x.shadow[localOf(0)]);
                if (!clear || checkNaN)
                {
                    b.i64const(-0x8000000000000000n);
                    exact();
                    b.select();
                }
                b.store('i64', { offset: e.layout.ramBase });
                if (!clear || checkNaN)
                {
                    exact();
                    b.op(I32.eqz);
                    e.openGuard('indefinite', EMPTY);
                    setStatus(Status.IE);
                    e.close();
                }
            }
            else if (dst.size === 8 && x.dyn >= 0)
            {
                // Exact at run time: the mark the run left, a value that is the
                // quadword's double (an indefinite is not), and no stack fault.
                b.localGet(x.dyn).i32const(1 << localOf(0)).op(I32.and).i32const(0).op(I32.ne)
                    .localGet(st(0)).localGet(x.shadow[localOf(0)]).op(F64.convertI64S)
                    .op(F64.eq).op(I32.and);
                if (!clear)
                {
                    b.localGet(Local.t1).op(I32.eqz).op(I32.and);
                }
                e.openIf('exactRun', EMPTY);
                prepare(e, dst);
                noteStore(e, 8);
                b.localGet(Local.addr).localGet(x.shadow[localOf(0)])
                    .store('i64', { offset: e.layout.ramBase });
                b.else();
                b.localGet(st(0));
                orIndefinite();
                b.localSet(x.temp2);
                storeInt(e, dst, x.temp2, op === 'fisttp');
                e.close();
            }
            else
            {
                b.localGet(st(0));
                orIndefinite();
                b.localSet(x.temp2);
                storeInt(e, dst, x.temp2, op === 'fisttp');
            }
            if (op !== 'fist')
            {
                popN(1);
            }
            return finish();
        case 'fbstp':
        {
            guard();
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
            e.openGuard('invalid', EMPTY);
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
            // An empty register faults and becomes the indefinite before the
            // exchange; both are held after it, as the processor answers.
            guard();
            if (!clear)
            {
                b.localGet(Local.t1);
                e.openIf('fault', EMPTY);
                for (const [position, k] of [[0, a], [i, c]])
                {
                    b.localGet(Local.x87Empty).i32const(1 << k).op(I32.and);
                    e.openIf('emptied', EMPTY);
                    indefinite();
                    b.localSet(st(position));
                    // Its MMX view too, as a write leaves it.
                    syncMm(k, st(position));
                    e.close();
                }
                e.close();
                mark(a, true);
                mark(c, true);
            }
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
        case 'fchs': case 'fabs':
            guard();
            if (viaFloats && clear)
            {
                const k = localOf(0);
                b.localGet(x.single[k]).op(op === 'fchs' ? F32.neg : F32.abs)
                    .localSet(x.single[k]);
                setFloat(k, numericAt(k));
                dirty(0);
                return finish();
            }
            if (viaFloats)
            {
                writeFloats();
            }
            if (op === 'fabs')
            {
                b.localGet(st(0)).op(F64.abs);
                orIndefinite();
                b.localSet(st(0));
                dirty(0);
                return finish();
            }
            b.localGet(st(0)).op(F64.neg);
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        case 'fsqrt':
            guard();
            if (viaFloats && clear)
            {
                // A float's square root is the 24-bit one; a negative's is a NaN, left.
                const k = localOf(0);
                const result = floatTemp(0);
                b.localGet(x.single[k]).op(F32.sqrt).localTee(result);
                finite();
                unlessFloat();
                b.localGet(result).localSet(x.single[k]);
                setFloat(k, true);
                dirty(0);
                return finish();
            }
            if (viaFloats)
            {
                writeFloats();
            }
            if (precise)
            {
                // A negative other than -0 is invalid: IE, and the result is a NaN.
                b.localGet(st(0)).f64const(0).op(F64.lt);
                e.openGuard('negative', EMPTY);
                setStatus(Status.IE);
                noteMade(st(0), null);
                e.close();
            }
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
            x.checkedPrecision = -1;
            return finish();
        case 'frndint':
            guard();
            roundLocal(e, st(0));
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            return finish();
        case 'fscale':
        {
            // ST0 * 2^trunc(ST1), the power applied in two clamped steps so an
            // exponent past a double's range still lands where it should.
            guard();
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
            // finite value, from the double's fields, a denormal scaled up
            // first; zero gives -inf and ZE and is its own significand; an
            // infinity is its own significand with an exponent of +inf, and a
            // NaN both. The test is of the value, before the fields replace it.
            guard();
            b.localGet(st(0)).localSet(x.temp);
            b.localGet(x.temp).op(F64.abs).f64const(Infinity).op(F64.lt);
            e.openIf('finite', EMPTY);
            b.localGet(x.temp).f64const(0).op(F64.eq);
            e.openIf('zero', EMPTY);
            if (clear)
            {
                setStatus(Status.ZE);
            }
            else
            {
                // A stack fault is the invalid operation alone.
                b.localGet(Local.x87Status).i32const(0).i32const(Status.ZE).localGet(Local.t1)
                    .select().op(I32.or).localSet(Local.x87Status);
            }
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
            b.else();
            // The exponent: +inf of an infinity, the NaN itself of a NaN.
            b.localGet(x.temp).f64const(Infinity).localGet(x.temp).localGet(x.temp).op(F64.ne)
                .select().localSet(x.temp2);
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
            guard();
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
            e.openGuard('invalid', EMPTY);
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
            if (op === 'fsincos' || op === 'fptan')
            {
                // Nothing pushed, where the tracker's state after it has the
                // push: the region leaves past the instruction with the stack
                // as it was, and the host enters the next at its top.
                e.exitAt(instruction.eip + instruction.length, Exit.UNTRANSLATED);
            }
            e.close();
            e.close();
            return finish();
        }
        case 'fpatan':
        {
            // ST1 = atan2(ST1, ST0), then a pop.
            guard();
            b.localGet(st(1)).localGet(st(0)).call(e.context.math.atan2);
            orIndefinite();
            b.localSet(st(1));
            dirty(1);
            popN(1);
            return finish();
        }
        case 'f2xm1':
            guard();
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
            guard();
            b.localGet(st(0)).localSet(x.temp);
            if (op === 'fyl2x')
            {
                if (precise)
                {
                    b.localGet(x.temp).f64const(0).op(F64.eq);
                    b.localGet(st(1)).op(F64.abs).f64const(Infinity).op(F64.lt).op(I32.and);
                    b.localGet(st(1)).f64const(0).op(F64.ne).op(I32.and);
                    e.openIf('zero', EMPTY);
                    setStatus(Status.ZE);
                    e.close();
                    b.localGet(x.temp).f64const(0).op(F64.lt);
                    e.openGuard('negative', EMPTY);
                    setStatus(Status.IE);
                    e.close();
                }
                // A negative argument's logarithm is the invalid operation's
                // indefinite, not the host's NaN.
                b.localGet(x.temp).call(math.log2).localSet(x.temp2);
                indefinite();
                b.localGet(x.temp2).localGet(x.temp).f64const(0).op(F64.lt).select()
                    .localSet(x.temp2);
                b.localGet(st(1)).localGet(x.temp2).op(F64.mul);
                noteIfMade(st(1), x.temp);
                hostNaN([st(1), x.temp2]);
            }
            else
            {
                if (precise)
                {
                    b.localGet(x.temp).f64const(-1).op(F64.lt);
                    e.openGuard('negative', EMPTY);
                    setStatus(Status.IE);
                    e.close();
                }
                b.localGet(x.temp).call(math.log1p).f64const(Math.LN2).op(F64.div)
                    .localSet(x.temp2);
                indefinite();
                b.localGet(x.temp2).localGet(x.temp).f64const(-1).op(F64.lt).select()
                    .localSet(x.temp2);
                b.localGet(st(1)).localGet(x.temp2).op(F64.mul);
                noteIfMade(st(1), x.temp);
                hostNaN([st(1), x.temp2]);
            }
            orIndefinite();
            b.localSet(st(1));
            dirty(1);
            popN(1);
            return finish();
        }
        case 'fprem': case 'fprem1':
        {
            // The partial remainder: ST0 - Q * ST1 with Q the quotient
            // rounded toward zero (fprem) or to nearest (fprem1), exact, and
            // C0, C3 and C1 its bits 2, 1 and 0; past an exponent difference of
            // 63 a partial reduction and C2. The shared helper's, the model's
            // `remainder` (`ir-x87.js`) in integers: a quotient in doubles rounds.
            const nearest = op === 'fprem1' ? 1 : 0;
            guard();
            b.localGet(st(0)).localSet(x.temp);
            b.localGet(st(1)).localSet(x.temp2);
            // Invalid: a NaN, an infinite dividend, a zero divisor: the
            // indefinite, IE, and the condition bits left as they were.
            b.localGet(x.temp).localGet(x.temp).op(F64.ne);
            b.localGet(x.temp2).localGet(x.temp2).op(F64.ne).op(I32.or);
            b.localGet(x.temp).op(F64.abs).f64const(Infinity).op(F64.eq).op(I32.or);
            b.localGet(x.temp2).f64const(0).op(F64.eq).op(I32.or);
            b.localGet(Local.t1).op(I32.or);
            e.openGuard('invalid', EMPTY);
            setStatus(Status.IE);
            noteMade(x.temp, x.temp2);
            indefinite();
            b.localSet(st(0));
            b.else();
            b.localGet(x.temp).localGet(x.temp2).i32const(nearest).call(e.context.remainder)
                .localSet(Local.t0).localSet(st(0));
            b.localGet(Local.x87Status).i32const(~(Status.C2 | Status.C0 | Status.C3 | Status.C1))
                .op(I32.and).localGet(Local.t0).op(I32.or).localSet(Local.x87Status);
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
            guard();
            if (viaFloats && clear)
            {
                // Two floats: the f32 operation is the processor's 24-bit result
                // wherever that is a normal float, and an exact sum's below it. A
                // result past a float's range, a product's or a quotient's below its
                // smallest normal (a zero one included, unless an operand is zero),
                // and a NaN leave for the host instead.
                const into = localOf(target);
                const [mine, theirs, result] = [floatTemp(0), floatTemp(1), floatTemp(2)];
                b.localGet(x.single[into]).localSet(mine);
                if (src.kind === 'x87')
                {
                    b.localGet(x.single[localOf(Number(src.reg))]);
                }
                else
                {
                    prepare(e, src);
                    b.localGet(Local.addr).load('f32', { offset: e.layout.ramBase });
                }
                b.localSet(theirs);
                const [a, c] = reversed ? [theirs, mine] : [mine, theirs];
                b.localGet(a).localGet(c).op(/** @type {number} */ ({
                    fadd: F32.add, fsub: F32.sub, fmul: F32.mul, fdiv: F32.div,
                }[kind])).localTee(result);
                if (kind === 'fmul' || kind === 'fdiv')
                {
                    // Above the smallest normal and at most the largest, by the magnitude's
                    // bits: one unsigned compare on the way that goes on. The smallest
                    // normal itself is out, as a value the processor rounds to just below
                    // it, in its wider exponent, comes out of f32 as it. A zero from a
                    // zero operand is the processor's too.
                    b.op(F32.bits).i32const(0x7fffffff).op(I32.and)
                        .i32const(0x00800001).op(I32.sub).i32const(0x7effffff).op(I32.ltU);
                    b.op(I32.eqz);
                    e.openGuard('subnormal', EMPTY);
                    b.localGet(result).f32const(0).op(F32.eq);
                    b.localGet(a).f32const(0).op(F32.eq);
                    b.localGet(c).f32const(0).op(F32.eq).op(I32.or).op(I32.and);
                    unlessFloat();
                    e.close();
                }
                else
                {
                    finite();
                    unlessFloat();
                }
                b.localGet(result).localSet(x.single[into]);
                setFloat(into, true);
                dirty(target);
                if (op.endsWith('p'))
                {
                    popN(1);
                }
                return finish();
            }
            if (viaFloats)
            {
                writeFloats();
            }
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
                loadFloat(e, src, 'unchecked');
            }
            b.localSet(x.temp2);
            const [a, c] = reversed ? [x.temp2, x.temp] : [x.temp, x.temp2];
            b.localGet(a).localGet(c).op(/** @type {number} */ ({
                fadd: F64.add, fsub: F64.sub, fmul: F64.mul, fdiv: F64.div,
            }[kind]));
            byPrecision();
            // An invalid NaN out of inputs that were not NaN raises IE; a stack
            // fault has raised it already, so the check needs no guard of its own.
            hostNaN([x.temp, x.temp2], true,
                src.kind === 'mem' && !op.startsWith('fi') && src.size !== 10 ? src : null);
            orIndefinite();
            b.localSet(st(target));
            if (kind === 'fdiv' && precise)
            {
                // A zero-divide of a finite nonzero, by a sound operation.
                b.localGet(c).f64const(0).op(F64.eq);
                b.localGet(a).f64const(0).op(F64.ne);
                b.localGet(a).op(F64.abs).f64const(Infinity).op(F64.lt);
                b.op(I32.and).op(I32.and);
                if (!clear)
                {
                    b.localGet(Local.t1).op(I32.eqz).op(I32.and);
                }
                e.openIf('zero', EMPTY);
                setStatus(Status.ZE);
                e.close();
            }
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
                guard();
                prepare(e, src);
                b.localGet(Local.addr);
                b.load(src.size === 2 ? 'i32_16s' : 'i32', { offset: e.layout.ramBase });
                b.op(F64.convertI32S).localSet(x.temp2);
            }
            else if (op === 'ftst')
            {
                guard();
                b.f64const(0).localSet(x.temp2);
            }
            else if (op === 'fcompp' || op === 'fucompp')
            {
                guard();
                b.localGet(st(1)).localSet(x.temp2);
            }
            else if (src.kind === 'x87')
            {
                guard();
                b.localGet(st(/** @type {number} */ (src.reg))).localSet(x.temp2);
            }
            else
            {
                guard();
                // An ordered compare raises IE on any NaN, a signalling one
                // included; the unordered one needs the load's own test.
                loadFloat(e, src, op.startsWith('fu') ? 'checked' : 'unchecked');
                b.localSet(x.temp2);
            }
            conditionBits(e, st(0), x.temp2, !op.startsWith('fu'));
            popN(op.endsWith('pp') ? 2 : op.endsWith('p') ? 1 : 0);
            return finish();
        }
        case 'fcomi': case 'fcomip': case 'fucomi': case 'fucomip':
        {
            guard();
            b.localGet(st(/** @type {number} */ (src.reg))).localSet(x.temp2);
            const a = st(0);
            const c = x.temp2;
            // Unordered (a NaN, or an empty register): ZF = PF = CF = 1; and
            // invalid for fcomi, or an SNaN.
            b.localGet(a).localGet(a).op(F64.ne).localGet(c).localGet(c).op(F64.ne).op(I32.or);
            b.localGet(Local.t1).op(I32.or);
            b.localSet(Local.t1);
            // Only the branch after it reading the flags: the branch compares.
            // The operands are kept aside, since what stands between (a pop
            // into ST(1)) may write the registers they are in.
            if (flagsLive && clear && e.fusesCompare(
                e.region.blocks[e.blockIndex].instructions.indexOf(instruction), keepsCompare))
            {
                b.localGet(a).localSet(x.base + 11);
                b.localGet(c).localSet(x.base + 12);
                e.fcmp = { a: x.base + 11, c: x.base + 12, double: true };
            }
            else if (flagsLive)
            {
                e.eagerWrite(CF | PF | AF | ZF | SF | OF);
                b.localGet(Local.t1);
                e.orFlag(PF);
                b.localGet(Local.t1).localGet(a).localGet(c).op(F64.eq).op(I32.or);
                e.orFlag(ZF);
                b.localGet(Local.t1).localGet(a).localGet(c).op(F64.lt).op(I32.or);
                e.orFlag(CF);
            }
            if (precise)
            {
                b.localGet(Local.t1);
                if (op.startsWith('fu'))
                {
                    signalling(e, a, c);
                    b.op(I32.and);
                }
                e.openGuard('invalid', EMPTY);
                setStatus(Status.IE);
                e.close();
                b.localGet(Local.x87Status).i32const(~Status.C1).op(I32.and)
                    .localSet(Local.x87Status);
            }
            popN(op.endsWith('p') ? 1 : 0);
            return finish();
        }
        case 'fcmovb': case 'fcmove': case 'fcmovbe': case 'fcmovu':
        case 'fcmovnb': case 'fcmovne': case 'fcmovnbe': case 'fcmovnu':
            guard();
            b.localGet(st(/** @type {number} */ (src.reg)));
            b.localGet(st(0));
            e.pushCondition(/** @type {number} */ (instruction.cc));
            b.select();
            orIndefinite();
            b.localSet(st(0));
            dirty(0);
            if (!clear)
            {
                // A stack fault leaves the indefinite in ST0, held.
                mark(state.top, true);
            }
            return finish();
        case 'fxam':
        {
            // C3 C2 C0: empty 101, NaN 001, infinity 011, zero 100, normal 010; C1 the sign.
            const v = st(0);
            // It reads the empty mask: the block's stale bits written first.
            x87Flush(e, true);
            b.localGet(Local.x87Status).i32const(~Status.CONDITION).op(I32.and)
                .localSet(Local.x87Status);
            b.localGet(Local.x87Empty).i32const(1 << state.top).op(I32.and);
            e.openIf('empty', EMPTY);
            // An empty register's sign is not asked: C1 stays clear.
            setStatus(Status.C3 | Status.C0);
            b.else();
            b.localGet(v).op(I64.reinterpretF64).i64const(0n).op(I64.ltS);
            e.openGuard('negative', EMPTY);
            setStatus(Status.C1);
            e.close();
            b.localGet(v).localGet(v).op(F64.ne);
            e.openGuard('nan', EMPTY);
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
            if (!precise && readsRelaxed(e, instruction))
            {
                x.relaxedReads++;
            }
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
            // After fnstenv the processor masks every exception; the control
            // word stays as it was here, since an exception behaves as masked
            // whatever the masks say (see the head of the file).
            const save = op === 'fnsave';
            if (!precise)
            {
                x.relaxedReads++;
            }
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
                x.checkedPrecision = -1;
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
            x.checkedPrecision = -1;
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
 * A float compare's operands, in locals, for the branch that reads its flags
 * (`fusesCompare` in `region.js`): f64 locals for the x87's, f32 or f64 for SSE's.
 *
 * @typedef {{ a: number, c: number, double: boolean }} FloatCompare
 */

/**
 * What may stand between a fused `fcomi` and its branch: an x87 move between
 * registers, which reads and writes no flag, touches no memory, rounds nothing
 * and cannot leave the region.
 *
 * @param {Instruction} instruction
 */
function keepsCompare(instruction){
    return (instruction.op === 'fstp' || instruction.op === 'fst' || instruction.op === 'fxch'
        || instruction.op === 'fld' || instruction.op === 'ffreep' || instruction.op === 'fnop')
        && instruction.operands.every(operand=>operand.kind === 'x87');
}

/**
 * Pushes 0/1 for a condition code read from a float compare's operands, as
 * `fcomi` and `comiss` set the flags: CF less or unordered, ZF equal or
 * unordered, PF unordered, OF SF AF clear.
 *
 * @param {Body} b @param {FloatCompare} compare @param {number} cc
 */
export function floatCondition(b, { a, c, double }, cc){
    // f64 or f32: ne, lt, gt, ge
    const [ne, lt, gt, ge] = double ? [F64.ne, F64.lt, F64.gt, F64.ge] : [0x5c, 0x5d, 0x5e, 0x60];
    const equalOrUnordered = ()=>{
        b.localGet(a).localGet(c).op(lt).localGet(a).localGet(c).op(gt).op(I32.or).op(I32.eqz);
    };
    switch (cc >> 1)
    {
        case 1: // b: CF
            b.localGet(a).localGet(c).op(ge).op(I32.eqz);
            break;
        case 2: // e: ZF
        case 7: // le: ZF, SF and OF being equal
            equalOrUnordered();
            break;
        case 3: // be: CF or ZF
            b.localGet(a).localGet(c).op(gt).op(I32.eqz);
            break;
        case 5: // p: PF
            b.localGet(a).localGet(a).op(ne).localGet(c).localGet(c).op(ne).op(I32.or);
            break;
        default: // o, s, l: OF, SF, SF != OF
            b.i32const(0);
    }
    if ((cc & 1) === 1)
    {
        b.op(I32.eqz);
    }
}

/** The status word's bits a module that is not `precise` does not keep: the
 * exception flags, the stack fault and summary bits of the low byte, and C1. */
const RELAXED_STATUS = 0x02ff;

/**
 * Whether an `fnstsw` lets the program see the bits a module that is not
 * `precise` does not keep: into memory, or into AX with anything after it but
 * `sahf` (C0, C2 and C3 into the flags) or a `test`/`and` of AH or AX with a
 * mask that leaves those bits out -- the compare idioms compilers emit. Found
 * at translation, for the diagnostics; the code is the same either way.
 *
 * @param {E} e @param {Instruction} instruction
 */
function readsRelaxed(e, instruction){
    if (instruction.operands[0].kind !== 'reg')
    {
        return true;
    }
    const block = e.region.blocks[e.blockIndex];
    const next = block?.instructions[block.instructions.indexOf(instruction) + 1];
    if (next === undefined)
    {
        return true;
    }
    if (next.op === 'sahf')
    {
        return false;
    }
    const [target, mask] = next.operands;
    if ((next.op === 'test' || next.op === 'and') && target?.kind === 'reg'
        && target.reg === 0 && mask?.kind === 'imm')
    {
        const bits = /** @type {number} */ (mask.value) << (target.size === 1 && target.high ? 8 : 0);
        return (bits & RELAXED_STATUS) !== 0;
    }
    return true;
}

/**
 * Pushes 1 when the float at `Local.addr` (m32 or m64) is a signalling NaN,
 * from its bits: all-ones exponent, quiet bit clear, fraction not zero.
 *
 * @param {E} e @param {Operand} operand
 */
function rawSignalling(e, operand){
    const { b } = e;
    const offset = e.layout.ramBase;
    if (operand.size === 4)
    {
        b.localGet(Local.addr).load('i32', { offset }).i32const(0x7fc00000).op(I32.and)
            .i32const(0x7f800000).op(I32.eq);
        b.localGet(Local.addr).load('i32', { offset }).i32const(0x3fffff).op(I32.and)
            .i32const(0).op(I32.ne).op(I32.and);
        return;
    }
    b.localGet(Local.addr).load('i64', { offset }).i64const(0x7ff8000000000000n).op(I64.and)
        .i64const(0x7ff0000000000000n).op(I64.eq);
    b.localGet(Local.addr).load('i64', { offset }).i64const(0x0007ffffffffffffn).op(I64.and)
        .i64const(0n).op(I64.ne).op(I32.and);
}

/**
 * Pushes the f64 at a float memory operand: m32, m64 or m80.
 *
 * A signalling NaN read is an invalid operand: IE, and the value goes on
 * quiet. `checked` tests the bits before the value is formed; `quick`
 * (`fld`) loads it as a float and tests only a value that is a NaN at all --
 * one compare on the common path, where the bit test was an integer load, a
 * mask and a compare -- and `unchecked` leaves the test to the caller: an
 * operation whose result is a NaN whenever the operand is (the arithmetic's
 * `hostNaN`) or that raises IE on any NaN (an ordered compare). A module
 * that is not `precise` tests nothing: every load is `unchecked`.
 *
 * @param {E} e @param {Operand} operand
 * @param {'checked' | 'quick' | 'unchecked'} [mode]
 */
function loadFloat(e, operand, mode = 'checked'){
    loadFloatValue(e, operand, mode);
    const at = e.context.precise === true ? e.layout.nanFirst ?? -1 : -1;
    if (at < 0)
    {
        return;
    }
    // A NaN hunt's record of a NaN read from memory, and the address it was read from.
    const { b } = e;
    const value = e.x87.temp3;
    b.localTee(value).localGet(value).op(F64.ne);
    b.if(EMPTY);
    noteEvent(e, NanRecord.LOAD, ()=>{
        atState(e.context, b).localGet(Local.addr)
            .store('i32', { offset: at + NanRecord.LOAD + 8 });
    });
    b.end();
    b.localGet(value);
}

/**
 * `loadFloat` without the NaN hunt's record.
 *
 * @param {E} e @param {Operand} operand @param {'checked' | 'quick' | 'unchecked'} [mode]
 */
function loadFloatValue(e, operand, mode = 'checked'){
    const { b } = e;
    if (e.context.precise !== true)
    {
        mode = 'unchecked';
    }
    prepare(e, operand);
    if (mode === 'unchecked' && operand.size === 10)
    {
        b.localGet(Local.addr).i32const(e.layout.ramBase).op(I32.add)
            .call(/** @type {number} */ (e.context.f80ToF64));
        return;
    }
    if (mode !== 'checked' && operand.size !== 10)
    {
        // f32 -> f64 quiets a signalling NaN keeping its payload, as the
        // processor's own conversion does; an f64 load keeps the bits.
        b.localGet(Local.addr).load(operand.size === 4 ? 'f32' : 'f64',
            { offset: e.layout.ramBase });
        if (operand.size === 4)
        {
            b.op(F64.promoteF32);
        }
        if (mode === 'unchecked')
        {
            return;
        }
        const value = e.x87.temp3;
        b.localTee(value).localGet(value).op(F64.ne);
        e.openGuard('nan', EMPTY);
        rawSignalling(e, operand);
        e.openGuard('signalling', EMPTY);
        b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
        if (operand.size === 8)
        {
            b.localGet(value).op(I64.reinterpretF64).i64const(0x0008000000000000n).op(I64.or)
                .op(F64.reinterpretI64).localSet(value);
        }
        e.close();
        e.close();
        b.localGet(value);
        return;
    }
    // A signalling NaN read from memory is an invalid operand: IE, and the
    // value goes on quiet. The quiet bit is the top fraction bit of each width.
    if (operand.size === 10)
    {
        b.localGet(Local.addr).load('i32_16u', { offset: e.layout.ramBase + 8 })
            .i32const(0x7fff).op(I32.and).i32const(0x7fff).op(I32.eq);
        b.localGet(Local.addr).load('i64', { offset: e.layout.ramBase })
            .i64const(0x7fffffffffffffffn).op(I64.and).i64const(0x4000000000000000n)
            .op(I64.gtS).op(I32.and);
        e.openGuard('signalling', EMPTY);
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
        e.openGuard('signalling', EMPTY);
        b.localGet(Local.t2).i32const(0x3fffff).op(I32.and);
        e.openGuard('nan', EMPTY);
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
    e.openGuard('signalling', EMPTY);
    b.localGet(Local.t64).i64const(0x0007ffffffffffffn).op(I64.and).i64const(0n).op(I64.ne);
    e.openGuard('nan', EMPTY);
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
    const at = e.context.precise === true ? e.layout.nanFirst ?? -1 : -1;
    if (at >= 0)
    {
        // A NaN hunt's record of a NaN stored, and the address it went to.
        const value = e.x87.temp3;
        pushValue();
        b.localTee(value).localGet(value).op(F64.ne);
        b.if(EMPTY);
        noteEvent(e, NanRecord.STORE, ()=>{
            atState(e.context, b).localGet(Local.addr)
                .store('i32', { offset: at + NanRecord.STORE + 8 });
        });
        b.end();
        pushValue = ()=>b.localGet(value);
    }
    if (operand.size === 10)
    {
        pushValue();
        b.localGet(Local.addr).i32const(e.layout.ramBase).op(I32.add);
        b.call(/** @type {number} */ (e.context.f64ToF80));
        return;
    }
    if (operand.size === 4 && e.context.precise === true)
    {
        // A nonzero value below the smallest normal single underflows: UE
        // (masked: the store still happens, denormal or zero).
        pushValue();
        b.localSet(e.x87.temp);
        b.localGet(e.x87.temp).op(F64.abs).f64const(2 ** -126).op(F64.lt);
        b.localGet(e.x87.temp).f64const(0).op(F64.ne).op(I32.and);
        e.openGuard('underflow', EMPTY);
        b.localGet(Local.x87Status).i32const(Status.UE).op(I32.or).localSet(Local.x87Status);
        e.close();
        b.localGet(Local.addr).localGet(e.x87.temp).op(F32.demoteF64)
            .store('f32', { offset: e.layout.ramBase });
        return;
    }
    b.localGet(Local.addr);
    pushValue();
    if (operand.size === 4)
    {
        b.op(F32.demoteF64).store('f32', { offset: e.layout.ramBase });
        return;
    }
    b.store('f64', { offset: e.layout.ramBase });
}

/**
 * Rounds the f64 on the stack to single precision's 24-bit mantissa, to
 * nearest even, keeping the double's exponent range: under PC = 00 the
 * processor keeps its own, so a value past a float's range neither overflows
 * nor goes denormal as a demote to f32 would make it.
 *
 * `precise` rounds in the double's bits, as the interpreter does, infinity
 * and NaN passed through. Otherwise Veltkamp's split: c = x * (2^29 + 1), and
 * x rounded is c - (c - x) -- three dependent operations where the bits were
 * ten and a round trip through the integer registers, the rounding being on
 * the path of every value computed from the result. It gives the same double
 * for every magnitude under 2^995 - 2^966 (ties included, every pattern of the
 * kept bits tested); an infinity, a NaN or anything larger, where c overflows
 * and the difference is a NaN, keeps its value unrounded. A double's own
 * denormal keeps 24 bits of its own, where the bits round at a fixed place.
 *
 * @param {E} e
 */
function roundSingle(e){
    const { b } = e;
    if (e.context.precise === true)
    {
        b.op(I64.reinterpretF64).localSet(Local.t64);
        b.localGet(Local.t64);
        b.localGet(Local.t64).localGet(Local.t64).i64const(29n).op(I64.shrU).i64const(1n)
            .op(I64.and).op(I64.add).i64const(0x0fffffffn).op(I64.add)
            .i64const(-0x20000000n).op(I64.and);
        b.localGet(Local.t64).i64const(0x7ff0000000000000n).op(I64.and)
            .i64const(0x7ff0000000000000n).op(I64.eq);
        b.select().op(F64.reinterpretI64);
        return;
    }
    b.localTee(Local.d0).f64const(2 ** 29 + 1).op(F64.mul).localTee(Local.d1);
    b.localGet(Local.d1).localGet(Local.d0).op(F64.sub).op(F64.sub).localTee(Local.d1);
    b.localGet(Local.d0).localGet(Local.d1).localGet(Local.d1).op(F64.eq).select();
}

/**
 * Pushes a local rounded to an integer by the control word's rounding
 * control, every mode inline: to nearest (even) first -- the control word
 * most conversions run under, `_ftol2`'s `fistp` among them -- then toward
 * zero, which a C cast compiled for the x87 sets with `fldcw` around its
 * `fistp`, then down and up. A call to the module's helper there spilled the
 * registers around every such conversion.
 *
 * @param {E} e @param {number} local
 */
function roundLocal(e, local){
    const { b } = e;
    const rc = ()=>b.localGet(Local.x87Control).i32const(0xc00).op(I32.and);
    rc().op(I32.eqz);
    e.openIf('nearest', ValType.f64);
    b.localGet(local).op(F64.nearest);
    b.else();
    rc().i32const(0xc00).op(I32.eq);
    e.openIf('chop', ValType.f64);
    b.localGet(local).op(F64.trunc);
    b.else();
    rc().i32const(0x400).op(I32.eq);
    e.openIf('down', ValType.f64);
    b.localGet(local).op(F64.floor);
    b.else();
    b.localGet(local).op(F64.ceil);
    e.close();
    e.close();
    e.close();
}

/**
 * Stores the register as an integer of the operand's width, rounded by the
 * control word (or truncated); a NaN or a value out of range stores the
 * integer indefinite and, when `precise`, raises IE.
 *
 * @param {E} e @param {Operand} operand @param {number} local @param {boolean} truncate
 */
function storeInt(e, operand, local, truncate){
    const { b } = e;
    prepare(e, operand);
    noteStore(e, operand.size);
    if (truncate)
    {
        b.localGet(local).op(F64.trunc);
    }
    else
    {
        roundLocal(e, local);
    }
    b.localSet(e.x87.temp);
    const rounded = e.x87.temp;
    const limit = operand.size === 2 ? 32768
        : operand.size === 4 ? 2147483648 : 9223372036854775808;
    const wide = operand.size === 8;
    const inRange = ()=>{
        // -limit <= v < limit; a NaN fails both compares.
        b.localGet(rounded).f64const(-limit).op(F64.ge);
        b.localGet(rounded).f64const(limit).op(F64.lt);
        b.op(I32.and);
    };
    if (e.context.precise !== true)
    {
        // No IE: the integer indefinite chosen by a select, with no branch.
        b.localGet(Local.addr).localGet(rounded);
        if (wide)
        {
            b.op(TRUNC_SAT_I64[0], [TRUNC_SAT_I64[1]]).i64const(-0x8000000000000000n);
        }
        else
        {
            b.op(TRUNC_SAT_I32[0], [TRUNC_SAT_I32[1]])
                .i32const(operand.size === 2 ? 0x8000 : -0x80000000);
        }
        inRange();
        b.select();
        b.store(wide ? 'i64' : operand.size === 2 ? 'i32_16' : 'i32',
            { offset: e.layout.ramBase });
        return;
    }
    inRange();
    b.op(I32.eqz);
    e.openGuard('indefinite', EMPTY);
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
 * a signalling NaN for the unordered one, when `precise`.
 *
 * @param {E} e @param {number} a @param {number} c @param {boolean} ordered
 */
function conditionBits(e, a, c, ordered){
    const { b } = e;
    b.localGet(Local.x87Status).i32const(~Status.CONDITION).op(I32.and).localSet(Local.x87Status);
    // Unordered: a NaN, or the guard's empty register already in t1.
    b.localGet(a).localGet(a).op(F64.ne).localGet(c).localGet(c).op(F64.ne).op(I32.or);
    b.localGet(Local.t1).op(I32.or);
    if (e.context.precise !== true)
    {
        // No IE to raise: the three bits with no branch, the unordered case's
        // all three over what the two compares (false for a NaN) give.
        b.i32const(Status.C3 | Status.C2 | Status.C0).op(0x6c); // i32.mul
        b.localGet(a).localGet(c).op(F64.eq).i32const(Status.C3).op(0x6c).op(I32.or);
        b.localGet(a).localGet(c).op(F64.lt).i32const(Status.C0).op(0x6c).op(I32.or);
        b.localGet(Local.x87Status).op(I32.or).localSet(Local.x87Status);
        return;
    }
    b.localSet(Local.t1);
    b.localGet(Local.t1);
    e.openGuard('unordered', EMPTY);
    b.localGet(Local.x87Status).i32const(Status.C3 | Status.C2 | Status.C0).op(I32.or)
        .localSet(Local.x87Status);
    if (ordered)
    {
        b.localGet(Local.x87Status).i32const(Status.IE).op(I32.or).localSet(Local.x87Status);
    }
    else
    {
        signalling(e, a, c);
        e.openGuard('signalling', EMPTY);
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
 * A NaN hunt's record (`layout.nanFirst`), by offset: each event's first
 * instruction and its count, then what an event keeps beside them -- a NaN
 * made: its two operands as f64 and the asking instruction (`addInvalidHelper`);
 * a load or a store: the address in memory; a stack fault: the region, the
 * top it was entered at, and the empty mask and the top it found -- and the
 * order the first events came in.
 */
export const NanRecord = Object.freeze({
    MADE: 0, MADE_A: 8, MADE_C: 16, ASKER: 24, FAULT: 28, RESULT: 36, LOAD: 44, STORE: 56,
    ORDER: 68, FAULT_REGION: 92, SIZE: 108,
    /** By event, where its place in the order is kept. */
    orderOf: /** @type {Record<number, number>} */ ({ 0: 72, 28: 76, 36: 80, 44: 84, 56: 88 }),
});

/**
 * One event of a NaN hunt at the instruction being emitted: its count and,
 * the first time, its address, its place in the order, and what `first`
 * stores beside them.
 *
 * @param {E} e @param {number} slot  the event (`NanRecord`)
 * @param {() => void} [first]
 */
function noteEvent(e, slot, first){
    const { b } = e;
    const at = /** @type {number} */ (e.layout.nanFirst);
    atState(e.context, atState(e.context, b)).load('i32', { offset: at + slot + 4 })
        .i32const(1).op(I32.add)
        .store('i32', { offset: at + slot + 4 });
    atState(e.context, b).load('i32', { offset: at + slot }).op(I32.eqz);
    b.if(EMPTY);
    atState(e.context, b).i32const(/** @type {import('../decode/decoder.js').Instruction} */ (e.current).eip)
        .store('i32', { offset: at + slot });
    atState(e.context, atState(e.context, b)).load('i32', { offset: at + NanRecord.ORDER })
        .i32const(1).op(I32.add)
        .store('i32', { offset: at + NanRecord.ORDER });
    atState(e.context, atState(e.context, b)).load('i32', { offset: at + NanRecord.ORDER })
        .store('i32', { offset: at + NanRecord.orderOf[slot] });
    first?.();
    b.end();
}

/**
 * The invalid-operation helper: `x87Invalid(a, c, address, size) -> IE`, for
 * an arithmetic whose result is a NaN. IE when the NaN was made from operands
 * that were not NaNs, or when the memory operand (`size` 4 or 8 at the wasm
 * address; 0 for none) holds a signalling NaN; 0 otherwise. A NaN made is
 * noted at `layout.nanFirst`, the asking instruction's address read from
 * past the record, where the region stored it.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 */
export function addInvalidHelper(m, layout){
    const type = m.type({
        params: [ValType.f64, ValType.f64, ValType.i32, ValType.i32], results: [ValType.i32],
    });
    const b = new Body();
    const offset = layout.ramBase;
    const at = layout.nanFirst ?? -1;
    b.localGet(0).localGet(0).op(F64.eq).localGet(1).localGet(1).op(F64.eq).op(I32.and);
    b.if(EMPTY);
    if (at >= 0)
    {
        // A NaN hunt's record: how many, and the first one's instruction and operands.
        b.i32const(0).i32const(0).load('i32', { offset: at + NanRecord.MADE + 4 }).i32const(1)
            .op(I32.add).store('i32', { offset: at + NanRecord.MADE + 4 });
        b.i32const(0).load('i32', { offset: at + NanRecord.MADE + 4 }).i32const(1).op(I32.eq);
        b.if(EMPTY);
        b.i32const(0).i32const(0).load('i32', { offset: at + NanRecord.ASKER })
            .store('i32', { offset: at + NanRecord.MADE });
        b.i32const(0).localGet(0).store('f64', { offset: at + NanRecord.MADE_A });
        b.i32const(0).localGet(1).store('f64', { offset: at + NanRecord.MADE_C });
        b.i32const(0).i32const(0).load('i32', { offset: at + NanRecord.ORDER }).i32const(1)
            .op(I32.add).store('i32', { offset: at + NanRecord.ORDER });
        b.i32const(0).i32const(0).load('i32', { offset: at + NanRecord.ORDER })
            .store('i32', { offset: at + NanRecord.orderOf[NanRecord.MADE] });
        b.end();
    }
    b.i32const(Status.IE).op(0x0f); // return
    b.end();
    b.localGet(3).i32const(4).op(I32.eq);
    b.if(EMPTY);
    b.localGet(2).load('i32', { offset }).i32const(0x7fc00000).op(I32.and)
        .i32const(0x7f800000).op(I32.eq);
    b.localGet(2).load('i32', { offset }).i32const(0x3fffff).op(I32.and)
        .i32const(0).op(I32.ne).op(I32.and);
    b.op(0x0f);
    b.end();
    b.localGet(3).i32const(8).op(I32.eq);
    b.if(EMPTY);
    b.localGet(2).load('i64', { offset }).i64const(0x7ff8000000000000n).op(I64.and)
        .i64const(0x7ff0000000000000n).op(I64.eq);
    b.localGet(2).load('i64', { offset }).i64const(0x0007ffffffffffffn).op(I64.and)
        .i64const(0n).op(I64.ne).op(I32.and);
    b.op(0x0f);
    b.end();
    b.i32const(0);
    return m.function(type, [], b.toBytes());
}

/**
 * The partial remainder helper a module carries: `remainder(a, c, nearest) →
 * (value, bits)` is `fprem` (`nearest` 0) or `fprem1` of a finite `a` by a
 * nonzero `c` that is not a NaN, the value exact and `bits` the condition
 * bits it leaves -- C2 for a partial reduction, otherwise the quotient's low
 * three bits in C0, C3 and C1 -- the model's `remainder` (`ir-x87.js`) bit for
 * bit, in integers rather than through two calls into the host.
 *
 * The significands, a subnormal's normalised, are divided the way the
 * processor's long division goes: the dividend's shifted left by the exponent
 * difference d, eleven bits a step so the partial remainder (below the
 * divisor's 2^53) stays below 2^64, the quotient's low bits carried along.
 * Past a difference of 63 the reduction is partial, as `remainder` has it: by
 * the divisor times a power of two that leaves 32 plus d mod 32 of it. The
 * result is the integer remainder times the divisor's unit, a power of two
 * applied in two steps since it may lie below a double's normal range (the
 * remainder is always a double exactly, so neither step rounds).
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @returns {number} the function index
 */
export function addRemainderHelper(m){
    const { f64, i32, i64 } = ValType;
    const type = m.type({ params: [f64, f64, i32], results: [f64, i32] });
    const A = 0; const C = 1; const NEAREST = 2;
    // locals: the significands (the dividend's the partial remainder once
    // divided), the exponents (the divisor's the result's scale once known),
    // the bits left to divide, the quotient's low bits, a step, a partial
    // reduction's flag, a step's quotient
    const MA = 3; const MC = 4; const EA = 5; const EC = 6; const N = 7; const Q = 8;
    const K = 9; const PARTIAL = 10; const STEP = 11;
    const b = new Body();
    // A zero dividend or an infinite divisor: the dividend, and a quotient of 0.
    b.localGet(A).f64const(0).op(F64.eq);
    b.localGet(C).op(F64.abs).f64const(Infinity).op(F64.eq).op(I32.or);
    b.if(EMPTY);
    b.localGet(A).i32const(0).return();
    b.end();
    for (const [value, significand, exponent] of [[A, MA, EA], [C, MC, EC]])
    {
        b.localGet(value).op(I64.reinterpretF64).localTee(significand).i64const(52n)
            .op(I64.shrU).op(I64.wrap).i32const(0x7ff).op(I32.and).localSet(exponent);
        b.localGet(significand).i64const(0xfffffffffffffn).op(I64.and).localSet(significand);
        b.localGet(exponent).op(I32.eqz);
        b.if(EMPTY);
        // A subnormal's leading bit moved to bit 52, its exponent below -1022.
        b.localGet(significand).op(I64.clz).op(I64.wrap).i32const(11).op(I32.sub).localSet(K);
        b.localGet(significand).localGet(K).op(I64.extendU).op(I64.shl).localSet(significand);
        b.i32const(-1022).localGet(K).op(I32.sub).localSet(exponent);
        b.else();
        b.localGet(significand).i64const(1n << 52n).op(I64.or).localSet(significand);
        b.localGet(exponent).i32const(1023).op(I32.sub).localSet(exponent);
        b.end();
    }
    b.localGet(EA).localGet(EC).op(I32.sub).localSet(N);
    b.localGet(N).i32const(0).op(I32.ltS);
    b.if(EMPTY);
    // Below the divisor: the dividend and a quotient of 0 -- but fprem1's
    // quotient of a dividend past half the divisor (a difference of -1) rounds
    // to 1, which leaves the difference of the two, exact within a factor of two.
    b.localGet(NEAREST).localGet(N).i32const(-1).op(I32.eq).op(I32.and);
    b.localGet(A).op(F64.abs).f64const(2).op(F64.mul).localGet(C).op(F64.abs).op(F64.gt)
        .op(I32.and);
    b.if(EMPTY);
    b.localGet(A).localGet(C).op(F64.abs).localGet(A).op(F64.copysign).op(F64.sub)
        .i32const(Status.C1).return();
    b.end();
    b.localGet(A).i32const(0).return();
    b.end();
    b.localGet(N).i32const(64).op(I32.geS).localTee(PARTIAL);
    b.if(EMPTY);
    b.localGet(N).i32const(31).op(I32.and).i32const(32).op(I32.add).localSet(N);
    b.end();
    // The unit of the divisor the reduction is by: 2^(ea - d - 52).
    b.localGet(EA).localGet(N).op(I32.sub).i32const(52).op(I32.sub).localSet(EC);
    b.i32const(0).localSet(Q);
    b.loop(EMPTY);
    // k = min(n, 11); r = r << k; q = q << k + r / c; r = r mod c
    b.localGet(N).i32const(11).localGet(N).i32const(11).op(I32.ltS).select().localSet(K);
    b.localGet(MA).localGet(K).op(I64.extendU).op(I64.shl).localTee(MA).localGet(MC)
        .op(I64.divU).localTee(STEP);
    b.op(I64.wrap).localGet(Q).localGet(K).op(I32.shl).op(I32.add).i32const(7).op(I32.and)
        .localSet(Q);
    b.localGet(MA).localGet(STEP).localGet(MC).op(I64.mul).op(I64.sub).localSet(MA);
    b.localGet(N).localGet(K).op(I32.sub).localTee(N).i32const(0).op(I32.gtS).brIf(0);
    b.end();
    // fprem1: past half the divisor, or at half with an odd quotient, the
    // quotient one more and the remainder the divisor's less it, of the other sign.
    b.localGet(NEAREST).localGet(PARTIAL).op(I32.eqz).op(I32.and);
    b.if(EMPTY);
    b.localGet(MA).i64const(1n).op(I64.shl).localGet(MC).op(I64.gtU);
    b.localGet(MA).i64const(1n).op(I64.shl).localGet(MC).op(I64.eq)
        .localGet(Q).i32const(1).op(I32.and).op(I32.and);
    b.op(I32.or);
    b.if(EMPTY);
    b.localGet(MC).localGet(MA).op(I64.sub).localSet(MA);
    b.localGet(Q).i32const(1).op(I32.add).i32const(7).op(I32.and).localSet(Q);
    b.localGet(A).op(F64.neg).localSet(A);
    b.end();
    b.end();
    // r * 2^e: first by 2^max(e, -1022), which leaves r (at least 1) normal,
    // then by what remains of e, at most 104 below.
    b.localGet(EC).i32const(-1022).localGet(EC).i32const(-1022).op(I32.gtS).select().localSet(K);
    b.localGet(MA).op(F64.convertI64U);
    b.localGet(K).i32const(1023).op(I32.add).op(I64.extendU).i64const(52n).op(I64.shl)
        .op(F64.reinterpretI64).op(F64.mul);
    b.localGet(EC).localGet(K).op(I32.sub).i32const(1023).op(I32.add).op(I64.extendU)
        .i64const(52n).op(I64.shl).op(F64.reinterpretI64).op(F64.mul);
    b.localGet(A).op(F64.copysign);
    b.localGet(PARTIAL);
    b.if(i32);
    b.i32const(Status.C2);
    b.else();
    b.localGet(Q).i32const(4).op(I32.and).i32const(6).op(I32.shl);
    b.localGet(Q).i32const(2).op(I32.and).i32const(13).op(I32.shl).op(I32.or);
    b.localGet(Q).i32const(1).op(I32.and).i32const(9).op(I32.shl).op(I32.or);
    b.end();
    return m.function(type, [i64, i64, i32, i32, i32, i32, i32, i32, i64], b.toBytes());
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
