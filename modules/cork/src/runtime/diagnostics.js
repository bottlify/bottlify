/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's diagnostics: the counters every part adds to (`counts`, the
 * exits by kind, what was refused), the journals kept for a hunt (stalls of
 * the engine thread, forced steps, interpreted starts, call sites, the store's
 * keys), and the two reports made of them - `counters`, cheap enough for a
 * slice, and `diagnostics`, the whole snapshot. Apart so the parts that
 * translate hold only the counting, not the reporting; a shipped build reads
 * none of the journals.
 */

import { formRegion } from '../region.js';
import { decode } from '../decode/decoder.js';
import { emitBatch } from './emit-built.js';
import { openArena } from './arena.js';
import { ANY_TOP, keyOf } from './entries.js';
import { PageFlag } from './pages.js';
import { Tables } from './layout.js';
import { blockCounts, mechanismCounts, topBlocks, transferTargets } from './block-profile.js';
import { profileForms } from './profile-forms.js';
import { NanRecord } from '../emit/x87.js';

/** @typedef {import('../../../core/src/layers/cpu/engine.js').Runtime} Runtime */
/** @typedef {import('../../../core/src/layers/cpu/engine.js').ExitKind} ExitKind */
/** @typedef {import('./state.js').RegionRecord} RegionRecord */

/** A profiling run's hot forms (`hotForms`): the regions emitted again for them at most, the
 * share of the counted executions they stop at, and how long an answer stands. */
const FORMS_REGIONS = 300;
const FORMS_SHARE = 0.95;
const FORMS_EVERY_MS = 30_000;
/** How many addresses forced steps are counted for (`forcedAt`): the first met, which in a
 * loop that forces are the ones that go on forcing. */
