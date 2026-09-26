/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The helper functions, in one module every region imports.
 *
 * `materialise` (fold a lazy flag record into the flags word), `f80ToF64`
 * and `f64ToF80` (the 80-bit memory forms), `round` (the control word's
 * rounding control), `codeHit` (a store into a page holding translated
 * code), `f64ToBcd` (`fbstp`'s packed BCD) and `x87Invalid` (an x87 NaN
 * result's IE) are identical in every region module, where a copy in each
 * would be a sixth of a module's bytes. They are defined once here,
 * instantiated once by the host with the same memory, and every region
 * module imports them by name -- the same shape as the funcref table a region
 * already imports, so nothing in the emitter's call sites changes but the
 * function index.
 *
 * `undo` is not here: a store calls it only in a differential build, and a
 * module that imported it always would write the ring always. It stays a
 * function of the region module that asks for it.
 */

import { ValType, ModuleBuilder } from '../wasm/encoder.js';
import { addMaterialiseHelper } from './flags.js';
import { addBcdHelper, addF80Helpers, addInvalidHelper, addRoundHelper } from './x87.js';
import { addCodeHitHelper } from './memory.js';

/** The imported helper names, in the order a region module imports them. */
export const HELPER_NAMES = Object.freeze([
    'materialise', 'f80ToF64', 'f64ToF80', 'round', 'codeHit', 'f64ToBcd', 'x87Invalid',
]);

/**
 * Defines the helpers in a module. Used to build the shared module; the
 * signatures here and in `importHelpers` must agree.
 *
 * @param {ModuleBuilder} m
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 */
export function defineHelpers(m, layout){
    const materialise = addMaterialiseHelper(m);
    const { f80ToF64, f64ToF80 } = addF80Helpers(m);
    const round = addRoundHelper(m);
    const codeHit = addCodeHitHelper(m, layout);
    const f64ToBcd = addBcdHelper(m);
    const x87Invalid = addInvalidHelper(m, layout);
    return { materialise, f80ToF64, f64ToF80, round, codeHit, f64ToBcd, x87Invalid };
}

/**
 * The shared helpers module: an imported memory and the exports.
 *
 * @param {import('../../../core/src/layers/cpu/engine.js').StateLayout} layout
 * @returns {Uint8Array}
 */
export function buildHelpersModule(layout){
    const m = new ModuleBuilder();
    m.importMemory('env', 'memory', { min: 1 });
    const helpers = defineHelpers(m, layout);
    for (const name of HELPER_NAMES)
    {
        m.exportFunction(name, helpers[/** @type {keyof typeof helpers} */ (name)]);
    }
    return m.toBytes();
}

/**
 * Imports the helpers into a region module, answering the indices the
 * emitter calls through. The signatures mirror `defineHelpers`'.
 *
 * @param {ModuleBuilder} m
 * @returns {{ materialise: number, f80ToF64: number, f64ToF80: number,
 *     round: number, codeHit: number, f64ToBcd: number, x87Invalid: number }}
 */
export function importHelpers(m){
    const i32 = ValType.i32;
    const f64 = ValType.f64;
    const materialise = m.importFunction('env', 'materialise',
        m.type({ params: [i32, i32, i32, i32, i32, i32], results: [i32] }));
    const f80ToF64 = m.importFunction('env', 'f80ToF64',
        m.type({ params: [i32], results: [f64] }));
    const f64ToF80 = m.importFunction('env', 'f64ToF80',
        m.type({ params: [f64, i32], results: [] }));
    const round = m.importFunction('env', 'round',
        m.type({ params: [f64, i32], results: [f64] }));
    const codeHit = m.importFunction('env', 'codeHit',
        m.type({ params: [i32], results: [i32] }));
    const f64ToBcd = m.importFunction('env', 'f64ToBcd',
        m.type({ params: [f64, i32], results: [] }));
    const x87Invalid = m.importFunction('env', 'x87Invalid',
        m.type({ params: [f64, f64, i32, i32], results: [i32] }));
    return { materialise, f80ToF64, f64ToF80, round, codeHit, f64ToBcd, x87Invalid };
}
