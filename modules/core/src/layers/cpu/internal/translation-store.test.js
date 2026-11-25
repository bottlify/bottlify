/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unframe } from './record-frame.js';
import {
    clearTranslations, createDirectoryTranslationStore, createMemoryDirectory, fileNameOf,
    readPieces, resolveTranslationStore,
    SEED_FORMAT, STORE_VERSION, unpackSeed,
} from './translation-store.js';

/**
 * A directory handle in memory, with the shape the store uses: files that
 * answer `getFile()` (size, bytes, a slice), a writable stream that keeps or
 * replaces what is there, and, when asked for, the synchronous access handle a
 * worker gets from the origin's file system.
 *
 * @param {{ probes: number, syncReads: number, writes?: number, writeMs?: number,
 *     writables?: number, largest?: number, short?: number }} [counter]  `largest`: the most
 *     bytes one write through the synchronous handle took; `short`: bytes each such write
 *     leaves out
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
                        counter.writables = (counter.writables ?? 0) + 1;
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
                                    counter.writes = (counter.writes ?? 0) + 1;
                                    counter.largest = Math.max(counter.largest ?? 0, from.length);
                                    // A disk taking a write in part, where a test asks.
                                    from = from.subarray(0, from.length - (counter.short ?? 0));
                                    // A disk that takes its time, where a test asks.
                                    const until = performance.now() + (counter.writeMs ?? 0);
                                    while (performance.now() < until)
                                    {
                                        // the write is under way
                                    }
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
        // The index names the record's place: name, offset, length (its frame's
        // byte and its own, `record-frame.js`), after the mark of the session that wrote it.
        assert.equal(await indexOf(root, 'my_game_1.0'),
            `# 1\n${fileNameOf('cork/1/x/401000/abc')} 0 4\n`);
        // A miss touches the file system for nothing: the index answers it.
        const probes = root.counter.probes;
        assert.equal(await store.get('cork/1/x/999/zzz'), null);
        assert.equal(root.counter.probes, probes, 'a miss probes no file');
        // Overwritten by an append: the index points at the new bytes.
        await store.put('cork/1/x/401000/abc', new Uint8Array([1]));
        assert.deepEqual([...(await store.get('cork/1/x/401000/abc') ?? [])], [1]);
        assert.equal(await indexOf(root, 'my_game_1.0'),
            `# 1\n${fileNameOf('cork/1/x/401000/abc')} 0 4\n${fileNameOf('cork/1/x/401000/abc')} 4 2\n`,
            'the index is a log: the later line for a name wins');
        const reopened = await createDirectoryTranslationStore(root, 'my game/1.0');
        assert.deepEqual([...(await reopened.get('cork/1/x/401000/abc') ?? [])], [1]);
        assert.equal(bundle.children.get('records').bytes.length, 6, 'both records are kept');
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

test('the local store of a bundle has one user at a time: a second run goes without',
    async()=>{
        // Two openings of the same files compacted under each other, and the
        // one still reading a removed generation stopped the engine's start.
        /** @type {Set<string>} */
        const held = new Set();
        const locks = {
            /** @param {string} lockName @param {any} options @param {(lock: any) => any} body */
            request: async(lockName, options, body)=>{
                if (held.has(lockName))
                {
                    assert.equal(options.ifAvailable, true);
                    return body(null);
                }
                held.add(lockName);
                try
                {
                    return await body({ name: lockName });
                }
                finally
                {
                    held.delete(lockName);
                }
            },
        };
        const root = createMemoryDirectory();
        const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', { configurable: true,
            value: { storage: { getDirectory: async()=>root }, locks } });
        try
        {
            const first = await resolveTranslationStore('local', 'game');
            assert.ok(first, 'the first run has the store');
            assert.equal(await resolveTranslationStore('local', 'game'), null,
                'a second, while the first holds it, runs without');
            assert.ok(await resolveTranslationStore('local', 'other'), 'another has its own');
            first.close?.();
            await new Promise(done=>setTimeout(done, 0));
            assert.ok(await resolveTranslationStore('local', 'game'), 'free again once closed');
        }
        finally
        {
            if (before)
            {
                Object.defineProperty(globalThis, 'navigator', before);
            }
            else
            {
                delete /** @type {any} */ (globalThis).navigator;
            }
        }
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
            // Unbounded, every run appended its re-puts and its module for good; each
            // record a byte longer for its frame, none compressed under a kilobyte.
            assert.equal(grown[19], 20 * 1809 + 808);
            // Kept, the file is at most twice what the last sessions used
            // (8 stable + 8 relinked + 3 modules: 4 619) and one run more.
            assert.ok(Math.max(...kept) <= 2 * 4619 + 1809, `bounded: ${kept.join(' ')}`);
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
    // A run that used something else, so 'a' is no longer the last run's.
    const between = await createDirectoryTranslationStore(root, 'bundle');
    await between.put('z', new Uint8Array([7]));
    await between.close();
    // A later compaction writes over the strays rather than after them.
    const third = await createDirectoryTranslationStore(root, 'bundle',
        { keepSessions: 4, compactFloor: 0, cap: 2 });
    assert.equal(await third.get('a'), null, 'past the cap');
    const fourth = await createDirectoryTranslationStore(root, 'bundle');
    await fourth.put('b', new Uint8Array([5]));
    await fourth.flush();
    assert.equal(new TextDecoder().decode(directory.children.get('current').bytes), '1');
    assert.deepEqual([...directory.children.get('records.1').bytes], [0, 7, 0, 5],
        'the stray bytes replaced, not appended to (each record after its frame\'s byte)');
    assert.ok(!directory.children.has('records'), 'the old generation removed');
    const fifth = await createDirectoryTranslationStore(root, 'bundle');
    assert.deepEqual([...(await fifth.get('b') ?? [])], [5]);
});

