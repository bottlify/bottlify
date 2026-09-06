/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Startup configuration normalization and validation.
 *
 * Input shape: a map of `module name → value`:
 *   undefined / true  → enabled with defaults;
 *   false / null      → disabled (a stub is installed if a module requires it);
 *   object            → enabled with the passed configuration (module-validated);
 *   anything else     → configuration error.
 * An unknown module name is a configuration error.
 */

/**
 * @typedef {Object} ModuleToggle
 * @property {boolean} enabled
 * @property {null | import("./contract.js").ModuleConfig} config
 */

/**
 * @param {Record<string, unknown> | undefined} desired Map `name → value` from the caller.
 * @param {readonly string[]} known    All module names known to the package.
 * @returns {Map<string, ModuleToggle>}
 */
export function normalizeConfig(desired, known){
    const knownSet = new Set(known);
    for (const key of Object.keys(desired ?? {})){
        if (!knownSet.has(key)){
            throw new Error(`Unknown module in configuration: "${key}". Known: ${known.join(', ')}`);
        }
    }

    const out = new Map();
    for (const name of known){
        const raw = desired ? desired[name] : undefined;
        let enabled;
        let config = null;
        if (raw === false || raw === null){
            enabled = false;
        } else if (raw === true || raw === undefined){
            enabled = true;
        } else if (typeof raw === 'object'){
            enabled = true;
            config = /** @type {import("./contract.js").ModuleConfig} */ raw;
        } else {
            throw new Error(`Configuration of module "${name}": expected boolean/null/object, got ${typeof raw}`);
        }
        out.set(name, { enabled, config });
    }
    return out;
}
