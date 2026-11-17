/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Forming again what runs: the steps that take over regions already
 * published. A relink gathers the running regions' functions into fewer,
 * larger modules, in chunks a worker forms and emits again
 * (`relinkStep`); a merge moves a region into the module that calls it most
 * (`mergeStep`, where modules are placed in the table); indirect calls are
 * sampled and a region is formed again with the callees that take its calls
 * (`sampleCalls`, `reformStep`); and a region whose closed loop blocks
 * translated code keeps leaving for is formed again with copies
 * (`copiesStep`). Each goes alone: it replaces regions that are running.
 */

import { formRegion } from '../region.js';
import { relinkBatch } from './emit-built.js';

/** @typedef {import('./state.js').RegionRecord} RegionRecord */
/** @typedef {import('./state.js').Placed} Placed */
/** @typedef {import('./state.js').Held} Held */

/**
 * What a call formed into its region is taken to save, counted in the compares
 * a call makes to find its callee among those formed in. A wasm call between
 * regions and its return are about a hundred and forty machine instructions
 * (the state written and read back on both sides, the entry hash, the call
 * itself) and a compare with its branch two, which would say seventy; half of
 * that leaves room for what a larger region costs besides - its compile, the
 * registers V8 spills in a longer function.
 */
const CALL_IN_COMPARES = 32;
/** The least share of a call's samples its callees formed in take together:
 * below it the region is not worth forming again. */
const WORTH_SHARE = 8;

/**
 * The callees of an indirect call worth forming into its region, by the
 * samples of where it went (`targets`: a callee and how many of the `total`
 * went to it): the most sampled first, as many of them as leave the call
 * cheapest. A callee formed in saves its own calls the wasm call
 * (`CALL_IN_COMPARES`) and costs every call that goes past it a compare, so
 * the two dozen methods a virtual call is spread evenly over all pay, and of a
 * call spread over hundreds none does: no share of it pays for the compares
 * the rest would make. A callee's count is taken down by `doubt` first - of a
 * call spread evenly over five hundred, a hundred samples show a few callees
 * three times, which says nothing of them - and callees that together take
 * under an eighth of the samples (`WORTH_SHARE`) are left: a few such, a little
 * above the rest by chance, would have the region formed again for nothing.
 *
 * @param {Map<number, number>} targets @param {number} total
 * @param {number} most  how many a call may have formed in
 * @param {number} [doubt]
 * @returns {number[]}  the callees, the most sampled first
 */