test('opening a store removes what its named generation is not made of, or, none named,'
    + ' files it does not know', async()=>{
    const root = fakeDirectory();
    const first = await createDirectoryTranslationStore(root, 'bundle');
    await first.put('a', new Uint8Array([1, 2, 3]));
    await first.close();
    const directory = root.children.get('cork').children.get(`bundle.v${STORE_VERSION}`);
    // A generation a compaction left (the tab closed before it removed the
    // old one, or before it named the new one), and a file nothing reads.
    for (const [name, bytes] of [['records.4', 40], ['index.4', 4], ['records.tmp', 7]])
    {
        const stray = await directory.getFileHandle(/** @type {string} */ (name),
            { create: true });
        stray.bytes = new Uint8Array(/** @type {number} */ (bytes));
    }
    const second = await createDirectoryTranslationStore(root, 'bundle');
    assert.deepEqual([...(await second.get('a') ?? [])], [1, 2, 3], 'its own records read');
    // No generation named: another's files may be the current one's, and stay.
    assert.deepEqual([...directory.children.keys()].sort(),
        ['index', 'index.4', 'records', 'records.4']);
    assert.equal(second.stats().opened.swept, 1);
    assert.equal(second.stats().opened.sweptBytes, 7);
    await second.close();
    // Named current, a later generation keeps its own files and loses the first's.
    const named = await directory.getFileHandle('current', { create: true });
    named.bytes = new TextEncoder().encode('2');
    for (const name of ['records.2', 'index.2'])
    {
        (await directory.getFileHandle(name, { create: true })).bytes = new Uint8Array(0);
    }
    const third = await createDirectoryTranslationStore(root, 'bundle');
    await third.get('a');
    assert.deepEqual([...directory.children.keys()].sort(),
        ['current', 'index.2', 'records.2'], 'what the current generation is made of');
    assert.equal(third.stats().opened.swept, 4);
    await third.close();
});

test('an opening that cannot read which generation is current removes nothing', async()=>{
    const root = fakeDirectory();
    const first = await createDirectoryTranslationStore(root, 'bundle');
    await first.put('a', new Uint8Array([1]));
    await first.close();
    const directory = root.children.get('cork').children.get(`bundle.v${STORE_VERSION}`);
    for (const name of ['current', 'records.2', 'index.2'])
    {
        (await directory.getFileHandle(name, { create: true })).bytes = name === 'current'
            ? new TextEncoder().encode('2') : new Uint8Array(0);
    }
    // The file there and its read refused, as a browser's storage does at times.
    const files = [...directory.children.keys()].sort();
    const getFileHandle = directory.getFileHandle.bind(directory);
    directory.getFileHandle = async(/** @type {string} */ name, /** @type {any} */ options)=>{
        if (name === 'current')
        {
            throw new Error('A requested file or directory could not be found');
        }
        return getFileHandle(name, options);
    };
    const second = await createDirectoryTranslationStore(root, 'bundle');
    await second.get('a');
    assert.equal(second.stats().opened.swept, 0);
    for (const name of files)
    {
        assert.ok(directory.children.has(name), `${name} kept`);
    }
    await second.close();
});

test('a `current` a write cut short left names no generation, and nothing is removed for it',
    async()=>{
        const root = fakeDirectory();
        const first = await createDirectoryTranslationStore(root, 'bundle');
        await first.put('a', new Uint8Array([1]));
        await first.close();
        const directory = root.children.get('cork').children.get(`bundle.v${STORE_VERSION}`);
        for (const name of ['records.12', 'index.12'])
        {
            (await directory.getFileHandle(name, { create: true })).bytes = new Uint8Array(0);
        }
        // `12` replaced through a synchronous handle and the page gone between the
        // cut and the write, or after its first digit.
        for (const torn of ['', '1'])
        {
            (await directory.getFileHandle('current', { create: true })).bytes =
                new TextEncoder().encode(torn);
            const store = await createDirectoryTranslationStore(root, 'bundle');
            assert.deepEqual([...(await store.get('a') ?? [])], [1], `${torn || 'empty'}: `
                + 'read as none named');
            assert.equal(store.stats().opened.swept, 0, `${torn || 'empty'}: nothing removed`);
            assert.ok(directory.children.has('records.12') && directory.children.has('records'));
            await store.close();
        }
    });

test('a record the disk took in part is a failure of the store, and no index names it',
    async()=>{
        const counter = { probes: 0, syncReads: 0, writes: 0, short: 0 };
        const root = fakeDirectory(counter, true);
        const store = await createDirectoryTranslationStore(root, 'bundle', undefined,
            { writer: ()=>null });
        await store.put('first', Uint8Array.from({ length: 64 }, (_, at)=>at));
        await store.flush();
        counter.short = 1;
        await store.put('torn', Uint8Array.from({ length: 64 }, (_, at)=>255 - at));
        counter.short = 0;
        await store.put('after', new Uint8Array([7]));
        await store.flush();
        assert.ok(store.stats().broken, 'the store gave up for the run');
        await store.close();
        assert.ok(!(await indexOf(root, 'bundle')).includes(fileNameOf('torn')));
        const next = await createDirectoryTranslationStore(root, 'bundle');
        assert.equal(await next.get('torn'), null);
        assert.equal((await next.get('first'))?.length, 64, 'what was whole stays');
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
        { keepSessions: 100, compactFloor: 0, cap: 25 });
    assert.equal(await store.get('r0'), null);
    assert.equal(await store.get('r1'), null);
    assert.equal((await store.get('r2'))?.[0], 2);
    assert.equal((await store.get('r3'))?.[0], 3);
    // Two records of ten bytes, each after its frame's byte.
    assert.equal(recordsSize(root), 22);
});

test('the last run\'s records stay whole however far past the cap they are', async()=>{
    // A game's session used 1.9 GB against a cap of 1: cut to the cap at every
    // start, the run after it translated half of what it had just stored.
    const root = fakeDirectory();
    const old = await createDirectoryTranslationStore(root, 'bundle');
    await old.put('old', new Uint8Array(10));
    await old.close();
    const big = await createDirectoryTranslationStore(root, 'bundle');
    for (let i = 0; i < 8; i++)
    {
        await big.put(`r${i}`, new Uint8Array(10).fill(i));
    }
    await big.close();
    const store = await createDirectoryTranslationStore(root, 'bundle',
        { keepSessions: 4, compactFloor: 0, cap: 25 });
    for (let i = 0; i < 8; i++)
    {
        assert.equal((await store.get(`r${i}`))?.[0], i, `r${i}, the last run's`);
    }
    assert.deepEqual({ ...store.stats().opened, ms: 0 }, { records: 9, bytes: 99, kept: 8,
        keptBytes: 88, overCap: 11, orphans: 0, compacted: false, ms: 0, swept: 0, sweptBytes: 0 },
    'past the cap only what an older run used, and a ninth of the file is no copy\'s worth');
    assert.equal((await store.get('old'))?.length, 10, 'readable until a copy leaves it out');
});

