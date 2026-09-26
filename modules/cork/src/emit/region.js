/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A region becomes one wasm function.
 *
 * The function takes the label of the block to enter, the slice's
 * instruction budget and -- under cork's own layout -- the machine state a
 * transfer carries (`STATE_PARAMS`), and answers how it left. Its shape:
 *
 *     prologue      what the parameters do not carry loaded into locals
 *     block $out
 *       loop $dispatch
 *         block … block   one nested block per basic block, innermost first
 *           br_table label
 *         end  block 0's code: instructions, then its exit
 *         end  block 1's code …
 *       end
 *     end
 *     epilogue      locals written back to the state block; the exit kind returned
 *
 * A jump forward to another block of the region is a branch out of that
 * block's wasm block, whose end its code follows. A jump backward sets the
 * label and branches back to the dispatch loop, charging the instructions
 * retired since the last charge against the budget and leaving with `budget`
 * when it is spent: only a backward jump can close a loop. A block that falls
 * through to the block emitted right after it does nothing at all. Anything
 * the region cannot continue -- a return, an indirect
 * jump, a call, an instruction the emitter does not translate -- writes the
 * next address into the state and leaves with `untranslated`, for the host
 * to run on the other executor or to dispatch to another region.
 *
 * Arithmetic flags are lazy (`flags.js`): an instruction records its
 * operation and operands, a reader in the same block computes the flag it
 * needs from the record, and the record is folded into the flags word only
 * where a whole word is needed. A dead-flag pass per block skips the record
 * for an instruction whose flags nothing reads before the next writer.
 */

import { CF, DF, OF, ARITH_FLAGS } from '../decode/table.js';
import { Body, EMPTY, ValType } from '../wasm/encoder.js';
import {
    ARITH, CARRY_IN_WORD, I32, Kind, eagerFlagsOf, emitCondition, emitFlag, kindOf, widthCode,
} from './flags.js';
import { emitInstruction } from './integer.js';
import {
    addUndoHelper, emitGroupChecks, emitStaleExit, emitStreamWindow, planBlock, planLoop,
    planRegion,
} from './memory.js';
import { importHelpers } from './helpers.js';
import { Tables, blockSlot } from '../runtime/layout.js';
import { ANY_TOP } from '../runtime/entries.js';
import { inlineReturns } from '../region.js';
import {
    floatCondition, isX87, prepareX87, regionHasMmx, sameState, x87BlockEnd, x87BlockStart,
    x87Edge, x87EntryCheck, x87Epilogue, x87LoadRegisters, x87Normalise,
    x87Prologue, x87StoreRegisters,
} from './x87.js';

/**
 * The host functions a module imports for the transcendentals, by name; an
 * instantiation supplies each from `Math` (`mathImports()`).
 */
export const MATH_IMPORTS = Object.freeze([
    'sin', 'cos', 'tan', 'atan2', 'exp2m1', 'log2', 'log1p',
]);

/**
 * Enters a region function from the host: the state a transfer between
 * regions carries in its parameters, read from the state block -- the eight
 * registers, the flag record (zero under a layout with none), the flags word,
 * and a count of nothing retired yet.
 *
 * @param {Function} fn  the region's function
 * @param {number} label @param {number} budget
 * @param {DataView} view  over the memory the state block is in
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {number} the exit code
 */
export function enterRegion(fn, label, budget, view, layout){
    // The reads are written out rather than put in helpers: the closures a
    // helper takes were most of the garbage a call into a page left to the
    // interpreter made, entered again once per call.
    const { regs } = layout;
    const record = layout.flagRecord ?? -1;
    return fn(label, budget,
        view.getInt32(regs, true), view.getInt32(regs + 4, true),
        view.getInt32(regs + 8, true), view.getInt32(regs + 12, true),
        view.getInt32(regs + 16, true), view.getInt32(regs + 20, true),
        view.getInt32(regs + 24, true), view.getInt32(regs + 28, true),
        record >= 0 ? view.getInt32(record, true) : 0,
        record >= 0 ? view.getInt32(record + 4, true) : 0,
        record >= 0 ? view.getInt32(record + 8, true) : 0,
        record >= 0 ? view.getInt32(record + 12, true) : 0,
        record >= 0 ? view.getInt32(record + 16, true) : 0,
        view.getInt32(layout.eflags, true), 0);
}

/** The import object entries for `MATH_IMPORTS`. */
export function mathImports(){
    return {
        sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2,
        /** @param {number} x */
        exp2m1: x=>Math.expm1(x * Math.LN2),
        log2: Math.log2, log1p: Math.log1p,
    };
}

/** How a run of translated code came back, as the low byte of the result. */
export const Exit = Object.freeze({
    UNTRANSLATED: 0, BUDGET: 1, TRAP: 2, HALT: 3, FAULT: 4, STALE: 5,
});

/**
 * The bits of a run's MMX mark (`Local.mmxTouched`). The first MMX
 * instruction of a run sets both; an `emms` clears the hold and leaves
 * the top, so the region's exit writes the one and not the other.
 */
export const MMX_HELD = 1;
export const MMX_TOP = 2;

/** Local indices every region function shares. */
export const Local = Object.freeze({
    label: 0, budget: 1,
    // 2..9: eax ecx edx ebx esp ebp esi edi
    reg: 2,
    kind: 10, res: 11, op1: 12, op2: 13, cin: 14, flags: 15,
    retired: 16, eip: 17, t0: 18, t1: 19, t2: 20, addr: 21, t64: 22, t64b: 23,
    count: 24, f0: 25, f1: 26, d0: 27, d1: 28, mmxTouched: 29,
    // the page flags of the current access, and whether a store hit a code page
    pflags: 30, stale: 31,
    // the x87 top, empty mask, status and control words, and the dirty mask
    x87Top: 32, x87Empty: 33, x87Status: 34, x87Control: 35, x87Dirty: 36,
    // 37, 38, 39: three v128 scratch locals when SIMD is available; the xmm
    // and mm locals a region uses follow, then the x87 locals, per region.
    vec: 37,
});
/** The record's locals in the order the layout's `flagRecord` keeps them. */
const RECORD_LOCALS = [Local.kind, Local.res, Local.op1, Local.op2, Local.cin];
/**
 * The function's parameters, locals 0..16: the label and the budget, then the
 * state a transfer between regions carries rather than writing it to the state
 * block and reading it back -- the eight registers, the flag record, the flags
 * word, and the instructions the run has retired so far (the counter word is
 * added to once, when the run leaves for the host). A region over a layout with
 * no flag record (the emulator's) takes them and loads its state as before.
 */
export const STATE_PARAMS = 17;
const LOCAL_TYPES = [
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // eip..addr
    ValType.i64, ValType.i64,
    ValType.i32, // count
    ValType.f32, ValType.f32, ValType.f64, ValType.f64, // f0 f1 d0 d1
    ValType.i32, // mmxTouched
    ValType.i32, ValType.i32, // pflags stale
    ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32, // x87Top..x87Dirty
];

/**
 * What a module carries that every region function in it uses.
 *
 * @typedef {Object} ModuleContext
 * @property {import('../wasm/encoder.js').ModuleBuilder} m
 * @property {number} regionType       the function type (`STATE_PARAMS` × i32) → i32
 * @property {number} materialise      the flag helper's function index
 * @property {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @property {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @property {number} [undo]           the undo helper's function index, in a differential build
 * @property {boolean} [countTransfers] each transfer through the hash adds one to the
 *     tables' transfer count (a diagnostic run)
 * @property {boolean} [blockProfile] each block counts its executions in the block
 *     profile past the tables (a diagnostic run, in a memory sized for it)
 * @property {boolean} [flat]  every backward jump through the dispatch rather than the loops
 *     the region's structure gives
 * @property {boolean} [wide]  compiled for the wide precision controls (double, extended):
 *     no rounding to single, and a block leaves with `PRECISION` if it finds single set
 * @property {boolean} [precise]  every relaxation off (the runtime's `precise`): the x87
 *     exception flags, the signalling-NaN tests, the underflow test and C1 kept as the processor
 *     keeps them, and the flags an instruction leaves undefined keeping the values the emulator
 *     gives them, which costs the record before it; without it the x87 bookkeeping is not
 *     computed and an undefined flag is as the cheapest code leaves it, which no program can
 *     rely on (real processors differ there)
 * @property {number} codeHit         the helper telling whether a byte lies in translated code
 * @property {number} [getEflags]      the host's flag fold, imported when the layout keeps
 *                                     lazy flags (the emulator's `flags_changed`)
 * @property {number} rdtsc            the host's time-stamp counter, imported by every region
 * @property {number} f80ToF64         the extended-precision readers
 * @property {number} f64ToF80
 * @property {number} round            the rounding-control helper
 * @property {number} f64ToBcd         the `fbstp` packed-BCD store
 * @property {number} x87Invalid       an x87 NaN result's IE (`addInvalidHelper`)
 * @property {Record<string, number>} math  the transcendentals imported from the host
 * @property {boolean} hash            an untranslated exit probes the entry hash and
 *                                     tail-calls the region found, through the host's table
 * @property {number} [trapPort]       the port a write to which is the host's call channel
 * @property {Set<string>} leaveOut    instruction classes (x87, mmx, sse) a region exits before
 * @property {number} [trap]           the host's trap import, called from inside a region
 */

/**
 * Prepares a module for region functions: the memory import, the flag
 * helper, the region function type.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {{ shared?: boolean, maxPages?: number }} [memory]
 * @param {{ undoLog?: boolean, hash?: boolean, trapPort?: number, leaveOut?: Set<string>,
 *     countTransfers?: boolean, wide?: boolean, blockProfile?: boolean, structure?: boolean,
 *     precise?: boolean }} [options]  undoLog:
 *     record every store's old bytes (differential builds only; part of the cache key);
 *     hash: import the host's function table and transfer through the entry hash (needs
 *     tail calls); trapPort: `out dx, eax` to it leaves with a trap exit
 * @returns {ModuleContext}
 */
