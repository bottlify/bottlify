/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createDirectoryTranslationStore, fileNameOf, resolveTranslationStore, STORE_VERSION,
} from './translation-store.js';

/**
 * A directory handle in memory, with the shape the store uses: files that
 * answer `getFile()` (size, bytes, a slice), a writable stream that keeps or
 * replaces what is there, and, when asked for, the synchronous access handle a
 * worker gets from the origin's file system.
 *
 * @param {{ probes: number, syncReads: number }} [counter]
 * @param {boolean} [sync]
 */
function fakeDirectory(counter = { probes: 0, syncReads: 0 }, sync = false){
    /** @type {Map<string, any>} */
    const children = new Map();
    /** @param {Uint8Array} bytes */
    const fileOf = bytes=>({
        size: bytes.length,
        arrayBuffer: async()=>bytes.buffer.slice(
            bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        /** @param {number} from @param {number} to */
        slice: (from, to)=>fileOf(bytes.subarray(from, to)),
    });
    return {
        children,
        counter,
        async* entries(){
            yield* children;
        },
        /** @param {string} name */
        async removeEntry(name){
            children.delete(name);
        },
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getDirectoryHandle(name, options = {}){
            let child = children.get(name);
            if (!child)
            {
                if (!options.create)
                {
                    throw new Error('NotFoundError');
                }
                child = fakeDirectory(counter, sync);
                children.set(name, child);
            }
            return child;
        },
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getFileHandle(name, options = {}){
            counter.probes++;
            let file = children.get(name);
            if (!file)
            {
                if (!options.create)
                {
                    throw new Error('NotFoundError');
                }
                file = {
                    bytes: new Uint8Array(0),
                    async getFile(){
                        return fileOf(file.bytes);
                    },
                    /** @param {{ keepExistingData?: boolean }} [how] */
                    async createWritable(how = {}){
                        let draft = how.keepExistingData
                            ? new Uint8Array(file.bytes) : new Uint8Array(0);
                        return {
                            /** @param {Uint8Array | { type: string, position: number, data: Uint8Array }} b */
                            async write(b){
                                if (b instanceof Uint8Array)
                                {
                                    draft = new Uint8Array(b);
                                    return;
                                }
                                const grown = new Uint8Array(
                                    Math.max(draft.length, b.position + b.data.length));
                                grown.set(draft);
                                grown.set(b.data, b.position);
                                draft = grown;
                            },
                            async close(){
                                file.bytes = draft;
                            },
                        };
                    },
                    ...sync ? {
                        async createSyncAccessHandle(){
                            return {
                                getSize: ()=>file.bytes.length,
                                /** @param {Uint8Array} into @param {{ at: number }} where */
                                read(into, { at }){
                                    counter.syncReads++;
                                    const chunk = file.bytes.subarray(at, at + into.length);
                                    into.set(chunk);
                                    return chunk.length;
                                },
                                /** @param {Uint8Array} from @param {{ at: number }} where */
                                write(from, { at }){
                                    const grown = new Uint8Array(
                                        Math.max(file.bytes.length, at + from.length));
                                    grown.set(file.bytes);
                                    grown.set(from, at);
                                    file.bytes = grown;
                                    return from.length;
                                },
                                /** @param {number} size */
                                truncate(size){
                                    file.bytes = file.bytes.subarray(0, size);
                                },
                                flush(){},
                                close(){},
                            };
                        },
                    } : {},
                };
                children.set(name, file);
            }
            return file;
        },
    };
}

/** @param {any} root @param {string} bundle */
async function indexOf(root, bundle){
    const directory = root.children.get('cork').children.get(`${bundle}.v${STORE_VERSION}`);
    return new TextDecoder().decode(
        new Uint8Array(await (await directory.children.get('index').getFile()).arrayBuffer()));
}

test('a record is appended to the bundle\'s records file and the index names its place',
    async()=>{
        const root = fakeDirectory();
        const store = await createDirectoryTranslationStore(root, 'my game/1.0');
        assert.equal(await store.get('cork/1/x/401000/abc'), null);
        await store.put('cork/1/x/401000/abc', new Uint8Array([7, 8, 9]));
        assert.deepEqual([...(await store.get('cork/1/x/401000/abc') ?? [])], [7, 8, 9]);
        const bundle = root.children.get('cork').children.get(`my_game_1.0.v${STORE_VERSION}`);
        assert.ok(bundle.children.has('records'), 'one records file');
        assert.match(fileNameOf('anything'), /^[0-9a-f]{16}\.cork$/);
        assert.notEqual(fileNameOf('a'), fileNameOf('b'));
        // The index names the record's place: name, offset, length, after
        // the mark of the session that wrote it.
        assert.equal(await indexOf(root, 'my_game_1.0'),
            `# 1\n${fileNameOf('cork/1/x/401000/abc')} 0 3\n`);
        // A miss touches the file system for nothing: the index answers it.
        const probes = root.counter.probes;
        assert.equal(await store.get('cork/1/x/999/zzz'), null);
        assert.equal(root.counter.probes, probes, 'a miss probes no file');
        // Overwritten by an append: the index points at the new bytes.
        await store.put('cork/1/x/401000/abc', new Uint8Array([1]));
        assert.deepEqual([...(await store.get('cork/1/x/401000/abc') ?? [])], [1]);
        assert.equal(await indexOf(root, 'my_game_1.0'),
            `# 1\n${fileNameOf('cork/1/x/401000/abc')} 0 3\n${fileNameOf('cork/1/x/401000/abc')} 3 1\n`,
            'the index is a log: the later line for a name wins');
        const reopened = await createDirectoryTranslationStore(root, 'my game/1.0');
        assert.deepEqual([...(await reopened.get('cork/1/x/401000/abc') ?? [])], [1]);
        assert.equal(bundle.children.get('records').bytes.length, 4, 'both records are kept');
    });

test('a batch of puts is indexed whole and a reopened store hits every one', async()=>{
    // A run's regions are put in one turn; the index carries all of them and
    // the records land at distinct places.
    const root = fakeDirectory();
    const first = await createDirectoryTranslationStore(root, 'bundle');
    const COUNT = 64;
    await Promise.all(Array.from({ length: COUNT },
        (_, i)=>first.put(`cork/1/bundle/40${i}/hash`, new Uint8Array([i, i, i, i & 1]))));
    await first.flush();
    const second = await createDirectoryTranslationStore(root, 'bundle');
    let hits = 0;
    for (let i = 0; i < COUNT; i++)
    {
        const bytes = await second.get(`cork/1/bundle/40${i}/hash`);
        if (bytes !== null && bytes[0] === i && bytes[3] === (i & 1))
        {
            hits++;
        }
    }
    assert.equal(hits, COUNT, 'every record of the batch is found after a reopen, intact');
    assert.equal((await indexOf(root, 'bundle')).trim().split('\n')
        .filter(line=>!line.startsWith('#')).length, COUNT);
});

test('inside a worker a hit is one synchronous read through the records file\'s handle',
    async()=>{
        const counter = { probes: 0, syncReads: 0 };
        const root = fakeDirectory(counter, true);
        const first = await createDirectoryTranslationStore(root, 'bundle');
        await first.put('cork/1/a', new Uint8Array([1, 2, 3, 4, 5]));
        await first.put('cork/1/b', new Uint8Array([6, 7]));
        await first.flush();
        const second = await createDirectoryTranslationStore(root, 'bundle');
        assert.deepEqual([...(await second.get('cork/1/b') ?? [])], [6, 7]);
        const probes = counter.probes;
        const reads = counter.syncReads;
        assert.deepEqual([...(await second.get('cork/1/a') ?? [])], [1, 2, 3, 4, 5]);
        assert.equal(counter.probes, probes, 'a hit opens no file');
        assert.equal(counter.syncReads, reads + 1, 'one read at the record\'s offset');
        second.close();
    });

test('an index entry the records file does not reach is not a record', async()=>{
    const root = fakeDirectory();
    const store = await createDirectoryTranslationStore(root, 'bundle');
    await store.put('cork/1/a', new Uint8Array([1, 2, 3]));
    await store.flush();
    // The page went away after the index was written but before the records
    // were: the file is shorter than the index says.
    const directory = root.children.get('cork').children.get(`bundle.v${STORE_VERSION}`);
    directory.children.get('records').bytes = new Uint8Array(0);
    const reopened = await createDirectoryTranslationStore(root, 'bundle');
    assert.equal(await reopened.get('cork/1/a'), null, 'a torn write is a miss, not garbage');
});

test('opening a store removes the bundle\'s directories of other layout versions', async()=>{
    const root = fakeDirectory();
    const cork = await root.getDirectoryHandle('cork', { create: true });
    await cork.getDirectoryHandle('bundle.v1', { create: true });
    await cork.getDirectoryHandle('other.v1', { create: true });
    await createDirectoryTranslationStore(root, 'bundle');
    assert.ok(!cork.children.has('bundle.v1'), 'the old version is gone');
    assert.ok(cork.children.has(`bundle.v${STORE_VERSION}`), 'this one stands');
    assert.ok(cork.children.has('other.v1'), 'another bundle\'s is not touched');
});

test('the request resolves to nothing without the API, to itself as an object', async()=>{
    assert.equal(await resolveTranslationStore(null, 'x'), null);
    assert.equal(await resolveTranslationStore(undefined, 'x'), null);
    assert.equal(await resolveTranslationStore('local', 'x'), null, 'no origin file system here');
    const own = { get: async()=>null, put: async()=>{} };
    assert.equal(await resolveTranslationStore(own, 'x'), own);
});

/** The size of the bundle's current records file. @param {any} root */
function recordsSize(root, bundle = 'bundle'){
    const directory = root.children.get('cork').children.get(`${bundle}.v${STORE_VERSION}`);
    const current = directory.children.get('current');
    const generation = current ? new TextDecoder().decode(current.bytes) : '0';
    return directory.children.get(generation === '0' ? 'records' : `records.${generation}`)
        .bytes.length;
}

/**
 * Twenty runs of a title: each reads its stable regions (a warm run), writes
 * its relinked records again (a re-put) and a module of its own that no later
 * run names (a relink's, or an old translator version's).
 *
 * @param {any} root @param {any} limits
 */
async function twentyRuns(root, limits){
    const sizes = [];
    for (let run = 0; run < 20; run++)
    {
        const store = await createDirectoryTranslationStore(root, 'bundle', limits);
        for (let i = 0; i < 8; i++)
        {
            if (await store.get(`stable/${i}`) === null)
            {
                await store.put(`stable/${i}`, new Uint8Array(100).fill(i));
            }
            await store.put(`relinked/${i}`, new Uint8Array(100).fill(run));
        }
        await store.put(`module/${run}`, new Uint8Array(1000).fill(run));
        await store.flush();
        store.close();
        sizes.push(recordsSize(root));
    }
    return sizes;
}

for (const sync of [false, true])
{
    test(`the store keeps what recent runs used and drops the rest${sync ? ' (worker)' : ''}`,
        async()=>{
            const limits = { keepSessions: 2, compactFloor: 4096, cap: 1 << 20 };
            const grown = await twentyRuns(fakeDirectory(undefined, sync),
                { ...limits, compactFloor: Infinity });
            const root = fakeDirectory(undefined, sync);
            const kept = await twentyRuns(root, limits);
            // Unbounded, every run appended its re-puts and its module for good.
            assert.equal(grown[19], 20 * 1800 + 800);
            // Kept, the file is at most twice what the last sessions used
            // (8 stable + 8 relinked + 3 modules: 4 600) and one run more.
            assert.ok(Math.max(...kept) <= 2 * 4600 + 1800, `bounded: ${kept.join(' ')}`);
            assert.deepEqual(kept.slice(-4), kept.slice(-6, -2), 'and steady, not growing');
            const store = await createDirectoryTranslationStore(root, 'bundle', limits);
            for (let i = 0; i < 8; i++)
            {
                assert.deepEqual([...(await store.get(`stable/${i}`) ?? [])],
                    Array(100).fill(i), 'what every run reads stays');
                assert.equal((await store.get(`relinked/${i}`))?.[0], 19,
                    'the last write of a name');
            }
            assert.ok(await store.get('module/19') !== null, 'the last run\'s module stays');
            assert.equal(await store.get('module/3'), null, 'one no run used for long goes');
        });
}

test('a compaction cut short before its generation is named leaves the old one whole', async()=>{
    const root = fakeDirectory();
    const first = await createDirectoryTranslationStore(root, 'bundle');
    await first.put('a', new Uint8Array([1, 2, 3]));
    await first.flush();
    // The page went away with the next generation's files written and the
    // `current` file not: they are strays, the old generation stands.
    const directory = root.children.get('cork').children.get(`bundle.v${STORE_VERSION}`);
    const stray = await directory.getFileHandle('records.1', { create: true });
    stray.bytes = new Uint8Array([9, 9, 9, 9]);
    const strayIndex = await directory.getFileHandle('index.1', { create: true });
    strayIndex.bytes = new TextEncoder().encode(`# 1\n${fileNameOf('a')} 0 4\n`);
    const second = await createDirectoryTranslationStore(root, 'bundle');
    assert.deepEqual([...(await second.get('a') ?? [])], [1, 2, 3], 'the old generation read');
    await second.flush();
    // A later compaction writes over the strays rather than after them.
    const third = await createDirectoryTranslationStore(root, 'bundle',
        { keepSessions: 4, compactFloor: 0, cap: 2 });
    assert.equal(await third.get('a'), null, 'past the cap');
    const fourth = await createDirectoryTranslationStore(root, 'bundle');
    await fourth.put('b', new Uint8Array([5]));
    await fourth.flush();
    assert.equal(new TextDecoder().decode(directory.children.get('current').bytes), '1');
    assert.deepEqual([...directory.children.get('records.1').bytes], [5],
        'the stray bytes replaced, not appended to');
    assert.ok(!directory.children.has('records'), 'the old generation removed');
    const fifth = await createDirectoryTranslationStore(root, 'bundle');
    assert.deepEqual([...(await fifth.get('b') ?? [])], [5]);
});

test('an index of touches is rewritten when it outgrows its records', async()=>{
    // A warm run that only reads: every run touches the same forty records,
    // and the records stay far under the compaction floor.
    const root = fakeDirectory();
    const limits = { keepSessions: 4, compactFloor: 1 << 20, cap: 1 << 30, indexFloor: 16384 };
    /** @type {number[]} */
    const sizes = [];
    for (let run = 0; run < 60; run++)
    {
        const store = await createDirectoryTranslationStore(root, 'bundle', limits);
        for (let i = 0; i < 40; i++)
        {
            if (await store.get(`region/${i}`) === null)
            {
                await store.put(`region/${i}`, new Uint8Array(64).fill(i));
            }
        }
        await store.flush();
        store.close();
        const directory = root.children.get('cork').children.get(`bundle.v${STORE_VERSION}`);
        const current = directory.children.get('current');
        const generation = current ? new TextDecoder().decode(current.bytes) : '0';
        sizes.push(directory.children.get(generation === '0' ? 'index' : `index.${generation}`)
            .bytes.length);
    }
    assert.ok(Math.max(...sizes.slice(30)) <= 16384 + 40 * 60, `bounded: ${sizes.join(' ')}`);
    const store = await createDirectoryTranslationStore(root, 'bundle', limits);
    assert.deepEqual([...(await store.get('region/7') ?? [])], Array(64).fill(7),
        'and all still read');
});

test('past the cap the records least recently used go first', async()=>{
    const root = fakeDirectory();
    for (let run = 0; run < 4; run++)
    {
        const store = await createDirectoryTranslationStore(root, 'bundle');
        await store.put(`r${run}`, new Uint8Array(10).fill(run));
        await store.flush();
    }
    const store = await createDirectoryTranslationStore(root, 'bundle',
        { keepSessions: 100, compactFloor: 1 << 20, cap: 25 });
    assert.equal(await store.get('r0'), null);
    assert.equal(await store.get('r1'), null);
    assert.equal((await store.get('r2'))?.[0], 2);
    assert.equal((await store.get('r3'))?.[0], 3);
    assert.equal(recordsSize(root), 20);
});
