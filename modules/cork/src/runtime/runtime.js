/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime: what the core's cpu layer composes into its hybrid host.
 *
 * Candidates arrive from the layer's sampler (`noteHot`); `translatePending`
 * forms a region at each, emits them into one wasm module of up to
 * `batchRegions` functions sharing the memory import and the helpers,
 * instantiates it asynchronously and publishes every block start as an
 * entry. The host asks `entryOf(eip)` before each turn and `run`s the entry
 * with the slice's remaining budget; the region adds what it retired to the
 * layout's counter word, so the layer's instruction count and sampler need
 * nothing new.
 *
 * A store into a page holding translated code leaves `stale`; the page's
 * regions are dropped, and a page dropped too often is marked volatile and
 * never translated again. A region is stamped with its pages' generation at
 * formation and dropped at publication when an invalidation moved one of
 * them in between; one the guest ran past before its publication (its store
 * lookups out, its batch on the worker) is hashed again as well, since a page
 * with no code published on it moves no generation. So a batch never
 * publishes code for bytes that changed while it was being compiled.
 */

import { emptyCode, formRegion, formShared, hashRegion } from '../region.js';
import { TIER_SLOT, enterRegion, mathImports } from '../emit/region.js';
import { decode } from '../decode/decoder.js';
import { NanRecord, RANGE, SHAPE, isX87, trackRegion } from '../emit/x87.js';
import { HELD, PRECISION } from '../emit/memory.js';
import { features as probeFeatures } from '../wasm/features.js';
import { Body, ModuleBuilder, ValType } from '../wasm/encoder.js';
import { SHARED_MAX_PAGES } from '../wasm/shared-import.js';
import { arenaEmitCache, createEmitCache, emitBatch, relinkBatch } from './emit-built.js';
import { createArena, openArena } from './arena.js';
import { buildHelpersModule } from '../emit/helpers.js';
import { openTranslationWorker } from './translator.js';
import { ANY_TOP, createEntries } from './entries.js';
import { PageFlag, createPageTable } from './pages.js';
import { createSharedCode } from './shared-code.js';
import { Tables, tablesSize } from './layout.js';
import { blockCounts, mechanismCounts, resetBlockCounts, topBlocks, transferTargets }
    from './block-profile.js';
import { profileForms } from './profile-forms.js';
import { createWeakInstances } from './weak-instances.js';
import {
    CACHE_VERSION, cacheKey, moduleKey, packRegion, seedRecords, unpackRegion,
} from './cache.js';

/** @typedef {import('../../../core/src/layers/cpu/engine.js').EngineEnv} EngineEnv */
/** @typedef {import('../../../core/src/layers/cpu/engine.js').Runtime} Runtime */
/** @typedef {import('../../../core/src/layers/cpu/engine.js').ExitKind} ExitKind */
/** @typedef {import('../emit/region.js').X87Precision} X87Precision */

/** @param {import('../region.js').Region} region */
const usesX87 = region=>region.blocks.some(block=>block.instructions.some(isX87));

/** A profiling run's hot forms (`hotForms`): the regions emitted again for them at most, the
 * share of the counted executions they stop at, and how long an answer stands. */
const FORMS_REGIONS = 300;
const FORMS_SHARE = 0.95;
const FORMS_EVERY_MS = 30_000;

/** Exit codes by number, as the region functions answer them. */
const KINDS = /** @type {ExitKind[]} */ (
    ['untranslated', 'budget', 'trap', 'halt', 'fault', 'stale', 'interpreted',
        // `RETURNED` goes to a region's own wasm call, never to the host; were it
        // to arrive, the state block is whole and the run goes on at its EIP.
        'untranslated']);


/** @type {Function | null} */
let noTier = null;
/**
 * What the table's `TIER_SLOT` holds until the host puts the interpreter tier's
 * entry there (`interpretWith`): a function answering 0, which a miss of the
 * hash takes as no tier and leaves as before. One a process.
 */
function noTierEntry(){
    if (noTier === null)
    {
        const m = new ModuleBuilder();
        const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
        m.function(type, [], new Body().i32const(0).toBytes(), { exportAs: 'none' });
        const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (m.toBytes());
        noTier = /** @type {Function} */ (
            new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.none);
    }
    return noTier;
}

/**
 * Under `precise`, a NaN hunt's record (`layout.nanFirst`): the first x87 NaN
 * translated code made from numbers, from what, and how many; the first stack
 * fault; the first arithmetic with a NaN result; the first NaN read from memory
 * and the first stored there.
 *
 * @param {DataView} view
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 */
function nanFirst(view, layout){
    const at = layout.nanFirst ?? -1;
    if (at < 0)
    {
        return {};
    }
    const word = (/** @type {number} */ offset)=>view.getUint32(at + offset, true);
    const hex = (/** @type {number} */ offset)=>`0x${word(offset).toString(16)}`;
    /** @param {number} slot */
    const first = slot=>({ eip: hex(slot), count: word(slot + 4),
        order: word(NanRecord.orderOf[slot]) });
    /** @type {Record<string, any>} */
    const out = {};
    if (word(NanRecord.MADE + 4) > 0)
    {
        out.nanFirst = { ...first(NanRecord.MADE), a: view.getFloat64(at + NanRecord.MADE_A, true),
            c: view.getFloat64(at + NanRecord.MADE_C, true) };
    }
    if (word(NanRecord.FAULT + 4) > 0)
    {
        // A register read empty or a push onto a held one: the indefinite, a NaN, follows.
        const r = NanRecord.FAULT_REGION;
        out.stackFaultFirst = { ...first(NanRecord.FAULT), region: hex(r), entryTop: word(r + 4),
            empty: hex(r + 8), top: word(r + 12) };
    }
    if (word(NanRecord.RESULT + 4) > 0)
    {
        // Any arithmetic whose result was a NaN, made or carried from an operand.
        out.nanResultFirst = first(NanRecord.RESULT);
    }
    if (word(NanRecord.LOAD + 4) > 0)
    {
        out.nanLoadFirst = { ...first(NanRecord.LOAD), from: hex(NanRecord.LOAD + 8) };
    }
    if (word(NanRecord.STORE + 4) > 0)
    {
        out.nanStoreFirst = { ...first(NanRecord.STORE), to: hex(NanRecord.STORE + 8) };
    }
    return out;
}

/**
 * The translation worker's file, beside this one, as a host opens it for a
 * pool of its own; null where it cannot be named (a bundler that did not carry
 * the file).
 *
 * @returns {string | null}
 */
export function translatorWorkerUrl(){
    try
    {
        return new URL('./translator.worker.js', import.meta.url).href;
    }
    catch {
        return null;
    }
}

/**
 * @param {EngineEnv & { features?: ReturnType<typeof probeFeatures> }} env
 * @returns {Runtime & { pages: import('./pages.js').PageTable }}
 */
