/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Objects by key, held weakly: what keeps one is whoever else uses it, and a
 * key whose object was collected goes with it. The runtime keeps its stored
 * batches' instances in one, so a stored region finds its batch's instance
 * while any region of that batch runs, and a batch a relink took every region
 * from is let go (a browser collects an instance once nothing uses it; node's
 * V8 keeps every instance that imports a table for as long as the table).
 *
 * @template {object} T
 */
export function createWeakInstances(){
    /** @type {Map<string, WeakRef<T>>} */
    const held = new Map();
    const gone = new FinalizationRegistry((/** @type {string} */ key)=>{
        if (held.get(key)?.deref() === undefined)
        {
            held.delete(key);
        }
    });
    return {
        /** @param {string} key @returns {T | undefined} */
        get: key=>held.get(key)?.deref(),
        /** @param {string} key */
        has: key=>held.get(key)?.deref() !== undefined,
        /** @param {string} key @param {T} instance */
        set(key, instance){
            held.set(key, new WeakRef(instance));
            gone.register(instance, key);
        },
        /** Forgets one, collected or not: a key taken again names a new object. @param {string} key */
        delete(key){
            held.delete(key);
        },
        /** How many are still reachable. Reading one holds it to the end of the turn. */
        live: ()=>[...held.values()].filter(ref=>ref.deref() !== undefined).length,
        /** How many keys are still there, collected or not yet swept. */
        size: ()=>held.size,
    };
}
