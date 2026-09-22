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
import { mathImports } from '../emit/region.js';
import { decode } from '../decode/decoder.js';
import { isX87, trackRegion } from '../emit/x87.js';
import { features as probeFeatures } from '../wasm/features.js';
import { emitBuilt } from './emit-built.js';
import { buildHelpersModule } from '../emit/helpers.js';
import { openTranslationWorker } from './translator.js';
import { ANY_TOP, createEntries } from './entries.js';
import { PageFlag, createPageTable } from './pages.js';
import { Tables } from './layout.js';
import { CACHE_VERSION, cacheKey, packRegion, unpackRegion } from './cache.js';

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
        hotThreshold: 2000, maxRegionBlocks: 64, maxRegionBytes: 8192, batchRegions: 32,
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
        ...config,
    };
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
        table ? { memory, hashBase: layout.tables + Tables.HASH } : {});
    if (table)
    {
        imports.handoffHash?.(layout.tables + Tables.HASH - layout.ramBase);
    }
    /** @type {Map<number, number>} candidates not yet formed: key(eip, top) → eip */
    const queue = new Map();
    /** @type {Set<number>} addresses a region formed nothing at, until their page moves */
    const barren = new Set();
    /** @type {Map<number, number>} untranslated exits by target address */
    const misses = new Map();
    // The untranslated exits by target address over the whole run, for the
    // diagnostics' histogram: the misses are forgotten when they become
    // candidates, but what the translator never reached is exactly what this
    // is read for. Bounded like `misses`; the coldest target makes room.
    const exitTargets = new Map();
    const EXIT_TARGETS_CAP = 4096;
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
        for (const [address, count] of misses)
        {
            if (count <= 1)
            {
                misses.delete(address);
            }
            else
            {
                misses.set(address, count >> 1);
            }
        }
    };
    /** @param {number} eip @param {number} top */
    const keyOf = (eip, top)=>eip * 16 + top;
    /**
     * @typedef {Object} RegionRecord
     * @property {number} entry
     * @property {Set<number>} pages
     * @property {number[]} slots   entry indices
     * @property {number} table     the function's index in the table, or -1
     * @property {[number, number][]} spans   the blocks' [start, end)
     */
    /** @type {Set<RegionRecord>} */
    const regions = new Set();
    /** @type {Map<number, Set<RegionRecord>>} page → regions on it */
    const byPage = new Map();
    /** @type {Map<number, number>} page → times invalidated, the stamp a batch checks */
    const generation = new Map();
    /** @type {Map<number, number>} page → times a write dropped its regions */
    const dropped = new Map();
    const counts = {
        modules: 0, invalidations: 0, volatilePages: 0, dropped: 0, moduleBytes: 0,
        cacheHits: 0, cacheMisses: 0,
        // The milliseconds of translating, by the part of a batch they are:
        // `translateMs` is their sum, so a frame's own figure and the split
        // always agree.
        formingMs: 0, lookupMs: 0, emitMs: 0, encodeMs: 0, storeMs: 0, instantiateMs: 0,
        publishMs: 0,
        // Emitting and encoding the worker did: reported apart from
        // `translateMs`, which is the engine thread's own, so the two threads'
        // costs stay legible.
        workerMs: 0,
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
    // The counter word folded the way the layer folds it: exact as long as
    // reads come less than 2^32 instructions apart.
    let counted = 0;
    let lastWord = 0;
    /** @type {DataView | null} */
    let cachedView = null;
    // One view, taken again only when the memory grew (which detaches the
    // buffer it was on): a view per region run was a fifth of a call's cost.
    const view = ()=>{
        if (cachedView === null || cachedView.buffer !== memory.buffer)
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

    /** @param {number} page */
    const invalidatePage = page=>{
        const on = byPage.get(page);
        const cost = on ? on.size : 0;
        if (on)
        {
            // The pages the dropped regions spanned, taken before the records
            // leave their sets.
            const touched = new Set([...on].flatMap(record=>[...record.pages]));
            for (const record of [...on])
            {
                for (const slot of record.slots)
                {
                    entries.remove(slot);
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
                counts.invalidations++;
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
        }
        for (const [key, eip] of [...queue])
        {
            if ((eip >>> 12) === page)
            {
                queue.delete(key);
            }
        }
        for (const eip of [...barren])
        {
            if ((eip >>> 12) === page)
            {
                barren.delete(eip);
            }
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
        if (barren.has(address))
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
                return 'other-top';
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
    /** @type {{ id: number, metas: any[], store: any } | null} */
    let outstanding = null;
    // A batch's store lookups are in flight: its bytes come back between
    // frames, and until then no new batch is formed, so the batches publish in
    // order and the waiting is never the slice's.
    let storePending = false;
    let workerRequest = 0;

    /** The options both the inline emitter and the worker's take. */
    const emitOptions = ()=>({
        undoLog: settings.undoLog,
        hash: table !== null,
        leaveOut,
        ...(settings.trapPort === undefined ? {} : { trapPort: settings.trapPort }),
    });

    /** Folds what the emitter left out into the run's refusal maps.
     * @param {import('./emit-built.js').BuiltRegion} built */
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
     * Instantiates a built or stored region, stamps it and publishes every
     * block start as an entry. The whole of the publish half of the old
     * batch loop, so a worker's answer and an inline emission take the same
     * path.
     *
     * @param {{ region: import('../region.js').Region, entryTop: number, stamp: string }} one
     * @param {import('./cache.js').CachedRegion} built
     * @returns {number} 1 when a region was published, 0 when it was dropped
     */
    const applyBuilt = (one, built)=>{
        const { region } = one;
        const eip = region.entry;
        counts.moduleBytes += built.module.length;
        const instantiateAt = performance.now();
        /** @type {WebAssembly.Instance} */
        let instance;
        try
        {
            const module = new WebAssembly.Module(
                /** @type {Uint8Array<ArrayBuffer>} */ (built.module));
            instance = new WebAssembly.Instance(module, {
                env: {
                    memory, getEflags: imports.getEflags, trap: imports.trap,
                    ...mathImports(), ...helperImports(), ...(table ? { table } : {}),
                },
            });
        }
        catch (e){
            // The region is refused: the program runs on as it did.
            counts.instantiateMs += performance.now() - instantiateAt;
            refused.batch = (refused.batch ?? 0) + 1;
            refused[`batch: ${String(e).slice(0, 120)}`] = 1;
            return 0;
        }
        counts.instantiateMs += performance.now() - instantiateAt;
        counts.modules++;
        const publishAt = performance.now();
        if (one.stamp !== stamp(region.pages))
        {
            // A page of it was written while the batch was built.
            counts.publishMs += performance.now() - publishAt;
            counts.dropped++;
            return 0;
        }
        const fn = /** @type {(label: number, budget: number) => number} */ (instance.exports.r0);
        const cut = new Set(built.cut);
        // Entries for every block start but the cut ones; a region with x87
        // in it is keyed by the top it was compiled for.
        const top = cut.size > 0 || usesX87(region) ? built.entryTop : ANY_TOP;
        const starts = built.labels.filter(([, label])=>!cut.has(label));
        if (starts.length === 0)
        {
            // Every block leaves at once (an instruction the other executor's
            // first): nothing to enter, nothing to keep.
            counts.publishMs += performance.now() - publishAt;
            barren.add(eip);
            return 0;
        }
        /** @type {RegionRecord} */
        const record = {
            entry: region.entry, pages: region.pages, slots: [], table: -1,
            spans: region.blocks.map(block=>[block.start, block.end]),
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
            record.slots.push(entries.add(start, fn, label, top, record.table));
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
        counts.publishMs += performance.now() - publishAt;
        return 1;
    };

    /**
     * A worker's answer: fold what it left out, keep the records, instantiate
     * and publish. Runs on the engine thread when the message arrives, which
     * is between the frames the host asked for.
     *
     * @param {{ id: number, results: { ok: boolean, built?: any, message?: string }[] }} data
     */
    const onWorkerResults = data=>{
        const batch = outstanding;
        if (batch === null || data?.id !== batch.id)
        {
            return;
        }
        outstanding = null;
        for (let i = 0; i < batch.metas.length; i++)
        {
            const one = batch.metas[i];
            const result = data.results?.[i];
            if (!result || result.ok !== true)
            {
                refused[`emit at ${one.region.entry.toString(16)}: `
                    + `${result?.message ?? 'the worker failed'}`] = 1;
                continue;
            }
            const built = result.built;
            counts.workerMs += (built.emitMs ?? 0) + (built.encodeMs ?? 0);
            foldTranslation(built);
            if (batch.store !== null)
            {
                const storeAt = performance.now();
                const key = cacheKey({
                    version: CACHE_VERSION, features: found, layoutId: layout.id,
                    bundleId: settings.bundleId ?? 'unknown', entry: one.region.entry,
                    hash: `${one.region.hash}-${one.entryTop}`,
                });
                batch.store.put(key, packRegion(built)).catch(()=>{});
                counts.storeMs += performance.now() - storeAt;
            }
            applyBuilt(one, built);
        }
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
            if (one.cached !== null)
            {
                published += applyBuilt(one, one.cached);
            }
        }
        const unbuilt = formed.filter(one=>one.cached === null);
        if (unbuilt.length > 0 && worker !== null)
        {
            // Off the frame thread: post the batch and answer with it later.
            // The records are kept until then; nothing here waits.
            outstanding = { id: ++workerRequest, metas: unbuilt, store };
            worker.post({
                id: outstanding.id,
                jobs: unbuilt.map(one=>({ region: one.region, entryTop: one.entryTop })),
                layout, features: found, options: emitOptions(),
            }, []);
            return published;
        }
        for (const one of unbuilt)
        {
            // One module per region: the unit the store keeps, and the unit
            // dropped when a page moves.
            /** @type {import('./emit-built.js').BuiltRegion} */
            let built;
            try
            {
                built = emitBuilt(one.region, one.entryTop, layout, found, emitOptions());
            }
            catch (e){
                // The emitter's own defect on this code: named in the report
                // rather than lost in a rejected promise, and the program runs
                // on without the region.
                refused[`emit at ${one.region.entry.toString(16)}: `
                    + `${String(e).slice(0, 120)}`] = 1;
                continue;
            }
            counts.emitMs += built.emitMs;
            counts.encodeMs += built.encodeMs;
            foldTranslation(built);
            if (store !== null)
            {
                const storeAt = performance.now();
                const key = cacheKey({
                    version: CACHE_VERSION, features: found, layoutId: layout.id,
                    bundleId: settings.bundleId ?? 'unknown', entry: one.region.entry,
                    hash: `${one.region.hash}-${one.entryTop}`,
                });
                store.put(key, packRegion(built)).catch(()=>{});
                counts.storeMs += performance.now() - storeAt;
            }
            published += applyBuilt(one, built);
        }
        return published;
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
                // translated with the next batch.
                this.noteHot(eip, top);
            }
            return entry;
        },
        run(entry, budget){
            const { fn, label } = entries.at(entry);
            // One record, rewritten per run: a call-heavy program leaves
            // and re-enters per call, and an object per leave was the
            // collector's share of the cost.
            const before = counterWord();
            const code = fn(label, budget) >>> 0;
            const retired = (counterWord() - before) >>> 0;
            corkRetired += retired;
            const kind = KINDS[code & 0xff] ?? 'untranslated';
            exits[kind]++;
            if (kind === 'untranslated')
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
        /** Records one untranslated exit to `address`: the address becomes a
         * candidate of the translator's own once `missThreshold` of them land
         * there. The count is bounded and the coldest entry makes room.
         * @param {number} address @param {number} [top]
         */
        missAt(address, top = 0){
            const target = (exitTargets.get(address) ?? 0) + 1;
            exitTargets.set(address, target);
            if (exitTargets.size > EXIT_TARGETS_CAP)
            {
                let least = -1;
                let leastCount = Infinity;
                for (const [at, count] of exitTargets)
                {
                    if (count < leastCount)
                    {
                        leastCount = count;
                        least = at;
                    }
                }
                exitTargets.delete(least);
            }
            const seen = (misses.get(address) ?? 0) + 1;
            if (seen >= settings.missThreshold)
            {
                misses.delete(address);
                this.noteHot(address, top);
                return;
            }
            if (!misses.has(address) && misses.size >= MISSES_CAP)
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
            misses.set(address, seen);
        },
        noteHot(eip, top = 0){
            if (!settings.translate)
            {
                return;
            }
            const key = keyOf(eip, top & 7);
            if (entries.entryOf(eip, top & 7) >= 0 || queue.has(key) || barren.has(eip)
                || !translatable(eip))
            {
                return;
            }
            queue.set(key, eip);
        },
        /** Writes whatever the store keeps aside from its records, so the
         * names of this run's regions are on disk before the run ends and the
         * next run's index can find them. */
        async flush(){
            await settings.store?.flush?.();
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
            if (!settings.translate || queue.size === 0)
            {
                return 0;
            }
            const batch = [...queue].slice(0, settings.batchRegions);
            for (const [key] of batch)
            {
                queue.delete(key);
            }
            // A diagnostic run with classes left out keeps no translations.
            const store = leaveOut.size > 0 ? null : (settings.store ?? null);
            const bundleId = settings.bundleId ?? 'unknown';
            /** @type {{ region: import('../region.js').Region, entryTop: number,
             *     stamp: string, cached: import('./cache.js').CachedRegion | null }[]} */
            const formed = [];
            const formedAt = performance.now();
            for (let i = 0; i < batch.length; i++)
            {
                const [key, eip] = batch[i];
                const entryTop = key % 16;
                const region = formRegion(read, eip, {
                    maxBlocks: settings.maxRegionBlocks, maxBytes: settings.maxRegionBytes,
                    translatable,
                });
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
                        queue.delete(keyOf(callee, top));
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
                    barren.add(eip);
                    continue;
                }
                formed.push({ region, entryTop, stamp: stamp(region.pages), cached: null });
            }
            counts.formingMs += performance.now() - formedAt;
            if (store === null)
            {
                return finishBatch(formed, null);
            }
            // The store's reads leave the slice path: the batch's records are
            // requested here and the slice goes on. The batch is published
            // when the bytes are back -- between frames, as instantiation
            // already is -- and a region not back is not published this frame.
            // `lookupMs` is the engine thread's own time to start them.
            const lookupAt = performance.now();
            storePending = true;
            Promise.all(formed.map(async one=>{
                const key = cacheKey({
                    version: CACHE_VERSION, features: found, layoutId: layout.id, bundleId,
                    entry: one.region.entry, hash: `${one.region.hash}-${one.entryTop}`,
                });
                try
                {
                    const bytes = await store.get(key);
                    one.cached = bytes === null ? null : unpackRegion(bytes);
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
                }
            })).then(()=>{
                storePending = false;
                finishBatch(formed, store);
            }, ()=>{
                storePending = false;
                finishBatch(formed, store);
            });
            counts.lookupMs += performance.now() - lookupAt;
            return 0;
        },
        invalidatePage,
        /** @param {number} page */
        holdsPage: page=>(pages.get(page) & PageFlag.HAS_CODE) !== 0,
        diagnostics(){
            fold();
            return {
                regions: regions.size,
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
                invalidations: counts.invalidations,
                volatilePages: counts.volatilePages,
                exits: { ...exits },
                // The top untranslated-exit targets over the whole run, and
                // why each has no entry: what a loading phase leaves behind.
                exitsByTarget: [...exitTargets].sort((a, b)=>b[1] - a[1]).slice(0, 32)
                    .map(([address, count])=>({ address, count, reason: missReason(address) })),
                refused: { ...refused },
                refusedWhy: { ...refusedWhy },
                handoffMisses: 0,
            };
        },
    };
}
