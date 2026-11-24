/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cache -- the run's one cache, as this process's layers see it: spaces of
 * names whose bodies every thread of the run reads in place.
 *
 * The cache itself is Cellar (`vendor/cellar/`): its keeper is the run's, on
 * the thread that holds the run's stores, and each process reads through a
 * reader of its own, handed in by whoever builds the process
 * (`config.reader`). A layer asks for a space by name and keeps its keys
 * inside it, so two layers' names never meet.
 *
 * Without a reader -- a machine built alone, a test of one layer -- every
 * space answers a miss and keeps nothing: what a layer would have read from
 * the cache it makes again, as on its first read.
 */

/**
 * One layer's names in the cache.
 *
 * @typedef {Object} CacheSpace
 * @property {(key: string) => 'hot' | 'cold' | null} look  where the body is, unread
 * @property {<T>(key: string, read: (body: Uint8Array) => T, options?: { wait?: boolean })
 *     => T | undefined} with  the body read in place inside `read`, never kept past it;
 *     undefined on a miss
 * @property {(key: string, bytes: Uint8Array) => boolean} put  a copy kept: false where there
 *     was no room
 * @property {(key: string) => void} drop
 */

/** What a space is with no cache under it. @type {CacheSpace} */
const NOTHING = Object.freeze({
    look: ()=>null,
    with: ()=>undefined,
    put: ()=>false,
    drop: ()=>{},
});

/**
 * The cache's api with no cache under it, as `create` answers without a
 * reader: for a test or a tool that builds a layer alone.
 */
export const noCache = Object.freeze({ space: ()=>NOTHING });

/** @typedef {import('../../../vendor/cellar/cellar.js').Reader} Reader */

/** Whole names a space keeps made, at most: past it it makes them again. */
const NAMES_KEPT = 1 << 16;

/**
 * The names `name/...` of the run's cache as a space, read through `reader`;
 * without one, a space that keeps nothing. Whoever holds the run's reader
 * outside a layer (the bundle's mount) takes its space here, as the layer
 * hands its own.
 *
 * @param {Reader | null | undefined} reader @param {string} name
 * @param {{ onlyCopy?: boolean }} [options]  `onlyCopy`: bodies that cannot be
 *     made again, which go to the disk and never away
 * @returns {CacheSpace}
 */
export function cacheSpace(reader, name, { onlyCopy = false } = {}){
    if (!reader)
    {
        return NOTHING;
    }
    /**
     * Each key's whole name, made once: a hit is then a lookup by the same
     * string, whose hash the engine keeps (a key is a caller's own string
     * kept the same way, a block's or a range's).
     *
     * @type {Map<string, string>}
     */
    const names = new Map();
    /** @param {string} key */
    const named = key=>{
        let whole = names.get(key);
        if (whole === undefined)
        {
            if (names.size >= NAMES_KEPT)
            {
                names.clear();
            }
            whole = `${name}/${key}`;
            names.set(key, whole);
        }
        return whole;
    };
    return {
        look: key=>reader.look(named(key)),
        with: (key, read, options)=>reader.with(named(key), read, options),
        put: (key, bytes)=>reader.put(named(key), bytes, { onlyCopy }),
        drop: key=>reader.drop(named(key)),
    };
}

/** The cache layer's module for one graph; see `defaultModules`. */
export function createCacheModule(){
    /** @type {Reader | null} */
    let reader = null;
    let made = false;

    return {
        name: 'cache',
        version: '0.1.0',
        requires: /** @type {readonly string[]} */ (['log']),

        /**
         * @param {{ reader?: Reader | null } | null} config
         * @returns {Promise<{ space: (name: string,
         *     options?: { onlyCopy?: boolean }) => CacheSpace }>}
         */
        async create(config){
            reader = config?.reader ?? null;
            made = true;
            const given = reader;
            if (given === null)
            {
                return noCache;
            }
            return {
                /** @param {string} name @param {{ onlyCopy?: boolean }} [options] */
                space: (name, options)=>cacheSpace(given, name, options),
            };
        },

        diagnostics(){
            return {
                name: 'cache',
                version: '0.1.0',
                status: /** @type {'created' | 'ready'} */ (made && reader !== null ? 'ready' : 'created'),
                metrics: {
                    // The bodies are the run's, held by its keeper and counted
                    // there; this process holds none of its own.
                    bytesHeld: {},
                    reader: reader?.figures() ?? 'no cache: every read is a miss',
                },
                issues: [],
            };
        },

        async dispose(){
            reader = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const cacheModule = createCacheModule();
