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
 * through to the block emitted right after it does nothing at all. In a
 * structured region (the default, `planStructure`) the blocks are in the
 * order of the control flow rather than of their addresses, the region's
 * loops are wasm loops a jump back to the head branches to, and the blocks
 * inside a loop are entered from outside through a second function of their
 * copies (`emitCopies`); only other backward jumps take the dispatch. Anything
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

import { CF, DF, ARITH_FLAGS } from '../decode/table.js';
import { Body, EMPTY, ValType } from '../wasm/encoder.js';
import {
    ARITH, CARRY_IN_WORD, I32, I64, Kind, MASKS, eagerFlagsOf, emitCondition, emitFlag, kindOf,
    recordOffsets, widthCode,
} from './flags.js';
import { emitInstruction } from './integer.js';
import { copyLoopOf, emitCopyAtOnce } from './copy-loop.js';
import {
    addUndoHelper, copyPlan, emitGroupChecks, emitStaleExit, emitStreamWindow, planBlock,
    planLoop, planRegion, readsWrapped,
} from './memory.js';
import { importHelpers } from './helpers.js';
import { LONG_SCRATCH, WIDTH_32, widthOf } from './width.js';
import { atState, atTables, importBases, intoState, intoTables } from './bases.js';
import { Mechanism, Tables, blockProfileAt, blockSlot, hashSlotsOf, mechanismAt,
    pageFlagsAt, transferTargetAt }
    from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { ANY_TOP } from '../runtime/entries.js';

/** `i64.add`, the one 64-bit operation a profiling run's counts take. */
const I64_ADD = 0x7c;
const I64_EXTEND_U = 0xad;
const I64_LT_U = 0x54;
const I64_EQ = 0x51;
const I64_NE = 0x52;
import { callsOut, inlineReturns } from '../region.js';
import {
    analyseX87, floatCondition, isX87, prepareX87, sameState, x87BlockEnd, x87BlockStart,
    x87Edge, x87EntryCheck, x87Epilogue, x87LoadRegisters, x87Normalise,
    x87Prologue, x87StoreRegisters, x87DropExact, regionHasMmx,
} from './x87.js';

/**
 * The host functions a module imports for the transcendentals, by name; an
 * instantiation supplies each (`mathImports()`), from `Math`.
 */
export const MATH_IMPORTS = Object.freeze([
    'sin', 'cos', 'tan', 'atan2', 'exp2m1', 'log2', 'log1p',
]);

/**
 * Enters a region function from the host: the registers a transfer between
 * regions carries in its parameters, read from the state block, and the budget
 * written there as the one the run started with.
 *
 * @param {Function} fn  the region's function
 * @param {number} label @param {number} budget
 * @param {DataView} view  over the memory the state block is in
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {number} the exit code
 */
export function enterRegion(fn, label, budget, view, layout){
    // The reads are written out rather than put in helpers: a helper's
    // closures would be most of the garbage a call into a page left to the
    // interpreter makes, entered again once per call.
    const { regs } = layout;
    if ((layout.origin ?? -1) >= 0)
    {
        view.setInt32(/** @type {number} */ (layout.origin), budget, true);
    }
    if (layout.bits === 64)
    {
        // Long mode's carried registers: rcx, rdx, r8, r9 (`WIDTH_64`).
        return fn(label, budget,
            view.getBigInt64(regs + 8, true), view.getBigInt64(regs + 16, true),
            view.getBigInt64(regs + 64, true), view.getBigInt64(regs + 72, true));
    }
    return fn(label, budget,
        view.getInt32(regs, true), view.getInt32(regs + 4, true),
        view.getInt32(regs + 8, true), view.getInt32(regs + 12, true));
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
    UNTRANSLATED: 0, BUDGET: 1, TRAP: 2, HALT: 3, FAULT: 4, STALE: 5, INTERPRETED: 6,
    // A `ret` to the address a call made as a wasm call (`callReturn`) is waiting at:
    // the caller goes on there. The host never sees it.
    RETURNED: 7,
});

/**
 * Where a module with `callReturn` keeps the return addresses its wasm calls
 * wait at, in the executor's state page from its start (`layout.regs`), past
 * the interrupt word: a depth, then a stack of addresses. There every load and
 * store of a call and its `ret` holds its address in the instruction; in the
 * tables, a megabyte past guest RAM, arm64 built each in a register first:
 * 4 % of what Crysis's rendering code ran. Past the state block,
 * so a thread's context does not carry it: no wasm call waits when one is
 * switched.
 */
export const CallStack = Object.freeze({
    DEPTH: 2560,
    // What a returning call left of the budget, for its caller to go on with.
    BUDGET: 2564,
    STACK: 2576,
    // Deeper calls leave as any call does, so the wasm stack stays bounded: the
    // most the stack holds, and the depth a module's calls stop at unless it is
    // given a lower one (`callDepth`).
    LIMIT: 256,
});

/**
 * A guest call a block ends with, made as a wasm call (`callAndReturn`): the
 * block, the locals it wrote before the call, and whether the call may go on
 * without the transfer (`emptySites`), the block's writes carried on unstored.
 *
 * @typedef {{ block: number, written: Set<number>, empty: boolean }} CallSite
 */

/**
 * The function table's index a module with `resume` calls the interpreter tier
 * in wasm through (`Runtime.interpretWith`): until the host puts the tier's
 * entry there, a function answering 0, which leaves as a miss always did.
 */
export const TIER_SLOT = 0;
/** The tier's answer at a start with an entry (`WasmExit.ENTRY` in `interp-wasm.js`). */
export const TIER_ENTRY = 8;

/**
 * The bits of a run's MMX mark (`Local.mmxTouched`). The first MMX
 * instruction of a run sets both; an `emms` clears the hold and leaves
 * the top, so the region's exit writes the one and not the other.
 */
export const MMX_HELD = 1;
export const MMX_TOP = 2;
/**
 * Past them, from this bit, the mm registers the run wrote, one bit each:
 * what its exit stores as MMX's -- a register a region writes on another path
 * than the one taken keeps its x87 view, its exact quadword included.
 */
export const MMX_WRITTEN_SHIFT = 8;

/** Local indices every region function shares. */
export const Local = Object.freeze({
    label: 0, budget: 1,
    // 2..9: eax ecx edx ebx esp ebp esi edi
    reg: 2,
    kind: 10, res: 11, op1: 12, op2: 13, cin: 14, flags: 15,
    origin: 16, eip: 17, t0: 18, t1: 19, t2: 20, addr: 21, t64: 22, t64b: 23,
    count: 24, f0: 25, f1: 26, d0: 27, d1: 28, mmxTouched: 29,
    // the page flags of the current access, and whether a store hit a code page
    pflags: 30, stale: 31,
    // the x87 top, empty mask, status and control words, and the dirty mask
    x87Top: 32, x87Empty: 33, x87Status: 34, x87Control: 35, x87Dirty: 36,
    // 37, 38, 39: three v128 scratch locals when SIMD is available; the xmm
    // and mm locals a region uses follow, then the x87 locals, per region.
    vec: 37,
});
/**
 * The function's parameters, locals 0..5: the label and the budget, then the
 * registers a transfer between regions carries rather than writing them to the
 * state block and reading them back -- eax, ecx, edx and ebx. As many as V8
 * passes in machine registers: a seventh parameter went through the stack on
 * every call and transfer, and with seventeen a direct call and its return took
 * twice what they take with six. The other four registers, the flag record and
 * the flags word stay in the state block across a transfer, a region loading
 * the registers it names and storing the ones it writes; the budget the run
 * started with is there too (`layout.origin`), the instructions retired being
 * what the run took off the budget since, added to the counter word once, when
 * it leaves for the host. A region over a layout with no flag record (the
 * emulator's) takes the parameters and loads its state as before.
 */
export const STATE_PARAMS = 6;

/** The mark of the region's end, before its epilogue (`markBlock`). */
export const BLOCK_MARK_END = 0xfff;

/**
 * A block's mark as a diagnostic build stores it (`markBlocks`): a constant no
 * translation otherwise holds, its low twelve bits the block and the four above
 * them its copy.
 *
 * @param {number} index @param {number} copy
 */
export const blockMark = (index, copy)=>(0x6b5a0000 | (copy & 0xf) << 12 | index & 0xfff) >>> 0;
/** The registers among the parameters: eax, ecx, edx, ebx. */
export const CARRIED_REGS = STATE_PARAMS - 2;
/**
 * A region's record fields as the state block keeps them between regions:
 * each local, its offset in the record (`recordOffsets`) and whether long
 * mode's i64.
 *
 * @param {{ bits?: 32 | 64 }} layout
 */
const recordFieldsOf = layout=>{
    const offsets = recordOffsets(layout);
    const wide = layout.bits === 64;
    return [
        { local: Local.kind, offset: offsets.kind, wide: false },
        { local: Local.res, offset: offsets.res, wide },
        { local: Local.op1, offset: offsets.op1, wide },
        { local: Local.op2, offset: offsets.op2, wide },
        { local: Local.cin, offset: offsets.cin, wide: false },
    ];
};

/**
 * What a diagnostic run is told of each instruction emitted: the instruction,
 * the bytes of wasm it and the checks its memory plan placed before it took in
 * the region's body (its exits' code, written at the region's end, apart), and
 * whether it had a lowering.
 *
 * @callback ExpansionNote
 * @param {import('../decode/decoder.js').Instruction} instruction
 * @param {number} bytes
 * @param {boolean} lowered
 * @returns {void}
 */

/**
 * What a module carries that every region function in it uses.
 *
 * @typedef {Object} ModuleContext
 * @property {import('../wasm/encoder.js').ModuleBuilder} m
 * @property {import('./width.js').Width} width  the registers' (`width.js`)
 * @property {number} regionType       the function type (`STATE_PARAMS` × i32) → i32
 * @property {number} materialise      the flag helper's function index
 * @property {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @property {number} [stateBase]  under the process's shared layout, the global holding where
 *     the executor's state block is (`bases.js`)
 * @property {number} [tablesBase]  and the one holding where its tables are
 * @property {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean,
 *     armHost?: boolean }} features
 * @property {number} [undo]           the undo helper's function index, in a differential build
 * @property {boolean} [callReturn] a call out of a region is a wasm call the matching `ret`
 *     returns from (`CallStack`), where the region goes on after it
 * @property {boolean} [emptySites] with `callReturn`, such a call looks its target up in the
 *     entry hash first and does the `ret` of a function that does nothing in place
 *     (`callAndReturn`)
 * @property {boolean} [linkedCalls] with `callReturn`, a direct call reads its target's first
 *     slot of the entry hash and calls the function there itself where the transfer would
 *     at its first look (`linkedCall`); false: through the transfer
 * @property {boolean} [crossTailCalls] false: a transfer to a region of another module leaves
 *     for the host's loop rather than tail-calling into the other instance (`finishModule`)
 * @property {boolean} [flagsAcrossCalls] false, with `callReturn`: the flag record neither
 *     crosses a guest call made as a wasm call nor comes back with its `ret` -- the caller
 *     goes on with its own, as no compiler's code reads flags across a call or a return
 *     (`callAndReturn`, `returnedEpilogue`); the flags word, which holds DF, still does
 * @property {number} [callDepth] with `callReturn`, how many wasm calls may wait at once: a
 *     call made deeper leaves as any call does (`callAndReturn`); `CallStack.LIMIT` at most
 * @property {boolean} [countTransfers] each transfer through the hash adds one to the
 *     tables' transfer count (a diagnostic run)
 * @property {boolean} [blockProfile] each block counts its executions in the block
 *     profile past the tables (a diagnostic run, in a memory sized for it)
 * @property {ExpansionNote} [expansion] told each instruction's wasm bytes as it is
 *     emitted, the checks of its memory plan with it (a diagnostic run)
 * @property {boolean} [markBlocks] each block's code opens with a store of `blockMark`, which
 *     finds it in the machine code a compiler makes (`tools/cork-asm.mjs`; a diagnostic
 *     build that is never run)
 * @property {boolean} [profileCalls] an indirect call notes its address and target in the
 *     layout's call profile while the host has it on
 * @property {boolean} [flat]  every backward jump through the dispatch rather than the loops
 *     the region's structure gives
 * @property {boolean} [wide]  compiled for the wide precision controls (double, extended):
 *     no rounding to single, and a block leaves with `PRECISION` if it finds single set
 * @property {boolean} [narrow]  compiled for single precision: every rounding instruction
 *     rounds to single with no test of its own, and a block leaves with `PRECISION` if it
 *     finds another precision set
 * @property {boolean} [atomic]  locked instructions as wasm atomics (`locked.js`)
 * @property {boolean} [ordered]  with atomic, a load or store of an integer operand not
 *     through esp as a wasm atomic where its address allows (`readOp`, `writeOp`)
 * @property {boolean} [checkReads]  an instruction that only reads tests its pages too
 * @property {boolean} [precise]  every relaxation off (the runtime's `precise`): the x87
 *     exception flags, the signalling-NaN tests, the underflow test and C1 kept as the processor
 *     keeps them, the flags an instruction leaves undefined keeping the values the emulator
 *     gives them, which costs the record before it, and single precision rounded in the
 *     double's bits (`roundSingle` in `x87.js`); without it the x87 bookkeeping is not
 *     computed, an undefined flag is as the cheapest code leaves it, which no program can
 *     rely on (real processors differ there), single is rounded by Veltkamp's split, and an
 *     instruction that only reads memory is not tested against the page flags (`checkAccess`)
 * @property {boolean} [looseStacks]  a store through esp alone tests no page: no translated
 *     code lies on a thread's stack (`prepareModule`)
 * @property {number} codeHit         the helper telling whether a byte lies in translated code
 * @property {number} spanHit         whether a store to a span of bytes reaches translated code
 * @property {number} windowHit       an access group's window test (`emitGroupChecks`)
 * @property {number} [getEflags]      the host's flag fold, imported when the layout keeps
 *                                     lazy flags (the emulator's `flags_changed`)
 * @property {number} rdtsc            the host's time-stamp counter, imported by every region
 * @property {number} f80ToF64         the extended-precision readers
 * @property {number} f64ToF80
 * @property {number} round            the rounding-control helper
 * @property {number} f64ToBcd         the `fbstp` packed-BCD store
 * @property {number} x87Invalid       an x87 NaN result's IE (`addInvalidHelper`)
 * @property {number} remainder        `fprem`'s and `fprem1`'s (`addRemainderHelper`)
 * @property {Record<string, number>} math  the transcendentals imported from the host
 * @property {boolean} hash            an untranslated exit probes the entry hash and
 *                                     tail-calls the region found, through the host's table
 * @property {number} [transfer]       with hash, the module's transfer function
 *     (`finishModule`), which an untranslated exit tail-calls with its EIP for the label
 * @property {number} [resume]         with a transfer over cork's own layout, the module's
 *     function a miss of the hash tail-calls to run the interpreter tier in wasm through the
 *     table's `TIER_SLOT` (`addResume`)
 * @property {{ base: number, arms: number, crossings: number, crossedTo: number }} [placed]
 *     the globals of the module's range of the table (`base`, `arms` long, job i's function
 *     at `base + i` -- the host's `placeModule`), and of what left the range: a count and
 *     the last index
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
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean,
 *     armHost?: boolean }} features
 * @param {{ shared?: boolean, maxPages?: number }} [memory]
 * @param {{ undoLog?: boolean, hash?: boolean, trapPort?: number, leaveOut?: Set<string>,
 *     countTransfers?: boolean, wide?: boolean, narrow?: boolean, blockProfile?: boolean,
 *     structure?: boolean, precise?: boolean, place?: number, profileCalls?: boolean,
 *     resume?: boolean, callReturn?: boolean, emptySites?: boolean, linkedCalls?: boolean,
 *     looseStacks?: boolean, atomic?: boolean, ordered?: boolean, checkReads?: boolean,
 *     expansion?: ExpansionNote | null, markBlocks?: boolean, crossTailCalls?: boolean,
 *     callDepth?: number, flagsAcrossCalls?: boolean }}
 *     [options]  expansion: told every instruction's wasm bytes as it is emitted
 *     (`tools/cork-expansion.mjs`), in a diagnostic build only; markBlocks: each block
 *     marked for the machine code (`blockMark`), likewise; checkReads: an
 *     instruction that only reads tests its pages too, so a page the program cannot read
 *     faults (a reservation not committed, PAGE_NOACCESS) rather than reading RAM;
 *     atomic: locked instructions as wasm atomics (`locked.js`), for a process
 *     whose threads run on more than one executor; ordered: with atomic, the integer
 *     loads and stores not through esp as wasm atomics too, for such a process on a
 *     host that reorders plain accesses (`readOp`); looseStacks: a store through esp alone
 *     tests no page (`emitGroupChecks`), which holds while no translated code lies on a
 *     thread's stack (the runtime's
 *     `noteStack`); undoLog:
 *     record every store's old bytes (differential builds only; part of the cache key);
 *     hash: import the host's function table and transfer through the entry hash (needs
 *     tail calls); trapPort: `out dx, eax` to it leaves with a trap exit; place: with
 *     hash, the number of regions the module will hold, which the host places in a range
 *     of the table: a transfer into the range is a direct tail call, and one out of it is
 *     counted (`finishModule`); profileCalls: indirect calls note their targets in the
 *     layout's call profile, when it has one (`callProfile`); structure: a region's loops
 *     as wasm loops (`planStructure`), false for every backward jump through the dispatch;
 *     resume: with hash, under cork's own layout, a miss of the hash runs the interpreter
 *     tier in wasm through the table's `TIER_SLOT` (`finishModule`); crossTailCalls: false
 *     for an engine whose tail call into another instance faults, a transfer out of the
 *     module (all of them where it is not placed) leaving for the host's loop
 * @returns {ModuleContext}
 */