export function createCorkRuntime({ memory, layout, config = {}, read, readBytes, imports,
    features })
{
    const settings = {
        maxRegionBlocks: 128, maxRegionBytes: 8192, batchRegions: 32,
        maxQueued: 8192, maxBatchRegions: 256,
        // Writes that drop a page's regions, inside `volatileWindowMs` of each
        // other, before the page is left to the other executor -- for
        // `volatileHoldMs`, twice as long each time it is left again: a mixer
        // patching a voice in as a sound starts writes its code a few times a
        // second for as long as the program runs, and a page left for good
        // after its eighth sound ran interpreted from then on. The interpreter
        // runs MMX code hundreds of times slower than its translation, so a
        // page is left only when it is rewritten about as fast as it can be
        // translated again: eighty times a second.
        volatileAfter: 8,
        volatileWindowMs: 100,
        volatileHoldMs: 2000,
        // Untranslated exits to one address before it is a candidate of the
        // translator's own: the slice sampler sees only where budgets run
        // out, and a stub reached through such exits alone never appears there.
        missThreshold: 64,
        // Test-only: a run with the translator off, so the whole program is
        // the interpreter tier's and the corpus can judge it alone.
        translate: true,
        undoLog: false,
        countTransfers: false,
        // Diagnostic: every block counts its executions in the block profile past
        // the tables -- only in a memory the host sized for it (cork's own layout)
        // -- and the diagnostics name the counts. Such a run keeps no store.
        blockProfile: false,
        // With `blockProfile`: seconds after the runtime is made at which the
        // counts start over, so a profile holds a steady state and not the load.
        blockProfileFrom: 0,
        // Diagnostic: every store key put and every one missed, as
        // `entry:hash:top`, in the diagnostics -- what tells two runs' keys apart.
        traceStore: false,
        // Diagnostic: the regions still published whose bytes no longer form
        // as they did -- translated code a write left standing -- in the
        // diagnostics (`staleRegions`), formed again when they are asked for.
        checkStale: false,
        // Diagnostic: addresses in [from, to) are left to the interpreter.
        interpretRange: /** @type {[number, number] | null} */ (null),
        // Batch modules published before the running regions are gathered into
        // big ones (0: never), and how many regions go into each of those:
        // a tail call into another module costs more the more modules there are,
        // but the engine thread instantiates each one whole -- 4096 regions of
        // a real title held it for 160 ms, 512 for 23 -- and a stall that long is
        // a frame lost and a sound mixer late.
        relinkAfter: 16,
        relinkRegions: 512,
        // A small leaf callee formed into its caller, the call and its return
        // jumps inside the region (false: every call crosses regions).
        leafCalls: true,
        // A direct call to a compiler's runtime helper recognised by its bytes
        // (MSVC's _ftol2) formed as the instructions it amounts to (false:
        // every such call runs the helper's own code; helpers.js).
        runtimeHelpers: true,
        // Indirect calls sampled while the translator runs, and a region whose
        // indirect call keeps going to a few small leaf callees formed again
        // with them in it: the call compares its target with each and jumps
        // (false: every indirect call leaves its region). Off unless asked:
        // the benchmarks' virtual and indirect calls run four to five times
        // faster with it, but games run on real hardware, from their start to
        // a menu, lost more than half the canvas's frame rate with it and
        // `dispatch` on, froze frames past 250 ms and repeated their audio,
        // and what it costs them is not found yet.
        callTargets: false,
        // Transfers from one module's regions into another's before the two
        // are gathered into one module on the translation worker (0: never;
        // never without a worker): a relink's cost against the direct tail
        // calls it buys.
        mergeAfter: 1 << 16,
        // Each module is placed in a range of the table, and a transfer to a
        // function of the same module is a direct tail call, the table's
        // indirect one only another module's (false: every transfer through
        // the table). Off unless asked: the benchmarks gain at most a few per
        // cent from it, and in the games `callTargets` names one still ran at
        // 57 % of the frame rate it had with neither when this one alone was on.
        dispatch: false,
        // A call out of a region a wasm call, and the region going on after the
        // `ret` that comes back to it, rather than a transfer through the entry
        // hash each way (`callAndReturn` in emit/integer.js).
        callReturn: true,
        // An entry that is a function doing nothing -- a `ret`, after a thunk's
        // jumps (`emptyCode` in region.js) -- marked in the entry hash, so a call
        // to it returns from the transfer without entering its region
        // (`finishModule` in emit/region.js; false: entered as any other).
        emptyCalls: true,
        // With it, a call out of a region reads its target's slot first and
        // returns from such a function in place, without calling the transfer
        // (`callAndReturn` in emit/integer.js).
        emptySites: false,
        // Each x87 region compiled for the precision control it runs under --
        // the wide ones (double, extended) or single -- a block testing
        // precision control once rather than every operation rounding by it;
        // a region seen under both tests at every such operation (false: every
        // region tests from the start).
        wideFirst: true,
        // A region compiled for single precision computes its x87 arithmetic
        // on floats in f32 where the operands are floats (`Singles` in
        // emit/x87.js): the 24-bit result in one operation, where rounding a
        // double's took four after it. A region whose results keep leaving the
        // float's range is translated again rounding them (false: always).
        floatSingles: true,
        // x87 regions compiled for the stack's shape at their entries -- which
        // registers are held and which empty -- tested once at an entry rather
        // than at every instruction; a region whose test fails `checkedAfter`
        // times is translated again with no test and the checks inside
        // (false: every region so from the start).
        x87Shapes: true,
        checkedAfter: 4,
        // A region's loops as wasm loops, the loops of its control flow
        // (`planStructure`), a block inside one entered through a copy of its
        // own (false: every backward jump through the region's dispatch).
        structure: true,
        // Everything the translator relaxes for speed kept exact instead: the x87
        // exception flags and their tests, signalling NaNs, underflow and C1, and
        // the flags an instruction leaves undefined -- off, what the cheapest code
        // leaves there; on, what the emulator leaves. Off, as games run: the tests and
        // the hardware corpus turn it on.
        precise: false,
        // Whether an instruction that only reads tests its pages as a store
        // does, so a page the program cannot read -- a reservation not
        // committed, one protected PAGE_NOACCESS -- faults as on Windows. Left
        // unset, reads are wrapped into RAM (one `and` for a shift, a load and
        // a branch) until the program first touches such a page where it is
        // tested -- the interpreter, a store -- and tested from then on
        // (`readsFaulted`): a program that never goes near one pays nothing.
        // True tests from the start, false never.
        checkReads: undefined,
        // Locked instructions as wasm atomics, each one indivisible on the shared
        // memory: for a process whose threads run on more than one executor
        // (roadmap/v2, stage 3). Off, a process on one executor pays nothing.
        atomic: false,
        // Where the process's record of shared code lies and which executor this
        // runtime is (`shared-code.js`), when other executors share its page flags;
        // null for a process on one.
        sharedCode: /** @type {{ at: number, index: number } | null} */ (null),
        // A store through esp alone tests no page while no translated code lies
        // on a thread's stack (`noteStack`), which the runtime then switches off
        // for good: a stack holds no code unless a program runs code there.
        looseStacks: true,
        // How long a batch may be with the worker, on time the engine thread was
        // free to hear its answer, before it is given up (tests shorten it).
        inFlightMs: 10_000,
        // Translation workers the runtime opens itself, each with a batch of its
        // own out: a loading phase keeps one busy most of the time with work
        // queued behind its batch. 0 with a worker: none opened here, a host's
        // pool lends them (`attachTranslator`).
        translators: 1,
        // Bytes of the translation cache arena, the functions emitted here and
        // by every translator, which each takes again rather than emitting
        // (0: each keeps a cache of its own). Shared memory is committed as
        // it fills.
        arenaBytes: 48 << 20,
        // Diagnostic: the host clock read around the translator's phases -- the
        // milliseconds of forming, lookups, emitting, encoding, storing,
        // instantiating and publishing, and the record of long holds. Off, as a
        // shipped build runs, the clock is read only where the translator needs
        // it (a batch that never comes back is freed after a time).
        timings: false,
        // While the translation worker loads: the largest batch emitted on the
        // engine thread, and the share of the time since the worker was made
        // that emitting there may take.
        loadingBatch: 16,
        loadingShare: 0.25,
        // The engine thread's time the translator's work may take at a
        // stretch, and the share of its time over a while, where a worker is
        // wanted: a batch goes on forming in the calls after, the store's
        // hits are compiled off the thread, they and a worker's answers are
        // published a share's worth a call, and a call that finds the share
        // spent does nothing until it has come back (0: a batch formed and
        // published whole in the call that takes it or answers it). A program
        // reaching code it had not run held the thread for batches formed
        // whole, a tenth of a second at a time in the runs measured -- frames
        // the guest did not run, its sound late -- where the translation is
        // the one to wait.
        holdMs: 4,
        holdShare: 0.5,
        // The bounded records the runtime keeps of where translated code left and
        // what missed: targets of untranslated exits, misses per (address, top)
        // before a candidate, and indirect call sites tried with predicted callees.
        exitTargets: 4096,
        missesKept: 4096,
        callSitesKept: 16384,
        // Merging modules a hot transfer crosses (`mergeAfter`): translated
        // instructions between two readings of the crossings, the fewest between
        // two merges, a region's share of that, and merges one region may take part in.
        mergeSample: 1 << 20,
        mergeEvery: 1 << 23,
        mergePerRegion: 1 << 19,
        mergesARegion: 2,
        // Indirect-call prediction (`callTargets`): samples of a call before its
        // callees are looked at, the share of them a callee formed in must take
        // (one in this many), callees a call compares with, how often a region is
        // formed again for its calls, and the window a call's samples are counted in.
        predictAfter: 48,
        predictShare: 8,
        predictCallees: 4,
        reforms: 3,
        // At a few hundred readings a second, 64 was a fifth of a second: a
        // site taking one call in a hundred gathered ten samples in it and
        // never came due.
        callWindow: 1024,
        // The entry hash's load past which a block start is kept in the host's
        // map alone (its slots are the layout's, `hashSlots`).
        hashLoad: 0.75,
        // A callee formed into its caller (`leafCalls`): its blocks and bytes at
        // most; and the most entries of a switch's jump table followed when forming.
        leafBlocks: 16,
        leafBytes: 512,
        // Levels of callees formed in that may keep direct calls of their own,
        // their small callees formed in as well (`formRegion`).
        formDepth: 1,
        switchEntries: 1024,
        ...config,
    };
    // The version translations are kept under: the translator's own, or a higher one
    // the host asks for, which empties every store of a lower version. Never lower
    // than the emitter's -- a record of an older emitter is code that is wrong now.
    const cacheVersion = Math.max(CACHE_VERSION, config.cacheVersion ?? 0);
    /** The host clock for a diagnostic timing, or zero when timings are off. */
    const clock = import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.timings === true
        ? ()=>performance.now() : ()=>0;
    /**
     * The precision control each x87 region is compiled for, by its entry
     * (`X87Precision`): the one the machine has when the entry is first formed
     * -- single, as Direct3D leaves it, or a wide one -- then, once a region
     * there left because it ran under the other, that one, and after a second
     * such leave a test at every rounding instruction (`mixed`). A program
     * that runs one part of its code under single and another under double --
     * a renderer and a physics library -- keeps each part compiled for its
     * own, where one switch for the whole program put every x87 region of it
     * under the test once both were seen.
     * @type {Map<number, { precision: X87Precision, misses: number }>}
     */
    const precisionAt = new Map();
    /**
     * The precision control a formed region's x87 is compiled for (`precisionAt`),
     * the machine's for an entry not yet seen; `mixed` without `wideFirst`, and for a
     * region with no x87 in it, which tests nothing.
     *
     * @param {import('../region.js').Region} region
     * @returns {X87Precision}
     */
    const precisionOf = region=>{
        if (settings.wideFirst !== true || !usesX87(region))
        {
            return 'mixed';
        }
        let known = precisionAt.get(region.entry);
        if (known === undefined)
        {
            const single = (view().getUint16(layout.x87Control, true) & 0x300) === 0;
            known = { precision: /** @type {X87Precision} */ (single ? 'narrow' : 'wide'),
                misses: 0 };
            precisionAt.set(region.entry, known);
        }
        return known.precision;
    };
    /** The x87 entries by the precision control they are compiled for. */
    const precisionCounts = ()=>{
        const counted = { wide: 0, narrow: 0, mixed: 0 };
        for (const { precision } of precisionAt.values())
        {
            counted[precision]++;
        }
        return counted;
    };
    /**
     * The entries, by `keyOf`, whose single-precision results kept leaving a float's range
     * (`RANGE`): compiled for single, they round every result from a double.
     * @type {Set<number>}
     */
    const roundedKeys = new Set();
    /**
     * A formed region's precision as a job and a record carry it, and whether its
     * single-precision arithmetic runs on floats (`floatSingles`).
     *
     * @param {import('../region.js').Region} region @param {number} entryTop
     */
    const precisionFlags = (region, entryTop)=>{
        const precision = precisionOf(region);
        return { wide: precision === 'wide', narrow: precision === 'narrow',
            floats: precision === 'narrow' && settings.floatSingles !== false
                && !roundedKeys.has(keyOf(region.entry, entryTop)) };
    };
    /**
     * What a job's emitter is told of its precision: nothing for `mixed`, the
     * emitter's default.
     *
     * @param {{ wide?: boolean, narrow?: boolean, floats?: boolean }} one
     */
    const precisionJob = one=>(one.wide === true ? { precision: /** @type {const} */ ('wide') }
        : one.narrow === true ? { precision: /** @type {const} */ ('narrow'),
            ...(one.floats === true ? { floats: true } : {}) } : {});
    /**
     * Whether regions test the pages they read (`checkReads`): from the
     * start when asked, or from the program's first fault on a page it cannot
     * reach.
     */
    let readsChecked = settings.checkReads === true;
    /** Whether regions are made loose (`looseStacks`): until code is translated on a stack. */
    let loose = settings.looseStacks !== false && settings.precise !== true
        && settings.undoLog !== true;
    /** The pages of the threads' stacks the host named (`noteStack`). @type {Set<number>} */
    const stackPages = new Set();
    /** How a region is formed, the same on this thread, in a batch and in a relink. */
    const formOptions = { maxBlocks: settings.maxRegionBlocks,
        maxBytes: settings.maxRegionBytes, leafCalls: settings.leafCalls,
        helpers: settings.runtimeHelpers !== false, leafBlocks: settings.leafBlocks,
        leafBytes: settings.leafBytes, switchEntries: settings.switchEntries,
        formDepth: settings.formDepth };
    /** The same on this thread, with the host's copy of a span at once where it has one; a
     * worker is sent `formOptions`, which a function cannot cross in. */
    const formHere = readBytes === undefined ? formOptions
        : { ...formOptions, bytesOf: readBytes };
    /** @type {Set<string>} instruction classes left to the other executor */
    const leaveOut = new Set(settings.leaveOut ?? []);
    if (layout.tables + tablesSize(layout) > memory.buffer.byteLength)
    {
        throw new Error(`cork: the memory ends at ${memory.buffer.byteLength}, before the tables`
            + ` at ${layout.tables} + ${tablesSize(layout)}`);
    }
    const found = features ?? probeFeatures();
    // A shared memory links only to modules whose import says so, with a
    // maximum: every module emitted here, and the helpers, declare it.
    const sharedMemory = typeof SharedArrayBuffer === 'function'
        && memory.buffer instanceof SharedArrayBuffer
        ? { shared: true, maxPages: SHARED_MAX_PAGES }
        : undefined;
    const codeShared = settings.sharedCode
        ? createSharedCode(memory, settings.sharedCode.at, settings.sharedCode.index) : null;
    const pages = createPageTable(memory, layout, codeShared);
    // The five helper functions every region imports, defined once here and
    // instantiated over this memory when the first region is published.
    /** @type {any} */
    let helperInstance = null;
    const helperImports = ()=>{
        if (helperInstance === null)
        {
            const module = new WebAssembly.Module(
                /** @type {Uint8Array<ArrayBuffer>} */ (buildHelpersModule(layout, sharedMemory)));
            helperInstance = new WebAssembly.Instance(module, { env: { memory } }).exports;
        }
        return /** @type {any} */ (helperInstance);
    };
    // With tail calls, every region function goes into one table shared by
    // every module, and every entry into the hash translated code probes:
    // a return or an indirect jump into translated code then transfers
    // without leaving wasm. Without them, the slice loop is the only way
    // between regions.
    const table = found.tailCalls
        ? new WebAssembly.Table({ element: 'anyfunc', initial: 256 })
        : null;
    // Under cork's own layout a miss of the hash may run the interpreter tier
    // in wasm through the table (`interpretWith`); its slot is no region's.
    const resumable = table !== null && (layout.flagRecord ?? -1) >= 0;
    if (resumable)
    {
        table.set(TIER_SLOT, noTierEntry());
    }
    /** What the tier has retired in place of misses, all told, once it is installed: not
     * the translator's own share. @type {(() => number) | null} */
    let tierEntered = null;
    /** @type {number[]} table indices of dropped regions, reused where modules are not
     * placed: a placed module's range is its own until its last region goes (`placeModule`) */
    const freeTable = [];
    /** The ranges of placed modules whose regions have all gone, for others to take.
     * @type {{ base: number, arms: number }[]} */
    const freeRanges = [];
    /**
     * A module placed in the table (`placeModule`): its range's start and
     * length, its counts of what left it through the table, and its running
     * regions.
     *
     * @typedef {{ base: number, arms: number, crossings: WebAssembly.Global,
     *     crossedTo: WebAssembly.Global, seen: number, records: Set<RegionRecord>,
     *     toward: Map<Placed, number>, instance: WebAssembly.Instance,
     *     baseGlobal: WebAssembly.Global }} Placed
     *   seen: `crossings` when last read; toward: crossings into each other module
     */
    /** @type {WeakMap<WebAssembly.Instance, Placed>} */
    const placedOf = new WeakMap();
    /** The placed modules with running regions. @type {Set<Placed>} */
    const placedLive = new Set();
    /** The running region at each table index. @type {Map<number, RegionRecord>} */
    const recordAt = new Map();
    const entries = createEntries(
        table
            ? { memory, hashBase: layout.tables + Tables.HASH, shift: layout.hashShift ?? 16,
                load: settings.hashLoad }
            : {});
    if (table)
    {
        imports.handoffHash?.(layout.tables + Tables.HASH - layout.ramBase);
    }
    /** The queue, miss and barren key: one address at one x87 top. Every
     * "has an entry" question is for a top, so a region compiled for another
     * top is no answer. @param {number} eip @param {number} top */
    const keyOf = (eip, top)=>eip * 16 + top;
    /** @type {Map<number, number>} candidates not yet formed: key(eip, top) → eip */
    const queue = new Map();
    /** The candidates by heat: bucket b holds the ones whose heat (the
     * interpreter's visit count under cork, 0 from the sampler) is in
     * [2^b, 2^(b+1)), the last bucket everything from 256 up; each in arrival
     * order. A batch takes the hottest first, so a loader's run-twice code
     * waits behind the loop it ran a thousand times, and the queue is capped:
     * past `maxQueued` the coldest, oldest candidate is evicted -- the
     * interpreter keeps counting it and notes it again should it get hot.
     * @type {Map<number, number>[]} */
    const buckets = Array.from({ length: 9 }, ()=>new Map());
    /** The bucket from which a waiting candidate is hot (met eight times or more while it waits). */
    const HOT_BUCKET = 3;
    /** @type {Map<number, number>} key → its bucket */
    const heatOf = new Map();
    /** @param {number} hotness */
    const bucketOf = hotness=>{
        let b = 0;
        let h = hotness >>> 1;
        while (h > 0 && b < 8)
        {
            b++;
            h >>>= 1;
        }
        return b;
    };
    /** Removes a candidate from the queue and its bucket. @param {number} key */
    const unqueue = key=>{
        queue.delete(key);
        const b = heatOf.get(key);
        if (b !== undefined)
        {
            buckets[b].delete(key);
            heatOf.delete(key);
        }
    };
    /** Adds a candidate at its heat, evicting the coldest when the queue is full.
     * @param {number} key @param {number} eip @param {number} hotness */
    const enqueue = (key, eip, hotness)=>{
        if (queue.size >= settings.maxQueued)
        {
            for (const bucket of buckets)
            {
                if (bucket.size > 0)
                {
                    const [oldest] = bucket.keys();
                    unqueue(oldest);
                    dropKey(oldest);
                    counts.queueEvictions++;
                    break;
                }
            }
        }
        const b = bucketOf(hotness);
        queue.set(key, eip);
        buckets[b].set(key, eip);
        heatOf.set(key, b);
        noteKey(key);
    };
    /** @type {Map<number, number>} key(eip, top) → eip of a candidate a region
     * formed nothing at, until its page moves. Per top: a region that formed
     * nothing at one top says nothing about a region for another -- the entry
     * block a top compiles empty is emptiness for that top alone. */
    const barren = new Map();
    /** @type {Map<number, Set<number>>} page → the queue/barren keys on it.
     * A host write invalidates its page every time, and copying two whole maps
     * per write (a loading run's writes are thousands a second) was the cost;
     * this clears a page's own keys instead. */
    const pageKeys = new Map();
    /**
     * Whether a write into a page is anything to the translator, a byte a page
     * of the address space: `WATCH_REGIONS` while a published region spans it
     * (`byPage`), `WATCH_KEYS` while a candidate or a barren address is filed
     * under it (`pageKeys`). The host invalidates every page it writes, and
     * nearly every such write is a call's answer into a stack or a buffer
     * where neither is: `invalidatePage` passes those over on this byte alone,
     * where it looked in three maps and moved the page's generation. That
     * generation is only read at a publication, of a region formed over the
     * page and published later, which the guest ran past meanwhile -- and such
     * a region is hashed again then, as for a guest store the page's code did
     * not watch.
     */
    const watched = new Uint8Array(1 << 20);
    const WATCH_REGIONS = 1;
    const WATCH_KEYS = 2;
    /** @param {number} key */
    // A key is eip * 16 + top, past 2^32 for an address above 256 MB, so its
    // page is a division rather than a shift, which would wrap there.
    const pageOfKey = key=>Math.floor(key / 65536);
    /** @param {number} key */
    const noteKey = key=>{
        const page = pageOfKey(key);
        let keys = pageKeys.get(page);
        if (!keys)
        {
            keys = new Set();
            pageKeys.set(page, keys);
            watched[page] |= WATCH_KEYS;
        }
        keys.add(key);
    };
    /** @param {number} key */
    const dropKey = key=>{
        const page = pageOfKey(key);
        const keys = pageKeys.get(page);
        if (keys)
        {
            keys.delete(key);
            if (keys.size === 0)
            {
                pageKeys.delete(page);
                watched[page] &= ~WATCH_KEYS;
            }
        }
    };
    /** Whether a candidate at this address is barren for this top.
     * @param {number} eip @param {number} top */
    const barrenHas = (eip, top)=>barren.has(keyOf(eip, top & 7));
    /** @param {number} eip @param {number} top */
    const barrenAdd = (eip, top)=>{
        if (top === ANY_TOP)
        {
            // A region indifferent to the stack is empty for every top.
            for (let t = 0; t < 8; t++)
            {
                const key = keyOf(eip, t);
                barren.set(key, eip);
                noteKey(key);
            }
            return;
        }
        const key = keyOf(eip, top & 7);
        barren.set(key, eip);
        noteKey(key);
    };
    /** Whether any top at this address is barren, for the diagnostics.
     * @param {number} eip */
    const barrenAt = eip=>{
        for (let top = 0; top < 8; top++)
        {
            if (barren.has(keyOf(eip, top)))
            {
                return true;
            }
        }
        return false;
    };
    /** @type {Map<number, number>} untranslated exits by target and top: a
     * count per key(eip, top), so misses at one top never stand in for
     * another's threshold. Keyed to the address for the histogram. */
    const misses = new Map();
    // The untranslated exits by target address over the whole run, for the
    // diagnostics' histogram: the misses are forgotten when they become
    // candidates, but what the translator never reached is exactly what this
    // is read for. Bounded like `misses`; the coldest target makes room. With
    // the count, the tops its exits were at, a bit each.
    /** @type {Map<number, { count: number, held: number, tops: number }>} */
    const exitTargets = new Map();
    const EXIT_TARGETS_CAP = settings.exitTargets;
    /**
     * How often the machine stood at an address that has a region for another
     * top (or a block with no entry of its own), per key(eip, top): the heat a
     * variant is noted with, so one the machine keeps arriving at climbs the
     * queue rather than waiting in its bottom bucket behind a loader's cold
     * starts while its code runs interpreted. Cleared past a cap.
     * @type {Map<number, number>}
     */
    const variantHeat = new Map();
    // How many addresses the untranslated-exit count holds at once. A real
    // program leaves for millions of addresses and the map filled in seconds;
    // the old rule stopped recording new ones once it did, so no address
    // reached after the fill could ever climb to the threshold and a
    // straight-line loader never became a candidate. The oldest is evicted
    // instead, and the counts halve every cap insertions so an address hit
    // once does not hold a slot against one hit often.
    const MISSES_CAP = settings.missesKept;
    let missesInserted = 0;
    const decayMisses = ()=>{
        for (const [key, count] of misses)
        {
            if (count <= 1)
            {
                misses.delete(key);
            }
            else
            {
                misses.set(key, count >> 1);
            }
        }
    };
    /**
     * @typedef {Object} RegionRecord
     * @property {number} entry
     * @property {Set<number>} pages
     * @property {Set<number>} [reads]   every page forming read: what a worker forms it from
     * @property {Set<number>} [formable]   every page forming was told it may form code on
     * @property {number[]} slots   entry indices
     * @property {number} table     the function's index in the table, or -1
     * @property {[number, number][]} spans   the blocks' [start, end)
     * @property {{ start: number, bytes: Uint8Array }[]} [sources]  every byte forming read,
     *     as it read them, kept where a store into code reached one of its pages before: a
     *     later store there drops it only when it changes one of them (`storedInto`)
     * @property {Map<number, [number, number]>} extents  by page, the code granules its
     *     blocks cover there, [from, to)
     * @property {number} entryTop  the x87 top it was formed for
     * @property {string} hash      of its bytes, which a relink forms it from again
     * @property {string} labels    its block starts and labels, which a relinked function
     *     must keep for the entries to stand
     * @property {boolean} [linked]  its function is in a relinked module already
     * @property {boolean} [wide]  an x87 region compiled for the wide precision controls
     * @property {boolean} [narrow]  an x87 region compiled for single precision
     * @property {boolean} [floats]  of those, one computing on floats in f32 (`floatSingles`)
     * @property {boolean} [loose]  compiled with its stores through esp untested (`looseStacks`)
     * @property {boolean} [wrapped]  compiled with its reads wrapped into RAM, untested
     * @property {boolean} [checked]  an x87 region whose entries test nothing of the stack's shape
     * @property {boolean} [copies]  its blocks inside its loops are entered through copies
     *     (`emitRegion`); without, they have no entry (`closed`)
     * @property {number[]} [closed]  the starts of those blocks with no entry
     * @property {number} [blocks]  how many blocks it has: a label from twice as many is a copy's
     * @property {Placed} [module]  the placed module its table index is in (`placeModule`)
     * @property {boolean} [movedAlone]  a merge took it alone into the module calling it
     * @property {number} [merged]  the merges that built it again (`MERGES_A_REGION`)
     * @property {number} [floatMisses]  its float results that were not the processor's
     * @property {number} [shapeMisses]  its entries' tests that failed
     * @property {[number, number[]][]} [targets]  by indirect call, the callees formed into it
     * @property {Map<number, number[]>} [unformed]  by indirect call, the callees forming it
     *     again did not take in (the region full): not asked of it again
     * @property {number} [reforms]  times it was formed again for its indirect calls
     */
    /** @type {Set<RegionRecord>} */
    const regions = new Set();
    /** @type {Map<number, RegionRecord>} entry index → the region that made it */
    const recordOf = new Map();
    /** key(entry, top) of the x87 regions whose shape test kept failing: formed checked. */
    const checkedKeys = new Set();
    /** By the start of a block inside a structured region's loop that has no entry, the
     * regions holding it so. @type {Map<number, Set<RegionRecord>>} */
    const closedIn = new Map();
    /** By page, the closed starts on it: those pages carry `PageFlag.CLOSED`, and the
     * interpreter tier in wasm runs no miss of the hash there, which the host must count
     * (`missAt`) for the copies. @type {Map<number, number>} */
    const closedPages = new Map();
    /** @param {number} start @param {RegionRecord} record */
    const forgetClosed = (start, record)=>{
        const holders = closedIn.get(start);
        holders?.delete(record);
        if (holders?.size === 0)
        {
            closedIn.delete(start);
            const page = start >>> 12;
            const left = (closedPages.get(page) ?? 1) - 1;
            if (left > 0)
            {
                closedPages.set(page, left);
            }
            else
            {
                closedPages.delete(page);
                pages.clear(page, PageFlag.CLOSED);
            }
        }
    };
    /** The regions to form again with copies of those blocks. @type {Set<RegionRecord>} */
    const copiesWanted = new Set();
    /** @type {Map<number, Set<RegionRecord>>} page → regions on it */
    const byPage = new Map();
    const GRANULES = 1 << (12 - Tables.CODE_GRANULE_SHIFT);
    /**
     * By code page, how many regions' extents there start at each granule and
     * end at each: the page's code range is the first start and the last end,
     * so a region that goes takes its own out rather than the range being made
     * again from every region left -- a page of small functions formed into
     * their callers holds nearly every region there is, and making its range
     * again was a pass over all of them each time one went.
     * @type {Map<number, Uint32Array>}  granule g's starts at g, its ends at GRANULES + 1 + g
     */
    const pageExtents = new Map();
    /** @param {RegionRecord} record @param {1 | -1} sign */
    const countExtents = (record, sign)=>{
        for (const [page, [from, to]] of record.extents)
        {
            let tally = pageExtents.get(page);
            if (tally === undefined)
            {
                tally = new Uint32Array(2 * GRANULES + 2);
                pageExtents.set(page, tally);
            }
            tally[from] += sign;
            tally[GRANULES + 1 + to] += sign;
        }
    };
    /** By the address of an indirect call in translated code, its targets sampled and how
     * often, and its samples in all. @type {Map<number, { total: number,
     *     targets: Map<number, number> }>} */
    const callSamples = new Map();
    /** The calls sampled `PREDICT_AFTER` times, whose callees are looked at next: what was
     * a pass over every call sampled at each `translatePending`. @type {Set<number>} */
    const callsDue = new Set();
    /**
     * A diagnostic: each sampled call site's samples over the run, its dues,
     * how its last due ended and the callees it named then -- what tells a
     * site the sampling never reaches from one whose callees did not form in.
     *
     * At its last due, too, how many of the regions spanning it were formed with its
     * callees (`held`, of `spanning`), and how often a region formed again for it did not
     * take them in (`notFormed`) -- the last such region's entry and why (`apart`, the
     * reason forming gave, or `full`).
     *
     * @type {Map<number, { samples: number, dues: number, last: string, top: number[],
     *     share: number, held: number, spanning: number, notFormed: number,
     *     unformedIn: number, apart: string }>}
     */
    const siteLog = new Map();
    /** @param {number} site */
    const logOf = site=>{
        let one = siteLog.get(site);
        if (one === undefined && siteLog.size < 16384)
        {
            one = { samples: 0, dues: 0, last: '', top: [], share: 0, held: 0, spanning: 0,
                notFormed: 0, unformedIn: 0, apart: '' };
            siteLog.set(site, one);
        }
        return one;
    };
    const CALL_SITES_CAP = settings.callSitesKept;
    /** @type {Map<number, number>} page → times invalidated, the stamp a batch checks */
    const generation = new Map();
    /**
     * By page, the writes that dropped its regions: how many since `since`, the window's
     * start, and how many times it was left volatile.
     * @type {Map<number, { times: number, since: number, left: number }>}
     */
    const dropped = new Map();
    /** By volatile page, when it is translated again. @type {Map<number, number>} */
    const volatileUntil = new Map();
    /**
     * By volatile page, the entries of the regions writes dropped there, with
     * their tops: code that ran hot enough to be translated, which the
     * interpreter's own counts -- saturated long before the page is let go --
     * would not hand over again.
     * @type {Map<number, Map<number, number>>}
     */
    const leftEntries = new Map();
    /** The pages whose hold is over go back to the translator. */
    const liftVolatile = ()=>{
        if (volatileUntil.size === 0)
        {
            return;
        }
        const now = performance.now();
        for (const [page, until] of volatileUntil)
        {
            if (now >= until)
            {
                volatileUntil.delete(page);
                pages.clear(page, PageFlag.VOLATILE);
                // What was asked for there while it was left formed nothing: asked
                // again, it is translated.
                for (const key of pageKeys.get(page) ?? [])
                {
                    barren.delete(key);
                }
                for (const [entry, top] of leftEntries.get(page) ?? [])
                {
                    runtimeApi?.noteHot(entry, top, 256);
                }
                leftEntries.delete(page);
                const record = dropped.get(page);
                if (record !== undefined)
                {
                    record.times = 0;
                    record.since = now;
                }
            }
        }
    };
    const counts = {
        modules: 0, invalidations: 0, volatilePages: 0, dropped: 0, moduleBytes: 0,
        // Stores into code that changed none of the bytes a region on the page was made from.
        storesKept: 0,
        // Indirect call sites whose samples came due (`callTargets`), and why
        // each was left as it was: no callee took a share of its samples, or
        // only ones tried already; its regions formed again as often as they
        // may be; formed again with none of its new callees in; no region
        // holding it to form again.
        predictDue: 0, predictNoShare: 0, predictReformsOut: 0, predictNotFormed: 0,
        predictNoRegion: 0, predictHeld: 0,
        queueDrops: 0, queueEvictions: 0, emitFailures: 0,
        cacheHits: 0, cacheMisses: 0, missNoRecord: 0, missNoModule: 0, precisionSwitches: 0,
        readSwitches: 0,
        stackCode: 0,
        // Batches the store answered in the call that formed them, and a turn later.
        lookedUpNow: 0, lookedUpLater: 0,
        // Calls that formed part of a batch and left the rest to a later one
        // (`holdMs`), that published part of a batch's store hits, and asks
        // the spent credit put off; the hits' modules compiled off this thread.
        formedInPart: 0, publishedInPart: 0, heldBack: 0, compiledApart: 0,
        shapeMisses: 0, shapeChecked: 0, x87RelaxedReads: 0, floatMisses: 0, floatsRounded: 0,
        // The milliseconds of translating, by the part of a batch they are:
        // `translateMs` is their sum, so a frame's own figure and the split
        // always agree.
        relinks: 0, relinked: 0, merges: 0, merged: 0, reforms: 0, copied: 0,
        formingMs: 0, lookupMs: 0, emitMs: 0, encodeMs: 0, storeMs: 0, instantiateMs: 0,
        publishMs: 0,
        // Emitting and encoding the worker did: reported apart from
        // `translateMs`, which is the engine thread's own, so the two threads'
        // costs stay legible.
        workerMs: 0,
        // With `timings`: all the worker was held for (forming a relink and
        // compiling too), how long a batch was out, and how long work stood
        // queued behind the one out -- what a second worker, or a second
        // batch out, would have taken -- and the longest the queue grew.
        workerBusyMs: 0, inFlightMs: 0, behindMs: 0, queueMax: 0,
    };
    /** When `translateNow` last looked, for `behindMs`. */
    let lookedAt = 0;
    /**
     * The engine thread's long holds, host milliseconds: what a guest thread
     * waiting on a timer (a sound mixer) sat through. The last 64 over 5 ms.
     * @type {{ at: number, ms: number, what: string }[]}
     */
    const stalls = [];
    /** @param {string} what @param {number} since @param {number} [floorMs] */
    const noteStall = (what, since, floorMs = 5)=>{
        if (import.meta.BOTTLIFY_DIAGNOSTICS === false || settings.timings !== true)
        {
            return;
        }
        const ms = performance.now() - since;
        if (ms < floorMs)
        {
            return;
        }
        if (stalls.length === 64)
        {
            stalls.shift();
        }
        stalls.push({ at: Math.round(since), ms: Math.round(ms), what });
    };
    let nextTable = resumable ? TIER_SLOT + 1 : 0;
    /** @type {Record<ExitKind, number>} */
    const exits = { untranslated: 0, budget: 0, trap: 0, halt: 0, fault: 0, stale: 0,
        interpreted: 0 };
    // The untranslated exits by what left: a bare one (nothing at the target
    // in the region), or one a region made to the host on purpose -- a window
    // its accesses would fault on or a store into code (HELD), the x87
    // precision it was not formed for (PRECISION), a stack shape it was not
    // checked for (SHAPE). One count read alone mixes them, and the held ones
    // land on addresses that are translated, which reads as a link not made.
    const untranslatedBy = { bare: 0, held: 0, precision: 0, shape: 0, range: 0, other: 0 };
    /** @type {Record<number, keyof typeof untranslatedBy>} */
    const VECTOR_NAMES = { 0: 'bare', [HELD]: 'held', [PRECISION]: 'precision', [SHAPE]: 'shape',
        [RANGE]: 'range' };
    /** @type {import('../../../core/src/layers/cpu/engine.js').ExitRecord} */
    const exit = { retired: 0, kind: 'untranslated', vector: 0 };
    /** @type {Record<string, number>} */
    const refused = {};
    /** @type {Record<string, number>} why an instruction was left out, with its block */
    const refusedWhy = {};
    /** By opcode, translated instructions that read a flag the fast default left undefined.
     * @type {Record<string, number>} */
    const relaxedFlagReads = {};
    let corkRetired = 0;
    // Turns the host retired nothing in and forced one interpreted
    // instruction through, so a slice always moves (the progress guarantee).
    let forcedSteps = 0;
    // The counter word folded the way the layer folds it: exact as long as
    // reads come less than 2^32 instructions apart.
    let counted = 0;
    let lastWord = 0;
    /** @type {DataView | null} */
    let cachedView = null;
    // One view, taken again only when the memory grew (which detaches the
    // buffer it was on): a view per region run was a fifth of a call's cost.
    const view = ()=>{
        // A grown memory detaches the old buffer, whose length then reads 0:
        // asked of the view's own buffer, not of `memory.buffer`, whose getter
        // is a crossing into the engine on every run.
        if (cachedView === null || cachedView.buffer.byteLength === 0)
        {
            cachedView = new DataView(memory.buffer);
        }
        return cachedView;
    };
    /** @type {Uint8Array | null} */
    let cachedBytes = null;
    /**
     * The guest's bytes `[address, end)` where they lie in the memory, or null
     * where a byte is past RAM and only `read` answers it: what compares a
     * store's range with a copy byte by byte, which through `read` was a call
     * a byte -- tens of microseconds for half a page.
     *
     * @param {number} address @param {number} end
     */
    const guestBytes = (address, end)=>{
        if (typeof layout.ramSize !== 'number' || address < 0 || end > layout.ramSize)
        {
            return null;
        }
        if (cachedBytes === null || cachedBytes.buffer.byteLength === 0)
        {
            cachedBytes = new Uint8Array(memory.buffer);
        }
        return cachedBytes.subarray(layout.ramBase + address, layout.ramBase + end);
    };
    const counterWord = ()=>view().getUint32(layout.counter, true);
    const fold = ()=>{
        const word = counterWord();
        counted += (word - lastWord) >>> 0;
        lastWord = word;
    };
    lastWord = counterWord();

    /** @param {Set<number>} of */
    const stamp = of=>[...of].map(page=>generation.get(page) ?? 0).join(',');

    /**
     * Takes regions out: their entries, their function-table slots, and the
     * code marks of their pages, which keep the range of the regions still on
     * each.
     *
     * @param {RegionRecord[]} records
     */
    const unpublish = records=>{
        // The pages the dropped regions spanned, taken before the records
        // leave their sets.
        const touched = new Set(records.flatMap(record=>[...record.pages]));
        for (const record of records)
        {
            for (const slot of record.slots)
            {
                entries.remove(slot);
                recordOf.delete(slot);
            }
            if (table && record.table >= 0)
            {
                // The entries are out of the hash first: nothing finds
                // the slot before it is emptied.
                table.set(record.table, null);
                recordAt.delete(record.table);
                if (record.module === undefined)
                {
                    freeTable.push(record.table);
                }
            }
            leaveModule(record);
            for (const p of record.pages)
            {
                byPage.get(p)?.delete(record);
            }
            countExtents(record, -1);
            for (const start of record.closed ?? [])
            {
                forgetClosed(start, record);
            }
            copiesWanted.delete(record);
            regions.delete(record);
        }
        for (const p of touched)
        {
            const left = byPage.get(p);
            pages.clearCode(p);
            if (!left?.size)
            {
                watched[p] &= ~WATCH_REGIONS;
                pageExtents.delete(p);
                imports.handoffPage?.(p, false);
                continue;
            }
            // The page's range from the extents of the regions still on it.
            const tally = pageExtents.get(p);
            if (tally === undefined)
            {
                continue;
            }
            let from = 0;
            while (from < GRANULES && tally[from] === 0)
            {
                from++;
            }
            let to = GRANULES;
            while (to > from && tally[GRANULES + 1 + to] === 0)
            {
                to--;
            }
            if (to > from)
            {
                pages.markCode(p * 4096 + (from << Tables.CODE_GRANULE_SHIFT),
                    (to - from) << Tables.CODE_GRANULE_SHIFT);
            }
        }
    };

    /**
     * @param {number} page
     * @param {RegionRecord[]} [only]  the regions on it that go; every one by default
     * @returns {RegionRecord[]}  the regions that went, unless the page was left volatile
     */
    const invalidatePage = (page, only)=>{
        if (watched[page] === 0)
        {
            return [];
        }
        const on = byPage.get(page);
        const going = only ?? (on ? [...on] : []);
        const cost = going.length;
        if (cost > 0)
        {
            unpublish(going);
            counts.invalidations += cost;
        }
        const notes = pageKeys.get(page);
        if (notes)
        {
            counts.queueDrops += notes.size;
            for (const key of notes)
            {
                unqueue(key);
                barren.delete(key);
            }
            pageKeys.delete(page);
            watched[page] &= ~WATCH_KEYS;
        }
        generation.set(page, (generation.get(page) ?? 0) + 1);
        // Only a write that cost a region counts towards volatility: the
        // loader placing an image writes a page many times before anything
        // on it is hot, and that is not a page that mixes code with data.
        if (cost === 0)
        {
            return going;
        }
        const now = performance.now();
        let record = dropped.get(page);
        if (record === undefined)
        {
            record = { times: 0, since: now, left: 0 };
            dropped.set(page, record);
        }
        if (now - record.since > settings.volatileWindowMs)
        {
            record.times = 0;
            record.since = now;
        }
        record.times++;
        if (record.times === settings.volatileAfter && !volatileUntil.has(page))
        {
            pages.set(page, PageFlag.VOLATILE);
            volatileUntil.set(page, now + settings.volatileHoldMs * 2 ** Math.min(record.left, 5));
            leftEntries.set(page, new Map(going.map(one=>[one.entry, one.entryTop])));
            record.left++;
            counts.volatilePages++;
            return [];
        }
        return going;
    };

    /**
     * Whether a byte of `sources` in `[address, end)` reads otherwise now.
     * @param {{ start: number, bytes: Uint8Array }[]} sources @param {number} address
     * @param {number} end
     */
    const sourcesChanged = (sources, address, end)=>{
        for (const { start, bytes } of sources)
        {
            const from = Math.max(start, address);
            const to = Math.min(start + bytes.length, end);
            const now = from < to ? guestBytes(from, to) : null;
            if (now !== null)
            {
                for (let k = 0, at = from - start; k < now.length; k++, at++)
                {
                    if (now[k] !== bytes[at])
                    {
                        return true;
                    }
                }
                continue;
            }
            for (let at = from; at < to; at++)
            {
                if (read(at) !== bytes[at - start])
                {
                    return true;
                }
            }
        }
        return false;
    };

    /**
     * Whether `sources` hold a byte of `[address, end)`.
     * @param {{ start: number, bytes: Uint8Array }[]} sources @param {number} address
     * @param {number} end
     */
    const sourcesMet = (sources, address, end)=>sources.some(({ start, bytes })=>
        start < end && address < start + bytes.length);

    /**
     * The bytes of each page a store into code has met, as the last store
     * there left them: what a store into none of the page's regions is judged
     * by. Only a choice of speed rides on it -- whether the page stays code --
     * since every region's own bytes are judged by its copy (`sources`).
     *
     * @type {Map<number, Uint8Array>}
     */
    const pageBytes = new Map();

    /**
     * Whether the store over `[address, end)` changed a byte of `page` from
     * what the page's copy holds, the copy taken up to date. A page met for
     * the first time has no copy to judge by: changed.
     *
     * @param {number} page @param {number} address @param {number} end
     */
    const pageChanged = (page, address, end)=>{
        const base = page * 4096;
        const copy = pageBytes.get(page);
        if (!copy)
        {
            const whole = guestBytes(base, base + 4096);
            if (whole !== null)
            {
                pageBytes.set(page, whole.slice());
                return true;
            }
            const made = new Uint8Array(4096);
            for (let at = 0; at < 4096; at++)
            {
                made[at] = read(base + at);
            }
            pageBytes.set(page, made);
            return true;
        }
        let changed = false;
        const to = Math.min(end, base + 4096);
        const from = Math.max(address, base);
        const current = from < to ? guestBytes(from, to) : null;
        if (current !== null)
        {
            for (let k = 0, at = from - base; k < current.length; k++, at++)
            {
                if (copy[at] !== current[k])
                {
                    copy[at] = current[k];
                    changed = true;
                }
            }
            return changed;
        }
        for (let at = from; at < to; at++)
        {
            const now = read(at);
            if (copy[at - base] !== now)
            {
                copy[at - base] = now;
                changed = true;
            }
        }
        return changed;
    };

    /**
     * Bytes at `[address, address + size)` were written while code stood on
     * their pages. A region goes when a byte it was made from now differs:
     * a program that writes its code over with the bytes already there -- a
     * mixer setting every voice's patch on each call, most of them as they
     * were -- keeps its translations, and one that changes a byte loses the
     * regions made of that byte and no other on the page. A page with a region
     * that kept no copy of its bytes goes whole, as every page did before its
     * first such store; the regions formed on it again keep theirs.
     *
     * The page's generation moves either way, so a region in flight from it
     * is checked again at its publication rather than trusted.
     *
     * @param {number} address @param {number} size
     * @param {boolean} [own]  the program's own store, whose dropped code is asked for again
     *     at once; a host's write (a file read, a loader) places bytes nothing has run yet,
     *     which run first where cold code runs
     */
    const storedInto = (address, size, own = true)=>{
        if (size <= 0)
        {
            return;
        }
        const end = address + size;
        const last = (end - 1) >>> 12;
        for (let page = address >>> 12; page <= last; page++)
        {
            const on = byPage.get(page);
            // With other executors beside this one a page goes whole, as before:
            // their stores reach this one's regions only when it next looks
            // (`takeCodeWrites`), and keeping regions across that gap is not
            // yet judged by the executors' gate.
            const whole = codeShared !== null || watched[page] === 0 || on === undefined
                || on.size === 0 || [...on].some(record=>record.sources === undefined);
            /** @param {any} record */
            const sourcesOf = record=>
                /** @type {{ start: number, bytes: Uint8Array }[]} */ (record.sources);
            const met = whole ? undefined
                : [...on].filter(record=>sourcesMet(sourcesOf(record), address, end));
            // Into none of the page's regions' bytes: no translation is wrong
            // for it, and what is left to decide is whether the page stays
            // code. A store that changed what was there is data beside the
            // code -- a variable between two functions, written on every turn
            // of a loop -- and kept as code the page would send every such
            // store to the interpreter, ten times the loop's cost in the
            // measured case; it goes whole, as before any store was judged by
            // its bytes, and nothing is asked for again. One that wrote the
            // bytes already there is a patch set again over code no region
            // took in, and the page stays.
            if (met !== undefined && met.length === 0 && pageChanged(page, address, end))
            {
                invalidatePage(page);
                continue;
            }
            if (whole)
            {
                // The copy a later store into none of the regions is judged by.
                pageChanged(page, address, end);
            }
            if (met !== undefined && met.length > 0 && pageBytes.has(page))
            {
                // Kept up to date for the next store into none of them.
                pageChanged(page, address, end);
            }
            const changed = met?.filter(record=>sourcesChanged(sourcesOf(record), address, end));
            if (changed === undefined || changed.length > 0)
            {
                // Code hot enough to have been translated runs on as it is now,
                // on the interpreter, whose counts of it are long saturated: it
                // is asked for again at once, so the bytes written are what is
                // translated next.
                for (const one of invalidatePage(page, changed))
                {
                    if (own && codeShared === null)
                    {
                        runtimeApi?.noteHot(one.entry, one.entryTop, 256);
                    }
                }
                continue;
            }
            counts.storesKept++;
            generation.set(page, (generation.get(page) ?? 0) + 1);
        }
    };

    /**
     * Code is translated on a page of a thread's stack: the regions that store
     * through esp untested go, and every region from now on tests them -- a
     * store through esp could write the code itself.
     */
    const stackCodeSeen = ()=>{
        if (!loose)
        {
            return;
        }
        loose = false;
        counts.stackCode++;
        const on = new Set([...regions].filter(record=>record.loose)
            .flatMap(record=>[...record.pages]));
        for (const page of on)
        {
            invalidatePage(page);
        }
    };

    /**
     * The program touched a page it cannot reach, and the tier that tested
     * the access faulted it: reads are tested from now on, and the regions
     * that wrapped theirs into RAM go -- the same instruction would read zeros
     * there where the interpreter faults. A program reaches one only on
     * purpose (a reservation it commits in its own handler), and a run
     * switches at most once.
     */
    const readsFaulted = ()=>{
        if (readsChecked || settings.checkReads === false)
        {
            return;
        }
        readsChecked = true;
        counts.readSwitches++;
        const on = new Set([...regions].filter(record=>record.wrapped)
            .flatMap(record=>[...record.pages]));
        for (const page of on)
        {
            invalidatePage(page);
        }
    };

    /**
     * A region left before a rounding instruction because the machine has
     * another precision control than it was compiled for (PRECISION): the
     * regions holding that instruction compiled for the other go, and their
     * entries are compiled from now on for the one found -- or, an entry whose
     * regions left this way once already, for a test at every rounding
     * instruction (`precisionAt`). Every other region stays as it is.
     *
     * @param {number} eip  the instruction it left before
     */
    const precisionMissed = eip=>{
        const single = (view().getUint16(layout.x87Control, true) & 0x300) === 0;
        const under = single ? 'narrow' : 'wide';
        const going = [...byPage.get(eip >>> 12) ?? []].filter(record=>
            (single ? record.wide : record.narrow) === true
            && record.spans.some(([from, to])=>eip >= from && eip < to));
        for (const record of going)
        {
            const known = precisionAt.get(record.entry);
            // A region compiled before its entry moved on goes without moving it again.
            if (known !== undefined && known.precision === (record.wide ? 'wide' : 'narrow'))
            {
                known.precision = known.misses === 0 ? under : 'mixed';
                known.misses++;
                counts.precisionSwitches++;
            }
        }
        if (going.length > 0)
        {
            unpublish(going);
        }
    };

    /**
     * A region computing single precision on floats left before an operation whose
     * float result is not the processor's (`RANGE`): the host ran it. One that keeps
     * leaving -- data at a float's edge, a result past it -- goes, its entry
     * translated again rounding every result from a double (`roundedKeys`).
     *
     * @param {number} eip  the operation it left before
     */
    const floatMissed = eip=>{
        counts.floatMisses++;
        const going = [...byPage.get(eip >>> 12) ?? []].filter(record=>record.floats === true
            && record.spans.some(([from, to])=>eip >= from && eip < to)
            && (record.floatMisses = (record.floatMisses ?? 0) + 1) >= settings.checkedAfter);
        for (const record of going)
        {
            roundedKeys.add(keyOf(record.entry, record.entryTop));
            counts.floatsRounded++;
        }
        if (going.length > 0)
        {
            unpublish(going);
        }
    };
    /**
     * An entry found the machine's x87 stack in another shape than its block
     * was compiled for, and the host's interpreter runs the block. A region
     * that keeps finding it -- code that faults on purpose, or a function
     * entered with the stack in more than one shape -- is dropped, to be
     * formed again checked; answers it then.
     *
     * @param {number} eip @param {number} top
     * @returns {RegionRecord | null}
     */
    const shapeMissed = (eip, top)=>{
        counts.shapeMisses++;
        const record = recordOf.get(entries.entryOf(eip, top));
        if (record === undefined || record.checked)
        {
            return null;
        }
        record.shapeMisses = (record.shapeMisses ?? 0) + 1;
        if (record.shapeMisses < settings.checkedAfter)
        {
            return null;
        }
        checkedKeys.add(keyOf(record.entry, record.entryTop));
        counts.shapeChecked++;
        unpublish([record]);
        return record;
    };
    /** Whether a formed x87 region is to be translated checked.
     * @param {import('../region.js').Region} region @param {number} entryTop */
    const checkedAt = (region, entryTop)=>usesX87(region)
        && (!settings.x87Shapes || checkedKeys.has(keyOf(region.entry, entryTop)));

    /** @param {number} address */
    const translatable = address=>(pages.get(address >>> 12)
        & (PageFlag.VOLATILE | PageFlag.INACCESSIBLE | PageFlag.NO_EXECUTE)) === 0
        // A diagnostic: a range left to the interpreter, to find which code a
        // translation goes wrong in by halving it.
        && !(settings.interpretRange && address >= settings.interpretRange[0]
            && address < settings.interpretRange[1]);

    /**
     * Why the translator has no entry at an untranslated exit's target, the
     * histogram's second column: the page is volatile (or beyond RAM), the
     * address formed nothing (`barren`), it is queued and not yet formed, an
     * entry stands at another x87 top, or the decoder refuses its first
     * instruction (`cpuid`, `rdtsc`, `int n`, the `fs:`-forms -- plan 4.2's
     * list). Anything else is not known.
     *
     * @param {number} address
     * @returns {string}
     */
    const missReason = address=>{
        if (pages.get(address >>> 12) & PageFlag.VOLATILE)
        {
            return 'volatile';
        }
        if (!translatable(address))
        {
            return 'inaccessible';
        }
        if (barrenAt(address))
        {
            return 'barren';
        }
        for (const eip of queue.values())
        {
            if (eip === address)
            {
                return 'queued';
            }
        }
        for (let top = 0; top < 8; top++)
        {
            if (entries.entryOf(address, top) >= 0)
            {
                // Every top it was left at has its region now: those exits
                // were the wait for the translation, not a gap still open.
                const tops = exitTargets.get(address)?.tops ?? 0;
                for (let t = 0; t < 8; t++)
                {
                    if ((tops >>> t & 1) !== 0 && entries.entryOf(address, t) < 0)
                    {
                        return 'other-top';
                    }
                }
                return 'translated since';
            }
        }
        if (typeof read === 'function' && 'refused' in decode(byte=>read(byte), address))
        {
            return 'refused';
        }
        // Closed in a region's loop: it is that region's to give an entry by
        // forming again with copies, and no candidate of its own until then.
        const holders = closedIn.get(address);
        if (holders !== undefined)
        {
            return [...holders].every(record=>record.copies === true) ? 'closed, copied' : 'closed';
        }
        return 'unknown';
    };

    // The translation worker: forming and the store lookup stay on the engine
    // thread, where the memory and the store are, and the emitting and
    // encoding of what the store did not hold go to a worker. The engine
    // never waits for it -- a batch not back yet is simply not published this
    // call, and the answer is picked up between frames. Where no worker can
    // be opened (a test process, a bundler that did not carry the file), the
    // same `emitBuilt` runs inline and the split's `emitMs`/`encodeMs` are the
    // engine's own, as before.
    // A worker only pays where something paces the run: its answer is picked
    // up between frames, and a run with no frames (`feed: 'slice'`, a test)
    // has none to hide the round trip behind, so it translates inline as it
    // always did unless a worker is asked for outright.
    const workerWanted = settings.workerUrl !== undefined
        || (settings.worker ?? (settings.feed !== 'slice'
            && typeof globalThis.Worker === 'function'));
    const workerUrl = workerWanted ? (settings.workerUrl ?? translatorWorkerUrl()) : null;
    /**
     * A batch with a translator: the regions it publishes (`metas`) or the
     * running ones it relinks, and whether nothing else may be out beside it
     * (`alone`: a relink, a merge, regions formed again with their callees or
     * copies -- each takes over regions that are running, and a batch
     * publishing beside it could publish one of them).
     * @typedef {{ id: number, metas?: any[], relink?: RegionRecord[], store: any,
     *     at: number, alone: boolean, covers?: number[] }} Pending
     *     covers: the block starts of its regions with no x87 in them (`coveredOut`)
     */
    /**
     * A translation worker: loaded once it has answered its first message
     * (`ready`), with at most one batch out (`pending`); one asked to go
     * (`leaving`) takes no batch and goes when its last one is back.
     * @typedef {{ adapter: import('./translator.js').WorkerAdapter, ready: boolean,
     *     pending: Pending | null, leaving: boolean }} Translator
     */
    /** @type {Translator[]} */
    const translators = [];
    /** Whether the translators are a pool's to lend, none opened here, until the first is. */
    let awaitingLend = workerUrl !== null && settings.translators === 0;
    /** When the first translator was made, and the time spent emitting here since. */
    let loadingSince = performance.now();
    let inlineWhileLoading = 0;
    let workerClosed = false;
    /** One that can take a batch now. */
    const freeTranslator = ()=>translators.find(one=>one.ready && !one.leaving
        && one.pending === null) ?? null;
    /** Whether any translator takes batches, free or not. */
    const translatorReady = ()=>translators.some(one=>one.ready && !one.leaving);
    /**
     * Whether a translator was made and has not loaded yet -- or none is
     * opened here and the host's pool has yet to lend the first: what is asked
     * for meanwhile is emitted here as while a worker loads.
     */
    const translatorLoading = ()=>translators.some(one=>!one.ready)
        || (awaitingLend && translators.length === 0);
    const batchesOut = ()=>translators.some(one=>one.pending !== null);
    /** Set while a step that takes over running regions (`Pending.alone`) posts. */
    let postingAlone = false;
    /**
     * The block starts the batches out will publish as entries at any top, by
     * how many hold each: a candidate among them is not formed again beside
     * them, as one a batch's own region covers is not -- with several batches
     * out, every block of a loop met while its region was with one translator
     * otherwise became a region of its own with the next.
     * @type {Map<number, number>}
     */
    const coveredOut = new Map();
    /** @param {Pending} pending */
    const uncover = pending=>{
        for (const at of pending.covers ?? [])
        {
            const held = (coveredOut.get(at) ?? 1) - 1;
            if (held === 0)
            {
                coveredOut.delete(at);
            }
            else
            {
                coveredOut.set(at, held);
            }
        }
        pending.covers = [];
    };
    // A batch's store lookups are in flight: its bytes come back between
    // frames, and until then no new batch is formed, so the batches publish in
    // order and the waiting is never the slice's.
    let storePending = false;
    /**
     * A region a batch publishes later (`publishOn`): it, its translation, and
     * the instance of its module -- or, for a store hit whose module this run
     * has not instantiated, null until there is one, with the bytes to compile
     * and what they are known by.
     * @typedef {{ one: any, built: any, instance: WebAssembly.Instance | null,
     *     source?: string | object, bytes?: Uint8Array }} Waiting
     */
    /**
     * The batches waiting to be published, in order: a translator's answer,
     * or a batch's store hits and whether their modules are compiled. Until
     * they are all published no new batch goes, as while a batch's lookups are
     * out, and they are published before a batch half formed goes on.
     * @type {{ waiting: Waiting[], next: number, ready: boolean }[]}
     */
    const toPublish = [];
    let workerRequest = 0;
    /** The runtime itself, once made: what a batch's answer calls to send the next. */
    /** @type {{ translatePending: () => Promise<number>,
     *     noteHot: (address: number, top?: number, heat?: number) => void } | null} */
    let runtimeApi = null;
    /**
     * The host's asks for a batch that found one out. The host asks when the
     * interpreter notes a new start, and a start already queued is not noted
     * again: an ask that found a batch with the worker or the store was spent,
     * and what queued meanwhile waited for some other start to be noted,
     * running interpreted. Each is kept and answered as a batch comes back --
     * a batch an ask, as inline, not the whole queue, whose cold starts stay
     * cold.
     */
    let owed = 0;
    /**
     * Whether a batch may go now: no store lookups out, nothing out that must
     * be alone, and a translator free -- or none ready, the batch then
     * emitted here as without a worker.
     */
    const batchMayGo = ()=>!storePending && toPublish.length === 0
        && !translators.some(one=>one.pending?.alone === true)
        && (freeTranslator() !== null || !translatorReady());
    /**
     * The batch being formed, from one call to the next while forming it whole
     * would hold the engine thread past `holdMs`: its candidates, the next to
     * form, and what is formed so far. Nothing else is formed or sent until it
     * is whole, so it goes out as the one batch it would have been. `covered`
     * holds the block starts of the regions it formed with no x87 in them,
     * each an entry at any top once published: a candidate among them is
     * already translated by one (a loop's head and its cases were all hot at
     * once, and each formed the whole loop again). It is noted again should
     * its block get no entry after all.
     * @type {{ batch: [number, number][], next: number, formed: any[],
     *     covered: Set<number>, ceiling: number, takenAt: number } | null}
     */
    let forming = null;
    /**
     * Whether the translator's work here is bounded (`holdMs`): only where a
     * worker is wanted, which is where frames pace the run -- a run with none
     * emits here, and has no frames to keep.
     */
    const holding = ()=>settings.holdMs > 0 && workerUrl !== null;
    /** The engine thread's time forming may take now (`holdMs`), refilled at
     * `holdShare` of the time that passes, and when it was last brought up to date. */
    let credit = settings.holdMs;
    let creditAt = performance.now();
    const creditNow = ()=>{
        const now = performance.now();
        credit = Math.min(settings.holdMs, credit + (now - creditAt) * settings.holdShare);
        creditAt = now;
        return credit;
    };
    const sendNext = ()=>{
        if (toPublish.length > 0 ? toPublish[0].ready
            : forming !== null || owed > 0 && queue.size > 0 && batchMayGo())
        {
            runtimeApi?.translatePending().catch(()=>{});
        }
    };
    /**
     * Whether a call is wanted once the credit has come back to half of
     * `holdMs` -- for a batch left half formed, or an ask the spent credit
     * refused -- and whether one is set: the host asks again when the
     * interpreter notes a new start, which a program running the code it has
     * may not do for a while.
     */
    let resumeWanted = false;
    let resumeArmed = false;
    const armResume = ()=>{
        if (!resumeWanted || resumeArmed)
        {
            return;
        }
        resumeWanted = false;
        resumeArmed = true;
        setTimeout(()=>{
            resumeArmed = false;
            if (!workerClosed)
            {
                sendNext();
            }
        }, Math.max(1, (settings.holdMs / 2 - creditNow()) / settings.holdShare));
    };
    /** The process's translation cache arena, shared with every translator it has; none
     * without a translator or where memory cannot be shared. */
    const arena = workerUrl !== null && settings.arenaBytes > 0
        && typeof SharedArrayBuffer === 'function' ? createArena(settings.arenaBytes) : null;
    /** What emitting inline keeps for a relink to take again: the arena the translators
     * share, or a cache of this thread's own. */
    const emitCache = arena !== null ? arenaEmitCache(arena) : createEmitCache();

    // The block profile is past cork's own tables, in a memory sized for it;
    // the hybrid layout's tables are carved from the emulator's RAM.
    /** The last `hotForms` answer and when it was taken. @type {{ at: number, forms: any } | null} */
    let formsTaken = null;
    const profiling = import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.blockProfile === true
        && (layout.codePages ?? -1) < 0;
    let profileResetAt = import.meta.BOTTLIFY_DIAGNOSTICS !== false && profiling
        && settings.blockProfileFrom > 0
        ? performance.now() + settings.blockProfileFrom * 1000 : null;
    // The store is opened (a directory store reads its index) while the host
    // is still starting, so it can answer the first batch's lookups at once.
    if (leaveOut.size === 0 && !settings.undoLog && !profiling)
    {
        settings.store?.prepare?.()?.catch(()=>{});
    }
    /** The options both the inline emitter and the worker's take. */
    const emitOptions = ()=>({
        undoLog: settings.undoLog,
        countTransfers: import.meta.BOTTLIFY_DIAGNOSTICS !== false
            && settings.countTransfers === true,
        blockProfile: profiling,
        hash: table !== null,
        place: table !== null && settings.dispatch === true,
        profileCalls: table !== null && settings.callTargets === true,
        callReturn: table !== null && settings.callReturn === true && !settings.undoLog,
        emptySites: settings.emptySites === true && settings.emptyCalls !== false,
        resume: resumable,
        structure: settings.structure,
        precise: settings.precise === true,
        checkReads: readsChecked,
        atomic: settings.atomic === true,
        looseStacks: loose,
        leaveOut,
        timings: import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.timings === true,
        ...(settings.trapPort === undefined ? {} : { trapPort: settings.trapPort }),
        ...(sharedMemory ? { memory: sharedMemory } : {}),
    });

    /**
     * The hot code's forms in a profiling run (`profileForms`): the regions its
     * counted blocks lie in, the most executed first, until they hold
     * `FORMS_SHARE` of the counted executions or `FORMS_REGIONS` of them --
     * formed again as their records were and emitted with the run's options
     * but no counts, in this thread. Emitting hundreds of regions is no cost
     * to take on every look at the diagnostics, so the answer stands for
     * `FORMS_EVERY_MS`.
     *
     * @param {[number, number, number, number][]} blocks  `blockCounts`
     */
    const hotForms = blocks=>{
        const now = performance.now();
        if (formsTaken !== null && now - formsTaken.at < FORMS_EVERY_MS)
        {
            return formsTaken.forms;
        }
        /** @type {Map<number, number>} */
        const executions = new Map();
        /** @type {Map<number, number>} */
        const byEntry = new Map();
        let total = 0;
        for (const [address, count, , entry] of blocks)
        {
            executions.set(address, count);
            total += count;
            if (entry >= 0)
            {
                byEntry.set(entry, (byEntry.get(entry) ?? 0) + count);
            }
        }
        /** @type {Map<number, RegionRecord>} */
        const hottestAt = new Map();
        for (const record of regions)
        {
            if (!hottestAt.has(record.entry))
            {
                hottestAt.set(record.entry, record);
            }
        }
        /** @type {{ region: import('../region.js').Region, entryTop: number, checked: boolean,
         *     copies: boolean }[]} */
        const jobs = [];
        let held = 0;
        for (const [entry, count] of [...byEntry].sort((a, b)=>b[1] - a[1]))
        {
            const record = hottestAt.get(entry);
            if (record === undefined)
            {
                continue;
            }
            if (jobs.length >= FORMS_REGIONS || held >= total * FORMS_SHARE)
            {
                break;
            }
            held += count;
            const called = record.targets === undefined ? {}
                : { callTargets: new Map(record.targets) };
            jobs.push({ region: formRegion(read, record.entry, { ...formHere, translatable,
                ...called }), entryTop: record.entryTop, checked: record.checked === true,
            copies: record.copies === true, ...precisionJob(record) });
        }
        const forms = { ...profileForms(jobs.map(job=>job.region), executions,
            note=>emitBatch(jobs, layout, found, { ...emitOptions(), blockProfile: false,
                countTransfers: false, timings: false, expansion: note })),
        held: total > 0 ? held / total : 0 };
        formsTaken = { at: now, forms };
        return forms;
    };

    /** Folds what the emitter left out into the run's refusal maps, the reads of
     * flags the fast default leaves undefined into theirs, and the x87 status-word
     * reads it let see what it relaxed into their count.
     * @param {{ unsupported?: [string, number][], refusals?: [string, number][],
     *     relaxedReads?: [string, number][], x87RelaxedReads?: number }} built */
    const foldTranslation = built=>{
        counts.x87RelaxedReads += built.x87RelaxedReads ?? 0;
        for (const [opcode, times] of built.relaxedReads ?? [])
        {
            relaxedFlagReads[opcode] = (relaxedFlagReads[opcode] ?? 0) + times;
        }
        for (const [opcode, times] of built.unsupported ?? [])
        {
            refused[opcode] = (refused[opcode] ?? 0) + times;
        }
        for (const [key, times] of built.refusals ?? [])
        {
            refusedWhy[key] = (refusedWhy[key] ?? 0) + times;
        }
    };

    /**
     * A placed module (`finishModule`) takes a range of the table, one index
     * per job, job i's function at the range's start plus i: a range a module
     * gave back (`leaveModule`) when one is long enough, else one past the
     * rest. The range is the module's while it has regions, since its transfer
     * function reaches the functions of that range directly, whatever the
     * table holds.
     *
     * @param {WebAssembly.Instance} instance
     */
    const placeModule = instance=>{
        const exported = /** @type {any} */ (instance.exports);
        if (!table || !(exported.arms instanceof WebAssembly.Global))
        {
            return;
        }
        const arms = exported.arms.value;
        const fits = freeRanges.findIndex(range=>range.arms >= arms);
        let base = nextTable;
        if (fits >= 0)
        {
            const range = freeRanges[fits];
            base = range.base;
            range.base += arms;
            range.arms -= arms;
            if (range.arms === 0)
            {
                freeRanges.splice(fits, 1);
            }
        }
        else
        {
            nextTable += arms;
            if (nextTable > table.length)
            {
                table.grow(Math.max(256, nextTable - table.length));
            }
        }
        exported.base.value = base;
        placedOf.set(instance, { base, arms, crossings: exported.crossings,
            crossedTo: exported.crossedTo, seen: 0, records: new Set(), toward: new Map(),
            instance, baseGlobal: exported.base });
    };

    /** A record into its placed module. @param {RegionRecord} record @param {Placed} placed */
    const joinModule = (record, placed)=>{
        record.module = placed;
        placed.records.add(record);
        if (!placedLive.has(placed))
        {
            placed.seen = placed.crossings.value;
            placedLive.add(placed);
        }
    };
    /** A record out of its placed module, dropped or moved. @param {RegionRecord} record */
    const leaveModule = record=>{
        const placed = record.module;
        if (placed === undefined)
        {
            return;
        }
        placed.records.delete(record);
        if (placed.records.size === 0)
        {
            placedLive.delete(placed);
            for (const other of placedLive)
            {
                other.toward.delete(placed);
            }
            // Its range goes back for another module to take: kept, the table
            // would grow by every batch a run makes, and V8 grows the dispatch
            // table of every instance that imports the table with it, so a run
            // that keeps rewriting its code runs out of memory. The module no
            // longer reaches that range directly (its base is out of every
            // index's reach), and a region of it published again -- a stored one
            // from its instance -- takes an index as an unplaced module's does.
            placed.baseGlobal.value = 0x80000000 | 0;
            placedOf.delete(placed.instance);
            // Emptied too: a function left in a cell holds its whole instance,
            // and a range no module takes again held its module for the run.
            for (let index = placed.base; index < placed.base + placed.arms; index++)
            {
                table?.set(index, null);
            }
            freeRanges.push({ base: placed.base, arms: placed.arms });
        }
    };

    /**
     * One instance of a module of regions -- a batch's, or a stored region's
     * own -- or null when it is refused (the program then runs on as it did).
     * The worker compiles what it emitted and sends the module along; bytes
     * from the store, or a build made here, are compiled here.
     *
     * @param {Uint8Array | WebAssembly.Module} module
     * @returns {WebAssembly.Instance | null}
     */
    const instantiate = module=>{
        const instantiateAt = clock();
        try
        {
            const compiled = module instanceof WebAssembly.Module
                ? module
                : new WebAssembly.Module(/** @type {Uint8Array<ArrayBuffer>} */ (module));
            const instance = new WebAssembly.Instance(compiled, {
                env: {
                    memory, getEflags: imports.getEflags, trap: imports.trap,
                    rdtsc: imports.rdtsc ?? (()=>0n),
                    ...mathImports(), ...helperImports(), ...(table ? { table } : {}),
                },
            });
            counts.modules++;
            placeModule(instance);
            return instance;
        }
        catch (e){
            refused.batch = (refused.batch ?? 0) + 1;
            refused[`batch: ${String(e).slice(0, 120)}`] = 1;
            return null;
        }
        finally
        {
            counts.instantiateMs += clock() - instantiateAt;
        }
    };

    /**
     * Instances of the batch modules this run has, by their store key, so a
     * stored region finds its batch's module already instantiated -- held
     * weakly. What keeps a batch's instance is a region of it still in the
     * table; one a relink took every region from is garbage, and with a store
     * this map held every one of them for the run: each relink a module of
     * thousands of regions again, past a gigabyte of modules in a level load.
     * A record found here is pinned to its instance (`settle`) until it is
     * published, since the instance may go between the look and the use.
     */
    /** @type {ReturnType<typeof createWeakInstances<WebAssembly.Instance>>} */
    const batchInstances = createWeakInstances();
    /** Batch modules instantiated since the last relink began. */
    let modulesSinceRelink = 0;
    /** The running regions a relink still has to gather, or null between relinks.
     * @type {RegionRecord[] | null} */
    let relinkQueue = null;
    /** Candidates taken into a batch that has not published yet, by when: noted
     * again meanwhile they are not queued a second time (the interpreter keeps
     * meeting them while the batch is with the worker). A batch that never
     * comes back frees them once it is overdue.
     * @type {Map<number, number>} */
    const inFlight = new Map();
    /** When the host's event loop last came round, the two latest a tick armed here saw. */
    let turns = [0, 0];
    let tickArmed = false;
    const armTick = ()=>{
        if (tickArmed)
        {
            return;
        }
        tickArmed = true;
        setTimeout(()=>{
            tickArmed = false;
            turns = [turns[1], performance.now()];
        }, 0);
    };
    /**
     * Whether what went to the worker at `since` is overdue: past `inFlightMs`
     * by the clock, and the event loop come round twice since, in which an
     * answer already waiting would have been delivered. The clock alone gave
     * up answers that a long hold of the engine thread -- a slice, a shader's
     * compile -- had only kept in the queue, and threw their work away.
     * @param {number} since
     */
    const overdue = since=>{
        if (performance.now() - since < settings.inFlightMs)
        {
            return false;
        }
        if (turns[0] > since + settings.inFlightMs)
        {
            return true;
        }
        armTick();
        return false;
    };

    /**
     * Stamps a built or stored region and publishes every block start as an
     * entry: its function out of the instance of the module that holds it.
     * The whole of the publish half of the old batch loop, so a worker's
     * answer and an inline emission take the same path.
     *
     * @param {{ region: import('../region.js').Region, entryTop: number, stamp: string,
     *     wide?: boolean, narrow?: boolean, floats?: boolean, checked?: boolean, copies?: boolean,
     *     loose?: boolean, wrapped?: boolean,
     *     replaces?: RegionRecord, targets?: [number, number[]][], copying?: boolean,
     *     waited?: boolean }} one
     *     replaces: the region it is formed again from, with the callees of its indirect calls
     *     (`targets`), or with copies of the blocks inside its loops (`copying`); waited: the
     *     guest ran between its forming and now
     * @param {{ labels: [number, number][], cut: number[], closed?: number[], entryTop: number,
     *     exportName?: string, linked?: boolean }} built
     * @param {WebAssembly.Instance} instance
     * @returns {number} 1 when a region was published, 0 when it was dropped
     */
    const applyBuilt = (one, built, instance)=>{
        const { region } = one;
        inFlight.delete(keyOf(region.entry, one.entryTop));
        const eip = region.entry;
        const publishAt = clock();
        // An x87 region built for a precision control before another was seen
        // would only leave at once: its bytes are translated again for that.
        // So would one built to test the stack's shape once its test had failed.
        // A write moves a page's generation only once code is published on it,
        // so a region the guest ran past before this -- its lookups out, its
        // batch on the worker -- is also read again: a guest store into a page
        // whose first region was in flight is otherwise seen by nothing.
        // A region that keeps the bytes it read (`storedInto`) is checked
        // against them whatever its stamp says: another executor's store moves
        // this one's generations only when it next looks (`takeCodeWrites`).
        // The bytes are every one forming read, a jump's target looked past
        // included, which its hash does not cover.
        const keepsSources = region.sources !== undefined
            && [...region.pages].some(page=>dropped.has(page));
        const moved = one.stamp !== stamp(region.pages) || one.waited === true || keepsSources;
        if ((moved && (region.sources !== undefined
            ? sourcesChanged(region.sources, 0, 0x100000000)
            : one.stamp !== stamp(region.pages) || hashRegion(read, region) !== region.hash))
            || ((one.wide === true || one.narrow === true)
                && precisionOf(region) !== (one.wide === true ? 'wide' : 'narrow'))
            || (one.floats === true && roundedKeys.has(keyOf(region.entry, one.entryTop)))
            || (one.loose && !loose)
            || (one.wrapped && readsChecked)
            || (one.checked !== true && checkedAt(region, one.entryTop)))
        {
            // A page of it was written while the batch was built.
            counts.publishMs += clock() - publishAt;
            counts.dropped++;
            return 0;
        }
        const fn = /** @type {(label: number, budget: number) => number} */ (
            instance.exports[built.exportName ?? 'r0']);
        const cut = new Set(built.cut);
        const closed = built.closed ?? [];
        const closedSet = new Set(closed);
        // Entries for every block start but the cut ones; a region with x87
        // in it is keyed by the top it was compiled for. A block closed in a
        // loop is no x87 matter.
        const top = built.labels.some(([start, label])=>cut.has(label) && !closedSet.has(start))
            || usesX87(region) ? built.entryTop : ANY_TOP;
        const starts = built.labels.filter(([, label])=>!cut.has(label));
        if (starts.length === 0)
        {
            // Every block leaves at once (an instruction the other executor's
            // first): nothing to enter, nothing to keep.
            counts.publishMs += clock() - publishAt;
            barrenAdd(eip, top);
            return 0;
        }
        /** @type {Map<number, [number, number]>} */
        const extents = new Map();
        for (const block of region.blocks)
        {
            if (block.end <= block.start)
            {
                continue;
            }
            // As `markCode` takes the block: the granules of its first and last
            // byte on each page it touches.
            const first = block.start >>> 12;
            const last = (block.end - 1) >>> 12;
            for (let page = first; page <= last; page++)
            {
                const from = page === first
                    ? (block.start & 0xfff) >>> Tables.CODE_GRANULE_SHIFT : 0;
                const to = page === last
                    ? (((block.end - 1) & 0xfff) >>> Tables.CODE_GRANULE_SHIFT) + 1 : GRANULES;
                const extent = extents.get(page);
                if (extent === undefined)
                {
                    extents.set(page, [from, to]);
                }
                else
                {
                    extent[0] = Math.min(extent[0], from);
                    extent[1] = Math.max(extent[1], to);
                }
            }
        }
        /** @type {RegionRecord} */
        const record = {
            entry: region.entry, pages: region.pages, reads: region.reads,
            formable: region.formable, slots: [], table: -1,
            spans: region.blocks.map(block=>[block.start, block.end]), extents,
            entryTop: one.entryTop, hash: region.hash, labels: JSON.stringify(built.labels),
            linked: built.linked === true, wide: one.wide === true, loose: one.loose === true,
            wrapped: one.wrapped === true,
            narrow: one.narrow === true, floats: one.floats === true,
            checked: one.checked === true,
            copies: one.copies === true, closed, blocks: built.labels.length,
        };
        if (keepsSources)
        {
            // A store into code met this page before: what forming read is kept,
            // so the next store there is judged by what it changes (`storedInto`).
            record.sources = region.sources;
        }
        if (one.replaces !== undefined)
        {
            // Formed again with its indirect calls' callees, or with copies:
            // the old region's entries give way to this one's.
            record.targets = one.targets;
            record.unformed = one.replaces.unformed;
            record.reforms = (one.replaces.reforms ?? 0) + (one.copying === true ? 0 : 1);
            // The same code for the merges' bounds: formed again, it would
            // otherwise start over at none.
            record.merged = one.replaces.merged;
            record.movedAlone = one.replaces.movedAlone;
            if (regions.has(one.replaces))
            {
                unpublish([one.replaces]);
            }
        }
        const placed = placedOf.get(instance);
        if (table)
        {
            let index = placed === undefined ? freeTable.pop()
                : placed.base + Number((built.exportName ?? 'r0').slice(1));
            if (index === undefined)
            {
                index = nextTable++;
                if (index >= table.length)
                {
                    table.grow(256);
                }
            }
            table.set(index, fn);
            record.table = index;
            recordAt.set(index, record);
        }
        if (placed !== undefined)
        {
            joinModule(record, placed);
        }
        const blockAt = new Map(region.blocks.map(block=>[block.start, block]));
        for (const [start, label] of starts)
        {
            // An address another region's entry already holds stays that
            // region's: the record keeps only the entries it made, or a relink
            // of it would put its function under the other's label (and a drop
            // of it would take the other's entry away) -- unless there it is
            // a copy of a block inside a loop (a label past twice its blocks,
            // `emitCopies`) and here it is not: a run entered there goes on in
            // this region's loops rather than in a flat dispatch.
            const empty = settings.emptyCalls !== false
                ? emptyCode(at=>blockAt.get(at), start) : 0;
            let slot = entries.add(start, fn, label, top, record.table, empty);
            const held = entries.at(slot);
            const holder = recordOf.get(slot);
            if (held.fn !== fn && holder !== undefined && held.top === top
                && held.label >= 2 * (holder.blocks ?? Infinity) && label < 2 * built.labels.length)
            {
                entries.remove(slot);
                recordOf.delete(slot);
                holder.slots = holder.slots.filter(other=>other !== slot);
                slot = entries.add(start, fn, label, top, record.table, empty);
            }
            if (entries.at(slot).fn === fn)
            {
                record.slots.push(slot);
                recordOf.set(slot, record);
            }
        }
        // A cut block start has no entry here: an address the runtime must
        // answer for with a region of its own at the machine's top, so a miss
        // there is a candidate, not an unknown address. A block closed in a
        // loop is this region's to answer for, formed again with copies once
        // translated code keeps leaving for it (`missAt`); the interpreter
        // runs through it to the loop's head, which has an entry.
        for (const [start, label] of built.labels)
        {
            if (cut.has(label) && !closedSet.has(start))
            {
                entries.noteStart(start);
            }
        }
        for (const start of closed)
        {
            let holders = closedIn.get(start);
            if (holders === undefined)
            {
                holders = new Set();
                closedIn.set(start, holders);
                const page = start >>> 12;
                closedPages.set(page, (closedPages.get(page) ?? 0) + 1);
                pages.set(page, PageFlag.CLOSED);
            }
            holders.add(record);
        }
        for (const block of region.blocks)
        {
            pages.markCode(block.start, block.end - block.start);
        }
        if (loose && stackPages.size > 0 && [...region.pages].some(page=>stackPages.has(page)))
        {
            stackCodeSeen();
        }
        for (const page of region.pages)
        {
            if (!byPage.get(page)?.size)
            {
                imports.handoffPage?.(page, true);
            }
        }
        for (const page of region.pages)
        {
            let set = byPage.get(page);
            if (!set)
            {
                set = new Set();
                byPage.set(page, set);
            }
            set.add(record);
            watched[page] |= WATCH_REGIONS;
        }
        countExtents(record, 1);
        regions.add(record);
        counts.publishMs += clock() - publishAt;
        return 1;
    };

    /** @type {{ put: string[], missed: string[] }} */
    const storeTrace = { put: [], missed: [] };
    /** @param {string[]} list
     * @param {{ region: { entry: number, hash: string, blocks?: { start: number, end: number }[] },
     *     entryTop: number }} one */
    const trace = (list, one)=>{
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.traceStore)
        {
            const spans = one.region.blocks
                ?.map(block=>`${block.start.toString(16)}-${block.end.toString(16)}`);
            list.push(`${one.region.entry.toString(16)}:${one.region.hash}:${one.entryTop}`
                + (spans ? `:${spans.join(',')}` : ''));
        }
    };
    // The settings that change emitted code but not a region's bytes, in the
    // store's keys: structure, precise, the transfer count, the modules' placing
    // and the call profile, the trap port -- each as the emitter reads it, where
    // structure left unset is on. The entry hash and the tier's resume follow
    // from the features and the layout, which the key names beside these.
    const variant = (settings.structure !== false ? 'S' : '')
        + (settings.precise === true ? 'P' : '') + (settings.countTransfers ? 'T' : '')
        + (settings.dispatch === true ? 'D' : '') + (settings.callTargets === true ? 'C' : '')
        + (settings.callReturn === true ? 'R' : '') + (sharedMemory ? 'M' : '')
        + (settings.emptySites === true && settings.emptyCalls !== false ? 'E' : '')
        + (settings.atomic === true ? 'A' : '')
        + `p${(settings.trapPort ?? 0).toString(16)}`;
    /** The store key of one formed region: an x87 region compiled for the wide
     * precision controls or for single, or checked, is another translation of the same
     * bytes.
     * @param {{ region: { entry: number, hash: string }, entryTop: number, wide?: boolean,
     *     narrow?: boolean, floats?: boolean, checked?: boolean, copies?: boolean,
     *     loose?: boolean, wrapped?: boolean }} one */
    const regionKey = one=>cacheKey({
        version: cacheVersion, features: found, variant, layoutId: layout.id,
        bundleId: settings.bundleId ?? 'unknown', entry: one.region.entry,
        hash: `${one.region.hash}-${one.entryTop}${one.wide ? '-w' : ''}`
            + `${one.narrow ? '-n' : ''}${one.floats ? '-f' : ''}${one.checked ? '-c' : ''}`
            + `${one.copies ? '-k' : ''}`
            + `${one.loose ? '-s' : ''}${one.wrapped === false ? '-q' : ''}`,
    });

    /**
     * An emitted batch: its module instantiated once, kept under its own key
     * with a record per region naming it, and every region published from it.
     *
     * @param {any[]} metas  the formed regions, in the batch's order
     * @param {import('./emit-built.js').BuiltBatch} batch
     * @param {WebAssembly.Module | null} compiled  the module, when the worker compiled it
     * @param {any} store
     * @param {boolean} [later]  the regions published a credit's worth a call
     *     (`publishOn`) rather than in this one
     * @returns {number} regions published
     */
    const publishBatch = (metas, batch, compiled, store, later = false)=>{
        const built = batch.results.filter(result=>result.ok);
        for (let i = 0; i < metas.length; i++)
        {
            const result = batch.results[i];
            if (!result.ok)
            {
                refused[`emit at ${metas[i].region.entry.toString(16)}: ${result.message}`] = 1;
                // Done with, as a region the emitter took is: left in flight,
                // a candidate the emitter failed on was sent again once overdue
                // and failed again, and translated code left for it all the while.
                // Barren until its page is written, which forms it again.
                inFlight.delete(keyOf(metas[i].region.entry, metas[i].entryTop));
                barrenAdd(metas[i].region.entry, metas[i].entryTop);
                counts.emitFailures++;
            }
        }
        if (built.length === 0)
        {
            return 0;
        }
        counts.moduleBytes += batch.module.length;
        const instance = instantiate(compiled ?? batch.module);
        modulesSinceRelink++;
        /** @type {string | undefined} */
        let key;
        if (store !== null)
        {
            const storeAt = clock();
            key = moduleKey({ version: cacheVersion, features: found, variant,
                layoutId: layout.id, bundleId: settings.bundleId ?? 'unknown' }, batch.module);
            store.put(key, packRegion({ module: batch.module, labels: [], cut: [], entryTop: 0,
                instructions: 0 }, cacheVersion)).catch(()=>{});
            if (instance !== null)
            {
                batchInstances.set(key, instance);
            }
            counts.storeMs += clock() - storeAt;
        }
        let published = 0;
        /** @type {Waiting[] | null} */
        const waiting = later && instance !== null ? [] : null;
        for (let i = 0; i < metas.length; i++)
        {
            const result = batch.results[i];
            if (!result.ok)
            {
                continue;
            }
            foldTranslation(result.region);
            if (store !== null)
            {
                const storeAt = clock();
                trace(storeTrace.put, metas[i]);
                store.put(regionKey(metas[i]), packRegion({ ...result.region,
                    module: new Uint8Array(0), moduleKey: key }, cacheVersion)).catch(()=>{});
                counts.storeMs += clock() - storeAt;
            }
            if (waiting !== null)
            {
                waiting.push({ one: metas[i], built: result.region, instance });
            }
            else if (instance !== null)
            {
                published += applyBuilt(metas[i], result.region, instance);
            }
        }
        if (waiting !== null && waiting.length > 0)
        {
            publishLater(waiting);
        }
        return published;
    };

    /**
     * A relinked chunk: its module instantiated once, and every region of it
     * still running switched to its function there -- the same labels, so the
     * entries and the table slot stand and only the function under them moves.
     * The old batch modules go when no region uses them any more.
     *
     * @param {RegionRecord[]} records  the chunk, in the order its jobs went
     * @param {import('./emit-built.js').BuiltBatch} batch
     * @param {WebAssembly.Module | null} compiled
     * @param {any} store
     */
    const applyRelink = (records, batch, compiled, store)=>{
        if (!batch.results.some(result=>result.ok))
        {
            return;
        }
        counts.moduleBytes += batch.module.length;
        const instance = instantiate(compiled ?? batch.module);
        if (instance === null)
        {
            return;
        }
        /** @type {string | undefined} */
        let key;
        if (store !== null)
        {
            key = moduleKey({ version: cacheVersion, features: found, variant,
                layoutId: layout.id, bundleId: settings.bundleId ?? 'unknown' }, batch.module);
            store.put(key, packRegion({ module: batch.module, labels: [], cut: [], entryTop: 0,
                instructions: 0 }, cacheVersion)).catch(()=>{});
            batchInstances.set(key, instance);
        }
        for (let i = 0; i < records.length; i++)
        {
            const record = records[i];
            const result = batch.results[i];
            if (!result.ok || !regions.has(record)
                || JSON.stringify(result.region.labels) !== record.labels)
            {
                continue;
            }
            const fn = /** @type {(label: number, budget: number) => number} */ (
                instance.exports[result.region.exportName]);
            const placed = placedOf.get(instance);
            if (table && record.table >= 0)
            {
                if (placed === undefined)
                {
                    table.set(record.table, fn);
                }
                else
                {
                    // Its index in the relinked module's range, which that
                    // module's transfers reach directly.
                    table.set(record.table, null);
                    recordAt.delete(record.table);
                    if (record.module === undefined)
                    {
                        freeTable.push(record.table);
                    }
                    leaveModule(record);
                    record.table = placed.base + Number(result.region.exportName.slice(1));
                    table.set(record.table, fn);
                    recordAt.set(record.table, record);
                    joinModule(record, placed);
                }
            }
            for (const slot of record.slots)
            {
                entries.retable(slot, fn, record.table);
            }
            record.linked = true;
            counts.relinked++;
            if (store !== null)
            {
                const one = { region: { entry: record.entry, hash: record.hash },
                    entryTop: record.entryTop, wide: record.wide, narrow: record.narrow,
                    floats: record.floats, checked: record.checked, copies: record.copies,
                    loose: record.loose };
                store.put(regionKey(one), packRegion({ ...result.region,
                    module: new Uint8Array(0), moduleKey: key, linked: true },
                cacheVersion)).catch(()=>{});
            }
        }
    };

    /**
     * A copy of every page the regions span, for the worker to form them
     * from: a few kilobytes a page, where posting the formed regions cloned
     * every decoded instruction (a seventh of a cold start's engine time).
     *
     * @param {Iterable<Set<number>>} pageSets
     * @returns {Map<number, Uint8Array>}
     */
    const copyPages = pageSets=>{
        /** @type {Map<number, Uint8Array>} */
        const copies = new Map();
        for (const set of pageSets)
        {
            for (const page of set)
            {
                if (!copies.has(page))
                {
                    const at = layout.ramBase + page * 4096;
                    // A copy of its own: a slice of a shared memory's buffer is
                    // shared too, and cannot be transferred to the translator.
                    // A page forming read past the memory -- an import slot that
                    // names nowhere -- read as zeros there, and is zeros here.
                    copies.set(page, at + 4096 <= memory.buffer.byteLength
                        ? new Uint8Array(memory.buffer, at, 4096).slice() : new Uint8Array(4096));
                }
            }
        }
        return copies;
    };

    /**
     * One step of a relink, when the translator is otherwise idle: once enough
     * batch modules have gathered, the running regions go in chunks of
     * `relinkRegions` to be formed again from a copy of their pages and
     * emitted into one module each -- on the worker if there is one.
     *
     * @param {any} store
     * @returns {boolean} whether a chunk was taken this call
     */
    const relinkStep = store=>{
        if (relinkQueue === null)
        {
            if (mergeStep(store))
            {
                return true;
            }
            if (settings.relinkAfter <= 0 || modulesSinceRelink < settings.relinkAfter)
            {
                return false;
            }
            // Only what still lives in a batch's own small module: a region
            // relinked once stays in its big one.
            relinkQueue = [...regions].filter(record=>!record.linked);
            modulesSinceRelink = 0;
            counts.relinks++;
        }
        const chunk = relinkQueue.splice(0, settings.relinkRegions)
            .filter(record=>regions.has(record));
        if (relinkQueue.length === 0)
        {
            relinkQueue = null;
        }
        return relinkChunk(chunk, store);
    };

    /** Translated instructions between two readings of the modules' crossings. */
    const MERGE_SAMPLE = settings.mergeSample;
    let sampledAt = 0;
    // At most one merge in this many: its module is instantiated on the
    // engine thread, 23 ms for a whole chunk of `relinkRegions`.
    const MERGE_EVERY = settings.mergeEvery;
    // And past that, this many for each region the last one built: a merge
    // builds both modules whole again, and with the worker no longer the one
    // that paced them, a module of hundreds gathering a few new regions at a
    // time would have the engine thread instantiate it over and over.
    const MERGE_PER_REGION = settings.mergePerRegion;
    let mergedAt = -MERGE_EVERY;
    let mergeWait = MERGE_EVERY;
    // The merges a region is built again by at most. A merge builds both
    // modules whole, and a module that merged once is crossed into by the
    // next new one: without a bound, every module of new code calling into a
    // hot one could have it built again, for as long as new code arrives.
    const MERGES_A_REGION = settings.mergesARegion;
    /**
     * What a merge of `from` into `into` would build: both whole when they fit
     * in `relinkRegions`, else the region `from` crossed into last, alone, into
     * `from`'s module -- or null when there is no such merge to take.
     *
     * @param {Placed} from @param {Placed} into
     * @returns {{ chunk: RegionRecord[], alone: RegionRecord | null } | null}
     */
    const mergeChunk = (from, into)=>{
        /** @type {RegionRecord[]} */
        let chunk = [...from.records, ...into.records];
        /** @type {RegionRecord | null} */
        let alone = null;
        if (chunk.length > settings.relinkRegions)
        {
            // A region moved alone goes nowhere again: two callers in two
            // full modules would otherwise take it from each other for good.
            const target = recordAt.get(from.crossedTo.value >>> 0);
            if (target === undefined || target.module !== into || target.movedAlone
                || from.records.size >= settings.relinkRegions)
            {
                return null;
            }
            alone = target;
            chunk = [...from.records, target];
        }
        if (chunk.some(record=>(record.merged ?? 0) >= MERGES_A_REGION))
        {
            return null;
        }
        return { chunk, alone };
    };
    /**
     * Two placed modules one of which transfers into the other, gathered into
     * one module on the worker once it has crossed `mergeAfter` times for every
     * region the merge builds: a transfer between them is then a direct tail
     * call, and a merge builds every region of both again -- the worker emits
     * them, the engine thread instantiates the module and compiles each
     * function at its first call, and the code runs on the engine's baseline
     * tier until its optimising compile catches up -- so the crossings it saves
     * must be many for each region it builds. The pair crossed most of those
     * that qualify; each module's count of transfers out of it is read here,
     * and its last one's index names where they went.
     *
     * @param {any} store
     * @returns {boolean} whether a merge was taken this call
     */
    const mergeStep = store=>{
        // Only on the worker: a merge is a relink after the warm-up, which on
        // the engine thread would be a slice's toll. Read every so many
        // translated instructions, not every call: a loading phase has
        // hundreds of modules and calls here between slices.
        if (settings.mergeAfter <= 0 || !translatorReady()
            || corkRetired - sampledAt < MERGE_SAMPLE)
        {
            return false;
        }
        sampledAt = corkRetired;
        for (const placed of placedLive)
        {
            const now = placed.crossings.value;
            const crossed = (now - placed.seen) >>> 0;
            placed.seen = now;
            const into = crossed === 0 ? undefined
                : recordAt.get(placed.crossedTo.value >>> 0)?.module;
            if (into !== undefined && into !== placed)
            {
                placed.toward.set(into, (placed.toward.get(into) ?? 0) + crossed);
            }
        }
        if (corkRetired - mergedAt < mergeWait)
        {
            return false;
        }
        /** @type {{ from: Placed, into: Placed, chunk: RegionRecord[],
         *     alone: RegionRecord | null } | null} */
        let best = null;
        let most = 0;
        for (const from of placedLive)
        {
            for (const [into, weight] of from.toward)
            {
                if (weight <= most || weight < settings.mergeAfter * 2)
                {
                    continue;
                }
                const merge = mergeChunk(from, into);
                if (merge !== null && weight >= settings.mergeAfter * merge.chunk.length)
                {
                    best = { from, into, ...merge };
                    most = weight;
                }
            }
        }
        if (best === null)
        {
            return false;
        }
        const { from, into, chunk, alone } = best;
        from.toward.delete(into);
        into.toward.delete(from);
        if (alone !== null)
        {
            alone.movedAlone = true;
        }
        for (const record of chunk)
        {
            record.merged = (record.merged ?? 0) + 1;
        }
        counts.merges++;
        counts.merged += chunk.length;
        mergedAt = corkRetired;
        mergeWait = Math.max(MERGE_EVERY, chunk.length * MERGE_PER_REGION);
        return relinkChunk(chunk, store);
    };

    // Samples of one call before its callees are looked at: sixteen come in
    // a reading at most, the last calls of a slice.
    const PREDICT_AFTER = settings.predictAfter;
    // A callee formed in takes an eighth of the call's samples, and a call
    // compares its target with four at most.
    const PREDICT_SHARE = settings.predictShare;
    const PREDICT_CALLEES = settings.predictCallees;
    const REFORMS = settings.reforms;
    // Readings a call's samples are kept for unless it is due by then: a
    // region formed again is built, compiled and run on the baseline tier
    // again, which only a call hot now pays back, not one that gathers its
    // samples a few at a time over a long run.
    const CALL_WINDOW = settings.callWindow;
    let readings = 0;
    const profileAt = settings.callTargets === true && table !== null
        ? layout.callProfile ?? -1 : -1;
    /**
     * Reads the indirect calls translated code noted since the last reading
     * and turns the profile on or off: on for one call here in two, so the
     * sixteen pairs are the last calls of a stretch of the run. Nothing is
     * noted with the profile off but its flag's load.
     */
    const sampleCalls = ()=>{
        const words = view();
        if (words.getUint32(profileAt, true) === 0)
        {
            words.setUint32(profileAt + 4, 0, true);
            // The pairs a reading takes are the ones written since: the
            // calls kept are picked by a hash, not every n-th, so how many
            // there are is not the count's to say.
            for (let i = 0; i < 16; i++)
            {
                words.setUint32(profileAt + 8 + i * 8, 0, true);
            }
            words.setUint32(profileAt, 1, true);
            return;
        }
        words.setUint32(profileAt, 0, true);
        if (++readings % CALL_WINDOW === 0)
        {
            for (const site of callSamples.keys())
            {
                if (!callsDue.has(site))
                {
                    callSamples.delete(site);
                }
            }
        }
        for (let i = 0; i < 16; i++)
        {
            const site = words.getUint32(profileAt + 8 + i * 8, true);
            if (site === 0)
            {
                continue;
            }
            const target = words.getUint32(profileAt + 12 + i * 8, true);
            let seen = callSamples.get(site);
            if (seen === undefined)
            {
                if (callSamples.size >= CALL_SITES_CAP)
                {
                    callSamples.clear();
                    callsDue.clear();
                }
                seen = { total: 0, targets: new Map() };
                callSamples.set(site, seen);
            }
            seen.targets.set(target, (seen.targets.get(target) ?? 0) + 1);
            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
            {
                const one = logOf(site);
                if (one)
                {
                    one.samples++;
                }
            }
            if (++seen.total === PREDICT_AFTER)
            {
                callsDue.add(site);
            }
        }
    };

    /**
     * The indirect calls sampled `PREDICT_AFTER` times whose callees are not
     * yet in the regions holding them: each such region formed again with the
     * callees that took a share of its calls' samples (`callTargets`), all in
     * one batch of up to `batchRegions`, and published over the one it
     * replaces when it comes back -- only when one of them was formed in, a
     * small leaf; the others' regions are left as they are, keeping the
     * callees they could not take (`unformed`) so as not to be formed again for
     * them. Each region holding a call is asked by what it has itself, not by
     * what the call's other regions were given. One batch rather than one a
     * call: each is a module the engine thread instantiates, and a round trip
     * through the worker that new code waits behind.
     *
     * @param {any} store
     * @returns {boolean} whether a batch was taken this call
     */
    const reformStep = store=>{
        /** Each region to form again: its calls' callees, and by call the ones new to it.
         * @type {Map<RegionRecord, { targets: Map<number, number[]>,
         *     added: Map<number, number[]> }>} */
        const wanted = new Map();
        for (const site of callsDue)
        {
            if (wanted.size >= settings.batchRegions)
            {
                break;
            }
            callsDue.delete(site);
            const seen = callSamples.get(site);
            callSamples.delete(site);
            if (seen === undefined)
            {
                continue;
            }
            counts.predictDue++;
            const shared = [...seen.targets].filter(([, times])=>
                times * PREDICT_SHARE >= seen.total)
                .sort((a, b)=>b[1] - a[1]).map(([target])=>target);
            // Asked of each region holding the call, by what that region has: one
            // formed after the call's first due, or formed again without it, takes
            // its callees as the first did.
            const spanning = [...byPage.get(site >>> 12) ?? []]
                .filter(record=>record.spans.some(([start, end])=>site >= start && site < end));
            const log = import.meta.BOTTLIFY_DIAGNOSTICS !== false ? logOf(site) : undefined;
            if (log)
            {
                const ranked = [...seen.targets].sort((a, b)=>b[1] - a[1]);
                log.dues++;
                log.top = ranked.slice(0, 4).map(([target])=>target);
                log.share = ranked[0][1] / seen.total;
                log.spanning = spanning.length;
                log.held = spanning.filter(record=>record.targets?.some(([at])=>at === site))
                    .length;
            }
            if (shared.length === 0)
            {
                counts.predictNoShare++;
                if (log)
                {
                    log.last = 'spread';
                }
                continue;
            }
            let placed = false;
            let out = false;
            for (const record of spanning)
            {
                const one = wanted.get(record)
                    ?? { targets: new Map(record.targets ?? []), added: new Map() };
                const had = one.targets.get(site) ?? [];
                const unformed = record.unformed?.get(site) ?? [];
                const added = shared.filter(target=>!had.includes(target)
                    && !unformed.includes(target)).slice(0, PREDICT_CALLEES - had.length);
                if (added.length === 0)
                {
                    continue;
                }
                if ((record.reforms ?? 0) >= REFORMS)
                {
                    counts.predictReformsOut++;
                    out = true;
                    continue;
                }
                one.targets.set(site, [...had, ...added]);
                one.added.set(site, added);
                wanted.set(record, one);
                placed = true;
            }
            if (!placed)
            {
                // Every region holding it has its callees or cannot take them, or
                // none holds it yet: its region not yet published, or dropped since.
                const why = spanning.length === 0 ? 'no region' : out ? 'reforms out' : 'held';
                if (why === 'no region')
                {
                    counts.predictNoRegion++;
                }
                else if (why === 'held')
                {
                    counts.predictHeld++;
                }
                if (log)
                {
                    log.last = why;
                }
            }
            else if (log)
            {
                log.last = 'fresh';
            }
        }
        const formed = [];
        for (const [record, { targets, added }] of wanted)
        {
            const region = formRegion(read, record.entry,
                { ...formHere, translatable, callTargets: targets });
            const starts = new Set(region.blocks.map(block=>block.start));
            let taken = false;
            for (const [site, callees] of added)
            {
                const missed = callees.filter(target=>!starts.has(target));
                taken ||= missed.length < callees.length;
                if (missed.length > 0)
                {
                    // Kept by the region and the one that replaces it, so a full
                    // region is not formed again for the same callees at every due.
                    record.unformed ??= new Map();
                    record.unformed.set(site, [...record.unformed.get(site) ?? [], ...missed]);
                    const log = import.meta.BOTTLIFY_DIAGNOSTICS !== false
                        ? logOf(site) : undefined;
                    if (log)
                    {
                        log.notFormed++;
                        log.unformedIn = record.entry;
                        log.apart = region.blocks.find(block=>block.start <= site
                            && site < block.end)?.exit.apart ?? 'full';
                    }
                }
            }
            if (!taken)
            {
                counts.predictNotFormed++;
                continue;
            }
            formed.push({ region, entryTop: record.entryTop, stamp: stamp(region.pages),
                cached: null, ...precisionFlags(region, record.entryTop), loose,
                wrapped: !readsChecked,
                checked: record.checked === true, copies: record.copies === true,
                replaces: record, targets: [...targets] });
        }
        if (formed.length === 0)
        {
            return false;
        }
        counts.reforms += formed.length;
        finishBatch(formed, store);
        return true;
    };

    /**
     * The regions whose closed blocks translated code keeps leaving for (`missAt`),
     * formed again with copies of the blocks inside their loops (`emitRegion`) and
     * published over the ones they replace when they come back.
     *
     * @param {any} store
     * @returns {boolean} whether a batch was taken this call
     */
    const copiesStep = store=>{
        const formed = [];
        for (const record of copiesWanted)
        {
            copiesWanted.delete(record);
            if (!regions.has(record) || record.copies === true)
            {
                continue;
            }
            // Asked once: its closed blocks are then the runtime's as any
            // block with no entry is, and the region is formed from the code
            // as it is now, whether or not that is what it was formed from.
            for (const start of record.closed ?? [])
            {
                forgetClosed(start, record);
            }
            const called = record.targets === undefined ? {}
                : { callTargets: new Map(record.targets) };
            const region = formRegion(read, record.entry, { ...formHere, translatable,
                ...called });
            formed.push({ region, entryTop: record.entryTop, stamp: stamp(region.pages),
                cached: null, ...precisionFlags(region, record.entryTop), loose,
                wrapped: !readsChecked,
                checked: record.checked === true, copies: true, copying: true, replaces: record,
                ...(record.targets === undefined ? {} : { targets: record.targets }) });
            if (formed.length >= settings.batchRegions)
            {
                break;
            }
        }
        if (formed.length === 0)
        {
            return false;
        }
        counts.copied += formed.length;
        finishBatch(formed, store);
        return true;
    };

    /**
     * Running regions formed again from a copy of their pages and emitted
     * into one module -- on the worker if there is one -- which takes their
     * table indices and entries over when it comes back (`applyRelink`).
     *
     * @param {RegionRecord[]} chunk @param {any} store
     * @returns {boolean} whether the chunk was taken
     */
    const relinkChunk = (chunk, store)=>{
        if (chunk.length === 0)
        {
            return false;
        }
        const copies = copyPages(chunk.map(record=>record.reads ?? record.pages));
        const relink = {
            jobs: chunk.map(record=>({ entry: record.entry, entryTop: record.entryTop,
                hash: record.hash, checked: record.checked === true, copies: record.copies === true,
                ...precisionJob(record),
                ...(record.targets === undefined ? {} : { targets: record.targets }) })),
            pages: [...copies],
            formable: chunk.flatMap(record=>[...record.formable ?? record.pages]),
            form: formOptions,
        };
        const translator = freeTranslator();
        if (translator !== null)
        {
            const pending = { id: ++workerRequest, relink: chunk, store, at: performance.now(),
                alone: true };
            translator.pending = pending;
            translator.adapter.post({ id: pending.id, relink, layout, features: found,
                options: emitOptions() }, [...copies.values()].map(bytes=>bytes.buffer));
            return true;
        }
        const batch = relinkBatch(relink, layout, found, emitOptions(), emitCache);
        counts.emitMs += batch.emitMs;
        counts.encodeMs += batch.encodeMs;
        applyRelink(chunk, batch, null, store);
        return true;
    };

    /**
     * A worker's answer: one module for the batch, published. Runs on the
     * engine thread when the message arrives, which is between the frames the
     * host asked for.
     *
     * @param {Translator} translator
     * @param {{ id: number, batch: import('./emit-built.js').BuiltBatch | null,
     *     compiled?: WebAssembly.Module | null, message?: string, busyMs?: number }} data
     */
    const onWorkerResults = (translator, data)=>{
        const pending = translator.pending;
        if (pending === null || data?.id !== pending.id)
        {
            return;
        }
        translator.pending = null;
        uncover(pending);
        if (translator.leaving)
        {
            dropTranslator(translator);
        }
        if (!data.batch)
        {
            refused[`emit: ${data.message ?? 'the worker failed'}`] = 1;
            return;
        }
        counts.workerMs += data.batch.emitMs + data.batch.encodeMs;
        if (settings.timings === true)
        {
            counts.workerBusyMs += data.busyMs ?? 0;
            counts.inFlightMs += performance.now() - pending.at;
        }
        const publishedAt = clock();
        if (pending.relink)
        {
            applyRelink(pending.relink, data.batch, data.compiled ?? null, pending.store);
        }
        else
        {
            // A credit's worth a call where the work here is bounded: a
            // translator's batch of a hundred regions held the thread for ten
            // milliseconds published at once. One emitted here has held it
            // longer emitting, and is published in the call that emitted it.
            publishBatch(pending.metas ?? [], data.batch, data.compiled ?? null, pending.store,
                holding());
        }
        noteStall(pending.relink ? 'relink' : 'publish', publishedAt);
        sendNext();
    };

    /**
     * A batch given up: its answer, should it come, no longer matches, and
     * the candidates it held are free to be taken again.
     * @param {Translator} translator
     */
    const giveUp = translator=>{
        const { pending } = translator;
        if (pending === null)
        {
            return;
        }
        for (const one of pending.metas ?? [])
        {
            inFlight.delete(keyOf(one.region.entry, one.entryTop));
        }
        uncover(pending);
        translator.pending = null;
    };
    /** @param {Translator} translator */
    const dropTranslator = translator=>{
        const at = translators.indexOf(translator);
        if (at >= 0)
        {
            translators.splice(at, 1);
        }
        translator.adapter.terminate();
    };

    /**
     * A translation worker taken on: a worker the runtime opened, or one a
     * host's pool lends it. It is made at once and loads its modules after: a
     * batch posted before then waited out the load -- a quarter of a second
     * from source -- while inline it would have run. So the batches go to it
     * only once it has answered a first message of its own, and are emitted
     * inline until then (while no other translator is ready).
     *
     * @param {import('./translator.js').WorkerAdapter} adapter
     */
    const attachTranslator = adapter=>{
        if (workerClosed)
        {
            adapter.terminate();
            return;
        }
        /** @type {Translator} */
        const translator = { adapter, ready: false, pending: null, leaving: false };
        if (translators.length === 0 && !awaitingLend)
        {
            loadingSince = performance.now();
        }
        awaitingLend = false;
        translators.push(translator);
        adapter.onMessage(data=>{
            if (data?.ready === true)
            {
                translator.ready = true;
                // What waited for it goes now.
                sendNext();
                return;
            }
            onWorkerResults(translator, data);
            // A translator free beside others still out takes the next batch
            // now rather than at the host's next ask.
            sendNext();
        });
        adapter.onLost(reason=>{
            // A worker that cannot load or has died answers nothing again:
            // its batch is given up so the next one is not held behind it,
            // and emitting goes back inline once no translator is left.
            if (!translators.includes(translator))
            {
                return;
            }
            refused[`worker: ${reason}`] = 1;
            giveUp(translator);
            dropTranslator(translator);
        });
        adapter.post({ ready: true, doorbell: settings.doorbell ?? null, arena }, []);
    };

    /**
     * A translator asked to go: it takes no batch from now on, and goes as
     * soon as the one it holds is back.
     * @param {import('./translator.js').WorkerAdapter} adapter
     */
    const detachTranslator = adapter=>{
        const translator = translators.find(one=>one.adapter === adapter);
        if (translator === undefined)
        {
            return;
        }
        translator.leaving = true;
        if (translator.pending === null)
        {
            dropTranslator(translator);
        }
    };

    if (workerUrl !== null)
    {
        for (let n = 0; n < settings.translators; n++)
        {
            openTranslationWorker(workerUrl).then(adapter=>{
                if (adapter !== null)
                {
                    attachTranslator(adapter);
                }
            }, ()=>{});
        }
    }

    /**
     * Takes a formed region's record as the store answered it: none, one
     * whose batch module this run has an instance of (`moduleBytes`
     * undefined), or one with its batch module's bytes -- a miss when those
     * are gone.
     *
     * @param {any} one  a formed region
     * @param {import('./cache.js').CachedRegion | null} cached
     * @param {Uint8Array | null} [moduleBytes]
     */
    const settle = (one, cached, moduleBytes)=>{
        one.cached = cached;
        if (cached === null)
        {
            counts.missNoRecord++;
        }
        else if (moduleBytes !== undefined)
        {
            one.moduleBytes = moduleBytes;
            if (moduleBytes === null)
            {
                counts.missNoModule++;
                one.cached = null;
            }
        }
        else if (cached.moduleKey !== undefined)
        {
            // Its batch's instance, held until the region is published.
            one.batchInstance = batchInstances.get(cached.moduleKey);
            if (one.batchInstance === undefined)
            {
                counts.missNoModule++;
                one.cached = null;
            }
        }
        if (one.cached !== null)
        {
            counts.cacheHits++;
        }
        else
        {
            counts.cacheMisses++;
            trace(storeTrace.missed, one);
        }
    };

    /**
     * A batch's lookups answered at once, where the store can answer without
     * a turn of the event loop (`getNow`: a directory store in a worker reads
     * its records file through a synchronous handle). The batch is then
     * published in the call that formed it, as without a store, where a turn
     * later -- with no batch formed meanwhile -- a first run went on
     * interpreted, formed other regions and emitted more than the store
     * saved. False, with nothing taken, when a lookup cannot be answered so.
     *
     * @param {any[]} formed @param {any} store
     */
    const lookUpNow = (formed, store)=>{
        if (typeof store.getNow !== 'function')
        {
            return false;
        }
        // A store across a link answers a batch's names at once, one wait for
        // all of them; any other is asked a name at a time.
        /** @type {(keys: string[]) => (Uint8Array | null | undefined)[] | undefined} */
        const many = typeof store.getManyNow === 'function'
            ? keys=>(keys.length === 0 ? [] : store.getManyNow(keys))
            : keys=>keys.map(key=>store.getNow(key));
        /** A batch module's bytes are read once for every record naming it.
         * @type {Map<string, Uint8Array | null>} */
        const modules = new Map();
        /** @type {[import('./cache.js').CachedRegion | null, Uint8Array | null | undefined][]} */
        const answers = [];
        try
        {
            const records = many(formed.map(one=>regionKey(one)));
            if (!records || records.some(bytes=>bytes === undefined))
            {
                return false;
            }
            const cached = records.map(bytes=>(bytes === null || bytes === undefined
                ? null : unpackRegion(bytes, cacheVersion)));
            /** @type {string[]} */
            const wanted = [...new Set(cached.map(one=>one?.moduleKey)
                .filter(/** @returns {key is string} */ key=>key !== undefined
                    && !batchInstances.has(key)))];
            const stored = many(wanted);
            if (!stored || stored.some(bytes=>bytes === undefined))
            {
                return false;
            }
            wanted.forEach((key, i)=>{
                const bytes = stored[i];
                modules.set(key, bytes === null || bytes === undefined
                    ? null : unpackRegion(bytes, cacheVersion)?.module ?? null);
            });
            for (const one of cached)
            {
                const batchKey = one?.moduleKey;
                answers.push([one, batchKey !== undefined && !batchInstances.has(batchKey)
                    ? modules.get(batchKey) : undefined]);
            }
        }
        catch {
            return false;
        }
        formed.forEach((one, i)=>settle(one, ...answers[i]));
        return true;
    };

    /**
     * A batch's regions to publish a credit's worth a call (`publishOn`). A
     * store hit whose module this run has not instantiated waits for it to be
     * compiled off this thread, once for every hit naming it -- by its batch's
     * key, or by itself for a module of its own.
     *
     * @param {Waiting[]} waiting
     */
    const publishLater = waiting=>{
        /** @type {Map<string | object, Promise<WebAssembly.Instance | null>>} */
        const instances = new Map();
        for (const { instance, source, bytes } of waiting)
        {
            if (instance !== null || source === undefined || bytes === undefined
                || instances.has(source))
            {
                continue;
            }
            /** @param {unknown} e */
            const failed = e=>{
                refused.batch = (refused.batch ?? 0) + 1;
                refused[`batch: ${String(e).slice(0, 120)}`] = 1;
                return null;
            };
            counts.compiledApart++;
            instances.set(source, WebAssembly.compile(
                /** @type {Uint8Array<ArrayBuffer>} */ (bytes)).then(module=>{
                if (workerClosed)
                {
                    return null;
                }
                const made = instantiate(module);
                if (made !== null && typeof source === 'string')
                {
                    batchInstances.set(source, made);
                    modulesSinceRelink++;
                }
                return made;
            }, failed));
        }
        const batch = { waiting, next: 0, ready: instances.size === 0 };
        toPublish.push(batch);
        if (batch.ready)
        {
            queueMicrotask(sendNext);
        }
        else
        {
            Promise.all(waiting.map(async entry=>{
                if (entry.instance === null && entry.source !== undefined)
                {
                    entry.instance = await instances.get(entry.source) ?? null;
                }
            })).then(()=>{
                batch.ready = true;
                sendNext();
            });
        }
    };

    /**
     * Publishes the batches `toPublish` holds from where it stopped, while
     * the first is ready, until they are all published or the call has taken
     * the credit; then the next batch may go.
     *
     * @returns {number} regions published
     */
    const publishOn = ()=>{
        const left = holding() ? creditNow() : Infinity;
        if (left <= 0 && !workerClosed)
        {
            counts.heldBack++;
            resumeWanted = true;
            return 0;
        }
        const until = performance.now() + left;
        let published = 0;
        let any = false;
        while (toPublish[0]?.ready === true)
        {
            const batch = toPublish[0];
            // The machine gone, nothing is published.
            const end = workerClosed ? batch.next : batch.waiting.length;
            for (; batch.next < end; batch.next++)
            {
                if (any && performance.now() >= until)
                {
                    counts.publishedInPart++;
                    resumeWanted = true;
                    return published;
                }
                any = true;
                const { one, built, instance } = batch.waiting[batch.next];
                if (instance !== null)
                {
                    published += applyBuilt(one, built, instance);
                }
            }
            toPublish.shift();
        }
        // The asks owed while they waited: as after a batch the store answered
        // whole, the next goes after this turn.
        queueMicrotask(sendNext);
        return published;
    };

    /**
     * The publish half of a batch, when its store lookups are back (or at
     * once, without a store or with one that answers at once): the regions
     * the store held are instantiated and published, and the rest are
     * emitted -- on the worker if there is one, inline otherwise -- stored and
     * published.
     *
     * @param {any[]} formed
     * @param {any} store
     * @returns {number} regions published
     */
    const finishBatch = (formed, store)=>{
        if (workerClosed)
        {
            // The machine went away while the store's bytes were in flight.
            return 0;
        }
        let published = 0;
        // Where the work here is bounded (`holding`), the hits wait for `publishOn`:
        // their modules compiled off this thread, then published a credit's
        // worth a call. A module compiled here held the thread for its whole
        // size, ten milliseconds for one of five megabytes.
        /** @type {Waiting[] | null} */
        const waiting = holding() ? [] : null;
        for (const one of formed)
        {
            if (one.cached === null)
            {
                continue;
            }
            // A stored region is a function of its batch's module, instantiated
            // once for every region of it; a record with a module of its own
            // is that module alone.
            const key = one.cached.moduleKey;
            let instance = key === undefined ? undefined
                : one.batchInstance ?? batchInstances.get(key);
            one.batchInstance = undefined;
            if (waiting !== null)
            {
                // The guest runs before it is published; the entry holds the
                // instance found until then, as `batchInstance` did.
                one.waited = true;
                waiting.push({ one, built: one.cached, instance: instance ?? null,
                    source: key ?? one,
                    bytes: key === undefined ? one.cached.module : one.moduleBytes });
                continue;
            }
            if (instance === undefined)
            {
                instance = instantiate(key === undefined ? one.cached.module : one.moduleBytes)
                    ?? undefined;
                if (instance !== undefined && key !== undefined)
                {
                    batchInstances.set(key, instance);
                    modulesSinceRelink++;
                }
            }
            if (instance !== undefined)
            {
                published += applyBuilt(one, one.cached, instance);
            }
        }
        if (waiting !== null && waiting.length > 0)
        {
            publishLater(waiting);
        }
        const unbuilt = formed.filter(one=>one.cached === null);
        // Built as the region's precision and the shape tests now say, whatever
        // they said when formed.
        for (const one of unbuilt)
        {
            Object.assign(one, precisionFlags(one.region, one.entryTop));
            one.loose = loose;
            one.wrapped = !readsChecked;
            one.checked = checkedAt(one.region, one.entryTop);
        }
        const translator = unbuilt.length > 0 ? freeTranslator() : null;
        if (translator !== null)
        {
            // Off the frame thread: post the batch and answer with it later.
            // The records are kept until then; nothing here waits.
            // The worker forms the regions again from a copy of their pages, as
            // a relink does, and keeps each one only when its bytes hash as they
            // did here.
            /** @type {Pending} */
            const pending = { id: ++workerRequest, metas: unbuilt, store, at: performance.now(),
                alone: postingAlone, covers: [] };
            for (const one of unbuilt)
            {
                if (!usesX87(one.region))
                {
                    for (const block of one.region.blocks)
                    {
                        pending.covers?.push(block.start);
                        coveredOut.set(block.start, (coveredOut.get(block.start) ?? 0) + 1);
                    }
                }
            }
            translator.pending = pending;
            for (const one of unbuilt)
            {
                one.waited = true;
            }
            const copies = copyPages(unbuilt.map(one=>one.region.reads ?? one.region.pages));
            translator.adapter.post({
                id: pending.id,
                relink: {
                    jobs: unbuilt.map(one=>({ entry: one.region.entry, entryTop: one.entryTop,
                        hash: one.region.hash, checked: one.checked, copies: one.copies === true,
                        ...precisionJob(one),
                        ...(one.targets === undefined ? {} : { targets: one.targets }) })),
                    pages: [...copies],
                    formable: unbuilt.flatMap(one=>[...one.region.formable ?? one.region.pages]),
                    form: formOptions,
                },
                layout, features: found, options: emitOptions(),
            }, [...copies.values()].map(bytes=>bytes.buffer));
            return published;
        }
        if (unbuilt.length > 0)
        {
            // The batch in one module, as the worker would have made it; a
            // region the emitter fails on is named in the report and the
            // program runs on without it.
            const jobs = unbuilt.map(one=>({ region: one.region, entryTop: one.entryTop,
                checked: one.checked, copies: one.copies === true, ...precisionJob(one) }));
            const batch = emitBatch(jobs, layout, found, emitOptions(), emitCache);
            counts.emitMs += batch.emitMs;
            counts.encodeMs += batch.encodeMs;
            published += publishBatch(unbuilt, batch, null, store);
        }
        return published;
    };

    /**
     * The `count` hottest candidates: the buckets from the hottest down, in
     * arrival order within one, so the sampler's candidates keep theirs.
     *
     * @param {number} count
     * @returns {[number, number][]}
     */
    const hottest = count=>{
        /** @type {[number, number][]} */
        const top = [];
        for (let b = buckets.length - 1; b >= 0 && top.length < count; b--)
        {
            for (const entry of buckets[b])
            {
                top.push(entry);
                if (top.length === count)
                {
                    break;
                }
            }
        }
        return top;
    };

    /**
     * One batch: formed here, and emitted here too while no worker takes it.
     * What `translatePending` runs, synchronously throughout; the time it
     * takes is charged to the credit (`holdMs`).
     *
     * @returns {number}
     */
    const translateNow = ()=>{
        if (!holding())
        {
            return translateStep();
        }
        const startedAt = performance.now();
        try
        {
            return translateStep();
        }
        finally
        {
            creditNow();
            credit -= performance.now() - startedAt;
            armResume();
        }
    };

    /** @returns {number} */
    const translateStep = ()=>{
        if (profileAt >= 0)
        {
            sampleCalls();
        }
        if (settings.timings === true)
        {
            const now = performance.now();
            if (lookedAt !== 0 && batchesOut() && freeTranslator() === null && queue.size > 0)
            {
                counts.behindMs += now - lookedAt;
            }
            lookedAt = now;
            counts.queueMax = Math.max(counts.queueMax, queue.size);
        }
        // A batch is with the worker: its answer is published when it
        // comes back, so the engine never waits for it. Candidates
        // formed in the meantime stay queued for the next call. A
        // batch's store lookups are likewise in flight: the next batch
        // waits for them, so the pending ones publish in order.
        // A batch the worker has held past the in-flight limit is given
        // up: its answer, should it come, no longer matches, and the
        // candidates it held are free to be taken again.
        for (const translator of translators)
        {
            if (translator.pending !== null && overdue(translator.pending.at))
            {
                refused['worker: no answer'] = (refused['worker: no answer'] ?? 0) + 1;
                giveUp(translator);
            }
        }
        if (toPublish[0]?.ready === true)
        {
            return publishOn();
        }
        if (forming !== null)
        {
            return formOn();
        }
        // Every translator busy, or one holding a batch nothing may be beside:
        // the ask is owed until an answer frees one. With none ready the batch
        // is emitted here, as without a worker.
        if (!batchMayGo())
        {
            owed++;
            return 0;
        }
        if (holding() && creditNow() <= 0)
        {
            // Forming has had its share: the ask waits until it is back.
            owed = Math.max(owed, 1);
            counts.heldBack++;
            resumeWanted = true;
            return 0;
        }
        owed = Math.max(0, owed - 1);
        if (!settings.translate)
        {
            return 0;
        }
        // A relink only while nothing hot waits: a chunk holds the worker for
        // seconds, and code the interpreter keeps meeting runs interpreted
        // until its own batch comes back. A title's queue is never empty --
        // the cold starts met twice stay -- so the test is the heat, not the
        // length.
        const keeps = leaveOut.size > 0 || settings.undoLog || profiling
            ? null : (settings.store ?? null);
        // The steps that take over running regions go out alone: only with no
        // batch out, and nothing goes beside them until they are back.
        if (!batchesOut())
        {
            postingAlone = true;
            try
            {
                if (copiesWanted.size > 0 && copiesStep(keeps))
                {
                    return 0;
                }
                if (!buckets.slice(HOT_BUCKET).some(bucket=>bucket.size > 0)
                    && (profileAt >= 0 && reformStep(keeps) || relinkStep(keeps)))
                {
                    return 0;
                }
            }
            finally
            {
                postingAlone = false;
            }
        }
        if (queue.size === 0)
        {
            return 0;
        }
        // A deep queue -- a loading phase, where every start met twice is
        // a candidate and one batch is in flight at a time -- takes a bigger
        // batch, a quarter of what waits up to `maxBatchRegions`, so the
        // round trip through the worker and the store is paid per hundreds
        // of regions rather than per thirty-two.
        // While the worker loads, a batch emitted here is kept small.
        const ceiling = translatorLoading() && !translatorReady()
            ? settings.loadingBatch : settings.maxBatchRegions;
        const wanted = Math.min(ceiling,
            Math.max(settings.batchRegions, queue.size >> 2));
        forming = { batch: hottest(wanted), next: 0, formed: [], covered: new Set(), ceiling,
            takenAt: performance.now() };
        return formOn();
    };

    /**
     * Forms the batch `forming` holds from where it stopped, until it is whole
     * or the call has taken the credit, and then sends it on. A candidate is
     * taken from the queue as it is formed, so one the batch did not reach
     * yet is a candidate as any other while the guest runs.
     *
     * @returns {number} regions published
     */
    const formOn = ()=>{
        const step = /** @type {NonNullable<typeof forming>} */ (forming);
        const { batch, formed, covered, ceiling, takenAt } = step;
        const left = holding() ? creditNow() : Infinity;
        if (left <= 0)
        {
            counts.heldBack++;
            resumeWanted = true;
            return 0;
        }
        const until = performance.now() + left;
        const first = step.next;
        const formedAt = clock();
        // Nothing runs while this call forms, so its regions share what
        // decoding finds; the guest runs between two calls, which may write
        // the code over.
        const shared = formShared();
        for (; step.next < batch.length; step.next++)
        {
            if (step.next > first && performance.now() >= until)
            {
                break;
            }
            const [key, eip] = batch[step.next];
            unqueue(key);
            dropKey(key);
            inFlight.set(key, takenAt);
            const entryTop = key % 16;
            // A candidate that has an entry by now -- a block of a region
            // published while it waited, the return address of a call the
            // interpreter met before its caller's region came back -- would
            // be formed again as a region of its own.
            if (covered.has(eip) || coveredOut.has(eip) || closedIn.has(eip)
                || entries.entryOf(eip, entryTop) >= 0)
            {
                inFlight.delete(key);
                continue;
            }
            const region = formRegion(read, eip, { ...formHere, translatable, shared });
            // What the region calls directly lands in the same batch, so
            // the call and the return transfer without a miss -- each
            // callee at the top the call site has, which the tracker
            // knows wherever it reached the block: batching it at the
            // entry's top compiled a callee nobody calls for a region
            // whose own x87 moved the stack before the call. Up to the
            // batch's ceiling, not its usual size: a loader's function
            // calls dozens, each of which the interpreter otherwise ran
            // and whose loop, hot first, became a region of its own
            // headed there rather than at the function's start.
            const tracked = usesX87(region) ? trackRegion(region, entryTop) : null;
            for (let at = 0; at < region.blocks.length; at++)
            {
                const block = region.blocks[at];
                if (block.exit.kind !== 'call')
                {
                    continue;
                }
                const [callee] = block.exit.targets;
                const end = tracked === null ? null : tracked.ends[at];
                const top = end === null ? entryTop : end.top;
                if (batch.length < ceiling
                    && entries.entryOf(callee, top) < 0 && translatable(callee)
                    && !batch.some(([queued])=>queued === keyOf(callee, top)))
                {
                    batch.push([keyOf(callee, top), callee]);
                }
            }
            for (const [opcode, times] of region.refused)
            {
                refused[opcode] = (refused[opcode] ?? 0) + times;
            }
            // The entry's own block decides whether nothing was formed:
            // the first in address order is another block wherever the
            // region reaches code below the entry.
            const entryBlock = region.blocks.find(block=>block.start === eip);
            if (entryBlock === undefined || entryBlock.instructions.length === 0)
            {
                barrenAdd(eip, entryTop);
                continue;
            }
            formed.push({ region, entryTop, stamp: stamp(region.pages), cached: null,
                ...precisionFlags(region, entryTop), loose,
                wrapped: !readsChecked,
                checked: checkedAt(region, entryTop) });
            if (!usesX87(region))
            {
                for (const block of region.blocks)
                {
                    covered.add(block.start);
                }
            }
        }
        counts.formingMs += clock() - formedAt;
        if (step.next < batch.length)
        {
            // The guest runs before the rest is formed: what is formed so far
            // is read again when it is published.
            for (const one of formed)
            {
                one.waited = true;
            }
            counts.formedInPart++;
            resumeWanted = true;
            return 0;
        }
        forming = null;
        // A region formed by an earlier call was formed from bytes the guest
        // may have written since: one that reads otherwise now goes, a
        // candidate to be noted again as any other. Sent on, the translator
        // would form it again from the bytes there now, refuse it as changed,
        // and leave its address barren until its page was written once more.
        for (let at = formed.length - 1; at >= 0; at--)
        {
            const { region, entryTop, waited } = formed[at];
            if (waited === true && (region.sources !== undefined
                ? sourcesChanged(region.sources, 0, 0x100000000)
                : hashRegion(read, region) !== region.hash))
            {
                inFlight.delete(keyOf(region.entry, entryTop));
                counts.dropped++;
                formed.splice(at, 1);
            }
        }
        // A diagnostic run with classes left out, or with an undo log the
        // stored modules were built without, keeps no translations.
        const store = leaveOut.size > 0 || settings.undoLog || profiling
            ? null : (settings.store ?? null);
        if (store === null)
        {
            return finishBatch(formed, null);
        }
        const lookupAt = clock();
        if (lookUpNow(formed, store))
        {
            counts.lookedUpNow++;
            counts.lookupMs += clock() - lookupAt;
            const published = finishBatch(formed, store);
            // A batch the store answered whole has no answer to come back
            // with, which is what sends the next one for the asks still owed:
            // the next goes after this turn, as it would after the worker's.
            queueMicrotask(sendNext);
            return published;
        }
        // A store that cannot answer at once answers off the slice path:
        // the batch's records are requested here and the slice goes on. The
        // batch is published when the bytes are back -- between frames, as
        // instantiation already is -- and a region not back is not
        // published this frame. `lookupMs` is the engine thread's own time
        // to start them.
        storePending = true;
        counts.lookedUpLater++;
        // A batch module's bytes are read once for every record naming it.
        /** @type {Map<string, Promise<Uint8Array | null>>} */
        const modules = new Map();
        /** @param {string} key */
        const moduleBytes = key=>{
            let pending = modules.get(key);
            if (pending === undefined)
            {
                /** @param {Uint8Array | null} bytes */
                const unpack = bytes=>(bytes === null
                    ? null : unpackRegion(bytes, cacheVersion)?.module ?? null);
                pending = /** @type {Promise<Uint8Array | null>} */ (store.get(key).then(unpack));
                modules.set(key, pending);
            }
            return pending;
        };
        // The guest runs on while the store answers.
        const answered = ()=>{
            storePending = false;
            for (const one of formed)
            {
                one.waited = true;
            }
            finishBatch(formed, store);
            sendNext();
        };
        Promise.all(formed.map(async one=>{
            try
            {
                const bytes = await store.get(regionKey(one));
                const cached = bytes === null ? null : unpackRegion(bytes, cacheVersion);
                const batchKey = cached?.moduleKey;
                // Its batch's module, unless this run instantiated it already.
                settle(one, cached, batchKey !== undefined && !batchInstances.has(batchKey)
                    ? await moduleBytes(batchKey) : undefined);
            }
            catch {
                settle(one, null);
            }
        })).then(answered, answered);
        counts.lookupMs += clock() - lookupAt;
        return 0;
    };

    /** @type {Runtime & { pages: import('./pages.js').PageTable }} */
    const api = {
        pages,
        entryOf(eip, top = 0){
            const entry = entries.entryOf(eip, top);
            if (entry < 0 && (entries.isSpecialised(eip) || entries.isBlocked(eip)))
            {
                // A region exists here for another top, or holds a block here
                // it cannot enter itself (an x87 block with no known state, or
                // one cut for a second top): one for this top is a candidate,
                // translated with the next batch -- as hot as the machine
                // keeps standing here.
                const key = keyOf(eip, top & 7);
                const heat = (variantHeat.get(key) ?? 0) + 1;
                if (variantHeat.size >= MISSES_CAP)
                {
                    variantHeat.clear();
                }
                variantHeat.set(key, heat);
                this.noteHot(eip, top, heat);
            }
            return entry;
        },
        run(entry, budget){
            const { fn, label } = entries.at(entry);
            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && profileResetAt !== null
                && performance.now() >= profileResetAt)
            {
                profileResetAt = null;
                resetBlockCounts(view(), layout);
                // The exits are counted over the same window as the blocks.
                for (const name of /** @type {(keyof typeof exits)[]} */ (Object.keys(exits)))
                {
                    exits[name] = 0;
                }
                for (const name of /** @type {(keyof typeof untranslatedBy)[]} */ (
                    Object.keys(untranslatedBy)))
                {
                    untranslatedBy[name] = 0;
                }
                exitTargets.clear();
            }
            // One record, rewritten per run: a call-heavy program leaves
            // and re-enters per call, and an object per leave was the
            // collector's share of the cost.
            const before = counterWord();
            const tierBefore = tierEntered === null ? 0 : tierEntered();
            const code = enterRegion(fn, label, budget, view(), layout) >>> 0;
            const retired = (counterWord() - before) >>> 0;
            corkRetired += tierEntered === null ? retired
                : retired - ((tierEntered() - tierBefore) >>> 0);
            const kind = KINDS[code & 0xff] ?? 'untranslated';
            exits[kind]++;
            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && kind === 'untranslated')
            {
                untranslatedBy[VECTOR_NAMES[code >>> 8] ?? 'other']++;
            }
            if (kind === 'untranslated' && code >>> 8 === PRECISION)
            {
                precisionMissed(view().getUint32(layout.eip, true));
            }
            else if (kind === 'untranslated' && code >>> 8 === RANGE)
            {
                floatMissed(view().getUint32(layout.eip, true));
            }
            else if (kind === 'untranslated' && code >>> 8 === SHAPE)
            {
                const record = shapeMissed(view().getUint32(layout.eip, true),
                    view().getUint8(layout.x87Top));
                if (record !== null)
                {
                    // Its code is hot: formed again, checked, with the next batch.
                    this.noteHot(record.entry, record.entryTop, 256);
                }
            }
            else if (kind === 'untranslated')
            {
                this.missAt(view().getUint32(layout.eip, true), view().getUint8(layout.x87Top),
                    code >>> 8 === HELD);
            }
            // Looked at whatever the run left by: a rep that stored into code and
            // ran out of budget on a later page in bulk leaves by the budget, and
            // the run that finishes it stores no code of its own.
            if (kind === 'stale' || view().getUint32(layout.tables + Tables.STALE_END, true) !== 0)
            {
                // Every page the run's stores into code reached, from the
                // lowest of them to the highest.
                const address = pages.staleAddress();
                const size = pages.staleSize();
                pages.clearStale();
                storedInto(address, size);
                codeShared?.publish(address, size);
                // The other executor's compiled page, if that is what was hit.
                imports.dirtyCode?.(address, size);
            }
            exit.retired = retired;
            exit.kind = kind;
            exit.vector = code >>> 8;
            return exit;
        },
        /** Records one untranslated exit to `address` at `top`: the address
         * becomes a candidate of the translator's own once `missThreshold` of
         * them land there at that top. The count is per top, so a flood of
         * misses at a top that is already served never withholds the one that
         * is not; it is bounded and the coldest key makes room.
         * @param {number} address @param {number} [top]
         * @param {boolean} [held]  a region left it to the host on purpose (`HELD`)
         */
        missAt(address, top = 0, held = false){
            const at = top & 7;
            // One record a target, changed in place: a call into a page left
            // to the interpreter exits once a call, and a map read and write
            // for each of two counts was a tenth of the crossing.
            let target = exitTargets.get(address);
            if (target === undefined)
            {
                target = { count: 0, held: 0, tops: 0 };
                exitTargets.set(address, target);
            }
            target.count++;
            if (held)
            {
                target.held++;
            }
            target.tops |= 1 << at;
            if (exitTargets.size > EXIT_TARGETS_CAP)
            {
                // The colder half goes at once: one pass for half the cap's
                // insertions, where a scan for the single coldest on every
                // insertion past the cap was a third of a loading phase.
                const heats = [...exitTargets.values()].map(one=>one.count).sort((a, b)=>a - b);
                const cold = heats[heats.length >> 1];
                for (const [addr, one] of exitTargets)
                {
                    if (one.count <= cold && exitTargets.size > EXIT_TARGETS_CAP >> 1)
                    {
                        exitTargets.delete(addr);
                    }
                }
            }
            if (held)
            {
                // A window its accesses would fault on or a store into code: a
                // region formed there, or one formed again with copies, tests
                // the same and leaves the same way, so it is no candidate --
                // counted, a hot one had every region holding it closed formed
                // again (a hundred and more for one small function formed into
                // its callers) and each such copy left there again.
                return;
            }
            const key = keyOf(address, at);
            const seen = (misses.get(key) ?? 0) + 1;
            if (seen >= settings.missThreshold)
            {
                misses.delete(key);
                const holders = closedIn.get(address);
                if (holders !== undefined)
                {
                    // A block closed in the loop of a region translated code
                    // keeps leaving for (a jump back to it that is no loop's,
                    // another region's exit): that region, formed again with
                    // copies, takes it rather than a region formed here.
                    for (const record of holders)
                    {
                        copiesWanted.add(record);
                    }
                    return;
                }
                // Noted with the exits this target has taken as its heat, and
                // again at every further threshold, so a target translated
                // code leaves for millions of times is formed before a start
                // the interpreter met twice -- a candidate noted cold sat in the
                // queue's bottom bucket behind a loader's thousands while
                // twelve million exits went to it.
                this.noteHot(address, at, target.count);
                return;
            }
            // A count is never below one, so a first sight is a new key.
            if (seen === 1 && misses.size >= MISSES_CAP)
            {
                const oldest = misses.keys().next().value;
                if (oldest !== undefined)
                {
                    misses.delete(oldest);
                }
                if (++missesInserted >= MISSES_CAP)
                {
                    missesInserted = 0;
                    decayMisses();
                }
            }
            misses.set(key, seen);
        },
        /**
         * The program faulted on a page it cannot reach: reads are tested
         * from now on (`checkReads` left unset).
         */
        readsFaulted,
        /** Whether translated reads test their pages now. */
        readsChecked: ()=>readsChecked,
        noteHot(eip, top = 0, hotness = 0){
            if (!settings.translate)
            {
                return;
            }
            const key = keyOf(eip, top & 7);
            const since = inFlight.get(key);
            if (since !== undefined)
            {
                if (!overdue(since))
                {
                    return;
                }
                inFlight.delete(key);
            }
            if (queue.has(key))
            {
                // Noted again while it waits: the layer saw it run more, so
                // it moves up a bucket.
                const b = bucketOf(hotness);
                const was = heatOf.get(key) ?? 0;
                if (b > was)
                {
                    buckets[was].delete(key);
                    buckets[b].set(key, eip);
                    heatOf.set(key, b);
                }
                return;
            }
            // A block closed in a live region's loop is that region's, formed
            // again with copies should translated code keep leaving for it.
            if (entries.entryOf(eip, top & 7) >= 0 || barrenHas(eip, top & 7)
                || !translatable(eip) || closedIn.has(eip))
            {
                return;
            }
            enqueue(key, eip, hotness);
        },
        seedRecords,
        attachTranslator,
        detachTranslator,
        /** Writes whatever the store keeps aside from its records, so the
         * names of this run's regions are on disk before the run ends and the
         * next run's index can find them. The store stays open: it is its
         * opener's to close, and a run hands one store to the machine of every
         * process it starts, so a machine that goes would otherwise take it
         * from the processes still running. */
        async flush(){
            await settings.store?.flush?.();
            // The worker holds nothing the store needs; end it and drop any
            // batch it still owes.
            workerClosed = true;
            for (const translator of [...translators])
            {
                giveUp(translator);
                dropTranslator(translator);
            }
        },

        /** @type {() => Promise<number>} */
        async translatePending(){
            liftVolatile();
            if (!translatorLoading() || translatorReady())
            {
                return translateNow();
            }
            // The worker is loading: what is asked for now is emitted here, in
            // small batches and for a quarter of the time the load has taken at
            // most, and the rest waits for it. A loading phase's thousands of
            // starts, each run a few times, cost more emitted on this thread
            // than interpreted until the worker takes them.
            if (inlineWhileLoading > settings.loadingShare * (performance.now() - loadingSince))
            {
                owed++;
                return 0;
            }
            const startedAt = performance.now();
            try
            {
                return translateNow();
            }
            finally
            {
                inlineWhileLoading += performance.now() - startedAt;
            }
        },
        invalidatePage,
        /**
         * `[address, address + size)` was written over code: the regions made of
         * a byte it changed go (`storedInto`).
         *
         * @param {number} address @param {number} size
         * @param {boolean} [own]  a store of the program's own, met by the host's
         *     interpreter, rather than the host's write
         */
        stored(address, size, own = false){
            storedInto(address, size, own);
        },
        /**
         * A store this executor met reached code: its translations of the pages
         * go, and the other executors of the process are told theirs do.
         *
         * @param {number} address @param {number} size
         */
        codeWritten(address, size){
            if (size <= 0)
            {
                return;
            }
            storedInto(address, size);
            codeShared?.publish(address, size);
        },
        /**
         * The stores into code the process's other executors met since this
         * one last looked: its translations of those pages go. Asked before
         * each slice.
         */
        takeCodeWrites(){
            return codeShared?.take((address, size)=>{
                if (size === 0xffffffff)
                {
                    for (const page of [...byPage.keys()])
                    {
                        invalidatePage(page);
                    }
                    return;
                }
                storedInto(address, size);
            }) ?? 0;
        },
        interpretWith(entry, entered){
            if (!resumable)
            {
                return false;
            }
            /** @type {WebAssembly.Table} */ (table).set(TIER_SLOT, entry);
            tierEntered = entered;
            return true;
        },
        noteStall,
        /** @param {number} page */
        holdsPage: page=>(pages.get(page) & PageFlag.HAS_CODE) !== 0,
        noteStack(base, size){
            const first = base >>> 12;
            const last = (base + Math.max(size, 1) - 1) >>> 12;
            for (let page = first; page <= last; page++)
            {
                stackPages.add(page);
                if ((pages.get(page) & PageFlag.HAS_CODE) !== 0)
                {
                    stackCodeSeen();
                }
            }
        },
        /** One turn the host forced an interpreted instruction through, for
         * the progress guarantee's diagnostics. */
        forcedStep(){
            forcedSteps++;
        },
        // The numbers a slice's counters want, and nothing that costs more
        // than reading them: the frame counters ask every slice, and the
        // whole snapshot below sorts the exit targets and names each one's
        // reason across the candidate queue -- a third of a loading phase's
        // engine time when it was asked that often.
        counters(){
            fold();
            return {
                regions: regions.size,
                modules: counts.modules,
                invalidations: counts.invalidations,
                translatedShare: counted > 0 ? corkRetired / counted : 0,
                retired: corkRetired,
                translateMs: counts.formingMs + counts.lookupMs + counts.emitMs
                    + counts.encodeMs + counts.storeMs + counts.instantiateMs + counts.publishMs,
                exits,
            };
        },
        diagnostics(){
            fold();
            const blocks = import.meta.BOTTLIFY_DIAGNOSTICS !== false && profiling
                ? blockCounts(view(), layout, regions) : null;
            return {
                ...(import.meta.BOTTLIFY_DIAGNOSTICS !== false && blocks
                    ? { blockCounts: blocks, topBlocks: topBlocks(blocks, regions),
                        mechanisms: mechanismCounts(view(), layout), forms: hotForms(blocks),
                        transferTargets: transferTargets(view(), layout) }
                    : {}),
                regions: regions.size,
                // Counted only by a run that asked (`countTransfers`), else 0.
                transfers: view().getUint32(layout.tables + Tables.TRANSFERS, true),
                relinks: counts.relinks,
                relinked: counts.relinked,
                merges: counts.merges,
                // The regions those merges built again, of `relinked`.
                merged: counts.merged,
                reforms: counts.reforms,
                copied: counts.copied,
                // Transfers that left a placed module through the table, as it
                // counts them (running modules only).
                crossings: [...placedLive].reduce((sum, placed)=>sum + placed.crossings.value, 0),
                // The function table's length: what the regions' indices span.
                tableSize: table ? table.length : 0,
                entries: table ? entries.hashed() : entries.count(),
                // Every entry, hashed or not: past the hash's room the rest are
                // reached from translated code only through the host.
                entriesAll: entries.count(),
                translateMs: counts.formingMs + counts.lookupMs + counts.emitMs
                    + counts.encodeMs + counts.storeMs + counts.instantiateMs + counts.publishMs,
                formingMs: counts.formingMs,
                lookupMs: counts.lookupMs,
                emitMs: counts.emitMs,
                encodeMs: counts.encodeMs,
                storeMs: counts.storeMs,
                instantiateMs: counts.instantiateMs,
                publishMs: counts.publishMs,
                workerMs: counts.workerMs,
                workerBusyMs: counts.workerBusyMs,
                inFlightMs: counts.inFlightMs,
                behindMs: counts.behindMs,
                queueMax: counts.queueMax,
                // Every module's bytes made in the run, relinks included -- not
                // what is held; `batchModulesHeld` is the stored batches' instances
                // still reachable.
                moduleBytes: counts.moduleBytes,
                modules: counts.modules,
                batchModulesHeld: batchInstances.live(),
                translatedShare: counted > 0 ? corkRetired / counted : 0,
                retired: corkRetired,
                cacheHits: counts.cacheHits,
                cacheMisses: counts.cacheMisses,
                missNoRecord: counts.missNoRecord,
                missNoModule: counts.missNoModule,
                lookedUpNow: counts.lookedUpNow,
                lookedUpLater: counts.lookedUpLater,
                formedInPart: counts.formedInPart,
                publishedInPart: counts.publishedInPart,
                heldBack: counts.heldBack,
                compiledApart: counts.compiledApart,
                // Times an x87 entry moved to the other precision control or to a
                // test at every rounding instruction (`precisionAt`).
                precisionSwitches: counts.precisionSwitches,
                // Reads tested since the program's first fault on a page it
                // cannot reach (1), or not (0).
                readSwitches: counts.readSwitches,
                // Whether stores through esp go untested (`looseStacks`), and how
                // often code on a stack switched that off (once at most).
                looseStacks: loose,
                stackCode: counts.stackCode,
                // The x87 entries by the precision control they are compiled for.
                precision: precisionCounts(),
                // Entries that found the x87 stack in another shape than their
                // block's, and the regions translated checked for it.
                shapeMisses: counts.shapeMisses,
                shapeChecked: counts.shapeChecked,
                // Single-precision operations on floats that left for the host because
                // the float result was not the processor's, and the regions that kept
                // leaving and went back to rounding from doubles (`floatSingles`).
                floatMisses: counts.floatMisses,
                floatsRounded: counts.floatsRounded,
                // Translated x87 status-word reads that may see what `precise`
                // alone keeps: where a strange result is worth a run with it.
                x87RelaxedReads: counts.x87RelaxedReads,
                // With `checkStale`, the regions still published whose bytes no
                // longer form as they did: translated code a write did not drop.
                ...(settings.checkStale ? { staleRegions: [...regions]
                    .filter(record=>formRegion(read, record.entry, { ...formHere, translatable,
                        ...(record.targets === undefined
                            ? {} : { callTargets: new Map(record.targets) }) }).hash
                        !== record.hash)
                    .map(record=>`0x${record.entry.toString(16)}`) } : {}),
                ...nanFirst(view(), layout),
                stalls: [...stalls],
                ...(import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.traceStore
                    ? { storeTrace } : {}),
                invalidations: counts.invalidations,
                dropped: counts.dropped,
                queued: queue.size,
                barren: barren.size,
                queueDrops: counts.queueDrops,
                emitFailures: counts.emitFailures,
                queueEvictions: counts.queueEvictions,
                // Times a page was left to the other executor, and the pages left now.
                volatilePages: counts.volatilePages,
                volatileNow: volatileUntil.size,
                storesKept: counts.storesKept,
                prediction: { due: counts.predictDue, noShare: counts.predictNoShare,
                    reformsOut: counts.predictReformsOut, notFormed: counts.predictNotFormed,
                    noRegion: counts.predictNoRegion, held: counts.predictHeld,
                    sites: [...siteLog].sort((a, b)=>b[1].samples - a[1].samples).slice(0, 4096)
                        .map(([site, one])=>({ site, ...one })),
                    reforms: counts.reforms },
                exits: { ...exits },
                untranslatedBy: { ...untranslatedBy },
                // The top untranslated-exit targets over the whole run (or the
                // block profile's window), and why each has no entry: what a
                // loading phase leaves behind. One only ever left on purpose
                // (HELD) is `held` -- its address is translated and no link is
                // missing; the reason of the rest is read now, not at the exit.
                exitsByTarget: [...exitTargets].sort((a, b)=>b[1].count - a[1].count).slice(0, 32)
                    .map(([address, { count, held }])=>({ address, count, held,
                        reason: held === count ? 'held' : missReason(address) })),
                refused: { ...refused },
                refusedWhy: { ...refusedWhy },
                // Where a program reads what `precise: false` leaves: a title that
                // misbehaves only without `precise` is looked for here first.
                relaxedFlagReads: { ...relaxedFlagReads },
                forcedSteps,
                handoffMisses: 0,
                worker: translatorReady() ? 'ready' : translatorLoading() ? 'loading' : 'none',
                translators: translators.length,
                translatorsReady: translators.filter(one=>one.ready).length,
                ...(arena === null ? {} : { arena: openArena(arena).counts() }),
                batchesOut: translators.filter(one=>one.pending !== null).length,
            };
        },
    };
    runtimeApi = api;
    return api;
}