export function calleesWorth(targets, total, most, doubt = 1){
    const ranked = [...targets].sort((a, b)=>b[1] - a[1]);
    let best = 0;
    let saved = 0;
    let taken = 0;
    let covered = 0;
    let walked = 0;
    for (let k = 1; k <= Math.min(most, ranked.length); k++)
    {
        const share = Math.max(0, ranked[k - 1][1] - doubt) / total;
        if (share === 0)
        {
            break;
        }
        covered += share;
        // A call to the k-th makes k compares, one that goes past them all k too.
        walked += share * k;
        const net = CALL_IN_COMPARES * covered - walked - (1 - covered) * k;
        if (net > saved)
        {
            saved = net;
            best = k;
            taken = covered;
        }
    }
    return taken * WORTH_SHARE >= 1 ? ranked.slice(0, best).map(([target])=>target) : [];
}

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createRelink(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { codeBase, emitLayout, entries, formHere, formOptions, found, layout, ramOf, read,
        settings, table, view } = /** @type {import('./state.js').Base} */ (state);
    const { CALL_SITES_CAP, applyRelink, byPage, copiesWanted, counts, emitCache, emitOptions,
        finishBatch, forgetClosed, formableFrom, freeTranslator, heldModules, logOf, placedLive,
        precisionFlags, precisionJob, recordAt, regions, stamp, storeVersionFor, translatorReady
    } = rt;
    /** By the address of an indirect call in translated code, its targets sampled and how
     * often, and its samples in all. @type {Map<number, { total: number,
     *     targets: Map<number, number> }>} */
    const callSamples = new Map();
    /** The calls sampled `PREDICT_AFTER` times, whose callees are looked at next: what was
     * a pass over every call sampled at each `translatePending`. @type {Set<number>} */
    const callsDue = new Set();
    /** The chunks of running regions a relink still has to gather, or null between
     * relinks. @type {RegionRecord[][] | null} */
    let relinkQueue = null;

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
     * batch modules have gathered and none has come for `relinkQuiet` instructions
     * of translated code, the running regions go in chunks of
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
            if (settings.relinkAfter <= 0 || rt.modulesSinceRelink < settings.relinkAfter)
            {
                return false;
            }
            // Not while the program is still reaching new code: every region is
            // emitted and compiled a second time, and runs in the engine's baseline
            // code again until that is done - a process that ends soon after pays
            // it and gets nothing back.
            if (rt.corkRetired - rt.modulePublishedAt < settings.relinkQuiet)
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
            rt.modulesSinceRelink = 0;
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
        if (placedLive.size === 0 || rt.corkRetired - sampledAt < MERGE_SAMPLE)
        {
            return;
        }
        sampledAt = rt.corkRetired;
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
                from.ran = rt.corkRetired;
            }
            const target = recordAt.get(placed.crossedTo.value >>> 0);
            if (target === undefined)
            {
                continue;
            }
            target.crossed = (target.crossed ?? 0) + crossed;
            if (target.held !== undefined)
            {
                target.held.ran = rt.corkRetired;
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
        if (rt.corkRetired - mergedAt < mergeWait)
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
        mergedAt = rt.corkRetired;
        mergeWait = Math.max(MERGE_EVERY, chunk.length * MERGE_PER_REGION);
        return relinkChunk(chunk, store);
    };

    // Samples of one call before its callees are looked at: sixteen come in
    // a reading at most, the last calls of a slice.
    const PREDICT_AFTER = settings.predictAfter;
    // The callees a call may have formed in, at most (`calleesWorth` says which):
    // a call compares its target with each in turn. At eight, each an eighth of
    // the samples or more, a virtual call over two dozen classes had none formed
    // in and every call of it was a wasm call (the PE bench's entities: 7.39
    // machine instructions a guest one, 3.82 with them).
    const PREDICT_CALLEES = 32;
    // Samples for each callee seen before a call's callees are looked at -
    // at four, one callee in eleven had a sample or none and was left for a
    // second forming of the region; at eight, one in three hundred - and
    // what a callee's count is doubted by (`calleesWorth`): none of either
    // where a test looks after a sample or two.
    const SAMPLES_A_CALLEE = Math.min(8, PREDICT_AFTER);
    const PREDICT_DOUBT = Math.min(1, PREDICT_AFTER - 1);
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
            // Due once the samples say where it goes: enough of them, and several
            // for each callee seen - one spread over two dozen callees looked at
            // after its first forty-eight had half of them formed in, and the
            // region formed again for the rest. A call with more callees than
            // may be formed in is due as it was.
            if (++seen.total >= PREDICT_AFTER
                && seen.total >= SAMPLES_A_CALLEE * Math.min(seen.targets.size, PREDICT_CALLEES))
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
            const shared = calleesWorth(seen.targets, seen.total, PREDICT_CALLEES,
                PREDICT_DOUBT);
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
        const until = rt.holding() ? performance.now() + rt.creditNow() : Infinity;
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
        const until = rt.holding() ? performance.now() + rt.creditNow() : Infinity;
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
                ...(record.targets === undefined ? {} : { targets: record.targets }),
                formable: [...record.formable ?? record.pages] })),
            pages: [...copies],
            form: formOptions,
        };
        const translator = freeTranslator();
        if (translator !== null)
        {
            const pending = { id: ++rt.workerRequest, relink: chunk, store, at: performance.now(),
                alone: true };
            translator.pending = pending;
            translator.adapter.post({ id: pending.id, relink, layout: emitLayout, features: found,
                options: emitOptions(), ...storeVersionFor(store) },
            [...copies.values()].map(bytes=>bytes.buffer));
            return true;
        }
        const relinkedAt = performance.now();
        const batch = relinkBatch(relink, emitLayout, found, emitOptions(), emitCache);
        rt.emittedHereMs += performance.now() - relinkedAt;
        counts.emitMs += batch.emitMs;
        counts.encodeMs += batch.encodeMs;
        applyRelink(chunk, batch, null, store);
        return true;
    };
    return {
        copyPages,
        relinkStep,
        readModules,
        profileAt,
        sampleCalls,
        reformStep,
        copiesStep,
    };
}
