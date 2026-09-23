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
 * @param {import('../region.js').Region} region
 * @param {number} entryTop
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean }} features
 * @param {{ undoLog?: boolean, hash?: boolean, trapPort?: number,
 *     leaveOut?: Set<string> | string[] }} [options]
 * @returns {BuiltRegion}
 */
export function emitBuilt(region, entryTop, layout, features, options = {}){
    const leaveOut = options.leaveOut instanceof Set
        ? options.leaveOut
        : new Set(options.leaveOut ?? []);
    const m = new ModuleBuilder();
    const context = prepareModule(m, layout, features, {}, {
        undoLog: options.undoLog === true,
        hash: options.hash === true,
        leaveOut,
        ...(options.trapPort === undefined ? {} : { trapPort: options.trapPort }),
    });
    const emitAt = performance.now();
    const translation = emitRegion(context, region, { entryTop });
    m.exportFunction('r0', translation.functionIndex);
    // Named by its address, so a browser's CPU profile of the engine says
    // which regions the time went to.
    m.nameFunction(translation.functionIndex,
        `r${region.entry.toString(16).padStart(8, '0')}`);
    const encodedAt = performance.now();
    const module = m.toBytes();
    const doneAt = performance.now();
    return {
        module,
        labels: [...translation.labels],
        cut: [...translation.cut],
        entryTop: translation.entryTop,
        instructions: translation.instructions,
        unsupported: [...translation.unsupported],
        refusals: [...translation.refusals],
        emitMs: encodedAt - emitAt,
        encodeMs: doneAt - encodedAt,
    };
}
