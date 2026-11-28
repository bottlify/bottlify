/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a fetched block lives between the network and a guest read: a body of
 * a Cellar keeper (`@bottlify/cellar`) of the bundle's own, by the block's
 * index, read where it lies.
 *
 * A body is the block as a read hands it out -- decoded, a deflate block
 * inflated and a zstd one unpacked as it is fetched -- so a read copies a
 * block once, from where the keeper holds it into what the program asked for,
 * and decodes nothing. Hot, it is in the keeper's shared memory, its kind of
 * the run's account; idle 30 s, or pushed out for room, it goes cold, into the keeper's
 * packs on the origin's file system (`opfs-disk.js`, one directory a bundle,
 * `blocks/<name>`), and a read brings it back from there at once, as it
 * waits for nothing but the disk. What the disk holds is the next run's too:
 * the keeper's index of it is saved every few seconds and at the end, and
 * read back when the next run opens the cache. A body the disk lost is a
 * block fetched again, never another's bytes: the keeper reads back only what
 * an index it wrote names, within the pack as long as it is.
 *
 * A keeper of the bundle's own rather than the run's (`process/run-cache.js`):
 * a keeper's disk takes every body of it that goes cold, and the run's holds
 * bodies no next run may read (a program's textures) or that are kept
 * elsewhere already (translations): a body cannot be named this run's alone in
 * a keeper with a disk. A bundle's directory is its own for the same reason a
 * cache was before: a layer every bottle stands on is kept once, and the
 * origin's budget lets a bundle's blocks go whole (`storage-budget.js`).
 *
 * Without a disk -- none asked for, a thread with no synchronous handle,
 * another tab holding the bundle's files -- the keeper holds the blocks in
 * memory alone, let go for room, never for idling. The keeper ranks bodies
 * by when they were last read only as finely as its sweeps (a second): those
 * read within one go oldest-made first.
 */

import { createReader, openAccount, openKeeper } from '@bottlify/cellar';
import { opfsDisk } from '../opfs-disk.js';
import { BLOCK_DIRECTORY, fileNameOf } from './saved.js';

/** @typedef {import('@bottlify/cellar').Disk} Disk */

/**
 * Turns what a caller asked for into where blocks are kept: a directory of
 * the origin's file system, or one shaped as it (a test's, a tool's over a
 * folder of its disk), under which `blocks/<name>` is the bundle's.
 *
 * `'local'` is the default and means the machine the page runs on, which for
 * blocks is OPFS: the only local storage that holds gigabytes and answers a
 * read synchronously. A thread that cannot take a synchronous handle there (a
 * page's own) finds out when the cache opens, and runs uncached in memory.
 *
 * @param {any} spec  `'local'`, a directory of your own, or something falsy for none.
 * @returns {Promise<any>}
 */
export async function resolveBlockStore(spec){
    if (!spec)
    {
        return null;
    }
    if (spec !== 'local')
    {
        return spec;
    }
    const storage = /** @type {any} */ (globalThis).navigator?.storage;
    return storage?.getDirectory ? storage.getDirectory() : null;
}


/**
 * The files of the layouts this one replaced, at the root by the cache's file
 * name: a table and packs of records, an order, and the earlier ones' bitmaps
 * and slots. Their blocks are fetched again; what held them goes.
 *
 * @param {string} file
 */
const replacedLayout = file=>new RegExp(`^${file.replace(/\./g, '\\.')}`
    + '\\.(index|order|held|present|slots|pack(\\.\\d+)?|blocks(\\.\\d+)?)$');

/** The body the order of a run's first reads is kept in, beside the blocks. */
const ORDER = 'order';

/**
 * How many blocks the record of a run's reads holds. A start reads a few
 * hundred blocks before its first frame; a few thousand covers that with room
 * for what a run reads afterwards.
 */
const ORDER_LIMIT = 4096;

/** A block idle so long goes to the disk, its memory let go. */
const IDLE_MS = 30_000;

/** The longest span a keeper takes: with no disk, a block leaves only for room. */
const NEVER_MS = 2 ** 31 - 1;

/** How often the keeper looks for idle blocks and empty segments. */
const SWEEP_MS = 1000;

/**
 * How often, at most, what was fetched is written out with an index naming
 * it: a run killed loses what it fetched since, which the next run fetches.
 */
const SAVE_MS = 2000;


/** A segment's bytes: a power of two a block fits in, at most 16 MiB, within the budget. */
const segmentFor = (/** @type {number} */ blockSize, /** @type {number} */ budget)=>Math.max(
    2 ** Math.ceil(Math.log2(blockSize)),
    Math.min(16 << 20, 2 ** Math.floor(Math.log2(Math.max(budget, 1)))));


/**
 * The bundle's directory under `store`, the files of the layouts this one
 * replaced removed from the root first; null where the store has no
 * directories to give.
 *
 * @param {any} store @param {string} file
 */
async function directoryOf(store, file){
    if (typeof store?.getDirectoryHandle !== 'function')
    {
        return null;
    }
    if (typeof store.entries === 'function')
    {
        const replaced = replacedLayout(file);
        /** @type {string[]} */
        const old = [];
        for await (const [name] of store.entries())
        {
            if (replaced.test(name))
            {
                old.push(name);
            }
        }
        for (const name of old)
        {
            // One another tab's older build holds open stays.
            await Promise.resolve(store.removeEntry(name)).catch(()=>{});
        }
    }
    return (await store.getDirectoryHandle(BLOCK_DIRECTORY, { create: true }))
        .getDirectoryHandle(file, { create: true });
}

/**
 * @param {Object} options
 * @param {any} options.store  Where blocks are kept (`resolveBlockStore`), or null.
 * @param {string} options.name       Names this bundle's cache. Two bundles must
 *                                    not share one, so this is its identity.
 * @param {number} options.blockSize
 * @param {number} options.blockCount
 * @param {import('@bottlify/cellar').AccountMemory} options.account  The run's
 *     account: the blocks hot in shared memory are its `kind`, at most its
 *     ceiling, and go cold for another kind's take that does not fit
 *     (`makeRoom`).
 * @param {string} options.kind
 * @param {(reason: string) => void} [options.onFull]  Told, once a run, that the
 *     disk refused a block for lack of room.
 * @param {() => number} [options.now]  The keeper's clock, for a test.
 * @returns {Promise<BlockCache>}
 */
export async function createBlockCache(options){
    const { store, name, blockSize, blockCount, now, account, kind } = options;
    const budget = openAccount(account).bound(kind);
    /** Why the disk last refused for room, once it has. @type {string | null} */
    let full = null;
    const onQuota = (/** @type {string} */ reason)=>{
        if (full === null)
        {
            full = reason;
            options.onFull?.(reason);
        }
    };
    /** @type {any} */
    let reader = null;
    /** @param {Disk | null} disk */
    const open = disk=>openKeeper({
        account, kind, segmentBytes: segmentFor(blockSize, budget), disk,
        coldAfterMs: disk === null ? NEVER_MS : IDLE_MS,
        announce: message=>reader?.adopt(message),
        ...now ? { now } : {},
    });
    /** Why there is no disk, while there is none. @type {string | null} */
    let reason = store ? null : 'no store';
    let keeper;
    /** @type {ReturnType<typeof opfsDisk> | null} */
    let disk = null;
    try
    {
        const directory = store ? await directoryOf(store, fileNameOf(name)) : null;
        reason ??= directory === null ? 'the store gives no directory' : null;
        disk = directory === null ? null : opfsDisk(directory, { onQuota });
        keeper = await open(disk);
    }
    catch (e){
        // A store that will not open is a slower run, not a failed one: a
        // thread with no synchronous handle (a page's own), another tab
        // holding the bundle's files, an index file the disk failed to read.
        reason = /** @type {Error} */ (e).message;
        disk = null;
        keeper = await open(null);
    }
    const backed = reason === null;
    /**
     * Until the pack the keeper opened ahead is open, nothing goes to the
     * disk: what a run puts and saves at once would stay in memory alone. The
     * keeper takes a pack opened in a step after its file's own (a macrotask
     * is past all of them).
     */
    const diskReady = async()=>{
        await disk?.settled();
        await new Promise(resolve=>setTimeout(resolve));
    };
    await diskReady();
    const opened = keeper;
    reader = createReader({ shared: opened.shared, segments: opened.segmentBuffers(), keeper: {
        reserve: (body, length, given)=>opened.reserve(body, length, given),
        raise: (body, given)=>opened.raise(body, given),
        raiseLater: ()=>{},
        drop: body=>{
            opened.drop(body);
        },
    } });
    const blocks = /** @type {import('@bottlify/cellar').Reader} */ (reader);
    const sweeping = setInterval(()=>opened.sweep(), SWEEP_MS);
    // A run's timer is not what keeps a host's process alive.
    /** @type {any} */ (sweeping).unref?.();

    /** Each block's name, made once: a read looks it up by the same string. @type {string[]} */
    const names = [];
    /** @param {number} index */
    const nameOf = index=>(names[index] ??= String(index));

    /**
     * The order the last run first asked for its blocks in: what a filler
     * should bring in before anything else, because a start reads the same
     * things in the same order every time.
     *
     * @type {number[]}
     */
    const previous = blocks.with(ORDER, body=>Array.from(
        new Uint32Array(body.slice().buffer)).filter(index=>index < blockCount), { wait: true })
        ?? [];
    /** This run's first demands, in order. @type {Set<number>} */
    const demanded = new Set();
    let dirty = false;
    let savedAt = -Infinity;
    let closed = false;

    /** The order put beside the blocks, then everything written out with its index. */
    const save = ()=>{
        if (dirty)
        {
            // This run's order first, then whatever the last run reached that
            // this one has not yet: a run cut short must not shed what a
            // longer one learned.
            const order = new Uint32Array([...demanded,
                ...previous.filter(index=>!demanded.has(index))].slice(0, ORDER_LIMIT));
            blocks.put(ORDER, new Uint8Array(order.buffer));
            dirty = false;
        }
        savedAt = performance.now();
        return opened.save();
    };

    /** A save put off for the last one's sake, to come at its time. @type {any} */
    let later = null;
    /**
     * Called when a batch of blocks has been brought in: what is hot and not
     * on the disk is written out, and an index naming it, for the next run;
     * every few seconds at most, a batch landing sooner saved when they are
     * up, so the last of a run is on the disk however the run ends.
     */
    const persist = async()=>{
        if (!backed || closed || later !== null)
        {
            return;
        }
        const wait = savedAt + SAVE_MS - performance.now();
        if (wait > 0)
        {
            later = setTimeout(()=>{
                later = null;
                persist();
            }, wait);
            later.unref?.();
            return;
        }
        // Marked now: a batch landing meanwhile waits for the next turn.
        savedAt = performance.now();
        await diskReady();
        if (!closed)
        {
            save();
        }
    };

    return {
        backed,
        reason,

        /** Whether block `index` is here, in memory or on the disk. @param {number} index */
        has: index=>blocks.look(nameOf(index)) !== null,

        /**
         * Block `index` read in place inside `read`, brought back from the
         * disk first where it is cold; undefined where it is not here.
         *
         * @template T
         * @param {number} index @param {(body: Uint8Array) => T} read
         * @returns {T | undefined}
         */
        with: (index, read)=>blocks.with(nameOf(index), read, { wait: true }),

        /**
         * A block, decoded, kept: false where there was no room for it, and the
         * read that wanted it fetches it again.
         *
         * @param {number} index @param {Uint8Array} bytes
         */
        put: (index, bytes)=>blocks.put(nameOf(index), bytes),

        /**
         * A read wanted this block. Only the first time counts, and only the
         * order: what is recorded is the sequence a start reads in.
         *
         * @param {number} index
         */
        demanded(index){
            if (backed && demanded.size < ORDER_LIMIT && !demanded.has(index))
            {
                demanded.add(index);
                dirty = true;
            }
        },

        /** What the last run asked for, in the order it asked. */
        order: ()=>previous,

        persist,

        /** Why the disk refused a block for room, once it has: the store is full. */
        full: ()=>full,

        /** Room in the account for `bytes` more of another kind, cold blocks let go for it. */
        makeRoom: (/** @type {number} */ bytes)=>opened.makeRoom(bytes),

        diagnostics(){
            const figures = opened.figures();
            const order = blocks.look(ORDER) === null ? 0 : 1;
            // The keeper's segments and its index are what the tab holds of
            // the blocks; the rest is on the disk.
            return { backed, resident: figures.hot + figures.cold - order, blocks: blockCount,
                heapBytes: figures.segmentBytes + figures.indexBytes,
                coldBytes: figures.coldBytes, ...full === null ? {} : { full },
                ...backed ? {} : { reason }, cellar: figures };
        },

        /** Saves, and lets go of the disk's files: the run is over. */
        close(){
            if (closed)
            {
                return;
            }
            closed = true;
            clearInterval(sweeping);
            clearTimeout(later);
            if (backed)
            {
                save();
            }
            opened.close();
        },
    };
}

/**
 * @typedef {Object} BlockCache
 * @property {boolean} backed  whether blocks are kept on a disk
 * @property {string | null} reason  why not, where they are not
 * @property {(index: number) => boolean} has
 * @property {<T>(index: number, read: (body: Uint8Array) => T) => T | undefined} with
 * @property {(index: number, bytes: Uint8Array) => boolean} put
 * @property {(index: number) => void} demanded
 * @property {() => number[]} order
 * @property {() => Promise<void>} persist
 * @property {() => string | null} full
 * @property {(bytes: number) => boolean} makeRoom
 * @property {() => Record<string, any>} diagnostics
 * @property {() => void} close
 */