test('a region\'s module lives as long as the region, read or not', async()=>{
    // A run that has the module's instance already reads only the region: the
    // module went as unused, and every region of it missed for want of it.
    const root = fakeDirectory();
    const limits = { keepSessions: 2, compactFloor: 0, cap: 1 << 20 };
    const first = await createDirectoryTranslationStore(root, 'bundle', limits);
    await first.put('module/m', new Uint8Array(100).fill(9));
    await first.put('region/a', new Uint8Array([1]), { needs: 'module/m' });
    await first.put('region/b', new Uint8Array([2]), { needs: 'module/m' });
    await first.close();
    for (let run = 0; run < 6; run++)
    {
        const store = await createDirectoryTranslationStore(root, 'bundle', limits);
        assert.deepEqual([...await store.get('region/a') ?? []], [1], `run ${run}`);
        await store.put(`other/${run}`, new Uint8Array(200));
        await store.close();
    }
    const store = await createDirectoryTranslationStore(root, 'bundle', limits);
    assert.equal((await store.get('module/m'))?.[0], 9, 'the module of a region in use');
    assert.equal(await store.get('region/b'), null, 'a region unused for long goes');
    assert.equal(await store.get('other/0'), null);
});

test('a region whose module is gone is no record, and past the cap the two go together',
    async()=>{
        const root = fakeDirectory();
        const first = await createDirectoryTranslationStore(root, 'bundle');
        // Named, never written: a page that went away between the two puts.
        await first.put('region/lost', new Uint8Array([1]), { needs: 'module/never' });
        await first.put('module/old', new Uint8Array(40).fill(4));
        await first.put('region/old', new Uint8Array([4]), { needs: 'module/old' });
        await first.close();
        const second = await createDirectoryTranslationStore(root, 'bundle');
        await second.put('module/new', new Uint8Array(40).fill(5));
        await second.put('region/new', new Uint8Array([5]), { needs: 'module/new' });
        await second.close();
        const store = await createDirectoryTranslationStore(root, 'bundle',
            { keepSessions: 4, compactFloor: 0, cap: 60 });
        assert.equal(await store.get('region/lost'), null, 'no module, no region');
        assert.equal(store.stats().opened.orphans, 1);
        assert.equal((await store.get('region/new'))?.[0], 5);
        assert.equal((await store.get('module/new'))?.[0], 5);
        assert.equal(await store.get('region/old'), null, 'the older pair past the cap');
        assert.equal(await store.get('module/old'), null, 'its module with it, not one alone');
    });

test('a module no region names any more is dead, however recently it was written',
    async()=>{
        // A relink moves its regions to a module of its own, each region's
        // record written again to name it: the batch's module is then named by
        // none, and kept for a session it is only weight.
        const root = fakeDirectory();
        const limits = { keepSessions: 4, compactFloor: 0, cap: 1 << 20 };
        const run = await createDirectoryTranslationStore(root, 'bundle', limits);
        await run.put('module/batch', new Uint8Array(400).fill(1));
        await run.put('region/a', new Uint8Array([1]), { needs: 'module/batch' });
        await run.put('region/b', new Uint8Array([2]), { needs: 'module/batch' });
        await run.put('module/relinked', new Uint8Array(400).fill(2));
        await run.put('region/a', new Uint8Array([3]), { needs: 'module/relinked' });
        await run.put('region/b', new Uint8Array([4]), { needs: 'module/relinked' });
        await run.close();
        const next = await createDirectoryTranslationStore(root, 'bundle', limits);
        assert.equal(await next.get('module/batch'), null, 'named by none');
        assert.equal((await next.get('module/relinked'))?.[0], 2);
        assert.deepEqual([(await next.get('region/a'))?.[0], (await next.get('region/b'))?.[0]],
            [3, 4]);
        assert.equal(next.stats().opened.compacted, true, 'more than half the file was dead');
        assert.equal(next.stats().bytes, 405, 'the relinked module and its two regions, framed');
    });

test('a store closed straight after its puts has them on disk for the next run', async()=>{
    for (const sync of [false, true])
    {
        const root = fakeDirectory(undefined, sync);
        const first = await createDirectoryTranslationStore(root, 'bundle');
        const puts = [];
        for (let i = 0; i < 20; i++)
        {
            puts.push(first.put(`r${i}`, new Uint8Array([i])));
        }
        // Not awaited, and no flush: the run's end closes the store as it goes.
        const closed = first.close();
        await Promise.all([...puts, closed]);
        const next = await createDirectoryTranslationStore(root, 'bundle');
        for (let i = 0; i < 20; i++)
        {
            assert.equal((await next.get(`r${i}`))?.[0], i, `r${i}${sync ? ' (worker)' : ''}`);
        }
        assert.equal(await first.get('late'), null);
        await first.put('late', new Uint8Array([1]));
        assert.equal(await next.get('late'), null, 'a put after the close keeps nothing');
    }
    // With a writer of its own, which a close ends: its writes still held go
    // with it unless the close waits for them.
    const root = fakeDirectory(undefined, true);
    const writer = heldWriter();
    const first = await createDirectoryTranslationStore(root, 'bundle', undefined,
        { writer: writer.factory });
    await first.prepare();
    const puts = [];
    for (let i = 0; i < 5; i++)
    {
        puts.push(first.put(`w${i}`, new Uint8Array([i])));
    }
    const closed = first.close();
    await new Promise(resolve=>setTimeout(resolve, 0));
    writer.release();
    await Promise.all([...puts, closed]);
    const next = await createDirectoryTranslationStore(root, 'bundle');
    for (let i = 0; i < 5; i++)
    {
        assert.equal((await next.get(`w${i}`))?.[0], i, `w${i}, written through the writer`);
    }
});

test('a record appended to reads whole, in its pieces\' order, reopened and compacted alike',
    async()=>{
        for (const sync of [false, true])
        {
            const root = fakeDirectory(undefined, sync);
            const limits = { keepSessions: 1, compactFloor: 0, cap: 1 << 20 };
            const first = await createDirectoryTranslationStore(root, 'bundle');
            await first.append('map', new Uint8Array([1, 2]));
            await first.put('dead', new Uint8Array(64));
            await first.append('map', new Uint8Array([3]));
            await first.append('map', new Uint8Array([4, 5]));
            const whole = [1, 2, 3, 4, 5];
            assert.deepEqual([...(await first.get('map')) ?? []], whole);
            if (sync)
            {
                assert.deepEqual([...first.getNow('map') ?? []], whole, 'at once');
            }
            const lines = (await indexOf(root, 'bundle')).split('\n');
            assert.equal(lines.filter(line=>line.startsWith(fileNameOf('map'))
                && line.endsWith(' +')).length, 2, 'two pieces named after the first');
            // Not closed: a page that goes away leaves its store so.
            const next = await createDirectoryTranslationStore(root, 'bundle');
            assert.deepEqual([...(await next.get('map')) ?? []], whole, 'reopened');
            await next.close();
            // 'dead' unread for a session: the next opening copies the live records.
            const compacted = await createDirectoryTranslationStore(root, 'bundle', limits);
            assert.deepEqual([...(await compacted.get('map')) ?? []], whole, 'compacted');
            assert.equal(compacted.stats().opened.compacted, true);
            assert.equal(await compacted.get('dead'), null);
            await compacted.close();
        }
    });