export function prepareModule(m, layout, features, memory = {},
    { undoLog = false, hash = false, trapPort, leaveOut = new Set(), countTransfers = false,
        wide = false, blockProfile = false, structure = false, precise = false } = {})
{
    m.importMemory('env', 'memory', {
        min: 1, ...(memory.maxPages === undefined ? {} : { max: memory.maxPages }),
        shared: memory.shared ?? false,
    });
    const hashed = hash && features.tailCalls;
    if (hashed)
    {
        m.importTable('env', 'table', 0);
    }
    // The host's call channel, when the layout has a port for it: called
    // from inside a region with the state block written back, it answers
    // whether the handler moved EIP.
    const trap = trapPort === undefined
        ? undefined
        : m.importFunction('env', 'trap',
            m.type({ params: [ValType.i32], results: [ValType.i32] }));
    // Imports come before the helpers, which are functions.
    const getEflags = layout.flagsChanged >= 0
        ? m.importFunction('env', 'getEflags', m.type({ params: [], results: [ValType.i32] }))
        : undefined;
    // The time-stamp counter is the host's -- the emulator's own under hybrid,
    // cork's clock under cork -- so `rdtsc` needs no crossing and the two agree.
    const rdtsc = m.importFunction('env', 'rdtsc',
        m.type({ params: [], results: [ValType.i64] }));
    // The transcendentals wasm has no operation for, as the host's Math.
    const unary = m.type({ params: [ValType.f64], results: [ValType.f64] });
    const binary = m.type({ params: [ValType.f64, ValType.f64], results: [ValType.f64] });
    /** @type {Record<string, number>} */
    const math = {};
    for (const name of MATH_IMPORTS)
    {
        math[name] = m.importFunction('env', name, name === 'atan2' ? binary : unary);
    }
    const regionType = m.type({
        params: new Array(STATE_PARAMS).fill(ValType.i32), results: [ValType.i32],
    });
    // The helpers are one shared module every region imports, rather
    // than a copy in each; the host instantiates it once with the same
    // memory (they are defined in `./helpers.js`).
    const { materialise, f80ToF64, f64ToF80, round, codeHit, f64ToBcd, x87Invalid } =
        importHelpers(m);
    /** @type {ModuleContext} */
    const context = {
        m, regionType, materialise, layout, features, f80ToF64, f64ToF80, round, math,
        hash: hashed, codeHit, f64ToBcd, x87Invalid, rdtsc, leaveOut,
    };
    if (trapPort !== undefined)
    {
        context.trapPort = trapPort;
        context.trap = trap;
    }
    if (getEflags !== undefined)
    {
        context.getEflags = getEflags;
    }
    if (undoLog)
    {
        context.undo = addUndoHelper(m, layout);
    }
    // A production bundle emits no diagnostic count, whatever it is asked.
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && countTransfers)
    {
        context.countTransfers = true;
    }
    if (wide)
    {
        context.wide = true;
    }
    if (precise)
    {
        context.precise = true;
    }
    if (!structure)
    {
        context.flat = true;
    }
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && blockProfile)
    {
        context.blockProfile = true;
    }
    return context;
}

/**
 * @typedef {Object} Translation
 * @property {number} functionIndex
 * @property {Map<number, number>} labels     block start eip → label
 * @property {Map<string, number>} unsupported  opcode → instructions the emitter left out
 * @property {Map<string, number>} refusals  `opcode (reason; entry kinds; entry x87)` → count
 * @property {Map<string, number>} relaxedReads  by opcode, the instructions that read a flag an
 *     instruction before them in their block left undefined, outside `precise`: what a program
 *     sees there is the fast default's (`relaxedFlagReads`)
 * @property {number} instructions
 * @property {Set<number>} cut      labels of blocks with no entry of their own: ones that
 *     leave at once (an x87 state conflict, nothing decoded, the first instruction left out)
 *     and ones compiled for the x87 stack in another shape than the entry's
 * @property {number} entryTop      the x87 top the function was compiled for
 * @property {number} loops         blocks emitted as wasm loops onto themselves
 * @property {number} x87Guards     x87 stack-fault checks left to run time
 * @property {number} fusedCompares  branches that compared a float compare's operands
 *     themselves, the flags never made (`fusesCompare`)
 * @property {number} x87RelaxedReads  status-word reads that may see what a module that is
 *     not `precise` does not keep (`readsRelaxed` in `x87.js`)
 * @property {number} folds         calls of the flag helper the function makes
 */

/**
 * Adds a region's function to the module.
 *
 * @param {ModuleContext} context
 * @param {import('../region.js').Region} region
 * @param {{ entryTop?: number, checked?: boolean }} [options]  the x87 top the entry is
 *     compiled for; checked: the entries test nothing of the x87 stack's shape (`planStack`)
 * @returns {Translation}
 */
export function emitRegion(context, region, options = {}){
    const emitter = new RegionEmitter(context, region, options);
    return emitter.emit();
}

/** The state the emitter keeps while writing one function. */
export class RegionEmitter {
    /**
     * @param {ModuleContext} context
     * @param {import('../region.js').Region} region
     * @param {{ entryTop?: number, checked?: boolean }} [options]
     */
    constructor(context, region, { entryTop = 0, checked = false } = {}){
        this.context = context;
        this.layout = context.layout;
        /** Where the layout keeps the flag record between regions, or -1. */
        this.flagRecord = context.layout.flagRecord ?? -1;
        this.region = region;
        this.b = new Body();
        /** @type {Map<number, number>} */
        this.labels = new Map(region.blocks.map((block, index)=>[block.start, index]));
        /** By ret block: the return addresses it jumps to rather than leaves by. */
        this.returns = inlineReturns(region);
        /** @type {string[]} the open control labels, innermost last */
        this.controls = [];
        /**
         * What the flag record holds at this point of the block, when known:
         * the unfolded kind and width code, or null when the block was
         * entered from elsewhere and the record is whatever the last
         * instruction anywhere left in it.
         *
         * @type {{ kind: number, width: number } | null}
         */
        this.pending = null;
        /** The record at each emitted block's end, and the guess for this one's start.
         * @type {({ kind: number, width: number } | null)[]} */
        this.ends = [];
        /** The guess for this block's start once worked out (`blockHint`).
         * @type {{ kind: number, width: number } | null | undefined} */
        this.hint = undefined;
        /** @type {Map<string, number>} */
        this.unsupported = new Map();
        /**
         * Why each left-out instruction was left out and the shape of the
         * block it sat in: `opcode (reason; entry kinds; entry x87)`. What
         * `unsupported` counts by opcode, split by cause, for the diagnostics.
         * @type {Map<string, number>}
         */
        this.refusals = new Map();
        /** @type {Map<string, number>} */
        this.relaxedReads = new Map();
        /** The x87 emitter's reason for the current instruction being left out.
         * @type {string | null} */
        this.x87RefusalReason = null;
        /**
         * Blocks that leave before retiring anything (nothing decoded, or
         * the first instruction left out): no entry is made for them, since
         * a transfer into one would come straight back to the same address.
         * @type {Set<number>}
         */
        this.leaving = new Set();
        this.blockIndex = 0;
        /** Whether the current block is a wasm loop onto itself (see `emitBlock`). */
        this.selfLoop = false;
        /**
         * The current instruction's place in the access groups (`planRegion`,
         * `planBlock` in a loop's checked copy), or null.
         * @type {import('./memory.js').Planned | null}
         */
        this.memPlan = null;
        /**
         * The region's access groups (`planRegion`), or null where every
         * access is tested (a hybrid layout).
         * @type {import('./memory.js').RegionPlan | null}
         */
        this.memoryPlan = null;
        /** Whether the block's port write called the host from here and went on. */
        this.trapped = false;
        /** Blocks emitted as loops onto themselves. */
        this.loops = 0;
        /** Calls of the flag helper emitted. */
        this.folds = 0;
        /** The flags live at each block's end (`liveFlagsOut`), which the dead-flag pass
         * takes and which decides a fused compare. @type {number[]} */
        this.flagsOut = [];
        /** The flags live after each instruction of the block being emitted. @type {number[]} */
        this.flagsAfterEach = [];
        /** The flags live after the instruction being emitted. */
        this.flagsAfter = ARITH_FLAGS | DF;
        /**
         * A float compare of the current block whose flags only its final
         * branch reads (`fusesCompare`): the branch compares the operands, held
         * in these locals, and the flags are never made.
         * @type {import('./x87.js').FloatCompare | null}
         */
        this.fcmp = null;
        /** Branches that compared a float compare's operands themselves, for the tests. */
        this.fusedCompares = 0;
        /** By block, the blocks whose way on goes there, in order, once a guess needs them.
         * @type {number[][] | null} */
        this.flowsInto = null;
        /** Each loop head's last block (`planLoops`). @type {Map<number, number>} */
        this.loopEnds = new Map();
        /** The ranges being emitted, innermost last (`emitRange`).
         * @type {{ lo: number, hi: number, loop: boolean,
         *     items: { start: number, end: number, loop: boolean }[] }[]} */
        this.ranges = [];
        /** Whether the current block's remaining instructions are unreachable. */
        this.dead = false;
        /** Instructions retired in the current block so far, to charge at its end. */
        this.blockRetired = 0;
        this.instructions = 0;
        // The vector registers the region touches, found by a scan, each given
        // a local: loaded in the prologue, and written back when written.
        /** @type {Map<number, number>} xmm index -> local */
        this.xmmLocals = new Map();
        /** @type {Map<number, number>} mm index -> local */
        this.mmLocals = new Map();
        /** @type {Set<number>} */
        this.xmmWritten = new Set();
        /** @type {Set<number>} */
        this.mmWritten = new Set();
        /** The instruction being emitted. @type {import('../decode/decoder.js').Instruction} */
        this.current = region.blocks[0].instructions[0];
        /** A store was emitted for the current instruction: check `stale` after it. */
        this.staleCheck = false;
        /** The control depth at the start of the block being emitted. */
        this.blockDepth = 0;
        /** @type {number[]} */
        this.localTypes = [...LOCAL_TYPES];
        this.entryTop = entryTop;
        // A region that translates both classes keeps the eight registers as one
        // set with two views, so every register needs an mm local (the mantissa)
        // beside its x87 local (the value): an exchange or a write of either
        // class moves the other's, and a register only one class touches is
        // still written back in the form the other left it. Allocate all eight
        // mm locals there; elsewhere only the operands'.
        const mixed = context.features.simd
            && !context.leaveOut.has('x87')
            && region.blocks.some(block=>block.instructions.some(isX87))
            && regionHasMmx(region, context.leaveOut);
        if (context.features.simd)
        {
            this.localTypes.push(ValType.v128, ValType.v128, ValType.v128);
            for (const block of region.blocks)
            {
                for (const instruction of block.instructions)
                {
                    for (const operand of instruction.operands)
                    {
                        if (operand.kind === 'xmm' && !this.xmmLocals.has(/** @type {number} */ (operand.reg)))
                        {
                            this.xmmLocals.set(/** @type {number} */ (operand.reg), this.localTypes.length + STATE_PARAMS);
                            this.localTypes.push(ValType.v128);
                        }
                    }
                }
            }
            if (mixed)
            {
                for (let p = 0; p < 8; p++)
                {
                    this.mmLocals.set(p, this.localTypes.length + STATE_PARAMS);
                    this.localTypes.push(ValType.i64);
                }
            }
            else
            {
                for (const block of region.blocks)
                {
                    for (const instruction of block.instructions)
                    {
                        for (const operand of instruction.operands)
                        {
                            if (operand.kind === 'mm' && !this.mmLocals.has(/** @type {number} */ (operand.reg)))
                            {
                                this.mmLocals.set(/** @type {number} */ (operand.reg), this.localTypes.length + STATE_PARAMS);
                                this.localTypes.push(ValType.i64);
                            }
                        }
                    }
                }
            }
        }
        /** The x87 emission state: the tracker's states per block and the locals. */
        this.x87 = prepareX87(this, entryTop, checked);
        /**
         * Where the registers' loads and stores go, filled once the body is
         * written and the locals it uses are known (`fillDeferred`): the
         * integer registers, the x87 ones, or both.
         * @type {{ at: number, kind: 'load' | 'store', regs: boolean, x87: boolean }[]}
         */
        this.deferred = [];
    }

