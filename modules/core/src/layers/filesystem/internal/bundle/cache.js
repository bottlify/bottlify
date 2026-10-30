/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
import { Codec, HEADER_SIZE, openBundle, withManifest } from './format.js';

/** @typedef {{ read: Function, write: Function, truncate: Function, stat: Function, open: Function, remove: Function }} BlockStore */

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

/**
 * The table a short-lived appended layout kept beside a cache: its blocks were
 * laid in the order they came, not at their index, while the bitmap beside
 * them still said where they had been. A cache that has one is not believed.
 *
 * @param {string} file  The cache's file name, without its suffix.
 */
const appendedTable = file=>`${file}.slots`;

/**
 * Whether a cache at the root of the origin's file system holds that table.
 *
 * @param {FileSystemDirectoryHandle} root @param {string} file
 */
const relaidAt = async(root, file)=>{
    try
    {
        await root.getFileHandle(appendedTable(file));
        return true;
    }
    catch {
        return false;
    }
};

/** Bytes of bitmap for this many blocks. @param {number} blockCount */
const bitmapBytes = blockCount=>Math.ceil(blockCount / 8);

/**
 * The name a bundle's blocks are kept under: its id and the fingerprint of its
 * index, so a bundle packed again starts a cache of its own.
 *
 * @param {string} id  @param {string} fingerprint
 */
export const blockCacheName = (id, fingerprint)=>`${id}-${fingerprint}`;

/**
 * How much of a bundle this machine already holds, read from the cache's
 * bitmap without opening it for writing: what a page asks before a start, to
 * say whether the game is here whole. The blocks of the translation seed are
 * not counted, being the translator's store's and read once.
 *
 * @param {Object} options
 * @param {any} options.root  The origin's file system (`navigator.storage.getDirectory()`).
 * @param {string} options.id  The bundle's id, as the engine is given it.
 * @param {{ fingerprint: string, blockCount: number, block: (index: number) => { packed: number },
 *     translations: { firstBlock: number, blocks: number } | null }} options.bundle  Opened.
 * @returns {Promise<{ blocks: number, resident: number, bytes: number, residentBytes: number }>}
 */
export async function bundleResidency({ root, id, bundle }){
    const name = blockCacheName(id, bundle.fingerprint).replace(/[^A-Za-z0-9._-]/g, '_');
    /** @type {Uint8Array | null} */
    let bitmap = null;
    try
    {
        const file = await (await root.getFileHandle(`${name}.present`)).getFile();
        bitmap = new Uint8Array(await file.arrayBuffer());
    }
    catch {
        // No cache yet: nothing of it is here.
    }
    if (bitmap && (bitmap.length !== bitmapBytes(bundle.blockCount) || await relaidAt(root, name)))
    {
        bitmap = null;
    }
    const seed = bundle.translations;
    const out = { blocks: 0, resident: 0, bytes: 0, residentBytes: 0 };
    for (let index = 0; index < bundle.blockCount; index++)
    {
        if (seed && index >= seed.firstBlock && index < seed.firstBlock + seed.blocks)
        {
            continue;
        }
        const { packed } = bundle.block(index);
        out.blocks++;
        out.bytes += packed;
        if (bitmap && isSet(bitmap, index))
        {
            out.resident++;
            out.residentBytes += packed;
        }
    }
    return out;
}

/**
 * How much of a block its slot holds: a zstd block is kept packed, because the
 * decoder that answers a guest read runs synchronously, and everything else is
 * kept in the form a read can use as it stands -- a deflate block inflated.
 *
 * @param {{ codec: number, packed: number, length: number }} block
 */
export const storedLength = block=>block.codec === Codec.ZSTD ? block.packed : block.length;

