/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's translation store as another executor of a process reaches it:
 * the process holds the store, the executor's translator asks it across the
 * executor's worker (`answerStoreAsks` on the process's side, `storeClient` on
 * the executor's).
 *
 * A record looked up crossed as a copy to each executor that asked for it. A
 * record whose bytes never change under its key - a batch's module, named by
 * what its bytes hash to, which the translator asks for as `fixed` - is put
 * once into the run's cache instead (`STORE_SPACE`), and every executor of the
 * process reads it there in place, the second and later ones without asking
 * the process at all. A batch module asked by each executor in turn was the
 * largest part of what executors were sent.
 */

import { readPieces } from './translation-store.js';
import { unframe } from './record-frame.js';
import { joinedSpace, relayedJoin } from '../../cache/module.js';

/**
 * The names of the run's cache the process puts those records under, read by
 * every executor of the process.
 */
export const STORE_SPACE = 'translations';

/**
 * The names of the run's cache the translator's emitted functions are kept
 * under (`KeptStore`), and how: they stay however long idle - one is read
 * again only at a relink, long after it was written - and leave when their
 * room is wanted, never to a disk, since one is made again by emitting it.
 */
export const KEPT_SPACE = 'cork';
export const KEPT_OPTIONS = Object.freeze({ idle: /** @type {const} */ ('stay') });

/**
 * What goes across with bytes the sender no longer needs: their buffer, where
 * they are the whole of one that is not shared; nothing otherwise, and they
 * are copied.
 *
 * @param {Uint8Array} bytes @returns {ArrayBuffer[]}
 */
const handedOver = bytes=>(bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength ? [bytes.buffer] : []);

/**
 * What an executor's translator asks of the store.
 *
 * @typedef {{ id?: number, method: string, key: string, bytes?: Uint8Array,
 *     options?: { needs?: string }, place?: boolean, fixed?: boolean }} StoreAsk
 */

/**
 * The process's side: each ask of one executor answered through `post`. A
 * record looked up is answered with a copy (the store may keep the bytes it
 * read), or, `fixed` and where the executor reads the run's cache
 * (`cache.joined`), put in the cache and answered `cached`; one put or touched
 * is the store's from here on.
 *
 * @param {{ store: import('../engine.js').TranslationStore | null,
 *     cache?: { space: import('../../cache/module.js').CacheSpace, joined: boolean } | null,
 *     post: (message: any) => void }} options
 */
export function answerStoreAsks({ store, cache = null, post }){
    /** How the records asked for crossed, by way. */
    const counts = { cached: 0, cachedBytes: 0, copied: 0, copiedBytes: 0 };
    /** @param {StoreAsk} ask @param {Uint8Array | null} bytes */
    const send = (ask, bytes)=>{
        if (bytes && ask.fixed === true && cache?.joined === true
            && cache.space.put(ask.key, bytes))
        {
            counts.cached++;
            counts.cachedBytes += bytes.length;
            post({ type: 'store', id: ask.id, cached: true });
            return;
        }
        if (bytes)
        {
            counts.copied++;
            counts.copiedBytes += bytes.length;
        }
        post({ type: 'store', id: ask.id, bytes });
    };
    return {
        counts,
        /** @param {StoreAsk} ask */
        answer(ask){
            if (store === null)
            {
                if (ask.method === 'get')
                {
                    post({ type: 'store', id: ask.id, bytes: null });
                }
                return;
            }
            if (ask.method === 'put' && ask.bytes instanceof Uint8Array)
            {
                Promise.resolve(store.put(ask.key, ask.bytes, ask.options)).catch(()=>{});
                return;
            }
            if (ask.method === 'append' && ask.bytes instanceof Uint8Array)
            {
                Promise.resolve(store.append?.(ask.key, ask.bytes)).catch(()=>{});
                return;
            }
            if (ask.method === 'touch')
            {
                store.touch?.(ask.key);
                return;
            }
            // An executor reading the records file itself is told where the record is: the
            // read and its copy across were the engine thread's, a twentieth of it at a film's
            // start, every executor's lookups answered here.
            const pieces = ask.place === true ? store.placeOf?.(ask.key) : undefined;
            if (pieces !== undefined)
            {
                post({ type: 'store', id: ask.id, pieces });
                return;
            }
            const now = store.getNow?.(ask.key);
            // An answer to an executor closed meanwhile goes nowhere.
            Promise.resolve(now !== undefined ? now : store.get(ask.key)).catch(()=>null)
                .then(bytes=>send(ask, bytes ?? null)).catch(()=>{});
        },
    };
}

/**
 * The executor's side: the store its translator is given (`store`), which
 * asks through `send`, and what it is told back (`take`). The run's cache,
 * where the process joined the executor to it, is read through `joinedSpace`
 * once the executor starts (`join`); the messages of segments made and let go
 * before that are held until then.
 *
 * @param {(message: any, transfer?: any[]) => void} send
 */