    /** The local an xmm register lives in. @param {number} index @param {boolean} [write] */
    xmmLocal(index, write = false){
        if (write)
        {
            this.xmmWritten.add(index);
        }
        return /** @type {number} */ (this.xmmLocals.get(index));
    }

    /** The local an mm register lives in. @param {number} index @param {boolean} [write] */
    mmLocal(index, write = false){
        if (write)
        {
            this.mmWritten.add(index);
        }
        return /** @type {number} */ (this.mmLocals.get(index));
    }

    mmxTouchedLocal(){
        return Local.mmxTouched;
    }

    /** One of the three v128 scratch locals. @param {number} which */
    vecTempLocal(which){
        return Local.vec + which;
    }

    /** The flag locals, in the shape the formulas take. */
    get flagLocals(){
        return {
            kind: Local.kind, res: Local.res, op1: Local.op1, op2: Local.op2, cin: Local.cin,
            flags: Local.flags,
        };
    }

    /** @returns {Translation} */
    emit(){
        const { b } = this;
        this.prologue();
        this.open('out', EMPTY);
        if (this.x87.active)
        {
            x87EntryCheck(this);
        }
        this.openLoop('dispatch');
        const blocks = this.region.blocks;
        const flat = this.context.flat === true;
        this.loopEnds = flat ? new Map() : planLoops(blocks);
        this.flowsInto = null;
        this.flagsOut = liveFlagsOut(blocks, this.labels, this.context.precise === true);
        // The other executor's code table in a hybrid layout is a second
        // thing a store is noted against: that layout tests each access. A
        // jump back carries windows only through the flat dispatch; a block
        // the x87 plan cuts runs nothing to take them for.
        this.memoryPlan = this.layout.codePages < 0
            ? planRegion(blocks, { entry: this.region.entry, backward: flat,
                heads: new Set([...this.loopEnds.keys(), ...this.x87.cut]),
                returns: this.returns })
            : null;
        this.ranges = [];
        this.emitRange(0, blocks.length - 1, false);
        // Falling out of the last block cannot happen: every block ends with
        // explicit control. If it did, the dispatch would loop on the same
        // label forever, so leave instead.
        b.unreachable();
        this.close(); // dispatch
        this.close(); // out
        this.epilogue();
        this.fillDeferred();
        const functionIndex = this.context.m.function(
            this.context.regionType, this.localTypes, b.toBytes(), { hints: b.hints });
        return {
            functionIndex, labels: this.labels, unsupported: this.unsupported,
            refusals: this.refusals, relaxedReads: this.relaxedReads,
            instructions: this.instructions,
            cut: new Set([...this.x87.cut, ...this.unknownBlocks(), ...this.leaving,
                ...this.shapedBlocks()]),
            entryTop: this.entryTop, loops: this.loops, x87Guards: this.x87.guards,
            x87RelaxedReads: this.x87.relaxedReads, fusedCompares: this.fusedCompares,
            folds: this.folds,
        };
    }

    // --- control structure bookkeeping ---

    /** @param {string} name @param {number} type */
    open(name, type){
        this.controls.push(name);
        this.b.block(type);
    }

    /** @param {string} name */
    openLoop(name){
        this.controls.push(name);
        this.b.loop(EMPTY);
    }

    /** @param {string} name @param {number} type */
    openIf(name, type = EMPTY){
        this.controls.push(name);
        this.b.if(type);
    }

    /**
     * An `if` whose body is a slow path rarely taken -- a spent budget, a page
     * not clean, a store into code, a fault, an x87 stack shape or precision
     * control other than the region's, an exception the processor would raise
     * -- marked unlikely for the engine, so the code it guards goes out of line
     * and its spills with it, where they sat on the path that goes on. A branch
     * that data decides (`zero` in `bsf`, `taken`) is an `openIf`.
     *
     * @param {string} name @param {number} type
     */
    openGuard(name, type = EMPTY){
        this.controls.push(name);
        this.b.unlikely().if(type);
    }

    close(){
        this.controls.pop();
        this.b.end();
    }

    /** The branch depth of an open control by name. @param {string} name */
    depthOf(name){
        const index = this.controls.lastIndexOf(name);
        if (index < 0)
        {
            throw new Error(`emit: no open control "${name}"`);
        }
        return this.controls.length - 1 - index;
    }

    // --- state block access ---

    /** Pushes the guest address of a layout field. @param {number} offset */
    stateAddress(offset){
        this.b.i32const(offset);
    }

    prologue(){
        this.loadState(this.flagRecord >= 0);
        this.resetRun(this.flagRecord >= 0);
    }

    /**
     * The registers, the flags, the vector registers and the x87 block into the
     * locals. `fromParams`: the registers, the record, the flags word and the
     * count came in as parameters (cork's layout, on entry), so only what
     * lives in the state block alone is loaded.
     *
     * @param {boolean} [fromParams]
     */
    loadState(fromParams = false){
        const { b, layout } = this;
        if (fromParams)
        {
            this.pending = null;
        }
        else
        {
            b.i32const(0).load('i32', { offset: layout.eflags }).localSet(Local.flags);
        }
        if (this.flagRecord >= 0 && !fromParams)
        {
            // The record the last region left, as it left it: its kind is not
            // known here, and a read folds it only when it must.
            for (const [i, local] of RECORD_LOCALS.entries())
            {
                b.i32const(0).load('i32', { offset: this.flagRecord + i * 4 }).localSet(local);
            }
            this.pending = null;
        }
        if (layout.flagsChanged >= 0 && this.context.getEflags !== undefined)
        {
            // The other executor keeps some flags lazy: when its record says
            // so, its own fold gives the whole word.
            b.i32const(0).load('i32', { offset: layout.flagsChanged });
            this.openIf('lazy', EMPTY);
            b.call(this.context.getEflags).localSet(Local.flags);
            this.close();
        }
        for (const [index, local] of this.xmmLocals)
        {
            b.i32const(0).loadV128({ offset: layout.xmm + index * 16 }).localSet(local);
        }
        for (const [index, local] of this.mmLocals)
        {
            b.i32const(0).load('i64', { offset: layout.x87 + index * 16 }).localSet(local);
        }
        if (this.x87.active)
        {
            x87Prologue(this);
        }
        // The registers, after the x87 empty mask they are loaded under.
        this.deferred.push({ at: b.length, kind: 'load', regs: !fromParams, x87: true });
    }

    /**
     * The run's own locals at their start: no record, nothing retired, nothing
     * touched. `fromParams`: the count came in as a parameter and goes on.
     *
     * @param {boolean} [fromParams]
     */
    resetRun(fromParams = false){
        const { b } = this;
        if (this.flagRecord < 0)
        {
            b.i32const(0).localSet(Local.kind);
        }
        if (!fromParams)
        {
            b.i32const(0).localSet(Local.retired);
        }
        b.i32const(0).localSet(Local.mmxTouched);
        b.i32const(0).localSet(Local.stale);
    }

    /**
     * Writes every local back and returns the kind in `t0`. Under cork's own
     * layout a transfer to another region passes the registers, the record,
     * the flags word and the count as its parameters, so only what lives in
     * the state block alone is written before it, and the rest only when the
     * run leaves for the host.
     */
    epilogue(){
        if (this.flagRecord >= 0 && this.context.hash)
        {
            this.storeMemoryState();
            this.transfer();
            this.storeCarriedState();
        }
        else
        {
            this.storeState();
            if (this.context.hash)
            {
                this.transfer();
            }
        }
        this.b.localGet(Local.t0);
    }

    /**
     * Every local back into the state block: the registers, the flags made
     * whole, EIP, the count added to the counter word, the vector registers
     * written, the x87 block. The state block is then the truth, as the
     * host reads it and as `loadState` takes it back.
     */
    storeState(){
        this.storeCarriedState();
        this.storeMemoryState();
    }

    /**
     * What a transfer carries in its parameters, into the state block: the
     * registers (all eight under cork's layout, whose unwritten ones came in
     * as parameters and are not in the block), the record or the folded
     * flags, EIP and the count.
     */
    storeCarriedState(){
        const { b, layout } = this;
        if (this.flagRecord >= 0)
        {
            // The record goes as it is: the helper at every exit was a fifth of
            // a call-heavy loop, and the next region mostly writes the flags
            // before it reads them. Whoever reads the word folds it.
            for (const [i, local] of RECORD_LOCALS.entries())
            {
                b.i32const(0).localGet(local).store('i32', { offset: this.flagRecord + i * 4 });
            }
        }
        else
        {
            this.materialise();
        }
        this.deferred.push({ at: b.length, kind: 'store', regs: true, x87: false });
        b.i32const(0).localGet(Local.flags).store('i32', { offset: layout.eflags });
        if (layout.flagsChanged >= 0)
        {
            b.i32const(0).i32const(0).store('i32', { offset: layout.flagsChanged });
        }
        b.i32const(0).localGet(Local.eip).store('i32', { offset: layout.eip });
        if (layout.previousIp >= 0)
        {
            b.i32const(0).localGet(Local.eip).store('i32', { offset: layout.previousIp });
        }
        b.i32const(0);
        b.i32const(0).load('i32', { offset: layout.counter }).localGet(Local.retired).op(I32.add);
        b.store('i32', { offset: layout.counter });
    }

