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
 * The blocks are written one after another into one file (`cacheFiles.pack`),
 * in the order they arrive, and a table (`cacheFiles.index`) gives each block's
 * offset there, or none: the file is as long as the blocks it holds, whichever
 * of the bundle they are. A slot from the index alone made the file as long as
 * the highest block read, and the browser counts a file's length against the
 * origin's quota (and on some file systems allocates it): a game that read
 * 1 437 of its 68 616 blocks across the bundle held its whole length on disk.
 *
 * Each block goes in with a header of its own -- a mark, its index and its
 * length -- and a read checks it before the bytes go to a guest, so a table
 * that names another block's bytes (another writer's, a write cut short, a
 * table of a run that never wrote its block) is a block fetched again, never
 * another block handed out. Where a block goes is the end of the file as the
 * store has it at the write, not a count a writer keeps of its own: two caches
 * of one bundle on one store put their blocks one after the other, and a block
 * two of them put is there twice, each copy whole. Each block's offset is
 * written into the table as it is put, at the block's own place in the table,
 * so one writer's table write does not undo the other's.
 *
 * What is stored is the block exactly as `readBlock` must hand it back -- so a
 * zstd block is stored packed, since the decoder that answers a synchronous
 * read is happy to run on every read, and a deflate block is stored inflated,
 * since no synchronous inflate exists to run later. That is why a slot's used
 * length comes from the bundle rather than from a header of our own: the bundle
 * already knows both numbers.
 *
 * The table is what makes a second session cheap. A cache whose table is not
 * this bundle's size, or whose file of blocks does not start with this layout's
 * mark, is discarded rather than trusted, and so is every file of the layouts
 * this one replaced.
 *
 * A store that fills up is a slower run, not a failed one: a block it refuses
 * is held in the heap, as where there is no store at all.
 */

import { createOpfsStore } from '../opfs-store.js';
import { Codec, HEADER_SIZE, openBundle, withManifest } from './format.js';

/**
 * @typedef {{ read: Function, write: Function, truncate: Function, stat: Function,
 *     open: Function, remove: Function, flush?: Function }} BlockStore
 */

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
    // Unbounded: the cache's files stay open, because a guest read cannot wait
    // for a handle, and a bounded pool would close one under it.
    return createOpfsStore({ root: await storage.getDirectory(),
        maxOpenHandles: Number.MAX_SAFE_INTEGER });
}

/**
 * Blocks a segment file held, in the layout before this one: block N at
 * `(N mod 1024) * blockSize` of `<name>.blocks.<floor(N / 1024)>`. Only its
 * files' names are left of it, for the cache that finds them to drop.
 */
const SEGMENT_BLOCKS = 1024;

/**
 * The files of a cache, by its file name (`blockCacheName`, made safe), all at
 * the root of the origin's file system: the table, the blocks, and the order the
 * last run read in. `replaced` are the files of the layouts this one replaced
 * -- the one-file `.blocks` with its `.present` bitmap, the first appended
 * layout's `.slots` table, and the segments `.blocks.<k>` with their `.held`
 * bitmap -- which a cache that finds them drops.
 */
export const cacheFiles = {
    /** @param {string} file */
    index: file=>`${file}.index`,
    /** @param {string} file */
    pack: file=>`${file}.pack`,
    /** @param {string} file */
    order: file=>`${file}.order`,
    /** @param {string} file @param {number} blockCount */
    replaced: (file, blockCount)=>[`${file}.blocks`, `${file}.present`, `${file}.slots`,
        `${file}.held`, ...Array.from({ length: Math.ceil(blockCount / SEGMENT_BLOCKS) },
            (_, k)=>`${file}.blocks.${k}`)],
};

/** The pack file's own header: its mark and the layout's version, then room. */
const PACK_HEADER = 16;
/** 'BPAK', the pack's mark. */
const PACK_MARK = 0x4b415042;
const PACK_VERSION = 1;
/** A block's header in the pack: its mark, its index, its length, and a word of room. */
const RECORD_HEADER = 16;
/** 'BLK1', a block's mark. */
const RECORD_MARK = 0x314b4c42;
/** Bytes of the table a block takes: its offset in the pack as a double, 0 for none. */
const ENTRY_BYTES = 8;

