/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime: what the core's cpu layer composes into its host.
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

import { codeSpans, emptyCode, formRegion, formShared, hashRegion } from '../region.js';
import { CallStack, TIER_SLOT, enterRegion } from '../emit/region.js';
import { RANGE, SHAPE, trackRegion } from '../emit/x87.js';
import { HELD, PRECISION } from '../emit/memory.js';
import { arenaEmitCache, createEmitCache, emitBatch, relinkBatch } from './emit-built.js';
import { createArena } from './arena.js';
import { openTranslationWorker } from './translator.js';
import { ANY_TOP, keyOf } from './entries.js';
import { PageFlag } from './pages.js';
import { Tables } from './layout.js';
import { resetBlockCounts } from './block-profile.js';
import { sharedFormsOf } from './shared-forms.js';
import { baseState, join } from './state.js';
import { cacheKey, moduleKey, packRegion, seedRecords, unpackRegion } from './cache.js';
import { createDiagnostics } from './diagnostics.js';
import { createVariants, usesX87 } from './variants.js';
import { createQueue } from './queue.js';
import { createRegions } from './regions.js';
import { createCodeWrites } from './code-writes.js';
import { createModules } from './modules.js';

/** @typedef {import('../../../core/src/layers/cpu/engine.js').Runtime} Runtime */
/** @typedef {import('../../../core/src/layers/cpu/engine.js').ExitKind} ExitKind */
/** @typedef {import('../emit/region.js').X87Precision} X87Precision */
/** @typedef {import('./state.js').RegionRecord} RegionRecord */
/** @typedef {import('./state.js').Placed} Placed */
/** @typedef {import('./state.js').Held} Held */

/**
 * The least share of the store's map of blocks to regions (`storedBlocks`) a
 * runtime adds before it puts the map again: one part in this many.
 */
const MAP_SHARE = 64;

/** Exit codes by number, as the region functions answer them. */
const KINDS = /** @type {ExitKind[]} */ (
    ['untranslated', 'budget', 'trap', 'halt', 'fault', 'stale', 'interpreted',
        // `RETURNED` goes to a region's own wasm call, never to the host; were it
        // to arrive, the state block is whole and the run goes on at its EIP.
        'untranslated']);

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
 * @param {Parameters<typeof baseState>[0]} env
 * @returns {Runtime & { pages: import('./pages.js').PageTable }}
 */
