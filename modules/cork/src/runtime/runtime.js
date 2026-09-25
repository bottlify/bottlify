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
 * them in between, so a batch never publishes code for bytes that changed
 * while it was being compiled.
 */

import { formRegion } from '../region.js';
import { enterRegion, mathImports } from '../emit/region.js';
import { decode } from '../decode/decoder.js';
import { SHAPE, isX87, trackRegion } from '../emit/x87.js';
import { PRECISION } from '../emit/memory.js';
import { features as probeFeatures } from '../wasm/features.js';
import { emitBatch, relinkBatch } from './emit-built.js';
import { buildHelpersModule } from '../emit/helpers.js';
import { openTranslationWorker } from './translator.js';
import { ANY_TOP, createEntries } from './entries.js';
import { PageFlag, createPageTable } from './pages.js';
import { Tables } from './layout.js';
import { CACHE_VERSION, cacheKey, moduleKey, packRegion, unpackRegion } from './cache.js';

/** @typedef {import('../../../core/src/layers/cpu/engine.js').EngineEnv} EngineEnv */
/** @typedef {import('../../../core/src/layers/cpu/engine.js').Runtime} Runtime */
/** @typedef {import('../../../core/src/layers/cpu/engine.js').ExitKind} ExitKind */

/** @param {import('../region.js').Region} region */
const usesX87 = region=>region.blocks.some(block=>block.instructions.some(isX87));

/** Exit codes by number, as the region functions answer them. */
const KINDS = /** @type {ExitKind[]} */ (
    ['untranslated', 'budget', 'trap', 'halt', 'fault', 'stale']);

/**
 * @param {EngineEnv & { features?: ReturnType<typeof probeFeatures> }} env
 * @returns {Runtime & { pages: import('./pages.js').PageTable }}
 */
