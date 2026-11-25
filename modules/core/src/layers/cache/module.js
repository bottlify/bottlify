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

import { createReader, openClient } from '../../../vendor/cellar/cellar.js';

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

/**
 * What a thread is handed to read the run's cache through a reader of its
 * own (`join`): the index and the segments as they are now; the segments made
 * and let go after come to it as messages, which its reader adopts.
 *
 * @typedef {{ shared: any, segments: (SharedArrayBuffer | null)[] }} Joined
 */

/**
 * Joins a thread to the run's cache, its messages posted through `post`: what
 * it makes its reader over, and `leave`, after which it is told nothing more.
 *
 * @typedef {(post: (message: any) => void) => (Joined & { leave: () => void }) | null} Join
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
export const noCache = Object.freeze({ space: ()=>NOTHING, join: /** @type {Join} */ (()=>null),
    serve: ()=>null });

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

/**
 * The names `name/...` of the run's cache, read from a thread that only reads
 * them (an executor's): a reader over what `join` handed it, which asks the
 * keeper nothing. A cold body or a name past what it was told is a miss, and
 * `put` keeps nothing: what such a thread wants kept, it asks of whoever
 * joined it. `adopt` takes the messages of segments made and let go.
 *
 * @param {Joined} joined @param {string} name
 * @returns {{ space: CacheSpace, adopt: (message: any) => void }}
 */
export function joinedSpace(joined, name){
    const reader = createReader({
        shared: joined.shared, segments: joined.segments,
        keeper: {
            reserve: ()=>null,
            raise: ()=>false,
            raiseLater: ()=>{},
            drop: ()=>{},
        },
    });
    const space = cacheSpace(reader, name);
    return {
        space: { ...space, put: ()=>false, drop: ()=>{} },
        adopt: message=>reader.adopt(message),
    };
}

/** A keeper call across a channel and its answer, as text. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** @param {Uint8Array} bytes */
const parsed = bytes=>(bytes.length === 0 ? undefined : JSON.parse(decoder.decode(bytes.slice())));

/**
 * Serves a channel's keeper calls (`channelSpace`) on this thread's event
 * loop, one wait at a time, until it is closed.
 *
 * @param {ReturnType<typeof import('../../../vendor/cellar/cellar.js').openServer>} server
 * @param {{ reserve: (name: string, length: number, options?: any) => any,
 *     raise: (name: string) => boolean, drop: (name: string) => void }} keeper
 * @returns {{ close: () => void }}
 */
export function serveKeeper(server, keeper){
    /** @param {Uint8Array} request */
    const handle = request=>{
        const { op, name, length, options } = parsed(request);
        const answer = op === 'reserve' ? keeper.reserve(name, length, options ?? {})
            : op === 'raise' ? keeper.raise(name)
                : (keeper.drop(name), null);
        return encoder.encode(JSON.stringify(answer));
    };
    (async()=>{
        while (!server.closed())
        {
            try
            {
                await server.serveAsync(handle);
            }
            catch {
                return;
            }
        }
    })();
    return { close: ()=>server.close() };
}

/**
 * The names `name/...` of the run's cache, read and written from a worker of
 * the thread that holds the keeper (the graphics worker), its keeper calls
 * across `channel` (`serveKeeper`): room is asked for ahead and not waited on
 * (`ask` answers when it is granted, `put` then writes the body in place and
 * makes it readable), and a cold body is brought back by a call the worker
 * waits on. `adopt` takes the messages of segments made and let go.
 *
 * @param {Joined} joined @param {SharedArrayBuffer} channel @param {string} name
 */
export function channelSpace(joined, channel, name){
    const client = openClient(channel);
    /** The segments this side's reader has views of: room is asked for below them. */
    let known = joined.segments.length;
    /** Room the keeper granted, by whole name, for the next reserve of it. @type {Map<string, any>} */
    const granted = new Map();
    /** @param {any} call */
    const askNow = call=>client.ask(encoder.encode(JSON.stringify(call)), { read: parsed });
    /** @param {any} call */
    const askLater = call=>client.call(encoder.encode(JSON.stringify(call)), { read: parsed });
    const reader = createReader({
        shared: joined.shared, segments: joined.segments,
        keeper: {
            reserve: (whole, length, options)=>{
                const place = granted.get(whole);
                granted.delete(whole);
                return place ?? askNow({ op: 'reserve', name: whole, length, options });
            },
            raise: whole=>askNow({ op: 'raise', name: whole }) === true,
            raiseLater: whole=>{
                askLater({ op: 'raise', name: whole }).catch(()=>{});
            },
            drop: whole=>{
                askLater({ op: 'drop', name: whole }).catch(()=>{});
            },
        },
    });
    // Bodies a worker hands over are the only copy of them: to the disk when
    // idle, never away.
    const space = cacheSpace(reader, name, { onlyCopy: true });
    return {
        space,
        /**
         * Room for `key`'s body of `length` bytes, asked for without waiting:
         * true once it is granted (a reserve then takes it at once), false where
         * the keeper had none.
         *
         * @param {string} key @param {number} length @returns {Promise<boolean>}
         */
        ask: async(key, length)=>{
            const whole = `${name}/${key}`;
            const place = await askLater({ op: 'reserve', name: whole, length,
                options: { known, onlyCopy: true } });
            if (place === null || place === undefined)
            {
                return false;
            }
            granted.set(whole, place);
            return true;
        },
        /** @param {string} key @param {Uint8Array} bytes */
        put: (key, bytes)=>space.put(key, bytes),
        adopt: (/** @type {any} */ message)=>{
            reader.adopt(message);
            if (message?.segment !== undefined && message.buffer)
            {
                known = Math.max(known, message.segment + 1);
            }
        },
        close: ()=>client.close(),
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
         * @param {{ reader?: Reader | null, join?: Join | null,
         *     serve?: (() => SharedArrayBuffer) | null } | null} config
         *     `join`: how another thread of this process (an executor) is joined to
         *     the run's cache, to read it in place too; `serve`: a channel a worker
         *     that writes the cache calls the keeper through (`channelSpace`)
         * @returns {Promise<{ space: (name: string,
         *     options?: { onlyCopy?: boolean }) => CacheSpace, join: Join,
         *     serve: () => SharedArrayBuffer | null }>}
         */
        async create(config){
            reader = config?.reader ?? null;
            made = true;
            const given = reader;
            if (given === null)
            {
                return noCache;
            }
            const join = config?.join ?? null;
            const serve = config?.serve ?? null;
            return {
                /** @param {string} name @param {{ onlyCopy?: boolean }} [options] */
                space: (name, options)=>cacheSpace(given, name, options),
                join: post=>join?.(post) ?? null,
                serve: ()=>serve?.() ?? null,
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
