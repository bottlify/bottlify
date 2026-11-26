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
 *
 * Its disk is a folder in the run's own (`run-folder.js`), for the bodies that
 * are the only copy for this run (texels the GPU was given, `disk: 'run'`): a
 * body that can be made again is never written there (`disk: 'never'`, the
 * cache layer's default), and the next run finds nothing in it.
 */

import { createChannel, createReader, openKeeper, openServer } from '../../vendor/cellar/cellar.js';
import { serveKeeper } from '../layers/cache/module.js';
import { opfsDisk } from '../layers/filesystem/internal/opfs-disk.js';

const MIB = 1024 * 1024;

/**
 * The bytes of shared memory the run's cache holds bodies in, at most, unless
 * the run names its own (`AppOptions.cache.budget`): the reads it kept before,
 * 32 MiB for ranges read again and one range alone up to 128 MiB, fit.
 */
export const RUN_CACHE_BYTES = 160 * MIB;

/** The shared memory the keeper adds and lets go of at a time. */
const SEGMENT_BYTES = 16 * MIB;

/** A body idle so long goes: the reads kept before were let go after as long. */
const IDLE_MS = 30_000;

/** How often the keeper looks for idle bodies and empty segments. */
const SWEEP_MS = 1000;

/**
 * @param {{ budget?: number,
 *     runFolder?: import('../layers/filesystem/internal/run-folder.js').RunFolder | null,
 *     onTail?: (tail: import('../layers/cache/module.js').OwnerTail) => void }} [options]
 *     `runFolder`: where the cache's disk is made; none, a cache in memory alone;
 *     `onTail`: an owner that went left bodies under its names past what it held
 */
export async function openRunCache(opened = {}){
    const { budget = RUN_CACHE_BYTES, runFolder = null, onTail = ()=>{} } = opened;
    /** What each thread reading is told of a segment made or let go. @type {Set<(message: any) => void>} */
    const told = new Set();
    /**
     * The most the keeper held at once: its segments, counted as each is made
     * and let go of, and the bytes placed in them, read at each sweep and each
     * look. What the budget is weighed against, which the keeper's figures, as
     * they stand at the end, do not say.
     */
    const peak = { segments: 0, live: 0, placedBytes: 0 };
    /** @param {import('../../vendor/cellar/cellar.js').Disk | null} disk */
    const open = disk=>openKeeper({
        budget, segmentBytes: SEGMENT_BYTES, coldAfterMs: IDLE_MS, disk,
        announce: message=>{
            if (message.segment !== undefined)
            {
                peak.live += message.buffer ? 1 : -1;
                peak.segments = Math.max(peak.segments, peak.live);
            }
            for (const tell of told)
            {
                tell(message);
            }
        },
    });
    let letGo = ()=>{};
    let keeper;
    try
    {
        if (runFolder === null)
        {
            throw new Error('no folder');
        }
        letGo = runFolder.use();
        keeper = await open(opfsDisk(await runFolder.folder.getDirectoryHandle('cache',
            { create: true })));
    }
    catch {
        // A folder whose files do not open (a thread with no synchronous
        // handle) leaves the cache in memory, as without a folder.
        letGo();
        letGo = ()=>{};
        keeper = await open(null);
    }
    const reader = createReader({
        shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, options)=>keeper.reserve(name, length, options),
            raise: (name, options)=>keeper.raise(name, options),
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
    /** Owners given names of their own, a number each, over every channel. */
    let owners = 0;
    /** What owners that went left behind them, summed. */
    const tails = { owners: 0, bodies: 0, bytes: 0 };
    /** The keeper as a channel's owners call it. */
    const channelKeeper = {
        reserve: (/** @type {string} */ name, /** @type {number} */ length, /** @type {any} */ options)=>
            keeper.reserve(name, length, options ?? {}),
        raise: (/** @type {string} */ name, /** @type {any} */ options)=>keeper.raise(name, options ?? {}),
        drop: (/** @type {string} */ name)=>{
            keeper.drop(name);
        },
        release: (/** @type {string} */ prefix)=>keeper.release(prefix),
    };
    /** @param {import('../layers/cache/module.js').OwnerTail} tail */
    const tailed = tail=>{
        tails.owners++;
        tails.bodies += tail.bodies;
        tails.bytes += tail.bytes;
        onTail(tail);
    };
    const look = ()=>{
        const figures = keeper.figures();
        peak.placedBytes = Math.max(peak.placedBytes, figures.placedBytes);
        return { ...figures, budget, peakSegmentBytes: peak.segments * SEGMENT_BYTES,
            peakPlacedBytes: peak.placedBytes, owners, ownerTails: { ...tails },
            // Threads joined but this one's own reader, and owners' channels open.
            joined: told.size - 1, served: served.size };
    };
    const sweeping = setInterval(()=>{
        // Read before the sweep lets idle bodies and empty segments go.
        look();
        keeper.sweep();
    }, SWEEP_MS);
    // A run's timer is not what keeps a host's process alive.
    /** @type {any} */ (sweeping).unref?.();

    return {
        reader,

        /** The link handlers a process in a worker of its own calls the keeper through. */
        handlers: {
            cache: {
                /** @param {string} name @param {number} length @param {any} options */
                reserve: (name, length, options)=>keeper.reserve(name, length, options ?? {}),
                /** @param {string} name @param {{ known?: number }} [options] */
                raise: (name, options)=>keeper.raise(name, options ?? {}),
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
                // The index as it is now: the table the keeper made larger last.
                shared: keeper.shared,
                segments: keeper.segmentBuffers(),
                leave: ()=>told.delete(post),
            };
        },

        /**
         * A channel one owner on a worker of this thread's (a graphics root)
         * calls the keeper through, served on this thread's event loop: the
         * worker asks for room without waiting and waits only to bring a cold
         * body back. Its shared memory, which the worker opens its end over,
         * and the prefix of the owner's names, `name/<n>/`: let go of when the
         * owner goes, or when its end of the channel closes.
         *
         * @param {string} name
         */
        serve(name){
            const channel = createChannel();
            const prefix = `${name}/${++owners}/`;
            const one = serveKeeper(openServer(channel), channelKeeper,
                { owner: prefix, onTail: tailed });
            served.add(one);
            // A channel whose owner closed it is not held to the run's end.
            one.ended.then(()=>served.delete(one));
            return { channel, prefix };
        },

        /**
         * What is held under names that begin with `prefix`: an owner's, by
         * the prefix its space was given.
         *
         * @param {string} prefix
         */
        under: (/** @type {string} */ prefix)=>keeper.under(prefix),

        /** The keeper's figures, with its budget and the most it held at once. */
        figures: look,

        close(){
            for (const one of served)
            {
                one.close();
            }
            served.clear();
            clearInterval(sweeping);
            told.clear();
            keeper.close();
            letGo();
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
            raise: (name, options)=>link.ask('raise', [name, options]),
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