export function createCorkRuntime({ memory, layout, config = {}, read, imports, features }){
    const settings = {
        hotThreshold: 2000, maxRegionBlocks: 128, maxRegionBytes: 8192, batchRegions: 32,
        maxQueued: 8192, maxBatchRegions: 256,
        // Invalidations of one page before it is left to the other executor.
        volatileAfter: 8,
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
        // x87 regions compiled for the wide precision controls (double,
        // extended) until the program is seen with single set: a block tests
        // precision control once rather than every operation rounding by it
        // (false: the test on every operation from the start).
        wideFirst: true,
        // x87 regions compiled for the stack's shape at their entries -- which
        // registers are held and which empty -- tested once at an entry rather
        // than at every instruction; a region whose test fails `checkedAfter`
        // times is translated again with no test and the checks inside
        // (false: every region so from the start).
        x87Shapes: true,
        checkedAfter: 4,
        // A region's loops as wasm loops and its flags' liveness over its
        // blocks. Off by default: in Doom 3's menu it doubled the guest's time
        // a frame (5.9 -> 10.1 ms) while it made play 3% faster, and the cause
        // is not yet known.
        structure: false,
        // Diagnostic: the host clock read around the translator's phases -- the
        // milliseconds of forming, lookups, emitting, encoding, storing,
        // instantiating and publishing, and the record of long holds. Off, as a
        // shipped build runs, the clock is read only where the translator needs
        // it (a batch that never comes back is freed after a time).
        timings: false,
        ...config,
    };
    /** The host clock for a diagnostic timing, or zero when timings are off. */
    const clock = settings.timings === true ? ()=>performance.now() : ()=>0;
    /** Whether new x87 regions are compiled for the wide precision controls. */
    let wide = settings.wideFirst === true;
    /** How a region is formed, the same on this thread, in a batch and in a relink. */
    const formOptions = { maxBlocks: settings.maxRegionBlocks,
        maxBytes: settings.maxRegionBytes, leafCalls: settings.leafCalls };
    /** @type {Set<string>} instruction classes left to the other executor */
    const leaveOut = new Set(settings.leaveOut ?? []);
    if (layout.tables + Tables.SIZE > memory.buffer.byteLength)
    {
        throw new Error(`cork: the memory ends at ${memory.buffer.byteLength}, before the tables`
            + ` at ${layout.tables} + ${Tables.SIZE}`);
    }
    const found = features ?? probeFeatures();
    const pages = createPageTable(memory, layout);
    // The five helper functions every region imports, defined once here and
    // instantiated over this memory when the first region is published.
    /** @type {any} */
    let helperInstance = null;
    const helperImports = ()=>{
        if (helperInstance === null)
        {
            const module = new WebAssembly.Module(
                /** @type {Uint8Array<ArrayBuffer>} */ (buildHelpersModule(layout)));
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
    /** @type {number[]} table indices of dropped regions */
    const freeTable = [];
    const entries = createEntries(
        table
            ? { memory, hashBase: layout.tables + Tables.HASH, shift: layout.hashShift ?? 16 }
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
    /** @type {Map<number, { count: number, tops: number }>} */
    const exitTargets = new Map();
    const EXIT_TARGETS_CAP = 4096;
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
    const MISSES_CAP = 4096;
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
     * @property {number[]} slots   entry indices
     * @property {number} table     the function's index in the table, or -1
     * @property {[number, number][]} spans   the blocks' [start, end)
     * @property {number} entryTop  the x87 top it was formed for
     * @property {string} hash      of its bytes, which a relink forms it from again
     * @property {string} labels    its block starts and labels, which a relinked function
     *     must keep for the entries to stand
     * @property {boolean} [linked]  its function is in a relinked module already
     * @property {boolean} [wide]  an x87 region compiled for the wide precision controls
     * @property {boolean} [checked]  an x87 region whose entries test nothing of the stack's shape
     * @property {number} [shapeMisses]  its entries' tests that failed
     */
    /** @type {Set<RegionRecord>} */
    const regions = new Set();
    /** @type {Map<number, RegionRecord>} entry index → the region that made it */
    const recordOf = new Map();
    /** key(entry, top) of the x87 regions whose shape test kept failing: formed checked. */
    const checkedKeys = new Set();
    /** @type {Map<number, Set<RegionRecord>>} page → regions on it */
    const byPage = new Map();
    /** @type {Map<number, number>} page → times invalidated, the stamp a batch checks */
    const generation = new Map();
    /** @type {Map<number, number>} page → times a write dropped its regions */
    const dropped = new Map();
    const counts = {
        modules: 0, invalidations: 0, volatilePages: 0, dropped: 0, moduleBytes: 0,
        queueDrops: 0, queueEvictions: 0,
        cacheHits: 0, cacheMisses: 0, missNoRecord: 0, missNoModule: 0, precisionSwitches: 0,
        shapeMisses: 0, shapeChecked: 0,
        // The milliseconds of translating, by the part of a batch they are:
        // `translateMs` is their sum, so a frame's own figure and the split
        // always agree.
        relinks: 0, relinked: 0,
        formingMs: 0, lookupMs: 0, emitMs: 0, encodeMs: 0, storeMs: 0, instantiateMs: 0,
        publishMs: 0,
        // Emitting and encoding the worker did: reported apart from
        // `translateMs`, which is the engine thread's own, so the two threads'
        // costs stay legible.
        workerMs: 0,
    };
    /**
     * The engine thread's long holds, host milliseconds: what a guest thread
     * waiting on a timer (a sound mixer) sat through. The last 64 over 5 ms.
     * @type {{ at: number, ms: number, what: string }[]}
     */
    const stalls = [];
    /** @param {string} what @param {number} since @param {number} [floorMs] */
    const noteStall = (what, since, floorMs = 5)=>{
        if (settings.timings !== true)
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
    let nextTable = 0;
    /** @type {Record<ExitKind, number>} */
    const exits = { untranslated: 0, budget: 0, trap: 0, halt: 0, fault: 0, stale: 0 };
    /** @type {import('../../../core/src/layers/cpu/engine.js').ExitRecord} */
    const exit = { retired: 0, kind: 'untranslated', vector: 0 };
    /** @type {Record<string, number>} */
    const refused = {};
    /** @type {Record<string, number>} why an instruction was left out, with its block */
    const refusedWhy = {};
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
                freeTable.push(record.table);
            }
            for (const p of record.pages)
            {
                byPage.get(p)?.delete(record);
            }
            regions.delete(record);
        }
        for (const p of touched)
        {
            const left = byPage.get(p);
            pages.clearCode(p);
            if (!left?.size)
            {
                imports.handoffPage?.(p, false);
                continue;
            }
            // The page's range from the regions still on it.
            for (const record of left)
            {
                for (const [start, end] of record.spans)
                {
                    if ((start >>> 12) <= p && ((end - 1) >>> 12) >= p)
                    {
                        pages.markCode(start, end - start);
                    }
                }
            }
        }
    };

    /** @param {number} page */
    const invalidatePage = page=>{
        const on = byPage.get(page);
        const cost = on ? on.size : 0;
        if (on)
        {
            unpublish([...on]);
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
        }
        generation.set(page, (generation.get(page) ?? 0) + 1);
        // Only a write that cost a region counts towards volatility: the
        // loader placing an image writes a page many times before anything
        // on it is hot, and that is not a page that mixes code with data.
        if (cost === 0)
        {
            return;
        }
        const times = (dropped.get(page) ?? 0) + 1;
        dropped.set(page, times);
        if (times === settings.volatileAfter)
        {
            pages.set(page, PageFlag.VOLATILE);
            counts.volatilePages++;
        }
    };

    /**
     * Single precision seen: x87 regions are compiled with the rounding from
     * now on, and the wide ones go -- each would only leave at its first
     * rounding block. Once: a program that sets single keeps it, as Direct3D
     * does from CreateDevice on.
     */
    const precisionSeen = ()=>{
        if (!wide)
        {
            return;
        }
        wide = false;
        counts.precisionSwitches++;
        const on = new Set([...regions].filter(record=>record.wide)
            .flatMap(record=>[...record.pages]));
        for (const page of on)
        {
            invalidatePage(page);
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
        & (PageFlag.VOLATILE | PageFlag.INACCESSIBLE)) === 0;

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
    const workerUrl = workerWanted
        ? (settings.workerUrl ?? (()=>{
            try
            {
                return new URL('./translator.worker.js', import.meta.url).href;
            }
            catch {
                return null;
            }
        })())
        : null;
    /** @type {{ post: (message: any, transfer: any[]) => void,
     *     terminate: () => void } | null} */
    let worker = null;
    let workerClosed = false;
    /** @type {{ id: number, metas?: any[], relink?: RegionRecord[], store: any } | null} */
    let outstanding = null;
    // A batch's store lookups are in flight: its bytes come back between
    // frames, and until then no new batch is formed, so the batches publish in
    // order and the waiting is never the slice's.
    let storePending = false;
    let workerRequest = 0;

    // The block profile is past cork's own tables, in a memory sized for it;
    // the hybrid layout's tables are carved from the emulator's RAM.
    const profiling = settings.blockProfile === true && (layout.codePages ?? -1) < 0;
    /**
     * Every counted block as [address, executions, shared, region entry], by the
     * slot table: the entry of a region the block is in (-1 when none is), so a
     * profile of the regions' functions divides by the instructions they ran.
     */
    const blockCounts = ()=>{
        const data = view();
        const base = layout.tables + Tables.BLOCK_PROFILE;
        /** @type {Map<number, number>} */
        const regionOf = new Map();
        for (const record of regions)
        {
            for (const [start] of record.spans)
            {
                if (!regionOf.has(start))
                {
                    regionOf.set(start, record.entry);
                }
            }
        }
        /** @type {[number, number, number, number][]} */
        const out = [];
        for (let slot = 0; slot < Tables.BLOCK_SLOTS; slot++)
        {
            const at = base + slot * Tables.BLOCK_SLOT;
            const count = data.getUint32(at + 4, true);
            if (count > 0)
            {
                const address = data.getUint32(at, true);
                out.push([address, count, data.getUint32(at + 8, true),
                    regionOf.get(address) ?? -1]);
            }
        }
        return out.sort((one, two)=>two[1] - one[1]);
    };
    let profileResetAt = profiling && settings.blockProfileFrom > 0
        ? performance.now() + settings.blockProfileFrom * 1000 : null;
    const resetBlockCounts = ()=>{
        const data = view();
        const base = layout.tables + Tables.BLOCK_PROFILE;
        for (let slot = 0; slot < Tables.BLOCK_SLOTS; slot++)
        {
            data.setUint32(base + slot * Tables.BLOCK_SLOT + 4, 0, true);
        }
    };
    /** The forty most executed, with the region each is in. @param {[number, number, number, number][]} blocks */
    const topBlocks = blocks=>blocks.slice(0, 40).map(([address, count, shared])=>{
        let entry = -1;
        let size = 0;
        for (const record of regions)
        {
            const span = record.spans.find(([start])=>start === address);
            if (span)
            {
                entry = record.entry;
                size = span[1] - span[0];
                break;
            }
        }
        return { address, count, shared: shared !== 0, entry, bytes: size };
    });

    /** The options both the inline emitter and the worker's take. */
    const emitOptions = ()=>({
        undoLog: settings.undoLog,
        countTransfers: settings.countTransfers,
        blockProfile: profiling,
        hash: table !== null,
        wide,
        structure: settings.structure,
        leaveOut,
        timings: settings.timings === true,
        ...(settings.trapPort === undefined ? {} : { trapPort: settings.trapPort }),
    });

    /** Folds what the emitter left out into the run's refusal maps.
     * @param {{ unsupported?: [string, number][], refusals?: [string, number][] }} built */
    const foldTranslation = built=>{
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

    /** Instances of the batch modules this run has, by their store key, so a
     * stored region finds its batch's module already instantiated.
     * ponytail: kept for the run; a batch whose regions are all dropped stays
     * until the machine goes -- an eviction when a title's churn shows in memory.
     * @type {Map<string, WebAssembly.Instance>} */
    const batchInstances = new Map();
    /** Batch modules instantiated since the last relink began. */
    let modulesSinceRelink = 0;
    /** The running regions a relink still has to gather, or null between relinks.
     * @type {RegionRecord[] | null} */
    let relinkQueue = null;
    /** Candidates taken into a batch that has not published yet, by when: noted
     * again meanwhile they are not queued a second time (the interpreter keeps
     * meeting them while the batch is with the worker). A batch that never
     * comes back frees them after IN_FLIGHT_MS.
     * @type {Map<number, number>} */
    const inFlight = new Map();
    const IN_FLIGHT_MS = 10_000;

    /**
     * Stamps a built or stored region and publishes every block start as an
     * entry: its function out of the instance of the module that holds it.
     * The whole of the publish half of the old batch loop, so a worker's
     * answer and an inline emission take the same path.
     *
     * @param {{ region: import('../region.js').Region, entryTop: number, stamp: string,
     *     wide?: boolean, checked?: boolean }} one
     * @param {{ labels: [number, number][], cut: number[], entryTop: number,
     *     exportName?: string, linked?: boolean }} built
     * @param {WebAssembly.Instance} instance
     * @returns {number} 1 when a region was published, 0 when it was dropped
     */
    const applyBuilt = (one, built, instance)=>{
        const { region } = one;
        inFlight.delete(keyOf(region.entry, one.entryTop));
        const eip = region.entry;
        const publishAt = clock();
        // A wide x87 region built before single precision was seen would
        // only leave at once: its bytes are translated again with the rounding.
        // So would one built to test the stack's shape once its test had failed.
        if (one.stamp !== stamp(region.pages) || (one.wide && !wide)
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
        // Entries for every block start but the cut ones; a region with x87
        // in it is keyed by the top it was compiled for.
        const top = cut.size > 0 || usesX87(region) ? built.entryTop : ANY_TOP;
        const starts = built.labels.filter(([, label])=>!cut.has(label));
        if (starts.length === 0)
        {
            // Every block leaves at once (an instruction the other executor's
            // first): nothing to enter, nothing to keep.
            counts.publishMs += clock() - publishAt;
            barrenAdd(eip, top);
            return 0;
        }
        /** @type {RegionRecord} */
        const record = {
            entry: region.entry, pages: region.pages, slots: [], table: -1,
            spans: region.blocks.map(block=>[block.start, block.end]),
            entryTop: one.entryTop, hash: region.hash, labels: JSON.stringify(built.labels),
            linked: built.linked === true, wide: one.wide === true,
            checked: one.checked === true,
        };
        if (table)
        {
            let index = freeTable.pop();
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
        }
        for (const [start, label] of starts)
        {
            // An address another region's entry already holds stays that
            // region's: the record keeps only the entries it made, or a relink
            // of it would put its function under the other's label (and a drop
            // of it would take the other's entry away).
            const slot = entries.add(start, fn, label, top, record.table);
            if (entries.at(slot).fn === fn)
            {
                record.slots.push(slot);
                recordOf.set(slot, record);
            }
        }
        // A cut block start has no entry here: an address the runtime must
        // answer for with a region of its own at the machine's top, so a miss
        // there is a candidate, not an unknown address.
        for (const [start, label] of built.labels)
        {
            if (cut.has(label))
            {
                entries.noteStart(start);
            }
        }
        for (const block of region.blocks)
        {
            pages.markCode(block.start, block.end - block.start);
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
        }
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
        if (settings.traceStore)
        {
            const spans = one.region.blocks
                ?.map(block=>`${block.start.toString(16)}-${block.end.toString(16)}`);
            list.push(`${one.region.entry.toString(16)}:${one.region.hash}:${one.entryTop}`
                + (spans ? `:${spans.join(',')}` : ''));
        }
    };
    /** The store key of one formed region: an x87 region compiled for the wide
     * precision controls, or checked, is another translation of the same bytes.
     * @param {{ region: { entry: number, hash: string }, entryTop: number, wide?: boolean,
     *     checked?: boolean }} one */
    const regionKey = one=>cacheKey({
        version: CACHE_VERSION, features: found, layoutId: layout.id,
        bundleId: settings.bundleId ?? 'unknown', entry: one.region.entry,
        hash: `${one.region.hash}-${one.entryTop}${one.wide ? '-w' : ''}${one.checked ? '-c' : ''}`,
    });

    /**
     * An emitted batch: its module instantiated once, kept under its own key
     * with a record per region naming it, and every region published from it.
     *
     * @param {any[]} metas  the formed regions, in the batch's order
     * @param {import('./emit-built.js').BuiltBatch} batch
     * @param {WebAssembly.Module | null} compiled  the module, when the worker compiled it
     * @param {any} store
     * @returns {number} regions published
     */
    const publishBatch = (metas, batch, compiled, store)=>{
        const built = batch.results.filter(result=>result.ok);
        for (let i = 0; i < metas.length; i++)
        {
            const result = batch.results[i];
            if (!result.ok)
            {
                refused[`emit at ${metas[i].region.entry.toString(16)}: ${result.message}`] = 1;
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
            key = moduleKey({ version: CACHE_VERSION, features: found, layoutId: layout.id,
                bundleId: settings.bundleId ?? 'unknown' }, batch.module);
            store.put(key, packRegion({ module: batch.module, labels: [], cut: [], entryTop: 0,
                instructions: 0 })).catch(()=>{});
            if (instance !== null)
            {
                batchInstances.set(key, instance);
            }
            counts.storeMs += clock() - storeAt;
        }
        let published = 0;
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
                    module: new Uint8Array(0), moduleKey: key })).catch(()=>{});
                counts.storeMs += clock() - storeAt;
            }
            if (instance !== null)
            {
                published += applyBuilt(metas[i], result.region, instance);
            }
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
            key = moduleKey({ version: CACHE_VERSION, features: found, layoutId: layout.id,
                bundleId: settings.bundleId ?? 'unknown' }, batch.module);
            store.put(key, packRegion({ module: batch.module, labels: [], cut: [], entryTop: 0,
                instructions: 0 })).catch(()=>{});
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
            if (table && record.table >= 0)
            {
                table.set(record.table, fn);
            }
            for (const slot of record.slots)
            {
                entries.at(slot).fn = fn;
            }
            record.linked = true;
            counts.relinked++;
            if (store !== null)
            {
                const one = { region: { entry: record.entry, hash: record.hash },
                    entryTop: record.entryTop, wide: record.wide, checked: record.checked };
                store.put(regionKey(one), packRegion({ ...result.region,
                    module: new Uint8Array(0), moduleKey: key, linked: true })).catch(()=>{});
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
                    copies.set(page, new Uint8Array(memory.buffer.slice(at, at + 4096)));
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
        if (chunk.length === 0)
        {
            return false;
        }
        const copies = copyPages(chunk.map(record=>record.pages));
        const relink = {
            jobs: chunk.map(record=>({ entry: record.entry, entryTop: record.entryTop,
                hash: record.hash, checked: record.checked === true })),
            pages: [...copies],
            form: formOptions,
        };
        if (worker !== null)
        {
            outstanding = { id: ++workerRequest, relink: chunk, store };
            worker.post({ id: outstanding.id, relink, layout, features: found,
                options: emitOptions() }, [...copies.values()].map(bytes=>bytes.buffer));
            return true;
        }
        const batch = relinkBatch(relink, layout, found, emitOptions());
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
     * @param {{ id: number, batch: import('./emit-built.js').BuiltBatch | null,
     *     compiled?: WebAssembly.Module | null, message?: string }} data
     */
    const onWorkerResults = data=>{
        const pending = outstanding;
        if (pending === null || data?.id !== pending.id)
        {
            return;
        }
        outstanding = null;
        if (!data.batch)
        {
            refused[`emit: ${data.message ?? 'the worker failed'}`] = 1;
            return;
        }
        counts.workerMs += data.batch.emitMs + data.batch.encodeMs;
        const publishedAt = clock();
        if (pending.relink)
        {
            applyRelink(pending.relink, data.batch, data.compiled ?? null, pending.store);
        }
        else
        {
            publishBatch(pending.metas ?? [], data.batch, data.compiled ?? null, pending.store);
        }
        noteStall(pending.relink ? 'relink' : 'publish', publishedAt);
    };

    if (workerUrl !== null)
    {
        openTranslationWorker(workerUrl).then(adapter=>{
            if (adapter === null || workerClosed)
            {
                adapter?.terminate();
                return;
            }
            adapter.onMessage(onWorkerResults);
            worker = adapter;
        }, ()=>{});
    }

    /**
     * The publish half of a batch, when its store lookups are back (or at
     * once, without a store): the regions the store held are instantiated and
     * published, and the rest are emitted -- on the worker if there is one,
     * inline otherwise -- stored and published. Runs off the slice that
     * requested the batch, so a region whose bytes are not back is not
     * published this frame.
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
            let instance = key === undefined ? undefined : batchInstances.get(key);
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
        const unbuilt = formed.filter(one=>one.cached === null);
        // Built as the precision mode and the shape tests now say, whatever
        // they said when formed.
        for (const one of unbuilt)
        {
            one.wide = one.wide === true && wide;
            one.checked = checkedAt(one.region, one.entryTop);
        }
        if (unbuilt.length > 0 && worker !== null)
        {
            // Off the frame thread: post the batch and answer with it later.
            // The records are kept until then; nothing here waits.
            // The worker forms the regions again from a copy of their pages, as
            // a relink does, and keeps each one only when its bytes hash as they
            // did here.
            outstanding = { id: ++workerRequest, metas: unbuilt, store };
            const copies = copyPages(unbuilt.map(one=>one.region.pages));
            worker.post({
                id: outstanding.id,
                relink: {
                    jobs: unbuilt.map(one=>({ entry: one.region.entry, entryTop: one.entryTop,
                        hash: one.region.hash, checked: one.checked })),
                    pages: [...copies],
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
                checked: one.checked }));
            const batch = emitBatch(jobs, layout, found, emitOptions());
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

    return {
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
            if (profileResetAt !== null && performance.now() >= profileResetAt)
            {
                profileResetAt = null;
                resetBlockCounts();
            }
            // One record, rewritten per run: a call-heavy program leaves
            // and re-enters per call, and an object per leave was the
            // collector's share of the cost.
            const before = counterWord();
            const code = enterRegion(fn, label, budget, view(), layout) >>> 0;
            const retired = (counterWord() - before) >>> 0;
            corkRetired += retired;
            const kind = KINDS[code & 0xff] ?? 'untranslated';
            exits[kind]++;
            if (kind === 'untranslated' && code >>> 8 === PRECISION)
            {
                precisionSeen();
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
                this.missAt(view().getUint32(layout.eip, true), view().getUint8(layout.x87Top));
            }
            if (kind === 'stale')
            {
                const address = pages.staleAddress();
                const size = pages.staleSize();
                invalidatePage(address >>> 12);
                if (((address + size - 1) >>> 12) !== (address >>> 12))
                {
                    invalidatePage((address + size - 1) >>> 12);
                }
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
         */
        missAt(address, top = 0){
            const at = top & 7;
            // One record a target, changed in place: a call into a page left
            // to the interpreter exits once a call, and a map read and write
            // for each of two counts was a tenth of the crossing.
            let target = exitTargets.get(address);
            if (target === undefined)
            {
                target = { count: 0, tops: 0 };
                exitTargets.set(address, target);
            }
            target.count++;
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
            const key = keyOf(address, at);
            const seen = (misses.get(key) ?? 0) + 1;
            if (seen >= settings.missThreshold)
            {
                misses.delete(key);
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
        noteHot(eip, top = 0, hotness = 0){
            if (!settings.translate)
            {
                return;
            }
            const key = keyOf(eip, top & 7);
            const since = inFlight.get(key);
            if (since !== undefined)
            {
                if (performance.now() - since < IN_FLIGHT_MS)
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
            if (entries.entryOf(eip, top & 7) >= 0 || barrenHas(eip, top & 7)
                || !translatable(eip))
            {
                return;
            }
            enqueue(key, eip, hotness);
        },
        /** Writes whatever the store keeps aside from its records, so the
         * names of this run's regions are on disk before the run ends and the
         * next run's index can find them. */
        async flush(){
            await settings.store?.flush?.();
            settings.store?.close?.();
            // The worker holds nothing the store needs; end it and drop any
            // batch it still owes.
            workerClosed = true;
            worker?.terminate();
            worker = null;
            outstanding = null;
        },

        /** @type {() => Promise<number>} */
        async translatePending(){
            // A batch is with the worker: its answer is published when it
            // comes back, so the engine never waits for it. Candidates
            // formed in the meantime stay queued for the next call. A
            // batch's store lookups are likewise in flight: the next batch
            // waits for them, so the pending ones publish in order.
            if (outstanding !== null || storePending)
            {
                return 0;
            }
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
            if (!buckets.slice(HOT_BUCKET).some(bucket=>bucket.size > 0) && relinkStep(keeps))
            {
                return 0;
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
            const wanted = Math.min(settings.maxBatchRegions,
                Math.max(settings.batchRegions, queue.size >> 2));
            const batch = hottest(wanted);
            const takenAt = performance.now();
            for (const [key] of batch)
            {
                unqueue(key);
                dropKey(key);
                inFlight.set(key, takenAt);
            }
            // A diagnostic run with classes left out, or with an undo log the
            // stored modules were built without, keeps no translations.
            const store = leaveOut.size > 0 || settings.undoLog || profiling
                ? null : (settings.store ?? null);
            /** @type {{ region: import('../region.js').Region, entryTop: number,
             *     stamp: string, cached: import('./cache.js').CachedRegion | null, wide?: boolean,
             *     checked?: boolean, moduleBytes?: Uint8Array | null }[]} */
            const formed = [];
            const formedAt = clock();
            // The block starts of the regions this batch formed with no x87 in
            // them, each an entry at any top once published: a candidate among
            // them is already translated by one (a loop's head and its cases
            // were all hot at once, and each formed the whole loop again). It
            // is noted again should its block get no entry after all.
            /** @type {Set<number>} */
            const covered = new Set();
            for (let i = 0; i < batch.length; i++)
            {
                const [key, eip] = batch[i];
                const entryTop = key % 16;
                if (covered.has(eip))
                {
                    inFlight.delete(key);
                    continue;
                }
                const region = formRegion(read, eip, { ...formOptions, translatable });
                // What the region calls directly lands in the same batch, so
                // the call and the return transfer without a miss -- each
                // callee at the top the call site has, which the tracker
                // knows wherever it reached the block: batching it at the
                // entry's top compiled a callee nobody calls for a region
                // whose own x87 moved the stack before the call.
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
                    if (batch.length < settings.batchRegions
                        && entries.entryOf(callee, top) < 0 && translatable(callee)
                        && !batch.some(([queued])=>queued === keyOf(callee, top)))
                    {
                        batch.push([keyOf(callee, top), callee]);
                        unqueue(keyOf(callee, top));
                        dropKey(keyOf(callee, top));
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
                    wide: wide && usesX87(region), checked: checkedAt(region, entryTop) });
                if (!usesX87(region))
                {
                    for (const block of region.blocks)
                    {
                        covered.add(block.start);
                    }
                }
            }
            counts.formingMs += clock() - formedAt;
            if (store === null)
            {
                return finishBatch(formed, null);
            }
            // The store's reads leave the slice path: the batch's records are
            // requested here and the slice goes on. The batch is published
            // when the bytes are back -- between frames, as instantiation
            // already is -- and a region not back is not published this frame.
            // `lookupMs` is the engine thread's own time to start them.
            const lookupAt = clock();
            storePending = true;
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
                        ? null : unpackRegion(bytes)?.module ?? null);
                    pending = /** @type {Promise<Uint8Array | null>} */ (store.get(key).then(unpack));
                    modules.set(key, pending);
                }
                return pending;
            };
            Promise.all(formed.map(async one=>{
                const key = regionKey(one);
                try
                {
                    const bytes = await store.get(key);
                    one.cached = bytes === null ? null : unpackRegion(bytes);
                    if (one.cached === null)
                    {
                        counts.missNoRecord++;
                    }
                    const batchKey = one.cached?.moduleKey;
                    if (batchKey !== undefined && !batchInstances.has(batchKey))
                    {
                        // Its batch's module, unless this run instantiated it
                        // already; a record whose module is gone is a miss.
                        one.moduleBytes = await moduleBytes(batchKey);
                        if (one.moduleBytes === null)
                        {
                            counts.missNoModule++;
                            one.cached = null;
                        }
                    }
                }
                catch {
                    one.cached = null;
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
            })).then(()=>{
                storePending = false;
                finishBatch(formed, store);
            }, ()=>{
                storePending = false;
                finishBatch(formed, store);
            });
            counts.lookupMs += clock() - lookupAt;
            return 0;
        },
        invalidatePage,
        noteStall,
        /** @param {number} page */
        holdsPage: page=>(pages.get(page) & PageFlag.HAS_CODE) !== 0,
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
            const blocks = profiling ? blockCounts() : null;
            return {
                ...(blocks ? { blockCounts: blocks, topBlocks: topBlocks(blocks) } : {}),
                regions: regions.size,
                // Counted only by a run that asked (`countTransfers`), else 0.
                transfers: view().getUint32(layout.tables + Tables.TRANSFERS, true),
                relinks: counts.relinks,
                relinked: counts.relinked,
                entries: table ? entries.hashed() : entries.count(),
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
                moduleBytes: counts.moduleBytes,
                modules: counts.modules,
                translatedShare: counted > 0 ? corkRetired / counted : 0,
                retired: corkRetired,
                cacheHits: counts.cacheHits,
                cacheMisses: counts.cacheMisses,
                missNoRecord: counts.missNoRecord,
                missNoModule: counts.missNoModule,
                // x87 regions compiled for the wide precision controls until this is 1.
                precisionSwitches: counts.precisionSwitches,
                wide,
                // Entries that found the x87 stack in another shape than their
                // block's, and the regions translated checked for it.
                shapeMisses: counts.shapeMisses,
                shapeChecked: counts.shapeChecked,
                stalls: [...stalls],
                ...(settings.traceStore ? { storeTrace } : {}),
                invalidations: counts.invalidations,
                dropped: counts.dropped,
                queued: queue.size,
                barren: barren.size,
                queueDrops: counts.queueDrops,
                queueEvictions: counts.queueEvictions,
                volatilePages: counts.volatilePages,
                exits: { ...exits },
                // The top untranslated-exit targets over the whole run, and
                // why each has no entry: what a loading phase leaves behind.
                exitsByTarget: [...exitTargets].sort((a, b)=>b[1].count - a[1].count).slice(0, 32)
                    .map(([address, { count }])=>({ address, count, reason: missReason(address) })),
                refused: { ...refused },
                refusedWhy: { ...refusedWhy },
                forcedSteps,
                handoffMisses: 0,
            };
        },
    };
}
