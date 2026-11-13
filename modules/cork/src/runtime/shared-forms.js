/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Formed regions shared by every runtime handed the same translation store
 * that forms as the others do: a process the run starts again finds its
 * store hits formed by an earlier one, and takes such a region where every
 * byte forming read and every page it asked about answer as they did -- a
 * region is a function of those and of the forming options -- instead of
 * decoding it again.
 *
 * A region is many small objects (its decoded instructions): kept up to a
 * count, the ones used longest ago going first. Keyed to the store object and
 * the forming options, so what shares a store and forms alike shares these.
 */

/**
 * @typedef {{ region: import('../region.js').Region, answers: Map<number, boolean> }} Formed
 *     a region and what `translatable` answered for each page forming asked about
 * @typedef {{ get: (key: string) => Formed | undefined, set: (key: string, formed: Formed)
 *     => void, stats: () => { held: number, hits: number, added: number, dropped: number } }}
 *     SharedForms
 */

/** @type {WeakMap<object, Map<string, SharedForms>>} */
const byStore = new WeakMap();
/** The runtimes each store made for one (`alone`) was handed. @type {WeakMap<object, number>} */
const handed = new WeakMap();

/**
 * The store a runtime keeps formed regions and compiled modules beside, for
 * the runtimes handed it after: the store, counting this runtime as handed it,
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
 * @param {number} cap  regions held at most
 * @returns {SharedForms}
 */
export function createSharedForms(cap){
    /** @type {Map<string, Formed>} */
    const held = new Map();
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
        set(key, formed){
            held.delete(key);
            held.set(key, formed);
            added++;
            for (const oldest of held.keys())
            {
                if (held.size <= cap)
                {
                    break;
                }
                held.delete(oldest);
                dropped++;
            }
        },
        stats: ()=>({ held: held.size, hits, added, dropped }),
    };
}

/**
 * The shared regions of a store's runtimes that form with these options, made
 * at the first ask; none without a store or with a cap of 0.
 *
 * @param {object | null} store @param {string} options  the forming options, as text
 * @param {number} cap
 * @returns {SharedForms | null}
 */
export function sharedFormsOf(store, options, cap){
    if (store === null || typeof store !== 'object' || !(cap > 0))
    {
        return null;
    }
    let kinds = byStore.get(store);
    if (kinds === undefined)
    {
        kinds = new Map();
        byStore.set(store, kinds);
    }
    let shared = kinds.get(options);
    if (shared === undefined)
    {
        shared = createSharedForms(cap);
        kinds.set(options, shared);
    }
    return shared;
}
