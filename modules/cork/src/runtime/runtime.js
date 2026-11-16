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

import { TIER_SLOT, enterRegion } from '../emit/region.js';
import { RANGE, SHAPE } from '../emit/x87.js';
import { HELD, MADE, PRECISION } from '../emit/memory.js';
import { keyOf } from './entries.js';
import { PageFlag } from './pages.js';
import { resetBlockCounts } from './block-profile.js';
import { baseState, join } from './state.js';
import { seedRecords } from './cache.js';
import { createDiagnostics } from './diagnostics.js';
import { createVariants } from './variants.js';
import { createQueue } from './queue.js';
import { createRegions } from './regions.js';
import { createCodeWrites } from './code-writes.js';
import { createModules } from './modules.js';
import { createTranslators } from './translators.js';
import { createStore } from './store.js';
import { createPublish } from './publish.js';
import { createRelink } from './relink.js';
import { createForming } from './forming.js';

// The translation worker's file, which a host opens for a pool of its own.
export { translatorWorkerUrl } from './translators.js';

/** Exit codes by number, as the region functions answer them. */
const KINDS = /** @type {ExitKind[]} */ (
    ['untranslated', 'budget', 'trap', 'halt', 'fault', 'stale', 'interpreted',
        // `RETURNED` goes to a region's own wasm call, never to the host; were it
        // to arrive, the state block is whole and the run goes on at its EIP.
        'untranslated']);

/** @typedef {import('../../../core/src/layers/cpu/engine.js').Runtime} Runtime */
/** @typedef {import('../../../core/src/layers/cpu/engine.js').ExitKind} ExitKind */
/** @typedef {import('../emit/region.js').X87Precision} X87Precision */
/** @typedef {import('./state.js').RegionRecord} RegionRecord */
/** @typedef {import('./state.js').Placed} Placed */
/** @typedef {import('./state.js').Held} Held */
/** @typedef {import('./state.js').Pending} Pending */
/** @typedef {import('./state.js').Translator} Translator */
/** @typedef {import('./state.js').Waiting} Waiting */
/** @typedef {import('./state.js').Publishing} Publishing */
/** @typedef {import('./state.js').Lookup} Lookup */
/** @typedef {import('./state.js').Forming} Forming */

/**
 * @param {Parameters<typeof baseState>[0]} env
 * @returns {Runtime & { pages: import('./pages.js').PageTable }}
 */
export function createCorkRuntime(env){
    const rt = /** @type {import('./state.js').State} */ (baseState(env));
    const { layout, settings, codeShared, pages, codePages, table, resumable, entries, view,
        counterWord, profiling } = rt;
    // The instructions translated code retired, counted by the run loop below with nothing
    // between it and a region's return; the parts read it through the state.
    let corkRetired = 0;
    join(rt, { get corkRetired(){ return corkRetired; } });
    // The parts, each made over what the base and the parts before it hold (a part reads
    // what a later one makes through the state, when it runs).
    const { noteStall, exits, untranslatedBy, interpretedAt, forcedStep, counters, counts,
        diagnostics
    } = join(rt, createDiagnostics(rt));
    const { queue, buckets, heatOf, bucketOf, enqueue, barrenHas, misses, exitTargets, bornAt,
        EXIT_TARGETS_CAP, variantHeat, MISSES_CAP, decayMisses, inFlight, overdue
    } = join(rt, createQueue(rt));
    join(rt, createModules(rt));
    const { heldOnEntry, closedIn, copiesWanted } = join(rt, createRegions(rt));
    const { readsFaulted, precisionMissed, floatMissed, heldMissed, shapeMissed
    } = join(rt, createVariants(rt));
    const { liftVolatile, invalidatePage, storedInto, translatable, stored, codeWritten,
        takeWrites, markWritten, takeCodeWrites, noteStack } = join(rt, createCodeWrites(rt));
    const { openTranslator, coveredOut, coveredIn, attachTranslator, detachTranslator,
        closeTranslators
    } = join(rt, createTranslators(rt));
    const { flushStore } = join(rt, createStore(rt));
    join(rt, createPublish(rt));
    join(rt, createRelink(rt));
    for (let n = 0; n < settings.translators; n++)
    {
        openTranslator();
    }
    const { translateNow } = join(rt, createForming(rt));

    // The run loop's own: what the tier has retired in place of misses, all told, once it
    // is installed (not the translator's share); the misses noted since the last decay;
    // the untranslated exits' vectors by name; the one exit record every run rewrites;
    // and when the block profile starts over.
    /** @type {(() => number) | null} */
    let tierEntered = null;
    // Where the last run left held, -1 for none, and the stores into code told of by then.
    let heldAt = -1;
    let heldStores = 0;
    let missesInserted = 0;
    /** @type {Record<number, keyof typeof untranslatedBy>} */
    const VECTOR_NAMES = { 0: 'bare', [HELD]: 'held', [PRECISION]: 'precision', [SHAPE]: 'shape',
        [RANGE]: 'range', [MADE]: 'made' };
    /** @type {import('../../../core/src/layers/cpu/engine.js').ExitRecord} */
    const exit = { retired: 0, kind: 'untranslated', vector: 0 };
    let profileResetAt = import.meta.BOTTLIFY_DIAGNOSTICS !== false && profiling
        && settings.blockProfileFrom > 0
        ? performance.now() + settings.blockProfileFrom * 1000 : null;
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
            // A region left held before this run, and what was run since stored into
            // no code: the window it left for was one it did not reach (`heldMissed`),
            // unless this run ends in the fault it was left for.
            const leftHeld = heldAt >= 0 && counts.codeStores === heldStores ? heldAt : -1;
            heldAt = -1;
            const code = enterRegion(fn, label, budget, view(), layout) >>> 0;
            const retired = (counterWord() - before) >>> 0;
            corkRetired += tierEntered === null ? retired
                : retired - ((tierEntered() - tierBefore) >>> 0);
            const kind = KINDS[code & 0xff] ?? 'untranslated';
            exits[kind]++;
            if (leftHeld >= 0 && retired === 0 && kind === 'untranslated')
            {
                // Nothing run yet: the host's own interpreter takes the instruction.
                heldAt = leftHeld;
            }
            else if (leftHeld >= 0 && kind !== 'fault' && kind !== 'stale'
                && pages.staleSize() === 0)
            {
                heldMissed(leftHeld);
            }
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
                if (code >>> 8 === HELD)
                {
                    heldAt = view().getUint32(layout.eip, true);
                    heldStores = counts.codeStores;
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
        translatedHere: ()=>rt.emittedHereMs,
        detachTranslator,
        /** The store's records named on disk (`flushStore`), then the workers ended. */
        async flush(){
            await flushStore();
            closeTranslators();
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
    rt.runtimeApi = api;
    return api;
}
