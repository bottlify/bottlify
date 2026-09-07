/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The network, when it is only this runtime.
 *
 * The transport is injected for the same reason the GPU device and the block
 * store are: what a socket can actually reach is the embedding application's
 * decision, not ours, and a layer that reached for BroadcastChannel or a
 * WebSocket itself could not be tested and could not be replaced. So this is a
 * contract with one implementation in the tree -- the one the tests drive, and
 * the one a single-tab run gets.
 *
 * The contract is three verbs, and it is deliberately about *addresses* rather
 * than about sockets. An adapter owns a name space and delivers to whatever is
 * listening on a name; everything a socket is -- state, buffers, whether a peer
 * has hung up -- belongs to the registry above and would only be duplicated,
 * differently, in every adapter that had to know it.
 *
 *     bind(key, endpoint) -> boolean   false when the address is taken
 *     unbind(key)
 *     find(key) -> endpoint | null
 *
 * An endpoint is whatever the registry put there. The adapter never looks
 * inside one.
 */

/**
 * @typedef {Object} Adapter
 * @property {(key: string, endpoint: any) => boolean} bind
 * @property {(key: string) => void} unbind
 * @property {(key: string) => any} find
 */

/**
 * An address space held in this runtime.
 *
 * @returns {Adapter}
 */
export function createLoopbackAdapter(){
    /** @type {Map<string, any>} */
    const bound = new Map();

    return {
        bind(key, endpoint){
            if (bound.has(key))
            {
                return false;
            }
            bound.set(key, endpoint);
            return true;
        },

        unbind(key){
            bound.delete(key);
        },

        find: key=>bound.get(key) ?? null,
    };
}
