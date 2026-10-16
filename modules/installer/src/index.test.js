/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFrom, placementOf, publish, saveBottle } from './index.js';

/** A prefix with one installed file, which is the least a bottle is made of. */
const PREFIX = {
    root: 'C:\\Game',
    files: [{ path: 'game.exe', bytes: new TextEncoder().encode('MZ') }],
    outside: [],
    entry: 'game.exe',
};

/** Answers every request as a bottle server would, and keeps what was sent. */
function server(){
    /** @type {{ url: string, body: any }[]} */
    const sent = [];
    /** @type {any} */
    const fetch = async(/** @type {string} */ url, /** @type {any} */ init)=>{
        sent.push({ url, body: init.body });
        return { ok: true, json: async()=>({ id: 'a-title', manifest: {} }), text: async()=>'' };
    };
    return { sent, endpoint: { url: 'http://bottles/', token: 'secret', fetch } };
}

test('a bottle\'s Windows travels in its manifest', async()=>{
    const { sent, endpoint } = server();
    await publish({ prefix: PREFIX, endpoint, id: 'a-title', manifest: { windows: 'win7' } });

    const finished = sent.find(request=>request.url.endsWith('/finish'));
    assert.equal(JSON.parse(finished?.body).manifest.windows, 'win7');
});

test('a Windows that is not one of the four is refused before anything is sent', async()=>{
    // The engine would refuse it when the bottle first started, which is the
    // moment furthest from anybody able to correct the manifest.
    const { sent, endpoint } = server();
    await assert.rejects(publish({ prefix: PREFIX, endpoint, id: 'a-title',
        manifest: { windows: 'win98' } }), /the choices are win2000, winxp, win7, win10/);
    assert.equal(sent.length, 0);
});

test('a bottle\'s manifest says where its installation put it', async()=>{
    const { sent, endpoint } = server();
    await publish({ prefix: PREFIX, endpoint, id: 'a-title' });

    const finished = sent.find(request=>request.url.endsWith('/finish'));
    assert.equal(JSON.parse(finished?.body).manifest.root, 'C:\\Game');
});

test('a bottle is mounted where its installation put it, and started from there', ()=>{
    // The registry the installation left names that directory, and a launcher
    // changes into it before it starts the game.
    assert.deepEqual(placementOf({ entry: 'TRON.exe',
        root: 'C:\\Program Files\\Buena Vista Interactive\\Tron 2.0 Demo' }), {
        prefix: 'Program Files\\Buena Vista Interactive\\Tron 2.0 Demo',
        imagePath: 'C:\\Program Files\\Buena Vista Interactive\\Tron 2.0 Demo\\TRON.exe',
    });
    assert.deepEqual(placementOf({ entry: 'game.exe', root: 'c:\\Games\\Game\\' }),
        { prefix: 'Games\\Game', imagePath: 'C:\\Games\\Game\\game.exe' },
        'a drive letter in either case, a trailing separator or none');
    assert.deepEqual(placementOf({ entry: 'game.exe', root: 'C:\\' }),
        { prefix: '', imagePath: 'C:\\game.exe' }, 'installed at the root');
    assert.deepEqual(placementOf({ entry: 'game.exe' }),
        { prefix: 'App', imagePath: 'C:\\App\\game.exe' }, 'a bottle that says nothing');
    assert.deepEqual(placementOf({ entry: 'game.exe', root: 'D:\\Games\\Game' }),
        { prefix: 'App', imagePath: 'C:\\App\\game.exe' },
        'a bundle is mounted on C:, whatever drive it was installed on');
});

test('what an app finished with is collected whole, system32 too, the setup left out', ()=>{
    // The engine covers its own libraries in system32 when the bottle runs, so
    // nothing there is sorted out here.
    const bytes = new TextEncoder().encode('MZ');
    const app = {
        session: { export: ()=>[
            { path: 'C:\\Install\\Setup.exe', bytes },
            { path: 'C:\\Games\\Game\\game.exe', bytes },
            { path: 'C:\\WINDOWS\\system32\\d3dx9_30.dll', bytes },
            { path: 'C:\\WINDOWS\\system32\\ddraw.dll', bytes },
        ] },
        registry: ()=>({ toJSON: ()=>({ roots: [] }) }),
    };
    const prefix = collectFrom(app, { name: 'Setup.exe', bytes });

    assert.deepEqual(prefix.files.map(file=>file.path), ['Games\\Game\\game.exe',
        'WINDOWS\\system32\\d3dx9_30.dll', 'WINDOWS\\system32\\ddraw.dll',
        '.bottlify\\registry.json']);
});

