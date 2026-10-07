/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's translation store, across a link (roadmap/v2, stage 2): one store
 * for every process of the run, kept by the system's thread, and asked from a
 * process in a worker of its own.
 *
 * It is one because it cannot be several: a directory store holds its records
 * file through a synchronous handle, and a second handle on the same file is
 * refused while the first is open. A process that opened none of its own
 * translated everything on every run, its first one included where every
 * process runs in a worker.
 *
 * A lookup blocks for its answer, as the store's own synchronous read does in
 * the thread that holds it: the translator publishes a batch in the call that
 * formed it when every lookup is answered at once (`getNow`), and a batch's
 * lookups cross together (`getManyNow`), one wait for the batch. A record
 * crosses as it is put and is not waited on.
 */

/** @typedef {import('../engine.js').TranslationStore} TranslationStore */

/**
 * The link's handlers that answer for the run's store.
 *
 * @param {TranslationStore} store
 */
export function storeHandlers(store){
    return {
        store: {
            /**
             * Every record named, in order: its bytes, or null for none. At
             * once where the store answers so, which a directory store
             * opened and holding its records file does.
             *
             * @param {string[]} keys
             * @returns {(Uint8Array | null)[] | Promise<(Uint8Array | null)[]>}
             */
            getMany(keys){
                const now = keys.map(key=>store.getNow?.(key));
                if (now.every(answer=>answer !== undefined))
                {
                    return /** @type {(Uint8Array | null)[]} */ (now);
                }
                return Promise.all(keys.map((key, i)=>(now[i] === undefined
                    ? store.get(key) : /** @type {Uint8Array | null} */ (now[i]))));
            },
            /** @param {string} key */
            get: key=>store.get(key),
            /** @param {string} key @param {Uint8Array} bytes */
            put: (key, bytes)=>store.put(key, bytes),
        },
    };
}

/**
 * The run's store as a process across a link sees it.
 *
 * @param {{ ask: (method: string, args: any[]) => any,
 *     call: (method: string, args: any[]) => Promise<any> }} link
 *     `ask` blocks for `storeHandlers`' answer, `call` does not
 * @returns {TranslationStore & {
 *     getManyNow: (keys: string[]) => (Uint8Array | null)[] | undefined }}
 */
export function remoteStore(link){
    /**
     * @param {string[]} keys
     * @returns {(Uint8Array | null)[] | undefined} undefined where the link cannot answer, and
     *     the translator asks `get`
     */
    const getManyNow = keys=>{
        try
        {
            return link.ask('getMany', [keys]);
        }
        catch {
            return undefined;
        }
    };
    return {
        getManyNow,
        /** @param {string} key */
        getNow: key=>getManyNow([key])?.[0],
        /** @param {string} key */
        get: key=>link.call('get', [key]).catch(()=>null),
        /** @param {string} key @param {Uint8Array} bytes */
        put: async(key, bytes)=>{
            link.call('put', [key, bytes]).catch(()=>{});
        },
    };
}
