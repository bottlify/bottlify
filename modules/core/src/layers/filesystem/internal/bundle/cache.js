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
 * A block is appended, into the next slot of `blockSize` bytes, and a table of
 * a slot per block says where. Not `index * blockSize`: the file would be as
 * long as the highest block fetched, and a browser counts that length against
 * the origin's quota (and on some file systems allocates it). A bundle whose
 * program and libraries were packed last asks for its last blocks first, and
 * a cache of a few megabytes asked for the whole bundle's length -- past the
 * quota, and the start failed on its first write. The read stays one table
 * lookup and one read, and blocks are never moved, so nothing fragments.
 *
 * What is stored is the block exactly as `readBlock` must hand it back -- so a
 * zstd block is stored packed, since the decoder that answers a synchronous
 * read is happy to run on every read, and a deflate block is stored inflated,
 * since no synchronous inflate exists to run later. That is why a slot's used
 * length comes from the bundle rather than from a header of our own: the bundle
 * already knows both numbers.
 *
 * The slot table is what makes a second session cheap. It is written beside
 * the data, and a cache whose table does not match the bundle it is asked
 * about is discarded with its data rather than trusted -- two different games
 * must not be able to read each other's bytes through the same slots.
 *
 * A store that fills up is a slower run, not a failed one: a block it refuses
 * is held in the heap, as where there is no store at all.
 */

import { createOpfsStore } from '../opfs-store.js';
import { Codec, HEADER_SIZE, openBundle, withManifest } from './format.js';

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

/**
 * The slot table as it is kept (`<name>.slots`): a 32-bit word a block, its
 * slot plus one, zero while the block is absent. Null where the file is of
 * another bundle's size.
 *
 * @param {Uint8Array} stored @param {number} blockCount
 * @returns {Uint32Array | null}
 */
const slotTable = (stored, blockCount)=>(stored.length === blockCount * 4
    ? new Uint32Array(stored.slice().buffer) : null);

/**
 * The name a bundle's blocks are kept under: its id and the fingerprint of its
 * index, so a bundle packed again starts a cache of its own.
 *
 * @param {string} id  @param {string} fingerprint
 */
export const blockCacheName = (id, fingerprint)=>`${id}-${fingerprint}`;

/**
 * How much of a bundle this machine already holds, read from the cache's
 * slot table without opening it for writing: what a page asks before a start, to
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
    /** @type {Uint32Array | null} */
    let slots = null;
    try
    {
        const file = await (await root.getFileHandle(`${name}.slots`)).getFile();
        slots = slotTable(new Uint8Array(await file.arrayBuffer()), bundle.blockCount);
    }
    catch {
        // No cache yet: nothing of it is here.
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
        if (slots && slots[index] !== 0)
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
    let slots;
    let data;
    try
    {
        slots = slotTable(new Uint8Array(await (await (await root.getFileHandle(`${name}.slots`))
            .getFile()).arrayBuffer()), bundle.blockCount);
        data = await (await root.getFileHandle(`${name}.blocks`)).getFile();
    }
    catch {
        return null;
    }
    if (slots === null)
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
            whole &&= slots[at] !== 0;
            const block = bundle.block(at);
            const packed = storedLength(block);
            const from = (slots[at] - 1) * bundle.blockSize;
            parts.push(data.slice(from, from + packed));
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
    const slotsPath = `${file}.slots`;
    const orderPath = `${file}.order`;

    try
    {
        await store.open(dataPath);
        await store.open(slotsPath);
        await store.open(orderPath);
    }
    catch (e){
        // A store that will not open is a slower run, not a failed one. The
        // ordinary reason is a build outside a worker, where no synchronous
        // handle on OPFS exists to be had.
        return createMemoryCache(maxHeapBytes, /** @type {Error} */ (e).message);
    }

    // A table of the wrong size belongs to a different bundle, or to a version
    // of this one with different blocks; no table at all, to a cache laid out
    // before there was one. Either way the data underneath it means something
    // else, so it starts again, data and all, rather than being partly believed.
    const held = store.stat(slotsPath);
    let slots = held ? slotTable(store.read(slotsPath, 0, held.size), blockCount) : null;
    /**
     * The order the last run first asked for its blocks in: what a filler
     * should bring in before anything else, because a start reads the same
     * things in the same order every time.
     *
     * @type {number[]}
     */
    let previous = [];
    if (slots)
    {
        const stored = store.read(orderPath, 0, ORDER_LIMIT * 4);
        previous = [...new Uint32Array(stored.buffer, stored.byteOffset, stored.length >> 2)]
            .filter(index=>index < blockCount);
    }
    else
    {
        slots = new Uint32Array(blockCount);
        store.truncate(dataPath, 0);
        store.truncate(slotsPath, slots.byteLength);
        store.truncate(orderPath, 0);
    }
    const table = slots;
    /** Slots taken: the next block goes after the last one the table names. */
    let used = table.reduce((most, slot)=>Math.max(most, slot), 0);
    /** The table's entries changed since it was written, as a range of blocks. */
    let low = blockCount;
    let high = -1;
    /** Blocks the store refused, the run's own and bounded, and why it refused. */
    const refused = createMemoryCache(maxHeapBytes, 'the store is full');
    /** @type {string | null} */
    let full = null;

    /** This run's first demands, in order. @type {Set<number>} */
    const demanded = new Set();
    let dirty = false;

    return {
        backed: true,

        /** @param {number} index */
        has: index=>table[index] !== 0 || refused.has(index),

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
            if (table[index] === 0)
            {
                return refused.read(index);
            }
            return store.read(dataPath, (table[index] - 1) * blockSize, length);
        },

        /**
         * @param {number} index
         * @param {Uint8Array} bytes
         */
        put(index, bytes){
            if (table[index] !== 0)
            {
                store.write(dataPath, (table[index] - 1) * blockSize, bytes);
                return;
            }
            try
            {
                store.write(dataPath, used * blockSize, bytes);
            }
            catch (e){
                // Past the origin's quota, or a disk with no room: the run goes on
                // with this block in the heap, and the next run fetches it again.
                full = /** @type {Error} */ (e).message;
                refused.put(index, bytes);
                return;
            }
            table[index] = ++used;
            low = Math.min(low, index);
            high = Math.max(high, index);
            dirty = true;
        },

        /**
         * Writes the table out. Called when a batch of blocks has been brought
         * in rather than on every one: losing the record of a block that is on
         * disk costs one refetch, and a write per block would cost far more.
         * A slot written and not recorded is taken again by the next run.
         */
        async persist(){
            await refused.persist();
            if (!dirty)
            {
                return;
            }
            if (high >= low)
            {
                store.write(slotsPath, low * 4,
                    new Uint8Array(table.buffer, low * 4, (high - low + 1) * 4));
                low = blockCount;
                high = -1;
            }
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
            const inHeap = refused.diagnostics();
            // In the heap the table, and what the store refused; the rest is on disk.
            return { backed: true, resident: used + inHeap.resident, blocks: blockCount,
                heapBytes: table.byteLength + inHeap.heapBytes, ...full === null ? {} : { full } };
        },
    };
}
