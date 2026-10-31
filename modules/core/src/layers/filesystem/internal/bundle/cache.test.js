/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockCacheName, bundleResidency, createBlockCache, resolveBlockStore, SEGMENT_BLOCKS }
    from './cache.js';

/**
 * The store contract the cache uses, over ordinary buffers. Synchronous, like
 * the OPFS store it stands in for, and it keeps its files between cache
 * instances so a second session can be tested against a first.
 */
function fakeStore(){
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();

    /** @param {string} path @returns {Uint8Array} */
    const bytesOf = path=>files.get(path) ?? new Uint8Array(0);

    /** @param {string} path @param {number} size */
    const grow = (path, size)=>{
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

test('a block is written at its own slot, not after the last one', async()=>{
    // The property the read arithmetic depends on: a slot is a function of the
    // index alone, so blocks may arrive in any order and over any number of
    // sessions without an index to consult.
    const store = fakeStore();
    const cache = await createBlockCache({ store, ...OPTIONS });

    await cache.put(7, new Uint8Array(16).fill(0x11));
    await cache.put(2, new Uint8Array(16).fill(0x22));

    const data = store.files.get('war.blocks.0');
    assert.equal(data?.[2 * 16], 0x22);
    assert.equal(data?.[7 * 16], 0x11);
    assert.deepEqual(cache.read(2, 16), new Uint8Array(16).fill(0x22));
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

test('a cache an appended layout laid out again is discarded, its table with it', async()=>{
    // A run of a build that appended blocks rewrote the data file in arrival
    // order and left the bitmap beside it: believed, it hands a game another
    // block's bytes.
    const store = fakeStore();
    const first = await createBlockCache({ store, ...OPTIONS });
    await first.put(5, new Uint8Array(16).fill(0xab));
    await first.persist();
    store.files.set('war.slots', new Uint8Array(OPTIONS.blockCount * 4));

    const second = await createBlockCache({ store, ...OPTIONS });
    assert.equal(second.has(5), false);
    assert.equal(store.files.has('war.slots'), false,
        'the table goes, so the next run believes its own');
    await second.put(5, new Uint8Array(16).fill(0xcd));
    await second.persist();
    const third = await createBlockCache({ store, ...OPTIONS });
    assert.deepEqual(third.read(5, 16), new Uint8Array(16).fill(0xcd));
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
    assert.equal(cache.diagnostics().heapBytes, 125, 'a bit a block');
});

test('the cache is backed by the store it was given, under a name the store allows', async()=>{
    const store = fakeStore();
    const cache = await createBlockCache({ store, ...OPTIONS, name: 'a/game:with\\odd chars' });

    assert.equal(cache.backed, true);
    assert.deepEqual([...store.files.keys()].sort(),
        ['a_game_with_odd_chars.held', 'a_game_with_odd_chars.order'],
        'no segment before a block of it is written');
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

test('what of a bundle is here is read off its bitmap and segments, the seed aside', async()=>{
    // Three segments' worth of blocks of 100 bytes, the last two the
    // translation seed; the bitmap says blocks 0, 1, 2, the first of the
    // second segment, and the last are here.
    const blockCount = 2 * SEGMENT_BLOCKS + 10;
    const bundle = {
        fingerprint: 'abc',
        blockCount,
        block: ()=>({ packed: 100 }),
        translations: { firstBlock: blockCount - 2, blocks: 2 },
    };
    const name = blockCacheName('game', 'abc');
    const bitmap = new Uint8Array(Math.ceil(blockCount / 8));
    for (const index of [0, 1, 2, SEGMENT_BLOCKS, blockCount - 1])
    {
        bitmap[index >> 3] |= 1 << (index & 7);
    }
    /** @param {Record<string, Uint8Array>} files */
    const residency = files=>bundleResidency({ root: rootOver(new Map(Object.entries(files))),
        id: 'game', bundle });
    const segment = new Uint8Array(1);
    /** @type {Record<string, Uint8Array>} */
    const whole = { [`${name}.held`]: bitmap, [`${name}.blocks.0`]: segment,
        [`${name}.blocks.1`]: segment, [`${name}.blocks.2`]: segment };
    assert.deepEqual(await residency(whole),
        { blocks: blockCount - 2, resident: 4, bytes: (blockCount - 2) * 100, residentBytes: 400 });
    assert.equal((await residency({})).resident, 0, 'no cache yet');
    const short = { ...whole };
    delete short[`${name}.blocks.1`];
    assert.equal((await residency(short)).resident, 3, 'a segment gone takes its blocks');
    assert.equal((await residency({ ...whole, [`${name}.held`]: Uint8Array.of(0xff) })).resident,
        0, 'a bitmap of another size is another bundle\'s');
    const older = { ...whole, [`${name}.present`]: bitmap };
    delete older[`${name}.held`];
    assert.equal((await residency(older)).resident, 0, 'the one-file layout\'s bitmap is not ours');
});

test('a block near the end costs one segment, not the bundle\'s length', async()=>{
    // A bundle that keeps its program in its last blocks reads those first: one
    // file with block N at N * blockSize was the whole bundle long on the first
    // read, and the origin's quota refused it.
    const store = fakeStore();
    const options = { ...OPTIONS, blockCount: 5 * SEGMENT_BLOCKS };
    const cache = await createBlockCache({ store, ...options });
    const last = options.blockCount - 1;
    await cache.put(last, new Uint8Array(16).fill(0x77));
    await cache.persist();

    const segments = [...store.files.keys()].filter(path=>path.includes('.blocks'));
    assert.deepEqual(segments, ['war.blocks.4'], 'only the segment the block is in');
    assert.ok((store.files.get('war.blocks.4')?.length ?? 0) <= SEGMENT_BLOCKS * 16);

    const second = await createBlockCache({ store, ...options });
    assert.deepEqual(second.read(last, 16), new Uint8Array(16).fill(0x77));
    assert.equal(second.has(0), false);
});

test('two caches writing the same bundle at once never hand back another block\'s bytes',
    async()=>{
        // The appended layout broke this way: each writer kept its own next
        // slot, and one's table named bytes the other had put elsewhere. A slot
        // from the index alone is the same for both, so the same bytes land
        // there whoever writes them.
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

test('a block its segment does not hold is fetched again, not handed out short', async()=>{
    const store = fakeStore();
    const options = { ...OPTIONS, blockCount: 2 * SEGMENT_BLOCKS };
    const first = await createBlockCache({ store, ...options });
    await first.put(3, new Uint8Array(16).fill(1));
    await first.put(SEGMENT_BLOCKS + 3, new Uint8Array(16).fill(2));
    await first.persist();

    store.files.delete('war.blocks.1');
    store.files.set('war.blocks.0', new Uint8Array(3 * 16 + 4));
    const second = await createBlockCache({ store, ...options });
    assert.equal(second.has(SEGMENT_BLOCKS + 3), false, 'a segment gone takes its blocks');
    assert.equal(second.has(3), true);
    assert.equal(second.read(3, 16), null);
    assert.equal(second.has(3), false, 'and is asked for again rather than read short');
});

test('a block the store refuses is held in the heap, and the cache says it is full', async()=>{
    const store = fakeStore();
    /** @param {string} path @param {number} at @param {Uint8Array} bytes */
    const write = (path, at, bytes)=>{
        if (path.includes('.blocks.'))
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
