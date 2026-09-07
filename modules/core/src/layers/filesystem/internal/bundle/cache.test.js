/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockCache, resolveBlockStore } from './cache.js';

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

    const data = store.files.get('/war.blocks');
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
