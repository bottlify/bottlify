/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's cache: one Cellar keeper (`vendor/cellar/`) on the thread that
 * holds the run's stores, and what each process reads it through.
 *
 * A process on this thread reads through the reader made here, its calls to
 * the keeper plain calls. A process in a worker of its own is handed the
 * index and the segments as they are (`join`) and makes a reader there; its
 * calls come across its link (`handlers`), and the segments made and let go
 * after reach it as messages. Every thread reads a body where the keeper put
 * it: nothing is copied from one thread to another.
 */

import { createChannel, createReader, openKeeper, openServer } from '../../vendor/cellar/cellar.js';
import { serveKeeper } from '../layers/cache/module.js';

const MIB = 1024 * 1024;

/**
 * The bytes of shared memory the run's cache holds bodies in, at most, unless
 * the run names its own (`AppOptions.cache.budget`): the reads it kept before,
 * 32 MiB for ranges read again and one range alone up to 128 MiB, fit.
 */
export const RUN_CACHE_BYTES = 160 * MIB;

/** A body idle so long goes: the reads kept before were let go after as long. */
const IDLE_MS = 30_000;

/** How often the keeper looks for idle bodies and empty segments. */
const SWEEP_MS = 1000;

/**
 * @param {{ budget?: number }} [options]
 */
export async function openRunCache({ budget = RUN_CACHE_BYTES } = {}){
    /** What each thread reading is told of a segment made or let go. @type {Set<(message: any) => void>} */
    const told = new Set();
    /**
     * The index's table as it is now: the keeper makes a larger one as names
     * are added, and a thread joining after is handed that one, not the first.
     *
     * @type {SharedArrayBuffer | null}
     */
    let table = null;
    const keeper = await openKeeper({
        budget, segmentBytes: 16 * MIB, coldAfterMs: IDLE_MS,
        announce: message=>{
            if (message.table !== undefined)
            {
                table = message.table;
            }
            for (const tell of told)
            {
                tell(message);
            }
        },
    });
    const reader = createReader({
        shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, options)=>keeper.reserve(name, length, options),
            raise: name=>keeper.raise(name),
            raiseLater: name=>{
                keeper.raise(name);
            },
            drop: name=>{
                keeper.drop(name);
            },
        },
    });
    told.add(message=>reader.adopt(message));
    /** The channels a worker that writes calls the keeper through, served here. @type {Set<{ close: () => void }>} */
    const served = new Set();
    const sweeping = setInterval(()=>keeper.sweep(), SWEEP_MS);
    // A run's timer is not what keeps a host's process alive.
    /** @type {any} */ (sweeping).unref?.();

    return {
        reader,

        /** The link handlers a process in a worker of its own calls the keeper through. */
        handlers: {
            cache: {
                /** @param {string} name @param {number} length @param {any} options */
                reserve: (name, length, options)=>keeper.reserve(name, length, options ?? {}),
                /** @param {string} name */
                raise: name=>keeper.raise(name),
                /** @param {string} name */
                drop: name=>keeper.drop(name),
            },
        },

        /**
         * A thread joining: what it makes its reader over, and from now on the
         * messages of segments made and let go, through `post`, until `leave`.
         *
         * @param {(message: any) => void} post
         */
        join(post){
            told.add(post);
            return {
                shared: table === null ? keeper.shared : { ...keeper.shared, table },
                segments: keeper.segmentBuffers(),
                leave: ()=>told.delete(post),
            };
        },

        /**
         * A channel a worker of this thread's (the graphics worker) calls the
         * keeper through, served on this thread's event loop: the worker asks
         * for room without waiting and waits only to bring a cold body back.
         * Its shared memory, which the worker opens its end over.
         */
        serve(){
            const memory = createChannel();
            served.add(serveKeeper(openServer(memory), keeper));
            return memory;
        },

        figures: ()=>keeper.figures(),

        close(){
            for (const one of served)
            {
                one.close();
            }
            served.clear();
            clearInterval(sweeping);
            told.clear();
            keeper.close();
        },
    };
}

/** @typedef {Awaited<ReturnType<typeof openRunCache>>} RunCache */

/**
 * The reader a process in a worker of its own reads the run's cache through:
 * over what `join` handed it, its calls to the keeper across its link.
 *
 * @param {{ shared: any, segments: (SharedArrayBuffer | null)[] }} joined
 * @param {{ ask: (method: string, args: any[]) => any,
 *     call: (method: string, args: any[]) => Promise<any> }} link
 *     `ask` blocks for the answer, `call` does not
 */
export function remoteCacheReader(joined, link){
    return createReader({
        shared: joined.shared, segments: joined.segments,
        keeper: {
            reserve: (name, length, options)=>link.ask('reserve', [name, length, options]),
            raise: name=>link.ask('raise', [name]),
            raiseLater: name=>{
                link.call('raise', [name]).catch(()=>{});
            },
            drop: name=>{
                link.call('drop', [name]).catch(()=>{});
            },
        },
    });
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