test('the touches of a run\'s reads are in the index a while after, the store left open',
    async t=>{
        const root = fakeDirectory();
        const first = await createDirectoryTranslationStore(root, 'bundle');
        await first.put('read', new Uint8Array([3]));
        await first.close();
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const second = await createDirectoryTranslationStore(root, 'bundle');
        assert.equal((await second.get('read'))?.[0], 3);
        const name = fileNameOf('read');
        const named = async()=>(await indexOf(root, 'bundle')).split(`# 2\n`)[1] ?? '';
        assert.equal(await named(), '', 'not at once');
        t.mock.timers.tick(2000);
        for (let turn = 0; turn < 20 && !(await named()).includes(name); turn++)
        {
            await new Promise(resolve=>setImmediate(resolve));
        }
        assert.match(await named(), new RegExp(`^${name} 0 2$`, 'm'));
    });

test('a run that only reads keeps what it read young', async()=>{
    // Its touches were written only past 512 lines: a warm run reading a
    // hundred records left them as old as the run that wrote them.
    const root = fakeDirectory();
    const limits = { keepSessions: 2, compactFloor: 0, cap: 1 << 20 };
    const first = await createDirectoryTranslationStore(root, 'bundle', limits);
    await first.put('read', new Uint8Array(10).fill(3));
    await first.put('unread', new Uint8Array(10));
    await first.close();
    for (let run = 0; run < 4; run++)
    {
        const store = await createDirectoryTranslationStore(root, 'bundle', limits);
        assert.equal((await store.get('read'))?.[0], 3, `run ${run}`);
        await store.close();
    }
    const store = await createDirectoryTranslationStore(root, 'bundle', limits);
    assert.equal(await store.get('unread'), null);
    assert.equal((await store.get('read'))?.[0], 3);
});

/**
 * What a store answers for each of `keys`, as arrays.
 *
 * @param {any} store @param {string[]} keys
 */
async function recordsOf(store, keys){
    return Promise.all(keys.map(async key=>[...(await store.get(key)) ?? []]));
}

const SEED_KEYS = ['cork/41/a/401000/x', 'cork/41/a/module/y', 'cork/41/a/402000/z'];

/** A store over `root` holding three records, flushed. @param {any} root */
async function capturedStore(root){
    const store = await createDirectoryTranslationStore(root, 'game');
    await store.put(SEED_KEYS[0], new Uint8Array([1, 2, 3]));
    await store.put(SEED_KEYS[1], new Uint8Array(300).fill(7));
    await store.put(SEED_KEYS[2], new Uint8Array([9]));
    // Written twice: a seed carries the later place, as a lookup would.
    await store.put(SEED_KEYS[2], new Uint8Array([9, 9]));
    await store.flush();
    return store;
}

for (const [kind, rootOf] of /** @type {[string, () => any][]} */ ([
    ['a worker\'s', ()=>createMemoryDirectory()],
    ['a page\'s', ()=>fakeDirectory()],
]))
{
    test(`a seed exported from one store gives an empty one the same records (${kind} files)`,
        async()=>{
            const first = await capturedStore(rootOf());
            const seed = await first.exportSeed();
            assert.equal(String.fromCharCode(...seed.subarray(0, 8)), 'CORKSEED');
            assert.equal(unpackSeed(seed)?.length, 3, 'one record a name, the later place');

            const root = rootOf();
            const fresh = await createDirectoryTranslationStore(root, 'game');
            assert.equal(await fresh.seededWith(), null);
            assert.deepEqual(await fresh.seed(seed, 'digest-1'),
                { taken: true, added: 3, present: 0 });
            const expected = await recordsOf(first, SEED_KEYS);
            assert.deepEqual(expected[2], [9, 9]);
            assert.deepEqual(await recordsOf(fresh, SEED_KEYS), expected);
            assert.equal(await fresh.seededWith(), 'digest-1');
            assert.deepEqual(await fresh.exportSeed(), seed, 'the same records make the same seed');
            await fresh.flush();
            fresh.close();

            // On disk: a store opened later finds the seeded records and the mark.
            const reopened = await createDirectoryTranslationStore(root, 'game');
            assert.deepEqual(await recordsOf(reopened, SEED_KEYS), expected);
            assert.equal(await reopened.seededWith(), 'digest-1');
            // Taken again, nothing is added: the records file stays as it was.
            const records = await (await root.getDirectoryHandle('cork'))
                .getDirectoryHandle(`game.v${STORE_VERSION}`);
            const size = (await (await records.getFileHandle('records')).getFile()).size;
            assert.deepEqual(await reopened.seed(seed, 'digest-1'),
                { taken: true, added: 0, present: 3 });
            await reopened.flush();
            assert.equal((await (await records.getFileHandle('records')).getFile()).size, size,
                'a second seed adds no bytes');
        });
}

test('a seed is the same bytes whatever order its records were put in', async()=>{
    const a = await createDirectoryTranslationStore(createMemoryDirectory(), 'game');
    const b = await createDirectoryTranslationStore(createMemoryDirectory(), 'game');
    for (let i = 0; i < 20; i++)
    {
        await a.put(`key/${i}`, new Uint8Array([i, i + 1]));
        await b.put(`key/${19 - i}`, new Uint8Array([19 - i, 20 - i]));
    }
    assert.deepEqual(await a.exportSeed(), await b.exportSeed());
});

test('a seed of another layout version or format, or a torn one, adds nothing', async()=>{
    const seed = await (await capturedStore(createMemoryDirectory())).exportSeed();
    const otherVersion = seed.slice();
    new DataView(otherVersion.buffer).setUint32(12, STORE_VERSION + 1, true);
    const otherFormat = seed.slice();
    new DataView(otherFormat.buffer).setUint32(8, SEED_FORMAT + 1, true);
    for (const [what, bytes] of /** @type {[string, Uint8Array | null][]} */ ([
        ['another STORE_VERSION', otherVersion], ['another seed format', otherFormat],
        ['cut short', seed.subarray(0, seed.length - 1)], ['not a seed', new Uint8Array(64)],
        ['nothing', null],
    ]))
    {
        const store = await createDirectoryTranslationStore(createMemoryDirectory(), 'game');
        assert.deepEqual(await store.seed(bytes, 'x'), { taken: false, added: 0, present: 0 },
            what);
        assert.equal(await store.get(SEED_KEYS[0]), null, `${what}: no record`);
        assert.equal(await store.seededWith(), null, `${what}: not marked as taken`);
    }
});

