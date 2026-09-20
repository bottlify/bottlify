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
function fakeDirectory(){
    /** @type {Map<string, any>} */
    const entries = new Map();
    return {
        entries,
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getDirectoryHandle(name, options = {}){
            let child = entries.get(name);
            if (!child)
            {
                if (!options.create)
                {
                    throw new Error('NotFoundError');
                }
                child = fakeDirectory();
                entries.set(name, child);
            }
            return child;
        },
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getFileHandle(name, options = {}){
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
    const bundle = cork.entries.get('my_game_1.0');
    assert.ok(bundle.entries.has(fileNameOf('cork/1/x/401000/abc')));
    assert.match(fileNameOf('anything'), /^[0-9a-f]{16}\.cork$/);
    assert.notEqual(fileNameOf('a'), fileNameOf('b'));
    // Overwritten in place.
    await store.put('cork/1/x/401000/abc', new Uint8Array([1]));
    assert.deepEqual([...(await store.get('cork/1/x/401000/abc') ?? [])], [1]);
});

test('the request resolves to nothing without the API, to itself as an object', async()=>{
    assert.equal(await resolveTranslationStore(null, 'x'), null);
    assert.equal(await resolveTranslationStore(undefined, 'x'), null);
    assert.equal(await resolveTranslationStore('local', 'x'), null, 'no origin file system here');
    const own = { get: async()=>null, put: async()=>{} };
    assert.equal(await resolveTranslationStore(own, 'x'), own);
});
