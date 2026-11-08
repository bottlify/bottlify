/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockCacheName, bundleResidency, cacheFiles, createBlockCache, resolveBlockStore }
    from './cache.js';

/** Blocks a segment file held in the layout before: what its tests lay out to see it dropped. */
const SEGMENT_BLOCKS = 1024;

/**
 * The store contract the cache uses, over ordinary buffers. Synchronous, like
 * the OPFS store it stands in for, and it keeps its files between cache
 * instances so a second session can be tested against a first.
 */
function fakeStore({ now = /** @type {(() => number) | null} */ (null) } = {}){
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** When each file was last written, by `now` or in writes: the OPFS store's `modified`. */
    /** @type {Map<string, number>} */
    const modified = new Map();
    let clock = 0;

    /** @param {string} path @returns {Uint8Array} */
    const bytesOf = path=>files.get(path) ?? new Uint8Array(0);

    /** @param {string} path @param {number} size */
    const grow = (path, size)=>{
        modified.set(path, now ? now() : ++clock);
        const held = files.get(path) ?? new Uint8Array(0);
        if (held.length >= size)
        {
            return held;
        }
        const grown = new Uint8Array(size);
        grown.set(held);
        files.set(path, grown);
        return grown;
    };

    return {
        files,
        list: ()=>[...files.keys()].map(path=>({ path, directory: false,
            size: bytesOf(path).length, modified: modified.get(path) ?? 0 })),
        /** @param {string} path */
        async open(path){
            // The origin's file system refuses a name with a separator in it,
            // and so does this stand-in: a cache that named its files as paths
            // fell back to the heap on every start and nobody noticed.
            if (/[\\/]/.test(path))
            {
                throw new TypeError(`Name is not allowed: ${path}`);
            }
            if (!files.has(path))
            {
                files.set(path, new Uint8Array(0));
            }
        },
        /** @param {string} path */
        stat: path=>files.has(path) ? { size: bytesOf(path).length } : null,
        /** @param {string} path @param {number} at @param {number} length */
        read: (path, at, length)=>bytesOf(path).slice(at, at + length),
        /** @param {string} path @param {number} at @param {Uint8Array} bytes */
        write(path, at, bytes){
            grow(path, at + bytes.length).set(bytes, at);
        },
        /** @param {string} path @param {number} size */
        truncate(path, size){
            modified.set(path, now ? now() : ++clock);
            files.set(path, new Uint8Array(size));
        },
        /** @param {string} path */
        remove(path){
            files.delete(path);
        },
    };
}

const OPTIONS = { name: 'war', blockSize: 16, blockCount: 20 };

test('a block goes to storage and comes back, and nothing is held in the heap', async()=>{
    const store = fakeStore();
    const cache = await createBlockCache({ store, ...OPTIONS });

    assert.equal(cache.has(3), false);
    assert.equal(cache.read(3, 16), null, 'an absent block reads as absent, not as zeroes');

    const bytes = new Uint8Array(16).fill(0x5a);
    await cache.put(3, bytes);

    assert.equal(cache.has(3), true);
    assert.deepEqual(cache.read(3, 16), bytes);
    assert.equal(cache.diagnostics().resident, 1);
});

test('blocks go into a segment one after another, each with its header, in the order they came',
    async()=>{
        // The table names where each one went: a block put late in the bundle
        // costs its own length in the pack and no more.
        const store = fakeStore();
        const cache = await createBlockCache({ store, ...OPTIONS });

        await cache.put(7, new Uint8Array(16).fill(0x11));
        await cache.put(2, new Uint8Array(16).fill(0x22));

        const pack = store.files.get('war.pack.0');
        assert.equal(pack?.length, 16 + 2 * (16 + 16), 'the pack\'s header and two records');
        assert.equal(pack?.[16 + 16], 0x11, 'block 7 first, after its header');
        assert.equal(pack?.[16 + 32 + 16], 0x22, 'block 2 after it');
        const table = new DataView((store.files.get('war.index') ?? new Uint8Array(0)).buffer);
        assert.deepEqual([table.getFloat64(7 * 8, true), table.getFloat64(2 * 8, true),
            table.getFloat64(3 * 8, true)], [16, 48, 0], 'each block\'s offset at its place');
        assert.deepEqual(cache.read(2, 16), new Uint8Array(16).fill(0x22));
    });