test('a lookup made while a seed is on its way waits for it and finds its records', async()=>{
    const seed = await (await capturedStore(createMemoryDirectory())).exportSeed();
    const store = await createDirectoryTranslationStore(createMemoryDirectory(), 'game');
    /** @type {(bytes: Uint8Array) => void} */
    let arrive = ()=>{};
    store.seed(new Promise(resolve=>{
        arrive = resolve;
    }), 'late');
    let answered = false;
    const lookup = store.get(SEED_KEYS[0]).then(bytes=>{
        answered = true;
        return bytes;
    });
    await new Promise(resolve=>setTimeout(resolve, 5));
    assert.equal(answered, false, 'the lookup waits for the seed');
    arrive(seed);
    assert.deepEqual([...await lookup ?? []], [1, 2, 3]);
});

test('a record the store holds already stays as the store holds it', async()=>{
    const seed = await (await capturedStore(createMemoryDirectory())).exportSeed();
    const store = await createDirectoryTranslationStore(createMemoryDirectory(), 'game');
    await store.put(SEED_KEYS[0], new Uint8Array([4, 4]));
    assert.deepEqual(await store.seed(seed), { taken: true, added: 2, present: 1 });
    assert.deepEqual([...await store.get(SEED_KEYS[0]) ?? []], [4, 4]);
    assert.equal(await store.seededWith(), null, 'no identity, no mark');
});

test('inside a worker an open store answers a lookup at once, without a turn', async()=>{
    const counter = { probes: 0, syncReads: 0 };
    const root = fakeDirectory(counter, true);
    const first = await createDirectoryTranslationStore(root, 'bundle');
    await first.put('cork/1/a', new Uint8Array([1, 2, 3]));
    await first.flush();
    first.close();
    const store = await createDirectoryTranslationStore(root, 'bundle');
    assert.equal(store.getNow('cork/1/a'), undefined, 'not open yet: asking starts the opening');
    await store.prepare();
    const reads = counter.syncReads;
    assert.deepEqual([...store.getNow('cork/1/a') ?? []], [1, 2, 3]);
    assert.equal(counter.syncReads, reads + 1, 'one read at the record\'s offset');
    assert.equal(store.getNow('cork/1/b'), null, 'a miss reads nothing');
    assert.equal(counter.syncReads, reads + 1);
    await store.close();
    assert.equal(store.getNow('cork/1/a'), undefined, 'the handle let go of');
    assert.deepEqual([...await store.get('cork/1/a') ?? []], [1, 2, 3], 'get still answers');
});

test('a page\'s store, with no synchronous handle, answers only through get', async()=>{
    const root = fakeDirectory();
    const store = await createDirectoryTranslationStore(root, 'bundle');
    await store.put('cork/1/a', new Uint8Array([5]));
    await store.prepare();
    assert.equal(store.getNow('cork/1/a'), undefined);
    assert.deepEqual([...await store.get('cork/1/a') ?? []], [5]);
});

test('a page\'s store opens one stream for the puts that arrive while one is queued', async()=>{
    // Each stream copies the whole records file: one per put made a run's
    // thousands of regions a copy of a growing file each.
    const root = fakeDirectory();
    const store = await createDirectoryTranslationStore(root, 'bundle');
    await store.prepare();
    const before = root.counter.writables ?? 0;
    const COUNT = 64;
    await Promise.all(Array.from({ length: COUNT },
        (_, i)=>store.put(`cork/1/many/${i}`, new Uint8Array([i, 255 - i]))));
    await store.flush();
    const bundle = root.children.get('cork').children.get(`bundle.v${STORE_VERSION}`);
    const records = bundle.children.get('records') ?? bundle.children.get('records.1');
    assert.equal(records.bytes.length, COUNT * 3,
        'every record landed, each after its frame\'s byte');
    // The index takes its own streams; the records take one for the batch.
    assert.ok((root.counter.writables ?? 0) - before <= 4,
        `${(root.counter.writables ?? 0) - before} streams for ${COUNT} puts`);
    const reopened = await createDirectoryTranslationStore(root, 'bundle');
    for (let i = 0; i < COUNT; i++)
    {
        assert.deepEqual([...await reopened.get(`cork/1/many/${i}`) ?? []], [i, 255 - i]);
    }
});

test('while a seed is on its way a lookup is not answered at once', async()=>{
    const seed = await (await capturedStore(createMemoryDirectory())).exportSeed();
    const store = await createDirectoryTranslationStore(createMemoryDirectory(), 'game');
    await store.prepare();
    assert.equal(store.getNow(SEED_KEYS[0]), null, 'open and empty: a miss at once');
    /** @type {(bytes: Uint8Array) => void} */
    let arrive = ()=>{};
    const taking = store.seed(new Promise(resolve=>{
        arrive = resolve;
    }), 'late');
    assert.equal(store.getNow(SEED_KEYS[0]), undefined, 'the seed may bring it');
    arrive(seed);
    await taking;
    assert.deepEqual([...store.getNow(SEED_KEYS[0]) ?? []], [1, 2, 3]);
});

test('a large seed is written a few milliseconds at a time, the thread let go between', async()=>{
    // A bundle's seed is thousands of records, taken in on the engine's own
    // thread while the program loads. Written in one go it held that thread
    // for hundreds of milliseconds -- a sound mixer in the guest missed its
    // turns and the device replayed its last lap.
    const source = await createDirectoryTranslationStore(createMemoryDirectory(), 'game');
    for (let at = 0; at < 64; at++)
    {
        const key = `cork/41/a/${(0x401000 + at * 16).toString(16)}/x`;
        await source.put(key, new Uint8Array(40).fill(at));
    }
    await source.flush();
    const seed = await source.exportSeed();
    const counter = { probes: 0, syncReads: 0, writes: 0, writeMs: 1 };
    const store = await createDirectoryTranslationStore(fakeDirectory(counter, true), 'game');
    /** @type {number | null} */
    let writesAtTurn = null;
    setTimeout(()=>{
        writesAtTurn = counter.writes;
    }, 0);
    const taken = await store.seed(seed, 'id');
    assert.equal(taken.added, 64);
    assert.ok(writesAtTurn !== null && writesAtTurn < 64,
        `the thread had a turn before the last record was written (${writesAtTurn})`);
    assert.deepEqual([...await store.get('cork/41/a/401010/x') ?? []], new Array(40).fill(1));
});