/** The pack's header as a new pack starts with it. */
const packHeader = ()=>{
    const header = new Uint8Array(PACK_HEADER);
    const view = new DataView(header.buffer);
    view.setUint32(0, PACK_MARK, true);
    view.setUint32(4, PACK_VERSION, true);
    return header;
};

/** Whether bytes start a pack of this layout. @param {Uint8Array} bytes */
const isPack = bytes=>bytes.length >= PACK_HEADER
    && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === PACK_MARK
    && new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true) === PACK_VERSION;

/**
 * A block as the pack holds it: its header, then its bytes.
 *
 * @param {number} index @param {Uint8Array} bytes
 */
const recordOf = (index, bytes)=>{
    const record = new Uint8Array(RECORD_HEADER + bytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, RECORD_MARK, true);
    view.setUint32(4, index, true);
    view.setUint32(8, bytes.length, true);
    record.set(bytes, RECORD_HEADER);
    return record;
};

/**
 * Whether a record's header, as read, is block `index`'s of `length` bytes.
 *
 * @param {Uint8Array} header @param {number} index @param {number} length
 */
const recordIs = (header, index, length)=>{
    if (header.length < RECORD_HEADER)
    {
        return false;
    }
    const view = new DataView(header.buffer, header.byteOffset, RECORD_HEADER);
    return view.getUint32(0, true) === RECORD_MARK && view.getUint32(4, true) === index
        && view.getUint32(8, true) === length;
};

/** Bytes of table for this many blocks. @param {number} blockCount */
const tableBytes = blockCount=>blockCount * ENTRY_BYTES;

/**
 * A table's offsets, every one inside a pack of `packSize` bytes or 0.
 *
 * @param {Uint8Array} bytes @param {number} blockCount @param {number} packSize
 */
const tableOf = (bytes, blockCount, packSize)=>{
    const table = new Float64Array(blockCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let index = 0; index < blockCount; index++)
    {
        const at = view.getFloat64(index * ENTRY_BYTES, true);
        table[index] = Number.isInteger(at) && at >= PACK_HEADER
            && at + RECORD_HEADER <= packSize ? at : 0;
    }
    return table;
};

/**
 * The name a bundle's blocks are kept under: its id and the fingerprint of its
 * index, so a bundle packed again starts a cache of its own.
 *
 * @param {string} id  @param {string} fingerprint
 */
export const blockCacheName = (id, fingerprint)=>`${id}-${fingerprint}`;

/**
 * A bare file name at the store's root: the origin's file system refuses a
 * name with a separator in it, and a bundle's id is not ours to vet.
 *
 * @param {string} name
 */
const fileNameOf = name=>name.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * A cache's table and its pack, read through the origin's file system without
 * opening anything for writing; null where it holds no table of this bundle's
 * size or no pack of this layout. A file that is not there is refused
 * (NotFoundError).
 *
 * @param {any} root @param {string} file @param {number} blockCount
 * @returns {Promise<{ table: Float64Array, pack: Blob } | null>}
 */
async function readCache(root, file, blockCount){
    /** @param {string} name @returns {Promise<Blob | null>} */
    const fileOf = async name=>{
        try
        {
            return await (await root.getFileHandle(name)).getFile();
        }
        catch {
            return null;
        }
    };
    const index = await fileOf(cacheFiles.index(file));
    const pack = await fileOf(cacheFiles.pack(file));
    if (index === null || pack === null || index.size !== tableBytes(blockCount)
        || !isPack(new Uint8Array(await pack.slice(0, PACK_HEADER).arrayBuffer())))
    {
        return null;
    }
    return { table: tableOf(new Uint8Array(await index.arrayBuffer()), blockCount, pack.size),
        pack };
}

