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