export function prepareModule(m, layout, features, memory = {},
    { undoLog = false, hash = false, trapPort, leaveOut = new Set(), countTransfers = false,
        wide = false, narrow = false, blockProfile = false, structure = true, precise = false,
        place = 0, profileCalls = false, resume = false, callReturn = false, emptySites = false,
        linkedCalls = true, looseStacks = false, atomic = false, ordered = false,
        checkReads = false, expansion = null, markBlocks = false, crossTailCalls = true,
        callDepth = CallStack.LIMIT, flagsAcrossCalls = true } = {})
{
    const width = widthOf(layout);
    // Long mode's emitter keeps the record between regions and the vector
    // scratch before its upper registers: without either it would translate
    // long-mode code with the record's paths quietly off.
    if (width.bits === 64 && ((layout.flagRecord ?? -1) < 0 || !features.simd))
    {
        throw new Error('emit: a 64-bit layout needs a flag record and SIMD');
    }
    m.importMemory('env', 'memory', {
        min: 1, ...(memory.maxPages === undefined ? {} : { max: memory.maxPages }),
        shared: memory.shared ?? false,
    });
    const bases = importBases(m, layout);
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
    /** @type {Record<string, number>} the others' types, by name */
    const types = {
        atan2: m.type({ params: [ValType.f64, ValType.f64], results: [ValType.f64] }),
    };
    /** @type {Record<string, number>} */
    const math = {};
    for (const name of MATH_IMPORTS)
    {
        math[name] = m.importFunction('env', name, types[name] ?? unary);
    }
    const regionType = m.type({
        params: [ValType.i32, ValType.i32, ...width.carried.map(()=>width.regType)],
        results: [ValType.i32],
    });
    // The helpers are one shared module every region imports, rather than a
    // copy in each; the host instantiates it once with the same memory (they
    // are defined in `./helpers.js`).
    const {
        materialise, f80ToF64, f64ToF80, round, codeHit, f64ToBcd, x87Invalid, remainder, spanHit,
        windowHit,
    } = importHelpers(m, width.bits === 64);
    /** @type {ModuleContext} */
    const context = {
        m, width, regionType, materialise, layout, features, f80ToF64, f64ToF80, round, math,
        hash: hashed, codeHit, spanHit, windowHit, f64ToBcd, x87Invalid, remainder, rdtsc,
        leaveOut, ...bases,
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
    if (callReturn && hashed && !undoLog && (layout.flagRecord ?? -1) >= 0)
    {
        context.callReturn = true;
        context.callDepth = Math.max(1, Math.min(CallStack.LIMIT, Math.trunc(callDepth)));
        // A long-mode `ret` pops a quadword, which the transfer's empty return
        // (`emptyReturn`) does not read yet.
        if (emptySites && width.bits === 32)
        {
            context.emptySites = true;
        }
        if (!linkedCalls)
        {
            context.linkedCalls = false;
        }
        if (!flagsAcrossCalls)
        {
            context.flagsAcrossCalls = false;
        }
    }
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && countTransfers)
    {
        context.countTransfers = true;
    }
    if (wide)
    {
        context.wide = true;
    }
    else if (narrow)
    {
        context.narrow = true;
    }
    if (precise)
    {
        context.precise = true;
    }
    else if (looseStacks && undoLog !== true)
    {
        context.looseStacks = true;
    }
    if (checkReads)
    {
        context.checkReads = true;
    }
    if (atomic && width.bits === 32)
    {
        context.atomic = true;
        if (ordered)
        {
            context.ordered = true;
        }
    }
    if (profileCalls && (layout.callProfile ?? -1) >= 0)
    {
        context.profileCalls = true;
    }
    if (!structure)
    {
        context.flat = true;
    }
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && blockProfile)
    {
        context.blockProfile = true;
    }
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && expansion !== null)
    {
        context.expansion = expansion;
    }
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && markBlocks)
    {
        context.markBlocks = true;
    }
    if (hashed)
    {
        // The transfer's index is taken before any region's, which call it;
        // its body waits for the module's last region (`finishModule`).
        context.transfer = m.function(regionType, [], new Uint8Array([0x00, 0x0b]));
        if (resume && (layout.flagRecord ?? -1) >= 0)
        {
            context.resume = addResume(m, layout, bases, materialise, context.transfer, width);
        }
    }
    if (hashed && !crossTailCalls)
    {
        context.crossTailCalls = false;
    }
    if (hashed && place > 0)
    {
        // The base starts where no table index minus it lands in the range,
        // so the module transfers through the table until the host places it.
        const base = m.global(ValType.i32, true, 0x80000000 | 0);
        m.exportGlobal('base', base).exportGlobal('arms', m.global(ValType.i32, false, place));
        // What left the module through the table, for the host to gather a
        // module and the one it keeps transferring into (the runtime's merges).
        const crossings = m.global(ValType.i32, true, 0);
        const crossedTo = m.global(ValType.i32, true, -1);
        m.exportGlobal('crossings', crossings).exportGlobal('crossedTo', crossedTo);
        context.placed = { base, arms: place, crossings, crossedTo };
    }
    return context;
}

/**
 * Writes the module's transfer function, once every region is in it: what an
 * untranslated exit with budget left tail-calls, with its EIP in the label's
 * place and the state the regions carry. It probes the entry hash for the EIP
 * and, on a slot compiled for this x87 top or for any, tail-calls that
 * region's function with the slot's label and the budget that remains: a
 * return, an indirect jump or a call into translated code costs no crossing.
 * A miss (an empty slot met) leaves as the region would have, the carried
 * state written back. In a placed module, job i's function is at the range's
 * start plus i, and a slot naming an index of the range is a direct tail call
 * of that job's function; one outside it goes through the table, counted.
 *
 * One function a module rather than the probe in every region: the regions
 * are the smaller -- a loading phase compiles thousands of them -- and the
 * hop into it is a direct tail call, a fraction of the indirect one.
 *
 * With `resume`, a miss tail-calls the module's resume function (`addResume`)
 * once the carried state is written back, rather than leave.
 *
 * @param {ModuleContext} context
 * @param {(number | null)[]} functions  each job's function index, null for one not emitted
 */
export function finishModule(context, functions){
    const { transfer, placed, m, regionType, layout } = context;
    if (transfer === undefined)
    {
        return;
    }
    if (placed !== undefined && functions.length !== placed.arms)
    {
        throw new Error(`emit: ${functions.length} functions for ${placed.arms} arms`);
    }
    const eip = 0; // the label's parameter, the label once the slot is found
    const index = STATE_PARAMS; // the slot's index, then the arm
    const slotAt = STATE_PARAMS + 1;
    const key = STATE_PARAMS + 2;
    const hashBase = layout.tables + Tables.HASH;
    const carried = (layout.flagRecord ?? -1) >= 0;
    const b = new Body();
    const pass = ()=>{
        for (let local = 0; local < STATE_PARAMS; local++)
        {
            b.localGet(local);
        }
    };
    b.block(EMPTY); // miss
    b.block(EMPTY); // found
    // An empty slot's key is 0, so EIP 0 -- a call through a null pointer --
    // would take the first empty slot it met for an entry.
    b.localGet(eip).op(I32.eqz).brIf(1);
    b.localGet(eip).i32const(0x9e3779b1 | 0).op(I32.mul).i32const(layout.hashShift ?? 16)
        .op(I32.shrU)
        .localSet(index);
    // The first slot before the probe's loop, which only a collision enters:
    // V8 checks the stack at every loop's head.
    const slot = (/** @type {number} */ depth)=>{
        b.localGet(index).i32const(Tables.HASH_SLOT).op(I32.mul).i32const(hashBase).op(I32.add);
        intoTables(context, b).localSet(slotAt);
        b.localGet(slotAt).load('i32').localTee(key).localGet(eip).op(I32.eq);
        b.if(EMPTY);
        // Compiled for any top, or for the one the machine has.
        b.localGet(slotAt).load('i32_8u', { offset: 10 }).localTee(key)
            .i32const(ANY_TOP).op(I32.eq);
        b.if(ValType.i32);
        b.i32const(1);
        b.else();
        b.localGet(key);
        atState(context, b).load('i32_8u', { offset: layout.x87Top }).op(I32.eq);
        b.end();
        b.brIf(depth + 1);
        b.localGet(eip).localSet(key);
        b.end();
        b.localGet(key).op(I32.eqz);
        b.brIf(depth + 1);
    };
    slot(0);
    b.loop(EMPTY);
    b.localGet(index).i32const(1).op(I32.add).i32const(hashSlotsOf(layout) - 1).op(I32.and)
        .localSet(index);
    slot(1);
    b.br(0);
    b.end(); // loop
    b.end(); // found
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && context.blockProfile)
    {
        const at = layout.tables + mechanismAt(layout, Mechanism.TRANSFER);
        atTables(context, atTables(context, b)).load('i64', { offset: at }).i64const(1n)
            .op(I64_ADD).store('i64', { offset: at });
        // And where to, by the target's slot (`blockSlot`, computed here): the
        // address, which a collision overwrites, and the count.
        b.localGet(eip).i32const(0x9e3779b1 | 0).op(I32.mul).i32const(12).op(I32.shrU)
            .i32const(Tables.TRANSFER_SLOT).op(I32.mul);
        intoTables(context, b).localTee(key);
        b.localGet(eip).store('i32', { offset: layout.tables + transferTargetAt(layout, 0) });
        b.localGet(key).localGet(key)
            .load('i32', { offset: layout.tables + transferTargetAt(layout, 0) + 4 })
            .i32const(1).op(I32.add)
            .store('i32', { offset: layout.tables + transferTargetAt(layout, 0) + 4 });
    }
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && context.countTransfers)
    {
        const at = layout.tables + Tables.TRANSFERS;
        atTables(context, atTables(context, b)).load('i32', { offset: at }).i32const(1)
            .op(I32.add).store('i32', { offset: at });
    }
    /** The registers, EIP and count written back as the region's epilogue writes them. */
    const writeBack = ()=>{
        if (!carried)
        {
            return;
        }
        // As the region's epilogue writes it (`storeCarriedState`): the
        // registers the parameters carry -- the rest, the record and the flags
        // word the region left in the block -- EIP and the count, the run's
        // budget restarting from here for a resume that goes on.
        const origin = /** @type {number} */ (layout.origin);
        const { width } = context;
        width.carried.forEach((r, i)=>{
            atState(context, b).localGet(Local.reg + i)
                .store(width.bits === 64 ? 'i64' : 'i32', { offset: layout.regs + r * width.slot });
        });
        if (layout.flagsChanged >= 0)
        {
            atState(context, b).i32const(0).store('i32', { offset: layout.flagsChanged });
        }
        storeIp(context, b, ()=>b.localGet(eip));
        atState(context, b);
        atState(context, b).load('i32', { offset: layout.counter });
        atState(context, b).load('i32', { offset: origin }).op(I32.add)
            .localGet(Local.budget).op(I32.sub);
        b.store('i32', { offset: layout.counter });
        atState(context, b).localGet(Local.budget).store('i32', { offset: origin });
    };
    /** What left the module through the table, for the runtime's merges. */
    const crossed = ()=>{
        if (placed !== undefined)
        {
            b.globalGet(placed.crossings).i32const(1).op(I32.add).globalSet(placed.crossings);
            b.localGet(slotAt).load('i32', { offset: 4 }).globalSet(placed.crossedTo);
        }
    };
    if (context.crossTailCalls === false)
    {
        // HACK until iOS ships https://github.com/WebKit/WebKit/pull/76671:
        // an engine whose tail call into another instance faults (iOS 27's
        // JavaScriptCore, WebKit bug 325447) has a region of another module
        // entered by the host's loop, as a miss is -- only not through the
        // tier's resume, which would find the region and come straight back.
        // A region of this module, placed, is still a direct tail call below.
        if (placed !== undefined)
        {
            b.localGet(slotAt).load('i32', { offset: 4 }).globalGet(placed.base).op(I32.sub)
                .i32const(placed.arms).op(I32.geU);
            b.if(EMPTY);
        }
        crossed();
        writeBack();
        b.i32const(Exit.UNTRANSLATED).return();
        if (placed !== undefined)
        {
            b.end();
        }
    }
    // Long mode's empty functions are entered as any other: their `ret` pops a
    // quadword, which `emptyReturn` does not read.
    if (carried && context.callReturn === true && context.width.bits === 32)
    {
        emptyReturn(context, b, slotAt, key);
    }
    b.localGet(slotAt).load('i32_16u', { offset: 8 }).localSet(eip);
    if (placed !== undefined)
    {
        // V8's indirect tail call costs several times a direct one, and more
        // the more modules there are.
        const { arms } = placed;
        b.localGet(slotAt).load('i32', { offset: 4 }).globalGet(placed.base).op(I32.sub)
            .localTee(index).i32const(arms).op(I32.ltU);
        b.if(EMPTY);
        b.block(EMPTY); // the table's way, for a job not emitted
        for (let i = 0; i < arms; i++)
        {
            b.block(EMPTY);
        }
        b.localGet(index);
        b.brTable(functions.map((fn, i)=>(fn === null ? arms : i)), arms);
        for (let i = 0; i < arms; i++)
        {
            b.end();
            const fn = functions[i];
            if (fn !== null)
            {
                pass();
                b.returnCall(fn);
            }
        }
        b.end(); // the table's way
        b.else();
        crossed();
        b.end();
    }
    pass();
    b.localGet(slotAt).load('i32', { offset: 4 });
    b.returnCallIndirect(regionType, 0);
    b.end(); // miss
    writeBack();
    if (context.resume !== undefined && carried)
    {
        b.localGet(Local.budget).returnCall(context.resume);
    }
    else
    {
        b.i32const(Exit.UNTRANSLATED);
    }
    m.functions[transfer - m.importedFunctions] = {
        typeIndex: regionType,
        locals: [ValType.i32, ValType.i32, ValType.i32, ValType.i32, ValType.i32],
        body: b.toBytes(), hints: b.hints,
    };
}

/**
 * EIP into the state block, and as the previous one where the layout keeps
 * it: long mode's RIP a quadword, the window's address zero-extended.
 *
 * @param {ModuleContext} context @param {Body} b @param {() => void} pushEip
 */
function storeIp(context, b, pushEip){
    const { layout } = context;
    const long = context.width.bits === 64;
    for (const offset of layout.previousIp >= 0 ? [layout.eip, layout.previousIp] : [layout.eip])
    {
        atState(context, b);
        pushEip();
        if (long)
        {
            b.op(I64_EXTEND_U).store('i64', { offset });
        }
        else
        {
            b.store('i32', { offset });
        }
    }
}

/**
 * In the transfer, at a slot whose entry is a function that does nothing (`emptyCode`, the
 * slot's byte 11): that function's `ret`, done here when it returns to the wasm call waiting
 * at the top of the call stack (`callAndReturn`) -- the return address the call pushed read
 * back from the guest's stack, on pages the program can read, and found to be the one the
 * call waits at. Then as `returnToCall` and `returnToCaller` leave it: the call taken off the
 * stack, `esp` past the address and the bytes the `ret` pops, the registers the parameters
 * carry in the state block beside the rest the caller left there, and the budget less the
 * instructions run (the jumps and the `ret`) where the caller reads it. The flags, the x87
 * and the memory are as the call left them, as the function would leave them. A `ret` to
 * anywhere else -- a jump into the function, a return address rewritten -- enters the region
 * as before.
 *
 * @param {ModuleContext} context @param {Body} b @param {number} slotAt @param {number} code
 */
