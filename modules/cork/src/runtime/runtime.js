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
import { isX87 } from '../emit/x87.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { features as probeFeatures } from '../wasm/features.js';
import { ANY_TOP, createEntries } from './entries.js';
import { PageFlag, createPageTable } from './pages.js';
import { Tables } from './layout.js';

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
        undoLog: false,
        ...config,
    };
    if (layout.tables + Tables.SIZE > memory.buffer.byteLength)
    {
        throw new Error(`cork: the memory ends at ${memory.buffer.byteLength}, before the tables`
            + ` at ${layout.tables} + ${Tables.SIZE}`);
    }
    const found = features ?? probeFeatures();
    const pages = createPageTable(memory, layout);
    const entries = createEntries();
    /** @type {Map<number, number>} candidates not yet formed: key(eip, top) → eip */
    const queue = new Map();
    /** @param {number} eip @param {number} top */
    const keyOf = (eip, top)=>eip * 16 + top;
    /**
     * @typedef {Object} RegionRecord
     * @property {number} entry
     * @property {Set<number>} pages
     * @property {number[]} slots   entry indices
     */
    /** @type {Set<RegionRecord>} */
    const regions = new Set();
    /** @type {Map<number, Set<RegionRecord>>} page → regions on it */
    const byPage = new Map();
    /** @type {Map<number, number>} page → times invalidated */
    const generation = new Map();
    const counts = { modules: 0, invalidations: 0, volatilePages: 0, dropped: 0 };
    /** @type {Record<ExitKind, number>} */
    const exits = { untranslated: 0, budget: 0, trap: 0, halt: 0, fault: 0, stale: 0 };
    /** @type {Record<string, number>} */
    const refused = {};
    let corkRetired = 0;
    // The counter word folded the way the layer folds it: exact as long as
    // reads come less than 2^32 instructions apart.
    let counted = 0;
    let lastWord = 0;
    const view = ()=>new DataView(memory.buffer);
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
                for (const p of record.pages)
                {
                    byPage.get(p)?.delete(record);
                }
                regions.delete(record);
                counts.invalidations++;
            }
            for (const p of touched)
            {
                if (!byPage.get(p)?.size)
                {
                    pages.clear(p, PageFlag.HAS_CODE);
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
        const times = (generation.get(page) ?? 0) + 1;
        generation.set(page, times);
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
            const before = counterWord();
            const code = fn(label, budget) >>> 0;
            const retired = (counterWord() - before) >>> 0;
            corkRetired += retired;
            const kind = KINDS[code & 0xff] ?? 'untranslated';
            exits[kind]++;
            if (kind === 'stale')
            {
                const address = pages.staleAddress();
                invalidatePage(address >>> 12);
                if ((address & 0xfff) > 0xff0)
                {
                    invalidatePage((address >>> 12) + 1);
                }
            }
            return { retired, kind, vector: code >>> 8 };
        },
        noteHot(eip, top = 0){
            const key = keyOf(eip, top & 7);
            if (entries.entryOf(eip, top & 7) >= 0 || queue.has(key) || !translatable(eip))
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
            const batch = [...queue].slice(0, settings.batchRegions);
            for (const [key] of batch)
            {
                queue.delete(key);
            }
            const m = new ModuleBuilder();
            const context = prepareModule(m, layout, found, {}, { undoLog: settings.undoLog });
            /** @type {{ region: import('../region.js').Region,
             *     translation: import('../emit/region.js').Translation, stamp: string }[]} */
            const formed = [];
            for (const [key, eip] of batch)
            {
                const entryTop = key % 16;
                const region = formRegion(read, eip, {
                    maxBlocks: settings.maxRegionBlocks, maxBytes: settings.maxRegionBytes,
                    translatable,
                });
                for (const [opcode, times] of region.refused)
                {
                    refused[opcode] = (refused[opcode] ?? 0) + times;
                }
                if (region.blocks.length === 0 || region.blocks[0].instructions.length === 0)
                {
                    continue;
                }
                const translation = emitRegion(context, region, { entryTop });
                for (const [opcode, times] of translation.unsupported)
                {
                    refused[opcode] = (refused[opcode] ?? 0) + times;
                }
                m.exportFunction(`r${formed.length}`, translation.functionIndex);
                formed.push({ region, translation, stamp: stamp(region.pages) });
            }
            if (formed.length === 0)
            {
                return 0;
            }
            /** @type {WebAssembly.Instance} */
            let instance;
            try
            {
                const module = await WebAssembly.compile(m.toBytes());
                instance = await WebAssembly.instantiate(module, {
                    env: { memory, getEflags: imports.getEflags, ...mathImports() },
                });
            }
            catch (e){
                // The whole batch is refused: the program runs on as it did.
                refused.batch = (refused.batch ?? 0) + 1;
                refused[`batch: ${String(e).slice(0, 120)}`] = 1;
                return 0;
            }
            counts.modules++;
            let published = 0;
            for (let i = 0; i < formed.length; i++)
            {
                const { region, translation, stamp: at } = formed[i];
                if (at !== stamp(region.pages))
                {
                    // A page of it was written while the batch compiled.
                    counts.dropped++;
                    continue;
                }
                const fn = /** @type {(label: number, budget: number) => number} */ (
                    instance.exports[`r${i}`]);
                /** @type {RegionRecord} */
                const record = { entry: region.entry, pages: region.pages, slots: [] };
                // Entries for every block start but the cut ones; a region
                // with x87 in it is keyed by the top it was compiled for.
                const top = translation.cut.size > 0 || usesX87(region)
                    ? translation.entryTop : ANY_TOP;
                for (const [eip, label] of translation.labels)
                {
                    if (!translation.cut.has(label))
                    {
                        record.slots.push(entries.add(eip, fn, label, top));
                    }
                }
                for (const block of region.blocks)
                {
                    pages.markRange(block.start, block.end - block.start, PageFlag.HAS_CODE);
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
            return published;
        },
        invalidatePage,
        diagnostics(){
            fold();
            return {
                regions: regions.size,
                entries: entries.count(),
                modules: counts.modules,
                translatedShare: counted > 0 ? corkRetired / counted : 0,
                cacheHits: 0,
                cacheMisses: 0,
                invalidations: counts.invalidations,
                volatilePages: counts.volatilePages,
                exits: { ...exits },
                refused: { ...refused },
                handoffMisses: 0,
            };
        },
    };
}
