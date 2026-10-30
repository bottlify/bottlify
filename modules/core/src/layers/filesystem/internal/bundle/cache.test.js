/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockCacheName, bundleResidency, createBlockCache, resolveBlockStore } from './cache.js';

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
    cache.put(3, bytes);

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

    cache.put(7, new Uint8Array(16).fill(0x11));
    cache.put(2, new Uint8Array(16).fill(0x22));

    const data = store.files.get('war.blocks');
    assert.equal(data?.[2 * 16], 0x22);
    assert.equal(data?.[7 * 16], 0x11);
    assert.deepEqual(cache.read(2, 16), new Uint8Array(16).fill(0x22));
});

test('a shorter block occupies only what it uses', async()=>{
    // A zstd block is stored packed, so its slot is mostly unused -- and the
    // read has to ask for the stored length rather than the slot's size.
    const store = fakeStore();
    const cache = await createBlockCache({ store, ...OPTIONS });

    cache.put(1, new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(cache.read(1, 4), new Uint8Array([1, 2, 3, 4]));
});

test('a second session already has what the first fetched', async()=>{
    const store = fakeStore();
    const first = await createBlockCache({ store, ...OPTIONS });
    first.put(5, new Uint8Array(16).fill(0xab));
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
    first.put(5, new Uint8Array(16).fill(0xab));
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
    first.put(5, new Uint8Array(16).fill(0xab));
    await first.persist();
    store.files.set('war.slots', new Uint8Array(OPTIONS.blockCount * 4));

    const second = await createBlockCache({ store, ...OPTIONS });
    assert.equal(second.has(5), false);
    assert.equal(store.files.has('war.slots'), false,
        'the table goes, so the next run believes its own');
    assert.equal(store.files.get('war.blocks')?.length, 0);
    second.put(5, new Uint8Array(16).fill(0xcd));
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

    cache.put(1, new Uint8Array(16).fill(0xaa));
    assert.equal(cache.backed, false);
    assert.equal(cache.has(1), true, 'a read that needed this block can now be served');
    assert.deepEqual(cache.read(1), new Uint8Array(16).fill(0xaa));

    // Two blocks fit; the third pushes the bound. Nothing is dropped while the
    // read that asked for them is still being served.
    cache.put(2, new Uint8Array(16));
    cache.put(3, new Uint8Array(16));
    assert.equal(cache.diagnostics().resident, 3, 'a read may need more than fits');

    await cache.persist();
    cache.put(4, new Uint8Array(16));
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
                cache.put(seed % OPTIONS.blockCount, new Uint8Array(16));
            }
            await cache.persist();
            cache.put(read % OPTIONS.blockCount, new Uint8Array(16));
            await cache.persist();
            const { bytes, heapBytes } = cache.diagnostics();
            assert.ok(bytes <= ceiling, `read ${read}: ${bytes} bytes held past ${ceiling}`);
            assert.equal(heapBytes, bytes, 'what it holds is the heap\'s');
        }
    });

test('a cache on storage holds only its record of blocks in the heap', async()=>{
    const cache = await createBlockCache({ store: fakeStore(), ...OPTIONS, blockCount: 1000 });
    cache.put(3, new Uint8Array(16));
    assert.equal(cache.diagnostics().heapBytes, 125, 'a bit a block');
});

test('the cache is backed by the store it was given, under a name the store allows', async()=>{
    const store = fakeStore();
    const cache = await createBlockCache({ store, ...OPTIONS, name: 'a/game:with\\odd chars' });

    assert.equal(cache.backed, true);
    assert.deepEqual([...store.files.keys()].sort(),
        ['a_game_with_odd_chars.blocks', 'a_game_with_odd_chars.order',
            'a_game_with_odd_chars.present']);
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

test('what of a bundle is here is read off its bitmap, the translation seed aside', async()=>{
    // Ten blocks of 100 bytes, the last two the translation seed; the bitmap
    // says blocks 0, 1, 2 and 9 are here.
    const bundle = {
        fingerprint: 'abc',
        blockCount: 10,
        block: ()=>({ packed: 100 }),
        translations: { firstBlock: 8, blocks: 2 },
    };
    /** @param {Uint8Array | null} bitmap */
    const rootWith = bitmap=>({
        /** @param {string} name */
        getFileHandle: async name=>{
            if (bitmap === null || name !== `${blockCacheName('game', 'abc')}.present`)
            {
                throw new Error('NotFoundError');
            }
            return { getFile: async()=>new Blob([new Uint8Array(bitmap)]) };
        },
    });
    /** @param {Uint8Array | null} bitmap */
    const residency = bitmap=>bundleResidency({ root: rootWith(bitmap), id: 'game', bundle });
    assert.deepEqual(await residency(Uint8Array.of(0b111, 0b10)),
        { blocks: 8, resident: 3, bytes: 800, residentBytes: 300 });
    assert.deepEqual(await residency(null),
        { blocks: 8, resident: 0, bytes: 800, residentBytes: 0 }, 'no cache yet');
    assert.equal((await residency(Uint8Array.of(0xff))).resident, 0,
        'a bitmap of another size is another bundle\'s');
});