function emptyReturn(context, b, slotAt, code){
    const { layout } = context;
    const esp = STATE_PARAMS + 3;
    const depth = STATE_PARAMS + 4;
    const flags = pageFlagsAt(layout);
    b.localGet(slotAt).load('i32_8u', { offset: 11 }).localTee(code);
    b.if(EMPTY);
    atState(context, b).load('i32', { offset: layout.regs + CallStack.DEPTH }).localTee(depth);
    b.if(EMPTY);
    atState(context, b).load('i32', { offset: layout.regs + 16 }).localTee(esp);
    b.i32const(12).op(I32.shrU).load('i32_8u', { offset: flags });
    b.localGet(esp).i32const(3).op(I32.add).i32const(12).op(I32.shrU)
        .load('i32_8u', { offset: flags });
    b.op(I32.or).i32const(PageFlag.INACCESSIBLE).op(I32.and).op(I32.eqz);
    b.if(EMPTY);
    b.localGet(depth).i32const(2).op(I32.shl);
    intoState(context, b).load('i32', { offset: layout.regs + CallStack.STACK - 4 })
        .localGet(esp).load('i32', { offset: layout.ramBase }).op(I32.eq);
    b.if(EMPTY);
    if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && context.blockProfile)
    {
        const at = layout.tables + mechanismAt(layout, Mechanism.EMPTY_RETURN);
        atTables(context, atTables(context, b)).load('i64', { offset: at }).i64const(1n)
            .op(I64_ADD).store('i64', { offset: at });
    }
    atState(context, b).localGet(depth).i32const(1).op(I32.sub)
        .store('i32', { offset: layout.regs + CallStack.DEPTH });
    // The low six bits are the dwords popped plus one: the return address's and the rest.
    atState(context, b).localGet(esp).localGet(code).i32const(63).op(I32.and).i32const(2)
        .op(I32.shl).op(I32.add).store('i32', { offset: layout.regs + 16 });
    for (let r = 0; r < CARRIED_REGS; r++)
    {
        atState(context, b).localGet(Local.reg + r).store('i32', { offset: layout.regs + r * 4 });
    }
    atState(context, b).localGet(Local.budget).localGet(code).i32const(6).op(I32.shrU)
        .i32const(1).op(I32.add).op(I32.sub)
        .store('i32', { offset: layout.regs + CallStack.BUDGET });
    b.i32const(Exit.RETURNED).return();
    b.end();
    b.end();
    b.end();
    b.end();
}

/**
 * The function a module's transfer tail-calls on a miss of the hash, with the
 * budget left, the state written back into the block: it runs the interpreter
 * tier in wasm in place of leaving, through the table's `TIER_SLOT` -- the flag
 * record folded into the word the tier reads, the tier run from EIP -- and where
 * the tier stops at a start with an entry it tail-calls the transfer with the
 * state the block holds, charged what the tier retired, to probe for it.
 * Anything else the tier stops for -- a hot start, a trap, a fault, a store into
 * code, an instruction it leaves, the budget -- leaves with `INTERPRETED` and the
 * tier's code, for the host to answer as it answers the tier's own runs; the
 * slot's function before the host installs the tier answers 0, a miss as
 * before. A function of its own rather than code in the transfer, which every
 * transfer runs through: a call there, taken or not, slowed the transfers of
 * cork-bench's calls workloads.
 *
 * @param {import('../wasm/encoder.js').ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {import('./bases.js').Bases} bases
 * @param {number} materialise @param {number} transfer
 * @param {import('./width.js').Width} [width]
 * @returns {number} the function's index
 */
function addResume(m, layout, bases, materialise, transfer, width = WIDTH_32){
    const record = /** @type {number} */ (layout.flagRecord);
    const [budget, code, left] = [0, 1, 2];
    const tierType = m.type({ params: [ValType.i32], results: [ValType.i32] });
    const b = new Body();
    // The record folded into the word, as `eflagsOf` folds it for the tier's own runs:
    // the kind, the result, the operands and the carry in, long mode's quadwords.
    const at = recordOffsets(layout);
    const value = width.bits === 64 ? 'i64' : 'i32';
    atState(bases, b).load('i32', { offset: record + at.kind }).localTee(code);
    b.if(EMPTY);
    atState(bases, b).localGet(code);
    for (const field of [at.res, at.op1, at.op2])
    {
        atState(bases, b).load(value, { offset: record + field });
    }
    atState(bases, b).load('i32', { offset: record + at.cin });
    atState(bases, b).load('i32', { offset: layout.eflags });
    b.call(materialise).store('i32', { offset: layout.eflags });
    atState(bases, b).i32const(0).store('i32', { offset: record });
    b.end();
    b.localGet(budget).i32const(TIER_SLOT).callIndirect(tierType, 0).localTee(code);
    b.op(I32.eqz);
    b.if(EMPTY);
    b.i32const(Exit.UNTRANSLATED).return();
    b.end();
    // What remains of the budget, where the tier stopped at an entry.
    b.localGet(budget).localGet(code).i32const(8).op(I32.shrU).op(I32.sub).localSet(left);
    b.localGet(code).i32const(0xff).op(I32.and).i32const(TIER_ENTRY).op(I32.eq)
        .localGet(left).i32const(0).op(I32.gtS).op(I32.and);
    b.if(EMPTY);
    // The run goes on from what is left, counted from here.
    atState(bases, b).localGet(left)
        .store('i32', { offset: /** @type {number} */ (layout.origin) });
    atState(bases, b).load('i32', { offset: layout.eip });
    b.localGet(left);
    for (const r of width.carried)
    {
        atState(bases, b).load(value, { offset: layout.regs + r * width.slot });
    }
    b.returnCall(transfer);
    b.end();
    b.localGet(code).i32const(0xff).op(I32.and).i32const(8).op(I32.shl)
        .i32const(Exit.INTERPRETED).op(I32.or);
    return m.function(tierType, [ValType.i32, ValType.i32], b.toBytes());
}

/**
 * @typedef {Object} Translation
 * @property {number} functionIndex
 * @property {number} copiesIndex   the function of the copies of a structured region's blocks
 *     inside its loops (`emitCopies`), which the region's own calls, or -1
 * @property {Map<number, number>} labels     block start eip → label
 * @property {Map<string, number>} unsupported  opcode → instructions the emitter left out
 * @property {Map<string, number>} refusals  `opcode (reason; entry kinds; entry x87)` → count
 * @property {Map<string, number>} relaxedReads  by opcode, the instructions that read a flag an
 *     instruction before them in their block left undefined, outside `precise`: what a program
 *     sees there is the fast default's (`relaxedFlagReads`)
 * @property {number} instructions
 * @property {Set<number>} cut      labels of blocks with no entry of their own: ones that
 *     leave at once (an x87 state conflict, nothing decoded, the first instruction left out),
 *     ones compiled for the x87 stack in another shape than the entry's, and the `closed`
 * @property {Set<number>} closed   the starts of the blocks inside a structured region's
 *     loops that have no entry, the region emitted without copies (`emitRegion`)
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
 * @param {{ entryTop?: number, checked?: boolean, copies?: boolean,
 *     precision?: X87Precision, floats?: boolean }} [options]  the x87 top the entry is
 *     compiled for; checked: the entries test nothing of the x87 stack's shape (`planStack`);
 *     copies: a structured region's blocks inside its loops are entered through copies of
 *     them (`emitCopies`) -- false, they have no entry (`closed`); precision: the precision
 *     control its x87 is compiled for, the module's (`prepareModule`'s wide and narrow) by
 *     default; floats: compiled for single, its arithmetic on floats in f32 (`Singles` in
 *     x87.js)
 * @returns {Translation}
 */
export function emitRegion(context, region, options = {}){
    const emitter = new RegionEmitter(context, region, options);
    return emitter.emit();
}

/**
 * What a region's function plans of the region before it emits, a pure
 * function of the formed region, the module's options and the x87 top and
 * `checked` it is compiled for -- so the same for the function of its copies,
 * which takes it (`emitCopies`). Nothing of it is written while emitting but
 * the access plan's `used` marks, which the copies take a copy of.
 *
 * @typedef {Object} RegionPlanning
 * @property {Map<number, number[]>} returns  by ret block, the return addresses it jumps to
 * @property {ReturnType<typeof planStructure> | null} structure
 * @property {import('../region.js').Region} region  in its emitting order
 * @property {import('./x87.js').X87Analysis} x87
 * @property {number[]} flagsOut  the flags live at each block's end
 * @property {import('./memory.js').RegionPlan | null} memoryPlan  the access groups
 */

/**
 * The precision control a region's x87 arithmetic is compiled for: `wide` (double or
 * extended, nothing rounded; a block leaves at its first rounding instruction when single is
 * set), `narrow` (single, every result rounded; leaves when another is set) or `mixed` (a
 * test at every rounding instruction).
 *
 * @typedef {'wide' | 'narrow' | 'mixed'} X87Precision
 */

/** The state the emitter keeps while writing one function. */
export class RegionEmitter {
    /**
     * @param {ModuleContext} context
     * @param {import('../region.js').Region} region
     * @param {{ entryTop?: number, checked?: boolean, copies?: boolean,
     *     precision?: X87Precision, floats?: boolean, copyFunction?: boolean,
     *     planned?: RegionPlanning | null }} [options]  copies, precision and floats: as
     *     `emitRegion` takes them; copyFunction: this is the function of a structured region's
     *     copies (`emitCopies`); planned: what the region's own function planned of it, which
     *     the function of its copies takes rather than plan it again
     */
    constructor(context, region,
        { entryTop = 0, checked = false, copies = true, copyFunction = false,
            planned = null, precision = context.wide === true ? 'wide'
                : context.narrow === true ? 'narrow' : 'mixed', floats = false } = {})
    {
        this.context = context;
        /** The region as formed, and the options, for the function of its copies. */
        this.formed = region;
        this.options = { entryTop, checked, precision, floats };
        /** Its x87 compiled for the wide precision controls, or for single (`X87Precision`). */
        this.wide = precision === 'wide';
        this.narrow = precision === 'narrow';
        /** Compiled for single with its arithmetic on floats in f32 (`Singles` in x87.js). */
        this.floats = this.narrow && floats;
        this.copyFunction = copyFunction;
        this.layout = context.layout;
        /** The registers' width (`width.js`). */
        this.width = context.width ?? WIDTH_32;
        /** Where the layout keeps the flag record between regions, or -1. */
        this.flagRecord = context.layout.flagRecord ?? -1;
        /** The record's fields there. */
        this.recordFields = recordFieldsOf(context.layout);
        /** What the function of the region's copies takes of this one's planning. */
        this.planned = planned;
        /** By ret block: the return addresses it jumps to rather than leaves by. */
        this.returns = planned?.returns ?? inlineReturns(region);
        /** A call out of this region is a wasm call it goes on after: no MMX state
         * to carry across one (the x87 stack goes through the state block). */
        this.callReturn = context.callReturn === true
            && !regionHasMmx(region, context.leaveOut ?? new Set());
        /** Whether the block's call returned here and went on. */
        this.returned = false;
        /** Whether a `ret` returns to a waiting call through `returnedEpilogue`. */
        this.returnsToCall = false;
        /** The emitting order and its loops, in a structured region (`planStructure`). */
        this.structure = planned !== null ? planned.structure
            : context.flat === true ? null
                : planStructure(region, this.returns, this.callReturn);
        // A structured region's blocks in the order they are emitted, which
        // is their labels' order too.
        this.region = planned?.region ?? (this.structure === null
            || this.structure.order.every((at, k)=>at === k)
            ? region : { ...region, blocks: this.structure.order.map(at=>region.blocks[at]) });
        /** The planning of the region's x87 (`analyseX87`). */
        this.x87Plan = planned !== null ? planned.x87
            : analyseX87(this.region, context.leaveOut, entryTop, checked, this.callReturn);
        // Room for what a region's code comes to, a good sixteen bytes of wasm
        // for each of its bytes, rather than doubling up to it.
        this.b = new Body(Math.min(1 << 16, 2 ** Math.ceil(Math.log2(Math.max(64,
            (region.bytes ?? 0) * 16)))));
        /** @type {Map<number, number>} */
        this.labels = new Map(this.region.blocks.map((block, index)=>[block.start, index]));
        /** @type {string[]} the open control labels, innermost last */
        this.controls = [];
        /** @type {Map<string, number[]>} by label, where in `controls` it is open */
        this.openAt = new Map();
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
        /**
         * By block, the locals its code writes, every copy of it in this function
         * together: what a path through it leaves out of step with the state block.
         * @type {(Set<number> | undefined)[]}
         */
        this.blockWrites = [];
        /**
         * By block, the guest call it ends with as a wasm call (`callAndReturn`):
         * the locals the block wrote before the call, and whether the call may go
         * on past the target without the transfer -- a function that does nothing,
         * returned from in place -- carrying them on unstored.
         * @type {Map<number, CallSite>}
         */
        this.callSites = new Map();
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
        /** The flags live at each block's start, what a way out to it hands on. @type {number[]} */
        this.flagsIn = [];
        /** The flags live after each instruction of the block being emitted. @type {number[]} */
        this.flagsAfterEach = [];
        /** The instruction of the block being emitted, by its place in the block; -1 between. */
        this.at = -1;
        /** The instruction `flagsAfter` is of. @type {import('../decode/decoder.js').Instruction | null} */
        this.flagsAfterOf = null;
        /** The flags live after the instruction being emitted. */
        this.flagsAfter = ARITH_FLAGS | DF;
        /**
         * A float compare of the current block whose flags only its final
         * branch reads (`fusesCompare`): the branch compares the operands, held
         * in these locals, and the flags are never made.
         * @type {import('./x87.js').FloatCompare | null}
         */
        this.fcmp = null;
        /**
         * Whether the instruction being emitted is a `cmp` the block's final
         * conditional branch alone reads (`oweResult`).
         */
        this.owesResult = false;
        /**
         * The width of a `cmp` whose record has its kind and operands and not
         * yet its result (`oweResult`), null when the record is whole.
         * @type {number | null}
         */
        this.resultOwed = null;
        /** Branches that compared a float compare's operands themselves, for the tests. */
        this.fusedCompares = 0;
        /** By block, the blocks whose way on goes there, in order, once a guess needs them.
         * @type {number[][] | null} */
        this.flowsInto = null;
        /** Each loop head's last block (`planStructure`). @type {Map<number, number>} */
        this.loopEnds = this.structure?.loops ?? new Map();
        /**
         * The blocks inside a loop other than a loop's head, in order, each
         * emitted twice: in its loop, and as a copy in a function of the
         * copies that the runtime enters it by (`emitCopies`).
         * @type {number[]}
         */
        this.copies = [];
        /** The heads of the loops that hold loops, whose head takes an entry into one. @type {Set<number>} */
        this.entered = new Set();
        for (const [lo, hi] of this.loopEnds)
        {
            for (let at = lo + 1; at <= hi; at++)
            {
                if (this.loopEnds.has(at))
                {
                    this.entered.add(lo);
                }
                else
                {
                    this.copies.push(at);
                }
            }
        }
        this.copies = [...new Set(this.copies)].sort((a, b)=>a - b);
        /** Every block inside a loop but a loop's head, copied or not. */
        this.interior = new Set(this.copies);
        /** Those with no entry, the region emitted without copies. @type {number[]} */
        this.closed = [];
        // A predicted call's return inside a loop comes back from outside
        // whenever the call goes elsewhere: such a region has its copies from
        // the start.
        const reentered = new Set((this.structure?.reentered ?? [])
            .map(at=>this.region.blocks.indexOf(region.blocks[at])));
        if (!copies && !copyFunction && !this.copies.some(at=>reentered.has(at)))
        {
            this.closed = this.copies;
            this.copies = [];
        }
        /** Each copied block's place among the copies. @type {Map<number, number>} */
        this.copyIndex = new Map(this.copies.map((at, k)=>[at, k]));
        /** The function of the copies, once emitted (`emitCopies`). */
        this.copiesIndex = -1;
        /** Whether the block being emitted is a copy, and which. */
        this.copying = false;
        this.copyAt = -1;
        /** The block emitted before this one, whose record's kind a guess may take. */
        this.lastEmitted = -1;
        /** The ranges being emitted, innermost last (`emitRange`).
         * @type {{ lo: number, hi: number, loop: boolean,
         *     items: { start: number, end: number, loop: boolean, copy?: boolean }[] }[]} */
        this.ranges = [];
        /** Whether the current block's remaining instructions are unreachable. */
        this.dead = false;
        /**
         * The read `prepare` last made off a wrapped sum its block's other reads
         * share (`wrappedFirst` in integer.js): the operand, the local holding
         * the sum and what the operand's displacement adds to it, for the load to
         * take as its offset. `addr` holds the whole address all the same.
         * @type {{ operand: object, local: number, offset: number } | null}
         */
        this.folded = null;
        /** The i32 local `folded` sums are kept in, -1 until made. */
        this.sumLocal = -1;
        /** Instructions retired in the current block so far, to charge at its end. */
        this.blockRetired = 0;
        /** Each block's marks made so far, in a build that marks them (`markBlock`).
         * @type {Map<number, number> | null} */
        this.marksMade = null;
        this.instructions = 0;
        // The vector registers the region touches, found by a scan, each given
        // a local: loaded in the prologue, and written back when written.
        /** @type {Map<number, number>} xmm index -> local */
        this.xmmLocals = new Map();
        /** @type {Map<number, number>} mm index -> local */
        this.mmLocals = new Map();
        /** @type {Set<number>} */
        this.xmmWritten = new Set();
        /**
         * The xmm registers whose low lane a scalar float form left in a local
         * of its own as well (`setLow` in simd.js), for the next scalar form
         * to read with no lane taken out of the vector: held within a block's
         * straight line, forgotten at any other write of the register.
         * @type {Map<number, { local: number, double: boolean }>}
         */
        this.lows = new Map();
        /** Those locals, one an xmm register and width. @type {Map<string, number>} */
        this.lowLocals = new Map();
        /**
         * The xmm registers whose low lane only their `lows` local holds yet,
         * the vector's own lane behind it: put back (`settleLows`) where the
         * vector is read, at the block's end and on every way out. 'zero': the
         * other lanes are zero too (a scalar load wrote the register).
         * @type {Map<number, 'replace' | 'zero'>}
         */
        this.pendingLows = new Map();
        /** @type {Set<number>} */
        this.mmWritten = new Set();
        /** The instruction being emitted. @type {import('../decode/decoder.js').Instruction} */
        this.current = region.blocks[0].instructions[0];
        /** A store was emitted for the current instruction: check `stale` after it. */
        this.staleCheck = false;
        /** The control depth at the start of the block being emitted. */
        this.blockDepth = 0;
        /** @type {number[]} */
        this.localTypes = [...this.width.locals];
        /** The ordered variant's store value (`orderedLocal`), -1 until made. */
        this.orderedValue = -1;
        this.entryTop = entryTop;
        // A region that translates both classes keeps the eight registers as one
        // set with two views, so every register needs an mm local (the mantissa)
        // beside its x87 local (the value): an exchange or a write of either
        // class moves the other's, and a register only one class touches is
        // still written back in the form the other left it. Allocate all eight
        // mm locals there; elsewhere only the operands'.
        const mixed = context.features.simd && this.x87Plan !== null && this.x87Plan.hasMmx;
        if (context.features.simd)
        {
            this.localTypes.push(ValType.v128, ValType.v128, ValType.v128, ...this.width.upper);
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
        this.x87 = prepareX87(this, entryTop, checked, this.x87Plan);
        /**
         * Where the registers' loads and stores go, filled once the body is
         * written and the locals it uses are known (`fillDeferred`): the
         * integer registers, the x87 ones, or both. `regs`: every register the
         * body names (`all`), only the ones the parameters do not carry
         * (`uncarried`), or none. `site`: a guest call's stores, which leave out
         * what the state block already holds (`fillDeferred`). `record`: the flag
         * record's fields and the flags word too, under cork's layout (`true`), or
         * the flags word alone (`word`, `flagsAcrossCalls` off).
         * @type {{ at: number, kind: 'load' | 'store', regs: 'all' | 'uncarried' | 'none',
         *     x87: boolean, site?: CallSite, record?: true | 'word' }[]}
         */
        this.deferred = [];
    }

    /** The local an xmm register lives in. @param {number} index @param {boolean} [write] */
    xmmLocal(index, write = false){
        if (this.pendingLows.has(index))
        {
            // The vector read or written as a whole: its lane put back first.
            // Inside a branch only that way has it, so the lane stays owed.
            if (write && this.controls.length !== this.blockDepth)
            {
                throw new Error(`xmm${index} written in a branch while its low lane is owed`);
            }
            this.settleLows([index], this.controls.length === this.blockDepth);
        }
        if (write)
        {
            this.xmmWritten.add(index);
            this.lows.delete(index);
        }
        return /** @type {number} */ (this.xmmLocals.get(index));
    }

    /**
     * Puts the owed low lanes (`pendingLows`) of these registers back into
     * their vectors, here; `clear`: where every later way through has them
     * (the block's straight line), so they are no longer owed.
     *
     * @param {Iterable<number>} indices @param {boolean} clear
     */
    settleLows(indices, clear){
        const { b } = this;
        for (const index of [...indices])
        {
            const how = this.pendingLows.get(index);
            const low = this.lows.get(index);
            if (how === undefined || low === undefined)
            {
                continue;
            }
            const vector = /** @type {number} */ (this.xmmLocals.get(index));
            if (how === 'zero')
            {
                b.v128const(new Array(16).fill(0));
            }
            else
            {
                b.localGet(vector);
            }
            // f64x2.replace_lane / f32x4.replace_lane
            b.localGet(low.local).op(0xfd, [low.double ? 0x22 : 0x20, 0]).localSet(vector);
            if (clear)
            {
                this.pendingLows.delete(index);
            }
        }
    }

    /** The i32 local a read's wrapped sum is kept in (`folded`). */
    foldedSumLocal(){
        if (this.sumLocal < 0)
        {
            this.sumLocal = this.localTypes.length + STATE_PARAMS;
            this.localTypes.push(ValType.i32);
        }
        return this.sumLocal;
    }

    /**
     * The scalar local an xmm register's low lane is held in (`lows`).
     *
     * @param {number} index @param {boolean} double
     */
    lowLocal(index, double){
        const key = `${index}${double ? 'd' : 's'}`;
        let local = this.lowLocals.get(key);
        if (local === undefined)
        {
            local = this.localTypes.length + STATE_PARAMS;
            this.localTypes.push(double ? ValType.f64 : ValType.f32);
            this.lowLocals.set(key, local);
        }
        return local;
    }

    /** The local an mm register lives in. @param {number} index @param {boolean} [write] */
    mmLocal(index, write = false){
        if (write)
        {
            this.mmWritten.add(index);
        }
        return /** @type {number} */ (this.mmLocals.get(index));
    }

    /**
     * The local the ordered variant holds a store's value in (`writeOp`), made
     * at its first store: a region of the other variants has none.
     */
    orderedLocal(){
        if (this.orderedValue < 0)
        {
            this.orderedValue = this.localTypes.length + STATE_PARAMS;
            this.localTypes.push(ValType.i32);
        }
        return this.orderedValue;
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
            flags: Local.flags, ...this.width.bits === 64 ? { wide: true } : {},
        };
    }

