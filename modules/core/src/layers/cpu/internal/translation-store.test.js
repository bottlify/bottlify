/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createDirectoryTranslationStore, fileNameOf, resolveTranslationStore,
} from './translation-store.js';

/** A directory handle in memory, with the shape the store uses. */
function fakeDirectory(counter = { probes: 0 }){
    /** @type {Map<string, any>} */
    const entries = new Map();
    return {
        entries,
        counter,
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getDirectoryHandle(name, options = {}){
            let child = entries.get(name);
            if (!child)
            {
                if (!options.create)
                {
                    throw new Error('NotFoundError');
                }
                child = fakeDirectory(counter);
                entries.set(name, child);
            }
            return child;
        },
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getFileHandle(name, options = {}){
            counter.probes++;
            let file = entries.get(name);
            if (!file)
            {
                if (!options.create)
                {
                    throw new Error('NotFoundError');
                }
                file = {
                    bytes: new Uint8Array(0),
                    async getFile(){
                        const bytes = file.bytes;
                        return { arrayBuffer: async()=>bytes.buffer.slice(
                            bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
                    },
                    async createWritable(){
                        return {
                            /** @param {Uint8Array} b */
                            async write(b){
                                file.bytes = new Uint8Array(b);
                            },
                            async close(){},
                        };
                    },
                };
                entries.set(name, file);
            }
            return file;
        },
    };
}

test('a record goes into the bundle\'s directory under a name hashed from its key', async()=>{
    const root = fakeDirectory();
    const store = await createDirectoryTranslationStore(root, 'my game/1.0');
    assert.equal(await store.get('cork/1/x/401000/abc'), null);
    await store.put('cork/1/x/401000/abc', new Uint8Array([7, 8, 9]));
    assert.deepEqual([...(await store.get('cork/1/x/401000/abc') ?? [])], [7, 8, 9]);
    const cork = root.entries.get('cork');
    const bundle = cork.entries.get('my_game_1.0.v1');
    assert.ok(bundle.entries.has(fileNameOf('cork/1/x/401000/abc')));
    assert.match(fileNameOf('anything'), /^[0-9a-f]{16}\.cork$/);
    assert.notEqual(fileNameOf('a'), fileNameOf('b'));
    // The index lists the record name, one per line.
    const indexFile = await bundle.entries.get('index').getFile();
    const indexText = new TextDecoder().decode(new Uint8Array(await indexFile.arrayBuffer()));
    assert.equal(indexText, `${fileNameOf('cork/1/x/401000/abc')}\n`);
    // A miss touches the file system for nothing: the index answers it.
    const probes = root.counter.probes;
    assert.equal(await store.get('cork/1/x/999/zzz'), null);
    assert.equal(root.counter.probes, probes, 'a miss probes no file');
    // Overwritten in place.
    await store.put('cork/1/x/401000/abc', new Uint8Array([1]));
    assert.deepEqual([...(await store.get('cork/1/x/401000/abc') ?? [])], [1]);
    assert.equal(await store.get('cork/1/x/999/zzz'), null);
});

test('a batch of puts is indexed whole and a reopened store hits every one', async()=>{
    // The shape that lost the real route's warm run: a run's regions are put
    // in one turn, and an index built by reading a line back and rewriting
    // loses every line but one of a concurrent batch.
    const root = fakeDirectory();
    const first = await createDirectoryTranslationStore(root, 'bundle');
    const COUNT = 64;
    await Promise.all(Array.from({ length: COUNT },
        (_, i)=>first.put(`cork/1/bundle/40${i}/hash`, new Uint8Array([i, i, i]))));
    await first.flush();

    const second = await createDirectoryTranslationStore(root, 'bundle');
    let hits = 0;
    for (let i = 0; i < COUNT; i++)
    {
        if (await second.get(`cork/1/bundle/40${i}/hash`) !== null)
        {
            hits++;
        }
    }
    assert.equal(hits, COUNT, 'every record of the batch is found after a reopen');
    const bundle = root.entries.get('cork').entries.get('bundle.v1');
    const text = new TextDecoder().decode(
        new Uint8Array(await (await bundle.entries.get('index').getFile()).arrayBuffer()));
    assert.equal(text.trim().split('\n').length, COUNT, 'the index lists them all');
});

test('the request resolves to nothing without the API, to itself as an object', async()=>{
    assert.equal(await resolveTranslationStore(null, 'x'), null);
    assert.equal(await resolveTranslationStore(undefined, 'x'), null);
    assert.equal(await resolveTranslationStore('local', 'x'), null, 'no origin file system here');
    const own = { get: async()=>null, put: async()=>{} };
    assert.equal(await resolveTranslationStore(own, 'x'), own);
});
