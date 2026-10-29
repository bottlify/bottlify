/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The per-bundle translation cache: a region's module is a pure function
 * of its bytes, its entry, the layout and this emitter, so the second run
 * of a program translates nothing it ran the first time. A region is still
 * formed (a decode, cheap) on every run, which is what checks its bytes;
 * what the store saves is the emitting and the encoding, the costly part.
 *
 * A region is kept under its entry, the x87 top it is entered at and the
 * run's modes -- what a run knows before it forms it. What forming made of
 * it is in its record (`RegionShape`): where it stopped at other regions'
 * blocks and which callees it formed in depend on what the run had
 * translated by then, and a run that formed it otherwise forms it again as
 * the record says before it compares the bytes.
 *
 * A record is the module's bytes behind a small header of what the
 * runtime needs to publish it without the emitter: the block starts and
 * their labels, the labels cut, the x87 top it was compiled for, the
 * instruction count, the shape.
 */

/**
 * Bumped whenever the emitter changes what it emits for the same bytes, or
 * the record's format changes: a record of another version is a miss.
 */
export const CACHE_VERSION = 127;

const MAGIC = 0x4b524f43; // 'CORK'

/**
 * What the emitter reads besides a region's bytes, its entry and the layout:
 * the host's features and the settings that change the code it emits -- a
 * store taken with other ones must not answer.
 *
 * @param {{ simd: boolean, tailCalls: boolean, defaultNaNNegative?: boolean,
 *     armHost?: boolean }} features
 * @param {string} variant  the emitting settings, as the runtime names them
 */
const flagsOf = (features, variant)=>(features.simd ? 's' : '-') + (features.tailCalls ? 't' : '-')
    + (features.defaultNaNNegative ? 'n' : '-') + (features.armHost ? 'a' : '') + variant;

/**
 * @param {{ version: number, features: { simd: boolean, tailCalls: boolean,
 *     defaultNaNNegative?: boolean,
 *     armHost?: boolean }, variant?: string, layoutId: string, bundleId: string,
 *     entry: number, kept: string }} of  kept: what the region is kept under at its entry
 */
export function cacheKey({ version, features, variant = '', layoutId, bundleId, entry, kept }){
    return `cork/${version}${flagsOf(features, variant)}/${layoutId}/${bundleId}/`
        + `${entry.toString(16)}/${kept}`;
}

/**
 * What a module's bytes hash to, the last part of its `moduleKey`: two FNV-1a
 * lanes over the bytes, 64 bits with their length beside it. Every batch of a
 * bundle shares one namespace, and a record whose module key another batch's
 * bytes answered would run the other batch's code.
 *
 * @param {Uint8Array} bytes
 */
export function moduleDigest(bytes){
    let low = 0x811c9dc5;
    let high = 0x050c5d1f;
    for (let i = 0; i < bytes.length; i++)
    {
        low = Math.imul(low ^ bytes[i], 0x01000193);
        high = Math.imul(high ^ bytes[i] ^ i & 0xff, 0x01000193);
    }
    return `${(high >>> 0).toString(16)}${(low >>> 0).toString(16).padStart(8, '0')}`
        + `-${bytes.length.toString(16)}`;
}

/**
 * The key a batch module's bytes are kept under: named by what they hash to,
 * so every region record of the batch names the same bytes, and a batch of
 * other regions later never takes a record's name.
 *
 * @param {{ version: number, features: { simd: boolean, tailCalls: boolean,
 *     defaultNaNNegative?: boolean,
 *     armHost?: boolean }, variant?: string, layoutId: string, bundleId: string }} of
 * @param {Uint8Array} bytes
 * @param {string} [digest]  `moduleDigest` of the bytes, where it was taken already (a
 *     translation worker takes it: over a module of megabytes it held the engine thread)
 */
export function moduleKey({ version, features, variant = '', layoutId, bundleId }, bytes,
    digest = moduleDigest(bytes))
{
    return `cork/${version}${flagsOf(features, variant)}/${layoutId}/${bundleId}/module/${digest}`;
}

/**
 * What forming made of a stored region, and what it was compiled as: its
 * bytes' hash, the blocks it left to other regions (`stops`), by indirect
 * call the callees formed in (`targets`), its x87 precision and float
 * arithmetic, whether that precision is one its run moved the entry to
 * (`moved`), whether its entries test the x87 stack's shape (`checked`
 * not), and whether its loops' blocks have entries of their own (`copies`).
 *
 * @typedef {{ hash: string, stops?: number[], targets?: [number, number[]][],
 *     wide?: boolean, narrow?: boolean, floats?: boolean, moved?: boolean,
 *     checked?: boolean, copies?: boolean }} RegionShape
 */

