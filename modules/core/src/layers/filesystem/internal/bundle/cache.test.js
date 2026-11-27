/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBlockCache, resolveBlockStore } from './cache.js';
import { BLOCK_DIRECTORY, blockCacheName, bundleResidency, savedBlocks } from './saved.js';
import { fakeOpfs } from '../opfs.fixture.js';

const BLOCK = 4096;
const NAME = blockCacheName('game', '0011aabb');
/** The bundle's directory of the fake origin, as paths name it. */
const HOME = `${BLOCK_DIRECTORY}/${NAME}`;

/** Block `index`'s bytes: its index in the first word, then a byte of it. @param {number} index */
const blockOf = index=>{
    const bytes = new Uint8Array(BLOCK).fill(index * 7 & 0xff);
    new DataView(bytes.buffer).setUint32(0, index, true);
    return bytes;
};

/**
 * @param {any} store @param {Partial<Parameters<typeof createBlockCache>[0]>} [options]
 */
const open = (store, options = {})=>createBlockCache({ store, name: NAME, blockSize: BLOCK,
    blockCount: 64, ...options });

/** A block as the cache reads it, copied out of its `with`. @param {any} cache @param {number} index */
const readOf = (cache, index)=>cache.with(index, (/** @type {Uint8Array} */ body)=>body.slice());

test('the blocks one run fetched are read by the next without a fetch', async()=>{
    const origin = fakeOpfs();
    const first = await open(origin.root);
    assert.equal(first.backed, true);
    for (let index = 0; index < 10; index++)
    {
        assert.equal(first.put(index, blockOf(index)), true);
    }
    first.close();

    const second = await open(origin.root);
    assert.equal(second.diagnostics().resident, 10);
    for (let index = 0; index < 10; index++)
    {
        assert.equal(second.has(index), true, `block ${index} is here`);
        assert.deepEqual(readOf(second, index), blockOf(index), `block ${index} as it was put`);
    }
    assert.equal(second.has(10), false, 'and nothing it never put');
    assert.equal(readOf(second, 10), undefined);
    second.close();
});

test('a block pushed out for room goes to the disk and comes back at its read', async()=>{
    // Room for four blocks in memory, twelve put: the oldest go to the disk
    // as each new one needs room, and a read brings any of them back at once.
    const origin = fakeOpfs();
    const cache = await open(origin.root, { budget: 4 * BLOCK });
    for (let index = 0; index < 12; index++)
    {
        cache.put(index, blockOf(index));
    }
    const { cellar } = cache.diagnostics();
    assert.ok(cellar.hot <= 4 && cellar.cold >= 8, `${cellar.hot} hot, ${cellar.cold} cold`);
    assert.ok(cellar.segmentBytes <= 4 * BLOCK, 'under its budget');
    for (const index of [0, 11, 3, 7, 1])
    {
        assert.equal(cache.has(index), true);
        assert.deepEqual(readOf(cache, index), blockOf(index), `block ${index} back from the disk`);
    }
    assert.ok(cache.diagnostics().cellar.raised >= 4, 'read back from the disk, not kept');
    cache.close();
});

test('a block idle 30 s goes to the disk, its memory let go', async()=>{
    const origin = fakeOpfs();
    const clock = { ms: 0 };
    const cache = await open(origin.root, { now: ()=>clock.ms });
    for (let index = 0; index < 4; index++)
    {
        cache.put(index, blockOf(index));
    }
    clock.ms = 31_000;
    // The cache looks once a second.
    while (cache.diagnostics().cellar.hot > 0)
    {
        await sleep(50);
    }
    assert.equal(cache.diagnostics().cellar.cold, 4);
    assert.deepEqual(readOf(cache, 2), blockOf(2), 'read back from the disk');
    cache.close();
});

test('with no disk a block leaves only for room, never for idling, and is fetched again',
    async()=>{
        const clock = { ms: 0 };
        const cache = await open(null, { budget: 4 * BLOCK, now: ()=>clock.ms });
        assert.equal(cache.backed, false);
        assert.equal(cache.reason, 'no store');
        cache.put(0, blockOf(0));
        cache.put(1, blockOf(1));
        clock.ms = 3_600_000;
        await sleep(1200);
        assert.equal(cache.has(0), true, 'an hour idle and still here');
        for (let index = 2; index < 6; index++)
        {
            cache.put(index, blockOf(index));
        }
        assert.equal(cache.has(0), false, 'let go for room, the least recently read first');
        assert.equal(readOf(cache, 0), undefined, 'a read misses it');
        assert.equal(cache.put(0, blockOf(0)), true, 'fetched again');
        assert.deepEqual(readOf(cache, 0), blockOf(0));
        assert.deepEqual(cache.order(), [], 'and nothing remembered for a next run');
        cache.close();
    });

