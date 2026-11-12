/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What every runtime handed the same translation store shares beyond the
 * store's records: a process the run starts again (ngen's `mscorsvw.exe` once
 * an assembly, a shader compiler once a shader) takes what an earlier one
 * made in this thread rather than making it again.
 *
 * - `modules`: compiled batch modules, by the key the store keeps their bytes
 *   under (`moduleKey`, which names their digest). A store hit instantiates
 *   one over its own memory without reading, copying or compiling the bytes,
 *   and the code V8 compiled lazily and tiered up for the earlier process
 *   comes along with it.
 * - `formed`: formed regions, by how they were formed (`formedMemo`). A hit
 *   whose every byte forming read and every page it asked about answer as
 *   they did takes the region formed earlier instead of decoding it again: a
 *   region is a function of those and of the forming options.
 *
 * Held strongly, so they outlive the process that made them, each up to a cap
 * (wasm bytes, regions); past it the ones used longest ago go. Keyed to the
 * store object, so what shares a store shares these and nothing else does.
 */

/**
 * Values by key, least recently used first, up to `cap` of their sizes.
 *
 * @template T
 * @typedef {{ get: (key: string) => { value: T, size: number } | undefined,
 *     set: (key: string, value: T, size: number) => void,
 *     stats: () => { held: number, size: number, hits: number, added: number,
 *         dropped: number } }} Held
 */

/**
 * @template T
 * @param {number} cap  the sizes held at most
 * @returns {Held<T>}
 */
export function createHeld(cap){
    /** @type {Map<string, { value: T, size: number }>} */
    const held = new Map();
    let total = 0;
    let hits = 0;
    let added = 0;
    let dropped = 0;
    return {
        get(key){
            const one = held.get(key);
            if (one === undefined)
            {
                return undefined;
            }
            // Used now: the last to go.
            held.delete(key);
            held.set(key, one);
            hits++;
            return one;
        },
        set(key, value, size){
            const was = held.get(key);
            if (was !== undefined)
            {
                held.delete(key);
                total -= was.size;
            }
            if (size > cap)
            {
                return;
            }
            held.set(key, { value, size });
            total += size;
            added++;
            for (const [oldest, one] of held)
            {
                if (total <= cap)
                {
                    break;
                }
                held.delete(oldest);
                total -= one.size;
                dropped++;
            }
        },
        stats: ()=>({ held: held.size, size: total, hits, added, dropped }),
    };
}

/**
 * @typedef {{ modules: Held<WebAssembly.Module> | null,
 *     formed: Map<string, Held<any>> }} RunShared
 */

/** @type {WeakMap<object, RunShared>} */
const byStore = new WeakMap();

/**
 * What the runtimes sharing a store share, made at its first ask; null
 * without a store.
 *
 * @param {object | null} store
 * @param {{ moduleBytes: number }} caps  the wasm bytes of compiled modules held (0: none)
 * @returns {RunShared | null}
 */
export function runSharedOf(store, { moduleBytes }){
    if (store === null || typeof store !== 'object')
    {
        return null;
    }
    let shared = byStore.get(store);
    if (shared === undefined)
    {
        shared = { modules: moduleBytes > 0 ? createHeld(moduleBytes) : null, formed: new Map() };
        byStore.set(store, shared);
    }
    return shared;
}

/**
 * The formed regions of the runtimes sharing a store that form with the same
 * options (`fingerprint`), up to `cap` regions; null for a cap of 0.
 *
 * @param {RunShared | null} shared @param {string} fingerprint @param {number} cap
 * @returns {Held<any> | null}
 */
export function formedMemo(shared, fingerprint, cap){
    if (shared === null || !(cap > 0))
    {
        return null;
    }
    let memo = shared.formed.get(fingerprint);
    if (memo === undefined)
    {
        memo = createHeld(cap);
        shared.formed.set(fingerprint, memo);
    }
    return memo;
}
