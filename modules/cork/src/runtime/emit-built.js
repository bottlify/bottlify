/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Emitting and encoding one region, with no memory of the machine: the work
 * the runtime can hand to a translation worker.
 *
 * The emitter is pure over a formed region, the layout, the host's features
 * and the options, so the same function runs inline in the runtime and in
 * the worker of `translator.worker.js` -- one implementation, so the two
 * cannot disagree. The result is everything `packRegion` and the runtime's
 * publication need: the module bytes, the labels and their starts, the cut
 * labels, the x87 top, the retired count, and what the emitter left out
 * (folded into the run's refusal maps by the caller), all data a structured
 * clone carries.
 */

import { emitRegion, finishModule, prepareModule } from '../emit/region.js';
import { formRegion, formShared } from '../region.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { openArena } from './arena.js';

/**
 * @typedef {Object} BuiltRegion
 * @property {Uint8Array} module
 * @property {[number, number][]} labels
 * @property {number[]} cut
 * @property {number} entryTop
 * @property {number} instructions
 * @property {[string, number][]} unsupported
 * @property {[string, number][]} refusals
 * @property {[string, number][]} relaxedReads
 * @property {number} x87RelaxedReads
 * @property {number} emitMs       milliseconds the emitter took
 * @property {number} encodeMs     milliseconds `toBytes` took
 */

/**
 * @typedef {Object} BatchRegion  One region of a batch module.
 * @property {string} exportName   its function's export in the module
 * @property {[number, number][]} labels
 * @property {number[]} cut
 * @property {number[]} closed  the starts of the blocks inside its loops that have no entry
 *     (a structured region formed without copies)
 * @property {number} entryTop
 * @property {number} instructions
 * @property {[string, number][]} unsupported
 * @property {[string, number][]} refusals
 * @property {[string, number][]} relaxedReads  by opcode, the reads of a flag an instruction
 *     before them left undefined, outside `precise`
 * @property {number} x87RelaxedReads  x87 status-word reads that may see what a module that is
 *     not `precise` does not keep
 */

/**
 * @typedef {Object} BuiltBatch
 * @property {Uint8Array} module   every region of the batch, one function each
 * @property {({ ok: true, region: BatchRegion } | { ok: false, message: string })[]} results
 *     one per job, in order: a region the emitter failed on is left out of the module
 * @property {number} emitMs
 * @property {number} encodeMs
 * @property {string} [digest]  `moduleDigest` of `module`, taken by a translation worker
 * @property {Uint8Array} [packed]  and the store's record of `module` (`packRegion`)
 */

/**
 * @typedef {import('./arena.js').KeptFunction} KeptFunction
 */

/**
 * Region functions already emitted, kept by the module's context, the region's
 * entry and hash, and what its job asked of the emitter (`jobKey`); a hit must
 * also match the region's `shapeOf`. Kept in this thread (`createEmitCache`) or
 * in the arena a process's translators share (`arenaEmitCache`).
 *
 * @typedef {Object} EmitCache
 * @property {(signature: string) => string} context  what keys name a module's context by
 * @property {(key: string, shape: number[]) => KeptFunction | undefined} take
 * @property {(key: string, shape: number[], kept: KeptFunction) => void} keep
 * @property {number} hits  the functions this cache handed back
 */

/**
 * @typedef {EmitCache & {
 *     kept: Map<string, KeptFunction & { shape: Float64Array, size: number }>,
 *     contexts: Map<string, number>, bytes: number, limit: number }} LocalEmitCache
 *     kept: the least recently used first, `region` shared by every batch that takes the
 *     function (nothing writes it); contexts: `contextKey` → the number keys name it by;
 *     bytes: the sizes of what is kept
 */

/**
 * A region's function is a pure function of the formed region, the x87 top and
 * shape test it is compiled for, and the module it is emitted into -- and a
 * module prepared with the same layout, features and options indexes its types,
 * imports, helpers and transfer function alike, whatever other regions it
 * holds. So a relink or a merge, which emits running regions again into a
 * bigger module, takes each one's function as it was emitted before: a merge
 * that gathers one more region into a module of hundreds otherwise emitted all
 * of them again. The region is still formed from the pages first, which is the
 * check that its bytes are what they were.
 *
 * @param {number} [limit]  bytes of functions kept, the least recently used going first
 * @returns {LocalEmitCache}
 */
export function createEmitCache(limit = 48 << 20){
    /** @type {LocalEmitCache} */
    const cache = {
        kept: new Map(), contexts: new Map(), bytes: 0, limit, hits: 0,
        context(signature){
            const number = cache.contexts.get(signature) ?? cache.contexts.size;
            cache.contexts.set(signature, number);
            return String(number);
        },
        take(key, shape){
            const kept = cache.kept.get(key);
            if (kept === undefined || !sameShape(kept.shape, shape))
            {
                return undefined;
            }
            cache.kept.delete(key);
            cache.kept.set(key, kept);
            cache.hits++;
            return kept;
        },
        keep(key, shape, { typeIndex, locals, body, hints, region }){
            const size = key.length + shape.length * 8 + body.length + locals.length * 8
                + hints.length * 8 + region.labels.length * 32 + 256;
            const old = cache.kept.get(key);
            if (old !== undefined)
            {
                cache.kept.delete(key);
                cache.bytes -= old.size;
            }
            // The shape as a typed array: guest addresses past 2^30 are not small
            // integers, and an array of them is an object per address to the collector.
            cache.kept.set(key, { typeIndex, locals, body, hints, region,
                shape: Float64Array.from(shape), size });
            cache.bytes += size;
            for (const [oldest, one] of cache.kept)
            {
                if (cache.bytes <= cache.limit)
                {
                    break;
                }
                cache.kept.delete(oldest);
                cache.bytes -= one.size;
            }
        },
    };
    return cache;
}

/**
 * The functions a process's translators keep in its arena: what any of them
 * emitted, every other takes. The context goes into the key whole, as every
 * worker must name it alike.
 *
 * @param {SharedArrayBuffer} buffer  `createArena`'s
 * @returns {EmitCache & { arena: ReturnType<typeof openArena> }}
 */
export function arenaEmitCache(buffer){
    const arena = openArena(buffer);
    /** @type {EmitCache & { arena: ReturnType<typeof openArena> }} */
    const cache = {
        arena, hits: 0,
        context: signature=>signature,
        take(key, shape){
            const kept = arena.get(key, shape);
            if (kept !== undefined)
            {
                cache.hits++;
            }
            return kept;
        },
        keep: (key, shape, kept)=>arena.set(key, shape, kept),
    };
    return cache;
}

/**
 * What a module's region functions read of the module besides their region: the
 * indices `prepareModule` hands out follow from these alone.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {NonNullable<Parameters<typeof emitBatch>[3]>} options
 * @param {Set<string>} leaveOut
 */
function contextKey(layout, features, options, leaveOut){
    return JSON.stringify([layout.id ?? layout, features.simd, features.tailCalls,
        features.defaultNaNNegative === true, options.undoLog === true, options.hash === true,
        options.trapPort ?? null, options.countTransfers === true, options.blockProfile === true,
        options.wide === true, options.narrow === true, options.structure !== false,
        options.precise === true, options.place === true, options.profileCalls === true,
        options.atomic === true, options.ordered === true,
        options.resume === true, options.callReturn === true, options.emptySites === true,
        options.linkedCalls !== false, options.looseStacks === true,
        options.checkReads === true, options.expansion != null, options.crossTailCalls !== false,
        [...leaveOut].sort()]);
}

/** @type {Map<string, number>} */
const EXIT_CODES = new Map(['fallthrough', 'jump', 'jcc', 'loop', 'ret', 'indirect', 'call',
    'trap', 'hlt', 'refused', 'fault', 'cut'].map((kind, code)=>[kind, code]));

/** Why a call's callee stayed apart (`Apart`), as the number a shape keeps; 0 when none. */
const APART_CODES = new Map(['blocks', 'bytes', 'shape', 'nested', 'unpredicted']
    .map((apart, code)=>[apart, code + 1]));

/**
 * Everything of a formed region the emitter reads that its bytes do not decide
 * -- its blocks' spans and exits, the bytes themselves being the hash's -- as
 * numbers, or null for an exit this does not know.
 *
 * @param {import('../region.js').Region} region
 * @returns {number[] | null}
 */
function shapeOf(region){
    /** @type {number[]} */
    const shape = [];
    for (const { start, end, exit } of region.blocks)
    {
        const code = EXIT_CODES.get(exit.kind);
        if (code === undefined)
        {
            return null;
        }
        shape.push(start, end, code, exit.next,
            (exit.backEdge ? 1 : 0) | (exit.predicted === true ? 2 : 0)
                | (APART_CODES.get(exit.apart ?? '') ?? 0) << 2, exit.targets.length,
            ...exit.targets);
        const table = exit.table;
        if (table === undefined)
        {
            shape.push(-1);
        }
        else
        {
            shape.push(table.index, table.address, table.entries.length, ...table.entries);
        }
    }
    return shape;
}

/**
 * What a job asks of the emitter besides its region -- the x87 top, the shape
 * test and whatever else a job carries -- every one of them part of the key; a
 * flag left out and one that is false ask the same.
 *
 * @param {Record<string, unknown>} job
 */
function jobKey(job){
    let key = '';
    for (const name of Object.keys(job).sort())
    {
        const value = job[name];
        if (name !== 'region' && value !== undefined && value !== false)
        {
            key += `${name}=${JSON.stringify(value)};`;
        }
    }
    return key;
}

/** @param {Float64Array} kept @param {number[]} shape */
function sameShape(kept, shape){
    if (kept.length !== shape.length)
    {
        return false;
    }
    for (let i = 0; i < shape.length; i++)
    {
        if (kept[i] !== shape[i])
        {
            return false;
        }
    }
    return true;
}

/**
 * Many regions in one module, one function each: a call from one region into
 * another of the same module is a call within one compiled module, and V8's
 * cost of a tail call into another module's function grows with how many
 * modules there are -- 2000 regions a module each ran a chain of calls at
 * 219 ns a call where one module of them ran it at 6.
 *
 * @param {{ region: import('../region.js').Region, entryTop: number, checked?: boolean,
 *     copies?: boolean, precision?: import('../emit/region.js').X87Precision,
 *     floats?: boolean }[]} jobs  checked: an x87 region whose entries test nothing of the
 *     stack's shape; copies: the blocks inside a structured region's loops are entered
 *     through copies of them, where without they have no entry; precision: the precision
 *     control its x87 is compiled for, the options' wide and narrow when not given; floats:
 *     compiled for single, its arithmetic on floats (`emitRegion`)
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {{ undoLog?: boolean, hash?: boolean, trapPort?: number, countTransfers?: boolean,
 *     blockProfile?: boolean, timings?: boolean, place?: boolean,
 *     leaveOut?: Set<string> | string[], wide?: boolean, narrow?: boolean,
 *     structure?: boolean, precise?: boolean, profileCalls?: boolean, resume?: boolean,
 *     atomic?: boolean, ordered?: boolean,
 *     callReturn?: boolean, emptySites?: boolean, linkedCalls?: boolean, crossTailCalls?: boolean,
 *     looseStacks?: boolean, checkReads?: boolean,
 *     memory?: { shared?: boolean, maxPages?: number },
 *     expansion?: import('../emit/region.js').ExpansionNote | null }}
 *     [options]
 *     timings: `emitMs` and `encodeMs` are measured (the runtime's `timings`), else 0;
 *     precise: nothing relaxed (the runtime's `precise`); place: job i's function goes at
 *     the module's range of the table plus i, a transfer into the range a direct tail call
 *     and one out of it counted (`finishModule`); resume: a miss of the hash runs the
 *     interpreter tier in wasm (`prepareModule`); memory: how the modules import the
 *     memory, shared for a shared one
 * @param {EmitCache} [cache]  functions emitted before, taken again rather than emitted
 * @returns {BuiltBatch}
 */
export function emitBatch(jobs, layout, features, options = {}, cache = undefined){
    const clock = import.meta.BOTTLIFY_DIAGNOSTICS !== false && options.timings === true
        ? ()=>performance.now() : ()=>0;
    const leaveOut = options.leaveOut instanceof Set
        ? options.leaveOut
        : new Set(options.leaveOut ?? []);
    const m = new ModuleBuilder();
    const context = prepareModule(m, layout, features, options.memory ?? {}, {
        undoLog: options.undoLog === true,
        hash: options.hash === true,
        countTransfers: options.countTransfers === true,
        blockProfile: options.blockProfile === true,
        wide: options.wide === true,
        narrow: options.narrow === true,
        structure: options.structure !== false,
        precise: options.precise === true,
        atomic: options.atomic === true,
        ordered: options.ordered === true,
        place: options.place === true ? jobs.length : 0,
        profileCalls: options.profileCalls === true,
        resume: options.resume === true,
        callReturn: options.callReturn === true,
        emptySites: options.emptySites === true,
        linkedCalls: options.linkedCalls !== false,
        looseStacks: options.looseStacks === true,
        checkReads: options.checkReads === true,
        crossTailCalls: options.crossTailCalls !== false,
        leaveOut,
        expansion: options.expansion ?? null,
        ...(options.trapPort === undefined ? {} : { trapPort: options.trapPort }),
    });
    const emitAt = clock();
    const prepared = cache === undefined ? ''
        : cache.context(contextKey(layout, features, options, leaveOut));
    /** Each job's function, for the dispatcher. @type {(number | null)[]} */
    const functions = jobs.map(()=>null);
    /** @type {BuiltBatch['results']} */
    const results = jobs.map((job, index)=>{
        const { region, entryTop, checked, copies, precision, floats } = job;
        try
        {
            const shape = cache === undefined ? null : shapeOf(region);
            const key = shape === null ? ''
                : `${prepared}:${region.entry}:${region.hash}:${jobKey(job)}`;
            const kept = shape === null ? undefined : cache?.take(key, shape);
            let functionIndex;
            let copiesIndex = -1;
            /** @type {Omit<BatchRegion, 'exportName'>} */
            let built;
            if (kept !== undefined)
            {
                functionIndex = m.function(kept.typeIndex, kept.locals, kept.body,
                    { hints: kept.hints });
                built = kept.region;
            }
            else
            {
                const { functions: made, types, globals, imports } = m;
                const before = [made.length, types.length, globals.length, imports.length];
                // The emitter adds the function only once the region is written,
                // so a region it fails on leaves the module as it was.
                const translation = emitRegion(context, region,
                    { entryTop, checked: checked === true, copies: copies === true,
                        ...(precision === undefined ? {} : { precision }),
                        ...(floats === true ? { floats } : {}) });
                functionIndex = translation.functionIndex;
                copiesIndex = translation.copiesIndex;
                built = {
                    labels: [...translation.labels],
                    cut: [...translation.cut],
                    closed: [...translation.closed],
                    entryTop: translation.entryTop,
                    instructions: translation.instructions,
                    unsupported: [...translation.unsupported],
                    refusals: [...translation.refusals],
                    relaxedReads: [...translation.relaxedReads],
                    x87RelaxedReads: translation.x87RelaxedReads,
                };
                // Kept only when the region added its one function and nothing
                // else to the module (a region with copies adds two): its body
                // then names no index of the module but those `prepareModule`
                // hands out alike in every module.
                if (cache !== undefined && shape !== null && made.length === before[0] + 1
                    && functionIndex === m.importedFunctions + before[0]
                    && types.length === before[1] && globals.length === before[2]
                    && imports.length === before[3])
                {
                    const { typeIndex, locals, body, hints } =
                        m.functions[functionIndex - m.importedFunctions];
                    cache.keep(key, shape, { typeIndex, locals, body, hints, region: built });
                }
            }
            const exportName = `r${index}`;
            m.exportFunction(exportName, functionIndex);
            functions[index] = functionIndex;
            // Named by its address, so a browser's CPU profile of the engine
            // says which regions the time went to; the names in the order of
            // the functions, the copies' first (`emitCopies`).
            const named = `r${region.entry.toString(16).padStart(8, '0')}`;
            if (copiesIndex >= 0)
            {
                m.nameFunction(copiesIndex, `${named}-copies`);
            }
            m.nameFunction(functionIndex, named);
            return { ok: true, region: { exportName, ...built } };
        }
        catch (e){
            return { ok: false,
                message: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
        }
    });
    finishModule(context, functions);
    const encodedAt = clock();
    const module = m.toBytes();
    return { module, results, emitMs: encodedAt - emitAt, encodeMs: clock() - encodedAt };
}

/**
 * Regions already running, formed again from a copy of their pages and emitted
 * into one module: the relink that gathers the regions of many small batch
 * modules into a few big ones. A region whose bytes no longer hash as they did
 * is answered as a failure (`changed`) and keeps the function it has. A job's
 * `targets` are the callees its indirect calls were predicted to (`callTargets`),
 * its `stops` the blocks its forming left to other regions (`entered`).
 *
 * @param {{ jobs: { entry: number, entryTop: number, hash: string, checked?: boolean,
 *         copies?: boolean, precision?: import('../emit/region.js').X87Precision,
 *         floats?: boolean, targets?: [number, number[]][], stops?: number[] }[],
 *     pages: [number, Uint8Array][], formable?: number[],
 *     form: { maxBlocks: number, maxBytes: number, leafCalls?: boolean,
 *         helpers?: boolean } }} relink   `pages` copies of every page forming read,
 *     `formable` the ones a region may span (all of `pages` when absent)
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {Parameters<typeof emitBatch>[3]} [options]
 * @param {EmitCache} [cache]
 * @returns {BuiltBatch}
 */
export function relinkBatch({ jobs, pages, form, formable }, layout, features, options = {},
    cache = undefined)
{
    const byPage = new Map(pages);
    // The pages a region may be formed over: the regions' own, when the copies hold more
    // that forming only read.
    const formablePages = formable === undefined ? byPage : new Set(formable);
    // The page read last, kept: forming reads a region's bytes in runs.
    let lastPage = -1;
    /** @type {Uint8Array | undefined} */
    let lastBytes;
    /** @param {number} address */
    const read = address=>{
        const page = address >>> 12;
        if (page !== lastPage)
        {
            lastPage = page;
            lastBytes = byPage.get(page);
        }
        return lastBytes?.[address & 0xfff] ?? 0;
    };
    // The pages the regions were formed over are the translatable ones: a page
    // one of them was refused at is not among any region's pages.
    /** @param {number} address */
    const translatable = address=>formablePages.has(address >>> 12);
    const shared = formShared();
    const formed = jobs.map(job=>{
        const stopped = new Set(job.stops ?? []);
        const region = formRegion(read, job.entry, { ...form, translatable, shared,
            entered: address=>stopped.has(address),
            ...(job.targets === undefined ? {} : { callTargets: new Map(job.targets) }) });
        return region.hash === job.hash
            ? { region, entryTop: job.entryTop, checked: job.checked === true,
                copies: job.copies === true,
                ...(job.precision === undefined ? {} : { precision: job.precision }),
                ...(job.floats === true ? { floats: true } : {}) } : null;
    });
    const batch = emitBatch(/** @type {{ region: any, entryTop: number }[]} */ (
        formed.filter(one=>one !== null)), layout, features, options, cache);
    let next = 0;
    const results = formed.map(one=>(one === null
        ? { ok: /** @type {const} */ (false), message: 'changed' }
        : batch.results[next++]));
    return { ...batch, results };
}

/**
 * One region alone in its module, exported as `r0`.
 *
 * @param {import('../region.js').Region} region
 * @param {number} entryTop
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {{ undoLog?: boolean, hash?: boolean, trapPort?: number,
 *     leaveOut?: Set<string> | string[] }} [options]
 * @returns {BuiltRegion}
 */
export function emitBuilt(region, entryTop, layout, features, options = {}){
    const batch = emitBatch([{ region, entryTop }], layout, features, options);
    const [result] = batch.results;
    if (!result.ok)
    {
        throw new Error(result.message);
    }
    const { emitMs, encodeMs } = batch;
    return { module: batch.module, ...result.region, emitMs, encodeMs };
}