/**
 * A bundle as this machine holds it, put together as a container of its own
 * from the block cache alone: a game played or downloaded here is saved
 * without its bytes fetched again. Only the index is read from the container,
 * and with it the description to write in. A deflate block comes out stored,
 * as the cache keeps it inflated, and without its checksum, which was of the
 * packed bytes; the translation seed is left out, being the translator's
 * store's and not the cache's, and the next start translates afresh.
 *
 * @param {Object} options
 * @param {any} options.root  The origin's file system (`navigator.storage.getDirectory()`).
 * @param {string} options.id  The bundle's id, as the engine is given it.
 * @param {import('./format.js').FetchRange} options.fetchRange  The container.
 * @param {import('./format.js').IndexDecode} options.decode
 * @param {Record<string, unknown> | null} options.manifest
 * @returns {Promise<Blob | null>}  A Blob of slices of the cache, copied only as it is
 *     read; null when the cache does not hold every block.
 */
export async function cachedBundle({ root, id, fetchRange, decode, manifest }){
    /** @type {Map<string, Promise<Uint8Array>>} */
    const fetched = new Map();
    /** @type {import('./format.js').FetchRange} */
    const once = (offset, length)=>{
        const key = `${offset}+${length}`;
        if (!fetched.has(key))
        {
            fetched.set(key, fetchRange(offset, length));
        }
        return /** @type {Promise<Uint8Array>} */ (fetched.get(key));
    };
    const bundle = await openBundle(once, decode);
    const name = blockCacheName(id, bundle.fingerprint).replace(/[^A-Za-z0-9._-]/g, '_');
    let bitmap;
    let data;
    try
    {
        bitmap = new Uint8Array(await (await (await root.getFileHandle(`${name}.present`))
            .getFile()).arrayBuffer());
        data = await (await root.getFileHandle(`${name}.blocks`)).getFile();
    }
    catch {
        return null;
    }
    if (bitmap.length !== bitmapBytes(bundle.blockCount) || await relaidAt(root, name))
    {
        return null;
    }
    const seed = bundle.translations;
    /** @type {Blob[]} */
    const parts = [];
    let whole = true;
    const { header, index } = await withManifest(once, decode, manifest, stored=>{
        let offset = HEADER_SIZE;
        stored.blocks = stored.blocks.map((/** @type {any} */ record, /** @type {number} */ at)=>{
            if (seed && at >= seed.firstBlock && at < seed.firstBlock + seed.blocks)
            {
                return { offset, packed: 0, codec: Codec.STORED };
            }
            whole &&= isSet(bitmap, at);
            const block = bundle.block(at);
            const packed = storedLength(block);
            parts.push(data.slice(at * bundle.blockSize, at * bundle.blockSize + packed));
            const laid = { ...record, offset, packed };
            if (block.codec === Codec.DEFLATE_RAW)
            {
                laid.codec = Codec.STORED;
                delete laid.crc;
            }
            offset += packed;
            return laid;
        });
        delete stored.translations;
        return offset;
    });
    return whole ? new Blob(/** @type {BlobPart[]} */ ([header, ...parts, index])) : null;
}

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
 * @param {string} reason  Why there is no durable store, for the journal.
 * @returns {any}
 */
function createMemoryCache(maxBytes, reason){
    /** Insertion order is least-recently-used order. @type {Map<number, Uint8Array>} */
    const held = new Map();
    /** Brought in for the read currently being served. @type {Set<number>} */
    const pinned = new Set();
    let bytes = 0;

    /** Lets the least recently used blocks go, those of the read being served aside. */
    const trim = ()=>{
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
    };

    return {
        backed: false,
        reason,

        /** @param {number} index */
        has: index=>held.has(index),

        /** Nothing durable to keep an order in, so nothing is remembered. */
        demanded(){},
        /** @returns {number[]} */
        order: ()=>[],

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
            // A block put again replaces itself, counted once.
            bytes += value.length - (held.get(index)?.length ?? 0);
            held.delete(index);
            held.set(index, value);
            pinned.add(index);
            trim();
        },

        /**
         * Not persistence here, but the end of a read: what it needed is free,
         * and what it held past the bound goes now rather than at the next put.
         */
        async persist(){
            pinned.clear();
            trim();
        },

        // `heapBytes`: what of it the tab's heaps hold (`memory-zones.js`), all of it here.
        diagnostics: ()=>({ backed: false, resident: held.size, bytes, heapBytes: bytes }),
    };
}