export function storeClient(send){
    /** The answers awaited, by the ask's id, with the key asked.
     * @type {Map<number, { key: string, answer: (bytes: Uint8Array | null) => void }>} */
    const answers = new Map();
    let asks = 0;
    /** @type {ReturnType<typeof joinedSpace> | null} */
    let cache = null;
    /**
     * The translator's emitted functions as this executor reads them, and the
     * run's cache passed on to its translation workers (`kept`).
     * @type {{ read: ReturnType<typeof joinedSpace>,
     *     relay: ReturnType<typeof relayedJoin> } | null}
     */
    let functions = null;
    /** @type {any[]} */
    const early = [];
    /**
     * This executor's own handle on the store's records file, beside the store's: a lookup
     * is then answered with where the record is (`placeOf`) and read here, not on the
     * process's thread. Null until the process hands the file, or where the browser keeps
     * it to one handle.
     * @type {any}
     */
    let records = null;
    /**
     * How the records asked for came: from the cache unasked, from it once put there, or
     * copied; and those whose place the store named and that did not read (`unreadable`), with
     * why the first did not: a corrupt or cut records file, which the translator meets as a miss.
     */
    const counts = { cacheHits: 0, cachePut: 0, copied: 0, unreadable: 0,
        unreadableWhy: /** @type {string | null} */ (null) };
    /** A record read from the cache, a copy of this thread's own (the translator keeps it).
     * @param {string} key */
    const fromCache = key=>cache?.space.with(key, body=>body.slice()) ?? null;
    /** A segment of the run's cache made or let go, told to every reader here. @param {any} message */
    const adopt = message=>{
        cache?.adopt(message);
        functions?.read.adopt(message);
        functions?.relay.adopt(message);
    };

    /**
     * The run's translation store as this executor reaches it: through the
     * process, which holds it and its index. A lookup is answered on the
     * process's event loop, a turn or a few later, and the runtime interprets
     * meanwhile as it does while any store answers late; a record goes and is
     * not waited on.
     *
     * @type {import('../engine.js').TranslationStore}
     */
    const store = {
        // Made for this executor's runtime, the only one its thread has.
        alone: true,
        get(key, options){
            // A record whose bytes never change under its key, once another executor
            // or this one asked for it, is in the run's cache: read there, the
            // process not asked.
            const fixed = options?.fixed === true && cache !== null;
            const kept = fixed ? fromCache(key) : null;
            if (kept !== null)
            {
                counts.cacheHits++;
                return Promise.resolve(kept);
            }
            return new Promise(answer=>{
                const id = ++asks;
                answers.set(id, { key, answer });
                send({ type: 'store', id, method: 'get', key, place: records !== null,
                    ...fixed ? { fixed: true } : {} });
            });
        },
        // The bytes of a put or an addition are the store's from the call on
        // (`TranslationStore`): one that is the whole of its buffer goes without a copy.
        put(key, bytes, options){
            send({ type: 'store', method: 'put', key, bytes, options }, handedOver(bytes));
            return Promise.resolve();
        },
        append(key, bytes){
            send({ type: 'store', method: 'append', key, bytes }, handedOver(bytes));
            return Promise.resolve();
        },
        touch: key=>send({ type: 'store', method: 'touch', key }),
    };

    return {
        store,
        counts,
        /** @param {import('../../cache/module.js').Joined | null | undefined} joined */
        join(joined){
            if (!joined)
            {
                return;
            }
            cache = joinedSpace(joined, STORE_SPACE);
            functions = { read: joinedSpace(joined, KEPT_SPACE), relay: relayedJoin(joined) };
            for (const message of early.splice(0))
            {
                adopt(message);
            }
        },
        /**
         * The run's cache as this executor's translator keeps its functions in
         * it (`KeptStore`): read here in place, a function emitted here sent to
         * the process to put, which writes the run's cache; null before the
         * executor is joined, or where it is not.
         *
         * @returns {import('../engine.js').KeptStore | null}
         */
        kept(){
            if (functions === null)
            {
                return null;
            }
            const { read, relay } = functions;
            return {
                space: {
                    with: (name, take)=>read.space.with(name, take),
                    put(name, bytes){
                        send({ type: 'kept', entries: [{ name, bytes }] }, handedOver(bytes));
                        return true;
                    },
                },
                prefix: `${KEPT_SPACE}/`,
                join: post=>relay.join(post),
            };
        },
        /** @param {any} handle  a synchronous handle on the records file */
        holdRecords(handle){
            records = handle;
        },
        /**
         * A message from the process meant for the store: an answer, or one of the
         * cache's. False for any other.
         *
         * @param {any} data
         */
        take(data){
            if (data?.type === 'cache')
            {
                if (cache === null)
                {
                    early.push(data.message);
                }
                else
                {
                    adopt(data.message);
                }
                return true;
            }
            if (data?.type !== 'store')
            {
                return false;
            }
            const asked = answers.get(data.id);
            answers.delete(data.id);
            const answer = asked?.answer;
            if (data.cached === true && asked !== undefined)
            {
                // Put in the run's cache for this ask: read there. Gone already
                // (let go under the cache's budget) is a miss, formed here.
                counts.cachePut++;
                answer?.(fromCache(asked.key));
                return true;
            }
            if (Array.isArray(data.pieces) && records !== null)
            {
                let bytes = null;
                try
                {
                    const framed = readPieces(records, data.pieces);
                    bytes = framed === null ? null : unframe(framed);
                }
                catch (e){
                    // A miss to the translator, which forms the region again; the
                    // store is not as it says it is, which the figures carry.
                    counts.unreadable++;
                    counts.unreadableWhy ??= `${asked?.key}: ${/** @type {any} */ (e)?.message ?? e}`;
                }
                answer?.(bytes);
                return true;
            }
            if (data.bytes)
            {
                counts.copied++;
            }
            answer?.(data.pieces === null ? null : data.bytes ?? null);
            return true;
        },
    };
}