test('a record of megabytes is written in pieces, the thread let go between, and reads whole',
    async()=>{
        // A relinked module is a record of megabytes: written whole it held
        // the engine's thread for a dozen milliseconds in one write.
        const counter = { probes: 0, syncReads: 0, writes: 0, writeMs: 1, largest: 0 };
        const store = await createDirectoryTranslationStore(fakeDirectory(counter, true), 'game');
        await store.get('cork/41/a/none');
        const bytes = Uint8Array.from({ length: 5 << 20 }, (_, at)=>(at * 7) >>> 3);
        let turned = false;
        setTimeout(()=>{
            turned = true;
        }, 0);
        const put = store.put('cork/41/a/module/m', bytes);
        await new Promise(resolve=>setTimeout(resolve, 0));
        assert.equal(await store.get('cork/41/a/module/m'), null, 'not a record until written');
        await put;
        assert.ok(turned);
        assert.ok(counter.largest < bytes.length, `the largest write ${counter.largest} bytes`);
        await store.flush();
        assert.deepEqual(await store.get('cork/41/a/module/m'), bytes);
        store.close();
    });

test('a store whose files fail it answers and keeps nothing rather than throwing', async()=>{
    // Another user of the directory compacting it removed the generation this
    // one read, and the engine did not start: a cache that cannot be read is
    // a run without one.
    const root = createMemoryDirectory();
    const gone = Object.assign(new Error('A requested file or directory could not be found'),
        { name: 'NotFoundError' });
    /** @param {any} directory @returns {any} */
    const failingRecords = directory=>({
        ...directory,
        getDirectoryHandle: async(/** @type {string} */ name, /** @type {any} */ options)=>
            failingRecords(await directory.getDirectoryHandle(name, options)),
        getFileHandle: async(/** @type {string} */ name, /** @type {any} */ options)=>{
            if (name.startsWith('records'))
            {
                throw gone;
            }
            return directory.getFileHandle(name, options);
        },
    });
    const store = await createDirectoryTranslationStore(failingRecords(root), 'game');
    assert.equal(await store.get('0123456789abcdef'), null);
    await store.put('0123456789abcdef', Uint8Array.of(1, 2, 3));
    assert.equal(await store.get('0123456789abcdef'), null, 'nothing kept');
    assert.equal(store.getNow?.('0123456789abcdef'), null);
});

/**
 * A records writer as the store's worker is, but in this thread: its own handle on the
 * file, its writes made when the test lets them go (`release`) -- the disk taking its
 * time while the store's thread goes on.
 */
function heldWriter(){
    /** @type {{ go: () => void, fail: () => void }[]} */
    const held = [];
    let holding = true;
    let closed = false;
    /** @type {any} */
    let handle = null;
    const state = { writes: 0, appends: 0 };
    /** @param {() => void} run @returns {Promise<void>} */
    const later = run=>new Promise((resolve, reject)=>{
        const go = ()=>{
            try
            {
                run();
                resolve();
            }
            catch (e){
                reject(e);
            }
        };
        if (closed)
        {
            reject(new Error('the records writer was closed'));
        }
        else if (holding)
        {
            held.push({ go, fail: ()=>reject(new Error('the records writer was closed')) });
        }
        else
        {
            queueMicrotask(go);
        }
    });
    return {
        state,
        release(){
            holding = false;
            for (const { go } of held.splice(0))
            {
                go();
            }
        },
        /** @returns {import('./translation-store.js').RecordsWriter} */
        factory: ()=>({
            open: async(/** @type {any} */ file)=>{
                handle = await file.createSyncAccessHandle();
                return true;
            },
            write: writes=>{
                // As to the worker, the records' buffers go across.
                /** @type {[number, Uint8Array][]} */
                const taken = structuredClone(writes,
                    { transfer: [...new Set(writes.map(([, bytes])=>bytes.buffer))] });
                return later(()=>{
                    for (const [at, bytes] of taken)
                    {
                        handle.write(bytes, { at });
                        state.writes++;
                    }
                });
            },
            flush: ()=>later(()=>handle.flush()),
            // The index's lines, on a handle of the writer's own for the one write.
            append: async(/** @type {any} */ file, at, bytes)=>{
                const index = await file.createSyncAccessHandle();
                index.write(bytes, { at });
                index.flush();
                index.close();
                state.appends++;
            },
            // As a worker that ends: what it held is never written.
            close: ()=>{
                closed = true;
                for (const { fail } of held.splice(0))
                {
                    fail();
                }
                handle?.close();
            },
        }),
    };
}

test('with a records writer the store\'s own thread writes no record, found once written',
    async()=>{
        const counter = { probes: 0, syncReads: 0, writes: 0 };
        const root = fakeDirectory(counter, true);
        const writer = heldWriter();
        const store = await createDirectoryTranslationStore(root, 'game', undefined,
            { writer: writer.factory });
        await store.get('cork/41/a/none');
        const bytes = Uint8Array.from({ length: 1 << 20 }, (_, at)=>(at * 13) >>> 2);
        const before = counter.writes;
        const put = store.put('cork/41/a/module/m', bytes.slice());
        await new Promise(resolve=>setTimeout(resolve, 0));
        assert.equal(counter.writes, before, 'nothing written on the store\'s thread');
        assert.equal(store.getNow('cork/41/a/module/m'), null, 'not a record until written');
        writer.release();
        await put;
        assert.ok(writer.state.writes > 0, 'the writer wrote it');
        assert.deepEqual(store.getNow('cork/41/a/module/m'), bytes);
        await store.flush();
        assert.ok(writer.state.appends > 0, 'the index too, by the writer');
        store.close();
        const next = await createDirectoryTranslationStore(root, 'game');
        assert.deepEqual(await next.get('cork/41/a/module/m'), bytes, 'and the next run finds it');
    });

test('a reader with a handle of its own on the records file reads by the places the store '
    + 'names what the store reads, and none is named without a writer', async()=>{
    const root = fakeDirectory({ probes: 0, syncReads: 0, writes: 0 }, true);
    const writer = heldWriter();
    writer.release();
    const store = await createDirectoryTranslationStore(root, 'game', undefined,
        { writer: writer.factory });
    await store.get('cork/41/a/none');
    const keys = ['cork/41/a/one', 'cork/41/a/two', 'cork/41/a/grown'];
    await store.put(keys[0], Uint8Array.from({ length: 300 }, (_, at)=>at * 5));
    await store.put(keys[1], Uint8Array.from({ length: 7 }, (_, at)=>at + 1));
    await store.append(keys[2], new Uint8Array([9, 8]));
    await store.append(keys[2], new Uint8Array([7]));
    const file = store.recordsFile();
    assert.ok(file !== null, 'the file, the store\'s handle standing beside others');
    const own = await file.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
    for (const key of keys)
    {
        const pieces = store.placeOf(key);
        assert.ok(Array.isArray(pieces), key);
        const framed = readPieces(own, /** @type {[number, number][]} */ (pieces));
        assert.deepEqual(framed === null ? null : unframe(framed), store.getNow(key), key);
    }
    assert.equal(store.placeOf('cork/41/a/never'), null);
    // Without a writer the store's handle is the file's only one.
    const alone = await createDirectoryTranslationStore(fakeDirectory(undefined, true), 'game',
        undefined, { writer: ()=>null });
    await alone.get('cork/41/a/none');
    assert.equal(alone.recordsFile(), null);
});