/**
 * The origin's file system as far as a bottle saved into it goes: directories
 * by name, files whose writable streams write at a position, seek and close.
 */
function fakeDirectory(){
    /** @type {Map<string, any>} */
    const entries = new Map();
    return {
        entries,
        async getDirectoryHandle(/** @type {string} */ name, { create = false } = {}){
            if (!entries.has(name) && create)
            {
                entries.set(name, fakeDirectory());
            }
            return entries.get(name);
        },
        async getFileHandle(/** @type {string} */ name, { create = false } = {}){
            if (!entries.has(name) && create)
            {
                let bytes = new Uint8Array(0);
                entries.set(name, {
                    bytes: ()=>bytes,
                    async createWritable(){
                        let next = new Uint8Array(0);
                        let at = 0;
                        /** @param {Uint8Array} data @param {number} position */
                        const put = (data, position)=>{
                            if (position + data.length > next.length)
                            {
                                const grown = new Uint8Array(position + data.length);
                                grown.set(next);
                                next = grown;
                            }
                            next.set(data, position);
                            at = position + data.length;
                        };
                        return {
                            async write(/** @type {any} */ chunk){
                                if (chunk instanceof Uint8Array)
                                {
                                    put(chunk, at);
                                }
                                else if (chunk.type === 'seek')
                                {
                                    at = chunk.position;
                                }
                                else
                                {
                                    put(chunk.data, chunk.position ?? at);
                                }
                            },
                            async close(){
                                bytes = next;
                            },
                        };
                    },
                });
            }
            return entries.get(name);
        },
    };
}

test('a bottle saved in the browser is the bundle a server would assemble, its program beside it',
    async()=>{
        // Kept in the origin's file system rather than sent: the launcher's
        // default. The container is read back by the engine's own reader.
        const { openBundle } = await import(
            '../../core/src/layers/filesystem/internal/bundle/format.js');
        const zlib = await import('node:zlib');
        const game = new Uint8Array(300_000).map((_, k)=>(k * 7) & 0xff);
        const prefix = {
            root: 'C:\\Game',
            files: [{ path: 'game.exe', bytes: game },
                { path: 'data\\level.dat', bytes: new TextEncoder().encode('level') }],
            outside: [],
            entry: 'game.exe',
        };
        const directory = fakeDirectory();
        const saved = await saveBottle({ prefix, directory: /** @type {any} */ (directory),
            id: 'a-title', manifest: { title: 'A Title', labels: ['demo'] } });
        const folder = directory.entries.get('a-title');
        const container = folder.entries.get('bundle.btl').bytes();
        assert.equal(container.length, saved.packed.bytes);
        const bundle = await openBundle(async(/** @type {number} */ offset,
            /** @type {number} */ length)=>container.subarray(offset, offset + length),
        (/** @type {number} */ codec, /** @type {Uint8Array} */ stored)=>(codec === 1
            ? new Uint8Array(zlib.inflateRawSync(stored)) : stored));
        assert.equal(bundle.find('game.exe')?.size, game.length);
        assert.equal(bundle.find('data\\level.dat')?.size, 5);
        assert.deepEqual([...folder.entries.get('entry').bytes()], [...game],
            'the program, kept beside the bottle');
        const manifest = JSON.parse(new TextDecoder().decode(
            folder.entries.get('manifest.json').bytes()));
        assert.equal(manifest.title, 'A Title');
        assert.equal(manifest.entry, 'game.exe');
        assert.equal(manifest.root, 'C:\\Game');
        assert.deepEqual(manifest.labels, ['demo']);
        assert.equal(manifest.bundle.indexSha256, saved.packed.indexSha256);

        await assert.rejects(saveBottle({ prefix: { ...prefix, entry: 'missing.exe' },
            directory: /** @type {any} */ (fakeDirectory()), id: 'b' }),
        /missing\.exe, is not among the installed files/);
    });
