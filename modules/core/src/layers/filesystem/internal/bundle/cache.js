/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Where a fetched block lives between the network and a guest read.
 *
 * The constraint that decides everything here is size. A bundle may be larger
 * than the address space a browser will give a single ArrayBuffer, so the
 * blocks brought in over a session cannot accumulate in the heap -- and the
 * heap is exactly where they would accumulate, since a program that touches a
 * lot of a large game touches nearly all of it. So the blocks go to storage,
 * and what stays in memory is a fixed-size record of which ones are there.
 *
 * A block occupies a fixed slot, `index * blockSize`, rather than being
 * appended. Two reasons: the read that a guest is waiting on becomes one
 * arithmetic step and one read with no index to consult, and a cache written
 * over several sessions never fragments or needs compacting.
 *
 * What is stored is the block exactly as `readBlock` must hand it back -- so a
 * zstd block is stored packed, since the decoder that answers a synchronous
 * read is happy to run on every read, and a deflate block is stored inflated,
 * since no synchronous inflate exists to run later. That is why a slot's used
 * length comes from the bundle rather than from a header of our own: the bundle
 * already knows both numbers.
 *
 * The presence bitmap is what makes a second session cheap. It is written
 * beside the data, and a cache whose bitmap does not match the bundle it is
 * asked about is discarded rather than trusted -- two different games must not
 * be able to read each other's bytes through the same slot arithmetic.
 */

import { createOpfsStore } from '../opfs-store.js';

/** @typedef {{ read: Function, write: Function, truncate: Function, stat: Function, open: Function }} BlockStore */

/**
 * Turns what a caller asked for into somewhere to put blocks.
 *
 * `'local'` is the default and means the machine the page is running on, which
 * for blocks is OPFS: the sessions option spells its own local answer the same
 * way, and there is only one kind of local storage that can hold gigabytes and
 * answer a read synchronously.
 *
 * It is a request rather than an assertion. The synchronous handles this needs
 * exist only inside a worker, and a build on the main thread has to reach a
 * running engine anyway, so an environment that cannot provide one answers with
 * nothing and the run proceeds uncached rather than failing.
 *
 * @param {any} spec  `'local'`, a store of your own, or something falsy for none.
 * @returns {Promise<BlockStore | null>}
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
    if (!storage?.getDirectory)
    {
        return null;
    }
    return createOpfsStore({ root: await storage.getDirectory() });
}

/** Bytes of bitmap for this many blocks. @param {number} blockCount */
const bitmapBytes = blockCount=>Math.ceil(blockCount / 8);

/**
 * @param {Uint8Array} bitmap
 * @param {number} index
 */
const isSet = (bitmap, index)=>(bitmap[index >> 3] & 1 << (index & 7)) !== 0;

/**
 * @param {Uint8Array} bitmap
 * @param {number} index
 */
const set = (bitmap, index)=>{
    bitmap[index >> 3] |= 1 << (index & 7);
};

/**
 * The fallback: blocks in the heap, bounded, forgotten when the tab closes.
 *
 * A build outside a worker cannot take a synchronous handle on OPFS at all, and
 * a test has no reason to want one. Such a build still runs -- more slowly, and
 * paying the network again for anything it has let go.
 *
 * It cannot simply hold nothing. A read of an absent block reports which blocks
 * it needs and is retried once they are here, so a cache that never becomes
 * resident does not make the run slower, it makes it never finish.
 *
 * Which is why blocks brought in for the read now being served are pinned until
 * that read has had its turn. A single read can want more blocks than the
 * bound, and evicting one of them to make room for the next would be the same
 * deadlock arriving by a longer route.
 *
 * @param {number} maxBytes
 * @returns {any}
 */
function createMemoryCache(maxBytes){
    /** Insertion order is least-recently-used order. @type {Map<number, Uint8Array>} */
    const held = new Map();
    /** Brought in for the read currently being served. @type {Set<number>} */
    const pinned = new Set();
    let bytes = 0;

    return {
        backed: false,

        /** @param {number} index */
        has: index=>held.has(index),

        /** @param {number} index */
        read(index){
            const found = held.get(index);
            if (!found)
            {
                return null;
            }
            held.delete(index);
            held.set(index, found);
            return found;
        },

        /** @param {number} index @param {Uint8Array} value */
        put(index, value){
            held.set(index, value);
            pinned.add(index);
            bytes += value.length;
            for (const [at, stored] of held)
            {
                if (bytes <= maxBytes)
                {
                    break;
                }
                if (pinned.has(at))
                {
                    continue;
                }
                held.delete(at);
                bytes -= stored.length;
            }
        },

        /** Not persistence here, but the end of a read: what it needed is free. */
        async persist(){
            pinned.clear();
        },

        diagnostics: ()=>({ backed: false, resident: held.size, bytes }),
    };
}

/**
 * @param {Object} options
 * @param {BlockStore | null} options.store  Synchronous byte storage, or null.
 * @param {string} options.name       Names this bundle's cache. Two bundles must
 *                                    not share one, so this is its identity.
 * @param {number} options.blockSize
 * @param {number} options.blockCount
 * @param {number} [options.maxHeapBytes]  Bound on the fallback, when there is
 *                                         nowhere to put blocks but the heap.
 * @returns {Promise<any>}
 */
export async function createBlockCache(options){
    const { store, name, blockSize, blockCount, maxHeapBytes = 64 << 20 } = options;
    if (!store)
    {
        return createMemoryCache(maxHeapBytes);
    }

    const dataPath = `/${name}.blocks`;
    const bitmapPath = `/${name}.present`;
    const bitmap = new Uint8Array(bitmapBytes(blockCount));

    try
    {
        await store.open(dataPath);
        await store.open(bitmapPath);
    }
    catch {
        // A store that will not open is a slower run, not a failed one. The
        // ordinary reason is a build outside a worker, where no synchronous
        // handle on OPFS exists to be had.
        return createMemoryCache(maxHeapBytes);
    }

    // A bitmap of the wrong size belongs to a different bundle, or to a version
    // of this one with different blocks. Either way the slots underneath it mean
    // something else, so it starts again rather than being partly believed.
    const held = store.stat(bitmapPath);
    if (held && held.size === bitmap.length)
    {
        bitmap.set(store.read(bitmapPath, 0, bitmap.length));
    }
    else
    {
        store.truncate(bitmapPath, bitmap.length);
        store.write(bitmapPath, 0, bitmap);
    }

    let dirty = false;

    return {
        backed: true,

        /** @param {number} index */
        has: index=>isSet(bitmap, index),

        /**
         * @param {number} index
         * @param {number} length  What this block occupies, from the bundle.
         * @returns {Uint8Array | null}
         */
        read(index, length){
            if (!isSet(bitmap, index))
            {
                return null;
            }
            return store.read(dataPath, index * blockSize, length);
        },

        /**
         * @param {number} index
         * @param {Uint8Array} bytes
         */
        put(index, bytes){
            store.write(dataPath, index * blockSize, bytes);
            set(bitmap, index);
            dirty = true;
        },

        /**
         * Writes the bitmap out. Called when a batch of blocks has been brought
         * in rather than on every one: losing the record of a block that is on
         * disk costs one refetch, and a write per block would cost far more.
         */
        async persist(){
            if (!dirty)
            {
                return;
            }
            store.write(bitmapPath, 0, bitmap);
            dirty = false;
        },

        diagnostics(){
            let resident = 0;
            for (let at = 0; at < blockCount; at++)
            {
                resident += isSet(bitmap, at) ? 1 : 0;
            }
            return { backed: true, resident, blocks: blockCount };
        },
    };
}