test('a cache on storage takes on disk what it holds, whatever blocks of the bundle it holds',
    async()=>{
        // The gate: 1 437 blocks read across a bundle of 68 616 (what one game
        // read of its bottle), on disk as the blocks they are, a header each and
        // a table of eight bytes a block -- the segments took the bundle's whole
        // length.
        const store = fakeStore();
        const blockSize = 4096;
        const options = { name: 'wide', blockSize, blockCount: 68_616 };
        const cache = await createBlockCache({ store, ...options });
        let seed = 7;
        /** @type {Set<number>} */
        const put = new Set();
        while (put.size < 1437)
        {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            const index = seed % options.blockCount;
            if (!put.has(index))
            {
                put.add(index);
                await cache.put(index, new Uint8Array(blockSize).fill(index & 0xff));
                cache.demanded(index);
            }
        }
        await cache.persist();
        const onDisk = [...store.files.values()].reduce((sum, bytes)=>sum + bytes.length, 0);
        const blocks = put.size * blockSize;
        const table = options.blockCount * 8;
        const order = put.size * 4;
        assert.equal(onDisk, 16 + put.size * (16 + blockSize) + table + order,
            'the pack\'s header, a header and the bytes of each block, the table and the order');
        assert.ok(onDisk < blocks * 1.2, `${onDisk} bytes on disk for ${blocks} of blocks`);
        assert.equal(cache.diagnostics().diskBytes, (store.files.get('wide.pack.0')?.length ?? 0)
            + table, 'the cache says what its blocks take');
        const again = await createBlockCache({ store, ...options });
        for (const index of put)
        {
            assert.deepEqual(again.read(index, blockSize),
                new Uint8Array(blockSize).fill(index & 0xff), `block ${index}`);
        }
        assert.equal(again.diagnostics().resident, put.size);
    });

