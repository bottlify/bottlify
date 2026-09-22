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
import { emitRegion, mathImports, prepareModule } from '../emit/region.js';
import { isX87, trackRegion } from '../emit/x87.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { features as probeFeatures } from '../wasm/features.js';
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
        modules: 0, invalidations: 0, volatilePages: 0, dropped: 0, translateMs: 0, moduleBytes: 0,
        cacheHits: 0, cacheMisses: 0,
    };
    let nextTable = 0;
    /** @type {Record<ExitKind, number>} */
    const exits = { untranslated: 0, budget: 0, trap: 0, halt: 0, fault: 0, stale: 0 };
    /** @type {import('../../../core/src/layers/cpu/engine.js').ExitRecord} */
    const exit = { retired: 0, kind: 'untranslated', vector: 0 };
    /** @type {Record<string, number>} */
    const refused = {};
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

    return {
        pages,
        entryOf(eip, top = 0){
            const entry = entries.entryOf(eip, top);
            if (entry < 0 && entries.isSpecialised(eip))
            {
                // A region exists here for another top: one for this top is
                // a candidate, translated with the next batch.
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
                const to = view().getUint32(layout.eip, true);
                const seen = (misses.get(to) ?? 0) + 1;
                if (seen >= settings.missThreshold)
                {
                    misses.delete(to);
                    this.noteHot(to, view().getUint8(layout.x87Top));
                }
                else if (seen > 1 || misses.size < 4096)
                {
                    misses.set(to, seen);
                }
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
        noteHot(eip, top = 0){
            const key = keyOf(eip, top & 7);
            if (entries.entryOf(eip, top & 7) >= 0 || queue.has(key) || barren.has(eip)
                || !translatable(eip))
            {
                return;
            }
            queue.set(key, eip);
        },
        async translatePending(){
            if (queue.size === 0)
            {
                return 0;
            }
            const startedAt = performance.now();
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
            // The store first, for every region of the batch at once: the
            // lookups are asynchronous and the emitter waits for none of them.
            if (store !== null)
            {
                await Promise.all(formed.map(async one=>{
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
                }));
            }
            let published = 0;
            for (const { region, entryTop, stamp: at, cached } of formed)
            {
                const eip = region.entry;
                // One module per region: the unit the store keeps, and the
                // unit dropped when a page moves.
                /** @type {import('./cache.js').CachedRegion} */
                let built;
                if (cached !== null)
                {
                    built = cached;
                }
                else
                {
                    const m = new ModuleBuilder();
                    const context = prepareModule(m, layout, found, {}, {
                        undoLog: settings.undoLog, hash: table !== null, leaveOut,
                        ...(settings.trapPort === undefined ? {} : { trapPort: settings.trapPort }),
                    });
                    /** @type {import('../emit/region.js').Translation} */
                    let translation;
                    try
                    {
                        translation = emitRegion(context, region, { entryTop });
                    }
                    catch (e){
                        // The emitter's own defect on this code: named in the
                        // report rather than lost in a rejected promise, and
                        // the program runs on without the region.
                        refused[`emit at ${eip.toString(16)}: ${String(e).slice(0, 120)}`] = 1;
                        continue;
                    }
                    for (const [opcode, times] of translation.unsupported)
                    {
                        refused[opcode] = (refused[opcode] ?? 0) + times;
                    }
                    m.exportFunction('r0', translation.functionIndex);
                    built = {
                        module: m.toBytes(), labels: [...translation.labels],
                        cut: [...translation.cut], entryTop: translation.entryTop,
                        instructions: translation.instructions,
                    };
                    if (store !== null)
                    {
                        const key = cacheKey({
                            version: CACHE_VERSION, features: found, layoutId: layout.id,
                            bundleId, entry: eip, hash: `${region.hash}-${entryTop}`,
                        });
                        store.put(key, packRegion(built)).catch(()=>{});
                    }
                }
                counts.moduleBytes += built.module.length;
                /** @type {WebAssembly.Instance} */
                let instance;
                try
                {
                    const module = new WebAssembly.Module(
                        /** @type {Uint8Array<ArrayBuffer>} */ (built.module));
                    instance = new WebAssembly.Instance(module, {
                        env: {
                            memory, getEflags: imports.getEflags, trap: imports.trap,
                            ...mathImports(), ...(table ? { table } : {}),
                        },
                    });
                }
                catch (e){
                    // The region is refused: the program runs on as it did.
                    refused.batch = (refused.batch ?? 0) + 1;
                    refused[`batch: ${String(e).slice(0, 120)}`] = 1;
                    continue;
                }
                counts.modules++;
                if (at !== stamp(region.pages))
                {
                    // A page of it was written while the batch was built.
                    counts.dropped++;
                    continue;
                }
                const fn = /** @type {(label: number, budget: number) => number} */ (
                    instance.exports.r0);
                const cut = new Set(built.cut);
                // Entries for every block start but the cut ones; a region
                // with x87 in it is keyed by the top it was compiled for.
                const top = cut.size > 0 || usesX87(region) ? built.entryTop : ANY_TOP;
                const starts = built.labels.filter(([, label])=>!cut.has(label));
                if (starts.length === 0)
                {
                    // Every block leaves at once (an instruction the other
                    // executor's first): nothing to enter, nothing to keep.
                    barren.add(eip);
                    continue;
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
                published++;
            }
            counts.translateMs += performance.now() - startedAt;
            return published;
        },
        invalidatePage,
        /** @param {number} page */
        holdsPage: page=>(pages.get(page) & PageFlag.HAS_CODE) !== 0,
        diagnostics(){
            fold();
            return {
                regions: regions.size,
                entries: table ? entries.hashed() : entries.count(),
                translateMs: counts.translateMs,
                moduleBytes: counts.moduleBytes,
                modules: counts.modules,
                translatedShare: counted > 0 ? corkRetired / counted : 0,
                retired: corkRetired,
                cacheHits: counts.cacheHits,
                cacheMisses: counts.cacheMisses,
                invalidations: counts.invalidations,
                volatilePages: counts.volatilePages,
                exits: { ...exits },
                refused: { ...refused },
                handoffMisses: 0,
            };
        },
    };
}