test('a disk out of room says so once; what it could not take is fetched again', async()=>{
    // The origin holds four blocks and the index; the cache's memory four
    // more: twenty put, the rest of them nowhere.
    const origin = fakeOpfs({ quota: 4 * BLOCK + 2048 });
    /** @type {string[]} */
    const told = [];
    const cache = await open(origin.root, { budget: 4 * BLOCK, onFull: reason=>told.push(reason) });
    for (let index = 0; index < 20; index++)
    {
        cache.put(index, blockOf(index));
    }
    assert.equal(told.length, 1, 'said once');
    assert.match(String(cache.full()), /room/);
    assert.equal(cache.diagnostics().full, cache.full());
    let here = 0;
    for (let index = 0; index < 20; index++)
    {
        const read = readOf(cache, index);
        assert.equal(read === undefined, !cache.has(index), `block ${index}: here is readable`);
        if (read !== undefined)
        {
            here++;
            assert.deepEqual(read, blockOf(index), `block ${index}, never another's bytes`);
        }
    }
    assert.ok(here >= 4 && here < 20, `${here} of 20 kept`);
    assert.ok(origin.used() <= 4 * BLOCK + 2048);
    cache.close();
});

test('what a run fetched last is on the disk within seconds, though it never closes', async()=>{
    // A run killed (a tab closed, a tool's exit) closes nothing: a batch that
    // landed just after a save is saved when the next one is due all the same.
    const origin = fakeOpfs();
    const cache = await open(origin.root);
    cache.put(0, blockOf(0));
    await cache.persist();
    cache.put(1, blockOf(1));
    await cache.persist();
    const saved = async()=>[...(await savedBlocks(origin.root, NAME))?.bodies.keys() ?? []].sort();
    assert.deepEqual(await saved(), ['0'], 'the second batch waits for its turn');
    // Due two seconds after the first save; looked at for five.
    for (let look = 0; look < 50 && (await saved()).length < 2; look++)
    {
        await sleep(100);
    }
    assert.deepEqual(await saved(), ['0', '1']);
    cache.close();
});

test('a pack cut short loses the blocks past its end, the others read whole', async()=>{
    const origin = fakeOpfs();
    const first = await open(origin.root);
    for (let index = 0; index < 6; index++)
    {
        first.put(index, blockOf(index));
    }
    first.close();
    const pack = origin.node(`${HOME}/pack-0`);
    assert.ok(pack && pack.data.length === 6 * BLOCK, 'six blocks written out at the end');
    pack.data = pack.data.slice(0, 4 * BLOCK + 100);

    const second = await open(origin.root);
    assert.equal(second.diagnostics().resident, 4);
    for (let index = 0; index < 6; index++)
    {
        const read = readOf(second, index);
        assert.deepEqual(read, index < 4 ? blockOf(index) : undefined, `block ${index}`);
    }
    second.close();
});

test('another tab holding the bundle\'s files: this one runs in memory, and says why', async()=>{
    const origin = fakeOpfs();
    const first = await open(origin.root);
    const second = await open(origin.root);
    assert.equal(second.backed, false);
    assert.match(String(second.reason), /in use/);
    assert.equal(second.put(3, blockOf(3)), true);
    assert.deepEqual(readOf(second, 3), blockOf(3));
    second.close();
    first.close();
});

test('the order of a run\'s first reads is the next run\'s', async()=>{
    const origin = fakeOpfs();
    const first = await open(origin.root);
    for (const index of [5, 3, 9, 3])
    {
        first.demanded(index);
    }
    await first.persist();
    first.close();
    const second = await open(origin.root);
    assert.deepEqual(second.order(), [5, 3, 9]);
    second.demanded(1);
    second.close();
    const third = await open(origin.root);
    assert.deepEqual(third.order(), [1, 5, 3, 9], 'this run\'s first, then what the last reached');
    third.close();
});