test('a shorter block occupies only what it uses', async()=>{
    // A zstd block is stored packed, so its slot is mostly unused -- and the
    // read has to ask for the stored length rather than the slot's size.
    const store = fakeStore();
    const cache = await createBlockCache({ store, ...OPTIONS });

    await cache.put(1, new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(cache.read(1, 4), new Uint8Array([1, 2, 3, 4]));
});

test('a second session already has what the first fetched', async()=>{
    const store = fakeStore();
    const first = await createBlockCache({ store, ...OPTIONS });
    await first.put(5, new Uint8Array(16).fill(0xab));
    await first.persist();

    const second = await createBlockCache({ store, ...OPTIONS });
    assert.equal(second.has(5), true, 'the record of it survived');
    assert.deepEqual(second.read(5, 16), new Uint8Array(16).fill(0xab));
    assert.equal(second.has(4), false);
});

test('a cache belonging to a different bundle is discarded, not believed', async()=>{
    // Slots are index arithmetic, so trusting another bundle's bitmap would
    // hand a game bytes from a different one with no error anywhere.
    const store = fakeStore();
    const first = await createBlockCache({ store, ...OPTIONS });
    await first.put(5, new Uint8Array(16).fill(0xab));
    await first.persist();

    const other = await createBlockCache({ store, ...OPTIONS, blockCount: 500 });
    assert.equal(other.has(5), false);
    assert.equal(other.diagnostics().resident, 0);
});

test('the first appended layout\'s table goes, and the pack keeps its own blocks', async()=>{
    // A build of that layout put its table at `.slots` beside its data: the
    // table goes, so no build believes it; this layout's pack checks its own.
    const store = fakeStore();
    const first = await createBlockCache({ store, ...OPTIONS });
    await first.put(5, new Uint8Array(16).fill(0xab));
    await first.persist();
    store.files.set('war.slots', new Uint8Array(OPTIONS.blockCount * 4));

    const second = await createBlockCache({ store, ...OPTIONS });
    assert.equal(store.files.has('war.slots'), false, 'the old table goes');
    assert.deepEqual(second.read(5, 16), new Uint8Array(16).fill(0xab));
});

test('asking for local storage where there is none is not an error', async()=>{
    // Node has no navigator.storage, which is the same position a build on the
    // main thread is in. The run has to reach a running engine either way.
    assert.equal(await resolveBlockStore('local'), null);
    assert.equal(await resolveBlockStore(null), null);

    const mine = fakeStore();
    assert.equal(await resolveBlockStore(mine), mine, 'a store of your own is used as given');
});

test('without storage the blocks are held in the heap, and bounded', async()=>{
    // A build outside a worker cannot take a synchronous OPFS handle at all. It
    // still runs, keeping blocks in memory and paying the network again for
    // whatever it has had to let go.
    const cache = await createBlockCache({ store: null, ...OPTIONS, maxHeapBytes: 32 });

    await cache.put(1, new Uint8Array(16).fill(0xaa));
    assert.equal(cache.backed, false);
    assert.equal(cache.has(1), true, 'a read that needed this block can now be served');
    assert.deepEqual(cache.read(1), new Uint8Array(16).fill(0xaa));

    // Two blocks fit; the third pushes the bound. Nothing is dropped while the
    // read that asked for them is still being served.
    await cache.put(2, new Uint8Array(16));
    await cache.put(3, new Uint8Array(16));
    assert.equal(cache.diagnostics().resident, 3, 'a read may need more than fits');

    await cache.persist();
    await cache.put(4, new Uint8Array(16));
    assert.equal(cache.has(1), false, 'and once it is served, the oldest goes');
    assert.equal(cache.has(4), true);
});

test('without storage the heap holds no more than its ceiling between reads, and says so',
    async()=>{
        // The heaps' pool (`HEAP_POOLS.blockCache`) at a size a test can fill: a
        // run of reads, each of a few blocks, never leaves more than the bound.
        const ceiling = 5 * 16;
        const cache = await createBlockCache({ store: null, ...OPTIONS, maxHeapBytes: ceiling });
        let seed = 7;
        for (let read = 0; read < 200; read++)
        {
            const wanted = 1 + (read % 3);
            for (let block = 0; block < wanted; block++)
            {
                seed = (seed * 1103515245 + 12345) >>> 0;
                await cache.put(seed % OPTIONS.blockCount, new Uint8Array(16));
            }
            await cache.persist();
            await cache.put(read % OPTIONS.blockCount, new Uint8Array(16));
            await cache.persist();
            const { bytes, heapBytes } = cache.diagnostics();
            assert.ok(bytes <= ceiling, `read ${read}: ${bytes} bytes held past ${ceiling}`);
            assert.equal(heapBytes, bytes, 'what it holds is the heap\'s');
        }
    });

test('a cache on storage holds only its record of blocks in the heap', async()=>{
    const cache = await createBlockCache({ store: fakeStore(), ...OPTIONS, blockCount: 1000 });
    await cache.put(3, new Uint8Array(16));
    assert.equal(cache.diagnostics().heapBytes, 8000, 'an offset a block');
});

test('the cache is backed by the store it was given, under a name the store allows', async()=>{
    const store = fakeStore();
    const cache = await createBlockCache({ store, ...OPTIONS, name: 'a/game:with\\odd chars' });

    assert.equal(cache.backed, true);
    assert.deepEqual([...store.files.keys()].sort(),
        ['a_game_with_odd_chars.index', 'a_game_with_odd_chars.order'],
        'no segment before a block is put');
    await cache.put(1, new Uint8Array(16));
    assert.equal(store.files.get('a_game_with_odd_chars.pack.0')?.length, 16 + 16 + 16,
        'the first segment: its header and the record');
});

test('a store that will not open says why, rather than only falling back', async()=>{
    const refusing = { ...fakeStore(), open: async()=>{
        throw new Error('no synchronous access here');
    } };
    const cache = await createBlockCache({ store: refusing, ...OPTIONS });

    assert.equal(cache.backed, false);
    assert.equal(cache.reason, 'no synchronous access here');
    assert.deepEqual(cache.order(), [], 'nothing durable, nothing remembered');
    cache.demanded(3);
});

test('the order a run first asked for its blocks in is there for the next run', async()=>{
    const store = fakeStore();
    const first = await createBlockCache({ store, ...OPTIONS });
    assert.deepEqual(first.order(), [], 'a bundle never run before has no order');

    for (const index of [7, 2, 7, 9, 2])
    {
        first.demanded(index);
    }
    await first.persist();

    const second = await createBlockCache({ store, ...OPTIONS });
    assert.deepEqual(second.order(), [7, 2, 9], 'first demands only, in their order');

    // A run cut short keeps what the longer one before it learned, after its own.
    second.demanded(9);
    second.demanded(4);
    await second.persist();
    const third = await createBlockCache({ store, ...OPTIONS });
    assert.deepEqual(third.order(), [9, 4, 7, 2]);
});

test('the order belongs to the bundle, and is discarded with its bitmap', async()=>{
    const store = fakeStore();
    const first = await createBlockCache({ store, ...OPTIONS });
    first.demanded(5);
    await first.persist();

    const other = await createBlockCache({ store, ...OPTIONS, blockCount: 500 });
    assert.deepEqual(other.order(), []);
});

test('the order is bounded', async()=>{
    const store = fakeStore();
    const cache = await createBlockCache({ store, ...OPTIONS, blockCount: 10000 });
    for (let index = 0; index < 6000; index++)
    {
        cache.demanded(index);
    }
    await cache.persist();

    const again = await createBlockCache({ store, ...OPTIONS, blockCount: 10000 });
    assert.equal(again.order().length, 4096);
    assert.equal(again.order()[0], 0, 'the earliest demands are the ones kept');
});

/**
 * The origin's file system as residency and the cached bundle read it: a
 * store's files, each a Blob, and a file that is not there refused as the
 * real one refuses it.
 *
 * @param {Map<string, Uint8Array>} files
 */
const rootOver = files=>({
    /** @param {string} name */
    getFileHandle: async name=>{
        const bytes = files.get(name);
        if (bytes === undefined)
        {
            throw new DOMException(`no ${name}`, 'NotFoundError');
        }
        return { getFile: async()=>new Blob([bytes.slice()]) };
    },
});

test('what of a bundle is here is read off its table and pack, the seed aside', async()=>{
    // Blocks of 100 bytes, the last two the translation seed; blocks 0, 1, 2,
    // 1500 and the last are put.
    const blockCount = 2 * SEGMENT_BLOCKS + 10;
    const bundle = {
        fingerprint: 'abc',
        blockSize: 128,
        blockCount,
        block: ()=>({ packed: 100, codec: 2, length: 100 }),
        translations: { firstBlock: blockCount - 2, blocks: 2 },
    };
    const name = blockCacheName('game', 'abc');
    const store = fakeStore();
    const cache = await createBlockCache({ store, name, blockSize: 128, blockCount });
    for (const index of [0, 1, 2, 1500, blockCount - 1])
    {
        await cache.put(index, new Uint8Array(100).fill(index & 0xff));
    }
    await cache.persist();
    /** @param {Map<string, Uint8Array>} files */
    const residency = files=>bundleResidency({ root: rootOver(files), id: 'game', bundle });
    assert.deepEqual(await residency(store.files),
        { blocks: blockCount - 2, resident: 4, bytes: (blockCount - 2) * 100, residentBytes: 400 });
    assert.equal((await residency(new Map())).resident, 0, 'no cache yet');
    const cut = new Map(store.files);
    cut.set(`${name}.pack.0`, (store.files.get(`${name}.pack.0`) ?? new Uint8Array(0))
        .slice(0, 16 + 3 * 116));
    assert.equal((await residency(cut)).resident, 3, 'a block past the pack\'s end is not here');
    assert.equal((await residency(new Map([...store.files, [`${name}.index`, Uint8Array.of(1)]])))
        .resident, 0, 'a table of another size is another bundle\'s');
    const older = new Map(store.files);
    older.delete(`${name}.index`);
    older.set(`${name}.held`, new Uint8Array(Math.ceil(blockCount / 8)).fill(0xff));
    assert.equal((await residency(older)).resident, 0, 'the segments\' bitmap is not ours');
});

test('two caches writing the same bundle at once never hand back another block\'s bytes',
    async()=>{
        // The first appended layout broke this way: each writer kept its own
        // next slot, and one's table named bytes the other had put elsewhere.
        // A block goes where the store's pack ends at the write, and a read
        // checks the record's header, so neither hands out the other's.
        const store = fakeStore();
        const options = { ...OPTIONS, blockCount: 3 * SEGMENT_BLOCKS };
        /** @param {number} index */
        const bytesOf = index=>new Uint8Array(16).map((unused, at)=>(index * 31 + at) & 0xff);
        const one = await createBlockCache({ store, ...options });
        const two = await createBlockCache({ store, ...options });
        let seed = 11;
        /** @type {Set<number>} */
        const written = new Set();
        for (let n = 0; n < 400; n++)
        {
            seed = (seed * 1103515245 + 12345) >>> 0;
            const index = seed % options.blockCount;
            written.add(index);
            await (n % 2 === 0 ? one : two).put(index, bytesOf(index));
            if (n % 37 === 0)
            {
                await (n % 2 === 0 ? two : one).persist();
            }
        }
        await one.persist();
        await two.persist();
        const third = await createBlockCache({ store, ...options });
        assert.ok(third.diagnostics().resident > 0);
        for (const cache of [one, two, third])
        {
            for (let index = 0; index < options.blockCount; index++)
            {
                const read = cache.read(index, 16);
                if (read !== null)
                {
                    assert.ok(written.has(index), `block ${index} was never written`);
                    assert.deepEqual(read, bytesOf(index), `block ${index}`);
                }
            }
        }
    });

test('a cache of the one-file layout is dropped and fetched again', async()=>{
    // `<name>.blocks` whole, with its `.present` bitmap: what it holds is laid
    // out at offsets no segment uses, and its file is what ran over the quota.
    const store = fakeStore();
    store.files.set('war.blocks', new Uint8Array(20 * 16).fill(0xee));
    store.files.set('war.present', new Uint8Array(3).fill(0xff));
    store.files.set('war.order', new Uint8Array(new Uint32Array([4, 5]).buffer));
    const cache = await createBlockCache({ store, ...OPTIONS });
    assert.equal(cache.has(4), false);
    assert.deepEqual(cache.order(), []);
    assert.equal(store.files.has('war.blocks'), false);
    assert.equal(store.files.has('war.present'), false);
    await cache.put(4, new Uint8Array(16).fill(0x44));
    await cache.persist();
    const again = await createBlockCache({ store, ...OPTIONS });
    assert.deepEqual(again.read(4, 16), new Uint8Array(16).fill(0x44));
});

test('a cache of the segment layout is dropped, every segment and its bitmap', async()=>{
    const store = fakeStore();
    const options = { ...OPTIONS, blockCount: 3 * SEGMENT_BLOCKS };
    store.files.set('war.held', new Uint8Array(3 * SEGMENT_BLOCKS / 8).fill(0xff));
    store.files.set('war.blocks.0', new Uint8Array(64).fill(0xee));
    store.files.set('war.blocks.2', new Uint8Array(64).fill(0xee));
    const cache = await createBlockCache({ store, ...options });
    assert.equal(cache.has(1), false);
    assert.deepEqual([...store.files.keys()].sort(), ['war.index', 'war.order']);
    assert.deepEqual(cacheFiles.replaced('war', options.blockCount).slice(-3),
        ['war.blocks.0', 'war.blocks.1', 'war.blocks.2']);
});

test('a block whose record the table does not name is fetched again, not handed out', async()=>{
    // A pack cut short, a table naming another block's record, a pack of
    // another layout: each is a block fetched again, never another's bytes.
    const store = fakeStore();
    const first = await createBlockCache({ store, ...OPTIONS });
    await first.put(3, new Uint8Array(16).fill(1));
    await first.put(4, new Uint8Array(16).fill(2));
    await first.put(5, new Uint8Array(16).fill(3));
    await first.persist();

    const table = store.files.get('war.index') ?? new Uint8Array(0);
    const view = new DataView(table.buffer);
    view.setFloat64(4 * 8, view.getFloat64(3 * 8, true), true);
    store.files.set('war.pack.0', (store.files.get('war.pack.0') ?? new Uint8Array(0))
        .slice(0, 16 + 2 * 32 + 20));
    const second = await createBlockCache({ store, ...OPTIONS });
    assert.deepEqual(second.read(3, 16), new Uint8Array(16).fill(1));
    assert.equal(second.read(4, 16), null, 'block 3\'s record is not block 4');
    assert.equal(second.has(4), false, 'and is asked for again');
    assert.equal(second.read(5, 16), null, 'a record cut short by the pack\'s end is not read');
    assert.equal(second.has(5), false);
    const third = await createBlockCache({ store, ...OPTIONS });
    assert.equal(third.has(4), false, 'what the read found wrong is not believed next time');

    store.files.set('war.pack.0', new Uint8Array(64).fill(0x11));
    const fourth = await createBlockCache({ store, ...OPTIONS });
    assert.equal(fourth.has(3), false, 'a pack without its mark starts again');
});

test('a block the store refuses is held in the heap, and the cache says it is full', async()=>{
    const store = fakeStore();
    /** @param {string} path @param {number} at @param {Uint8Array} bytes */
    const write = (path, at, bytes)=>{
        if (/\.pack\.\d+$/.test(path) && at > 0)
        {
            throw new DOMException('quota', 'QuotaExceededError');
        }
        store.write(path, at, bytes);
    };
    const cache = await createBlockCache({ store: { ...store, write }, ...OPTIONS });
    await cache.put(6, new Uint8Array(16).fill(6));
    assert.equal(cache.has(6), true, 'the read that wanted it can go on');
    assert.deepEqual(cache.read(6, 16), new Uint8Array(16).fill(6));
    assert.equal(cache.diagnostics().full, 'quota');
    await cache.persist();
    const again = await createBlockCache({ store, ...OPTIONS });
    assert.equal(again.has(6), false, 'nothing recorded that is not on disk');
});

/**
 * A store with room for `limit` bytes in all, refusing a write past it as the
 * origin's file system does.
 *
 * @param {ReturnType<typeof fakeStore>} store @param {number} limit
 */
const roomFor = (store, limit)=>({ ...store,
    /** @param {string} path @param {number} at @param {Uint8Array} bytes */
    write(path, at, bytes){
        const held = store.files.get(path)?.length ?? 0;
        const total = [...store.files.values()].reduce((sum, one)=>sum + one.length, 0);
        if (total - held + Math.max(held, at + bytes.length) > limit)
        {
            throw new DOMException('quota', 'QuotaExceededError');
        }
        store.write(path, at, bytes);
    } });

/** Three records of 16-byte blocks to a segment, after its header. */
const SPAN = 16 + 3 * 32;

test('a store out of room lets the segment written longest ago go, another bundle\'s', async()=>{
    const store = fakeStore();
    const old = await createBlockCache({ store, ...OPTIONS, name: 'old', segmentBytes: SPAN });
    for (let index = 0; index < 6; index++)
    {
        await old.put(index, new Uint8Array(16).fill(index));
    }
    assert.deepEqual([...store.files.keys()].filter(path=>path.includes('.pack')),
        ['old.pack.0', 'old.pack.1']);
    // Room for both tables and three segments: the fourth asks for more.
    const limit = 2 * OPTIONS.blockCount * 8 + 3 * SPAN;
    const war = await createBlockCache({ store: roomFor(store, limit), ...OPTIONS,
        segmentBytes: SPAN });
    for (let index = 0; index < 4; index++)
    {
        await war.put(index, new Uint8Array(16).fill(0x40 + index));
    }
    assert.equal(store.files.has('old.pack.0'), false, 'the oldest segment went');
    assert.equal(store.files.has('old.pack.1'), true, 'and only it');
    assert.deepEqual(war.read(3, 16), new Uint8Array(16).fill(0x43), 'the block is on disk');
    assert.equal(store.files.get('war.pack.1')?.length, 16 + 32);
    assert.deepEqual(war.diagnostics().letGo, { segments: 1, bytes: SPAN });
    assert.equal(war.diagnostics().full, 'quota', 'the refusal is said');

    const again = await createBlockCache({ store, ...OPTIONS, name: 'old', segmentBytes: SPAN });
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(index=>again.has(index)),
        [false, false, false, true, true, true], 'what went is fetched again, the rest is here');
    assert.deepEqual(again.read(4, 16), new Uint8Array(16).fill(4));
});