    /**
     * What lives in the state block alone, a transfer's callee loading it from
     * there: the vector registers written and the x87 block.
     */
    storeMemoryState(){
        const { b, layout } = this;
        this.deferred.push({ at: b.length, kind: 'store', regs: false, x87: true });
        for (const index of this.xmmWritten)
        {
            b.i32const(0).localGet(this.xmmLocal(index))
                .storeV128({ offset: layout.xmm + index * 16 });
        }
        if (this.x87.active && this.x87.hasMmx)
        {
            // A region of both classes: the eight registers are one set with two
            // views, reconciled at every write. `x87Epilogue` writes the words
            // (the top, the masks, the status and control); the registers go
            // back from the mantissas the mm locals hold, each in the form --
            // MMX or relaxed double -- its last write left it, which the form
            // mask names. The run's MMX mark is not consulted: the locals the
            // instructions kept are the truth, an `emms` among them.
            x87Epilogue(this);
            this.storeMixedRegisters();
            return;
        }
        for (const index of this.mmWritten)
        {
            b.i32const(0).localGet(this.mmLocal(index))
                .store('i64', { offset: layout.x87 + index * 16 });
            if (layout.x87Format === 'tagged80')
            {
                // An MMX write leaves the register's exponent all ones, as the
                // processor does, so the emulator sees it as it would its own.
                b.i32const(0).i32const(0xffff)
                    .store('i32_16', { offset: layout.x87 + index * 16 + 8 });
            }
        }
        if (this.x87.active)
        {
            x87Epilogue(this);
        }
        if (this.mmLocals.size > 0)
        {
            // An MMX instruction ran: the x87 stack's top is zero and every
            // register is held, as on the processor. The two are written
            // apart, because an `emms` after them releases the hold -- it
            // wrote the empty mask itself -- and leaves the top at the zero
            // the first of them set.
            b.localGet(Local.mmxTouched).i32const(MMX_TOP).op(I32.and);
            b.if(EMPTY);
            b.i32const(0).i32const(0).store('i32_8', { offset: layout.x87Top });
            b.end();
            b.localGet(Local.mmxTouched).i32const(MMX_HELD).op(I32.and);
            b.if(EMPTY);
            b.i32const(0).i32const(0).store('i32_8', { offset: layout.x87Empty });
            b.end();
        }
    }

    /**
     * The register loads and stores `loadState` and `storeState` left a place
     * for, now that the whole body is written: a register the region never
     * names is neither loaded nor stored, and one it only reads is not
     * stored. A transfer between regions is a store and a load of the state
     * block, so what a region leaves alone costs it nothing there. A
     * register written is also loaded: a path that leaves before its write
     * stores the value it came in with. The same for the x87 registers
     * outside a region with MMX (whose two views need all eight).
     */
    fillDeferred(){
        const main = this.b;
        const { used, written } = main;
        const { layout } = this;
        // Under cork's layout the registers a region did not load came in as
        // parameters, so the block does not hold them: every one is stored,
        // and a reload (after a trap's handler) takes every one back.
        const all = this.flagRecord >= 0;
        for (const { at, kind, regs, x87 } of this.deferred.reverse())
        {
            const b = this.b = new Body();
            for (let r = 0; r < (regs ? 8 : 0); r++)
            {
                const offset = layout.regs + r * 4;
                if (kind === 'load' && (all || used.has(Local.reg + r)))
                {
                    b.i32const(0).load('i32', { offset }).localSet(Local.reg + r);
                }
                if (kind === 'store' && (all || written.has(Local.reg + r)))
                {
                    b.i32const(0).localGet(Local.reg + r).store('i32', { offset });
                }
            }
            if (x87 && this.x87.active && !this.x87.hasMmx)
            {
                if (kind === 'load')
                {
                    x87LoadRegisters(this, k=>used.has(this.x87.base + k));
                }
                else
                {
                    x87StoreRegisters(this, k=>written.has(this.x87.base + k));
                }
            }
            main.insert(at, b);
        }
        this.b = main;
    }

    /**
     * The eight registers of a region that translated both classes, back into
     * the state block from the mantissas the mm locals hold. A register written
     * by either class is stored; the form mask says which tag it takes, the all
     * ones an MMX write left or the relaxed double an x87 write left, so the
     * emulator reads each back as the view that wrote it last. The mantissa is
     * the mm local's whichever class wrote it: an x87 write kept the mm local
     * equal to the double's bits, an MMX write to the value it stored.
     */
    storeMixedRegisters(){
        const { b, layout } = this;
        const x = this.x87;
        for (let p = 0; p < 8; p++)
        {
            const at = layout.x87 + p * 16;
            const mm = /** @type {number} */ (this.mmLocals.get(p));
            // An MMX write is unconditional (its local is the mantissa); an x87
            // one is under the dirty mask, which the register's own writes set.
            const unconditional = this.mmWritten.has(p);
            if (!unconditional)
            {
                b.localGet(Local.x87Dirty).i32const(1 << p).op(I32.and);
                this.openIf(`mixed${p}`, EMPTY);
            }
            b.i32const(0).localGet(mm).store('i64', { offset: at });
            if (layout.x87Format === 'tagged80')
            {
                b.i32const(0);
                b.i32const(0xffff);
                b.i32const(0x7ffe);
                b.localGet(x.form).i32const(1 << p).op(I32.and);
                b.select();
                b.store('i32_16', { offset: at + 8 });
            }
            if (!unconditional)
            {
                this.close();
            }
        }
    }