const FORCED_KEPT = 256;


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
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createDiagnostics(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { codePages, counterWord, emitLayout, entries, formHere, found, layout, pages, profiling,
        read, settings, table, transfersCounted, view
    } = /** @type {import('./state.js').Base} */ (state);
    /**
     * With `timings`: the instructions interpreted from each address the host
     * began interpreting at (a chunk's first), and the first and last time -
     * which code a frame spent interpreted, and when. Bounded: past the cap a
     * new address is not counted.
     * @type {Map<number, { count: number, first: number, last: number }>}
     */
    const interpretedFrom = new Map();
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
    // Indirect call sites tried with predicted callees, kept for the diagnostics.
    const CALL_SITES_CAP = 16384;
    const counts = {
        modules: 0, invalidations: 0, volatilePages: 0, dropped: 0, moduleBytes: 0,
        // Stores into code that changed none of the bytes a region on the page was made from.
        storesKept: 0,
        // Indirect call sites whose samples came due (`callTargets`), and why
        // each was left as it was: no callee took a share of its samples, or
        // only ones tried already; its regions formed again as often as they
        // may be; formed again with none of its new callees in; no region
        // holding it to form again. And the calls a region was formed again
        // without sampling (`quiet`).
        predictDue: 0, predictNoShare: 0, predictReformsOut: 0, predictNotFormed: 0,
        predictNoRegion: 0, predictHeld: 0, predictQuiet: 0,
        queueDrops: 0, queueEvictions: 0, emitFailures: 0,
        // Regions the worker formed otherwise from bytes nobody wrote, emitted here instead
        // (`publishBatch`): a forming the worker does not repeat, which is a bug to find.
        formedApart: 0,
        // A changed record by why (`accepted`): formed as it says with other
        // bytes, formed again by it with other bytes, or other modes (x87
        // precision, floats, the stack shape's tests).
        cacheHits: 0, cacheMisses: 0, missNoRecord: 0, missNoModule: 0, missChanged: 0,
        missBytes: 0, missFormedOther: 0, missModes: 0, missPrecision: 0, missFloats: 0,
        hitsFormedAgain: 0, formedAsRecorded: 0,
        takenUnformed: 0, sharedModules: 0, formedShared: 0,
        toStoredRegion: 0, precisionSwitches: 0,
        readSwitches: 0,
        stackCode: 0,
        // Inner entries that left held at their start, nothing run (`heldOnEntry`).
        heldEntries: 0,
        // Batches the store answered in the call that formed them, and a turn later.
        lookedUpNow: 0, lookedUpLater: 0, lookedUpInPart: 0,
        // Asks of a store that answers a turn later for records not yet formed (`askBefore`).
        askedBefore: 0,
        // Calls that formed part of a batch and left the rest to a later one
        // (`holdMs`), that published part of a batch's store hits, and asks
        // the spent credit put off; the hits' modules compiled off this thread.
        formedInPart: 0, publishedInPart: 0, heldBack: 0, compiledApart: 0, answeredFirst: 0,
        // Calls that found a batch whole and every translator busy (`holdMs`).
        formedWaiting: 0,
        shapeMisses: 0, shapeChecked: 0, x87RelaxedReads: 0, floatMisses: 0, floatsRounded: 0,
        windowsOwn: 0,
        // Stores into pages of code the runtime was told of (`storedInto`).
        codeStores: 0,
        // The milliseconds of translating, by the part of a batch they are:
        // `translateMs` is their sum, so a frame's own figure and the split
        // always agree.
        relinks: 0, relinked: 0, merges: 0, merged: 0, reforms: 0, copied: 0,
        // Modules let go past `cacheBytes`, their regions, and the regions of
        // them published again; the crossings counted by modules no longer placed.
        evictions: 0, evictedRegions: 0, broughtBack: 0, crossingsGone: 0,
        chargeRefused: 0, unchargedBytes: 0,
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
        // With `timings`: the worker's busy time by part - emitting, encoding,
        // compiling its modules, and hashing and packing them for the store.
        workerEmitMs: 0, workerEncodeMs: 0, workerCompileMs: 0, workerPackMs: 0,
    };
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
    /** @type {Record<ExitKind, number>} */
    const exits = { untranslated: 0, budget: 0, trap: 0, halt: 0, fault: 0, stale: 0,
        interpreted: 0 };
    // The untranslated exits by what left: a bare one (nothing at the target
    // in the region), or one a region made to the host on purpose -- a window
    // its accesses would fault on or a store into code (HELD), the x87
    // precision it was not formed for (PRECISION), a stack shape it was not
    // checked for (SHAPE). One count read alone mixes them, and the held ones
    // land on addresses that are translated, which reads as a link not made.
    const untranslatedBy = { bare: 0, held: 0, precision: 0, shape: 0, range: 0, made: 0,
        other: 0 };
    /** @type {Record<string, number>} */
    const refused = {};
    /** @type {Record<string, number>} why an instruction was left out, with its block */
    const refusedWhy = {};
    /** By opcode, translated instructions that read a flag the fast default left undefined.
     * @type {Record<string, number>} */
    const relaxedFlagReads = {};
    // Turns the host retired nothing in and forced one interpreted
    // instruction through, so a slice always moves (the progress guarantee).
    let forcedSteps = 0;
    /** Forced steps by address, for the first `FORCED_KEPT` addresses met.
     * @type {Map<number, { count: number, top: number, why: string, registers: string }>} */
    const forcedAt = new Map();
    // The counter word folded the way the layer folds it: exact as long as
    // reads come less than 2^32 instructions apart.
    let counted = 0;
    let lastWord = 0;
    const fold = ()=>{
        const word = counterWord();
        counted += (word - lastWord) >>> 0;
        lastWord = word;
    };
    lastWord = counterWord();

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
        if (codePages.get(address >>> 12) & PageFlag.VOLATILE)
        {
            return 'volatile';
        }
        if (!rt.translatable(address))
        {
            return 'inaccessible';
        }
        const barren = rt.barrenAt(address);
        if (barren !== null)
        {
            return `barren (${barren})`;
        }
        for (const eip of rt.queue.values())
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
                const tops = rt.exitTargets.get(address)?.tops ?? 0;
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
        const holders = rt.closedIn.get(address);
        if (holders !== undefined)
        {
            return [...holders].every(record=>record.copies === true) ? 'closed, copied' : 'closed';
        }
        return 'unknown';
    };

    /** The last `hotForms` answer and when it was taken. @type {{ at: number, forms: any } | null} */
    let formsTaken = null;

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
        for (const record of rt.regions)
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
            jobs.push({ region: formRegion(read, record.entry, { ...formHere,
                translatable: rt.formableFrom(record.entry), ...called }),
            entryTop: record.entryTop, checked: record.checked === true,
            copies: record.copies === true, ...rt.precisionJob(record) });
        }
        const forms = { ...profileForms(jobs.map(job=>job.region), executions,
            note=>emitBatch(jobs, emitLayout, found, { ...rt.emitOptions(), blockProfile: false,
                countTransfers: false, timings: false, expansion: note })),
        held: total > 0 ? held / total : 0 };
        formsTaken = { at: now, forms };
        return forms;
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

    /** Instructions interpreted from `at` on (`interpretedFrom`), with `timings`.
     * @param {number} at @param {number} instructions */
    const interpretedAt = (at, instructions)=>{
        if (settings.timings !== true || instructions === 0)
        {
            return;
        }
        const now = Math.round(performance.now() - rt.bornAt);
        const one = interpretedFrom.get(at);
        if (one !== undefined)
        {
            one.count += instructions;
            one.last = now;
        }
        else if (interpretedFrom.size < rt.EXIT_TARGETS_CAP)
        {
            interpretedFrom.set(at, { count: instructions, first: now, last: now });
        }
    };
    /** One turn the host forced an interpreted instruction through, for
     * the progress guarantee's diagnostics: where, at what x87 top, and why,
     * kept for the busiest addresses (`forcedAt`), with the registers the first one
     * met there before the step, and the flags of the page each points at: with the
     * instruction they say which window a region found closed (a `held` leave).
     * @param {number} [at] @param {number} [top] @param {string} [why]
     * @param {() => number[]} [registers] */
    const forcedStep = (at, top, why, registers)=>{
        forcedSteps++;
        if (at !== undefined && (forcedAt.size < FORCED_KEPT || forcedAt.has(at)))
        {
            const values = forcedAt.has(at) ? [] : registers?.() ?? [];
            // The region the entry is a block of, and the modes it was made in.
            const owner = forcedAt.has(at) ? undefined
                : rt.recordOf.get(entries.entryOf(at, (top ?? 0) & 7));
            const one = forcedAt.get(at) ?? { count: 0, top: top ?? -1, why: why ?? '',
                registers: values.map(value=>`${(value >>> 0).toString(16)}`
                    + `/${(pages.get(value >>> 12) ?? 0).toString(16)}`).join(' ')
                    + (owner === undefined ? '' : ` in 0x${owner.entry.toString(16)}`
                        + `@${owner.entryTop}${owner.loose ? ' loose' : ''}`
                        + `${owner.wrapped ? ' wrapped' : ''}${owner.checked ? ' checked' : ''}`
                        + ` ${owner.spans.length} blocks`) };
            one.count++;
            forcedAt.set(at, one);
        }
    };
    // The numbers a slice's counters want, and nothing that costs more
    // than reading them: the frame counters ask every slice, and the
    // whole snapshot below sorts the exit targets and names each one's
    // reason across the candidate queue -- a third of a loading phase's
    // engine time when it was asked that often.
    /** @type {Runtime['counters']} */
    const counters = ()=>{
        fold();
        return {
            regions: rt.regions.size,
            modules: counts.modules,
            invalidations: counts.invalidations,
            translatedShare: counted > 0 ? rt.corkRetired / counted : 0,
            retired: rt.corkRetired,
            // Whether the milliseconds below were measured (`timings`): 0 otherwise.
            timed: import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.timings === true,
            translateMs: counts.formingMs + counts.lookupMs + counts.emitMs
                + counts.encodeMs + counts.storeMs + counts.instantiateMs + counts.publishMs,
            exits,
        };
    };
    const diagnostics = ()=>{
        fold();
        const blocks = import.meta.BOTTLIFY_DIAGNOSTICS !== false && profiling
            ? blockCounts(view(), layout, rt.regions) : null;
        return {
            ...(import.meta.BOTTLIFY_DIAGNOSTICS !== false && blocks
                ? { blockCounts: blocks, topBlocks: topBlocks(blocks, rt.regions),
                    mechanisms: mechanismCounts(view(), layout), forms: hotForms(blocks),
                    transferTargets: transferTargets(view(), layout) }
                : {}),
            regions: rt.regions.size,
            crtFormed: { ...rt.crtFormed },
            // Counted only by a run that asked (`countTransfers`); absent otherwise,
            // where a 0 would read as none made.
            ...(transfersCounted
                ? { transfers: view().getUint32(layout.tables + Tables.TRANSFERS, true) }
                : {}),
            relinks: counts.relinks,
            relinked: counts.relinked,
            merges: counts.merges,
            // The regions those merges built again, of `relinked`.
            merged: counts.merged,
            reforms: counts.reforms,
            copied: counts.copied,
            // Transfers that left a placed module through the table, as it
            // counts them (running modules only).
            crossings: [...rt.placedLive].reduce((sum, placed)=>sum + placed.crossings.value, 0),
            // And all of them since the start, those of modules gone included.
            crossingsAll: counts.crossingsGone
                + [...rt.placedLive].reduce((sum, placed)=>sum + placed.crossings.value, 0),
            // The wasm bytes of the modules some running region's function is
            // in, and how many: what the translated code holds now, against
            // `moduleBytes`, all made in the run. Past `cacheBytes` the modules
            // gone longest without running were let go (`evictions`), their
            // regions brought back from the store when asked for again.
            heldBytes: rt.heldBytes,
            heldModules: rt.heldModules.size,
            cacheBytes: settings.cacheBytes,
            evictions: counts.evictions,
            evictedRegions: counts.evictedRegions,
            // Where the host bounds the modules (`charge`): the times it had no
            // room for one, and the bytes held past it where nothing was left
            // to let go.
            chargeRefused: counts.chargeRefused,
            unchargedBytes: counts.unchargedBytes,
            broughtBack: counts.broughtBack,
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
            workerEmitMs: counts.workerEmitMs,
            workerEncodeMs: counts.workerEncodeMs,
            workerCompileMs: counts.workerCompileMs,
            workerPackMs: counts.workerPackMs,
            inFlightMs: counts.inFlightMs,
            behindMs: counts.behindMs,
            queueMax: counts.queueMax,
            // Every module's bytes made in the run, relinks included -- not
            // what is held; `batchModulesHeld` is the stored batches' instances
            // still reachable.
            moduleBytes: counts.moduleBytes,
            modules: counts.modules,
            batchModulesHeld: rt.batchInstances.live(),
            translatedShare: counted > 0 ? rt.corkRetired / counted : 0,
            retired: rt.corkRetired,
            cacheHits: counts.cacheHits,
            cacheMisses: counts.cacheMisses,
            missNoRecord: counts.missNoRecord,
            missChanged: counts.missChanged,
            missBytes: counts.missBytes,
            missFormedOther: counts.missFormedOther,
            missModes: counts.missModes,
            missPrecision: counts.missPrecision,
            missFloats: counts.missFloats,
            hitsFormedAgain: counts.hitsFormedAgain,
            formedAsRecorded: counts.formedAsRecorded,
            takenUnformed: counts.takenUnformed,
            toStoredRegion: counts.toStoredRegion,
            missNoModule: counts.missNoModule,
            // Store hits whose batch module a runtime sharing the store had
            // compiled already, and what the shared modules hold.
            sharedModules: counts.sharedModules,
            sharedHeld: rt.sharedModules?.stats() ?? null,
            // Regions taken as a runtime sharing the store formed them, and
            // what the shared regions hold.
            formedShared: counts.formedShared,
            sharedForms: rt.sharedForms?.stats() ?? null,
            // What the store holds and what its opening kept, where it says.
            store: settings.store?.stats?.() ?? null,
            lookedUpNow: counts.lookedUpNow,
            lookedUpLater: counts.lookedUpLater,
            lookedUpInPart: counts.lookedUpInPart,
            askedBefore: counts.askedBefore,
            formedInPart: counts.formedInPart,
            // Forming or a lookup cut short for another executor's ask (`awaited`).
            answeredFirst: counts.answeredFirst,
            publishedInPart: counts.publishedInPart,
            heldBack: counts.heldBack,
            compiledApart: counts.compiledApart,
            formedWaiting: counts.formedWaiting,
            // Times an x87 entry moved to the other precision control or to a
            // test at every rounding instruction (`precisionAt`).
            precisionSwitches: counts.precisionSwitches,
            // Reads tested since the program's first fault on a page it
            // cannot reach (1), or not (0).
            readSwitches: counts.readSwitches,
            // Whether stores through esp go untested (`looseStacks`), and how
            // often code on a stack switched that off (once at most).
            looseStacks: rt.loose,
            stackCode: counts.stackCode,
            heldEntries: counts.heldEntries,
            // The x87 entries by the precision control they are compiled for.
            precision: rt.precisionCounts(),
            // Entries that found the x87 stack in another shape than their
            // block's, and the regions translated checked for it.
            shapeMisses: counts.shapeMisses,
            shapeChecked: counts.shapeChecked,
            // Single-precision operations on floats that left for the host because
            // the float result was not the processor's, and the regions that kept
            // leaving and went back to rounding from doubles (`floatSingles`).
            floatMisses: counts.floatMisses,
            floatsRounded: counts.floatsRounded,
            // Regions translated again with each block testing its own windows after
            // they kept leaving held (`heldMissed`).
            windowsOwn: counts.windowsOwn,
            // Translated x87 status-word reads that may see what `precise`
            // alone keeps: where a strange result is worth a run with it.
            x87RelaxedReads: counts.x87RelaxedReads,
            // With `checkStale`, the regions still published whose bytes no
            // longer form as they did: translated code a write did not drop.
            ...(settings.checkStale ? { staleRegions: [...rt.regions]
                .filter(record=>formRegion(read, record.entry, { ...formHere,
                    translatable: rt.formableFrom(record.entry),
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
            queued: rt.queue.size,
            barren: rt.barren.size,
            queueDrops: counts.queueDrops,
            emitFailures: counts.emitFailures,
            formedApart: counts.formedApart,
            queueEvictions: counts.queueEvictions,
            // Times a page was left to the other executor, and the pages left now.
            volatilePages: counts.volatilePages,
            volatileNow: rt.volatileUntil.size,
            // Pages of stubs: regions from elsewhere stop at them (`STUB_WRITES`).
            stubPages: [...rt.dropped.values()].filter(one=>one.costs >= rt.STUB_WRITES).length,
            storesKept: counts.storesKept,
            // Pages whose bytes are kept to judge a store into none of their
            // regions by: pages code was on when the store came.
            codePageCopies: rt.pageBytes.size,
            prediction: { due: counts.predictDue, noShare: counts.predictNoShare,
                reformsOut: counts.predictReformsOut, notFormed: counts.predictNotFormed,
                noRegion: counts.predictNoRegion, held: counts.predictHeld,
                quiet: counts.predictQuiet,
                // The most callees one call has formed in, among the regions published.
                callees: Math.max(0, ...[...rt.regions].flatMap(record=>
                    (record.targets ?? []).map(([site, callees])=>callees.filter(callee=>
                        record.unformed?.get(site)?.includes(callee) !== true).length))),
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
            exitsByTarget: [...rt.exitTargets].sort((a, b)=>b[1].count - a[1].count).slice(0, 32)
                .map(([address, { count, held, first, last, way }])=>({ address, count, held,
                    first, last, way, reason: held === count ? 'held' : missReason(address) })),
            // The entries that met another x87 stack than theirs, busiest first:
            // `unowned` ones are counted against no region and stay interpreted.
            shapeMissesByTarget: [...rt.shapeTargets].sort((a, b)=>b[1].count - a[1].count)
                .slice(0, 32).map(([address, one])=>({ address, ...one })),
            refused: { ...refused },
            refusedWhy: { ...refusedWhy },
            // Where a program reads what `precise: false` leaves: a title that
            // misbehaves only without `precise` is looked for here first.
            relaxedFlagReads: { ...relaxedFlagReads },
            forcedSteps,
            // Where the interpreted instructions went, busiest first.
            // and why no translation took each start over: the tops it has
            // entries at (a bit each), a formed region not yet published that
            // will cover it (`coveredOut`, the regions holding it), a loop it
            // is closed in, and the miss's reason.
            interpretedFrom: [...interpretedFrom].sort((a, b)=>b[1].count - a[1].count)
                .slice(0, 24).map(([address, one])=>{
                    let tops = 0;
                    for (let top = 0; top < 8; top++)
                    {
                        tops |= entries.entryOf(address, top) >= 0 ? 1 << top : 0;
                    }
                    let pending = rt.coveredOut.get(keyOf(address, ANY_TOP)) ?? 0;
                    for (let top = 0; top < 8; top++)
                    {
                        pending += rt.coveredOut.get(keyOf(address, top)) ?? 0;
                    }
                    return { address, ...one, tops, coveredOut: pending,
                        closed: rt.closedIn.has(address), why: missReason(address) };
                }),
            // The addresses most forced, busiest first, as "0x401000 x5000 top 3 why".
            forcedAt: [...forcedAt].sort((a, b)=>b[1].count - a[1].count).slice(0, 10)
                .map(([at, one])=>`0x${at.toString(16)} x${one.count}`
                    + ` top ${one.top} ${one.why}`
                    + (one.registers ? ` [${one.registers}]` : '')),
            worker: /** @type {'ready' | 'loading' | 'none'} */ (rt.translatorReady() ? 'ready'
                : rt.translatorLoading() ? 'loading' : 'none'),
            translators: rt.translators.length,
            translatorsReady: rt.translators.filter(one=>one.ready).length,
            ...(rt.arena === null ? {} : { arena: openArena(rt.arena).counts() }),
            batchesOut: rt.translators.filter(one=>one.pending !== null).length,
        };
    };
    return {
        logOf,
        CALL_SITES_CAP,
        counts,
        noteStall,
        exits,
        untranslatedBy,
        refused,
        refusedWhy,
        relaxedFlagReads,
        storeTrace,
        trace,
        interpretedAt,
        forcedStep,
        counters,
        diagnostics,
    };
}
