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

import { formShared, hashRegion } from '../region.js';
import { TIER_SLOT, enterRegion } from '../emit/region.js';
import { RANGE, SHAPE, trackRegion } from '../emit/x87.js';
import { HELD, PRECISION } from '../emit/memory.js';
import { openTranslationWorker } from './translator.js';
import { keyOf } from './entries.js';
import { PageFlag } from './pages.js';
import { resetBlockCounts } from './block-profile.js';
import { baseState, join } from './state.js';
import { seedRecords } from './cache.js';
import { createDiagnostics } from './diagnostics.js';
import { createVariants, usesX87 } from './variants.js';
import { createQueue } from './queue.js';
import { createRegions } from './regions.js';
import { createCodeWrites } from './code-writes.js';
import { createModules } from './modules.js';
import { createTranslators } from './translators.js';
import { createStore } from './store.js';
import { createPublish } from './publish.js';
import { createRelink } from './relink.js';

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
    const { layout, read, settings, clock, leaveOut, codeShared, pages, codePages, table,
        resumable, entries, view, counterWord, profiling } = rt;
    const { counts, noteStall, exits, untranslatedBy, refused, interpretedAt, forcedStep, counters,
        diagnostics } = join(rt, createDiagnostics(rt));
    const { precisionFlags, readsFaulted, precisionMissed, floatMissed, shapeMissed, checkedAt
    } = join(rt, createVariants(rt));
    join(rt, createModules(rt));
    /** What the tier has retired in place of misses, all told, once it is installed: not
     * the translator's own share. @type {(() => number) | null} */
    let tierEntered = null;
    const { queue, buckets, HOT_BUCKET, heatOf, bucketOf, unqueue, enqueue, dropKey, barrenHas,
        barrenAdd, misses, exitTargets, bornAt, noteWay, EXIT_TARGETS_CAP, variantHeat, MISSES_CAP,
        decayMisses, inFlight, overdue } = join(rt, createQueue(rt));
    let missesInserted = 0;
    const { heldOnEntry, closedIn, copiesWanted } = join(rt, createRegions(rt));
    const { liftVolatile, stamp, invalidatePage, sourcesChanged, storedInto, translatable, stored,
        codeWritten, takeWrites, markWritten, takeCodeWrites, noteStack
    } = join(rt, createCodeWrites(rt));
    /** When `translateNow` last looked, for `behindMs`. */
    let lookedAt = 0;
    /** @type {Record<number, keyof typeof untranslatedBy>} */
    const VECTOR_NAMES = { 0: 'bare', [HELD]: 'held', [PRECISION]: 'precision', [SHAPE]: 'shape',
        [RANGE]: 'range' };
    /** @type {import('../../../core/src/layers/cpu/engine.js').ExitRecord} */
    const exit = { retired: 0, kind: 'untranslated', vector: 0 };
    let corkRetired = 0;
    const { workerUrl, translators, freeTranslator, translatorReady, translatorLoading, batchesOut,
        coveredOut, coverKeys, coveredIn, giveUp, attachTranslator, detachTranslator,
        closeTranslators } = join(rt, createTranslators(rt));
    /** Set while a step that takes over running regions (`Pending.alone`) posts. */
    let postingAlone = false;
    // A batch's store lookups are in flight: its bytes come back between
    // frames, and until then no new batch is formed, so the batches publish in
    // order and the waiting is never the slice's.
    let storePending = false;
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
    /** @type {Forming | null} */
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
            if (!rt.workerClosed)
            {
                sendNext();
            }
        }, Math.max(1, (settings.holdMs / 2 - creditNow()) / HOLD_SHARE));
    };
    let profileResetAt = import.meta.BOTTLIFY_DIAGNOSTICS !== false && profiling
        && settings.blockProfileFrom > 0
        ? performance.now() + settings.blockProfileFrom * 1000 : null;
    const { formAt, storeHere, storedOwner, waitedFor, prefetch, recordBefore, lookUpOn,
        lookUpLater, flushStore } = join(rt, createStore(rt));
    const { toPublish, compileOn, publishOn, finishBatch } = join(rt, createPublish(rt));
    const { relinkStep, readModules, profileAt, sampleCalls, reformStep, copiesStep
    } = join(rt, createRelink(rt));

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
            && (translators.some(one=>!one.leaving) || rt.awaitingLend))
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
        // The guest runs on while the store answers.
        lookUpLater(formed, store, ()=>{
            storePending = false;
            for (const one of formed)
            {
                one.waited = true;
            }
            finishBatch(formed, store);
            sendNext();
        });
        counts.lookupMs += clock() - lookupAt;
        return 0;
    };
    // Late: what the modules read of runtime.js.
    join(rt, {
        get corkRetired(){ return corkRetired; },
        get postingAlone(){ return postingAlone; },
        get runtimeApi(){ return runtimeApi; },
        holding,
        creditNow,
        sendNext,
        get resumeWanted(){ return resumeWanted; },
        set resumeWanted(value){ resumeWanted = value; },
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
    runtimeApi = api;
    return api;
}