export function createCorkRuntime(env){
    const rt = /** @type {import('./state.js').State} */ (baseState(env));
    const { layout, ramOf, codeBase, read, readBytes, settings, cacheVersion, clock, formOptions,
        formHere, leaveOut, found, emitLayout, sharedMemory, codeShared, pages, codePages, table,
        resumable, entries, view, counterWord, profiling, transfersCounted } = rt;
    const { logOf, CALL_SITES_CAP, counts, noteStall, exits, untranslatedBy, refused, refusedWhy,
        relaxedFlagReads, storeTrace, trace, interpretedAt, forcedStep, counters, diagnostics
    } = join(rt, createDiagnostics(rt));
    const { precisionAt, precisionOf, roundedKeys, precisionFlags, precisionJob, stackPages,
        throughStack, stackCodeSeen, readsFaulted, precisionMissed, floatMissed, shapeMissed,
        checkedAt } = join(rt, createVariants(rt));
    const { freeTable, placedOf, placedLive, recordAt, heldModules, compiledBytes, sharesStore,
        joinModule, leaveModule, evictedKeys, EVICT_HOLD, joinHeld, instantiate, batchInstances,
        keepBatch, share, sharedModule } = join(rt, createModules(rt));
    /** What the tier has retired in place of misses, all told, once it is installed: not
     * the translator's own share. @type {(() => number) | null} */
    let tierEntered = null;
    const { queue, buckets, HOT_BUCKET, heatOf, bucketOf, unqueue, enqueue, watched, WATCH_REGIONS,
        dropKey, barrenHas, barrenAdd, misses, exitTargets, bornAt, noteWay, EXIT_TARGETS_CAP,
        variantHeat, MISSES_CAP, decayMisses, inFlight, overdue } = join(rt, createQueue(rt));
    let missesInserted = 0;
    const { regions, crtFormed, recordOf, heldStarts, heldOnEntry, closedIn, closedPages,
        forgetClosed, copiesWanted, byPage, GRANULES, countExtents, unpublish
    } = join(rt, createRegions(rt));
    /** By the address of an indirect call in translated code, its targets sampled and how
     * often, and its samples in all. @type {Map<number, { total: number,
     *     targets: Map<number, number> }>} */
    const callSamples = new Map();
    /** The calls sampled `PREDICT_AFTER` times, whose callees are looked at next: what was
     * a pass over every call sampled at each `translatePending`. @type {Set<number>} */
    const callsDue = new Set();
    const { dropped, liftVolatile, stamp, invalidatePage, sourcesChanged, storedInto, translatable,
        stubPage, formableFrom, stored, codeWritten, takeWrites, markWritten, takeCodeWrites,
        noteStack } = join(rt, createCodeWrites(rt));
    /** When `translateNow` last looked, for `behindMs`. */
    let lookedAt = 0;
    // The milliseconds emitted on this thread, read on every build: what a
    // host's pool takes as a want for a worker (`translatedHere`). The
    // translator's phase timings are a diagnostic and read 0 in a shipped
    // build, and a pool going by them never lent a process its worker again
    // once it had given it back.
    let emittedHereMs = 0;
    /** @type {Record<number, keyof typeof untranslatedBy>} */
    const VECTOR_NAMES = { 0: 'bare', [HELD]: 'held', [PRECISION]: 'precision', [SHAPE]: 'shape',
        [RANGE]: 'range' };
    /** @type {import('../../../core/src/layers/cpu/engine.js').ExitRecord} */
    const exit = { retired: 0, kind: 'untranslated', vector: 0 };
    let corkRetired = 0;

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
     *     covers: what its regions cover until they are published (`coveredOut`)
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
     * The entries regions formed and not yet published will have, by `keyOf`
     * (`coverKeys`), and how many such regions hold each: a candidate among
     * them is not formed again beside them, as one a batch's own region
     * covers is not. A region covers its blocks from when it goes to a
     * translator, or its record comes back from the store, until it is
     * published -- with several batches out, every block of a loop met while
     * its region was with one translator otherwise became a region of its own
     * with the next, and a block met while the translator's module compiled
     * still did: in Far Cry's load, 8 768 of 22 000 regions began at a block
     * of a region formed and not yet published.
     * @type {Map<number, number>}
     */
    const coveredOut = new Map();
    /**
     * Where a formed region's blocks will be entries once it is published: at
     * any top, or at its entry's where it has x87 in it -- a block whose stack
     * has another shape there is cut, and a candidate at its own top is formed
     * once the region is published.
     * @param {{ region: import('../region.js').Region, entryTop: number }} one
     */
    const coverKeys = one=>{
        const top = usesX87(one.region) ? one.entryTop : ANY_TOP;
        return one.region.blocks.map(block=>keyOf(block.start, top));
    };
    /** @param {number[]} keys @returns {number[]} the keys */
    const cover = keys=>{
        for (const key of keys)
        {
            coveredOut.set(key, (coveredOut.get(key) ?? 0) + 1);
        }
        return keys;
    };
    /** @param {number[] | undefined} keys */
    const uncoverKeys = keys=>{
        for (const key of keys ?? [])
        {
            const held = (coveredOut.get(key) ?? 1) - 1;
            if (held === 0)
            {
                coveredOut.delete(key);
            }
            else
            {
                coveredOut.set(key, held);
            }
        }
    };
    /** @param {Pending} pending */
    const uncover = pending=>{
        uncoverKeys(pending.covers);
        pending.covers = [];
    };
    /** Whether a region formed and not published will have an entry at an address and top.
     * @param {Set<number> | Map<number, number>} keys @param {number} eip @param {number} top */
    const coveredIn = (keys, eip, top)=>keys.has(keyOf(eip, ANY_TOP)) || keys.has(keyOf(eip, top));
    // A batch's store lookups are in flight: its bytes come back between
    // frames, and until then no new batch is formed, so the batches publish in
    // order and the waiting is never the slice's.
    let storePending = false;
    /**
     * A region a batch publishes later (`publishOn`): it, its translation, and
     * the instance of its module -- or, for a store hit whose module this run
     * has not instantiated, null, with the bytes to compile and what they are
     * known by (`instanceFor`). With `relink`, `one` is a running region a
     * relink moves to the instance, and where the store keeps the module.
     * @typedef {{ one: any, built: any, instance: WebAssembly.Instance | null,
     *     source?: string | object, bytes?: Uint8Array | WebAssembly.Module,
     *     relink?: { store: any, key: string | undefined } }} Waiting
     */
    /**
     * The batches waiting to be published, in order: a translator's answer,
     * or a batch's store hits and whether their modules are compiled. Until
     * they are all published no new batch goes, as while a batch's lookups are
     * out, and they are published before a batch half formed goes on. A
     * batch's store hits wait for their modules: `compile` holds those not
     * started yet (`compileOn`), `started` the compiles under way, `compiled`
     * those done, and `instances` those instantiated as their first region is
     * published.
     * @typedef {{ waiting: Waiting[], next: number, ready: boolean,
     *     compile: { source: string | object, bytes: Uint8Array }[],
     *     started: Promise<void>[],
     *     compiled: Map<string | object, WebAssembly.Module | null>,
     *     instances: Map<string | object, WebAssembly.Instance | null>,
     *     covers: number[] }} Publishing
     * @type {Publishing[]}
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
     * holds where the regions it formed will have entries once published
     * (`coverKeys`): a candidate among them is already translated by one (a
     * loop's head and its cases were all hot at once, and each formed the
     * whole loop again). It is noted again should its block get no entry
     * after all. `forTranslator`: a translator was free when it was taken,
     * or one was loading where the work here is bounded, so it goes to one --
     * emitted here only should none be left at all.
     * `lookup`: the store's answers so far (`lookUpOn`), null once the store
     * cannot answer at once. `known`: what the store answered for the batch's
     * keys before they were formed (`recordBefore`), and `unpacked` those
     * records read.
     * @typedef {{ records: (Uint8Array | null | undefined)[] | null,
     *     cached: (import('./cache.js').CachedRegion | null)[], wanted: string[] | null,
     *     modules: Map<string, Uint8Array | WebAssembly.Module | null>, done: boolean,
     *     keys?: string[] }} Lookup
     * @typedef {{ batch: [number, number][], next: number, formed: any[],
     *     covered: Set<number>, ceiling: number, takenAt: number,
     *     forTranslator: boolean, lookup?: Lookup | null,
     *     known?: Map<string, Uint8Array | null>,
     *     unpacked?: Map<string, import('./cache.js').CachedRegion | null> }} Forming
     * @type {Forming | null}
     */
    let forming = null;
    /**
     * Whether the translator's work here is bounded (`holdMs`): only where a
     * worker is wanted, which is where frames pace the run -- a run with none
     * emits here, and has no frames to keep.
     */
    const holding = ()=>settings.holdMs > 0 && workerUrl !== null;
    /** The share of the engine thread's time over a while the translator's work may take. */
    const HOLD_SHARE = settings.holdShare;
    /** The engine thread's time forming may take now (`holdMs`), refilled at
     * `HOLD_SHARE` of the time that passes, and when it was last brought up to date. */
    let credit = settings.holdMs;
    let creditAt = performance.now();
    const creditNow = ()=>{
        const now = performance.now();
        credit = Math.min(settings.holdMs, credit + (now - creditAt) * HOLD_SHARE);
        creditAt = now;
        return credit;
    };
    const sendNext = ()=>{
        if (toPublish.length > 0
            ? toPublish[0].ready || toPublish.some(batch=>batch.compile.length > 0)
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
        }, Math.max(1, (settings.holdMs / 2 - creditNow()) / HOLD_SHARE));
    };
    /** The process's translation cache arena, shared with every translator it has; none
     * without a translator or where memory cannot be shared. Its size is `createArena`'s:
     * an arena of 8 MiB rather than 48 bought no memory back (roadmap/negative-results.md). */
    const arena = settings.arena ?? (workerUrl !== null && typeof SharedArrayBuffer === 'function'
        ? createArena() : null);
    /** What emitting inline keeps for a relink to take again: the arena the translators
     * share, or a cache of this thread's own. */
    const emitCache = arena !== null ? arenaEmitCache(arena) : createEmitCache();
    let profileResetAt = import.meta.BOTTLIFY_DIAGNOSTICS !== false && profiling
        && settings.blockProfileFrom > 0
        ? performance.now() + settings.blockProfileFrom * 1000 : null;
    // The store is opened (a directory store reads its index) while the host
    // is still starting, so it can answer the first batch's lookups at once.
    if (leaveOut.size === 0 && !profiling)
    {
        settings.store?.prepare?.()?.catch(()=>{});
    }
    /** The options both the inline emitter and the worker's take. */
    const emitOptions = ()=>({
        countTransfers: transfersCounted,
        blockProfile: profiling,
        hash: table !== null,
        place: table !== null && settings.dispatch === true,
        profileCalls: table !== null && settings.callTargets === true,
        callReturn: table !== null && settings.callReturn === true,
        linkedCalls: settings.linkedCalls !== false,
        crossTailCalls: settings.crossTailCalls !== false,
        ...(settings.callDepth === CallStack.LIMIT ? {} : { callDepth: settings.callDepth }),
        resume: resumable,
        structure: settings.structure,
        precise: settings.precise === true,
        checkReads: rt.readsChecked,
        zeroPage: settings.zeroPage === true,
        atomic: settings.atomic === true,
        ordered: settings.atomic === true && settings.ordered === true,
        looseStacks: rt.loose,
        leaveOut,
        timings: import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.timings === true,
        ...(settings.trapPort === undefined ? {} : { trapPort: settings.trapPort }),
        ...(sharedMemory ? { memory: sharedMemory } : {}),
    });

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
    /** Batch modules instantiated since the last relink began. */
    let modulesSinceRelink = 0;
    /** The chunks of running regions a relink still has to gather, or null between
     * relinks. @type {RegionRecord[][] | null} */
    let relinkQueue = null;

    /**
     * Stamps a built or stored region and publishes every block start as an
     * entry: its function out of the instance of the module that holds it.
     * The whole of the publish half of the old batch loop, so a worker's
     * answer and an inline emission take the same path.
     *
     * @param {{ region: import('../region.js').Region, entryTop: number, stamp: string,
     *     wide?: boolean, narrow?: boolean, floats?: boolean, checked?: boolean, copies?: boolean,
     *     loose?: boolean, wrapped?: boolean, anyTop?: boolean, byHash?: boolean,
     *     replaces?: RegionRecord, targets?: [number, number[]][], copying?: boolean,
     *     sites?: number[], waited?: boolean }} one
     *     replaces: the region it is formed again from, with the callees of its indirect calls
     *     (`targets`), or with copies of the blocks inside its loops (`copying`); sites: the
     *     indirect calls it was formed again for, each spending one of its own reforms;
     *     waited: the guest ran between its forming and now
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
            || (one.loose && !rt.loose)
            || (one.wrapped && rt.readsChecked)
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
        const code = codeSpans(region);
        for (const [start, end] of code)
        {
            if (end <= start)
            {
                continue;
            }
            // As `markCode` takes the span: the granules of its first and last
            // byte on each page it touches.
            const first = start >>> 12;
            const last = (end - 1) >>> 12;
            for (let page = first; page <= last; page++)
            {
                const from = page === first
                    ? (start & 0xfff) >>> Tables.CODE_GRANULE_SHIFT : 0;
                const to = page === last
                    ? (((end - 1) & 0xfff) >>> Tables.CODE_GRANULE_SHIFT) + 1 : GRANULES;
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
            anyTop: one.anyTop ?? !usesX87(region),
            ...((one.byHash ?? one.replaces?.byHash) === true ? { byHash: true } : {}),
            ...(one.targets === undefined ? {} : { targets: one.targets }),
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
            record.reforms = new Map(one.replaces.reforms ?? []);
            for (const site of one.copying === true ? [] : one.sites ?? [])
            {
                record.reforms.set(site, (record.reforms.get(site) ?? 0) + 1);
            }
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
                index = rt.nextTable++;
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
            // A block that left held when entered at its start (`heldOnEntry`) is
            // no entry of a region that formed it in, published again or relinked.
            if (start !== region.entry && heldStarts.has(start * 16 + top))
            {
                entries.noteStart(start);
                continue;
            }
            // An address another region's entry already holds stays that
            // region's: the record keeps only the entries it made, or a relink
            // of it would put its function under the other's label (and a drop
            // of it would take the other's entry away) -- unless there it is
            // a copy of a block inside a loop (a label past twice its blocks,
            // `emitCopies`) and here it is not: a run entered there goes on in
            // this region's loops rather than in a flat dispatch.
            const empty = settings.emptyCalls !== false
                ? emptyCode(at=>blockAt.get(at), start) : 0;
            noteWay(start, 'published');
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
            // The same function there already -- this region published again
            // from an instance a running record of it holds -- stays that
            // record's: an entry two records list is taken away by the first
            // dropped (`evict`) and named still by the other.
            const owner = recordOf.get(slot);
            if (entries.at(slot).fn === fn && (owner === undefined || !regions.has(owner)))
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
                codePages.set(page, PageFlag.CLOSED);
            }
            holders.add(record);
        }
        for (const [start, end] of code)
        {
            codePages.markCode(start, end - start);
        }
        if (rt.loose && (stackPages.size > 0 || codeShared !== null)
            && [...region.pages].some(page=>stackPages.has(page)
                || codeShared?.onStack(page) === true))
        {
            stackCodeSeen();
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
        for (const block of region.blocks)
        {
            for (const instruction of block.instructions)
            {
                if (instruction.crt !== undefined)
                {
                    crtFormed[instruction.crt] = (crtFormed[instruction.crt] ?? 0) + 1;
                }
            }
        }
        if (record.loose && !rt.loose && throughStack(region))
        {
            // Its own code lies on a stack (`stackCodeSeen` above, which ran before
            // it was among the regions): its stores through esp, untested, could
            // write it. Asked for again, it is formed tested.
            unpublish([record]);
            counts.dropped++;
            counts.publishMs += clock() - publishAt;
            return 0;
        }
        // With other executors, the bytes are read again now that the pages say
        // there is code on them: a store another executor made before its check
        // could see that is caught here, one after it by the check. Its own
        // slices do not tell this one (`waited`), and the store moved no
        // generation while the pages held no code.
        if (codeShared !== null && (region.sources !== undefined
            ? sourcesChanged(region.sources, 0, 0x100000000)
            : hashRegion(read, region) !== region.hash))
        {
            unpublish([record]);
            counts.dropped++;
            counts.publishMs += clock() - publishAt;
            return 0;
        }
        joinHeld(record, instance);
        const bounced = evictedKeys.get(keyOf(region.entry, one.entryTop));
        if (bounced !== undefined && record.held !== undefined)
        {
            // Let go and asked for again: something still runs it, which the
            // marks may not show (a tail call into it from another module), so
            // its module stays a while, longer each time, and a relink takes
            // it with the hot.
            counts.broughtBack++;
            record.heat = (record.heat ?? 0) + 1;
            record.held.keepUntil = Math.max(record.held.keepUntil,
                corkRetired + EVICT_HOLD * 2 ** Math.min(bounced - 1, 6));
        }
        counts.publishMs += clock() - publishAt;
        return 1;
    };
    // The settings that change emitted code but not a region's bytes, in the
    // store's keys: structure, precise, the transfer count, the modules' placing
    // and the call profile, the trap port -- each as the emitter reads it, where
    // structure left unset is on. The entry hash and the tier's resume follow
    // from the features and the layout, which the key names beside these. 'W'
    // marks reads wrapped into a RAM that is not a power of two, which a store
    // made before they were (each read tested) holds under the same layout.
    const variant = (settings.structure !== false ? 'S' : '')
        + ((emitLayout.ramSize & emitLayout.ramSize - 1) !== 0 ? 'W' : '')
        + (settings.precise === true ? 'P' : '') + (settings.countTransfers ? 'T' : '')
        + (settings.dispatch === true ? 'D' : '') + (settings.callTargets === true ? 'C' : '')
        + (settings.callReturn === true ? 'R' : '') + (sharedMemory ? 'M' : '')
        + (settings.linkedCalls !== false ? 'L' : '')
        + (settings.crossTailCalls === false ? 'X' : '')
        + (settings.callReturn === true && settings.callDepth !== CallStack.LIMIT
            ? `d${settings.callDepth}` : '')
        + (settings.atomic === true ? 'A' : '')
        + (settings.atomic === true && settings.ordered === true ? 'O' : '')
        + `p${(settings.trapPort ?? 0).toString(16)}`;
    /**
     * The store key of one formed region: its entry, its top, and the run's modes its
     * code is made for -- what a run knows before it forms the region. The region stored
     * there stands for it, and one a lookup found of other bytes than that record's goes
     * beside it (`storeKey`); what forming made of it is in its record (`shapeOf`).
     * A region with no x87 in it is the same code at every top, and is kept at any
     * (`anyTop`, found once for the formed region): of a warm Far Cry run's 2 072 misses,
     * 362 were entries the store had at another top.
     * @param {{ region: { entry: number, blocks?: import('../region.js').Block[] },
     *     entryTop: number, loose?: boolean, wrapped?: boolean, anyTop?: boolean }} one */
    const regionKey = one=>{
        const { blocks } = one.region;
        one.anyTop ??= blocks !== undefined
            && !usesX87(/** @type {import('../region.js').Region} */ (one.region));
        return cacheKey({
            version: cacheVersion, features: found, variant, layoutId: emitLayout.id,
            bundleId: settings.bundleId ?? 'unknown', entry: one.region.entry,
            kept: `${one.anyTop ? 'x' : one.entryTop}${one.loose ? '-s' : ''}`
                + `${one.wrapped === false ? '-q' : ''}`,
        });
    };
    /**
     * Where a region's record is put: under its key, or beside the record there under its
     * own bytes' hash too, where that record is of other bytes (`byHash`, which a region
     * formed again inherits from the one it replaces). An entry whose code reaches a stub
     * the program patches as it runs - a .NET runtime's call to its prestub, made a jump
     * to the method once that is prepared - is formed in two versions every run, and one
     * record under its key had the later version overwrite the earlier: the next run met
     * the earlier first and missed, and so on every start (The Swapper: 8 400 regions,
     * 4 128 of them in mscorlib's native image). Kept apart, each version is a hit.
     * @param {Parameters<typeof regionKey>[0] & { region: { hash: string },
     *     byHash?: boolean, replaces?: { byHash?: boolean } }} one */
    const storeKey = one=>regionKey(one)
        + ((one.byHash ?? one.replaces?.byHash) === true ? `/${one.region.hash}` : '');
    /**
     * The key to ask for a formed region's own version (`storeKey`) where the record under
     * its key is of other bytes, or null.
     * @param {{ region: { hash: string } }} one @param {string} key  its `regionKey`
     * @param {import('./cache.js').CachedRegion | null | undefined} cached  the record there
     */
    const besideKey = (one, key, cached)=>(cached?.shape !== undefined
        && cached.shape.hash !== one.region.hash ? `${key}/${one.region.hash}` : null);
    /**
     * What forming made of a region and what it is compiled as, for its record.
     * @param {{ region: { entry: number, hash: string },
     *     targets?: [number, number[]][],
     *     wide?: boolean, narrow?: boolean, floats?: boolean, checked?: boolean,
     *     copies?: boolean }} one
     * @returns {import('./cache.js').RegionShape}
     */
    const shapeOf = one=>({ hash: one.region.hash,
        ...((precisionAt.get(one.region.entry)?.misses ?? 0) > 0 ? { moved: true } : {}),
        ...(one.targets === undefined ? {} : { targets: one.targets }),
        ...(one.wide === true ? { wide: true } : {}),
        ...(one.narrow === true ? { narrow: true } : {}),
        ...(one.floats === true ? { floats: true } : {}),
        ...(one.checked === true ? { checked: true } : {}),
        ...(one.copies === true ? { copies: true } : {}) });
    /**
     * The formed regions of the runtimes sharing the store and forming as this
     * one does (`sharedFormed`), by entry and the callees formed in. None for a
     * run that keeps no store, where no other runtime of this thread would take
     * them (and a region formed to be kept is formed without what the rest of
     * its call decoded), and for a diagnostic range left to the interpreter,
     * which `translatable` answers by address rather than by page.
     */
    const sharedForms = settings.interpretRange || leaveOut.size > 0 || profiling ? null
        : sharedFormsOf(sharesStore, JSON.stringify(formOptions), settings.sharedFormed);
    /**
     * Whether a region formed earlier would be formed the same here now: every
     * page forming asked about answers as it did, and every byte it read is as
     * it was.
     *
     * @param {import('./shared-forms.js').Formed} formed
     */
    const formsAsBefore = ({ region, answers })=>{
        const formable = formableFrom(region.entry);
        for (const [page, yes] of answers)
        {
            if (formable(page * 4096) !== yes)
            {
                return false;
            }
        }
        for (const { start, bytes } of region.sources ?? [])
        {
            const now = readBytes?.(start, start + bytes.length);
            for (let at = 0; at < bytes.length; at++)
            {
                if ((now === undefined ? read(start + at) : now[at]) !== bytes[at])
                {
                    return false;
                }
            }
        }
        return true;
    };
    /**
     * A region formed at `eip` with these callees formed in (`callTargets`), or
     * the one a runtime sharing the store formed so where it forms the same
     * (`formsAsBefore`). One formed to be kept is formed alone, without what
     * other regions of the call decoded (`shared`): forming reads and asks
     * about only what it did not find there, and the region's own reads must
     * be all of them.
     *
     * @param {number} eip @param {[number, number[]][] | undefined} targets
     * @param {import('../region.js').FormShared} [shared]
     * @returns {import('../region.js').Region}
     */
    const formAt = (eip, targets, shared)=>{
        const called = targets === undefined ? {} : { callTargets: new Map(targets) };
        const formable = formableFrom(eip);
        // What forming finds shared between the regions of a call is found under their
        // own pages: a region entered on a page of stubs may form on less than the others.
        const sharing = stubPage(eip >>> 12) ? undefined : shared;
        if (sharedForms === null)
        {
            return formRegion(read, eip, { ...formHere, translatable: formable, shared: sharing,
                ...called });
        }
        const key = `${eip}/${targets === undefined ? '' : JSON.stringify(targets)}`;
        const known = sharedForms.get(key);
        if (known !== undefined && formsAsBefore(known))
        {
            counts.formedShared++;
            return known.region;
        }
        /** @type {Map<number, boolean>} */
        const answers = new Map();
        const region = formRegion(read, eip, { ...formHere, ...called,
            translatable: address=>{
                const page = Math.floor(address / 4096);
                let yes = answers.get(page);
                if (yes === undefined)
                {
                    yes = formable(address);
                    answers.set(page, yes);
                }
                return yes;
            } });
        sharedForms.set(key, { region, answers });
        return region;
    };

    /**
     * The stored region for a formed one, or null. Formed here beside other
     * regions than the run that stored it had, or before the callees it was
     * formed with were known, a region is formed again as its record says
     * first; it is taken when its bytes hash as they did, compiled for the
     * precision this run gives its entry, with floats only where this run
     * keeps them and with the shape tests unless this run checks its stack.
     * An entry whose precision control this run has not moved yet takes the
     * one the record was compiled for where the run that stored it moved it
     * (`moved`, `precisionAt`): it learned what the entry runs under. A record
     * compiled for the control its run first met there is no such lesson, and
     * is taken only for that control -- a region compiled for another leaves
     * at its first rounding instruction. Taken, the formed region is the one
     * the record was made of. A record of other bytes is passed over for the one kept
     * beside it under the formed region's hash (`beside`, `storeKey`).
     *
     * @param {any} one @param {import('./cache.js').CachedRegion | null} cached
     * @param {import('./cache.js').CachedRegion | null} [beside]  the record at `besideKey`
     * @returns {import('./cache.js').CachedRegion | null}
     */
    const accepted = (one, cached, beside = null)=>{
        let shape = cached?.shape;
        if (cached === null || shape === undefined)
        {
            return null;
        }
        let region = one.region;
        if (region.hash !== shape.hash && beside !== null && beside.shape !== undefined
            && beside.shape.hash === region.hash)
        {
            cached = beside;
            shape = beside.shape;
            one.byHash = true;
        }
        if (region.hash !== shape.hash && one.formedAs !== undefined
            && one.formedAs === regionKey(one))
        {
            // Formed as this record says already (`recordBefore`): other bytes.
            counts.missChanged++;
            counts.missBytes++;
            one.storedOther = true;
            one.byHash = true;
            return null;
        }
        if (region.hash !== shape.hash)
        {
            region = formAt(region.entry, shape.targets);
            if (region.hash !== shape.hash)
            {
                counts.missChanged++;
                counts.missFormedOther++;
                one.storedOther = true;
                one.byHash = true;
                return null;
            }
            counts.hitsFormedAgain++;
        }
        precisionOf(region);
        const known = precisionAt.get(region.entry);
        if (known !== undefined && known.misses === 0 && shape.moved === true)
        {
            known.precision = shape.wide === true ? 'wide' : shape.narrow === true ? 'narrow'
                : 'mixed';
        }
        const flags = precisionFlags(region, one.entryTop);
        const otherPrecision = flags.wide !== (shape.wide === true)
            || flags.narrow !== (shape.narrow === true);
        const otherFloats = shape.floats === true && !flags.floats;
        if (otherPrecision || otherFloats
            || (shape.checked !== true && checkedAt(region, one.entryTop)))
        {
            counts.missChanged++;
            counts.missModes++;
            counts.missPrecision += otherPrecision ? 1 : 0;
            counts.missFloats += !otherPrecision && otherFloats ? 1 : 0;
            one.storedOther = true;
            return null;
        }
        if (region !== one.region)
        {
            one.region = region;
            one.stamp = stamp(region.pages);
        }
        one.wide = shape.wide === true;
        one.narrow = shape.narrow === true;
        one.floats = shape.floats === true;
        one.checked = shape.checked === true;
        one.copies = shape.copies === true;
        if (shape.targets !== undefined)
        {
            one.targets = shape.targets;
        }
        if (one.formedAs !== undefined && region === one.formedRegion)
        {
            counts.formedAsRecorded++;
        }
        return cached;
    };
    /**
     * Where the stored regions have entries: by `keyOf` of a block and the top its
     * entry is keyed at (`ANY_TOP` for a region with no x87 in it), the region's own
     * entry and top as `keyOf` packs them. A run that meets a block of a stored region
     * before the region's entry -- a call's return, a loop entered from outside --
     * forms the region it belongs to, which the store answers, rather than another
     * there: of a warm Far Cry run's 2 072 misses, 803 were such blocks. Read from the
     * store as the runtime starts, written back with this run's regions when it
     * flushes. null until read.
     * @type {Map<number, number> | null}
     */
    let storedBlocks = null;
    const blocksKey = ()=>cacheKey({ version: cacheVersion, features: found, variant,
        layoutId: emitLayout.id, bundleId: settings.bundleId ?? 'unknown', entry: 0,
        kept: 'blocks' });
    /**
     * The store this runtime keeps its translations in: none for a diagnostic run
     * with classes left out or a block profile.
     * @returns {any}
     */
    const storeHere = ()=>(leaveOut.size > 0 || profiling
        ? null : (settings.store ?? null));
    /** `storedBlocks` as a record holds it: a block, an entry and their tops each.
     * @param {Map<number, number>} blocks */
    const packBlocks = blocks=>{
        const bytes = new Uint8Array(blocks.size * 12);
        const data = new DataView(bytes.buffer);
        let at = 0;
        for (const [block, owner] of blocks)
        {
            data.setUint32(at, Math.floor(block / 16), true);
            data.setUint32(at + 4, Math.floor(owner / 16), true);
            data.setUint32(at + 8, (block % 16) << 4 | owner % 16, true);
            at += 12;
        }
        return bytes;
    };
    /** @param {Uint8Array} bytes @returns {Map<number, number>} */
    const unpackBlocks = bytes=>{
        const blocks = new Map();
        const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let at = 0; at + 12 <= bytes.length && bytes.length % 12 === 0; at += 12)
        {
            const tops = data.getUint32(at + 8, true);
            blocks.set(keyOf(data.getUint32(at, true), tops >>> 4),
                keyOf(data.getUint32(at + 4, true), tops & 15));
        }
        return blocks;
    };
    /** The read of `storedBlocks`, which a flush waits for before it writes them back. */
    const blocksRead = (async()=>{
        const store = storeHere();
        try
        {
            const bytes = store === null || typeof store.get !== 'function' ? null
                : await store.get(blocksKey());
            storedBlocks = bytes === null ? new Map() : unpackBlocks(bytes);
        }
        catch {
            storedBlocks = new Map();
        }
    })();
    /**
     * The region a candidate is a block of in the store, where that region is
     * neither published nor on its way: its entry and top as `keyOf` packs them, or
     * -1.
     * @param {number} eip @param {number} top
     */
    const storedOwner = (eip, top)=>{
        const owner = storedBlocks?.get(keyOf(eip, top)) ?? storedBlocks?.get(keyOf(eip, ANY_TOP));
        if (owner === undefined || Math.floor(owner / 16) === eip)
        {
            return -1;
        }
        const at = Math.floor(owner / 16);
        return entries.entryOf(at, owner % 16) >= 0 || inFlight.has(owner) || !translatable(at)
            ? -1 : owner;
    };

    /** What asks a translator to digest and pack the module it answers with, where it is to be
     * stored. @param {any} store */
    const storeVersionFor = store=>(store === null ? {} : { storeVersion: cacheVersion });

    /**
     * Puts a batch's module in the store, as the translation worker digested
     * and packed it where it did, and answers the key it is kept under.
     *
     * @param {any} store @param {import('./emit-built.js').BuiltBatch} batch
     * @returns {string}
     */
    const storeModule = (store, batch)=>{
        const key = moduleKey({ version: cacheVersion, features: found, variant,
            layoutId: emitLayout.id, bundleId: settings.bundleId ?? 'unknown' }, batch.module,
        batch.digest);
        store.put(key, batch.packed ?? packRegion({ module: batch.module, labels: [], cut: [],
            entryTop: 0, instructions: 0 }, cacheVersion)).catch(()=>{});
        return key;
    };

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
     * @param {number[]} [covers]  what the regions cover until they are published
     *     (`coveredOut`)
     * @returns {number} regions published
     */
    const publishBatch = (metas, batch, compiled, store, later = false, covers = [])=>{
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
            uncoverKeys(covers);
            return 0;
        }
        counts.moduleBytes += batch.module.length;
        /** @type {string | undefined} */
        let key;
        if (store !== null)
        {
            const storeAt = clock();
            key = storeModule(store, batch);
            counts.storeMs += clock() - storeAt;
        }
        const instance = instantiate(compiled ?? batch.module, batch.module.length, key);
        modulesSinceRelink++;
        if (key !== undefined && instance !== null)
        {
            keepBatch(key, instance);
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
                store.put(storeKey(metas[i]), packRegion({ ...result.region,
                    module: new Uint8Array(0), moduleKey: key, shape: shapeOf(metas[i]) },
                cacheVersion),
                key === undefined ? undefined : { needs: key }).catch(()=>{});
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
            publishLater(waiting, covers);
        }
        else
        {
            uncoverKeys(covers);
        }
        return published;
    };

    /**
     * A relinked chunk: its module instantiated once, and every region of it
     * still running switched to its function there -- the same labels, so the
     * entries and the table slot stand and only the function under them moves.
     * The old batch modules go when no region uses them any more -- in the
     * store as well: each region's record names the relinked module from then
     * on, and a batch module no record names is dead there. A later run takes
     * the relinked regions as they are and relinks only what it adds.
     *
     * @param {RegionRecord[]} records  the chunk, in the order its jobs went
     * @param {import('./emit-built.js').BuiltBatch} batch
     * @param {WebAssembly.Module | null} compiled
     * @param {any} store
     * @param {boolean} [later]  the regions moved a credit's worth a call
     *     (`publishOn`) rather than in this one
     */
    const applyRelink = (records, batch, compiled, store, later = false)=>{
        if (!batch.results.some(result=>result.ok))
        {
            return;
        }
        counts.moduleBytes += batch.module.length;
        /** @type {string | undefined} */
        const key = store === null ? undefined : storeModule(store, batch);
        const instance = instantiate(compiled ?? batch.module, batch.module.length, key);
        if (instance === null)
        {
            return;
        }
        if (key !== undefined)
        {
            keepBatch(key, instance);
        }
        // A region left on its old module until it is moved runs the same
        // code there: each moves on its own.
        /** @type {Waiting[] | null} */
        const waiting = later ? [] : null;
        for (let i = 0; i < records.length; i++)
        {
            const result = batch.results[i];
            if (!result.ok)
            {
                continue;
            }
            if (waiting !== null)
            {
                waiting.push({ one: records[i], built: result.region, instance,
                    relink: { store, key } });
                continue;
            }
            relinkOne(records[i], result.region, instance, store, key);
        }
        if (waiting !== null && waiting.length > 0)
        {
            publishLater(waiting);
        }
    };

    /**
     * Moves a running region to its function in a relinked module, should it
     * still run the code the relink formed again, and stores it as that.
     *
     * @param {RegionRecord} record @param {any} region  its translation in the module
     * @param {WebAssembly.Instance} instance @param {any} store
     * @param {string | undefined} key  where the store keeps the module
     */
    const relinkOne = (record, region, instance, store, key)=>{
        if (!regions.has(record) || JSON.stringify(region.labels) !== record.labels)
        {
            return;
        }
        const fn = /** @type {(label: number, budget: number) => number} */ (
            instance.exports[region.exportName]);
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
                record.table = placed.base + Number(region.exportName.slice(1));
                table.set(record.table, fn);
                recordAt.set(record.table, record);
                joinModule(record, placed);
            }
        }
        for (const slot of record.slots)
        {
            entries.retable(slot, fn, record.table);
        }
        joinHeld(record, instance);
        record.linked = true;
        counts.relinked++;
        if (store !== null)
        {
            const one = { region: { entry: record.entry, hash: record.hash },
                entryTop: record.entryTop, wide: record.wide, narrow: record.narrow,
                floats: record.floats, checked: record.checked, copies: record.copies,
                loose: record.loose, wrapped: record.wrapped, targets: record.targets,
                anyTop: record.anyTop, byHash: record.byHash };
            store.put(storeKey(one), packRegion({ ...region,
                module: new Uint8Array(0), moduleKey: key, linked: true, shape: shapeOf(one) },
            cacheVersion), key === undefined ? undefined : { needs: key }).catch(()=>{});
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
                    const at = layout.ramBase + codeBase + page * 4096;
                    // A copy of its own: a slice of a shared memory's buffer is
                    // shared too, and cannot be transferred to the translator.
                    // A page forming read past the memory -- an import slot that
                    // names nowhere -- read as zeros there, and is zeros here.
                    copies.set(page, at + 4096 <= ramOf.buffer.byteLength
                        ? new Uint8Array(ramOf.buffer, at, 4096).slice() : new Uint8Array(4096));
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
            // The hottest first, so they share the big modules, and those no
            // entry or crossing reached lately in small ones of their own.
            foldHeat();
            const waiting = [...regions].filter(record=>!record.linked);
            const hot = waiting.filter(record=>(record.heat ?? 0) >= 1)
                .sort((a, b)=>(b.heat ?? 0) - (a.heat ?? 0));
            const cold = waiting.filter(record=>!((record.heat ?? 0) >= 1));
            relinkQueue = [...chunksOf(hot, settings.relinkRegions),
                ...chunksOf(cold, Math.min(settings.relinkCold, settings.relinkRegions))];
            modulesSinceRelink = 0;
            counts.relinks++;
        }
        const chunk = (relinkQueue.shift() ?? []).filter(record=>regions.has(record));
        if (relinkQueue.length === 0)
        {
            relinkQueue = null;
        }
        return relinkChunk(chunk, store);
    };

    /** @param {RegionRecord[]} records @param {number} size @returns {RegionRecord[][]} */
    const chunksOf = (records, size)=>{
        /** @type {RegionRecord[][]} */
        const chunks = [];
        for (let at = 0; at < records.length; at += Math.max(1, size))
        {
            chunks.push(records.slice(at, at + Math.max(1, size)));
        }
        return chunks;
    };

    /**
     * Each running region's heat: what it had, halved, and the host's entries
     * into it and the crossings read into it since (`readModules`). Read only
     * when a relink is weighed: the entries count themselves.
     * One entered once and not since is under one at the next reading: cold.
     */
    const foldHeat = ()=>{
        for (const record of regions)
        {
            let fresh = record.crossed ?? 0;
            for (const slot of record.slots)
            {
                const entry = entries.at(slot);
                fresh += entry.heat;
                entry.heat = 0;
            }
            record.crossed = 0;
            record.heat = (record.heat ?? 0) / 2 + fresh;
        }
    };

    /** Translated instructions between two readings of the modules' crossings. */
    const MERGE_SAMPLE = 1 << 20;
    let sampledAt = 0;
    // At most one merge in this many: its module is instantiated on the
    // engine thread, 23 ms for a whole chunk of `relinkRegions`.
    const MERGE_EVERY = 1 << 23;
    // And past that, this many for each region the last one built: a merge
    // builds both modules whole again, and with the worker no longer the one
    // that paced them, a module of hundreds gathering a few new regions at a
    // time would have the engine thread instantiate it over and over.
    const MERGE_PER_REGION = 1 << 19;
    let mergedAt = -MERGE_EVERY;
    let mergeWait = MERGE_EVERY;
    // The merges a region is built again by at most. A merge builds both
    // modules whole, and a module that merged once is crossed into by the
    // next new one: without a bound, every module of new code calling into a
    // hot one could have it built again, for as long as new code arrives.
    const MERGES_A_REGION = 2;
    /** Readings of the modules' crossings, and the one the merges last weighed. */
    let modulesRead = 0;
    let mergeRead = 0;
    /**
     * Reads each placed module's count of transfers out of it, every so many
     * translated instructions, not every call: a loading phase has hundreds
     * of modules and calls here between slices. A module that crossed out and
     * the one its last crossing went into ran (`Held`), the region it went
     * into was entered, and the merges learn where each module crossed to.
     */
    const readModules = ()=>{
        if (placedLive.size === 0 || corkRetired - sampledAt < MERGE_SAMPLE)
        {
            return;
        }
        sampledAt = corkRetired;
        modulesRead++;
        for (const placed of placedLive)
        {
            const now = placed.crossings.value;
            const crossed = (now - placed.seen) >>> 0;
            placed.seen = now;
            if (crossed === 0)
            {
                continue;
            }
            const from = heldModules.get(placed.instance);
            if (from !== undefined)
            {
                from.ran = corkRetired;
            }
            const target = recordAt.get(placed.crossedTo.value >>> 0);
            if (target === undefined)
            {
                continue;
            }
            target.crossed = (target.crossed ?? 0) + crossed;
            if (target.held !== undefined)
            {
                target.held.ran = corkRetired;
            }
            const into = target.module;
            if (settings.mergeAfter > 0 && into !== undefined && into !== placed)
            {
                placed.toward.set(into, (placed.toward.get(into) ?? 0) + crossed);
            }
        }
    };

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
        // the engine thread would be a slice's toll; weighed once a reading.
        if (settings.mergeAfter <= 0 || !translatorReady())
        {
            return false;
        }
        readModules();
        if (modulesRead === mergeRead)
        {
            return false;
        }
        mergeRead = modulesRead;
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
    const PREDICT_SHARE = 8;
    const PREDICT_CALLEES = 4;
    // Times a region is formed again for one of its indirect calls. Counted by call, not by
    // region: three other sites of a region coming due first had spent a region's whole
    // budget, and a callee a site's first samples missed (a phase of the program) was never
    // taken in - every call of it left the region (vcall: 569 k transfers in place of 74,
    // by the order the workloads ran in).
    const REFORMS = 3;
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
     * Each region `reformStep` is to form again: its calls' callees, by call
     * the ones new to it, and the calls it is to stop sampling -- kept from one
     * step to the next while forming them all in one would hold the thread past
     * `holdMs`.
     * @type {Map<RegionRecord, { targets: Map<number, number[]>,
     *     added: Map<number, number[]>, quiet: Set<number> }>}
     */
    const reformsWanted = new Map();

    /**
     * The indirect calls sampled `PREDICT_AFTER` times whose callees are not
     * yet in the regions holding them: each such region formed again with the
     * callees that took a share of its calls' samples (`callTargets`), all in
     * one batch of up to `batchRegions`, and published over the one it
     * replaces when it comes back -- only when one of them was formed in, a
     * small leaf; the others' regions are left as they are, keeping the
     * callees they could not take (`unformed`) so as not to be formed again for
     * them. A call that has nothing more to form into a region, and none of
     * its callees formed in there, is named in it with no callees and the
     * region formed again without the profile at it (`quiet`): its samples
     * would never be used, and every call paid for them, `spread` 3.5% in
     * Node (roadmap/negative-results.md). Each region holding a call is asked
     * by what it has itself, not by what the call's other regions were given.
     * One batch rather than one a call: each is a module the engine thread
     * instantiates, and a round trip through the worker that new code waits
     * behind.
     *
     * @param {any} store
     * @returns {boolean} whether a batch was taken this call
     */
    const reformStep = store=>{
        const wanted = reformsWanted;
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
            }
            let placed = false;
            let out = false;
            let quieted = false;
            for (const record of spanning)
            {
                const one = wanted.get(record) ?? { targets: new Map(record.targets ?? []),
                    added: new Map(), quiet: new Set() };
                const had = one.targets.get(site) ?? [];
                const unformed = record.unformed?.get(site) ?? [];
                const added = shared.filter(target=>!had.includes(target)
                    && !unformed.includes(target)).slice(0, PREDICT_CALLEES - had.length);
                // A call named with no callees is quiet here already; one with a
                // callee formed in samples only the calls that still leave.
                const quiet = added.length === 0 && one.targets.get(site)?.length !== 0
                    && had.every(target=>unformed.includes(target));
                if (added.length === 0 && !quiet)
                {
                    continue;
                }
                if ((record.reforms?.get(site) ?? 0) >= REFORMS)
                {
                    counts.predictReformsOut++;
                    out = true;
                    continue;
                }
                if (quiet)
                {
                    one.targets.set(site, []);
                    one.quiet.add(site);
                    quieted = true;
                }
                else
                {
                    one.targets.set(site, [...had, ...added]);
                    one.added.set(site, added);
                }
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
                log.last = quieted ? 'quiet' : 'fresh';
            }
        }
        const formed = [];
        // As a batch's forming is (`holdMs`): those not reached are formed at the next step.
        // Formed in one call, a batch of them held the thread for thirty milliseconds.
        const until = holding() ? performance.now() + creditNow() : Infinity;
        let tried = 0;
        for (const [record, { targets, added, quiet }] of wanted)
        {
            if (tried > 0 && performance.now() >= until)
            {
                break;
            }
            tried++;
            wanted.delete(record);
            if (!regions.has(record))
            {
                continue;
            }
            const region = formRegion(read, record.entry,
                { ...formHere, translatable: formableFrom(record.entry), callTargets: targets });
            const starts = new Set(region.blocks.map(block=>block.start));
            // Formed without the profile at a quiet call, the region is worth
            // publishing whether or not a callee was formed in.
            let taken = quiet.size > 0;
            for (const [site, callees] of added)
            {
                // A callee's far branch the region left as cold (`coldBranch`), taken often:
                // followed, its callee was formed in with it, or is too large for that now and
                // stays a wasm call, the branch no longer in the region - which no longer
                // leaves there either way. A call is in its region however its callees went.
                if (!region.blocks.some(block=>site >= block.start && site < block.end))
                {
                    taken = true;
                    continue;
                }
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
            counts.predictQuiet += quiet.size;
            formed.push({ region, entryTop: record.entryTop, stamp: stamp(region.pages),
                cached: null, ...precisionFlags(region, record.entryTop), loose: rt.loose,
                wrapped: !rt.readsChecked,
                checked: record.checked === true, copies: record.copies === true,
                replaces: record, targets: [...targets], sites: [...added.keys(), ...quiet] });
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
        // As a batch's forming is (`holdMs`): those not reached wait for the next step.
        const until = holding() ? performance.now() + creditNow() : Infinity;
        for (const record of copiesWanted)
        {
            if (formed.length > 0 && performance.now() >= until)
            {
                break;
            }
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
            const region = formRegion(read, record.entry, { ...formHere,
                translatable: formableFrom(record.entry), ...called });
            formed.push({ region, entryTop: record.entryTop, stamp: stamp(region.pages),
                cached: null, ...precisionFlags(region, record.entryTop), loose: rt.loose,
                wrapped: !rt.readsChecked,
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
            translator.adapter.post({ id: pending.id, relink, layout: emitLayout, features: found,
                options: emitOptions(), ...storeVersionFor(store) },
            [...copies.values()].map(bytes=>bytes.buffer));
            return true;
        }
        const relinkedAt = performance.now();
        const batch = relinkBatch(relink, emitLayout, found, emitOptions(), emitCache);
        emittedHereMs += performance.now() - relinkedAt;
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
     *     compiled?: WebAssembly.Module | null, message?: string, busyMs?: number,
     *     compileMs?: number, packMs?: number }} data
     */
    const onWorkerResults = (translator, data)=>{
        const pending = translator.pending;
        if (pending === null || data?.id !== pending.id)
        {
            return;
        }
        translator.pending = null;
        // The regions cover their blocks until they are published.
        const covers = pending.covers ?? [];
        pending.covers = [];
        if (translator.leaving)
        {
            dropTranslator(translator);
        }
        if (!data.batch)
        {
            uncoverKeys(covers);
            refused[`emit: ${data.message ?? 'the worker failed'}`] = 1;
            return;
        }
        counts.workerMs += data.batch.emitMs + data.batch.encodeMs;
        if (settings.timings === true)
        {
            for (const one of pending.metas ?? [])
            {
                for (const block of one.region.blocks)
                {
                    noteWay(block.start, 'answered');
                }
            }
            counts.workerBusyMs += data.busyMs ?? 0;
            counts.workerEmitMs += data.batch.emitMs;
            counts.workerEncodeMs += data.batch.encodeMs;
            counts.workerCompileMs += data.compileMs ?? 0;
            counts.workerPackMs += data.packMs ?? 0;
            counts.inFlightMs += performance.now() - pending.at;
        }
        const publishedAt = clock();
        // A credit's worth a call where the work here is bounded: a translator's
        // batch of a hundred regions held the thread for ten milliseconds
        // published at once, a relink of five hundred for six to fifteen. One
        // emitted here has held it longer emitting, and is published in the
        // call that emitted it.
        if (pending.relink)
        {
            uncoverKeys(covers);
            applyRelink(pending.relink, data.batch, data.compiled ?? null, pending.store,
                holding());
        }
        else
        {
            publishBatch(pending.metas ?? [], data.batch, data.compiled ?? null, pending.store,
                holding(), covers);
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
     * @param {Uint8Array | WebAssembly.Module | null} [moduleBytes]  compiled
     *     already where a runtime sharing the store compiled it
     */
    const settle = (one, cached, moduleBytes)=>{
        one.cached = cached;
        if (cached === null)
        {
            if (one.storedOther !== true)
            {
                counts.missNoRecord++;
            }
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
            // Its batch's instance, held until the region is published. The
            // module is not read for it, and counts as used all the same.
            one.batchInstance = batchInstances.get(cached.moduleKey);
            if (one.batchInstance === undefined)
            {
                counts.missNoModule++;
                one.cached = null;
            }
            else
            {
                settings.store?.touch?.(cached.moduleKey);
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
     * Whether another executor waits for this thread's answer (`awaited`):
     * forming and looking up stop at the next region, as when the credit runs
     * out. Every region formed here is an answer that thread waited out --
     * thousands a second from a render thread, a third of a millisecond each.
     */
    const waitedFor = ()=>{
        if (settings.awaited?.() !== true)
        {
            return false;
        }
        counts.answeredFirst++;
        return true;
    };

    /**
     * A record of the store's as `step` read it, once a key.
     *
     * @param {Forming} step @param {string} key @param {Uint8Array} bytes
     */
    const unpackedOf = (step, key, bytes)=>{
        const unpacked = step.unpacked ??= new Map();
        let cached = unpacked.get(key);
        if (cached === undefined)
        {
            cached = unpackRegion(bytes, cacheVersion);
            unpacked.set(key, cached);
        }
        return cached;
    };
    /** A candidate's store key at the top it is entered at, or at any top.
     * @param {number} eip @param {number} entryTop @param {boolean} anyTop */
    const candidateKey = (eip, entryTop, anyTop)=>regionKey({ region: { entry: eip }, entryTop,
        loose: rt.loose, wrapped: !rt.readsChecked, anyTop });
    /**
     * The batch's candidates' records asked of a store across a link before
     * they are formed, in one wait, at both keys each (`recordBefore`).
     *
     * @param {Forming} step @param {any} store
     */
    const prefetch = (step, store)=>{
        /** @type {string[]} */
        const keys = [];
        for (let at = step.next; at < step.batch.length; at++)
        {
            const [key, eip] = step.batch[at];
            const owner = storedOwner(eip, key % 16);
            const entry = owner >= 0 ? Math.floor(owner / 16) : eip;
            const top = owner >= 0 ? owner % 16 : key % 16;
            keys.push(candidateKey(entry, top, false), candidateKey(entry, top, true));
        }
        try
        {
            /** @type {(Uint8Array | null | undefined)[] | undefined} */
            const answers = keys.length === 0 ? undefined : store.getManyNow(keys);
            for (let at = 0; at < (answers?.length ?? 0); at++)
            {
                const bytes = answers?.[at];
                if (bytes !== undefined)
                {
                    step.known?.set(keys[at], bytes);
                }
            }
        }
        catch {
            // Asked again after forming, as without this.
        }
    };
    /**
     * A candidate's record before it is formed, where the store answers at
     * once: at the top it is entered at, then at any top. A region the store
     * holds is then formed once, as its record says (`accepted`), where it was
     * formed first as this run's regions and callees had it and then again
     * as the record says: on eight executors, each forming what it reaches
     * beside regions of its own, two of three hits were formed twice. A store
     * across a link was asked as the batch began (`prefetch`); a candidate
     * added since, a callee, is formed first and looked up after, as before.
     *
     * @param {Forming} step @param {any} store @param {number} eip @param {number} entryTop
     * @returns {{ key: string, shape: import('./cache.js').RegionShape } | null}
     */
    const recordBefore = (step, store, eip, entryTop)=>{
        const known = step.known;
        if (store === null || known === undefined)
        {
            return null;
        }
        for (const anyTop of [false, true])
        {
            const key = candidateKey(eip, entryTop, anyTop);
            let bytes = known.get(key);
            if (bytes === undefined && typeof store.getManyNow !== 'function'
                && typeof store.getNow === 'function')
            {
                try
                {
                    bytes = store.getNow(key) ?? undefined;
                }
                catch {
                    bytes = undefined;
                }
                if (bytes !== undefined)
                {
                    known.set(key, bytes);
                }
            }
            const shape = bytes === undefined || bytes === null ? undefined
                : unpackedOf(step, key, bytes)?.shape;
            if (shape !== undefined)
            {
                return { key, shape };
            }
        }
        return null;
    };

    /**
     * A batch's lookups answered at once, where the store can answer without
     * a turn of the event loop (`getNow`: a directory store in a worker reads
     * its records file through a synchronous handle). The batch is then
     * published as soon as it is answered, as without a store, where a turn
     * later -- with no batch formed meanwhile -- a first run went on
     * interpreted, formed other regions and emitted more than the store
     * saved. Answered a credit's worth a call, the guest running between, a
     * record or a module at a time: a batch's hundreds of records read and
     * unpacked at once held the thread for ten milliseconds. Each region is
     * settled once all are answered. 'later', with nothing settled, when a
     * lookup cannot be answered so.
     *
     * @param {Forming} step @param {any} store
     * @param {number} until  when the call's share is spent
     * @param {boolean} any  whether the call has done work already, so it may stop at once
     * @returns {'done' | 'part' | 'later'}
     */
    const lookUpOn = (step, store, until, any)=>{
        if (typeof store.getNow !== 'function')
        {
            return 'later';
        }
        const { formed } = step;
        const known = step.known ??= new Map();
        /** @type {Lookup} */
        const lookup = step.lookup ?? { records: null, cached: [], wanted: null,
            modules: new Map(), done: false };
        step.lookup = lookup;
        if (lookup.done)
        {
            return 'done';
        }
        const keys = lookup.keys ??= formed.map(region=>regionKey(region));
        // A store across a link answers the batch's names in one wait - each
        // region's key and its own version's beside it (`storeKey`); any other
        // is asked a name at a time. A name answered before its region was
        // formed (`recordBefore`) is not asked again.
        const linked = typeof store.getManyNow === 'function';
        /** @type {(key: string) => Uint8Array | null | undefined} */
        const one = linked ? key=>store.getManyNow([key])?.[0] : key=>store.getNow(key);
        /** @param {string} key */
        const answer = key=>(known.has(key) ? known.get(key) : one(key));
        try
        {
            if (linked && lookup.records === null)
            {
                const asked = [...keys, ...keys.map((key, at)=>`${key}/${formed[at].region.hash}`)]
                    .filter(key=>!known.has(key));
                const answers = asked.length === 0 ? [] : store.getManyNow(asked) ?? null;
                if (answers === null || answers.some((/** @type {any} */ bytes)=>
                    bytes === undefined))
                {
                    return 'later';
                }
                asked.forEach((key, at)=>known.set(key, answers[at]));
                lookup.records = keys.map(key=>known.get(key) ?? null);
            }
            while (lookup.cached.length < formed.length)
            {
                if (any && (performance.now() >= until || waitedFor()))
                {
                    return 'part';
                }
                any = true;
                const at = lookup.cached.length;
                const bytes = lookup.records !== null ? lookup.records[at] : answer(keys[at]);
                if (bytes === undefined)
                {
                    return 'later';
                }
                const cached = bytes === null ? null : unpackedOf(step, keys[at], bytes);
                const other = besideKey(formed[at], keys[at], cached);
                const besideBytes = other === null ? null : answer(other);
                if (besideBytes === undefined)
                {
                    return 'later';
                }
                lookup.cached.push(accepted(formed[at], cached, besideBytes === null ? null
                    : unpackedOf(step, /** @type {string} */ (other), besideBytes)));
            }
            /** A batch module's bytes are read once for every record naming it. */
            lookup.wanted ??= [...new Set(lookup.cached.map(cached=>cached?.moduleKey)
                .filter(/** @returns {key is string} */ key=>key !== undefined
                    && !batchInstances.has(key)))];
            while (lookup.modules.size < lookup.wanted.length)
            {
                if (any && (performance.now() >= until || waitedFor()))
                {
                    return 'part';
                }
                any = true;
                const key = lookup.wanted[lookup.modules.size];
                const compiled = sharedModule(key);
                if (compiled !== undefined)
                {
                    lookup.modules.set(key, compiled);
                    continue;
                }
                const bytes = one(key);
                if (bytes === undefined)
                {
                    return 'later';
                }
                lookup.modules.set(key, bytes === null
                    ? null : unpackRegion(bytes, cacheVersion)?.module ?? null);
            }
        }
        catch {
            return 'later';
        }
        formed.forEach((region, at)=>{
            const cached = lookup.cached[at];
            const batchKey = cached?.moduleKey;
            settle(region, cached, batchKey !== undefined && !batchInstances.has(batchKey)
                ? lookup.modules.get(batchKey) ?? null : undefined);
        });
        lookup.done = true;
        return 'done';
    };

    /**
     * A batch's regions to publish a credit's worth a call (`publishOn`). A
     * store hit whose module this run has not instantiated waits for it to be
     * compiled off this thread (`compileOn`), once for every hit naming it --
     * by its batch's key, or by itself for a module of its own.
     *
     * @param {Waiting[]} waiting
     * @param {number[]} [covers]  what the regions cover until they are published
     *     (`coveredOut`)
     */
    const publishLater = (waiting, covers = [])=>{
        /** @type {Publishing['compile']} */
        const compile = [];
        /** @type {Set<string | object>} */
        const named = new Set();
        /** @type {Publishing['compiled']} */
        const compiled = new Map();
        for (const { instance, source, bytes } of waiting)
        {
            if (instance === null && source !== undefined && bytes !== undefined
                && !named.has(source))
            {
                named.add(source);
                // Compiled already by a runtime sharing the store.
                if (bytes instanceof WebAssembly.Module)
                {
                    compiled.set(source, bytes);
                }
                else
                {
                    compile.push({ source, bytes });
                }
            }
        }
        toPublish.push({ waiting, next: 0, ready: compile.length === 0, compile, started: [],
            compiled, instances: new Map(), covers });
        queueMicrotask(sendNext);
    };

    /**
     * Starts compiling the modules of the first batch with any not started, a
     * credit's worth a call: `WebAssembly.compile` copies and hashes a module's
     * bytes on this thread before it lets go, a dozen milliseconds for a
     * batch's modules started at once. The batch is ready once every one of
     * them is compiled.
     *
     * @returns {number} regions published: none
     */
    const compileOn = ()=>{
        const batch = /** @type {Publishing} */ (toPublish.find(one=>one.compile.length > 0));
        if (workerClosed)
        {
            batch.compile.length = 0;
            batch.ready = true;
            return 0;
        }
        const left = holding() ? creditNow() : Infinity;
        if (left <= 0)
        {
            counts.heldBack++;
            resumeWanted = true;
            return 0;
        }
        const until = performance.now() + left;
        while (batch.compile.length > 0)
        {
            const { source, bytes } = /** @type {Publishing['compile'][number]} */ (
                batch.compile.shift());
            counts.compiledApart++;
            batch.started.push(WebAssembly.compile(/** @type {Uint8Array<ArrayBuffer>} */ (bytes))
                .then(module=>{
                    compiledBytes.set(module, bytes.length);
                    batch.compiled.set(source, module);
                    if (typeof source === 'string')
                    {
                        share(source, module, bytes.length);
                    }
                }, (/** @type {unknown} */ e)=>{
                    refused.batch = (refused.batch ?? 0) + 1;
                    refused[`batch: ${String(e).slice(0, 120)}`] = 1;
                    batch.compiled.set(source, null);
                }));
            if (performance.now() >= until)
            {
                break;
            }
        }
        if (batch.compile.length > 0)
        {
            resumeWanted = true;
            return 0;
        }
        Promise.all(batch.started).then(()=>{
            batch.ready = true;
            sendNext();
        });
        return 0;
    };

    /**
     * The instance of a store hit's module, made as the first region naming it
     * is published: made as each was compiled, a batch's modules were all
     * instantiated in the turn the last compile came back.
     *
     * @param {Publishing} batch @param {string | object | undefined} source
     * @returns {WebAssembly.Instance | null}
     */
    const instanceFor = (batch, source)=>{
        if (source === undefined)
        {
            return null;
        }
        let made = batch.instances.get(source);
        if (made === undefined)
        {
            const module = batch.compiled.get(source) ?? null;
            made = module === null ? null : instantiate(module);
            batch.instances.set(source, made);
            if (made !== null && typeof source === 'string')
            {
                keepBatch(source, made);
                modulesSinceRelink++;
            }
        }
        return made;
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
                const entry = batch.waiting[batch.next];
                const { one, built, relink } = entry;
                const instance = entry.instance ?? instanceFor(batch, entry.source);
                if (instance !== null && relink !== undefined)
                {
                    relinkOne(one, built, instance, relink.store, relink.key);
                }
                else if (instance !== null)
                {
                    published += applyBuilt(one, built, instance);
                }
            }
            uncoverKeys(batch.covers);
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
                instance = instantiate(key === undefined ? one.cached.module : one.moduleBytes,
                    undefined, key) ?? undefined;
                if (instance !== undefined && key !== undefined)
                {
                    keepBatch(key, instance);
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
            publishLater(waiting, cover(waiting.flatMap(({ one })=>coverKeys(one))));
        }
        const unbuilt = formed.filter(one=>one.cached === null);
        // Built as the region's precision and the shape tests now say, whatever
        // they said when formed.
        for (const one of unbuilt)
        {
            Object.assign(one, precisionFlags(one.region, one.entryTop));
            one.loose = rt.loose;
            one.wrapped = !rt.readsChecked;
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
                alone: postingAlone, covers: cover(unbuilt.flatMap(coverKeys)) };
            translator.pending = pending;
            for (const one of unbuilt)
            {
                one.waited = true;
                for (const block of one.region.blocks)
                {
                    noteWay(block.start, 'sent');
                }
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
                layout: emitLayout, features: found, options: emitOptions(),
                ...storeVersionFor(store),
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
            const emittedAt = performance.now();
            const batch = emitBatch(jobs, emitLayout, found, emitOptions(), emitCache);
            emittedHereMs += performance.now() - emittedAt;
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
        readModules();
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
        if (toPublish.some(batch=>batch.compile.length > 0))
        {
            return compileOn();
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
        const keeps = leaveOut.size > 0 || profiling
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
        // Where the work here is bounded (`holding`), nothing is emitted here
        // while a translator loads -- the batch waits for it, a region of a
        // shader compiler's emitted alone held the thread for twenty-five
        // milliseconds -- and with none to come a batch emitted here is one
        // region, emitted in the call that finishes it.
        const inline = !translatorReady();
        const loading = translatorLoading();
        const ceiling = inline && holding() && !loading ? 1 : settings.maxBatchRegions;
        const wanted = Math.min(ceiling,
            Math.max(settings.batchRegions, queue.size >> 2));
        forming = { batch: hottest(wanted), next: 0, formed: [], covered: new Set(), ceiling,
            takenAt: performance.now(),
            forTranslator: freeTranslator() !== null || holding() && loading };
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
        // A diagnostic run with classes left out, or with an undo log the
        // stored modules were built without, keeps no translations.
        const store = storeHere();
        if (step.known === undefined)
        {
            step.known = new Map();
            if (store !== null && typeof store.getManyNow === 'function')
            {
                prefetch(step, store);
            }
        }
        // Nothing runs while this call forms, so its regions share what
        // decoding finds; the guest runs between two calls, which may write
        // the code over.
        const shared = formShared();
        for (; step.next < batch.length; step.next++)
        {
            if (step.next > first && (performance.now() >= until || waitedFor()))
            {
                break;
            }
            let [key, eip] = batch[step.next];
            unqueue(key);
            dropKey(key);
            // A block of a region the store holds: that region is formed, which the
            // store answers, and has an entry here once published.
            const owner = storedOwner(eip, key % 16);
            if (owner >= 0)
            {
                unqueue(owner);
                dropKey(owner);
                key = owner;
                eip = Math.floor(owner / 16);
                counts.toStoredRegion++;
            }
            inFlight.set(key, takenAt);
            noteWay(eip, 'taken');
            noteWay(eip, 'batch', batch.length);
            const entryTop = key % 16;
            // A candidate that has an entry by now -- a block of a region
            // published while it waited, the return address of a call the
            // interpreter met before its caller's region came back -- would
            // be formed again as a region of its own.
            if (coveredIn(covered, eip, entryTop) || coveredIn(coveredOut, eip, entryTop)
                || closedIn.has(eip) || entries.entryOf(eip, entryTop) >= 0)
            {
                inFlight.delete(key);
                continue;
            }
            // One the store holds is formed as its record says (`recordBefore`).
            const record = recordBefore(step, store, eip, entryTop);
            const region = formAt(eip, record?.shape.targets, shared);
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
                // Barren, and not in flight: nothing will publish it, and the
                // address may be asked for again once its page is written.
                barrenAdd(eip, entryTop);
                inFlight.delete(key);
                continue;
            }
            formed.push({ region, entryTop, stamp: stamp(region.pages), cached: null,
                ...precisionFlags(region, entryTop), loose: rt.loose,
                wrapped: !rt.readsChecked,
                checked: checkedAt(region, entryTop),
                // Formed with the record's callees, and translated with them should
                // the record be refused: the translator forms the region again from
                // what it is sent, and refuses it when it hashes otherwise.
                ...(record === null ? {} : { formedAs: record.key, formedRegion: region,
                    ...(record.shape.targets === undefined ? {}
                        : { targets: record.shape.targets }) }) });
            for (const covers of coverKeys({ region, entryTop }))
            {
                covered.add(covers);
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
        /** @type {'done' | 'part' | 'later' | null} */
        let looked = null;
        if (store !== null && step.lookup !== null)
        {
            const lookupAt = clock();
            looked = lookUpOn(step, store, until, step.next > first);
            counts.lookupMs += clock() - lookupAt;
            if (looked === 'part')
            {
                // The guest runs before the rest is answered: what is formed
                // is read again when it is published.
                for (const one of formed)
                {
                    one.waited = true;
                }
                counts.lookedUpInPart++;
                resumeWanted = true;
                return 0;
            }
            if (looked === 'later')
            {
                step.lookup = null;
            }
        }
        if (step.forTranslator && freeTranslator() === null
            && (translators.some(one=>!one.leaving) || awaitingLend))
        {
            // Whole, it waits for a translator: one was free when it was taken,
            // or loading, and while it formed a pool took that one back as
            // idle, or the run's pool had its workers between processes --
            // emitted here instead, a batch of hundreds of regions held the
            // thread for a third of a second. An answer, or a translator
            // ready, calls back.
            for (const one of formed)
            {
                one.waited = true;
            }
            counts.formedWaiting++;
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
        if (store === null)
        {
            return finishBatch(formed, null);
        }
        const lookupAt = clock();
        if (looked === 'done')
        {
            counts.lookedUpNow++;
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
        /** @type {Map<string, Promise<Uint8Array | WebAssembly.Module | null>>} */
        const modules = new Map();
        /** @param {string} key */
        const moduleBytes = key=>{
            let pending = modules.get(key);
            if (pending === undefined)
            {
                /** @param {Uint8Array | null} bytes */
                const unpack = bytes=>(bytes === null
                    ? null : unpackRegion(bytes, cacheVersion)?.module ?? null);
                const compiled = sharedModule(key);
                pending = compiled !== undefined ? Promise.resolve(compiled)
                    : /** @type {Promise<Uint8Array | null>} */ (store.get(key).then(unpack));
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
                const key = regionKey(one);
                const bytes = await store.get(key);
                const record = bytes === null ? null : unpackRegion(bytes, cacheVersion);
                const other = besideKey(one, key, record);
                const besideBytes = other === null ? null : await store.get(other);
                const cached = accepted(one, record, besideBytes === null ? null
                    : unpackRegion(besideBytes, cacheVersion));
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
    // Late: what the modules read of runtime.js.
    join(rt, {
        get corkRetired(){ return corkRetired; },
        translators,
        translatorReady,
        translatorLoading,
        coveredOut,
        get runtimeApi(){ return runtimeApi; },
        arena,
        emitOptions,
        sharedForms,
    });
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
            const one = entries.at(entry);
            const { fn, label } = one;
            // The heat a relink weighs by, and the mark of the
            // module the eviction weighs by.
            one.heat++;
            if (one.owner !== null)
            {
                one.owner.ran = corkRetired;
            }
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
                if (code >>> 8 === HELD && retired === 0)
                {
                    heldOnEntry(entry, one);
                }
                this.missAt(view().getUint32(layout.eip, true), view().getUint8(layout.x87Top),
                    code >>> 8 === HELD);
            }
            // Looked at whatever the run left by: a rep that stored into code and
            // ran out of budget on a later page in bulk leaves by the budget, and
            // the run that finishes it stores no code of its own.
            if (kind === 'stale' || pages.staleSize() !== 0)
            {
                // Every page the run's stores into code reached, from the
                // lowest of them to the highest.
                const address = codePages.staleAddress();
                const size = pages.staleSize();
                pages.clearStale();
                storedInto(address, size);
                codeShared?.publish(address, size);
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
                target = { count: 0, held: 0, tops: 0, first: -1, last: -1 };
                exitTargets.set(address, target);
            }
            target.count++;
            // When: a loading phase's wait for a translation, or one that play
            // still pays. A whole millisecond is enough, and a clock read a
            // thousandth of the exits.
            if ((target.count & 1023) === 1)
            {
                const now = Math.round(performance.now() - bornAt);
                target.first = target.first < 0 ? now : target.first;
                target.last = now;
            }
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
        readsChecked: ()=>rt.readsChecked,
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
            // again with copies should translated code keep leaving for it. A
            // block of a region formed and not yet published has its entry
            // once it is: queued, a batch took it, found it covered and dropped
            // it, and the interpreter noted it again - a .NET runtime's load
            // spent a seventh of the engine thread over a window so.
            if (entries.entryOf(eip, top & 7) >= 0 || barrenHas(eip, top & 7)
                || !translatable(eip) || closedIn.has(eip)
                || coveredIn(coveredOut, eip, top & 7))
            {
                return;
            }
            enqueue(key, eip, hotness);
        },
        seedRecords,
        attachTranslator,
        /** The milliseconds emitted on this thread, ever: work no worker took. */
        translatedHere: ()=>emittedHereMs,
        detachTranslator,
        /** Writes whatever the store keeps aside from its records, so the
         * names of this run's regions are on disk before the run ends and the
         * next run's index can find them. The store stays open: it is its
         * opener's to close, and a run hands one store to the machine of every
         * process it starts, so a machine that goes would otherwise take it
         * from the processes still running. */
        async flush(){
            const store = storeHere();
            if (store !== null && regions.size > 0)
            {
                // Where this run's regions have entries, beside what the store
                // holds now -- not what it held when this runtime started: every
                // process of the run has a runtime of its own, and a program that
                // runs a tool again and again (Far Cry, its shader compiler 45
                // times a run) would have each one put back the map it read,
                // dropping what the others added since, and put it whole even
                // when it added nothing: 46 maps of 2.5 MB a run.
                await blocksRead;
                /** @type {Map<number, number> | null} */
                let now = storedBlocks;
                try
                {
                    const bytes = await store.get(blocksKey());
                    now = bytes === null ? now : unpackBlocks(bytes);
                }
                catch {
                    // The map read at the start stands for it.
                }
                const blocks = new Map(now ?? []);
                let added = 0;
                for (const record of regions)
                {
                    for (const slot of record.slots)
                    {
                        const { eip, top } = entries.at(slot);
                        const block = keyOf(eip, top);
                        const owner = keyOf(record.entry, record.entryTop);
                        if (blocks.get(block) !== owner)
                        {
                            blocks.set(block, owner);
                            added++;
                        }
                    }
                }
                // Put whole, the map is worth it only for what this runtime adds to
                // it: a tool's process adding a few blocks to a game's map of
                // 200 000 wrote 2.5 MB for each of its runs.
                if (added > 0 && added * MAP_SHARE >= blocks.size)
                {
                    await store.put(blocksKey(), packBlocks(blocks)).catch(()=>{});
                }
            }
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
            return translateNow();
        },
        invalidatePage,
        stored,
        codeWritten,
        takeWrites,
        markWritten,
        takeCodeWrites,
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
        noteStack,
        interpretedAt,
        forcedStep,
        counters,
        diagnostics,
    };
    runtimeApi = api;
    return api;
}