/**
 * @typedef {Object} CachedRegion
 * @property {Uint8Array} module       the wasm module holding the region; empty in a
 *     record whose module is a batch's, kept apart under `moduleKey`
 * @property {string} [exportName]     the region's function in the module (`r0` when absent)
 * @property {string} [moduleKey]      where the batch module's bytes are kept
 * @property {boolean} [linked]        the module is a relinked one, which gathers many regions
 * @property {[number, number][]} labels  block start → label
 * @property {number[]} cut            labels of blocks that leave at once
 * @property {number[]} [closed]       starts of the blocks inside the loops that have no entry
 *     (`closed` of a translation)
 * @property {number} entryTop
 * @property {number} instructions
 * @property {RegionShape} [shape]     a region's, not a module's
 */

/** @param {CachedRegion} region @returns {Uint8Array} */
export function packRegion(region, version = CACHE_VERSION){
    const header = new TextEncoder().encode(JSON.stringify({
        labels: region.labels, cut: region.cut, entryTop: region.entryTop,
        instructions: region.instructions,
        ...(region.exportName === undefined ? {} : { exportName: region.exportName }),
        ...(region.moduleKey === undefined ? {} : { moduleKey: region.moduleKey }),
        ...(region.linked ? { linked: true } : {}),
        ...(region.closed?.length ? { closed: region.closed } : {}),
        ...(region.shape === undefined ? {} : { shape: region.shape }),
    }));
    const out = new Uint8Array(12 + header.length + region.module.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, version, true);
    view.setUint32(8, header.length, true);
    out.set(header, 12);
    out.set(region.module, 12 + header.length);
    return out;
}

/**
 * The region back, or null for bytes of another version or shape.
 *
 * @param {Uint8Array} bytes @returns {CachedRegion | null}
 */
export function unpackRegion(bytes, version = CACHE_VERSION){
    if (bytes.length < 12)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== version)
    {
        return null;
    }
    const length = view.getUint32(8, true);
    if (12 + length > bytes.length)
    {
        return null;
    }
    try
    {
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length)));
        if (!Array.isArray(header.labels) || !Array.isArray(header.cut)
            || typeof header.entryTop !== 'number' || typeof header.instructions !== 'number')
        {
            return null;
        }
        return {
            module: bytes.subarray(12 + length), labels: header.labels, cut: header.cut,
            entryTop: header.entryTop, instructions: header.instructions,
            ...(typeof header.exportName === 'string' ? { exportName: header.exportName } : {}),
            ...(typeof header.moduleKey === 'string' ? { moduleKey: header.moduleKey } : {}),
            ...(header.linked === true ? { linked: true } : {}),
            ...(Array.isArray(header.closed) ? { closed: header.closed } : {}),
            ...(typeof header.shape?.hash === 'string' ? { shape: header.shape } : {}),
        };
    }
    catch {
        return null;
    }
}

/**
 * Of a store's records, the ones a seed for this emitter needs: every region
 * record of this version and the modules they name. A batch's module whose
 * regions a relink has moved since is named by none of them -- on a load of
 * fifteen hundred functions that was half the store's bytes -- and a record
 * of another version could never be read back; both stay behind.
 *
 * @param {Iterable<[string, Uint8Array]>} records  the store's names and bytes
 * @param {(key: string) => string} nameOf  the name the store keeps a key under
 * @returns {[string, Uint8Array][]}
 */
export function seedRecords(records, nameOf){
    const all = [...records];
    /** @type {Set<string>} */
    const named = new Set();
    /** @type {Set<string>} */
    const regions = new Set();
    for (const [name, bytes] of all)
    {
        const region = unpackRegion(bytes);
        // A module's record has no labels; a region's has one per block.
        if (region !== null && region.labels.length > 0)
        {
            regions.add(name);
            if (region.moduleKey !== undefined)
            {
                named.add(nameOf(region.moduleKey));
            }
        }
    }
    return all.filter(([name])=>regions.has(name) || named.has(name));
}

/**
 * A store in memory: for tests, and for a run whose host has nowhere to
 * keep translations across starts.
 *
 * @returns {import('../../../core/src/layers/cpu/engine.js').TranslationStore
 *     & { size: () => number }}
 */
export function memoryTranslationStore(){
    /** @type {Map<string, Uint8Array>} */
    const records = new Map();
    return {
        get: async key=>records.get(key) ?? null,
        put: async(key, bytes)=>{
            records.set(key, bytes);
        },
        size: ()=>records.size,
    };
}
