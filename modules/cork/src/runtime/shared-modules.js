/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compiled batch modules shared by every runtime handed the same translation
 * store: a process the run starts again (ngen's `mscorsvw.exe` once an
 * assembly, a shader compiler once a shader) finds the modules an earlier one
 * compiled, by the key the store keeps their bytes under (`moduleKey`, which
 * names their digest), and instantiates them over its own memory without
 * reading, copying or compiling the bytes again. The compiled code comes
 * along with the module: the functions V8 compiled lazily and tiered up for
 * the earlier process run as they are, where a module compiled again starts
 * over in its baseline tier.
 *
 * Held strongly, so a module outlives the process that made it, up to a cap
 * of wasm bytes; past it the modules used longest ago go. Keyed to the store
 * object, so what shares a store shares these and nothing else does.
 */

/**
 * @typedef {{ get: (key: string) => { module: WebAssembly.Module, bytes: number } | undefined,
 *     set: (key: string, module: WebAssembly.Module, bytes: number) => void,
 *     stats: () => { held: number, bytes: number, hits: number, added: number,
 *         dropped: number } }} SharedModules
 */

/** @type {WeakMap<object, SharedModules>} */
const byStore = new WeakMap();

/**
 * @param {number} cap  wasm bytes held at most
 * @returns {SharedModules}
 */
export function createSharedModules(cap){
    /** @type {Map<string, { module: WebAssembly.Module, bytes: number }>} */
    const held = new Map();
    let bytes = 0;
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
        set(key, module, size){
            if (held.has(key) || size > cap)
            {
                return;
            }
            held.set(key, { module, bytes: size });
            bytes += size;
            added++;
            for (const [oldest, one] of held)
            {
                if (bytes <= cap)
                {
                    break;
                }
                held.delete(oldest);
                bytes -= one.bytes;
                dropped++;
            }
        },
        stats: ()=>({ held: held.size, bytes, hits, added, dropped }),
    };
}

/**
 * The shared modules of a store, made at its first ask; none without a store
 * or with a cap of 0.
 *
 * @param {object | null} store @param {number} cap
 * @returns {SharedModules | null}
 */
export function sharedModulesOf(store, cap){
    if (store === null || typeof store !== 'object' || !(cap > 0))
    {
        return null;
    }
    let shared = byStore.get(store);
    if (shared === undefined)
    {
        shared = createSharedModules(cap);
        byStore.set(store, shared);
    }
    return shared;
}
