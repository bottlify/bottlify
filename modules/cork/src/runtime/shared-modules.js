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
 *
 * Its code is one whatever instances run it, so the keeping pays for it, from
 * the charge it is made with (the machine's memory), and no runtime running
 * it does: a module the charge has no room for is not kept.
 */

/** The runtimes each store made for one (`alone`) was handed. @type {WeakMap<object, number>} */
const handed = new WeakMap();

/**
 * The store a runtime keeps its compiled modules beside, for the runtimes
 * handed it after: the store, counting this runtime as handed it,
 * or null where none would take them. A store made for one runtime (`alone`: a
 * proxy a process or an executor in a worker made for itself) is kept beside
 * only from the second runtime handed it on -- a child run beside its parent
 * in the parent's worker, whose siblings run beside it after -- and kept
 * nothing beside for the first, which shares it with no one.
 *
 * @param {object | null} store
 * @returns {object | null}
 */
export function sharedStoreOf(store){
    if (store === null || typeof store !== 'object')
    {
        return null;
    }
    if (/** @type {{ alone?: boolean }} */ (store).alone !== true)
    {
        return store;
    }
    const runtimes = (handed.get(store) ?? 0) + 1;
    handed.set(store, runtimes);
    return runtimes > 1 ? store : null;
}

/**
 * @typedef {{ get: (key: string, now?: number) => { module: WebAssembly.Module, bytes: number }
 *         | undefined,
 *     set: (key: string, module: WebAssembly.Module, bytes: number, now?: number) => boolean,
 *     sweep: (now: number, age: number) => void,
 *     stats: () => { held: number, bytes: number, hits: number, added: number,
 *         dropped: number }, paid: boolean }} SharedModules
 */

/** By store, then by the charge that pays for them (`UNPAID` for none).
 * @type {WeakMap<object, WeakMap<object, SharedModules>>} */
const byStore = new WeakMap();
const UNPAID = {};

/** @typedef {{ take: (bytes: number) => boolean, give: (bytes: number) => void }} Charge */

/**
 * @param {number} cap  wasm bytes held at most
 * @param {Charge | null} [charge]  what the modules held are taken from
 * @returns {SharedModules}
 */
export function createSharedModules(cap, charge = null){
    /** In the order used, each with when it was used last.
     * @type {Map<string, { module: WebAssembly.Module, bytes: number, at: number }>} */
    const held = new Map();
    let bytes = 0;
    let hits = 0;
    let added = 0;
    let dropped = 0;
    return {
        get(key, now = 0){
            const one = held.get(key);
            if (one === undefined)
            {
                return undefined;
            }
            // Used now: the last to go.
            held.delete(key);
            one.at = now;
            held.set(key, one);
            hits++;
            return one;
        },
        set(key, module, size, now = 0){
            if (held.has(key))
            {
                return held.get(key)?.module === module;
            }
            if (size > cap || (charge !== null && !charge.take(size)))
            {
                return false;
            }
            held.set(key, { module, bytes: size, at: now });
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
                charge?.give(one.bytes);
                dropped++;
            }
            return held.has(key);
        },
        // The ones no runtime has taken for `age` go, as a runtime lets go
        // its own modules untouched that long (`coldMs`): kept here, they
        // held the code a runtime let go alive. In the order used, so the
        // oldest come first.
        sweep(now, age){
            for (const [oldest, one] of held)
            {
                if (now - one.at < age)
                {
                    break;
                }
                held.delete(oldest);
                bytes -= one.bytes;
                charge?.give(one.bytes);
                dropped++;
            }
        },
        stats: ()=>({ held: held.size, bytes, hits, added, dropped }),
        // Whether what it keeps is paid for here, and so by no runtime running it.
        paid: charge !== null,
    };
}

/**
 * The shared modules of a store paid for by `charge`, made at their first ask;
 * none without a store or with a cap of 0. Two runs on one store, each with a
 * memory of its own (a machine rebuilt, a tool's runs one after another), keep
 * apart: what one keeps is paid in its memory and never handed to the other.
 *
 * @param {object | null} store @param {number} cap
 * @param {Charge | null} [charge]  what its modules are taken from: one object
 *     for every runtime of a run
 * @returns {SharedModules | null}
 */
export function sharedModulesOf(store, cap, charge = null){
    if (store === null || typeof store !== 'object' || !(cap > 0))
    {
        return null;
    }
    let byCharge = byStore.get(store);
    if (byCharge === undefined)
    {
        byCharge = new WeakMap();
        byStore.set(store, byCharge);
    }
    let shared = byCharge.get(charge ?? UNPAID);
    if (shared === undefined)
    {
        shared = createSharedModules(cap, charge);
        byCharge.set(charge ?? UNPAID, shared);
    }
    return shared;
}