test('the files of the layouts this one replaced go, another bundle\'s stay', async()=>{
    const origin = fakeOpfs();
    for (const old of ['.index', '.order', '.pack.0', '.pack.3', '.blocks', '.blocks.1', '.held',
        '.present', '.slots'])
    {
        origin.put(`${NAME}${old}`, new Uint8Array(8));
    }
    origin.put('other-00000000.index', new Uint8Array(8));
    origin.put(`${NAME}.files`, new Uint8Array(8));
    const cache = await open(origin.root);
    assert.deepEqual(origin.names(), [BLOCK_DIRECTORY, `${NAME}.files`, 'other-00000000.index']);
    cache.close();
});

test('what a keeper saved is read without opening anything for writing', async()=>{
    // Cellar's own keeper writes the index read here: a layout of Cellar's
    // that changed is caught by this test, not by a page that finds nothing.
    const origin = fakeOpfs();
    const cache = await open(origin.root);
    for (const index of [0, 4, 7])
    {
        cache.put(index, blockOf(index));
    }
    cache.close();
    const saved = await savedBlocks(origin.root, NAME);
    assert.ok(saved);
    assert.deepEqual([...saved.bodies.keys()].filter(name=>/^\d+$/.test(name)).sort(),
        ['0', '4', '7']);
    for (const index of [0, 4, 7])
    {
        const body = /** @type {any} */ (saved.bodies.get(String(index)));
        assert.deepEqual(new Uint8Array(await saved.slice(body).arrayBuffer()), blockOf(index));
    }
    assert.equal(await savedBlocks(origin.root, 'nothing-00000000'), null, 'no cache yet');
});

test('a saved index the origin refuses to open is not a miss: the refusal comes through', async()=>{
    const refused = new DOMException('the origin is not allowed', 'SecurityError');
    const root = { getDirectoryHandle: async()=>{
        throw refused;
    } };
    await assert.rejects(savedBlocks(root, NAME), refused);
    const folder = { getFileHandle: async()=>{
        throw new DOMException('held elsewhere', 'NoModificationAllowedError');
    } };
    const blocks = { getDirectoryHandle: async()=>folder };
    await assert.rejects(savedBlocks({ getDirectoryHandle: async()=>blocks }, NAME),
        { name: 'NoModificationAllowedError' }, 'a file of it refused, too');
});

test('what of a bundle is here is read off its saved index, the seed aside', async()=>{
    // Blocks 0, 1, 2, 30 and the last are put; the last two are the
    // translation seed.
    const blockCount = 64;
    const bundle = {
        fingerprint: '0011aabb',
        blockCount,
        block: ()=>({ packed: 1000, codec: 1, length: BLOCK }),
        translations: { firstBlock: blockCount - 2, blocks: 2 },
    };
    const origin = fakeOpfs();
    const cache = await open(origin.root);
    for (const index of [0, 1, 2, 30, blockCount - 1])
    {
        cache.put(index, blockOf(index));
    }
    cache.close();
    const residency = ()=>bundleResidency({ root: origin.root, id: 'game', bundle });
    assert.deepEqual(await residency(), { blocks: blockCount - 2, resident: 4,
        bytes: (blockCount - 2) * 1000, residentBytes: 4000 });
    const pack = /** @type {any} */ (origin.node(`${HOME}/pack-0`));
    // The last two bodies of the pack, block 30 and the seed's, cut short.
    pack.data = pack.data.slice(0, pack.data.length - BLOCK - 1);
    assert.equal((await residency()).resident, 3, 'a block past its pack\'s end is not here');
    assert.equal((await bundleResidency({ root: fakeOpfs().root, id: 'game', bundle })).resident,
        0, 'no cache yet');
});

test('a store is the origin\'s file system, one of your own, or none', async()=>{
    assert.equal(await resolveBlockStore('local'), null, 'no origin file system in node');
    assert.equal(await resolveBlockStore(null), null);
    const mine = fakeOpfs().root;
    assert.equal(await resolveBlockStore(mine), mine);
    const flat = await open({}, { budget: 4 * BLOCK });
    assert.equal(flat.backed, false, 'a store with no directories keeps nothing on a disk');
    flat.close();
});
