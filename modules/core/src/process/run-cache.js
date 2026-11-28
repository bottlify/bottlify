/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's cache: one Cellar keeper (`@bottlify/cellar`) on the thread that
 * holds the run's stores, and what each process reads it through.
 *
 * A process on this thread reads through the reader made here, its calls to
 * the keeper plain calls. A process in a worker of its own is handed the
 * index and the segments as they are (`join`) and makes a reader there; its
 * calls come across its link (`across`), and the segments made and let go
 * after reach it as messages. Every thread reads a body where the keeper put
 * it: nothing is copied from one thread to another.
 *
 * Every owner of names - a graphics root, a process's scratches, the run's
 * own - is numbered here, wherever it runs: on this thread (`own`), in a
 * worker of this thread's (`serve`, a channel), in a process's worker or a
 * worker of that process's (`across`). Its going lets go of all it held; one
 * that goes without saying so goes with its process, or with the run.
 *
 * Its segments are one kind of the run's account (`createRunAccount`), the
 * machine's memory every process of the run takes its own from: a take there
 * that does not fit has the keeper let cold bodies go for it (`room`).
 *
 * Its disk is a folder in the run's own (`run-folder.js`), for the bodies that
 * are the only copy for this run (texels the GPU was given, `disk: 'run'`): a
 * body that can be made again is never written there (`disk: 'never'`, the
 * cache layer's default), and the next run finds nothing in it.
 */

import { answerKeeper, createChannel, createReader, keeperWords, linkCarrier,
    openKeeper, openKeeperClient, openServer, serveKeeperChannel } from '@bottlify/cellar';
import { createRunAccount } from '../layers/cache/account.js';
import { ownedSpace } from '../layers/cache/module.js';
import { createScratches } from '../layers/cache/scratch.js';
import { opfsDisk } from '../layers/filesystem/internal/opfs-disk.js';

const MIB = 1024 * 1024;

/**
 * The shared memory the keeper adds and lets go of at a time, bodies shared
 * in it; a body over a quarter of it has a segment of its own.
 */
const SEGMENT_BYTES = 16 * MIB;

/**
 * The calls in place of a process's link, which are the run's cache's: a
 * request of the longest name a path makes, 1004 bytes of UTF-8 past its
 * words, and as many out at once as a process nests or sends unwaited.
 */
export const CACHE_CALLS = Object.freeze({ words: 256, slots: 8 });

/** A body idle so long goes: the reads kept before were let go after as long. */
const IDLE_MS = 30_000;

/** How often the keeper looks for idle bodies and empty segments. */
const SWEEP_MS = 1000;

/**
 * @param {{ account?: import('@bottlify/cellar').AccountMemory, budget?: number,
 *     runFolder?: import('../layers/filesystem/internal/run-folder.js').RunFolder | null,
 *     onTail?: (tail: import('../layers/cache/module.js').OwnerTail) => void,
 *     onLoss?: (detail: string) => void }} [opened]
 *     `account`: the run's (`createRunAccount`), by default one with no limit
 *     and the cache's segments at most `budget`;
 *     `runFolder`: where the cache's disk is made; none, a cache in memory alone;
 *     `onTail`: an owner that went left bodies under its names past what it held;
 *     `onLoss`: the disk in the run's folder did not open, said once
 */
export async function openRunCache(opened = {}){
    const { budget, runFolder = null, onTail = ()=>{}, onLoss = ()=>{} } = opened;
    const account = opened.account ?? createRunAccount({ cacheBytes: budget });
    /** What each thread reading is told of a segment made or let go. @type {Set<(message: any) => void>} */
    const told = new Set();
    /**
     * The most placed in the keeper's segments at once, read at each sweep and
     * each look (the most its segments held, the keeper counts itself): what
     * the budget is weighed against, which the keeper's figures, as they stand
     * at the end, do not say.
     */
    const peak = { placedBytes: 0,
        /**
         * At the most placed: what rounding to blocks cost then, and each space
         * as it stood. A run's bodies go cold as it goes on, so at its end the
         * blocks it held are gone and their rounding with them.
         */
        roundingBytes: 0, spaces: /** @type {Record<string, { bodies: number, bytes: number,
            hotBytes: number, placedBytes: number }>} */ ({}) };
    /** @param {import('@bottlify/cellar').Disk | null} disk */
    const open = disk=>openKeeper({
        account, segmentBytes: SEGMENT_BYTES, coldAfterMs: IDLE_MS, disk,
        announce: message=>{
            for (const tell of told)
            {
                tell(message);
            }
        },
    });
    let letGo = ()=>{};
    /** Why a folder was given and the cache has no disk in it; null where it has one, or none was given. */
    let diskLost = /** @type {string | null} */ (null);
    let keeper;
    if (runFolder === null)
    {
        keeper = await open(null);
    }
    else
    {
        letGo = runFolder.use();
        const disk = await runFolder.folder.getDirectoryHandle('cache', { create: true })
            .then((/** @type {any} */ folder)=>opfsDisk(folder), (/** @type {any} */ error)=>{
                // The bodies that are the only copy for the run have nowhere
                // to go: those the budget has no room for are refused.
                diskLost = String(error?.message ?? error);
                onLoss(`the run's folder has no cache in it (${diskLost}): the bodies that are`
                    + ' the only copy for the run stay in memory, and those past its budget are'
                    + ' refused');
                letGo();
                letGo = ()=>{};
                return null;
            });
        keeper = await open(disk);
    }
    /**
     * The spaces names were reserved under, by what comes before a name's
     * first '/': a cache module's space, an owner's kind (`texels`). Each is
     * weighed on its own when the figures are asked for: which owner's
     * bodies the rounding to blocks costs.
     */
    const spaces = new Set();
    /** @param {string} name @param {number} length @param {any} [options] */
    const reserve = (name, length, options)=>{
        const slash = name.indexOf('/');
        if (slash > 0)
        {
            spaces.add(name.slice(0, slash));
        }
        return keeper.reserve(name, length, options ?? {});
    };
    const reader = createReader({
        shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve,
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
    /**
     * The owners whose names are out and whose release is not a channel's:
     * one on this thread (`own`), one in a process's worker, one whose
     * channel has not come yet. Each is let go of by its own release, else
     * with its process, else with the run.
     *
     * @type {Set<string>}
     */
    const ownersOut = new Set();
    /** Whether the run is going: an owner let go of with it leaves no tail. */
    let closing = false;
    /** @param {string} name */
    const numbered = name=>`${name}/${++owners}/`;
    /** What owners that went left behind them, summed. */
    const tails = { owners: 0, bodies: 0, bytes: 0 };
    /**
     * The keepers whose cold bodies go for a take of the account's that does
     * not fit: this one first, then those of the bundles' blocks (`roomFrom`).
     *
     * @type {((bytes: number) => boolean)[]}
     */
    const roomMakers = [keeper.makeRoom];
    /** @param {number} bytes */
    const makeRoom = bytes=>roomMakers.some(make=>make(bytes));
    /** The keeper as a remote keeper's readers call it: each reserve weighed by space. */
    const remote = { reserve, raise: keeper.raise, drop: keeper.drop, makeRoom };
    /** @param {import('../layers/cache/module.js').OwnerTail} tail */
    const tailed = tail=>{
        tails.owners++;
        tails.bodies += tail.bodies;
        tails.bytes += tail.bytes;
        onTail(tail);
    };
    /**
     * An owner out goes: its names let go of, past the `held` it said, a
     * tail; null once it went before (a second release, its process gone).
     *
     * @param {string} prefix @param {number | null} held  null where it never said
     */
    const releaseOut = (prefix, held)=>(ownersOut.delete(prefix)
        ? releaseOwner(keeper, prefix, held, { onTail: tailed, quiet: closing }) : null);
    /**
     * Serves the channel of an owner numbered already, as `serve` does: its
     * names let go of by its release, or, where it never said so, when the
     * channel closes - a tail unless the run closed it, going.
     *
     * @param {SharedArrayBuffer} channel @param {string} prefix
     */
    const serveOn = (channel, prefix)=>{
        let out = true;
        /** @param {number | null} held */
        const release = held=>{
            if (!out)
            {
                return null;
            }
            out = false;
            return releaseOwner(keeper, prefix, held, { onTail: tailed, quiet: closing });
        };
        const one = serveKeeperChannel(channel, answerKeeper({ keeper: remote, owners: {
            // One channel is one owner's, given no names past its own.
            own: ()=>null,
            release: (owned, held)=>(owned === prefix ? release(held) : null),
        } }));
        served.add(one);
        // A channel whose owner closed it is not held to the run's end.
        one.ended.finally(()=>{
            served.delete(one);
            release(null);
        });
    };
    /**
     * The run's own scratches (its presenter's), under names of its own,
     * made when first asked for and let go of with the run.
     *
     * @type {{ rooms: ReturnType<typeof createScratches>,
     *     owner: ReturnType<typeof ownedSpace> } | null}
     */
    let runRooms = null;
    /**
     * Names of the run's cache an owner on this thread holds alone, `name/<n>/`,
     * the number the run's over every owner (`ownedSpace`): let go of by its
     * release, its keeper calls this thread's.
     *
     * @param {string} name @returns {import('../layers/cache/module.js').Owned}
     */
    const own = name=>{
        const prefix = numbered(name);
        ownersOut.add(prefix);
        return { prefix, release: held=>releaseOut(prefix, held) };
    };
    const weighSpaces = ()=>Object.fromEntries([...spaces].sort()
        .map(space=>[space, keeper.under(`${space}/`)]));
    const look = ()=>{
        const figures = keeper.figures();
        if (figures.placedBytes > peak.placedBytes)
        {
            peak.placedBytes = figures.placedBytes;
            peak.roundingBytes = figures.roundingBytes;
            peak.spaces = weighSpaces();
        }
        return { ...figures, budget: figures.account.kinds.cache.ceiling,
            peakPlacedBytes: peak.placedBytes, peakRoundingBytes: peak.roundingBytes,
            peakSpaces: peak.spaces, owners, ownerTails: { ...tails },
            // Threads joined but this one's own reader, and owners' channels open.
            joined: told.size - 1, served: served.size, diskLost };
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

        /**
         * A process in a worker of its own, as the keeper serves it: the
         * handler of its link's calls in place it calls the keeper through
         * (`words`, the link made with `CACHE_CALLS`), the names its owners
         * there are given (`own`, numbered here as every owner of the run is)
         * and let go of (`release`), and the channel of one
         * of them that a graphics worker writes through, which comes as a
         * message, since the link carries no shared memory (`served`). `end`:
         * the process went, and every owner of it still out is let go of -
         * past what it said it held, a tail - but one whose channel is served,
         * which goes when its graphics root does.
         */
        across(){
            /** Its owners out, by prefix. @type {Set<string>} */
            const mine = new Set();
            return {
                words: keeperWords(answerKeeper({ keeper: remote, owners: {
                    own: kind=>{
                        const { prefix } = own(kind);
                        mine.add(prefix);
                        return prefix;
                    },
                    release: (prefix, held)=>(mine.delete(prefix)
                        ? releaseOut(prefix, held) : null),
                } })),
                /**
                 * The channel of an owner of its own: served from now on. One
                 * that is not its, or comes after it went, is closed unserved,
                 * so nothing waits on it.
                 *
                 * @param {string} prefix @param {SharedArrayBuffer} channel
                 */
                served(prefix, channel){
                    const shared = typeof SharedArrayBuffer === 'function'
                        && channel instanceof SharedArrayBuffer;
                    if (!shared || !mine.delete(prefix) || !ownersOut.delete(prefix))
                    {
                        if (shared)
                        {
                            openServer(channel).close();
                        }
                        return;
                    }
                    serveOn(channel, prefix);
                },
                end(){
                    for (const prefix of mine)
                    {
                        releaseOut(prefix, null);
                    }
                    mine.clear();
                },
            };
        },

        own,

        /**
         * Room in the run's account for `bytes` more of another kind, cold
         * bodies let go for it (`Keeper.makeRoom`): an account's `room` on
         * this thread.
         *
         * @param {number} bytes
         */
        room: makeRoom,

        /**
         * Another keeper of the run's account on this thread (a bundle's
         * blocks), its cold bodies let go for room after this one's: what
         * takes it back out, as that keeper closes.
         *
         * @param {(bytes: number) => boolean} make  its `makeRoom`
         */
        roomFrom(make){
            roomMakers.push(make);
            return ()=>{
                roomMakers.splice(roomMakers.indexOf(make) >>> 0, 1);
            };
        },

        /**
         * A scratch of the run's own (its presenter's), held under names of
         * the run's, made when first asked for and let go of with the run.
         *
         * @param {string} name @returns {import('../layers/cache/scratch.js').Scratch}
         */
        scratch(name){
            if (runRooms === null)
            {
                const owner = ownedSpace(reader, own('scratch'));
                runRooms = { owner, rooms: createScratches(owner.space.hold) };
            }
            return runRooms.rooms.scratch(name);
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
            const prefix = numbered(name);
            serveOn(channel, prefix);
            return { channel, prefix };
        },

        /**
         * What is held under names that begin with `prefix`: an owner's, by
         * the prefix its space was given.
         *
         * @param {string} prefix
         */
        under: (/** @type {string} */ prefix)=>keeper.under(prefix),

        /**
         * The keeper's figures, with its budget and the most it held at once,
         * and by space (`spaces`): each one's bodies, their bytes, those in
         * memory and the blocks they take; and as the cache stood when it had
         * the most placed (`peakSpaces`, `peakRoundingBytes`).
         */
        figures: ()=>({ ...look(), spaces: weighSpaces(),
            // What each owner whose names are out but not a channel's holds:
            // a process's in a worker of its own, by its prefix.
            ownersOut: Object.fromEntries([...ownersOut].sort()
                .map(prefix=>[prefix, keeper.under(prefix)])) }),

        close(){
            closing = true;
            runRooms?.rooms.releaseAll();
            runRooms?.owner.close();
            runRooms = null;
            for (const prefix of [...ownersOut])
            {
                releaseOut(prefix, null);
            }
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
 * Lets go of every name of one owner's in the keeper (Cellar's `release`,
 * which takes back the memory it held as well): past the `held` it said it
 * had, a tail (`onTail`); `held` null where it went without saying, a tail
 * unless `quiet` - the run going, every owner with it.
 *
 * @param {{ release: (prefix: string)
 *     => { bodies: number, bytes: number, waiting: number } }} keeper
 * @param {string} prefix @param {number | null} held
 * @param {{ onTail: (tail: import('../layers/cache/module.js').OwnerTail) => void, quiet: boolean }} options
 */
function releaseOwner(keeper, prefix, held, { onTail, quiet }){
    const left = keeper.release(prefix);
    const owed = held ?? 0;
    if (left.bodies > owed && !(held === null && quiet))
    {
        onTail({ prefix, bodies: left.bodies - owed, bytes: left.bytes, held: owed,
            why: held === null ? 'unreleased' : 'unknown' });
    }
    return left;
}

/**
 * The run's cache as a process in a worker of its own reads it: a reader over
 * what `join` handed it, and the names of its owners, numbered by the keeper,
 * its calls to the keeper Cellar's remote keeper across its link
 * (`RunCache.across`), answered by the run's thread inside any wait of its
 * own on the process. `own` names an owner that reads and writes through the
 * process's reader (`ownedSpace`: an in-thread root, the process's
 * scratches), let go of by a call it waits on, so its going is counted
 * before its process is; `serve` one in a worker of the process's (a
 * graphics root, `channelSpace`), whose channel is made here and sent to the
 * keeper's thread as a message (`post`), since the link carries no shared
 * memory. The owner may call through it at once: what it asks waits in the
 * channel until the keeper's thread serves it.
 *
 * @param {{ shared: any, segments: (SharedArrayBuffer | null)[] }} joined
 * @param {import('@bottlify/cellar').Link} link
 * @param {((message: { type: 'cache-serve', prefix: string,
 *     channel: SharedArrayBuffer }) => void) | null} post  to the keeper's thread
 */
export function remoteCache(joined, link, post){
    const client = openKeeperClient(linkCarrier(link));
    /** @param {string} name */
    const prefixOf = name=>{
        const prefix = client.own(name);
        if (prefix === null)
        {
            throw new Error(`run cache: the run gave no names for ${name}`);
        }
        return prefix;
    };
    return {
        reader: createReader({ shared: joined.shared, segments: joined.segments,
            keeper: client.keeper }),
        /** Room in the run's account, made by its keeper across the link. */
        room: client.room,
        /** @type {import('../layers/cache/module.js').Own} */
        own: name=>{
            const prefix = prefixOf(name);
            return { prefix, release: held=>client.release(prefix, held) };
        },
        /** @type {import('../layers/cache/module.js').Serve} */
        serve: name=>{
            if (post === null)
            {
                return null;
            }
            const channel = createChannel();
            const prefix = prefixOf(name);
            post({ type: 'cache-serve', prefix, channel });
            return { channel, prefix };
        },
    };
}