/**
 * How many blocks the record of a run's reads holds. A start reads a few
 * hundred blocks before its first frame; a few thousand covers that with room
 * for what a run reads afterwards, and stays a small file beside the blocks.
 */
const ORDER_LIMIT = 4096;

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
    const { store, name, blockSize, blockCount } = options;
    // Counted in blocks rather than bytes, because what the bound has to hold is
    // the blocks of one read: too few of them and every read evicts the one
    // before it. Sixty-four mebibytes is the floor for a small block size, not
    // the answer for every one.
    const maxHeapBytes = options.maxHeapBytes
        ?? Math.max(64 << 20, 32 * blockSize);
    if (!store)
    {
        return createMemoryCache(maxHeapBytes, 'no store');
    }

    // A bare file name at the store's root: the origin's file system refuses a
    // name with a separator in it, and a bundle's id is not ours to vet.
    const file = name.replace(/[^A-Za-z0-9._-]/g, '_');
    const dataPath = `${file}.blocks`;
    const bitmapPath = `${file}.present`;
    const orderPath = `${file}.order`;
    const bitmap = new Uint8Array(bitmapBytes(blockCount));

    try
    {
        await store.open(dataPath);
        await store.open(bitmapPath);
        await store.open(orderPath);
    }
    catch (e){
        // A store that will not open is a slower run, not a failed one. The
        // ordinary reason is a build outside a worker, where no synchronous
        // handle on OPFS exists to be had.
        return createMemoryCache(maxHeapBytes, /** @type {Error} */ (e).message);
    }

    // A bitmap of the wrong size belongs to a different bundle, or to a version
    // of this one with different blocks. Either way the slots underneath it mean
    // something else, so it starts again rather than being partly believed.
    const relaid = store.stat(appendedTable(file)) !== null;
    const held = relaid ? null : store.stat(bitmapPath);
    /**
     * The order the last run first asked for its blocks in: what a filler
     * should bring in before anything else, because a start reads the same
     * things in the same order every time.
     *
     * @type {number[]}
     */
    let previous = [];
    if (held && held.size === bitmap.length)
    {
        bitmap.set(store.read(bitmapPath, 0, bitmap.length));
        const stored = store.read(orderPath, 0, ORDER_LIMIT * 4);
        previous = [...new Uint32Array(stored.buffer, stored.byteOffset, stored.length >> 2)]
            .filter(index=>index < blockCount);
    }
    else
    {
        if (relaid)
        {
            store.truncate(dataPath, 0);
            store.remove(appendedTable(file));
        }
        store.truncate(bitmapPath, bitmap.length);
        store.write(bitmapPath, 0, bitmap);
        store.truncate(orderPath, 0);
    }

    /** This run's first demands, in order. @type {Set<number>} */
    const demanded = new Set();
    let dirty = false;

    return {
        backed: true,

        /** @param {number} index */
        has: index=>isSet(bitmap, index),

        /**
         * A read wanted this block. Only the first time counts, and only the
         * order: what is recorded is the sequence a start reads in.
         *
         * @param {number} index
         */
        demanded(index){
            if (demanded.size < ORDER_LIMIT && !demanded.has(index))
            {
                demanded.add(index);
                dirty = true;
            }
        },

        /** What the last run asked for, in the order it asked. */
        order: ()=>previous,

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
            // This run's order first, then whatever the last run reached that
            // this one has not yet: a run cut short must not shed what a
            // longer one learned.
            const order = new Uint32Array([...demanded,
                ...previous.filter(index=>!demanded.has(index))].slice(0, ORDER_LIMIT));
            store.truncate(orderPath, order.byteLength);
            store.write(orderPath, 0, new Uint8Array(order.buffer));
            dirty = false;
        },

        diagnostics(){
            let resident = 0;
            for (let at = 0; at < blockCount; at++)
            {
                resident += isSet(bitmap, at) ? 1 : 0;
            }
            // In the heap only the record of which blocks are here: the blocks are on disk.
            return { backed: true, resident, blocks: blockCount, heapBytes: bitmap.length };
        },
    };
}