test('a bundle larger than the room keeps its newest blocks, on disk', async()=>{
    const store = fakeStore();
    const cache = await createBlockCache({ store: roomFor(store, OPTIONS.blockCount * 8 + 2 * SPAN),
        ...OPTIONS, segmentBytes: SPAN });
    for (let index = 0; index < 9; index++)
    {
        await cache.put(index, new Uint8Array(16).fill(index));
    }
    const here = Array.from({ length: 9 }, (_, index)=>cache.has(index));
    assert.deepEqual(here, [false, false, false, true, true, true, true, true, true]);
    assert.equal(cache.diagnostics().heapBytes, OPTIONS.blockCount * 8, 'nothing in the heap');
    const again = await createBlockCache({ store, ...OPTIONS, segmentBytes: SPAN });
    assert.deepEqual(Array.from({ length: 9 }, (_, index)=>again.has(index)), here);
    assert.deepEqual(again.read(8, 16), new Uint8Array(16).fill(8));
});

test('a refusal that is not for room lets nothing go', async()=>{
    const store = fakeStore();
    const old = await createBlockCache({ store, ...OPTIONS, name: 'old', segmentBytes: SPAN });
    await old.put(0, new Uint8Array(16));
    const broken = { ...store,
        /** @param {string} path @param {number} at @param {Uint8Array} bytes */
        write(path, at, bytes){
            if (path.startsWith('war.pack'))
            {
                throw new TypeError('handle closed');
            }
            store.write(path, at, bytes);
        } };
    const war = await createBlockCache({ store: broken, ...OPTIONS, segmentBytes: SPAN });
    await war.put(1, new Uint8Array(16).fill(1));
    assert.equal(store.files.has('old.pack.0'), true);
    assert.deepEqual(war.read(1, 16), new Uint8Array(16).fill(1), 'held in the heap');
});