    /**
     * An untranslated exit with budget left probes the entry hash for the
     * address it leaves at and, on a slot compiled for this x87 top or for
     * any, tail-calls that region's function with the label and the budget
     * that remains: a return, an indirect jump or a call into translated
     * code costs no crossing. The state block is complete at this point,
     * so the callee's prologue reads what this epilogue wrote. A miss
     * (an empty slot met) leaves as before.
     */
    transfer(){
        const { b, layout } = this;
        const base = layout.tables + Tables.HASH;
        b.localGet(Local.t0).i32const(Exit.UNTRANSLATED).op(I32.eq)
            .localGet(Local.budget).i32const(0).op(I32.gtS).op(I32.and);
        this.openIf('lookup');
        b.localGet(Local.eip).i32const(0x9e3779b1 | 0).op(I32.mul).i32const(layout.hashShift ?? 16)
            .op(I32.shrU)
            .localSet(Local.t1);
        this.openLoop('probe');
        b.localGet(Local.t1).i32const(Tables.HASH_SLOT).op(I32.mul).i32const(base).op(I32.add)
            .localSet(Local.t2);
        b.localGet(Local.t2).load('i32').localTee(Local.addr).localGet(Local.eip).op(I32.eq);
        this.openIf('hit');
        b.localGet(Local.t2).load('i32_8u', { offset: 10 }).localTee(Local.addr)
            .i32const(ANY_TOP).op(I32.eq);
        b.localGet(Local.addr).i32const(0).load('i32_8u', { offset: layout.x87Top }).op(I32.eq);
        b.op(I32.or);
        this.openIf('top');
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.countTransfers)
        {
            const at = layout.tables + Tables.TRANSFERS;
            b.i32const(0).i32const(0).load('i32', { offset: at }).i32const(1).op(I32.add)
                .store('i32', { offset: at });
        }
        b.localGet(Local.t2).load('i32_16u', { offset: 8 });
        b.localGet(Local.budget);
        for (let local = Local.budget + 1; local < STATE_PARAMS; local++)
        {
            // A region over the emulator's layout loads its state from the
            // block and takes none: zeros, so a register it never names is
            // not counted as used and loaded for the call alone.
            if (this.flagRecord >= 0)
            {
                b.localGet(local);
            }
            else
            {
                b.i32const(0);
            }
        }
        b.localGet(Local.t2).load('i32', { offset: 4 });
        b.returnCallIndirect(this.context.regionType, 0);
        this.close();
        b.localGet(Local.t2).load('i32').localSet(Local.addr);
        this.close();
        b.localGet(Local.addr).op(I32.eqz);
        b.brIf(this.depthOf('lookup'));
        b.localGet(Local.t1).i32const(1).op(I32.add).i32const(Tables.HASH_SLOTS - 1).op(I32.and)
            .localSet(Local.t1);
        b.br(this.depthOf('probe'));
        this.close();
        this.close();
    }

    // --- flags ---

    /**
     * Folds the record into the flags word, unless the word is known to be
     * whole already. Afterwards the record is EAGER.
     */
    materialise(){
        if (this.pending && this.pending.kind === Kind.EAGER)
        {
            return;
        }
        const { b } = this;
        // Where the record is not known here (a block's or the epilogue's
        // start) it is often whole already: then no call.
        const unknown = this.pending === null;
        if (unknown)
        {
            b.localGet(Local.kind);
            this.openIf('lazyFlags');
        }
        b.localGet(Local.kind).localGet(Local.res).localGet(Local.op1).localGet(Local.op2)
            .localGet(Local.cin).localGet(Local.flags);
        b.call(this.context.materialise);
        this.folds++;
        b.localSet(Local.flags);
        b.i32const(0).localSet(Local.kind);
        if (unknown)
        {
            this.close();
        }
        this.pending = { kind: Kind.EAGER, width: 2 };
    }

    /**
     * Makes the word own CF, which is all an `inc` or `dec` keeps of the
     * flags before it: a known record's CF is computed inline into the word
     * (a `dec ecx` after an `add` or `xor` in a loop called the helper each
     * turn for five flags the `dec` overwrites); an unknown one is folded
     * only when its kind does not leave CF in the word already -- a counting
     * loop's head meets its own `dec`'s record there. The record stays as it
     * was otherwise, its word agreeing with it.
     */
    carryIntoWord(){
        const { b } = this;
        const pending = this.pending;
        if (pending === null)
        {
            // The unfolded kind in t2; CF of a kind that does not keep it in
            // the word, without the helper: the operands are masked to their
            // width, so an unsigned compare is the carry at every width.
            const k = Local.t2;
            b.localGet(Local.kind).i32const(2).op(I32.shrU).localSet(k);
            b.i32const(CARRY_IN_WORD).localGet(k).op(I32.shrU).i32const(1).op(I32.and).op(I32.eqz);
            this.openIf('carry', EMPTY);
            b.localGet(Local.flags).i32const(~CF).op(I32.and);
            // SUB/SBB: op1 < op2, or equal with a borrow in (SBB).
            b.localGet(k).i32const(Kind.SUB).op(I32.sub).i32const(2).op(I32.ltU);
            b.localGet(Local.op1).localGet(Local.op2).op(I32.ltU);
            b.localGet(Local.op1).localGet(Local.op2).op(I32.eq).localGet(Local.cin).op(I32.and)
                .localGet(k).i32const(Kind.SBB).op(I32.eq).op(I32.and);
            b.op(I32.or).op(I32.and);
            // ADD/ADC: the sum wrapped below op1, or equal with a carry in (ADC).
            b.localGet(k).i32const(Kind.ADD).op(I32.sub).i32const(2).op(I32.ltU);
            b.localGet(Local.res).localGet(Local.op1).op(I32.ltU);
            b.localGet(Local.res).localGet(Local.op1).op(I32.eq).localGet(Local.cin).op(I32.and)
                .localGet(k).i32const(Kind.ADC).op(I32.eq).op(I32.and);
            b.op(I32.or).op(I32.and);
            b.op(I32.or);
            // NEG: op2 was not zero. LOGIC: none of the three, 0.
            b.localGet(k).i32const(Kind.NEG).op(I32.eq);
            b.localGet(Local.op2).i32const(0).op(I32.ne).op(I32.and);
            b.op(I32.or);
            b.op(I32.or).localSet(Local.flags);
            this.close();
            return;
        }
        if ((eagerFlagsOf(pending.kind) & CF) !== 0)
        {
            return;
        }
        b.localGet(Local.flags).i32const(~CF).op(I32.and);
        emitFlag(b, this.flagLocals, pending.kind, pending.width, CF);
        b.op(I32.or).localSet(Local.flags);
    }

    /**
     * The guess at the record the current block is entered with, worked out
     * at its first read: what an earlier block that goes on here left, or else
     * what a later one that jumps back here is expected to leave -- a loop's
     * head reading the flags its latch set. Only a guess -- the block is
     * entered from elsewhere too -- so a read checks it.
     *
     * @returns {{ kind: number, width: number } | null}
     */
    blockHint(){
        if (this.hint !== undefined)
        {
            return this.hint;
        }
        const index = this.blockIndex;
        const blocks = this.region.blocks;
        this.flowsInto ??= flowsInto(blocks, this.labels);
        const from = this.flowsInto[index];
        this.hint = null;
        for (const i of from)
        {
            const end = this.ends[i];
            if (i < index && end && end.kind !== Kind.EAGER)
            {
                this.hint = end;
                return end;
            }
        }
        for (const i of from)
        {
            if (i >= index)
            {
                this.hint = recordAtEnd(blocks[i]);
                if (this.hint !== null)
                {
                    return this.hint;
                }
            }
        }
        return null;
    }

    /**
     * Pushes 0/1 for a flag, from the record when its kind is known here and
     * from the word otherwise.
     *
     * @param {number} flag
     */
    pushFlag(flag){
        this.pushRead((kind, width)=>emitFlag(this.b, this.flagLocals, kind, width, flag));
    }

    /** Pushes 0/1 for a condition code. @param {number} cc */
    pushCondition(cc){
        if (this.fcmp !== null)
        {
            // Read once, by the branch; a loop's second copy compares again.
            floatCondition(this.b, this.fcmp, cc);
            this.fcmp = null;
            this.fusedCompares++;
            return;
        }
        this.pushRead((kind, width)=>emitCondition(this.b, this.flagLocals, kind, width, cc));
    }

    /**
     * Whether the flags of the instruction at `at` in the current block are
     * read by the block's final conditional branch alone: nothing after the
     * branch reads them (the flags' liveness over the region), and nothing
     * between the two touches the flags or can leave (`between` names what
     * may stand there). Such a float compare need not make the flags at all;
     * the branch compares its operands itself.
     *
     * @param {number} at
     * @param {(instruction: import('../decode/decoder.js').Instruction) => boolean} between
     */
    fusesCompare(at, between){
        const block = this.region.blocks[this.blockIndex];
        const last = block.instructions.length - 1;
        if (block.exit.kind !== 'jcc' || at < 0 || at >= last)
        {
            return false;
        }
        for (let k = at + 1; k < last; k++)
        {
            if (!between(block.instructions[k]))
            {
                return false;
            }
        }
        return (this.flagsOut[this.blockIndex] & ARITH_FLAGS) === 0;
    }

    /**
     * A read of the flags: from the record when its kind is known here; where
     * it is not (a block's start), from the record when it is of the kind the
     * block before left -- the second `jcc` of a `cmp; je; jl` chain, the
     * test after a loop's head -- and through the helper otherwise.
     *
     * @param {(kind: number, width: number) => void} read
     */
    pushRead(read){
        const hint = this.pending === null ? this.blockHint() : null;
        if (hint !== null)
        {
            const { b } = this;
            b.localGet(Local.kind).i32const(hint.kind * 4 + hint.width).op(I32.eq);
            this.openIf('flagHint', ValType.i32);
            read(hint.kind, hint.width);
            b.else();
            b.localGet(Local.kind).localGet(Local.res).localGet(Local.op1).localGet(Local.op2)
                .localGet(Local.cin).localGet(Local.flags);
            b.call(this.context.materialise);
            this.folds++;
            b.localSet(Local.flags);
            b.i32const(0).localSet(Local.kind);
            read(Kind.EAGER, 2);
            this.close();
            return;
        }
        if (this.pending === null)
        {
            this.materialise();
        }
        const { kind, width } = /** @type {{ kind: number, width: number }} */ (this.pending);
        read(kind, width);
    }

    /**
     * Records a lazy write: the result is on the stack and is left there,
     * op1 and op2 were set by the caller.
     *
     * @param {number} kind  an unfolded Kind
     * @param {number} size
     */
    record(kind, size){
        this.b.localTee(Local.res);
        this.b.i32const(kindOf(kind, size)).localSet(Local.kind);
        this.pending = { kind, width: widthCode(size) };
    }

    /**
     * Prepares for an eager write of some flags: the word is made whole and
     * the bits named are cleared, so the caller ors its values in.
     *
     * @param {number} mask
     */
    eagerWrite(mask){
        if ((mask & ARITH) === ARITH)
        {
            // All six are written: nothing of the record survives to fold.
            this.b.i32const(0).localSet(Local.kind);
            this.pending = { kind: Kind.EAGER, width: 2 };
        }
        else
        {
            this.materialise();
        }
        this.b.localGet(Local.flags).i32const(~mask).op(I32.and).localSet(Local.flags);
    }

    /** Ors a 0/1 on the stack into the word as `flag`. @param {number} flag */
    orFlag(flag){
        this.b.i32const(flag).op(0x6c).localGet(Local.flags).op(I32.or).localSet(Local.flags);
    }

    // --- blocks and exits ---

    /**
     * The ways control arrives at a block, for the refusal diagnostics: the
     * entry of the region, the fall-through of a preceding block, a branch's
     * target, a call's return address, or (no in-region edge at all) an
     * address only the runtime enters -- an indirect target.
     *
     * @param {number} index
     */
    entryKinds(index){
        const { region } = this;
        const block = region.blocks[index];
        const kinds = [];
        if (block.start === region.entry)
        {
            kinds.push('region-entry');
        }
        let returns = false;
        let falls = false;
        let branch = false;
        for (let i = 0; i < region.blocks.length; i++)
        {
            if (i === index)
            {
                continue;
            }
            const exit = region.blocks[i].exit;
            if (exit.next === block.start && (exit.kind === 'call' || exit.kind === 'trap'))
            {
                returns = true;
            }
            else if (exit.next === block.start
                && (exit.kind === 'fallthrough' || exit.kind === 'jcc' || exit.kind === 'loop'))
            {
                falls = true;
            }
            if (exit.targets.includes(block.start))
            {
                branch = true;
            }
        }
        if (returns)
        {
            kinds.push('call-return');
        }
        if (falls)
        {
            kinds.push('fall-through');
        }
        if (branch)
        {
            kinds.push('branch-target');
        }
        if (kinds.length === 0)
        {
            kinds.push('indirect-target');
        }
        return kinds.join('+');
    }

    /** Whether the region's entry block had a known x87 state. */
    entryBlockKnown(){
        if (!this.x87.active)
        {
            return true;
        }
        const at = this.region.blocks.findIndex(block=>block.start === this.region.entry);
        return at >= 0 && this.x87.states[at] !== null;
    }

    /**
     * Records one left-out instruction, why and the shape of its block.
     *
     * @param {import('../decode/decoder.js').Instruction} instruction
     * @param {string} reason
     * @param {number} index
     */
    noteRefusal(instruction, reason, index){
        const key = `${instruction.opcode} (${reason}; ${this.entryKinds(index)}; `
            + `entry-${this.entryBlockKnown() ? 'known' : 'unknown'})`;
        this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
    }

    /**
     * The blocks `lo` to `hi` as the region's structure has them: each a wasm
     * block the code after its end follows, a loop among them as one item
     * whose blocks are a range of their own inside a wasm loop. A branch
     * forward is a branch out of its target's item; a branch back to the head
     * of a loop around it is a branch to that loop. The dispatch at the head
     * of the range takes an entry to any of its blocks: at the function's own
     * head always, at a loop's only when the label is not the loop's head --
     * an entry into the middle of the loop from outside it, rather than a turn.
     *
     * @param {number} lo @param {number} hi
     * @param {boolean} loop  the range is a loop's, `lo` its head
     */
    emitRange(lo, hi, loop){
        const { b } = this;
        const blocks = this.region.blocks;
        /** @type {{ start: number, end: number, loop: boolean }[]} */
        const items = [];
        for (let i = loop ? lo + 1 : lo; i <= hi;)
        {
            const end = this.loopEnds.get(i);
            if (end !== undefined && end <= hi)
            {
                items.push({ start: i, end, loop: true });
                i = end + 1;
            }
            else
            {
                items.push({ start: i, end: i, loop: false });
                i++;
            }
        }
        const range = { lo, hi, loop, items };
        this.ranges.push(range);
        for (let k = items.length - 1; k >= 0; k--)
        {
            this.open(`b${items[k].start}`, EMPTY);
            if (!items[k].loop && this.entryTested(items[k].start))
            {
                // The block's own entry, before its test of the windows it
                // takes from the block before (`emitEntryTests`).
                this.open(`p${items[k].start}`, EMPTY);
            }
        }
        /** The depth of the item holding each label, `fallback` for the rest. @param {number} fallback */
        const table = fallback=>{
            const past = blocks.map((block, t)=>{
                const item = items.find(one=>one.start <= t && t <= one.end);
                return item ? this.depthOf(`b${item.start}`) : fallback;
            });
            if (this.memoryPlan === null || !this.memoryPlan.entry.some(tests=>tests.length > 0))
            {
                return past;
            }
            // A label past the blocks is the block's from the one it takes
            // windows from: past their test (`takesFrom`).
            const own = past.map((depth, t)=>(this.entryTested(t)
                && items.some(one=>one.start === t && !one.loop) ? this.depthOf(`p${t}`) : depth));
            return [...own, ...past];
        };
        if (loop)
        {
            b.localGet(Local.label).i32const(lo).op(I32.ne);
            this.openIf(`enter${lo}`);
            // Any label not of an item here is the head's: out of the `if`.
            b.localGet(Local.label);
            b.brTable(table(0), 0);
            this.close();
            this.emitBlock(blocks[lo], lo);
        }
        else
        {
            b.localGet(Local.label);
            b.brTable(table(0), 0);
        }
        for (const item of items)
        {
            this.close();
            if (item.loop)
            {
                this.openLoop(`L${item.start}`);
                this.emitRange(item.start, item.end, true);
                this.close();
            }
            else
            {
                if (this.entryTested(item.start))
                {
                    this.emitEntryTests(item.start);
                    this.close();
                }
                this.emitBlock(blocks[item.start], item.start);
            }
        }
        this.ranges.pop();
    }

    /**
     * Whether a block tests, when entered from anywhere but the block it
     * takes windows from, the windows that block tested for it.
     *
     * @param {number} index
     */
    entryTested(index){
        return this.memoryPlan !== null && this.memoryPlan.entry[index].length > 0;
    }

    /**
     * Whether the current block goes on into `index` with the windows that
     * block takes from it tested: then past that block's entry test.
     *
     * @param {number} index
     */
    takesFrom(index){
        return this.entryTested(index)
            && /** @type {import('./memory.js').RegionPlan} */ (this.memoryPlan).inherit[index]
                === this.blockIndex;
    }

    /**
     * A block's entry test: the windows it takes from the block before it,
     * tested where it is entered otherwise -- by the dispatch, from another
     * region, from the host -- and left untranslated at its start when one is
     * not clean, with nothing of it run.
     *
     * @param {number} index
     */
    emitEntryTests(index){
        const block = this.region.blocks[index];
        this.blockRetired = 0;
        this.staleCheck = false;
        this.current = block.instructions[0];
        if (this.x87.active)
        {
            // Its way out leaves the stack as the block's own start has it.
            x87BlockStart(this, index);
        }
        emitGroupChecks(this, /** @type {import('./memory.js').RegionPlan} */ (this.memoryPlan)
            .entry[index], block.start);
    }

    /**
     * Before falling through into the block after this one: a loop's head is
     * entered with its own label, which its dispatch tells from an entry; a
     * block that takes windows from this one past its entry test.
     *
     * @param {number} index  the block fallen into
     */
    fallInto(index){
        if (this.loopEnds.has(index))
        {
            this.b.i32const(index).localSet(Local.label);
        }
        else if (this.takesFrom(index))
        {
            this.b.br(this.depthOf(`b${index}`));
        }
    }

    /**
     * @param {import('../region.js').Block} block
     * @param {number} index
     */
    emitBlock(block, index){
        // The record's kind at the end of the block before, which a later
        // block's read at its start may take as its guess (`blockHint`).
        if (index > 0)
        {
            this.ends[index - 1] = this.pending;
        }
        this.hint = undefined;
        this.pending = null;
        this.fcmp = null;
        this.dead = false;
        this.blockRetired = 0;
        this.blockDepth = this.controls.length;
        this.blockIndex = index;
        if (block.instructions.length === 0)
        {
            this.leaving.add(index);
        }
        if (this.x87.active && !x87BlockStart(this, index))
        {
            // Reached with two different x87 tops: the other executor runs it.
            const first = block.instructions.find(instruction=>isX87(instruction))
                ?? block.instructions[0];
            if (first)
            {
                this.noteRefusal(first, 'cut-second-top', index);
            }
            this.exitAt(block.start, Exit.UNTRANSLATED);
            return;
        }
        // A block whose conditional branch comes back to its own start -- the
        // shape of most inner loops -- is a wasm loop with a direct branch
        // on the back edge, sparing the dispatcher's round trip each time.
        // With x87 in play, only when the block ends in the state it starts
        // in, so the edge needs no moves.
        const x = this.x87;
        this.selfLoop = (block.exit.kind === 'jcc' || block.exit.kind === 'loop')
            && block.exit.targets[0] === block.start && block.instructions.length > 0
            && (!x.active || (x.states[index] !== null && x.ends[index] !== null
                && sameState(x.states[index], x.ends[index])));
        this.flagsAfterEach = [];
        const live = deadFlagPass(block, this.flagsOut[index], this.flagsAfterEach,
            this.context.precise === true);
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.precise !== true)
        {
            relaxedFlagReads(block, this.relaxedReads);
        }
        const streams = this.selfLoop && !x.active && this.layout.codePages < 0
            ? planLoop(block.instructions) : null;
        if (streams !== null)
        {
            this.emitHoistedLoop(block, index, live, streams);
            return;
        }
        if (this.selfLoop)
        {
            this.openLoop(`self${index}`);
            this.loops++;
            // The loop is the block's own level: a charge at it settles the
            // block's count, so the budget exit inside it charges nothing twice.
            this.blockDepth = this.controls.length;
        }
        const plan = this.memoryPlan?.blocks[index] ?? new Map();
        if (!this.emitInstructions(block, index, live, plan))
        {
            this.closeSelfLoop();
            return;
        }
        if (this.x87.active)
        {
            // The stack words the block's plain x87 left stale, written
            // before every way out of it -- the fall-through and the loop's
            // own back edge too.
            x87BlockEnd(this);
        }
        this.emitExit(block, index);
        this.closeSelfLoop();
    }

    /**
     * A self-looping block whose accesses move by fixed strides
     * (`planLoop`), in two copies: turns whose streams' pages were tested
     * once before them run a copy with no test on those accesses, and when a
     * test finds a page not clean the checked copy runs to the loop's end.
     * The unchecked copy goes back to the test when the turns it was cleared
     * for are spent. Both copies charge, look at the budget and leave as the
     * one loop did; the checked copy is emitted first, so a block that ends
     * early (an instruction with no lowering) ends before a second copy.
     *
     * @param {import('../region.js').Block} block @param {number} index
     * @param {boolean[]} live
     * @param {{ plan: Map<number, any>, streams: import('./memory.js').Stream[],
     *     turns: number, forward: boolean }} streams
     */
    emitHoistedLoop(block, index, live, streams){
        const { b } = this;
        const last = block.instructions[block.instructions.length - 1];
        const turns = this.localTypes.length + STATE_PARAMS;
        this.localTypes.push(ValType.i32);
        const depth = this.controls.length;
        this.loops++;
        this.open(`selfDone${index}`, EMPTY);
        this.openLoop(`self${index}`);
        emitStreamWindow(this, streams.streams, streams.turns, streams.forward);
        b.op(I32.eqz);
        this.openGuard('streamsFlagged');
        // The checked copy, to the loop's end.
        this.openLoop(`checked${index}`);
        this.blockDepth = this.controls.length;
        this.blockRetired = 0;
        if (!this.emitInstructions(block, index, live, planBlock(block.instructions)))
        {
            while (this.controls.length > depth)
            {
                this.close();
            }
            this.selfLoop = false;
            return;
        }
        const backEdge = (/** @type {() => void} */ taken)=>{
            this.charge();
            this.pushBranchCondition(last);
            this.openIf('taken');
            b.localGet(Local.budget).i32const(0).op(I32.leS);
            this.openGuard('spent');
            this.exitAt(block.start, Exit.BUDGET);
            this.close();
            taken();
            this.close();
            b.br(this.depthOf(`selfDone${index}`));
        };
        backEdge(()=>b.br(this.depthOf(`checked${index}`)));
        this.close(); // checked
        this.close(); // streamsFlagged
        // The unchecked copy, for as many turns as the test cleared.
        b.i32const(streams.turns).localSet(turns);
        this.openLoop(`unchecked${index}`);
        this.blockDepth = this.controls.length;
        this.blockRetired = 0;
        this.pending = null;
        this.dead = false;
        const counted = this.instructions;
        this.emitInstructions(block, index, live, streams.plan);
        this.instructions = counted;
        backEdge(()=>{
            b.localGet(turns).i32const(1).op(I32.sub).localTee(turns);
            b.brIf(this.depthOf(`unchecked${index}`));
            b.br(this.depthOf(`self${index}`));
        });
        this.close(); // unchecked
        this.close(); // self
        this.close(); // selfDone
        this.selfLoop = false;
        const [, notTaken] = block.exit.targets;
        const next = this.region.blocks[index + 1];
        if (next && next.start === notTaken)
        {
            this.fallInto(index + 1);
            return;
        }
        this.jumpTo(notTaken);
    }

    /**
     * One more execution of the block at `start` in its profile slot: the count,
     * and the address when the slot is another block's (then marked shared).
     *
     * @param {number} start
     */
    countBlock(start){
        const { b } = this;
        const at = this.layout.tables + Tables.BLOCK_PROFILE + blockSlot(start) * Tables.BLOCK_SLOT;
        b.i32const(0).i32const(0).load('i32', { offset: at + 4 }).i32const(1).op(I32.add)
            .store('i32', { offset: at + 4 });
        b.i32const(0).load('i32', { offset: at }).i32const(start | 0).op(I32.ne);
        this.openIf('profileSlot');
        b.i32const(0).i32const(0).load('i32', { offset: at + 8 })
            .i32const(0).load('i32', { offset: at }).i32const(0).op(I32.ne).op(I32.or)
            .store('i32', { offset: at + 8 });
        b.i32const(0).i32const(start | 0).store('i32', { offset: at });
        this.close();
    }

    /**
     * The block's instructions, each under its access plan. Answers false
     * when the block ended early -- an instruction with no lowering, or one
     * that leaves unconditionally -- and nothing after it is reached.
     *
     * @param {import('../region.js').Block} block @param {number} index
     * @param {boolean[]} live @param {Map<number, any>} plan
     */
    emitInstructions(block, index, live, plan){
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.blockProfile)
        {
            this.countBlock(block.start);
        }
        for (let i = 0; i < block.instructions.length; i++)
        {
            const instruction = block.instructions[i];
            const flagsLive = live[i];
            this.flagsAfter = this.flagsAfterEach[i];
            this.current = instruction;
            this.staleCheck = false;
            this.x87RefusalReason = null;
            // Counted before it is emitted, so an exit *after* it (a halt, a
            // call) has it charged; an exit *before* it uncounts it.
            this.blockRetired++;
            this.instructions++;
            this.memPlan = plan.get(i) ?? null;
            if (this.memPlan !== null && this.memPlan.checks.length > 0)
            {
                emitGroupChecks(this, this.memPlan.checks);
            }
            const done = emitInstruction(this, instruction, flagsLive);
            if (done && this.memPlan !== null && this.memPlan.access !== null
                && !this.memPlan.used)
            {
                throw new Error(`memory plan: ${instruction.op} at ${instruction.eip.toString(16)}`
                    + ' made no access');
            }
            this.memPlan = null;
            if (!done)
            {
                this.unsupported.set(instruction.opcode,
                    (this.unsupported.get(instruction.opcode) ?? 0) + 1);
                this.noteRefusal(instruction, this.x87RefusalReason ?? 'no-lowering', index);
                this.instructions--;
                this.exitBefore(instruction.eip, Exit.UNTRANSLATED);
                this.dead = true;
                return false;
            }
            if (this.dead)
            {
                return false;
            }
            if (this.staleCheck)
            {
                // A store into a code page: leave now, before running what it
                // may have changed, with EIP at the next instruction.
                this.staleCheck = false;
                emitStaleExit(this, instruction.eip + instruction.length);
            }
        }
        return true;
    }

    /**
     * Blocks the x87 tracker reached with no known state: reached only from
     * outside the region (a call return, or a runtime entry) or from a block
     * where tracking had already stopped. Their x87 forms cannot be emitted
     * for a top the region does not know, so they get no entry of their own
     * and the runtime forms a region for them at the top the machine has.
     */
    unknownBlocks(){
        const x = this.x87;
        if (!x.active)
        {
            return [];
        }
        return x.states.flatMap((state, index)=>state === null ? [index] : []);
    }

    /**
     * Blocks compiled for the x87 stack in another shape than the region's
     * entry: another top, or registers exchanged. Reached from inside the
     * region the edge brings the stack into that shape; entered from outside
     * the machine's stack is the entry's, and the block would push, pop and
     * write the top back for a stack it does not have. No entry for them.
     */
    shapedBlocks(){
        const x = this.x87;
        if (!x.active)
        {
            return [];
        }
        // The entry's block by its address: it is the first in address order
        // only when nothing the region reaches lies below it.
        const at = this.region.blocks.findIndex(block=>block.start === this.region.entry);
        const entry = x.states[at];
        if (entry === undefined)
        {
            return [];
        }
        return x.states.flatMap((state, index)=>
            index !== at && state !== null
                && (entry === null || !sameState(state, entry)) ? [index] : []);
    }

    /** Closes the block's loop onto itself, when it is one. */
    closeSelfLoop(){
        if (this.selfLoop)
        {
            this.close();
            this.selfLoop = false;
        }
    }

    /**
     * Charges the block's instructions so far to the budget and the count.
     * On a conditional path (inside an `if` the block opened) the count stays
     * owed: the path that falls through charges it at its own exit.
     */
    charge(){
        if (this.blockRetired === 0)
        {
            return;
        }
        const { b } = this;
        b.localGet(Local.retired).i32const(this.blockRetired).op(I32.add).localSet(Local.retired);
        b.localGet(Local.budget).i32const(this.blockRetired).op(I32.sub).localSet(Local.budget);
        if (this.controls.length === this.blockDepth)
        {
            this.blockRetired = 0;
        }
    }

    /**
     * @param {import('../region.js').Block} block
     * @param {number} index
     */
    emitExit(block, index){
        const { exit } = block;
        const next = this.region.blocks[index + 1];
        switch (exit.kind)
        {
            case 'fallthrough':
                this.charge();
                if (next && next.start === exit.targets[0])
                {
                    if (this.x87.active && !x87Edge(this, index + 1))
                    {
                        // The next block is compiled for another top than the
                        // one arriving here (a region's own entry, reached by
                        // fall-through): leave before entering it.
                        this.exitAt(exit.targets[0], Exit.UNTRANSLATED);
                    }
                    else
                    {
                        this.fallInto(index + 1);
                    }
                    return;
                }
                this.jumpTo(exit.targets[0]);
                return;
            case 'jump':
                this.charge();
                this.jumpTo(exit.targets[0]);
                return;
            case 'jcc':
            case 'loop':
            {
                const [taken, notTaken] = exit.targets;
                const last = block.instructions[block.instructions.length - 1];
                this.charge();
                if (this.selfLoop)
                {
                    // The back edge directly: on the taken edge, and only
                    // there, the budget looked at as any jump does -- a
                    // leave before the decision would have the next run
                    // repeat the body past a fall-through it never took.
                    this.pushBranchCondition(last);
                    this.openIf('taken');
                    this.b.localGet(Local.budget).i32const(0).op(I32.leS);
                    this.openGuard('spent');
                    this.exitAt(block.start, Exit.BUDGET);
                    this.close();
                    this.b.br(this.depthOf(`self${index}`));
                    this.close();
                    this.closeSelfLoop();
                    if (next && next.start === notTaken)
                    {
                        this.fallInto(index + 1);
                        return;
                    }
                    this.jumpTo(notTaken);
                    return;
                }
                this.pushBranchCondition(last);
                this.openIf('taken');
                this.jumpTo(taken);
                this.close();
                if (next && next.start === notTaken)
                {
                    this.fallInto(index + 1);
                    return;
                }
                this.jumpTo(notTaken);
                return;
            }
            case 'cut':
            case 'refused':
                this.charge();
                this.exitAt(exit.next, Exit.UNTRANSLATED);
                return;
            case 'trap':
                if (this.trapped)
                {
                    // The call channel was called from here and the program
                    // went on: the block after the port write follows.
                    this.trapped = false;
                    this.charge();
                    this.jumpTo(exit.next);
                    return;
                }
                if (!this.dead)
                {
                    this.charge();
                    this.exitAt(exit.next, Exit.UNTRANSLATED);
                }
                return;
            case 'call':
                // A direct call to a block of the region: the push is done
                // and the jump is the block's. Any other left by itself.
                if (!this.dead)
                {
                    this.charge();
                    this.jumpTo(exit.targets[0]);
                }
                return;
            default:
                // ret, indirect, call, hlt, fault: the instruction's own
                // emission already left the function.
                if (!this.dead)
                {
                    this.charge();
                    this.exitAt(exit.next, Exit.UNTRANSLATED);
                }
        }
    }

    /**
     * Pushes 0/1: whether the block's last instruction branches.
     *
     * @param {import('../decode/decoder.js').Instruction} instruction
     */
    pushBranchCondition(instruction){
        const { b } = this;
        const { op } = instruction;
        if (instruction.cc !== undefined)
        {
            this.pushCondition(instruction.cc);
            return;
        }
        // loop / loope / loopne / jecxz on ecx (cx under an address-size prefix)
        const wide = !instruction.prefixes.address;
        const pushCount = ()=>{
            b.localGet(Local.reg + 1);
            if (!wide)
            {
                b.i32const(0xffff).op(I32.and);
            }
        };
        if (op === 'jecxz')
        {
            pushCount();
            b.op(I32.eqz);
            return;
        }
        // The decrement happened in the instruction's own emission.
        pushCount();
        b.i32const(0).op(I32.ne);
        if (op === 'loope' || op === 'loopne')
        {
            this.pushFlag(0x40);
            if (op === 'loopne')
            {
                b.op(I32.eqz);
            }
            b.op(I32.and);
        }
    }

    /**
     * Continues at another address: through the dispatch loop when the
     * address starts a block of this region, out of the function otherwise.
     *
     * @param {number} target
     */
    jumpTo(target){
        const { b } = this;
        const label = this.labels.get(target);
        if (label === undefined)
        {
            this.exitAt(target, Exit.UNTRANSLATED);
            return;
        }
        if (this.x87.active && !x87Edge(this, label))
        {
            // The target block is compiled for another top than the one
            // arriving here (a region's own entry, reached from a path with
            // a different top): leave, and the runtime enters it at the top
            // the machine has.
            this.exitAt(target, Exit.UNTRANSLATED);
            return;
        }
        if (label > this.blockIndex)
        {
            // A forward edge cannot close a loop: a branch out of the item that
            // holds the target, in the innermost range holding it, which is
            // still open here -- with no budget test and no trip through a
            // dispatch. A target in a loop enters the loop with its label.
            for (let k = this.ranges.length - 1; k >= 0; k--)
            {
                const range = this.ranges[k];
                const item = range.items.find(one=>one.start <= label && label <= one.end);
                if (label >= range.lo && label <= range.hi && item)
                {
                    if (item.loop)
                    {
                        b.i32const(this.labelFor(label)).localSet(Local.label);
                    }
                    b.br(this.depthOf(item.loop || this.takesFrom(label)
                        || !this.entryTested(label) ? `b${item.start}` : `p${label}`));
                    return;
                }
            }
        }
        // A backward edge is looked at against the budget: only it can close
        // a loop. To the head of a loop around this block it is a branch to
        // that loop; any other goes through the function's dispatch.
        const around = this.ranges.some(range=>range.loop && range.lo === label);
        b.localGet(Local.budget).i32const(0).op(I32.leS);
        this.openGuard('spent');
        this.exitAt(target, Exit.BUDGET);
        this.close();
        b.i32const(this.labelFor(label)).localSet(Local.label);
        b.br(this.depthOf(around ? `L${label}` : 'dispatch'));
    }

    /**
     * The label a jump from the current block into `index` goes through a
     * dispatch with: past the block's entry test when the block takes its
     * windows from this one (the labels past the blocks), its own otherwise.
     *
     * @param {number} index
     */
    labelFor(index){
        return this.takesFrom(index) ? index + this.region.blocks.length : index;
    }

    /**
     * Leaves the function with the state block complete: EIP as given, the
     * kind as given. The epilogue after `$out` does the writing back.
     *
     * @param {number} eip
     * @param {number} kind
     * @param {number} [vector]
     */
    exitAt(eip, kind, vector = 0){
        this.charge();
        this.b.i32const(eip).localSet(Local.eip);
        this.exitWithKind(kind, vector);
    }

    /**
     * Leaves before the current instruction runs: it is uncounted, EIP is
     * its own address, the state is as it was before it.
     *
     * @param {number} eip @param {number} kind @param {number} [vector]
     */
    exitBefore(eip, kind, vector = 0){
        if (kind === Exit.UNTRANSLATED && this.blockRetired === 1)
        {
            // The block's first instruction is the other executor's: the
            // block retires nothing, so it must not be an entry (see
            // `leaving`). Every untranslated exit before an instruction is
            // unconditional; a fault's is not, and a block that may fault
            // first still runs when it does not.
            this.leaving.add(this.blockIndex);
        }
        this.blockRetired--;
        this.exitAt(eip, kind, vector);
        this.blockRetired++;
    }

    /**
     * As `exitAt`, with EIP already in the `eip` local.
     * @param {number} kind @param {number} [vector]
     */
    exitDynamic(kind, vector = 0){
        this.charge();
        this.exitWithKind(kind, vector);
    }

    /** @param {number} kind @param {number} vector */
    exitWithKind(kind, vector){
        if (this.x87.active)
        {
            x87Normalise(this);
        }
        if (this.staleCheck)
        {
            // The instruction stored and leaves in the same breath (a call):
            // a store into a code page turns the exit into `stale`, the EIP
            // being the one the exit set.
            this.b.i32const(Exit.STALE).i32const(kind | vector << 8).localGet(Local.stale)
                .op(0x1b).localSet(Local.t0);
        }
        else
        {
            this.b.i32const(kind | vector << 8).localSet(Local.t0);
        }
        this.b.br(this.depthOf('out'));
    }
}

