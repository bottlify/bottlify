/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Forming: what `translatePending` runs. A batch is the hottest candidates
 * formed into regions on the engine thread, looked up in the store, and
 * emitted on a worker or here (`translateStep`, `formOn`); between batches
 * the steps that form running code again take their turn. The engine thread's
 * time for it is bounded where frames pace the run (`holdMs`): a credit
 * refilled at `HOLD_SHARE` of the time that passes, a batch formed in parts
 * across calls once it is spent, and a call armed to resume it
 * (`armResume`). Nothing else is formed or sent while a batch is half formed,
 * its lookups are out or its publication waits, so batches publish in order.
 */

import { formShared, hashRegion } from '../region.js';
import { keyOf } from './entries.js';
import { callsOf, summaryOf } from './summary.js';

/**
 * The share of the engine thread's time over a while the translator's work may
 * take (`holdMs` refills at it): what a frame gives up to new code.
 */
const HOLD_SHARE = 0.5;

/** @typedef {import('./state.js').Pending} Pending */
/** @typedef {import('./state.js').Forming} Forming */

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createForming(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { clock, entries, leaveOut, profiling, read, settings
    } = /** @type {import('./state.js').Base} */ (state);
    const { HOT_BUCKET, barrenAdd, batchesOut, buckets, checkedAt, closedIn, compileOn, copiesStep,
        copiesWanted, counts, coverKeys, coveredIn, coveredOut, dropKey, finishBatch, formAt,
        freeTranslator, giveUp, inFlight, lookUpLater, lookUpOn, noteWay, overdue, precisionFlags,
        prefetch, profileAt, publishOn, queue, readModules, recordBefore, reformStep, refused,
        regionOfRecord,
        relinkStep, sampleCalls, sourcesChanged, stamp, storeHere, storedOwner, toPublish,
        translatable, translatorLoading, translatorReady, translators, unqueue, waitedFor,
        workerUrl } = rt;
    /** When `translateNow` last looked, for `behindMs`. */
    let lookedAt = 0;
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
            const region = regionOfRecord(record, eip)
                ?? formAt(eip, record?.shape.targets, shared);
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
            for (const [callee, top] of callsOf(region, entryTop,
                settings.summaries === false ? null : summaryOf(region, entryTop)))
            {
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
            // One a record stands for was stored with an entry that runs.
            const entryBlock = /** @type {import('./summary.js').SummedRegion} */ (region)
                .summary !== undefined ? null : region.blocks.find(block=>block.start === eip);
            if (entryBlock !== null
                && (entryBlock === undefined || entryBlock.instructions.length === 0))
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
    return {
        get postingAlone(){ return postingAlone; },
        get runtimeApi(){ return runtimeApi; },
        set runtimeApi(value){ runtimeApi = value; },
        holding,
        creditNow,
        sendNext,
        get resumeWanted(){ return resumeWanted; },
        set resumeWanted(value){ resumeWanted = value; },
        translateNow,
    };
}
