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
        const bundle = root.children.get('cork').children.get('my_game_1.0.v2');
        assert.ok(bundle.children.has('records'), 'one records file');
        assert.match(fileNameOf('anything'), /^[0-9a-f]{16}\.cork$/);
        assert.notEqual(fileNameOf('a'), fileNameOf('b'));
        // The index names the record's place: name, offset, length.
        assert.equal(await indexOf(root, 'my_game_1.0'),
            `${fileNameOf('cork/1/x/401000/abc')} 0 3\n`);
        // A miss touches the file system for nothing: the index answers it.
        const probes = root.counter.probes;
        assert.equal(await store.get('cork/1/x/999/zzz'), null);
        assert.equal(root.counter.probes, probes, 'a miss probes no file');
        // Overwritten by an append: the index points at the new bytes.
        await store.put('cork/1/x/401000/abc', new Uint8Array([1]));
        assert.deepEqual([...(await store.get('cork/1/x/401000/abc') ?? [])], [1]);
        assert.equal(await indexOf(root, 'my_game_1.0'),
            `${fileNameOf('cork/1/x/401000/abc')} 0 3\n${fileNameOf('cork/1/x/401000/abc')} 3 1\n`,
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
    assert.equal((await indexOf(root, 'bundle')).trim().split('\n').length, COUNT);
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