test('a bottle\'s own blocks of the last two hours stay, and a full store says so once',
    async()=>{
        const store = fakeStore({ now: ()=>Date.now() });
        /** @type {string[]} */
        const told = [];
        const cache = await createBlockCache({
            store: roomFor(store, OPTIONS.blockCount * 8 + 2 * SPAN), ...OPTIONS,
            segmentBytes: SPAN, onFull: reason=>told.push(reason) });
        for (let index = 0; index < 9; index++)
        {
            await cache.put(index, new Uint8Array(16).fill(index));
        }
        assert.equal(store.files.has('war.pack.0'), true, 'its first segment is two hours young');
        assert.deepEqual(told, ['quota'], 'no room, said once');
        assert.deepEqual(cache.read(0, 16), new Uint8Array(16).fill(0));
        assert.deepEqual(cache.read(8, 16), new Uint8Array(16).fill(8), 'the rest in the heap');
        assert.deepEqual(cache.diagnostics().letGo, { segments: 0, bytes: 0 });
    });

test('a bottle lets its own old blocks go before another bottle\'s older ones', async()=>{
    let time = 1000;
    const store = fakeStore({ now: ()=>time });
    const old = await createBlockCache({ store, ...OPTIONS, name: 'old', segmentBytes: SPAN });
    for (let index = 0; index < 3; index++)
    {
        await old.put(index, new Uint8Array(16));
    }
    time = 2000;
    const limit = 2 * OPTIONS.blockCount * 8 + 3 * SPAN;
    const war = await createBlockCache({ store: roomFor(store, limit), ...OPTIONS,
        segmentBytes: SPAN });
    for (let index = 0; index < 7; index++)
    {
        await war.put(index, new Uint8Array(16).fill(index));
    }
    assert.equal(store.files.has('old.pack.0'), true, 'the other bottle\'s is older, and stays');
    assert.equal(store.files.has('war.pack.0'), false, 'its own old segment went');
    assert.deepEqual(war.read(6, 16), new Uint8Array(16).fill(6));
});

test('other bottles\' blocks stay when the person said so, and the store says it is full',
    async()=>{
        const store = fakeStore();
        const old = await createBlockCache({ store, ...OPTIONS, name: 'old', segmentBytes: SPAN });
        for (let index = 0; index < 3; index++)
        {
            await old.put(index, new Uint8Array(16));
        }
        /** @type {string[]} */
        const told = [];
        const war = await createBlockCache({ store: roomFor(store, 2 * OPTIONS.blockCount * 8
            + 2 * SPAN), ...OPTIONS, segmentBytes: SPAN, evictOthers: false,
        onFull: reason=>told.push(reason) });
        for (let index = 0; index < 4; index++)
        {
            await war.put(index, new Uint8Array(16).fill(index));
        }
        assert.equal(store.files.has('old.pack.0'), true);
        assert.deepEqual(told, ['quota']);
        assert.deepEqual(war.read(3, 16), new Uint8Array(16).fill(3), 'held in the heap');
    });
