/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normaliseSession, opfsSession, packSession, resolveStorage, unpackSession,
} from './storage.js';

/** @param {number} size @param {number} fill */
const bytes = (size, fill)=>new Uint8Array(size).fill(fill);

test('a session survives being packed and unpacked', async()=>{
    const files = [
        { path: 'C:\\Save\\game1.sav', bytes: bytes(4096, 0x41) },
        { path: 'C:\\Config.wtf', bytes: new Uint8Array([1, 2, 3]) },
        { path: 'C:\\empty.dat', bytes: new Uint8Array(0) },
    ];

    const back = await unpackSession(await packSession(files));
    assert.equal(back.files.length, 3);
    for (const [index, file] of files.entries())
    {
        assert.equal(back.files[index].path, file.path);
        assert.deepEqual([...back.files[index].bytes], [...file.bytes]);
    }
    assert.equal(back.registry, null, 'a bare list of files is a session with no registry');
});

test('the registry travels with the files and never becomes one of them', async()=>{
    // A program's settings and its name live in the registry as often as in a
    // file; a session that carried only the files forgot them on every start.
    const registry = { roots: [{ id: 0x80000001, key: { name: 'HKEY_CURRENT_USER', values: [
        { name: 'Player', type: 1, data: [65, 0] }], keys: [] } }] };
    const files = [{ path: 'C:\\Config.wtf', bytes: new Uint8Array([1]) }];

    const back = await unpackSession(await packSession({ files, registry }));
    assert.deepEqual(back.registry, registry);
    assert.deepEqual(back.files.map(file=>file.path), ['C:\\Config.wtf'],
        'the registry is not a file a caller could write to the volume');
    assert.deepEqual(normaliseSession(files), { files, registry: null });
    assert.deepEqual(normaliseSession(null), { files: [], registry: null });
});

test('a session in the origin file system is written whole and read back', async()=>{
    // The directory handle's interface, and nothing more of it: a file that is
    // not there is an error on open, a write is a stream that is closed.
    /** @type {Map<string, Uint8Array>} */
    const disk = new Map();
    const directory = async()=>({
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getFileHandle(name, options){
            if (!disk.has(name) && !options?.create)
            {
                throw new Error('NotFoundError');
            }
            return {
                getFile: async()=>({
                    arrayBuffer: async()=>(disk.get(name) ?? new Uint8Array(0)).buffer,
                }),
                createWritable: async()=>{
                    /** @type {Uint8Array} */
                    let written = new Uint8Array(0);
                    return {
                        /** @param {Uint8Array} chunk */
                        write: async chunk=>{ written = chunk; },
                        close: async()=>{ disk.set(name, written); },
                    };
                },
            };
        },
    });
    const store = opfsSession('a game/with:odd chars', directory);
    assert.deepEqual(await store.load(), { files: [], registry: null },
        'nothing yet, not an error');

    const session = { files: [{ path: 'C:\\save.dat', bytes: new Uint8Array([7, 7]) }],
        registry: { roots: [] } };
    await store.save(session);
    assert.deepEqual([...disk.keys()], ['a_game_with_odd_chars.session'], 'one file, a safe name');
    const back = await store.load();
    assert.deepEqual(back.registry, { roots: [] });
    assert.deepEqual([...back.files[0].bytes], [7, 7]);
});

test('a session is compressed, and as one stream', async()=>{
    // Saves and configuration are exactly the kind of data that compresses, and
    // a session travels whole -- so it is one stream rather than the blocks a
    // bundle needs, which would only cost ratio here.
    const packed = await packSession([{ path: 'C:\\big.sav', bytes: bytes(64 * 1024, 0x7a) }]);
    assert.ok(packed.length < 2000, `64 KiB of one byte packed to ${packed.length}`);
});

test('an empty session is empty, not an error', async()=>{
    assert.deepEqual(await unpackSession(new Uint8Array(0)), { files: [], registry: null });
    assert.deepEqual(await unpackSession(await packSession([])), { files: [], registry: null });
});

test('something that is not a session says so', async()=>{
    const { deflateRawSync } = await import('node:zlib');
    const nonsense = new Uint8Array(deflateRawSync(Buffer.from('hello there')));
    await assert.rejects(()=>unpackSession(nonsense), /not a packed session/);
});

test('a path with characters outside ASCII comes back intact', async()=>{
    // A save named by the user is named in whatever language they use, and the
    // frame counts bytes rather than characters.
    const files = [{ path: 'C:\\Сохранения\\игра.sav', bytes: new Uint8Array([9]) }];
    const back = await unpackSession(await packSession(files));
    assert.equal(back.files[0].path, files[0].path);
});

test('storage takes a provider, a bare function, or nothing', async()=>{
    const nothing = resolveStorage(null, 'x');
    assert.deepEqual(await nothing.load(), { files: [], registry: null });
    assert.equal(nothing.save, null, 'nothing in means nothing out');

    const loader = resolveStorage(async()=>[{ path: 'C:\\a', bytes: new Uint8Array([1]) }], 'x');
    assert.equal((await loader.load()).files.length, 1, 'a bare list is taken as the files');
    assert.equal(loader.save, null, 'a function that only loads does not save');

    /** @type {any[][]} */
    const saved = [];
    const provider = resolveStorage({
        load: async()=>[{ path: 'C:\\b', bytes: new Uint8Array([2]) }],
        /** @param {any[]} files @param {any[]} changes */
        save: (files, changes)=>saved.push([files, changes]),
    }, 'x');

    assert.equal((await provider.load())[0].path, 'C:\\b');
    provider.save?.({ files: [{ path: 'C:\\b', bytes: new Uint8Array(0) }], registry: null },
        [{ path: 'C:\\b', kind: 'written' }]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0][1][0].kind, 'written');
});

test('the local option says plainly where it does not work', async()=>{
    const local = resolveStorage('local', 'game');

    // There is no localStorage in a worker, which is where the engine runs. A
    // caller reaching for the convenient option deserves to be told why rather
    // than to find an empty session.
    if (!globalThis.localStorage)
    {
        await assert.rejects(()=>local.load(), /does not exist here/);
    }
});