    /** @returns {Translation} */
    emit(){
        const { b } = this;
        const blocks = this.region.blocks;
        const flat = this.structure === null;
        const { planned } = this;
        const flagsOut = planned?.flagsOut
            ?? liveFlagsOut(blocks, this.labels, this.context.precise === true);
        // The other executor's code table in a hybrid layout is a second
        // thing a store is noted against: that layout tests each access. A
        // jump back carries windows only through the flat dispatch; a block
        // the x87 plan cuts runs nothing to take them for.
        const memoryPlan = planned !== null ? planned.memoryPlan
            : this.layout.codePages < 0
                ? planRegion(blocks, { entry: this.region.entry, backward: flat,
                    heads: new Set([...this.loopEnds.keys(), ...this.x87.cut]),
                    returns: this.returns, masked: readsWrapped(this.context),
                    long: this.width.bits === 64 })
                : null;
        this.flagsIn = blocks.map((block, i)=>block.instructions.reduceRight((live, instruction)=>
            liveBefore(instruction, live, this.context.precise === true), flagsOut[i]));
        if (this.copies.length > 0 && !this.copyFunction)
        {
            this.emitCopies(flagsOut, memoryPlan);
        }
        this.prologue();
        // A `ret` back to the call waiting for it leaves through an epilogue of
        // its own after the one every other exit shares (`returnToCaller`): its
        // stores written once there, not in the loop's body at every `ret`, where
        // they cost a hot loop of a function that ends in one its registers
        // (long mode's: vm 2.2x slower with them inline; 32-bit code keeps them).
        this.returnsToCall = this.context.callReturn === true && this.width.bits === 64
            && blocks.some(block=>block.instructions.at(-1)?.op === 'ret');
        if (this.returnsToCall)
        {
            this.open('returned', EMPTY);
        }
        this.open('out', EMPTY);
        if (this.x87.active)
        {
            x87EntryCheck(this);
        }
        this.openLoop('dispatch');
        this.flowsInto = null;
        this.flagsOut = flagsOut;
        this.memoryPlan = memoryPlan;
        this.ranges = [];
        this.emitRange(0, blocks.length - 1, false);
        // Falling out of the last block cannot happen: every block ends with
        // explicit control. If it did, the dispatch would loop on the same
        // label forever, so leave instead.
        b.unreachable();
        this.close(); // dispatch
        this.close(); // out
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.markBlocks)
        {
            this.markBlock(BLOCK_MARK_END);
        }
        this.epilogue();
        if (this.returnsToCall)
        {
            b.return();
            this.close(); // returned
            this.returnedEpilogue();
        }
        this.fillDeferred();
        const functionIndex = this.context.m.function(
            this.context.regionType, this.localTypes, b.toBytes(), { hints: b.hints });
        return {
            functionIndex, copiesIndex: this.copiesIndex,
            labels: new Map([...this.labels].map(([start, at])=>[start, this.entryLabel(at)])),
            unsupported: this.unsupported, refusals: this.refusals, relaxedReads: this.relaxedReads,
            instructions: this.instructions,
            cut: new Set([...this.x87.cut, ...this.unknownBlocks(), ...this.leaving,
                ...this.shapedBlocks(), ...this.closed].map(at=>this.entryLabel(at))),
            closed: new Set(this.closed.map(at=>this.region.blocks[at].start)),
            entryTop: this.entryTop, loops: this.loops, x87Guards: this.x87.guards,
            x87RelaxedReads: this.x87.relaxedReads, fusedCompares: this.fusedCompares,
            folds: this.folds,
        };
    }

    // --- control structure bookkeeping ---

    /**
     * A control onto the stack of open ones, and onto its name's own stack of
     * places: a region of a hundred blocks keeps a hundred open, and a branch's
     * depth by a search of the names was a quadratic share of emitting.
     *
     * @param {string} name
     */
    push(name){
        let places = this.openAt.get(name);
        if (places === undefined)
        {
            places = [];
            this.openAt.set(name, places);
        }
        places.push(this.controls.length);
        this.controls.push(name);
    }

    /** @param {string} name @param {number} type */
    open(name, type){
        this.push(name);
        this.b.block(type);
    }

    /** @param {string} name */
    openLoop(name){
        this.push(name);
        this.b.loop(EMPTY);
    }

    /** @param {string} name @param {number} type */
    openIf(name, type = EMPTY){
        this.push(name);
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
        this.push(name);
        this.b.unlikely().if(type);
    }

    close(){
        const name = this.controls.pop();
        if (name !== undefined)
        {
            this.openAt.get(name)?.pop();
        }
        this.b.end();
    }

    /** The branch depth of an open control by name. @param {string} name */
    depthOf(name){
        const places = this.openAt.get(name);
        if (places === undefined || places.length === 0)
        {
            throw new Error(`emit: no open control "${name}"`);
        }
        return this.controls.length - 1 - places[places.length - 1];
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
     * locals. `fromParams`: eax to ebx came in as parameters (cork's layout,
     * on entry), so only the other registers are loaded. `afterCall`: back
     * from a guest call's wasm call, where with `flagsAcrossCalls` off the
     * record stays the caller's own.
     *
     * @param {boolean} [fromParams] @param {boolean} [afterCall]
     */
    loadState(fromParams = false, afterCall = false){
        const { b, layout, context } = this;
        if (this.flagRecord >= 0)
        {
            // The record the last region left, as it left it: its kind is not
            // known here, and a read folds it only when it must. Like the
            // registers, each field and the flags word only where the body
            // reads it (`fillDeferred`).
            this.deferred.push({ at: b.length, kind: 'load', regs: 'none', x87: false,
                record: afterCall && this.context.flagsAcrossCalls === false ? 'word' : true });
            this.pending = null;
        }
        else
        {
            atState(context, b).load('i32', { offset: layout.eflags }).localSet(Local.flags);
        }
        if (layout.flagsChanged >= 0 && this.context.getEflags !== undefined)
        {
            // The other executor keeps some flags lazy: when its record says
            // so, its own fold gives the whole word.
            atState(context, b).load('i32', { offset: layout.flagsChanged });
            this.openIf('lazy', EMPTY);
            b.call(this.context.getEflags).localSet(Local.flags);
            this.close();
        }
        for (const [index, local] of this.xmmLocals)
        {
            atState(context, b).loadV128({ offset: layout.xmm + index * 16 }).localSet(local);
        }
        for (const [index, local] of this.mmLocals)
        {
            atState(context, b).load('i64', { offset: layout.x87 + index * 16 }).localSet(local);
        }
        if (this.x87.active)
        {
            x87Prologue(this);
        }
        // The registers, after the x87 empty mask they are loaded under: on
        // entry under cork's layout the ones the parameters did not bring.
        this.deferred.push({ at: b.length, kind: 'load', regs: fromParams ? 'uncarried' : 'all',
            x87: true });
    }

    /**
     * The run's own locals at their start: no record, nothing retired, nothing
     * touched. `fromParams`: the budget the run started with came in as a
     * parameter and goes on.
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
            b.localGet(Local.budget).localSet(Local.origin);
            if (this.flagRecord >= 0)
            {
                atState(this.context, b).localGet(Local.budget)
                    .store('i32', { offset: /** @type {number} */ (this.layout.origin) });
            }
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
        if (this.pendingLows.size > 0)
        {
            // Every way here put its lanes back; one put back here would be any way's.
            throw new Error('low lanes owed at the epilogue');
        }
        if (this.flagRecord >= 0 && this.context.hash)
        {
            this.storeMemoryState();
            this.storeUncarriedState();
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
        const { b, layout, context } = this;
        if (this.flagRecord >= 0)
        {
            // The record goes as it is: the helper at every exit would be a
            // fifth of a call-heavy loop, and the next region mostly writes the
            // flags before it reads them. Whoever reads the word folds it.
            this.deferred.push({ at: b.length, kind: 'store', regs: 'all', x87: false,
                record: true });
        }
        else
        {
            this.materialise();
            this.deferred.push({ at: b.length, kind: 'store', regs: 'all', x87: false });
            atState(context, b).localGet(Local.flags).store('i32', { offset: layout.eflags });
        }
        if (layout.flagsChanged >= 0)
        {
            atState(context, b).i32const(0).store('i32', { offset: layout.flagsChanged });
        }
        storeIp(context, b, ()=>b.localGet(Local.eip));
        atState(context, b);
        atState(context, b).load('i32', { offset: layout.counter });
        this.pushOrigin();
        b.op(I32.add).localGet(Local.budget).op(I32.sub);
        b.store('i32', { offset: layout.counter });
    }

    /**
     * Ends the run here: no budget left, so no transfer goes on and the next
     * back edge or call leaves. The budget is the count too -- what the run
     * took off it since `origin` -- so the origin goes down by what is left,
     * and the exit charges what ran: zeroing the budget alone charged the
     * rest of the quantum as retired, at every call that ended a turn.
     */
    endBudget(){
        const { b, context } = this;
        if (this.flagRecord >= 0)
        {
            atState(context, b);
            this.pushOrigin();
            b.localGet(Local.budget).op(I32.sub)
                .store('i32', { offset: /** @type {number} */ (this.layout.origin) });
        }
        else
        {
            b.localGet(Local.origin).localGet(Local.budget).op(I32.sub).localSet(Local.origin);
        }
        b.i32const(0).localSet(Local.budget);
    }

    /** The budget the run started with: in the state block under cork's layout. */
    pushOrigin(){
        if (this.flagRecord >= 0)
        {
            atState(this.context, this.b)
                .load('i32', { offset: /** @type {number} */ (this.layout.origin) });
        }
        else
        {
            this.b.localGet(Local.origin);
        }
    }

    /**
     * What a transfer under cork's layout leaves in the state block for its
     * callee rather than in its parameters: esp to edi as far as written, the
     * record and the flags word. All three wait for the whole body
     * (`fillDeferred`): what the body never writes is there already, and at a
     * guest call (`site`) so is what no path to the call wrote since the state
     * block last held it.
     *
     * @param {CallSite} [site]
     */
    storeUncarriedState(site){
        const { b } = this;
        this.deferred.push({ at: b.length, kind: 'store', regs: 'uncarried', x87: false, site,
            record: true });
    }

    /**
     * The record's locals into the state block, those `due` says.
     *
     * @param {Body} b @param {(local: number) => boolean} [due]
     */
    storeRecord(b, due = ()=>true){
        for (const { local, offset, wide } of this.recordFields)
        {
            if (due(local))
            {
                atState(this.context, b).localGet(local)
                    .store(wide ? 'i64' : 'i32', { offset: this.flagRecord + offset });
            }
        }
    }

    /**
     * A `ret` back to a call that made this run a wasm call (`callReturn`):
     * the registers, the record, the flags word and the vector registers
     * written into the state block, the count left alone, what is left of the
     * budget beside the calls waiting (`CallStack.BUDGET`), and the function
     * returning `RETURNED`.
     */
    returnToCaller(){
        this.charge();
        if (this.x87.active)
        {
            // As at any exit: the registers back in their own locals and the
            // top and the mask the plain forms keep in locals written.
            x87Normalise(this);
        }
        if (this.returnsToCall)
        {
            this.b.br(this.depthOf('returned'));
            return;
        }
        this.returnedEpilogue();
    }

    /** What `returnToCaller` leaves through, here or after the shared epilogue. */
    returnedEpilogue(){
        const { b, layout } = this;
        this.storeMemoryState();
        this.deferred.push({ at: b.length, kind: 'store', regs: 'all', x87: false,
            record: this.context.flagsAcrossCalls === false ? 'word' : true });
        atState(this.context, b).localGet(Local.budget)
            .store('i32', { offset: layout.regs + CallStack.BUDGET });
        b.i32const(Exit.RETURNED).return();
    }

    /**
     * What lives in the state block alone, a transfer's callee loading it from
     * there: the vector registers written and the x87 block. At a guest call
     * (`site`) the vector registers wait for the whole body, as
     * `storeUncarriedState`'s do.
     *
     * @param {CallSite} [site]
     */
    storeMemoryState(site){
        const { b, layout } = this;
        this.deferred.push({ at: b.length, kind: 'store', regs: 'none', x87: true, site });
        for (const index of site === undefined ? this.xmmWritten : [])
        {
            atState(this.context, b).localGet(this.xmmLocal(index))
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
        if (this.mmWritten.size > 0)
        {
            // What this run wrote, of the registers the region writes.
            x87DropExact(this, ()=>this.b.localGet(Local.mmxTouched)
                .i32const(MMX_WRITTEN_SHIFT).op(I32.shrU));
        }
        for (const index of this.mmWritten)
        {
            // A register the region writes on another path than the one this run
            // took holds what it was given: its bytes go back as they came.
            atState(this.context, b).localGet(this.mmLocal(index))
                .store('i64', { offset: layout.x87 + index * 16 });
            if (layout.x87Format === 'tagged80')
            {
                // An MMX write leaves the register's exponent all ones, as the
                // processor does, so the emulator sees it as it would its own.
                b.localGet(Local.mmxTouched).i32const(1 << MMX_WRITTEN_SHIFT + index)
                    .op(I32.and);
                this.openIf(`mmTag${index}`, EMPTY);
                atState(this.context, b).i32const(0xffff)
                    .store('i32_16', { offset: layout.x87 + index * 16 + 8 });
                this.close();
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
            atState(this.context, b).i32const(0).store('i32_8', { offset: layout.x87Top });
            b.end();
            b.localGet(Local.mmxTouched).i32const(MMX_HELD).op(I32.and);
            b.if(EMPTY);
            atState(this.context, b).i32const(0).store('i32_8', { offset: layout.x87Empty });
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
        const { layout } = this;
        // Under cork's layout the registers the parameters carry are not in
        // the block between regions: each is stored when the run leaves for
        // the host, and a reload (after a trap's handler) takes each back --
        // the next transfer passes them whether the region names them or not.
        // The others are, as every register is under the emulator's layout.
        const { width } = this;
        const carried = this.flagRecord >= 0 ? width.carried : [];
        const kind64 = width.bits === 64 ? 'i64' : 'i32';
        const onEntry = this.deferred.some(one=>one.site !== undefined)
            ? this.writtenOnEntry() : [];
        /** @type {{ at: number, body: Body }[]} */
        const pieces = [];
        for (const { at, kind, regs, x87, site, record } of this.deferred.reverse())
        {
            const b = this.b = new Body();
            // At a guest call, what the state block holds already stays: only
            // what some way to the call wrote since it last held it is stored.
            const entered = site === undefined ? undefined : onEntry[site.block];
            /** @param {number} local */
            const due = local=>site === undefined || site.written.has(local)
                || entered?.has(local) === true;
            for (let r = 0; r < (regs === 'none' ? 0 : width.regs); r++)
            {
                const offset = layout.regs + r * width.slot;
                const local = width.regLocal[r];
                const always = carried.includes(r) && regs === 'all';
                if (regs === 'uncarried' && carried.includes(r))
                {
                    continue;
                }
                if (kind === 'load' && (always || main.uses(local)))
                {
                    atState(this.context, b).load(kind64, { offset }).localSet(local);
                }
                if (kind === 'store' && (always || main.writes(local)) && due(local))
                {
                    atState(this.context, b).localGet(local).store(kind64, { offset });
                }
            }
            if (x87 && this.x87.active && !this.x87.hasMmx)
            {
                if (kind === 'load')
                {
                    x87LoadRegisters(this, k=>main.uses(this.x87.base + k));
                }
                else
                {
                    x87StoreRegisters(this, k=>main.writes(this.x87.base + k));
                }
            }
            if (site !== undefined && x87)
            {
                // `storeMemoryState`'s vector registers.
                for (const index of this.xmmWritten)
                {
                    const local = this.xmmLocal(index);
                    if (due(local))
                    {
                        atState(this.context, b).localGet(local)
                            .storeV128({ offset: layout.xmm + index * 16 });
                    }
                }
            }
            if (record !== undefined)
            {
                // The record's fields and the flags word as the registers: one the
                // body never writes is what the state block holds all along -- its
                // value on entry, or a callee's after a wasm call -- and one it never
                // names is not loaded (`uses` counts writes too: a path that leaves
                // before the write stores the value it came in with).
                if (kind === 'load')
                {
                    for (const { local, offset, wide } of this.recordFields)
                    {
                        if (record === true && main.uses(local))
                        {
                            atState(this.context, b)
                                .load(wide ? 'i64' : 'i32', { offset: this.flagRecord + offset })
                                .localSet(local);
                        }
                    }
                    if (main.uses(Local.flags))
                    {
                        atState(this.context, b).load('i32', { offset: layout.eflags })
                            .localSet(Local.flags);
                    }
                }
                else
                {
                    // Not the record into a call that does not carry it.
                    const into = record === true && !(site !== undefined
                        && this.context.flagsAcrossCalls === false);
                    this.storeRecord(b, local=>into && main.writes(local) && due(local));
                    if (main.writes(Local.flags) && due(Local.flags))
                    {
                        atState(this.context, b).localGet(Local.flags)
                            .store('i32', { offset: layout.eflags });
                    }
                }
            }
            pieces.push({ at, body: b });
        }
        main.insertAll(pieces.reverse());
        this.b = main;
    }

    /**
     * What each block may start with written and not yet back in the state
     * block, for a guest call's stores (`fillDeferred`): the union over its
     * ways in of what each wrote since the state block was last the truth --
     * the run's start, which loads what the region names, or a wasm call's
     * return, after which everything is loaded back. A call that leaves the
     * region starts what follows anew, as an entry does; a call to a function
     * that does nothing (`emptySites`) goes on with what was written before
     * it. A block not emitted in this function runs nothing here.
     *
     * @returns {Set<number>[]}  by block, the locals
     */
    writtenOnEntry(){
        const blocks = this.region.blocks;
        /** @type {Set<number>[]} */
        const into = blocks.map(()=>new Set());
        const ways = blocks.map(block=>jumpsOf(block, this.returns, this.callReturn, this.labels)
            .flatMap(target=>{
                const at = this.labels.get(target);
                return at === undefined ? [] : [at];
            }));
        const work = blocks.map((_, i)=>i);
        const queued = new Set(work);
        while (work.length > 0)
        {
            const i = /** @type {number} */ (work.pop());
            queued.delete(i);
            const written = this.blockWrites[i];
            const site = this.callSites.get(i);
            if (written === undefined || (site === undefined
                ? callsOut(blocks[i], this.labels) : !site.empty))
            {
                continue;
            }
            // Added from both into each way's set, not joined into a set of
            // their own first: the join was a tenth of what translating made
            // for the collector.
            const own = site === undefined ? written : site.written;
            for (const j of ways[i])
            {
                const before = into[j].size;
                if (j !== i)
                {
                    for (const local of into[i])
                    {
                        into[j].add(local);
                    }
                }
                for (const local of own)
                {
                    into[j].add(local);
                }
                if (into[j].size !== before && !queued.has(j))
                {
                    queued.add(j);
                    work.push(j);
                }
            }
        }
        return into;
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
        x87DropExact(this, ()=>b.localGet(Local.x87Dirty).localGet(Local.mmxTouched)
            .i32const(MMX_WRITTEN_SHIFT).op(I32.shrU).op(I32.or));
        for (let p = 0; p < 8; p++)
        {
            const at = layout.x87 + p * 16;
            const mm = /** @type {number} */ (this.mmLocals.get(p));
            // Stored where the run wrote it, by either class: an MMX write marks
            // the run's MMX mark (its local is the mantissa), an x87 one the
            // dirty mask.
            b.localGet(Local.x87Dirty);
            if (this.mmWritten.has(p))
            {
                b.localGet(Local.mmxTouched).i32const(MMX_WRITTEN_SHIFT).op(I32.shrU)
                    .op(I32.or);
            }
            b.i32const(1 << p).op(I32.and);
            this.openIf(`mixed${p}`, EMPTY);
            atState(this.context, b).localGet(mm).store('i64', { offset: at });
            if (layout.x87Format === 'tagged80')
            {
                atState(this.context, b);
                b.i32const(0xffff);
                b.i32const(0x7ffe);
                b.localGet(x.form).i32const(1 << p).op(I32.and);
                b.select();
                b.store('i32_16', { offset: at + 8 });
            }
            this.close();
        }
    }


    /**
     * An untranslated exit with budget left tail-calls the module's transfer
     * function (`finishModule`) with its EIP and the state a transfer carries:
     * the entry hash names the region to go on in, or the transfer leaves as
     * this epilogue would have. The state block is complete but for what the
     * parameters carry, so the callee's prologue reads what this epilogue wrote.
     */
    transfer(){
        const { b } = this;
        b.localGet(Local.t0).i32const(Exit.UNTRANSLATED).op(I32.eq)
            .localGet(Local.budget).i32const(0).op(I32.gtS).op(I32.and);
        this.openIf('transfer');
        b.localGet(Local.eip);
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
        b.returnCall(/** @type {number} */ (this.context.transfer));
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
            // Long mode's record is i64, its operands zero-extended: the same compares.
            const wide = this.width.bits === 64;
            const ltU = wide ? I64_LT_U : I32.ltU;
            const eq = wide ? I64_EQ : I32.eq;
            b.localGet(k).i32const(Kind.SUB).op(I32.sub).i32const(2).op(I32.ltU);
            b.localGet(Local.op1).localGet(Local.op2).op(ltU);
            b.localGet(Local.op1).localGet(Local.op2).op(eq).localGet(Local.cin).op(I32.and)
                .localGet(k).i32const(Kind.SBB).op(I32.eq).op(I32.and);
            b.op(I32.or).op(I32.and);
            // ADD/ADC: the sum wrapped below op1, or equal with a carry in (ADC).
            b.localGet(k).i32const(Kind.ADD).op(I32.sub).i32const(2).op(I32.ltU);
            b.localGet(Local.res).localGet(Local.op1).op(ltU);
            b.localGet(Local.res).localGet(Local.op1).op(eq).localGet(Local.cin).op(I32.and)
                .localGet(k).i32const(Kind.ADC).op(I32.eq).op(I32.and);
            b.op(I32.or).op(I32.and);
            b.op(I32.or);
            // NEG: op2 was not zero. LOGIC: none of the three, 0.
            b.localGet(k).i32const(Kind.NEG).op(I32.eq);
            b.localGet(Local.op2);
            if (wide)
            {
                b.i64const(0n).op(I64_NE);
            }
            else
            {
                b.i32const(0).op(I32.ne);
            }
            b.op(I32.and);
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
        if (this.resultOwed !== null && this.pending?.kind === Kind.SUB && cc >> 1 === 2)
        {
            // je/jne of a compare: its operands equal or not, the result unmade.
            this.b.localGet(Local.op1).localGet(Local.op2).op((cc & 1) === 0 ? I32.eq : I32.ne);
            return;
        }
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
        if (this.width.bits === 64 && size < 8)
        {
            // A narrower result goes on as the i32 it is, into the i64 record
            // zero-extended.
            this.b.localTee(LONG_SCRATCH).localGet(LONG_SCRATCH).op(I64_EXTEND_U)
                .localSet(Local.res);
        }
        else
        {
            this.b.localTee(Local.res);
        }
        this.b.i32const(kindOf(kind, size)).localSet(Local.kind);
        this.pending = { kind, width: widthCode(size) };
    }

    /**
     * Prepares for an eager write of some flags: the word is made whole and
     * the bits named are cleared, so the caller ors its values in. Whole only
     * where a flag the instruction leaves as it was is read later: a `bt`
     * before a `jc` folds no record. (No shift by cl nor repeated compare,
     * which may write no flag at all, comes here.)
     *
     * @param {number} mask
     */
    eagerWrite(mask){
        // Outside precise, an undefined flag is the emitter's to leave as it will.
        const left = ARITH & ~mask
            & (this.context.precise === true ? ARITH : ~this.current.flagsUndefined);
        if ((mask & ARITH) === ARITH || (left & this.flagsAfter) === 0)
        {
            // All six are written, or the ones not are not read: nothing of
            // the record survives to fold.
            this.b.i32const(0).localSet(Local.kind);
            this.pending = { kind: Kind.EAGER, width: 2 };
        }
        else
        {
            this.materialise();
        }
        this.b.localGet(Local.flags).i32const(~mask).op(I32.and).localSet(Local.flags);
    }

    /**
     * An empty record, the six flags taken as the word's: on a way out whose
     * next code writes them before it reads them, which then are no one's.
     */
    clearRecord(){
        const { b } = this;
        b.i32const(0).localSet(Local.kind);
        for (const { local, wide } of this.recordFields)
        {
            if (local !== Local.kind)
            {
                (wide ? b.i64const(0n) : b.i32const(0)).localSet(local);
            }
        }
    }

    /**
     * Whether a `cmp` just before the block's final conditional branch may
     * leave its record's result unmade (`oweResult`): a branch whose
     * condition the operands alone answer, in a block that ends in it.
     *
     * @param {import('../region.js').Block} block
     */
    owesTo(block){
        const last = block.instructions.at(-1);
        return block.exit.kind === 'jcc' && this.width.bits === 32 && last?.cc !== undefined
            && [1, 2, 3, 6, 7].includes(last.cc >> 1);
    }

    /**
     * The record of a `cmp` the block's final branch alone reads, but for its
     * result: the branch compares the operands, and the result is made only on
     * a way on whose code reads the flags (`payResultFor`) and on a way out that
     * hands them on (`exitWithKind`). Made where it was read, it was made every
     * turn of a loop whose exit reads it once -- the engine computes a value
     * where it is defined, not on the edge that uses it.
     *
     * @param {number} size
     */
    oweResult(size){
        this.b.i32const(kindOf(Kind.SUB, size)).localSet(Local.kind);
        this.pending = { kind: Kind.SUB, width: widthCode(size) };
        this.resultOwed = size;
    }

    /** The owed result made (`oweResult`), on the way being emitted. */
    payResult(){
        const size = this.resultOwed;
        if (size === null)
        {
            return;
        }
        this.b.localGet(Local.op1).localGet(Local.op2).op(I32.sub);
        if (size < 4)
        {
            this.b.i32const(MASKS[widthCode(size)]).op(I32.and);
        }
        this.b.localSet(Local.res);
    }

    /**
     * The owed result made on the way to `eip`, where the code there reads a
     * flag before it writes it.
     *
     * @param {number} eip
     */
    payResultFor(eip){
        if ((this.flagsLiveAt(eip) & ARITH_FLAGS) !== 0)
        {
            this.payResult();
        }
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
     * Whether a block's own branch comes back to its start as a wasm loop
     * onto itself -- the shape of most inner loops -- rather than a jump:
     * with x87 in play, only when the block ends in the state it starts in,
     * so the edge needs no moves.
     *
     * @param {number} index
     */
    loopsOntoItself(index){
        const block = this.region.blocks[index];
        const x = this.x87;
        return (block.exit.kind === 'jcc' || block.exit.kind === 'loop')
            && block.exit.targets[0] === block.start && block.instructions.length > 0
            && (!x.active || (x.states[index] !== null && x.ends[index] !== null
                && sameState(x.states[index], x.ends[index])));
    }

    /**
     * The label the runtime enters a block by: its own, or, for a block inside
     * a loop other than the head, its copy's past the labels of the blocks
     * and of their entry tests.
     *
     * @param {number} index
     */
    entryLabel(index){
        const at = this.copyIndex.get(index);
        return at === undefined ? index : 2 * this.region.blocks.length + at;
    }

    /**
     * By label, the block the dispatch enters with it, or -1 for a label past
     * a block's entry test (a jump's inside the region, never an entry).
     *
     * @returns {number[]}
     */
    labelBlocks(){
        const count = this.region.blocks.length;
        if (this.copies.length === 0)
        {
            return this.region.blocks.map((_, index)=>index);
        }
        return [...this.region.blocks.map((_, index)=>index), ...new Array(count).fill(-1),
            ...this.copies];
    }

    /**
     * The blocks `lo` to `hi` as the region's structure has them: each a wasm
     * block the code after its end follows, a loop among them as one item
     * whose blocks are a range of their own inside a wasm loop. A branch
     * forward is a branch out of its target's item; a branch back to the head
     * of a loop around it is a branch to that loop, the only way into the
     * loop but its head's own, so a turn tests no label and a block inside it
     * joins no way in from the dispatch -- the runtime enters such a block
     * (after an exit in the middle of the loop, or from another region) through
     * its copy (`emitCopies`). A loop's head inside another loop is entered from
     * the dispatch through the outer loop's head, which tests the label.
     * The function's own range opens with the dispatch; in the function of the
     * copies, it holds the copies alone.
     *
     * @param {number} lo @param {number} hi
     * @param {boolean} loop  the range is a loop's, `lo` its head
     */
    emitRange(lo, hi, loop){
        const { b } = this;
        const blocks = this.region.blocks;
        /** @type {{ start: number, end: number, loop: boolean, copy?: boolean }[]} */
        const items = this.copyFunction
            ? this.copies.map(at=>({ start: at, end: at, loop: false, copy: true })) : [];
        for (let i = loop ? lo + 1 : lo; i <= hi && !this.copyFunction;)
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
            const { start, copy } = items[k];
            this.open(`${copy ? 'c' : 'b'}${start}`, EMPTY);
            if (!items[k].loop && this.entryTested(start))
            {
                // The block's own entry, before its test of the windows it
                // takes from the block before (`emitEntryTests`).
                this.open(`${copy ? 'q' : 'p'}${start}`, EMPTY);
            }
        }
        if (loop)
        {
            if (this.entered.has(lo))
            {
                // A way into a loop inside this one, from the dispatch: a turn
                // comes back with the head's own label.
                b.localGet(Local.label).i32const(lo).op(I32.ne);
                this.openGuard(`enter${lo}`);
                b.localGet(Local.label);
                b.brTable(blocks.map((block, t)=>{
                    const item = items.find(one=>one.loop && one.start <= t && t <= one.end);
                    return item ? this.depthOf(`b${item.start}`) : 0;
                }), 0);
                this.close();
            }
            this.emitBlock(blocks[lo], lo);
        }
        else
        {
            b.localGet(Local.label);
            b.brTable(this.dispatchTable(items), 0);
        }
        for (const item of items)
        {
            this.close();
            if (item.loop)
            {
                // A loop of one block that is its own loop onto itself needs
                // no second one around it, nor the stack check at its head.
                if (item.start === item.end && this.loopsOntoItself(item.start))
                {
                    this.open(`L${item.start}`, EMPTY);
                }
                else
                {
                    this.openLoop(`L${item.start}`);
                }
                this.emitRange(item.start, item.end, true);
                this.close();
                continue;
            }
            this.copying = item.copy === true;
            this.copyAt = this.copying ? /** @type {number} */ (this.copyIndex.get(item.start)) : -1;
            if (this.entryTested(item.start))
            {
                this.emitEntryTests(item.start);
                this.close();
            }
            this.emitBlock(blocks[item.start], item.start);
            this.copying = false;
            this.copyAt = -1;
        }
        this.ranges.pop();
    }

    /**
     * The function's dispatch over its labels (`labelBlocks`): a block's own
     * label to the item holding it, past its entry test to the block, a copy's
     * to the copy. Without entry tests or copies, only the blocks' own.
     *
     * @param {{ start: number, end: number, loop: boolean, copy?: boolean }[]} items
     * @returns {number[]}
     */
    dispatchTable(items){
        const blocks = this.region.blocks;
        /** @param {number} t */
        const copyDepth = t=>this.depthOf(`${this.entryTested(t) ? 'q' : 'c'}${t}`);
        const past = blocks.map((block, t)=>{
            if (this.copyFunction)
            {
                return this.copyIndex.has(t) ? copyDepth(t) : 0;
            }
            const item = items.find(one=>one.start <= t && t <= one.end);
            return item ? this.depthOf(`b${item.start}`) : 0;
        });
        const tested = this.memoryPlan !== null
            && this.memoryPlan.entry.some(tests=>tests.length > 0);
        if (!tested && !this.copyFunction)
        {
            return past;
        }
        // A label past the blocks is the block's from the one it takes
        // windows from: past their test (`takesFrom`).
        const own = past.map((depth, t)=>(this.entryTested(t)
            && items.some(one=>one.start === t && !one.loop)
            ? this.depthOf(`${this.copyFunction ? 'q' : 'p'}${t}`) : depth));
        return this.copyFunction ? [...own, ...past, ...this.copies.map(copyDepth)]
            : [...own, ...past];
    }

    /**
     * The function of a structured region's copies: the blocks inside its
     * loops but the heads (`copies`), each as a block of a flat dispatch, which
     * go on among themselves and leave by the entry hash at the first jump to
     * a block that has no copy -- a loop's head, or a block after the loops --
     * where the region's own function takes over. A copy's label sends the
     * region's function there before anything of it runs, with the state as
     * it came in. Kept out of the region's function, whose loops then join no
     * way in but their heads': cold copies inside it make TurboFan keep less of
     * a loop in registers. The same region's plans -- its order and loops, its
     * returns, its x87, its flags' liveness and its access groups -- are this
     * function's, taken rather than made again.
     *
     * @param {number[]} flagsOut  the flags live at each block's end (`liveFlagsOut`)
     * @param {import('./memory.js').RegionPlan | null} memoryPlan  the access groups
     */
    emitCopies(flagsOut, memoryPlan){
        const copies = new RegionEmitter(this.context, this.formed, { ...this.options,
            copyFunction: true, planned: { returns: this.returns, structure: this.structure,
                region: this.region, x87: this.x87Plan, flagsOut,
                memoryPlan: memoryPlan === null ? null : copyPlan(memoryPlan) } });
        const { functionIndex } = copies.emit();
        this.copiesIndex = functionIndex;
        const { b } = this;
        b.localGet(Local.label).i32const(2 * this.region.blocks.length).op(I32.geU);
        this.openGuard('copy');
        for (let local = 0; local < STATE_PARAMS; local++)
        {
            b.localGet(local);
        }
        if (this.context.features.tailCalls)
        {
            b.returnCall(functionIndex);
        }
        else
        {
            b.call(functionIndex).return();
        }
        this.close();
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
     * The block whose code follows the current block's in the function, or -1:
     * the next in the order, or the next copy while emitting the copies (the
     * last one's way on is a branch).
     *
     * @param {number} index  the current block
     */
    following(index){
        if (this.copying)
        {
            return this.copies[this.copyAt + 1] ?? -1;
        }
        return index + 1 < this.region.blocks.length ? index + 1 : -1;
    }

    /**
     * Into the block after this one, as a jump there is taken: the x87
     * registers moved to the locals that block is compiled for, or, where it
     * is compiled for another top than the one arriving (a region's own entry,
     * a block compiled for a guessed top), a leave before it. The edge of a
     * conditional branch that is not taken is such an edge too: the block
     * after it may have been reached first, by another way, with the registers
     * exchanged otherwise.
     *
     * @param {number} index  the block fallen into @param {number} start  its address
     */
    fallThrough(index, start){
        if (this.x87.active && !x87Edge(this, index))
        {
            this.exitAt(start, Exit.UNTRANSLATED);
            return;
        }
        this.fallInto(index);
    }

    /**
     * Before falling through into the block after this one: a block that
     * takes windows from this one past its entry test.
     *
     * @param {number} index  the block fallen into
     */
    fallInto(index){
        if (this.takesFrom(index))
        {
            this.b.br(this.depthOf(`${this.copying ? 'c' : 'b'}${index}`));
        }
    }

    /**
     * @param {import('../region.js').Block} block
     * @param {number} index
     */
    emitBlock(block, index){
        // The record's kind at the end of the block before, which a later
        // block's read at its start may take as its guess (`blockHint`).
        if (this.lastEmitted >= 0)
        {
            this.ends[this.lastEmitted] = this.pending;
        }
        this.lastEmitted = index;
        // A block every way into which tested the control word tests it no more
        // (`planPrecision`); its copy, entered otherwise, does.
        this.x87.checkedPrecision = !this.copying && this.x87.precisionIn?.[index] === true
            ? index : -1;
        this.hint = undefined;
        this.pending = null;
        this.fcmp = null;
        this.dead = false;
        this.blockRetired = 0;
        this.blockDepth = this.controls.length;
        this.blockIndex = index;
        this.at = -1;
        // Until the next block starts, what is written is this block's: its
        // instructions and its ways out.
        this.b.written = this.blockWrites[index] ??= new Set();
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
        this.selfLoop = this.loopsOntoItself(index);
        this.flagsAfterEach = [];
        const live = deadFlagPass(block, this.flagsOut[index], this.flagsAfterEach,
            this.context.precise === true);
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.precise !== true)
        {
            relaxedFlagReads(block, this.relaxedReads);
        }
        // A loop that only reads is left unhoisted where reads go untested: its
        // unchecked copy saved one wrapping `and` a read and cost a turn counter
        // and the window's test, which a short loop (a strlen, a hash of a
        // name) never paid back: cork-bench sort -3.1 %, str -1.8 %, crc's
        // long table walk +0.3 %.
        const planned = this.selfLoop && !x.active && this.layout.codePages < 0
            ? planLoop(block.instructions, this.width.bits === 64) : null;
        const streams = planned !== null && (planned.streams.some(stream=>stream.store)
            || !readsWrapped(this.context)) ? planned : null;
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
        this.resultOwed = null;
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
     *     turns: number, forward: boolean, ranges: import('./memory.js').Range[] }} streams
     */
    emitHoistedLoop(block, index, live, streams){
        const { b } = this;
        const last = block.instructions[block.instructions.length - 1];
        const turns = this.localTypes.length + STATE_PARAMS;
        this.localTypes.push(ValType.i32);
        const depth = this.controls.length;
        this.loops++;
        this.open(`selfDone${index}`, EMPTY);
        const copy = this.width.bits === 32 && this.context.undo === undefined
            ? copyLoopOf(block) : null;
        if (copy !== null)
        {
            const pending = this.pending;
            emitCopyAtOnce(this, block, copy, `selfDone${index}`, ()=>{
                this.current = block.instructions[1];
                this.flagsAfter = this.flagsAfterEach[1];
                this.memPlan = null;
                emitInstruction(this, block.instructions[1], live[1]);
            }, import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.blockProfile
                ? times=>this.countBlock(block.start, times) : null);
            this.pending = pending;
        }
        this.openLoop(`self${index}`);
        emitStreamWindow(this, streams.streams, streams.turns, streams.forward, streams.ranges);
        b.op(I32.eqz);
        this.openGuard('streamsFlagged');
        // The checked copy, to the loop's end.
        this.openLoop(`checked${index}`);
        this.blockDepth = this.controls.length;
        this.blockRetired = 0;
        // Long mode's accesses are tested one by one outside the streams (no groups yet).
        if (!this.emitInstructions(block, index, live,
            this.width.bits === 64 ? new Map() : planBlock(block.instructions)))
        {
            while (this.controls.length > depth)
            {
                this.close();
            }
            // The block ends at an instruction with no lowering, inside the checked
            // copy; a run whose streams' pages were clean skipped that copy, and
            // runs the block plainly to the same way out.
            this.selfLoop = false;
            this.blockRetired = 0;
            this.blockDepth = this.controls.length;
            this.pending = null;
            this.fcmp = null;
            this.resultOwed = null;
            this.dead = false;
            const counted = this.instructions;
            this.emitInstructions(block, index, live, this.memoryPlan?.blocks[index] ?? new Map());
            this.instructions = counted;
            return;
        }
        const backEdge = (/** @type {() => void} */ taken)=>{
            this.charge();
            this.pushBranchCondition(last);
            this.openIf('taken');
            this.spentTest();
            this.openGuard('spent');
            this.exitAt(block.start, Exit.BUDGET);
            this.close();
            this.payResultFor(block.start);
            taken();
            this.close();
            this.payResultFor(block.exit.targets[1]);
            this.resultOwed = null;
            b.br(this.depthOf(`selfDone${index}`));
        };
        backEdge(()=>b.br(this.depthOf(`checked${index}`)));
        this.close(); // checked
        this.close(); // streamsFlagged
        // The unchecked copy, for as many turns as the test cleared. With no
        // other executor to answer (no interrupt word) the turns are counted
        // on the budget itself: the copy runs while the budget is above what
        // those turns leave of it, or above zero if they would spend it, so a
        // turn charges and looks once, where a count of its own and the
        // budget's test were two looks. Where the bound is met, the budget
        // spent leaves as before and a budget left goes back to the test.
        // And two turns a wasm turn, for an even number of the turns
        // cleared: the first turn's back edge goes on into the second
        // with no charge and no look, its count owed into the second's ways
        // out, and the second charges both and looks once -- the budget's
        // subtraction, compare and branch and V8's stack check at the loop's
        // head paid every other turn.
        const shared = this.layout.interrupt !== undefined;
        const paired = !shared && streams.turns >= 2 && this.context.precise !== true
            && block.instructions.length <= PAIRED_MAX;
        const cleared = paired ? streams.turns & ~1 : streams.turns;
        if (shared)
        {
            b.i32const(cleared).localSet(turns);
        }
        else
        {
            b.localGet(Local.budget).i32const(cleared * block.instructions.length)
                .op(I32.sub).localTee(turns).i32const(0)
                .localGet(turns).i32const(0).op(I32.gtS).select().localSet(turns);
        }
        this.openLoop(`unchecked${index}`);
        this.blockDepth = this.controls.length;
        this.blockRetired = 0;
        this.pending = null;
        this.dead = false;
        const counted = this.instructions;
        this.emitInstructions(block, index, live, streams.plan);
        this.instructions = counted;
        if (shared)
        {
            backEdge(()=>{
                b.localGet(turns).i32const(1).op(I32.sub).localTee(turns);
                b.brIf(this.depthOf(`unchecked${index}`));
                b.br(this.depthOf(`self${index}`));
            });
        }
        else
        {
            if (this.blockRetired !== block.instructions.length)
            {
                // A turn charged less than its bound was made for would run
                // past the pages the test cleared.
                throw new Error(`emit: block ${index}'s unchecked turn charges`
                    + ` ${this.blockRetired}, not ${block.instructions.length}`);
            }
            const turn = this.blockRetired;
            if (paired)
            {
                // The first turn's back edge into the second, its count owed
                // into it; its fall-through charges it below.
                this.pushBranchCondition(last);
                this.openIf('taken');
                this.payResultFor(block.start);
                this.resultOwed = null;
                this.pending = null;
                this.fcmp = null;
                this.emitInstructions(block, index, live,
                    new Map([...streams.plan].map(([i, slot])=>[i, { ...slot }])));
                this.instructions = counted;
                if (this.blockRetired !== 2 * turn)
                {
                    throw new Error(`emit: block ${index}'s unchecked turns charge`
                        + ` ${this.blockRetired}, not ${2 * turn}`);
                }
                this.charge();
                this.blockRetired = 0;
            }
            else
            {
                this.charge();
            }
            this.pushBranchCondition(last);
            this.openIf('taken');
            b.localGet(Local.budget).localGet(turns).op(I32.leS);
            this.openGuard('turnsDone');
            this.spentTest();
            this.openGuard('spent');
            this.exitAt(block.start, Exit.BUDGET);
            this.close();
            this.payResultFor(block.start);
            b.br(this.depthOf(`self${index}`));
            this.close();
            this.payResultFor(block.start);
            b.br(this.depthOf(`unchecked${index}`));
            this.close();
            this.payResultFor(block.exit.targets[1]);
            b.br(this.depthOf(`selfDone${index}`));
            if (paired)
            {
                this.close(); // taken
                this.dead = false;
                this.blockRetired = turn;
                this.charge();
                this.payResultFor(block.exit.targets[1]);
                b.br(this.depthOf(`selfDone${index}`));
            }
            this.resultOwed = null;
        }
        this.close(); // unchecked
        this.close(); // self
        this.close(); // selfDone
        this.selfLoop = false;
        const [, notTaken] = block.exit.targets;
        const after = this.following(index);
        const next = after < 0 ? undefined : this.region.blocks[after];
        if (next && next.start === notTaken)
        {
            this.fallInto(after);
            return;
        }
        this.jumpTo(notTaken);
    }

    /**
     * One more execution of the block at `start` in its profile slot: the count,
     * and the address when the slot is another block's (then marked shared).
     *
     * @param {number} start
     * @param {number} [times]  a local holding how many executions, one unless given
     */
    countBlock(start, times = -1){
        const { b } = this;
        const at = this.layout.tables + blockProfileAt(this.layout)
            + blockSlot(start) * Tables.BLOCK_SLOT;
        const { context } = this;
        atTables(context, atTables(context, b)).load('i32', { offset: at + 4 });
        if (times < 0)
        {
            b.i32const(1);
        }
        else
        {
            b.localGet(times);
        }
        b.op(I32.add).store('i32', { offset: at + 4 });
        atTables(context, b).load('i32', { offset: at }).i32const(start | 0).op(I32.ne);
        this.openIf('profileSlot');
        atTables(context, atTables(context, b)).load('i32', { offset: at + 8 });
        atTables(context, b).load('i32', { offset: at }).i32const(0).op(I32.ne).op(I32.or)
            .store('i32', { offset: at + 8 });
        atTables(context, b).i32const(start | 0).store('i32', { offset: at });
        this.close();
    }

    /**
     * A store of the block's mark (`blockMark`): which code a compiler made of
     * which block, read back from its machine code. A block emitted twice (a
     * hoisted loop's checked and unchecked copies) is marked with its copy.
     *
     * @param {number} index  the block, or `BLOCK_MARK_END` before the epilogue
     */
    markBlock(index){
        this.marksMade ??= new Map();
        const copy = this.marksMade.get(index) ?? 0;
        this.marksMade.set(index, copy + 1);
        // In the state page, short of `nanFirst` and in no field: past the 32-bit
        // state block, in the 64-bit one's unused tail.
        atState(this.context, this.b).i32const(blockMark(index, copy))
            .store('i32', { offset: this.layout.regs + 1020 });
    }

    /**
     * One more of `mechanism` in a profiling run's counts (`blockProfile`);
     * nothing in any other.
     *
     * @param {number} mechanism  a `Mechanism`
     */
    countMechanism(mechanism){
        if (import.meta.BOTTLIFY_DIAGNOSTICS === false || !this.context.blockProfile)
        {
            return;
        }
        const at = this.layout.tables + mechanismAt(this.layout, mechanism);
        atTables(this.context, atTables(this.context, this.b)).load('i64', { offset: at })
            .i64const(1n).op(I64_ADD).store('i64', { offset: at });
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
        if (this.pendingLows.size > 0)
        {
            throw new Error(`block ${index}: low lanes owed from the block before`);
        }
        if (this.resultOwed !== null)
        {
            throw new Error(`block ${index}: a compare's result owed from the block before`);
        }
        this.lows.clear();
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.markBlocks)
        {
            this.markBlock(index);
        }
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.blockProfile)
        {
            this.countBlock(block.start);
        }
        for (let i = 0; i < block.instructions.length; i++)
        {
            const instruction = block.instructions[i];
            const flagsLive = live[i];
            this.flagsAfter = this.flagsAfterEach[i];
            this.flagsAfterOf = instruction;
            this.current = instruction;
            this.at = i;
            this.owesResult = i === block.instructions.length - 2 && this.owesTo(block);
            this.staleCheck = false;
            this.folded = null;
            this.x87RefusalReason = null;
            // Counted before it is emitted, so an exit *after* it (a halt, a
            // call) has it charged; an exit *before* it uncounts it.
            this.blockRetired++;
            this.instructions++;
            this.memPlan = plan.get(i) ?? null;
            if (i === block.instructions.length - 1 && block.exit.kind !== 'fallthrough')
            {
                // The block's way on: its vectors whole before any of it.
                this.settleLows(this.pendingLows.keys(), true);
            }
            const bodyAt = this.b.length;
            if (this.memPlan !== null && this.memPlan.checks.length > 0)
            {
                emitGroupChecks(this, this.memPlan.checks);
            }
            const done = emitInstruction(this, instruction, flagsLive);
            this.owesResult = false;
            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.context.expansion)
            {
                this.context.expansion(instruction, this.b.length - bodyAt, done);
            }
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
                // Nothing after the way out runs: it paid what was owed.
                this.pendingLows.clear();
                return false;
            }
            if (this.dead)
            {
                this.pendingLows.clear();
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
        this.settleLows(this.pendingLows.keys(), true);
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
     * Whether a back edge leaves for the host: the budget spent -- at or under
     * zero, or, where other executors run beside this one, under the word they
     * store when they need its answer (`layout.interrupt`), all ones but the
     * sign then. A plain load: with the atomic one the loops of a process of
     * several executors ran 3-12 % slower than one executor's in Chrome 141
     * (cork-bench), with the plain one 0-3 %, and on ARM it is an `ldar`.
     * Neither V8 12 nor 14 takes the load out of a loop that stores nothing
     * (the cork host's test); one that did would leave such a loop when its
     * budget runs out, as a run with no word does.
     */
    spentTest(){
        this.b.localGet(Local.budget);
        this.spentLimit();
        this.b.op(I32.leS);
    }

    /** What `spentTest` compares the budget with: 0, or the interrupt word. */
    spentLimit(){
        const { b } = this;
        if (this.layout.interrupt === undefined)
        {
            b.i32const(0);
        }
        else
        {
            atState(this.context, b).load('i32', { offset: this.layout.interrupt });
        }
    }

    /**
     * Charges the block's instructions so far to the budget, which is the
     * count too (`origin`). On a conditional path (inside an `if` the block
     * opened) the count stays owed: the path that falls through charges it at
     * its own exit.
     */
    charge(){
        if (this.blockRetired === 0)
        {
            return;
        }
        const { b } = this;
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
        const after = this.following(index);
        const next = after < 0 ? undefined : this.region.blocks[after];
        switch (exit.kind)
        {
            case 'fallthrough':
                this.charge();
                if (next && next.start === exit.targets[0])
                {
                    this.fallThrough(after, exit.targets[0]);
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
                    this.spentTest();
                    this.openGuard('spent');
                    this.exitAt(block.start, Exit.BUDGET);
                    this.close();
                    this.payResultFor(block.start);
                    this.b.br(this.depthOf(`self${index}`));
                    this.close();
                    this.closeSelfLoop();
                    this.payResultFor(notTaken);
                    if (next && next.start === notTaken)
                    {
                        this.fallThrough(after, notTaken);
                        return;
                    }
                    this.jumpTo(notTaken);
                    return;
                }
                this.pushBranchCondition(last);
                this.openIf('taken');
                this.payResultFor(taken);
                this.jumpTo(taken);
                this.close();
                this.payResultFor(notTaken);
                if (next && next.start === notTaken)
                {
                    this.fallThrough(after, notTaken);
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
                if (this.returned)
                {
                    // Called as a wasm call and returned to: the block after it.
                    this.returned = false;
                    this.charge();
                    this.jumpTo(exit.next);
                    return;
                }
                // A direct call to a block of the region: the push is done
                // and the jump is the block's. Any other left by itself.
                if (!this.dead)
                {
                    this.charge();
                    this.jumpTo(exit.targets[0]);
                }
                return;
            default:
                if (this.returned)
                {
                    this.returned = false;
                    this.charge();
                    this.jumpTo(exit.next);
                    return;
                }
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
        // loop / loope / loopne / jecxz on ecx (cx under an address-size prefix);
        // in long mode on rcx (ecx under the prefix: jrcxz is jecxz there)
        const wide = !instruction.prefixes.address;
        const long = this.width.bits === 64;
        const pushCount = ()=>{
            b.localGet(this.width.regLocal[1]);
            if (long && !wide)
            {
                b.op(I64.wrap);
            }
            else if (!wide)
            {
                b.i32const(0xffff).op(I32.and);
            }
        };
        const quad = long && wide;
        if (op === 'jecxz')
        {
            pushCount();
            b.op(quad ? I64.eqz : I32.eqz);
            return;
        }
        // The decrement happened in the instruction's own emission.
        pushCount();
        if (quad)
        {
            b.op(I64.eqz).op(I32.eqz);
        }
        else
        {
            b.i32const(0).op(I32.ne);
        }
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
        if (this.copying && this.jumpFromCopy(label))
        {
            return;
        }
        if (!this.copying && label > this.blockIndex)
        {
            // A forward edge cannot close a loop: a branch out of the item that
            // holds the target, in the innermost range holding it, which is
            // still open here -- with no budget test and no trip through a
            // dispatch. A loop is entered at its head, falling into it.
            for (let k = this.ranges.length - 1; k >= 0; k--)
            {
                const range = this.ranges[k];
                /** @type {{ start: number, end: number, loop: boolean } | undefined} */
                const item = range.items.find(one=>!one.copy && one.start <= label
                    && label <= one.end);
                if (label >= range.lo && label <= range.hi && item
                    && (!item.loop || item.start === label))
                {
                    b.br(this.depthOf(item.loop || this.takesFrom(label)
                        || !this.entryTested(label) ? `b${item.start}` : `p${label}`));
                    return;
                }
            }
        }
        // A backward edge is looked at against the budget: only it can close
        // a loop. To the head of a loop around this block it is a branch to
        // that loop; any other goes through the function's dispatch -- or,
        // to a block the dispatch does not hold, out through the entry hash:
        // a copy's (`emitCopies`), or, from a copy, the region's own.
        const around = !this.copying && this.ranges.some(range=>range.loop && range.lo === label);
        this.spentTest();
        this.openGuard('spent');
        this.exitAfterEdge(target, Exit.BUDGET);
        this.close();
        if (this.copyFunction ? !this.copyIndex.has(label) : this.interior.has(label))
        {
            this.countMechanism(Mechanism.JUMP_OUT);
            this.exitAfterEdge(target, Exit.UNTRANSLATED);
            return;
        }
        this.countMechanism(around ? Mechanism.JUMP_LOOP : Mechanism.JUMP_DISPATCH);
        if (!around || this.entered.has(label))
        {
            b.i32const(this.labelFor(label)).localSet(Local.label);
        }
        b.br(this.depthOf(around ? `L${label}` : 'dispatch'));
    }

    /**
     * A jump forward from a copy (`emitCopies`) to a later copy: a branch.
     * Answers false for any other, which is looked at against the budget.
     *
     * @param {number} label  the target block
     */
    jumpFromCopy(label){
        const at = this.copyIndex.get(label);
        if (at === undefined || at <= this.copyAt)
        {
            return false;
        }
        this.b.br(this.depthOf(this.takesFrom(label) || !this.entryTested(label) ? `c${label}`
            : `q${label}`));
        return true;
    }

    /**
     * The label a jump from the current block into `index` goes through a
     * dispatch with: a block inside a loop, its copy's (entered with its test);
     * past the block's entry test when the block takes its windows from this
     * one (the labels past the blocks); its own otherwise.
     *
     * @param {number} index
     */
    labelFor(index){
        if (this.copyIndex.has(index))
        {
            return this.entryLabel(index);
        }
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
        this.exitWithKind(kind, vector, this.flagsLiveAt(eip));
    }

    /**
     * The flags the code at `eip` reads before it writes them, as far as the
     * region knows it: a block's start, or the instruction being emitted or the
     * one after it; anywhere else all of them.
     *
     * @param {number} eip
     */
    flagsLiveAt(eip){
        const at = this.labels.get(eip);
        if (at !== undefined && this.flagsIn.length > at)
        {
            return this.flagsIn[at];
        }
        const of = this.flagsAfterOf;
        if (of !== null && of === this.current)
        {
            if (eip === of.eip)
            {
                return liveBefore(of, this.flagsAfter, this.context.precise === true);
            }
            if (eip === of.eip + of.length)
            {
                return this.flagsAfter;
            }
        }
        return ARITH_FLAGS | DF;
    }

    /**
     * `exitAt` from a jump whose x87 edge has already moved the registers
     * where the target reads them: the exit writes them back from there.
     *
     * @param {number} eip @param {number} kind
     */
    exitAfterEdge(eip, kind){
        const x = this.x87;
        const held = x.current;
        x.current = x.active ? x.landed : held;
        this.exitAt(eip, kind);
        x.current = held;
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
            // `leaving`). So also where the exit is conditional, as an `out`
            // to a port other than the trap port's is: entered at such an
            // `out`, the block would leave through the hash for its own
            // start and tail-call itself forever. A fault's exit is not
            // counted here: a block that may fault first still runs when it
            // does not.
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

    /**
     * @param {number} kind @param {number} vector
     * @param {number} [live]  the flags the code it leaves for reads before it writes them
     */
    exitWithKind(kind, vector, live = ARITH_FLAGS){
        if (this.x87.active)
        {
            x87Normalise(this);
        }
        if ((live & ARITH_FLAGS) !== 0)
        {
            this.payResult();
        }
        else
        {
            // Whoever runs next writes the six before reading one: the record
            // goes on empty, so the epilogue's read of it at every way out keeps
            // no field of it alive, nor its computation, across the loop the
            // way out sits in -- a jump back's spent budget, a store's page check.
            this.clearRecord();
        }
        // This way out has the owed lanes; the block's way on still owes them.
        this.settleLows(this.pendingLows.keys(), false);
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
            read[i] = (read[i] & ~kills) | flagsReadBy(instruction);
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
 * The blocks of a region in the order a structured function emits them, and
 * the loops that order holds as wasm loops.
 *
 * Address order is the compiler's layout, not the program's control flow: a
 * switch's cases laid after the loop's latch jump back to it, a callee laid
 * below its caller is reached by a jump back, and a loop entered at its test
 * at the bottom is jumped into from above -- each of those a jump back that
 * closes no loop, which as a wasm loop would widen the real ones into a nest
 * the code does not have. So the loops are the control flow's own: a jump to
 * a block that dominates it -- every way into the region reaches the jumper
 * through the target -- closes a natural loop, whose blocks are those that
 * reach the jump without passing its head. The ways in are the region's entry
 * and the return addresses of the calls that leave it, where the callee's
 * return comes back from outside: a loop with such a return inside it is
 * entered in its middle every turn -- through a copy of its blocks and the
 * entry hash back to its head (`emitCopies`), dearer than the flat dispatch's
 * one branch -- so it is no natural loop and its jumps back go through the
 * function's dispatch. The blocks are then emitted in a
 * topological order of the jumps that close no loop, a loop's blocks together
 * after its head, so that every other jump is a branch forward; ties go to
 * the block the last one falls through to, then to the lowest address.
 *
 * @param {import('../region.js').Region} region
 * @param {Map<number, number[]>} returns  by ret block, the return addresses it jumps to
 *     (`inlineReturns`)
 * @returns {{ order: number[], loops: Map<number, number>, reentered: number[] }}  order: the
 *     blocks as they are emitted, each by its index in `region.blocks`; loops: by the place
 *     in `order` of each loop's head, the place of its last block (a loop of one block only
 *     inside another: elsewhere the block's own loop onto itself, `selfLoop`, is all it
 *     needs); reentered: by index in `region.blocks`, blocks the runtime enters that may be
 *     inside a loop: the return addresses of the predicted indirect calls, which a call to
 *     another target comes back to from outside
 */
export function planStructure(region, returns, callReturn = false){
    const { blocks } = region;
    const index = new Map(blocks.map((block, i)=>[block.start, i]));
    /** @type {number[]} the blocks entered from outside the region besides its entry */
    const roots = [index.get(region.entry) ?? 0];
    /** @type {number[]} the return addresses of calls that leave only when they go elsewhere */
    const reentered = [];
    /** @type {number[][]} the blocks each jumps to inside the region, once each */
    const successors = blocks.map(block=>{
        /** @type {number[]} */
        const out = [];
        for (const target of jumpsOf(block, returns, callReturn, index))
        {
            const at = index.get(target);
            if (at !== undefined && !out.includes(at))
            {
                out.push(at);
            }
        }
        const back = comesBackTo(block, index);
        if (back !== undefined && !roots.includes(back))
        {
            roots.push(back);
        }
        const { kind, next, predicted } = block.exit;
        const last = block.instructions[block.instructions.length - 1];
        if (kind === 'indirect' && last?.op === 'call' && predicted === true)
        {
            const after = index.get(next);
            if (after !== undefined)
            {
                reentered.push(after);
            }
        }
        return out;
    });
    /** @param {number} at */
    const fallOf = at=>(['fallthrough', 'jcc', 'loop'].includes(blocks[at].exit.kind)
        ? index.get(blocks[at].exit.next) : undefined);
    return { ...structureOf(successors, roots, fallOf), reentered };
}

/**
 * The order and the loops of `planStructure` from the region's graph alone,
 * at either width: the loops are the natural loops of the jumps from the
 * roots, and the blocks are in a topological order of the jumps that close
 * no loop, a loop's blocks together after its head, ties going to the block
 * the last one falls through to, then to the lowest index.
 *
 * @param {number[][]} successors  by block, the blocks it jumps to inside the region, once each
 * @param {number[]} roots  the blocks entered from outside, the region's entry first
 * @param {(at: number) => number | undefined} fallOf  the block `at` falls through into, if any
 * @returns {{ order: number[], loops: Map<number, number> }}  as `planStructure`'s
 */
export function structureOf(successors, roots, fallOf){
    const count = successors.length;
    // With no jump back in address order but a block's onto itself there is
    // no loop of more than one block, and the address order is one the jumps
    // all go forward in: most regions, whose search below cost more than their
    // emitting.
    if (successors.every((to, from)=>to.every(at=>at >= from)))
    {
        return { order: successors.map((_, at)=>at), loops: new Map() };
    }
    const entry = roots[0];
    let graph = successors;
    let found = naturalLoops(graph, roots);
    // A region formed at a block in the middle of a loop -- a jump's target
    // that got hot first -- sees that loop begin at its entry, a loop around
    // the one the code has whenever every way back to the entry comes from
    // inside a loop of the region: the two, one of the code, turn by turn
    // through both heads. The entry is then taken as a block of that loop,
    // its way in a root above it (`virtual`) that goes where the entry goes,
    // and the loop has one head -- where the machine, running on from the
    // entry, comes into the region, as it does from any block of a loop
    // that has no copy.
    let virtual = -1;
    const around = found.bodies.get(entry);
    if (around !== undefined && found.predecessors[entry].every(p=>around.has(p))
        && [...found.bodies].some(([head, body])=>head !== entry
            && found.predecessors[entry].every(p=>body.has(p))))
    {
        virtual = count;
        graph = [...successors, successors[entry]];
        found = naturalLoops(graph, [virtual, ...roots.slice(1)]);
    }
    const { number, bodies } = found;
    const nodes = graph.length;
    // Each block's loops, innermost first: natural loops nest or are apart.
    /** @type {number[][]} */
    const loopsOf = graph.map(()=>[]);
    const heads = [...bodies.keys()].sort((a, b)=>(bodies.get(a)?.size ?? 0)
        - (bodies.get(b)?.size ?? 0));
    for (const head of heads)
    {
        for (const at of /** @type {Set<number>} */ (bodies.get(head)))
        {
            loopsOf[at].push(head);
        }
    }
    // The order: a block is ready once every block that jumps to it forward
    // is placed, and while a loop is open only its own blocks are taken.
    const waiting = new Int32Array(nodes);
    graph.forEach((to, from)=>{
        for (const at of to)
        {
            if (number[at] > number[from])
            {
                waiting[at]++;
            }
        }
    });
    /** @type {Set<number>} */
    const ready = new Set();
    graph.forEach((_, at)=>{
        if (waiting[at] === 0)
        {
            ready.add(at);
        }
    });
    /** @type {{ head: number, left: number }[]} */
    const open = [];
    /** @type {Set<number>} loops whose blocks the order could not keep together */
    const broken = new Set();
    /** @type {number[]} */
    const order = [];
    let last = -1;
    while (order.length < nodes)
    {
        const inner = open.length > 0 ? open[open.length - 1].head : -1;
        /** @param {number} at */
        const allowed = at=>inner < 0 || loopsOf[at].includes(inner);
        const fall = last >= 0 && last !== virtual ? fallOf(last) : undefined;
        let pick = -1;
        if (fall !== undefined && ready.has(fall) && allowed(fall))
        {
            pick = fall;
        }
        else
        {
            for (const at of ready)
            {
                if (allowed(at) && (pick < 0 || at < pick))
                {
                    pick = at;
                }
            }
        }
        if (pick < 0)
        {
            // Not met with natural loops; so that an order is always made.
            const loop = open.pop();
            if (loop === undefined)
            {
                throw new Error('emit: the blocks have no order');
            }
            broken.add(loop.head);
            continue;
        }
        ready.delete(pick);
        order.push(pick);
        last = pick;
        const body = bodies.get(pick);
        if (body !== undefined)
        {
            open.push({ head: pick, left: body.size });
        }
        for (const one of open)
        {
            if (loopsOf[pick].includes(one.head))
            {
                one.left--;
            }
        }
        while (open.length > 0 && open[open.length - 1].left === 0)
        {
            open.pop();
        }
        for (const at of graph[pick])
        {
            if (number[at] > number[pick] && --waiting[at] === 0)
            {
                ready.add(at);
            }
        }
    }
    const blockOrder = order.filter(at=>at !== virtual);
    const placed = new Int32Array(count).fill(-1);
    blockOrder.forEach((at, k)=>{
        placed[at] = k;
    });
    /** @type {Map<number, number>} */
    const loops = new Map();
    /** @type {number[]} */
    const ontoItself = [];
    for (const [head, body] of bodies)
    {
        if (broken.has(head) || head === virtual)
        {
            continue;
        }
        if (body.size < 2)
        {
            ontoItself.push(placed[head]);
            continue;
        }
        const first = placed[head];
        const end = first + body.size - 1;
        if ([...body].every(at=>placed[at] >= first && placed[at] <= end))
        {
            loops.set(first, end);
        }
    }
    // A loop of one block is the block's own loop onto itself (`selfLoop`),
    // and a loop here only inside another: there it is entered through that
    // loop's head, where as one of its blocks it would have no entry and the
    // machine, found standing in it when the region comes, would run it
    // interpreted to its end.
    for (const at of ontoItself)
    {
        if ([...loops].some(([lo, hi])=>lo < at && at <= hi))
        {
            loops.set(at, at);
        }
    }
    return { order: blockOrder, loops };
}

/**
 * The natural loops of a region's jumps (`planStructure`): a depth-first
 * search from the ways in, then from any block only the runtime enters, each
 * in address order, whose reverse finishing order numbers the blocks so that
 * only a jump to an ancestor goes back; the dominators under a root above
 * every way in -- a block a search starts from is one, dominated by nothing
 * of the region; and for each jump to a block that dominates the jumper, the
 * blocks that reach the jump without passing that head.
 *
 * @param {number[][]} successors  by block, the blocks it jumps to
 * @param {number[]} roots  the ways in
 * @returns {{ number: Int32Array, predecessors: number[][], bodies: Map<number, Set<number>> }}
 */
function naturalLoops(successors, roots){
    const count = successors.length;
    /** @type {number[]} */
    const finished = [];
    const state = new Uint8Array(count);
    const isRoot = new Uint8Array(count);
    for (const root of roots)
    {
        isRoot[root] = 1;
    }
    const starts = [...roots, ...successors.map((_, i)=>i)];
    for (const start of starts)
    {
        if (state[start] !== 0)
        {
            continue;
        }
        isRoot[start] = 1;
        /** @type {[number, number][]} */
        const stack = [[start, 0]];
        state[start] = 1;
        while (stack.length > 0)
        {
            const top = stack[stack.length - 1];
            const [at, k] = top;
            if (k < successors[at].length)
            {
                top[1]++;
                const to = successors[at][k];
                if (state[to] === 0)
                {
                    state[to] = 1;
                    stack.push([to, 0]);
                }
                continue;
            }
            state[at] = 2;
            finished.push(at);
            stack.pop();
        }
    }
    const rpo = finished.reverse();
    const number = new Int32Array(count);
    rpo.forEach((at, k)=>{
        number[at] = k;
    });
    /** @type {number[][]} */
    const predecessors = successors.map(()=>[]);
    successors.forEach((to, from)=>{
        for (const at of to)
        {
            predecessors[at].push(from);
        }
    });
    // The iterative algorithm over that numbering; -1 is the root above the ways in.
    const idom = new Int32Array(count).fill(-2);
    /** @param {number} a @param {number} b */
    const meet = (a, b)=>{
        let x = a;
        let y = b;
        while (x !== y)
        {
            if (x === -1 || y === -1)
            {
                return -1;
            }
            if (number[x] > number[y])
            {
                x = idom[x];
            }
            else
            {
                y = idom[y];
            }
        }
        return x;
    };
    for (const at of rpo)
    {
        if (isRoot[at] === 1)
        {
            idom[at] = -1;
        }
    }
    for (let changed = true; changed;)
    {
        changed = false;
        for (const at of rpo)
        {
            if (isRoot[at] === 1)
            {
                continue;
            }
            let dom = -2;
            for (const p of predecessors[at])
            {
                if (idom[p] !== -2)
                {
                    dom = dom === -2 ? p : meet(p, dom);
                }
            }
            if (dom !== idom[at])
            {
                idom[at] = dom;
                changed = true;
            }
        }
    }
    /** @param {number} a @param {number} b  whether a dominates b */
    const dominates = (a, b)=>{
        for (let at = b; at >= 0; at = idom[at])
        {
            if (at === a)
            {
                return true;
            }
        }
        return false;
    };
    /** @type {Map<number, Set<number>>} */
    const bodies = new Map();
    successors.forEach((to, from)=>{
        for (const head of to)
        {
            if (number[head] > number[from] || !dominates(head, from))
            {
                continue;
            }
            const body = bodies.get(head) ?? new Set([head]);
            bodies.set(head, body);
            const work = [from];
            while (work.length > 0)
            {
                const at = /** @type {number} */ (work.pop());
                if (body.has(at))
                {
                    continue;
                }
                body.add(at);
                work.push(...predecessors[at]);
            }
        }
    });
    return { number, predecessors, bodies };
}

/**
 * Where a block's way on goes inside its region, as the emitter jumps there:
 * its branches' targets, a switch's cases, a call's formed-in callee or a
 * predicted call's, the return addresses of a formed-in callee's `ret`, and
 * past a port write the host's call channel answers from inside the region.
 *
 * @param {import('../region.js').Block} block @param {Map<number, number[]>} returns
 * @param {boolean} [callReturn]  a call that leaves the region is a wasm call, its return
 *     address its way on
 * @param {Map<number, number>} [index]  the region's blocks by start, with `callReturn`
 * @returns {number[]} addresses, some perhaps outside the region
 */
function jumpsOf(block, returns, callReturn = false, index = new Map()){
    const { kind, targets, next, table, predicted } = block.exit;
    // A call whose callee is formed in jumps there and its `ret` jumps back
    // (`returns`): its return address is no way on of its own, and an edge to
    // it could make the callee's first block one inside a loop, with no entry
    // for the callers in other regions.
    if (callReturn && callsOut(block, index))
    {
        return [...targets, next];
    }
    if (kind === 'fallthrough' || kind === 'jump' || kind === 'call'
        || kind === 'indirect' && (table !== undefined || predicted))
    {
        return targets;
    }
    if (kind === 'jcc' || kind === 'loop')
    {
        return [...targets, next];
    }
    if (kind === 'trap')
    {
        return [next];
    }
    return kind === 'ret' ? returns.get(block.start) ?? [] : [];
}

/**
 * The block a way out of this one comes back to from outside the region on
 * every turn, if any: the return address of a call that always leaves it -- a
 * direct call whose callee is not formed in, an indirect one no prediction
 * formed a callee of in -- and the address after a port write, where the host
 * resumes a program whose handler it did not run from inside the region. A
 * predicted call's return comes back from outside only when the call went
 * elsewhere, which its copy takes (`emitCopies`).
 *
 * @param {import('../region.js').Block} block @param {Map<number, number>} index
 * @returns {number | undefined}  the block's index
 */
function comesBackTo(block, index){
    const { kind, targets, next, predicted } = block.exit;
    const last = block.instructions[block.instructions.length - 1];
    const leaves = kind === 'call' ? !index.has(targets[0])
        : kind === 'trap' || kind === 'indirect' && last?.op === 'call'
            && !(predicted === true && targets.some(target=>index.has(target)));
    return leaves ? index.get(next) : undefined;
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
        liveAfter = liveBefore(instruction, liveAfter, precise);
    }
    return live;
}

/**
 * The flags live before an instruction, from those live after it.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 * @param {number} after @param {boolean} precise
 */
function liveBefore(instruction, after, precise){
    const count = shiftCount(instruction);
    return count === 0 ? after
        : (after & ~killedBy(instruction, precise, count)) | flagsReadBy(instruction);
}

/**
 * The flags an instruction reads, as the liveness passes take them: a divide
 * reads them all, as the divide fault it may raise hands the handler the
 * flags word whole -- a handler that does not resume the same code, so a
 * record the code after it overwrites is not the translator's to drop.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
const flagsReadBy = instruction=>(instruction.faults === 'divide'
    ? instruction.flagsRead | ARITH_FLAGS : instruction.flagsRead);

/**
 * The flags an instruction leaves no earlier record's value in. A shift or
 * rotate by cl may write none, and so may a repeated compare or scan, which
 * with ecx zero runs no iteration and leaves the flags as they were: the
 * `je` after a `repe cmpsb` of no bytes reads the flags of what came before.
 * Precisely, only a defined write: the emulator
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
    if (count === -1 || repeatedCompare(instruction))
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

/** The longest block a hoisted loop's unchecked copy runs two turns a wasm turn. */
const PAIRED_MAX = 32;

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
        if (count === 0 || count === -1 || repeatedCompare(instruction))
        {
            continue;
        }
        undefinedNow = (undefinedNow & ~instruction.flagsWritten) | instruction.flagsUndefined;
    }
}

const SHIFT_OPS = new Set(['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar', 'shld', 'shrd']);

/**
 * A `rep` or `repne` compare or scan: whether it writes the flags is ecx's to say.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
const repeatedCompare = instruction=>(instruction.op === 'cmps' || instruction.op === 'scas')
    && (instruction.prefixes.rep === true || instruction.prefixes.repne === true);

/**
 * The count of a shift or rotate masked to five bits, six for a 64-bit
 * operand, -1 when it is in cl, null for any other instruction. `rcl` and
 * `rcr` of a byte or a word by 9 or 17 still write flags: the processor
 * leaves them only when the masked count is zero.
 *
 * @param {import('../decode/decoder.js').Instruction} instruction
 */
function shiftCount(instruction){
    if (!SHIFT_OPS.has(instruction.op))
    {
        return null;
    }
    const count = instruction.operands[instruction.operands.length - 1];
    if (count.kind !== 'imm')
    {
        return -1;
    }
    return /** @type {number} */ (count.value) & (instruction.size === 8 ? 63 : 31);
}
