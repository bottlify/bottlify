/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cache -- the run's one cache, as this process's layers see it: spaces of
 * names whose bodies every thread of the run reads in place.
 *
 * The cache itself is Cellar (`@bottlify/cellar`): its keeper is the run's, on
 * the thread that holds the run's stores, and each process reads through a
 * reader of its own, handed in by whoever builds the process
 * (`config.reader`). A layer asks for a space by name and keeps its keys
 * inside it, so two layers' names never meet.
 *
 * Without a reader -- a machine built alone, a test of one layer -- every
 * space answers a miss and keeps nothing: what a layer would have read from
 * the cache it makes again, as on its first read.
 */

import { createReader, openClient } from '@bottlify/cellar';

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
    serve: /** @type {Serve} */ (()=>null) });

/** @typedef {import('@bottlify/cellar').Reader} Reader */

/**
 * A channel one owner on a worker calls the run's keeper through, and the
 * prefix of the names it holds alone (`channelSpace`), or null where the run
 * has no cache to serve.
 *
 * @typedef {(name: string) => { channel: SharedArrayBuffer, prefix: string } | null} Serve
 */

/** Whole names a space keeps made, at most: past it it makes them again. */
const NAMES_KEPT = 1 << 16;

/**
 * The names `name/...` of the run's cache as a space, read through `reader`;
 * without one, a space that keeps nothing. Whoever holds the run's reader
 * outside a layer (the bundle's mount) takes its space here, as the layer
 * hands its own.
 *
 * @param {Reader | null | undefined} reader @param {string} name
 * @param {{ onlyCopy?: boolean, disk?: 'kept' | 'run' | 'never', idle?: 'go' | 'stay' }} [options]
 *     `onlyCopy`: bodies that cannot be made again, which never go away; `disk`:
 *     where a body may go on the disk (Cellar's `DiskPolicy`), never by default:
 *     a body the run's cache can make again is not worth a write; `idle`: `stay`
 *     for bodies read again only long after they were written (a translator's
 *     functions, at a relink), which leave only when their room is wanted
 * @returns {CacheSpace}
 */