/**
 * The flags live at each block's end, over the region: the union of what its
 * successors inside the region read before they write, and all of them where
 * a way out of the block leaves the region -- the host, or another region,
 * reads the whole word. A block's own exits before its end continue the same
 * code the analysis followed, or leave at an instruction the host runs from:
 * a jump back that finds the budget spent leaves at its target, which reads
 * what it reads when the jump is taken.
 *
 * @param {import('../region.js').Block[]} blocks
 * @param {Map<number, number>} labels  the region's block starts, to their indices
 * @param {boolean} [precise]  undefined flags as the emulator leaves them (`killedBy`)
 * @returns {number[]}
 */
export function liveFlagsOut(blocks, labels, precise = true){
    const ALL = ARITH_FLAGS | DF;
    /** @type {(number[] | null)[]} the successors inside the region, null when one leaves */
    const successors = blocks.map(block=>{
        const { kind, targets, next } = block.exit;
        if (kind !== 'jump' && kind !== 'jcc' && kind !== 'loop' && kind !== 'fallthrough')
        {
            return null;
        }
        /** @type {number[]} */
        const to = [];
        for (const target of targets)
        {
            const label = labels.get(target);
            if (label === undefined)
            {
                return null;
            }
            to.push(label);
        }
        if (kind !== 'jump')
        {
            const label = labels.get(next);
            if (label === undefined)
            {
                return null;
            }
            to.push(label);
        }
        return to;
    });
    // A block's live-in is (out & ~killed) | read, what it kills and what it reads
    // before it writes taken once over its instructions -- the pass's own walk.
    const killed = blocks.map(()=>0);
    const read = blocks.map(()=>0);
    blocks.forEach((block, i)=>{
        for (let k = block.instructions.length - 1; k >= 0; k--)
        {
            const instruction = block.instructions[k];
            const count = shiftCount(instruction);
            if (count === 0)
            {
                continue;
            }
            const kills = killedBy(instruction, precise, count);
            killed[i] |= kills;
            read[i] = (read[i] & ~kills) | instruction.flagsRead;
        }
    });
    const liveIn = blocks.map(()=>0);
    const out = blocks.map(()=>ALL);
    for (let changed = true; changed;)
    {
        changed = false;
        for (let i = blocks.length - 1; i >= 0; i--)
        {
            const next = successors[i];
            out[i] = next === null ? ALL : next.reduce((flags, j)=>flags | liveIn[j], 0);
            const flags = (out[i] & ~killed[i]) | read[i];
            if (flags !== liveIn[i])
            {
                liveIn[i] = flags;
                changed = true;
            }
        }
    }
    return out;
}

