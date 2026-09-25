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

import { emitRegion, prepareModule } from '../emit/region.js';
import { formRegion } from '../region.js';
import { ModuleBuilder } from '../wasm/encoder.js';

/**
 * @typedef {Object} BuiltRegion
 * @property {Uint8Array} module
 * @property {[number, number][]} labels
 * @property {number[]} cut
 * @property {number} entryTop
 * @property {number} instructions
 * @property {[string, number][]} unsupported
 * @property {[string, number][]} refusals
 * @property {number} emitMs       milliseconds the emitter took
 * @property {number} encodeMs     milliseconds `toBytes` took
 */

/**
 * @typedef {Object} BatchRegion  One region of a batch module.
 * @property {string} exportName   its function's export in the module
 * @property {[number, number][]} labels
 * @property {number[]} cut
 * @property {number} entryTop
 * @property {number} instructions
 * @property {[string, number][]} unsupported
 * @property {[string, number][]} refusals
 * @property {number} relaxedReads  x87 status-word reads that may see what a module that is
 *     not `precise` does not keep
 */

/**
 * @typedef {Object} BuiltBatch
 * @property {Uint8Array} module   every region of the batch, one function each
 * @property {({ ok: true, region: BatchRegion } | { ok: false, message: string })[]} results
 *     one per job, in order: a region the emitter failed on is left out of the module
 * @property {number} emitMs
 * @property {number} encodeMs
 */

/**
 * Many regions in one module, one function each: a call from one region into
 * another of the same module is a call within one compiled module, and V8's
 * cost of a tail call into another module's function grows with how many
 * modules there are -- 2000 regions a module each ran a chain of calls at
 * 219 ns a call where one module of them ran it at 6.
 *
 * @param {{ region: import('../region.js').Region, entryTop: number, checked?: boolean }[]} jobs
 *     checked: an x87 region whose entries test nothing of the stack's shape
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {{ undoLog?: boolean, hash?: boolean, trapPort?: number, countTransfers?: boolean,
 *     blockProfile?: boolean, timings?: boolean,
 *     leaveOut?: Set<string> | string[], wide?: boolean, structure?: boolean,
 *     precise?: boolean }} [options]
 *     timings: `emitMs` and `encodeMs` are measured (the runtime's `timings`), else 0;
 *     precise: nothing relaxed (the runtime's `precise`)
 * @returns {BuiltBatch}
 */
export function emitBatch(jobs, layout, features, options = {}){
    const clock = import.meta.BOTTLIFY_DIAGNOSTICS !== false && options.timings === true
        ? ()=>performance.now() : ()=>0;
    const leaveOut = options.leaveOut instanceof Set
        ? options.leaveOut
        : new Set(options.leaveOut ?? []);
    const m = new ModuleBuilder();
    const context = prepareModule(m, layout, features, {}, {
        undoLog: options.undoLog === true,
        hash: options.hash === true,
        countTransfers: options.countTransfers === true,
        blockProfile: options.blockProfile === true,
        wide: options.wide === true,
        structure: options.structure === true,
        precise: options.precise === true,
        leaveOut,
        ...(options.trapPort === undefined ? {} : { trapPort: options.trapPort }),
    });
    const emitAt = clock();
    /** @type {BuiltBatch['results']} */
    const results = jobs.map(({ region, entryTop, checked }, index)=>{
        try
        {
            // The emitter adds the function only once the region is written,
            // so a region it fails on leaves the module as it was.
            const translation = emitRegion(context, region,
                { entryTop, checked: checked === true });
            const exportName = `r${index}`;
            m.exportFunction(exportName, translation.functionIndex);
            // Named by its address, so a browser's CPU profile of the engine
            // says which regions the time went to.
            m.nameFunction(translation.functionIndex,
                `r${region.entry.toString(16).padStart(8, '0')}`);
            return { ok: true, region: {
                exportName,
                labels: [...translation.labels],
                cut: [...translation.cut],
                entryTop: translation.entryTop,
                instructions: translation.instructions,
                unsupported: [...translation.unsupported],
                refusals: [...translation.refusals],
                relaxedReads: translation.x87RelaxedReads,
            } };
        }
        catch (e){
            return { ok: false,
                message: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
        }
    });
    const encodedAt = clock();
    const module = m.toBytes();
    return { module, results, emitMs: encodedAt - emitAt, encodeMs: clock() - encodedAt };
}

/**
 * Regions already running, formed again from a copy of their pages and emitted
 * into one module: the relink that gathers the regions of many small batch
 * modules into a few big ones. A region whose bytes no longer hash as they did
 * is answered as a failure (`changed`) and keeps the function it has.
 *
 * @param {{ jobs: { entry: number, entryTop: number, hash: string, checked?: boolean }[],
 *     pages: [number, Uint8Array][],
 *     form: { maxBlocks: number, maxBytes: number, leafCalls?: boolean } }} relink
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {Parameters<typeof emitBatch>[3]} [options]
 * @returns {BuiltBatch}
 */
export function relinkBatch({ jobs, pages, form }, layout, features, options = {}){
    const byPage = new Map(pages);
    /** @param {number} address */
    const read = address=>byPage.get(address >>> 12)?.[address & 0xfff] ?? 0;
    // The pages the regions were formed over are the translatable ones: a page
    // one of them was refused at is not among any region's pages.
    /** @param {number} address */
    const translatable = address=>byPage.has(address >>> 12);
    const formed = jobs.map(job=>{
        const region = formRegion(read, job.entry, { ...form, translatable });
        return region.hash === job.hash
            ? { region, entryTop: job.entryTop, checked: job.checked === true } : null;
    });
    const batch = emitBatch(/** @type {{ region: any, entryTop: number }[]} */ (
        formed.filter(one=>one !== null)), layout, features, options);
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
