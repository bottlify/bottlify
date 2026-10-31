/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * install.js: the files depots leave, their chunks downloaded, and an install
 * into a bundle written in place -- over depots made up here and served as
 * SteamPipe serves them (depot.fixture.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contentServer, fakeDepot, memoryFile, noise } from './depot.fixture.js';
import { comparePaths, downloadFiles, installBundle, installedFiles } from './install.js';
import { manifest } from './depot.js';
import { Codec, openBundle } from '../layers/filesystem/internal/bundle/format.js';

const SERVERS = ['a.example', 'b.example', 'c.example']
    .map(host=>({ host, vhost: host, type: 'CDN' }));

/** @param {string} name @param {number} size @param {number} [seed] */
const file = (name, size, seed = name.length)=>({ name, bytes: noise(size, seed) });

/** Every file of a bundle held in memory, by path. @param {Uint8Array} container */
async function filesOf(container){
    /** @param {number} at @param {number} length */
    const fetchRange = async(at, length)=>container.slice(at, at + length);
    const bundle = await openBundle(fetchRange, (codec, bytes)=>{
        assert.equal(codec, Codec.STORED);
        return bytes;
    });
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    for (const one of bundle.files)
    {
        const bytes = new Uint8Array(one.size);
        for (const { block, from, to } of bundle.rangesFor(one, 0, one.size))
        {
            const stored = container.subarray(block.offset, block.offset + block.packed);
            const at = (block.index - one.firstBlock) * bundle.blockSize;
            bytes.set(stored.subarray(from, to), at + from);
        }
        assert.equal(createHash('sha256').update(bytes).digest('hex'), one.sha256, one.path);
        files.set(one.path, bytes);
    }
    return { files, directories: bundle.directories, bundle };
}

test('the files depots leave: a later depot\'s path over an earlier\'s, spelt as first written',
    ()=>{
        /** @param {number} depot @param {any[]} files */
        const listed = (depot, files)=>({ key: new Uint8Array(32), manifest: { depot, gid: 1n,
            created: 0, size: 0, files: files.map(one=>({ size: 0, flags: 0, sha: new Uint8Array(0),
                chunks: [], ...one })) } });
        const { files, directories } = installedFiles([
            listed(1, [{ name: 'Data\\a.pak', size: 1 }, { name: 'Data', flags: 0x40 },
                { name: 'Saves', flags: 0x40 }, { name: 'Links', flags: 0x40 },
                { name: 'Links\\here', link: 'elsewhere' }, { name: 'b.exe', size: 2 }]),
            listed(2, [{ name: 'DATA\\A.PAK', size: 3 }, { name: 'data/z.txt', size: 4 },
                { name: 'Data.txt', size: 5 }]),
        ]);
        assert.deepEqual(files.map(one=>[one.path, one.size, one.depot]), [
            ['Data\\a.pak', 3, 2], ['Data\\z.txt', 4, 2], ['Data.txt', 5, 2], ['b.exe', 2, 1],
        ]);
        assert.deepEqual(directories, ['Saves'], 'a folder with a link in it is not empty');
        assert.deepEqual(['b', 'a\\c', 'a.x', 'B', 'a'].sort(comparePaths),
            ['B', 'a', 'a\\c', 'a.x', 'b']);
    });

test('a chunk a server will not give is asked of the next; one no server gives fails the download',
    async t=>{
        const depot = fakeDepot({ depot: 5, gid: 6n, files: [file('f', 200_000)],
            chunkSize: 50_000 });
        const served = contentServer([depot], { fail: ['a.example'] });
        t.mock.method(globalThis, 'fetch', served.fetch);
        const files = installedFiles([{ key: depot.key,
            manifest: await manifest(SERVERS[1], depot) }]).files;
        const out = new Uint8Array(200_000);
        await downloadFiles({ files, servers: SERVERS, jobs: 3, done: task=>task === 1,
            write: (_, chunk, bytes)=>out.set(bytes, chunk.offset) });
        assert.equal(served.asked.chunks, 3, 'the chunk already in place is not asked for');
        const whole = noise(200_000, 1);
        assert.deepEqual(out.subarray(0, 50_000), whole.subarray(0, 50_000));
        assert.deepEqual(out.subarray(50_000, 100_000), new Uint8Array(50_000));
        assert.deepEqual(out.subarray(100_000), whole.subarray(100_000));

        const nowhere = contentServer([depot], { fail: SERVERS.map(server=>server.host) });
        t.mock.method(globalThis, 'fetch', nowhere.fetch);
        await assert.rejects(downloadFiles({ files, servers: SERVERS, write: ()=>{} }), /answered 503/);
        const stop = new AbortController();
        stop.abort();
        await assert.rejects(downloadFiles({ files, servers: SERVERS, write: ()=>{},
            signal: stop.signal }), { name: 'AbortError' });
    });