/**
 * The loops of a region as wasm can hold them: each head (the target of a
 * branch back from a block at or after it) with the last block of its loop,
 * widened until any two loops are nested or apart. A loop of one block is left
 * out: the block's own loop onto itself (`selfLoop`) takes it.
 *
 * @param {import('../region.js').Block[]} blocks  in address order
 * @returns {Map<number, number>} the head's index -> the loop's last block's
 */
export function planLoops(blocks){
    const index = new Map(blocks.map((block, i)=>[block.start, i]));
    /** @type {Map<number, number>} */
    const ends = new Map();
    blocks.forEach((block, source)=>{
        const { kind, targets, next } = block.exit;
        const edges = kind === 'jump' || kind === 'call' ? [...targets]
            : kind === 'jcc' || kind === 'loop' || kind === 'fallthrough'
                ? [...targets, next] : [];
        for (const target of edges)
        {
            const head = index.get(target);
            if (head !== undefined && head < source)
            {
                ends.set(head, Math.max(ends.get(head) ?? head, source));
            }
        }
    });
    for (let changed = true; changed;)
    {
        changed = false;
        for (const [one, oneEnd] of ends)
        {
            for (const [two, twoEnd] of ends)
            {
                if (one < two && two <= oneEnd && oneEnd < twoEnd)
                {
                    ends.set(one, twoEnd);
                    changed = true;
                }
            }
        }
    }
    return ends;
}