export function cacheSpace(reader, name, { onlyCopy = false, disk = 'never', idle = 'go' } = {}){
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
        put: (key, bytes)=>reader.put(named(key), bytes, { onlyCopy, disk, idle }),
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

/**
 * The run's cache passed on by a thread that was joined to it (a process in a
 * worker of its own) to threads of its own (its executors): `adopt` takes each
 * message the thread is told, keeps what a thread joining later is handed and
 * tells it to every thread joined here; `join` is the run's `join` as seen from
 * here.
 *
 * @param {{ shared: any, segments: (SharedArrayBuffer | null)[] }} joined
 */
export function relayedJoin(joined){
    let table = joined.shared.table;
    const segments = [...joined.segments];
    /** @type {Set<(message: any) => void>} */
    const told = new Set();
    return {
        /** @param {{ segment?: number, buffer?: SharedArrayBuffer | null, table?: SharedArrayBuffer }} message */
        adopt(message){
            if (message.table !== undefined && message.table.byteLength > table.byteLength)
            {
                table = message.table;
            }
            if (message.segment !== undefined)
            {
                while (segments.length <= message.segment)
                {
                    segments.push(null);
                }
                segments[message.segment] = message.buffer ?? null;
            }
            for (const tell of told)
            {
                tell(message);
            }
        },
        /** @param {(message: any) => void} post */
        join(post){
            told.add(post);
            return {
                shared: { ...joined.shared, table }, segments: [...segments],
                leave: ()=>told.delete(post),
            };
        },
    };
}

/** A keeper call across a channel and its answer, as text. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** @param {Uint8Array} bytes */
const parsed = bytes=>(bytes.length === 0 ? undefined : JSON.parse(decoder.decode(bytes.slice())));

/**
 * What an owner left behind it in the run's cache: bodies under its names
 * past what it said it held when it went (`release`), or all it held where it
 * went without saying (its channel closed with its names still out).
 *
 * @typedef {{ prefix: string, bodies: number, bytes: number, held: number,
 *     why: 'unknown' | 'unreleased' }} OwnerTail
 */

/**
 * Serves a channel's keeper calls (`channelSpace`) on this thread's event
 * loop, one wait at a time, until it is closed. The channel is one owner's,
 * whose names begin with `owner`: let go of when it goes (`release`) or,
 * where it never said so, when its end closes the channel; what it left past
 * what it held is a tail (`onTail`).
 *
 * @param {ReturnType<typeof import('@bottlify/cellar').openServer>} server
 * @param {{ reserve: (name: string, length: number, options?: any) => any,
 *     raise: (name: string, options?: { known?: number }) => boolean,
 *     drop: (name: string) => void,
 *     release: (prefix: string) => { bodies: number, bytes: number, waiting: number } }} keeper
 * @param {{ owner: string, onTail?: (tail: OwnerTail) => void }} options
 * @returns {{ close: () => void, ended: Promise<void> }}
 */
export function serveKeeper(server, keeper, { owner, onTail = ()=>{} }){
    /** Whether the owner is still out: not released, its channel open. */
    let out = true;
    /** Whether this side closes the channel: the run going, every owner with it. */
    let closing = false;
    /**
     * Lets go of an owner's names: past the `held` it said it had, a tail;
     * `held` null where it never said, and went (a tail only where this side
     * did not close the channel).
     *
     * @param {string} prefix @param {number | null} held
     */
    const release = (prefix, held)=>{
        out = false;
        const left = keeper.release(prefix);
        const owed = held ?? 0;
        if (left.bodies > owed && !(held === null && closing))
        {
            onTail({ prefix, bodies: left.bodies - owed, bytes: left.bytes, held: owed,
                why: held === null ? 'unreleased' : 'unknown' });
        }
        return left;
    };
    /** @param {Uint8Array} request */
    const handle = request=>{
        const { op, name, length, options, held } = parsed(request);
        /** @type {any} */
        let answer = null;
        if (op === 'reserve')
        {
            answer = keeper.reserve(name, length, options ?? {});
        }
        else if (op === 'raise')
        {
            answer = keeper.raise(name, options ?? {});
        }
        else if (op === 'release')
        {
            answer = out ? release(owner, Number(held) || 0) : null;
        }
        else
        {
            keeper.drop(name);
        }
        return encoder.encode(JSON.stringify(answer));
    };
    const ended = (async()=>{
        while (!server.closed())
        {
            try
            {
                await server.serveAsync(handle);
            }
            catch {
                break;
            }
        }
        // An owner whose channel closed with its names out (its worker gone,
        // a root that never closed): all it held is let go of, and counted.
        if (out)
        {
            release(owner, null);
        }
    })();
    return {
        close: ()=>{
            closing = true;
            server.close();
        },
        ended,
    };
}

/**
 * Names of the run's cache that one owner holds alone, read and written from
 * a worker of the thread that holds the keeper (the graphics worker), its
 * keeper calls across its channel (`serveKeeper`): `name/<n>/...`, the
 * number the run's, so two owners of one kind (two roots' texels) never
 * share a name. Room is asked for ahead and not waited on (`ask` answers when it is
 * granted, `put` then writes the body in place and makes it readable), and a
 * cold body is brought back by a call the worker waits on. One channel is one
 * owner's. `adopt` takes the
 * messages of segments made and let go. `close` lets go of every name the
 * owner held, saying how many it held, so that the keeper's side counts what
 * it finds past them as a tail (`OwnerTail`).
 *
 * @param {Joined} joined
 * @param {{ channel: SharedArrayBuffer, prefix: string }} served  the owner's channel and
 *     the prefix of its names, as the keeper's side served them (`RunCache.serve`)
 */
export function channelSpace(joined, { channel, prefix }){
    const client = openClient(channel);
    /** The segments this side's reader has views of: room is asked for below them. */
    let known = joined.segments.length;
    /** Room the keeper granted, by whole name, for the next reserve of it. @type {Map<string, any>} */
    const granted = new Map();
    /** @param {any} call */
    const askNow = call=>client.ask(encoder.encode(JSON.stringify(call)), { read: parsed });
    /** @param {any} call */
    const askLater = call=>client.call(encoder.encode(JSON.stringify(call)), { read: parsed });
    /** The keys this owner put and has not let go of, as it counts them. @type {Set<string>} */
    const held = new Set();
    /** Room asked for and not answered yet, a reservation the keeper may be holding. */
    let asking = 0;
    let closed = false;
    const reader = createReader({
        shared: joined.shared, segments: joined.segments,
        keeper: {
            reserve: (whole, length, options)=>{
                const place = granted.get(whole);
                granted.delete(whole);
                return place ?? askNow({ op: 'reserve', name: whole, length, options });
            },
            raise: (whole, options)=>askNow({ op: 'raise', name: whole, options }) === true,
            raiseLater: whole=>{
                askLater({ op: 'raise', name: whole }).catch(()=>{});
            },
            drop: whole=>{
                askLater({ op: 'drop', name: whole }).catch(()=>{});
            },
        },
    });
    // Bodies a worker hands over are the only copy of them for this run: to
    // the disk when idle, never away, and nothing the next run reads.
    const names = cacheSpace(reader, prefix.slice(0, -1), { onlyCopy: true, disk: 'run' });
    /** @type {CacheSpace} */
    const space = {
        look: names.look,
        with: names.with,
        put: (key, bytes)=>{
            const kept = names.put(key, bytes);
            if (kept)
            {
                held.add(key);
            }
            return kept;
        },
        drop: key=>{
            held.delete(key);
            names.drop(key);
        },
    };
    return {
        space,
        /** This owner's names' prefix in the run's cache. */
        prefix,
        /** The bodies this owner holds, as it counts them. */
        held: ()=>held.size,
        /**
         * Room for `key`'s body of `length` bytes, asked for without waiting:
         * true once it is granted (a reserve then takes it at once), false where
         * the keeper had none.
         *
         * @param {string} key @param {number} length @returns {Promise<boolean>}
         */
        ask: async(key, length)=>{
            const whole = `${prefix}${key}`;
            asking++;
            const place = await askLater({ op: 'reserve', name: whole, length,
                options: { known, onlyCopy: true, disk: 'run' } }).finally(()=>{
                asking--;
            });
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
        /**
         * The owner goes: every name it held is let go of, after the calls it
         * sent before (a channel answers in order), and the channel closes
         * once the keeper has answered. What was there, or null where the
         * channel was gone first.
         *
         * @returns {Promise<{ bodies: number, bytes: number, waiting: number } | null>}
         */
        close: async()=>{
            if (closed)
            {
                return null;
            }
            closed = true;
            // A reservation granted and not written is the owner's too.
            const holding = held.size + granted.size + asking;
            try
            {
                return await askLater({ op: 'release', held: holding });
            }
            catch {
                return null;
            }
            finally
            {
                client.close();
            }
        },
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
         *     serve?: Serve | null } | null} config
         *     `join`: how another thread of this process (an executor) is joined to
         *     the run's cache, to read it in place too; `serve`: a channel a worker
         *     that writes the cache calls the keeper through (`channelSpace`)
         * @returns {Promise<{ space: (name: string, options?: { onlyCopy?: boolean,
         *     disk?: 'kept' | 'run' | 'never', idle?: 'go' | 'stay' }) => CacheSpace,
         *     join: Join,
         *     serve: Serve }>}
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
                /** @param {string} name @param {{ onlyCopy?: boolean,
                 *     disk?: 'kept' | 'run' | 'never', idle?: 'go' | 'stay' }} [options] */
                space: (name, options)=>cacheSpace(given, name, options),
                join: post=>join?.(post) ?? null,
                serve: name=>serve?.(name) ?? null,
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