test('a record is handed to the writer framed, the caller\'s buffer left with it', async()=>{
    const root = fakeDirectory({ probes: 0, syncReads: 0, writes: 0 }, true);
    const writer = heldWriter();
    writer.release();
    const store = await createDirectoryTranslationStore(root, 'game', undefined,
        { writer: writer.factory });
    await store.get('cork/41/a/none');
    const whole = Uint8Array.from({ length: 5000 }, (_, at)=>at * 7);
    const expected = whole.slice();
    const larger = Uint8Array.from({ length: 300 }, (_, at)=>at * 3);
    const inside = larger.subarray(100, 200);
    await store.put('cork/41/a/whole', whole);
    await store.put('cork/41/a/inside', inside);
    // What goes across is the frame (`record-frame.js`), a buffer of the store's own.
    assert.equal(whole.byteLength, 5000, 'the caller\'s buffer stays with it');
    assert.equal(larger.byteLength, 300, 'the larger buffer stays with its owner');
    assert.deepEqual(store.getNow('cork/41/a/whole'), expected);
    assert.deepEqual(store.getNow('cork/41/a/inside'), larger.slice(100, 200));
});

test('a writer that cannot stand beside the store\'s handle leaves the writes to the store',
    async()=>{
        const counter = { probes: 0, syncReads: 0, writes: 0 };
        const store = await createDirectoryTranslationStore(fakeDirectory(counter, true), 'game',
            undefined, { writer: ()=>({ open: async()=>false, write: async()=>{
                throw new Error('not this writer');
            }, flush: async()=>{}, close: ()=>{} }) });
        await store.get('cork/41/a/none');
        await store.put('cork/41/a/x', new Uint8Array([1, 2, 3]));
        assert.deepEqual([...store.getNow('cork/41/a/x') ?? []], [1, 2, 3]);
    });

/**
 * The origin's file system as a worker has it, whose records file refuses a
 * synchronous handle -- always, or only one asked for in a shared mode -- and
 * counts the streams opened on it.
 *
 * @param {'always' | 'shared'} refuses
 */
const refusingDirectory = refuses=>{
    const streams = { opened: 0 };
    const wrap = (/** @type {any} */ directory)=>({
        ...directory,
        getDirectoryHandle: async(/** @type {string} */ name, /** @type {any} */ options)=>
            wrap(await directory.getDirectoryHandle(name, options)),
        getFileHandle: async(/** @type {string} */ name, /** @type {any} */ options)=>{
            const handle = await directory.getFileHandle(name, options);
            if (!name.startsWith('records'))
            {
                return handle;
            }
            return {
                ...handle,
                createSyncAccessHandle: async(/** @type {any} */ asked)=>{
                    if (refuses === 'always' || asked?.mode !== undefined)
                    {
                        throw new DOMException('refused', 'NoModificationAllowedError');
                    }
                    return handle.createSyncAccessHandle();
                },
                createWritable: async()=>{
                    streams.opened++;
                    throw new Error('a stream copies the whole records file');
                },
            };
        },
    });
    return { root: wrap(createMemoryDirectory()), streams };
};

test('a worker holds the records file alone where a shared handle is refused, and never'
    + ' writes it through a stream', async()=>{
    const writer = { closed: 0 };
    const shared = refusingDirectory('shared');
    const store = await createDirectoryTranslationStore(shared.root, 'game', undefined,
        { writer: ()=>({ open: async()=>true, write: async()=>{
            throw new Error('not this writer');
        }, flush: async()=>{}, close: ()=>{
            writer.closed++;
        } }) });
    await store.put('cork/41/a/x', new Uint8Array([1, 2, 3]));
    assert.deepEqual([...store.getNow('cork/41/a/x') ?? []], [1, 2, 3], 'written alone');
    assert.equal(writer.closed, 1, 'the writer let go');
    assert.equal(shared.streams.opened, 0);

    const refused = refusingDirectory('always');
    const without = await createDirectoryTranslationStore(refused.root, 'game', undefined,
        { writer: ()=>null });
    await without.put('cork/41/a/x', new Uint8Array([1, 2, 3]));
    assert.equal(await without.get('cork/41/a/x'), null, 'no cache rather than a copy a put');
    assert.equal(refused.streams.opened, 0);
    assert.equal(without.stats().broken, true);
});

/**
 * A record as its length and an FNV-1a hash of its bytes, or what stood for it.
 *
 * @param {Uint8Array | null | undefined} bytes
 */