/**
 * Which instructions of a block need their flag record: an instruction's
 * flags are needed when some flag it writes is read before the next
 * instruction that writes it -- or by whatever follows the block, which is
 * assumed to read everything.
 *
 * @param {import('../region.js').Block} block
 * @param {number} [liveOut]  the flags live after the block: all of them unless the
 *     region's own analysis (`liveFlagsOut`) says fewer
 * @param {number[]} [after]  filled with the flags live after each instruction
 * @param {boolean} [precise]  undefined flags as the emulator leaves them (`killedBy`)
 * @returns {boolean[]}  per instruction: whether its written flags are live
 */
export function deadFlagPass(block, liveOut = ARITH_FLAGS | DF, after = [], precise = true){
    const live = new Array(block.instructions.length).fill(true);
    let liveAfter = liveOut;
    for (let i = block.instructions.length - 1; i >= 0; i--)
    {
        const instruction = block.instructions[i];
        // A shift or rotate by a count of zero writes no flag at all; by a
        // count in cl it may or may not, so it kills nothing an earlier
        // record holds, though its own writes are live when read later.
        const count = shiftCount(instruction);
        after[i] = liveAfter;
        if (count === 0)
        {
            live[i] = false;
            continue;
        }
        live[i] = ((instruction.flagsWritten | instruction.flagsUndefined) & liveAfter) !== 0;
        liveAfter = (liveAfter & ~killedBy(instruction, precise, count)) | instruction.flagsRead;
    }
    return live;
}

/**
 * The flags an instruction leaves no earlier record's value in. A shift or
 * rotate by cl may write none. Precisely, only a defined write: the emulator
 * leaves an undefined flag as it was, and the emitter with it, so an earlier
 * record may still be what a later reader sees. Otherwise an undefined flag is
 * killed as well -- whatever the code left there, no program can rely on it,
 * and an `imul` in a hash loop no longer keeps the `xor` before it alive and
 * folds it every turn to leave SF, ZF, AF and PF untouched.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 * @param {boolean} precise @param {number | null} count  its `shiftCount`
 */
function killedBy(instruction, precise, count){
    if (count === -1)
    {
        return 0;
    }
    return precise ? instruction.flagsWritten & ~instruction.flagsUndefined
        : instruction.flagsWritten | instruction.flagsUndefined;
}

/**
 * By block, the blocks that go on to it -- falling through, by a conditional
 * branch or a jump -- in address order: where a guess at the record it is
 * entered with comes from.
 *
 * @param {import('../region.js').Block[]} blocks @param {Map<number, number>} labels
 * @returns {number[][]}
 */
function flowsInto(blocks, labels){
    /** @type {number[][]} */
    const into = blocks.map(()=>[]);
    blocks.forEach((block, i)=>{
        const { kind, next, targets } = block.exit;
        const to = kind === 'fallthrough' || kind === 'jcc' || kind === 'loop' ? [next, ...targets]
            : kind === 'jump' ? [targets[0]] : [];
        for (const target of to)
        {
            const label = labels.get(target);
            const list = label === undefined ? null : into[label];
            if (list !== null && list[list.length - 1] !== i)
            {
                list.push(i);
            }
        }
    });
    return into;
}

/** The kinds the instructions that leave a record of their own record, by op. */
const RECORDED = new Map([
    ['add', Kind.ADD], ['xadd', Kind.ADD], ['adc', Kind.ADC], ['sub', Kind.SUB], ['cmp', Kind.SUB],
    ['sbb', Kind.SBB], ['and', Kind.LOGIC], ['or', Kind.LOGIC], ['xor', Kind.LOGIC],
    ['test', Kind.LOGIC], ['inc', Kind.INC], ['dec', Kind.DEC], ['neg', Kind.NEG],
]);

/**
 * The record a block is expected to end with, before it is emitted: that of its
 * last instruction to write a flag, when that one leaves a record of its own.
 *
 * @param {import('../region.js').Block} block
 * @returns {{ kind: number, width: number } | null}
 */
function recordAtEnd(block){
    for (let k = block.instructions.length - 1; k >= 0; k--)
    {
        const instruction = block.instructions[k];
        if ((instruction.flagsWritten | instruction.flagsUndefined) !== 0)
        {
            const kind = RECORDED.get(instruction.op);
            return kind === undefined ? null : { kind, width: widthCode(instruction.size) };
        }
    }
    return null;
}

/**
 * Counts, by opcode, the instructions of a block that read a flag an earlier
 * one of the block left undefined: where the fast default's value of it is
 * what the program sees. A static count, of reads within a block only.
 *
 * @param {import('../region.js').Block} block @param {Map<string, number>} into
 */
function relaxedFlagReads(block, into){
    let undefinedNow = 0;
    for (const instruction of block.instructions)
    {
        if ((instruction.flagsRead & undefinedNow) !== 0)
        {
            into.set(instruction.opcode, (into.get(instruction.opcode) ?? 0) + 1);
        }
        const count = shiftCount(instruction);
        if (count === 0 || count === -1)
        {
            continue;
        }
        undefinedNow = (undefinedNow & ~instruction.flagsWritten) | instruction.flagsUndefined;
    }
}

const SHIFT_OPS = new Set(['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar', 'shld', 'shrd']);

/**
 * The count of a shift or rotate masked to five bits, -1 when it is in cl,
 * null for any other instruction.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
function shiftCount(instruction){
    if (!SHIFT_OPS.has(instruction.op))
    {
        return null;
    }
    const count = instruction.operands[instruction.operands.length - 1];
    return count.kind === 'imm' ? (/** @type {number} */ (count.value) & 31) : -1;
}

export { CF, OF, ARITH, EMPTY };