/** An app of two depots and a redistributable's, as an install takes them. */
function app(){
    const script = new TextEncoder().encode(String.raw`"InstallScript"
{ "Registry" { "HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor" { "string" { "Dir" "%INSTALLDIR%" } } } }`);
    const depots = [
        fakeDepot({ depot: 101, gid: 1n, chunkSize: 40_000, files: [
            file('Game.exe', 90_000), file('data\\level1.pak', 300_000, 9),
            { name: 'empty', directory: true }, file('data\\zero.bin', 0),
            { name: 'install.vdf', bytes: script },
        ] }),
        fakeDepot({ depot: 102, gid: 2n, files: [file('DATA\\level1.pak', 120_000, 4)] }),
        fakeDepot({ depot: 228990, gid: 3n, shared: true, files: [
            file('_CommonRedist\\DirectX\\Jun2010\\DXSETUP.exe', 1000),
            { name: '_CommonRedist\\DirectX\\Jun2010\\installscript.vdf', bytes: new TextEncoder()
                .encode(String.raw`"InstallScript" { "Registry" { "HKEY_LOCAL_MACHINE\\SOFTWARE\\DX"
                { "dword" { "Installed" "1" } } } }`) },
        ] }),
    ];
    return depots;
}

test('an install into a bundle in place: every file, the redistributables, the entry', async t=>{
    const depots = app();
    const served = contentServer(depots);
    t.mock.method(globalThis, 'fetch', served.fetch);
    const handle = memoryFile();
    /** @type {string[]} */
    const stages = [];
    const { bundle, entry, said } = await installBundle({ handle, depots, servers: SERVERS,
        installscript: 'install.vdf', executable: 'game.exe',
        onProgress: ({ stage })=>stages.at(-1) !== stage && stages.push(stage) });
    assert.deepEqual(stages, ['downloading', 'finishing']);
    const { files, directories } = await filesOf(handle.bytes());
    assert.deepEqual([...files.keys()], [
        '.bottlify\\registry.json', 'Game.exe', '_CommonRedist\\DirectX\\Jun2010\\DXSETUP.exe',
        '_CommonRedist\\DirectX\\Jun2010\\installscript.vdf', 'data\\level1.pak', 'data\\zero.bin',
        'install.vdf',
    ]);
    assert.deepEqual(files.get('data\\level1.pak'), noise(120_000, 4), 'the later depot\'s');
    assert.deepEqual(files.get('Game.exe'), noise(90_000, 8));
    assert.deepEqual(entry, noise(90_000, 8));
    assert.deepEqual(directories, ['empty']);
    const hive = JSON.parse(new TextDecoder().decode(files.get('.bottlify\\registry.json')));
    assert.deepEqual(hive.roots[0].key.keys[0].keys.map((/** @type {any} */ key)=>key.name),
        ['Vendor', 'DX']);
    assert.equal(said.at(-1), 'redistributables: 0 file(s), 2 registry value(s)');
    assert.equal(bundle.files, 7);
    assert.equal(bundle.bytes, handle.getSize());
});

test('an install stopped part way goes on from what it saved; a new manifest starts it over',
    async t=>{
        const depots = app();
        const served = contentServer(depots);
        t.mock.method(globalThis, 'fetch', served.fetch);
        const whole = memoryFile();
        await installBundle({ handle: whole, depots, servers: SERVERS });
        const every = served.asked.chunks;

        const handle = memoryFile();
        /** @type {import('./install.js').InstallProgress | null} */
        let saved = null;
        const stop = new AbortController();
        let landed = 0;
        await assert.rejects(installBundle({ handle, depots, servers: SERVERS, jobs: 1,
            signal: stop.signal,
            onSave: progress=>{
                saved = { stamp: progress.stamp, done: progress.done.slice() };
            },
            onProgress: ({ done })=>{
                if (done > 0 && ++landed === 4)
                {
                    stop.abort();
                }
            } }), { name: 'AbortError' });
        assert.equal(served.asked.chunks - every, 4);
        assert.ok(saved, 'what was done is saved as the run stops');
        await installBundle({ handle, depots, servers: SERVERS, resume: saved });
        assert.equal(served.asked.chunks - every, every, 'each chunk once across the two runs');
        assert.deepEqual(handle.bytes(), whole.bytes(), 'the bundle a run never stopped makes');

        // Another build of a depot: what was saved is the old one's.
        const changed = app().map(one=>(one.depot === 102 ? fakeDepot({ depot: 102, gid: 22n,
            files: [file('DATA\\level1.pak', 120_000, 5)] }) : one));
        const rebuilt = contentServer(changed);
        t.mock.method(globalThis, 'fetch', rebuilt.fetch);
        await installBundle({ handle, depots: changed, servers: SERVERS, resume: saved });
        assert.equal(rebuilt.asked.chunks, every, 'every chunk again');
        assert.deepEqual((await filesOf(handle.bytes())).files.get('data\\level1.pak'),
            noise(120_000, 5));
    });