const digest = bytes=>{
    if (!(bytes instanceof Uint8Array))
    {
        return String(bytes);
    }
    let hash = 0x811c9dc5;
    for (const byte of bytes)
    {
        hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
    return `${bytes.length}:${hash.toString(16)}`;
};

test('a key put twice answers its last put\'s bytes though the first one\'s write ends last',
    async()=>{
        // A writer that finishes the writes it is given in the order opposite to it.
        /** @type {(() => void)[]} */
        const waiting = [];
        let handle = /** @type {any} */ (null);
        const root = fakeDirectory({ probes: 0, syncReads: 0 }, true);
        const store = await createDirectoryTranslationStore(root, 'game', undefined, {
            writer: ()=>({
                open: async(/** @type {any} */ file)=>{
                    handle = await file.createSyncAccessHandle();
                    return true;
                },
                write: writes=>new Promise(resolve=>{
                    waiting.push(()=>{
                        for (const [at, bytes] of writes)
                        {
                            handle.write(bytes, { at });
                        }
                        resolve();
                    });
                }),
                flush: async()=>handle.flush(),
                close: ()=>handle?.close(),
            }),
        });
        await store.get('cork/41/a/none');
        const first = Uint8Array.from({ length: 300 }, (_, i)=>i & 0xff);
        const second = Uint8Array.from({ length: 200 }, (_, i)=>0xff - (i & 0xff));
        const puts = [store.put('cork/41/a/1/x', first.slice()),
            store.put('cork/41/a/1/x', second.slice())];
        while (waiting.length < 2)
        {
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
        /** @type {() => void} */ (waiting.pop())();
        await new Promise(resolve=>setTimeout(resolve, 0));
        /** @type {() => void} */ (waiting.pop())();
        await Promise.all(puts);
        await store.flush();
        assert.equal(digest(store.getNow('cork/41/a/1/x')), digest(second));
        store.close();
        const reopened = await createDirectoryTranslationStore(root, 'game', undefined,
            { writer: ()=>null });
        assert.equal(digest(await reopened.get('cork/41/a/1/x')), digest(second),
            'and so does the index the next opening reads');
    });

// The gate of the writer: a seeded run of puts, through the writer and through the store's
// own handle, leaves the same records, the same seed and what the next opening finds.
for (const seed of [5, 6, 7])
{
    test(`a store written through its writer holds what one writing itself holds (seed ${seed})`,
        async()=>{
            let state = seed >>> 0;
            const next = ()=>{
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                return state / 4294967296;
            };
            /** @type {[string, Uint8Array][]} */
            const puts = [];
            for (let i = 0; i < 60; i++)
            {
                const key = `cork/41/a/${Math.floor(next() * 40).toString(16)}/x`;
                const length = 1 + Math.floor(next() * (next() < 0.1 ? 600_000 : 3000));
                puts.push([key, Uint8Array.from({ length }, ()=>Math.floor(next() * 256))]);
            }
            // Keys come again (sixty puts of forty names): each answers its last.
            /** @type {Map<string, Uint8Array>} */
            const last = new Map(puts);
            const lastPuts = puts.map(([key])=>last.get(key));
            /** @param {(() => any) | undefined} writer */
            const fill = async writer=>{
                const root = fakeDirectory({ probes: 0, syncReads: 0 }, true);
                const held = writer === undefined ? null : heldWriter();
                held?.release();
                const store = await createDirectoryTranslationStore(root, 'game', undefined,
                    held === null ? { writer: ()=>null } : { writer: held.factory });
                await store.get('cork/41/a/none');
                await Promise.all(puts.map(([key, bytes])=>store.put(key, bytes.slice())));
                await store.flush();
                const found = puts.map(([key])=>store.getNow(key));
                const exported = await store.exportSeed();
                store.close();
                const reopened = await createDirectoryTranslationStore(root, 'game',
                    undefined, { writer: ()=>null });
                const again = await Promise.all(puts.map(([key])=>reopened.get(key)));
                return { found, exported, again, wrote: held?.state.writes ?? 0 };
            };
            const itself = await fill(undefined);
            const through = await fill(()=>null);
            assert.ok(through.wrote > 0, 'the writer wrote the records');
            // Compared by a digest of each record: a deepEqual of records up to
            // 600 KB that differ builds a message of gigabytes.
            assert.deepEqual(through.found.map(digest), itself.found.map(digest));
            assert.deepEqual(digest(through.exported), digest(itself.exported));
            assert.deepEqual(through.again.map(digest), itself.again.map(digest));
            assert.deepEqual(itself.found.map(digest), lastPuts.map(digest),
                'a key answers the bytes of its last put');
        });
}

test('clearing a bundle\'s translations removes every version of them and no other bundle\'s',
    async()=>{
        const root = fakeDirectory();
        const store = await createDirectoryTranslationStore(root, 'bundle');
        await store.put('cork/1/a', new Uint8Array([1, 2, 3]));
        await store.flush();
        store.close();
        const cork = await root.getDirectoryHandle('cork', { create: true });
        await cork.getDirectoryHandle('bundle.v1', { create: true });
        await cork.getDirectoryHandle('other.v3', { create: true });

        assert.equal(await clearTranslations('bundle', root), 2);
        assert.ok(cork.children.has('other.v3'), 'another bundle\'s stands');
        const reopened = await createDirectoryTranslationStore(root, 'bundle');
        assert.equal(await reopened.get('cork/1/a'), null, 'the next start translates afresh');
        assert.equal(await clearTranslations('none', fakeDirectory()), 0,
            'nothing kept, nothing gone');
    });

test('a record two runs left unused is dead, and a quarter of the file dead is worth a copy',
    async()=>{
        // A game's store had grown to 1.4 GB: a third of it regions translated
        // ahead whose entry never ran, which no later run asks for, kept four runs.
        const root = fakeDirectory();
        for (const name of ['a', 'b', 'c'])
        {
            const store = await createDirectoryTranslationStore(root, 'bundle');
            await store.put(name, new Uint8Array(10));
            await store.close();
        }
        const store = await createDirectoryTranslationStore(root, 'bundle');
        await store.get('c');
        assert.deepEqual([store.stats().opened.records, store.stats().opened.kept], [3, 2],
            'the first run\'s record, unused by the two after it, is not kept');
        await store.close();
        const later = fakeDirectory();
        const keepAll = { keepSessions: 100, compactFloor: 0, cap: 1 << 20 };
        const old = await createDirectoryTranslationStore(later, 'bundle', keepAll);
        for (let i = 0; i < 3; i++)
        {
            await old.put(`dead${i}`, new Uint8Array(10));
        }
        await old.close();
        const live = await createDirectoryTranslationStore(later, 'bundle', keepAll);
        for (let i = 0; i < 6; i++)
        {
            await live.put(`live${i}`, new Uint8Array(10));
        }
        await live.close();
        const reopened = await createDirectoryTranslationStore(later, 'bundle', { keepSessions: 1,
            compactFloor: 0, cap: 1 << 20 });
        await reopened.get('live0');
        const opened = reopened.stats().opened;
        assert.deepEqual([opened.records, opened.kept, opened.compacted], [9, 6, true],
            'three tenths dead: copied');
    });

test('a record its run forgets is gone at the next opening, its module with its last region',
    async()=>{
        const root = fakeDirectory();
        const first = await createDirectoryTranslationStore(root, 'bundle');
        await first.put('module/m', new Uint8Array(40).fill(7));
        await first.put('region/kept', new Uint8Array([1]), { needs: 'module/m' });
        await first.put('module/n', new Uint8Array(40).fill(8));
        await first.put('region/never', new Uint8Array([2]), { needs: 'module/n' });
        first.forget('region/never');
        first.forget('region/missing');
        await first.close();
        const second = await createDirectoryTranslationStore(root, 'bundle');
        assert.equal((await second.get('region/kept'))?.[0], 1);
        assert.equal((await second.get('module/m'))?.[0], 7);
        assert.equal(await second.get('region/never'), null, 'forgotten');
        assert.equal(second.stats().opened.kept, 2, 'its module goes with it');
        await second.put('region/never', new Uint8Array([3]));
        await second.close();
        const third = await createDirectoryTranslationStore(root, 'bundle');
        assert.equal((await third.get('region/never'))?.[0], 3, 'written again, it is back');
    });