/**
 * How much of a bundle this machine already holds, read from the cache's
 * table without opening it for writing: what a page asks before a start, to
 * say whether the game is here whole. The blocks of the translation seed are
 * not counted, being the translator's store's and read once.
 *
 * @param {Object} options
 * @param {any} options.root  The origin's file system (`navigator.storage.getDirectory()`).
 * @param {string} options.id  The bundle's id, as the engine is given it.
 * @param {{ fingerprint: string, blockCount: number,
 *     block: (index: number) => { packed: number, codec: number, length: number },
 *     translations: { firstBlock: number, blocks: number } | null }} options.bundle  Opened.
 * @returns {Promise<{ blocks: number, resident: number, bytes: number, residentBytes: number }>}
 */
export async function bundleResidency({ root, id, bundle }){
    const cache = await readCache(root, fileNameOf(blockCacheName(id, bundle.fingerprint)),
        bundle.blockCount);
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
        if (cache && cache.table[index] !== 0
            && cache.table[index] + RECORD_HEADER + storedLength(bundle.block(index))
                <= cache.pack.size)
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
    const cache = await readCache(root, fileNameOf(blockCacheName(id, bundle.fingerprint)),
        bundle.blockCount);
    if (cache === null)
    {
        return null;
    }
    const seed = bundle.translations;
    // Every block's header checked against the block it is taken for, before
    // its bytes go into the container: a table naming another block's would
    // put that block's bytes under this one's index.
    for (let at = 0; at < bundle.blockCount; at++)
    {
        if (seed && at >= seed.firstBlock && at < seed.firstBlock + seed.blocks)
        {
            continue;
        }
        const offset = cache.table[at];
        const header = offset === 0 ? new Uint8Array(0)
            : new Uint8Array(await cache.pack.slice(offset, offset + RECORD_HEADER).arrayBuffer());
        if (!recordIs(header, at, storedLength(bundle.block(at))))
        {
            return null;
        }
    }
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
            const block = bundle.block(at);
            const packed = storedLength(block);
            const from = cache.table[at] + RECORD_HEADER;
            // A block past the pack's end would come out short, not missing.
            whole &&= cache.table[at] !== 0 && cache.pack.size >= from + packed;
            parts.push(cache.pack.slice(from, from + packed));
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

    const file = fileNameOf(name);
    const indexPath = cacheFiles.index(file);
    const packPath = cacheFiles.pack(file);
    const orderPath = cacheFiles.order(file);

    try
    {
        await store.open(indexPath);
        await store.open(packPath);
        await store.open(orderPath);
    }
    catch (e){
        // A store that will not open is a slower run, not a failed one. The
        // ordinary reason is a build outside a worker, where no synchronous
        // handle on OPFS exists to be had.
        return createMemoryCache(maxHeapBytes, /** @type {Error} */ (e).message);
    }

    // A layout this one replaced: its blocks are not where this table says,
    // and its files are what held the bundle's length on disk, so they go.
    const replaced = cacheFiles.replaced(file, blockCount).filter(path=>store.stat(path) !== null);
    for (const path of replaced)
    {
        store.remove(path);
    }
    if (replaced.length > 0)
    {
        // A file another tab's older build holds open stays; the removal's
        // failure is taken here rather than by the next open.
        await Promise.resolve().then(()=>store.flush?.()).catch(()=>{});
    }

    /** Bytes the pack holds as the store has them now: where the next block goes. */
    const packSize = ()=>store.stat(packPath)?.size ?? 0;
    // A table of the wrong size belongs to a different bundle, or to a version
    // of this one with different blocks; a pack without this layout's mark to
    // another layout. Either way what the table names means something else, so
    // both start again rather than being partly believed.
    const tableStat = store.stat(indexPath);
    const believed = tableStat !== null && tableStat.size === tableBytes(blockCount)
        && isPack(store.read(packPath, 0, PACK_HEADER));
    /** Each block's offset in the pack, or 0. */
    const table = believed
        ? tableOf(store.read(indexPath, 0, tableBytes(blockCount)), blockCount, packSize())
        : new Float64Array(blockCount);
    /**
     * The order the last run first asked for its blocks in: what a filler
     * should bring in before anything else, because a start reads the same
     * things in the same order every time.
     *
     * @type {number[]}
     */
    let previous = [];
    if (believed)
    {
        const stored = store.read(orderPath, 0, ORDER_LIMIT * 4);
        previous = [...new Uint32Array(stored.buffer, stored.byteOffset, stored.length >> 2)]
            .filter(index=>index < blockCount);
    }
    else
    {
        try
        {
            store.truncate(packPath, 0);
            store.write(packPath, 0, packHeader());
            store.truncate(indexPath, tableBytes(blockCount));
            store.truncate(orderPath, 0);
        }
        catch (e){
            // No room even for an empty table: the run holds its blocks in the heap.
            return createMemoryCache(maxHeapBytes, /** @type {Error} */ (e).message);
        }
    }

    /** One table entry, written at its block's place. @param {number} index */
    const writeEntry = index=>{
        const entry = new Uint8Array(ENTRY_BYTES);
        new DataView(entry.buffer).setFloat64(0, table[index], true);
        store.write(indexPath, index * ENTRY_BYTES, entry);
    };

    /** This run's first demands, in order. @type {Set<number>} */
    const demanded = new Set();
    let dirty = false;
    /** Blocks the store refused, held for the run alone and bounded. */
    const refused = createMemoryCache(maxHeapBytes, 'the store refused a write');
    /** Why the store last refused a write, while it does. @type {string | null} */
    let full = null;

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
            const at = table[index];
            if (at === 0)
            {
                return refused.read(index);
            }
            /** @type {Uint8Array | null} */
            let record = null;
            try
            {
                record = store.read(packPath, at, RECORD_HEADER + length);
            }
            catch {
                // The pack gone, or its handle closed by a store of the
                // caller's with a smaller pool: the block is fetched again.
            }
            if (record === null || record.length !== RECORD_HEADER + length
                || !recordIs(record, index, length))
            {
                // Not this block's whole record where the table says: fetched
                // again, never handed to a guest as another block or a short one.
                table[index] = 0;
                try
                {
                    writeEntry(index);
                }
                catch {
                    // The next run checks the record again.
                }
                return null;
            }
            return record.subarray(RECORD_HEADER);
        },

        /**
         * Asynchronous as the store's contract is; a block the store will not
         * take is held in the heap for this run.
         *
         * @param {number} index
         * @param {Uint8Array} bytes
         */
        async put(index, bytes){
            try
            {
                // The end of the pack as the store has it now, read and
                // written with nothing between: another cache of this bundle
                // on the store puts its blocks after this one's.
                const at = Math.max(PACK_HEADER, packSize());
                store.write(packPath, at, recordOf(index, bytes));
                table[index] = at;
                writeEntry(index);
            }
            catch (e){
                // Past the origin's quota, or a disk with no room: the run goes
                // on with this block in the heap, and the next run fetches it.
                full = /** @type {Error} */ (e).message;
                table[index] = 0;
                refused.put(index, bytes);
                return;
            }
        },

        /**
         * Writes the order out. Called when a batch of blocks has been brought
         * in rather than on every one: the table is written as each block is
         * put, the order is a hint.
         */
        async persist(){
            await refused.persist();
            if (!dirty)
            {
                return;
            }
            // This run's order first, then whatever the last run reached that
            // this one has not yet: a run cut short must not shed what a
            // longer one learned.
            const order = new Uint32Array([...demanded,
                ...previous.filter(index=>!demanded.has(index))].slice(0, ORDER_LIMIT));
            try
            {
                store.truncate(orderPath, order.byteLength);
                store.write(orderPath, 0, new Uint8Array(order.buffer));
            }
            catch (e){
                full = /** @type {Error} */ (e).message;
            }
            dirty = false;
        },

        diagnostics(){
            let resident = 0;
            for (let at = 0; at < blockCount; at++)
            {
                resident += table[at] !== 0 ? 1 : 0;
            }
            const inHeap = refused.diagnostics();
            // In the heap the table of which blocks are here and where, and what
            // the store refused; the rest is on disk, the pack as long as what
            // it holds.
            return { backed: true, resident: resident + inHeap.resident, blocks: blockCount,
                heapBytes: table.byteLength + inHeap.heapBytes, diskBytes: packSize()
                    + tableBytes(blockCount), ...full === null ? {} : { full } };
        },
    };
}
