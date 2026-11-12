/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * content.js and install.js: GOG's generation-2 manifests read, a build's
 * depots chosen, chunks addressed and opened, and an install into a bundle in
 * place -- over a build made up here and served as GOG's CDN serves one
 * (deflated manifests named by their hash, chunks by their deflated MD5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { memoryFile, noise } from '../steam/depot.fixture.js';
import { Codec, openBundle } from '../layers/filesystem/internal/bundle/format.js';
import {
    GOG_CDN, chunkUrl, dependencyDepots, endpointsOf, galaxyPath, installedFiles, openChunk,
    pickBuild, pickDepots, primaryTask, readMeta,
} from './content.js';
import { installGogBundle } from './install.js';

/** @param {Uint8Array} bytes */
const md5 = bytes=>createHash('md5').update(bytes).digest('hex');

/** A secure link as GOG's answers it: the chunk's path goes into `path`. */
const SECURE = { urls: [
    { endpoint_name: 'low', priority: 1, url_format: '{base_url}/token={token}{path}',
        parameters: { base_url: 'https://two.example', token: 't2',
            path: '/content-system/v2/store/100' } },
    { endpoint_name: 'high', priority: 10, url_format: '{base_url}/token={token}{path}',
        parameters: { base_url: 'https://one.example', token: 't1',
            path: '/content-system/v2/store/100' } },
] };
/** The dependencies' open link: no parameters, the path after its address. */
const OPEN = { urls: [{ url_format: 'https://deps.example/content-system/v2/dependencies/store',
    parameters: {}, priority: 10 }] };

test('a hash\'s galaxy path, and a chunk\'s address at either kind of endpoint', ()=>{
    assert.equal(galaxyPath('92ab42631ff4742b309bb62c175e6306'),
        '92/ab/92ab42631ff4742b309bb62c175e6306');
    const [first, second] = endpointsOf(SECURE);
    assert.equal(first.endpoint_name, 'high', 'the highest priority first');
    assert.equal(chunkUrl(first, 'abcdef01'),
        'https://one.example/token=t1/content-system/v2/store/100/ab/cd/abcdef01');
    assert.equal(chunkUrl(second, 'abcdef01').slice(0, 26), 'https://two.example/token=');
    assert.equal(chunkUrl(OPEN.urls[0], 'abcdef01'),
        'https://deps.example/content-system/v2/dependencies/store/ab/cd/abcdef01');
});

test('the build Galaxy installs, and the depots one language and a 64-bit machine take', ()=>{
    assert.equal(pickBuild({ items: [
        { build_id: '3', branch: 'beta', generation: 2, link: 'b' },
        { build_id: '2', branch: null, generation: 1, link: 'one' },
        { build_id: '1', branch: null, generation: 2, link: 'two' },
    ] })?.build_id, '1');
    assert.equal(pickBuild({ items: [] }), null);
    /** @param {string} manifest @param {string[]} languages @param {string[]} [osBitness] */
    const listedAs = (manifest, languages, osBitness)=>({ productId: '100', manifest, languages,
        size: 1, ...osBitness ? { osBitness } : {} });
    const build = { baseProductId: '100', installDirectory: 'Game', products: [], depots: [
        listedAs('all', ['*']), listedAs('en', ['en-US']), listedAs('de', ['de-DE']),
        listedAs('shared', ['en-US', 'de-DE']), listedAs('shared', ['de-DE']),
        listedAs('x86', ['*'], ['32']), listedAs('x64', ['*'], ['64']),
    ] };
    assert.deepEqual(pickDepots(build, { language: 'de-DE' }).depots.map(one=>one.manifest),
        ['all', 'de', 'shared', 'x64']);
    const fallback = pickDepots(build, { language: 'ja-JP' });
    assert.equal(fallback.language, 'en-US', 'a language the build lacks falls back to English');
    assert.deepEqual(pickDepots(build, { bitness: '32' }).depots.map(one=>one.manifest),
        ['all', 'en', 'shared', 'x86']);
    const repository = { depots: [
        { dependencyId: 'DirectX', manifest: 'dx', executable: { path: 'x', arguments: '' },
            internal: false, size: 1 },
        { dependencyId: 'MSVC2010_x64', manifest: 'vc64', osBitness: ['64'],
            executable: { path: 'y', arguments: '' }, internal: false, size: 1 },
        { dependencyId: 'MSVC2010_x64', manifest: 'vc32only', osBitness: ['32'],
            executable: { path: 'y', arguments: '' }, internal: false, size: 1 },
        { dependencyId: 'Other', manifest: 'no', executable: { path: '', arguments: '' },
            internal: true, size: 1 },
    ] };
    assert.deepEqual(dependencyDepots(repository, ['DirectX', 'MSVC2010_x64'])
        .map(one=>one.manifest), ['dx', 'vc64']);
});

test('the files depots leave: support files apart, a later depot\'s over an earlier\'s', ()=>{
    /** @param {number} size */
    const chunk = size=>({ md5: 'm', compressedMd5: `c${size}`, size, compressedSize: size });
    const { files, directories } = installedFiles([
        { items: [{ type: 'DepotFile', path: 'Data\\a.pak', chunks: [chunk(4), chunk(6)] },
            { type: 'DepotFile', path: 'game.exe', chunks: [chunk(3)] },
            { type: 'DepotDirectory', path: 'Saves' }] },
        { items: [{ type: 'DepotFile', path: 'DATA/A.PAK', chunks: [chunk(2)] },
            { type: 'DepotFile', path: 'app\\game.ini', flags: ['support'], chunks: [chunk(1)] },
            { type: 'DepotLink', path: 'Links\\here', target: 'there' }] },
    ]);
    assert.deepEqual(files.map(one=>[one.path, one.size, one.source]), [
        ['Data\\a.pak', 2, 1], ['__support\\app\\game.ini', 1, 1], ['game.exe', 3, 0],
    ]);
    assert.deepEqual(installedFiles([{ items: [{ type: 'DepotFile', path: 'a',
        chunks: [chunk(4), chunk(6)] }] }]).files[0].chunks.map(one=>one.offset), [0, 4],
    'each chunk where it lies in its file');
    assert.deepEqual(directories, ['Saves']);
});

test('a chunk is opened only when both its MD5s and its length are what the depot says',
    async()=>{
        const plain = noise(5000, 3);
        const packed = new Uint8Array(deflateSync(plain));
        const chunk = { md5: md5(plain), compressedMd5: md5(packed), size: plain.length,
            compressedSize: packed.length };
        assert.deepEqual(await openChunk(packed, chunk), plain);
        const damaged = packed.slice();
        damaged[10] ^= 1;
        await assert.rejects(openChunk(damaged, chunk), /is not what its name says/);
        await assert.rejects(openChunk(packed, { ...chunk, md5: md5(noise(5000, 4)) }),
            /opens to something else/);
        assert.deepEqual(await readMeta(new Uint8Array(deflateSync('{"a":1}'))), { a: 1 });
        assert.deepEqual(await readMeta(new TextEncoder().encode('{"a":2}')), { a: 2 });
    });

test('the program a person starts: the primary play task of goggame-<id>.info', ()=>{
    const info = (/** @type {any} */ value)=>new TextEncoder().encode(JSON.stringify(value));
    assert.deepEqual(primaryTask(info({ playTasks: [
        { type: 'URLTask', isPrimary: true, link: 'https://example' },
        { type: 'FileTask', isPrimary: true, path: 'bin/Game.exe', arguments: '-window',
            workingDir: 'bin' },
    ] })), { path: 'bin\\Game.exe', arguments: '-window', workingDir: 'bin' });
    assert.deepEqual(primaryTask(info({ playTasks: [{ type: 'FileTask', path: 'a.exe',
        arguments: ['-x', '-y'] }] })), { path: 'a.exe', arguments: '-x -y', workingDir: '' });
    assert.equal(primaryTask(info({ playTasks: [] })), null);
    assert.equal(primaryTask(new TextEncoder().encode('not json')), null);
});

/**
 * A build of a game and a dependency of it, served from a CDN in memory: each
 * file cut into chunks of `CHUNK` bytes, deflated, named by their MD5.
 */
const CHUNK = 7000;

/** @param {Record<string, Uint8Array>} contents @param {string[]} [support] */
function depot(contents, support = []){
    /** @type {Map<string, Uint8Array>} */
    const chunks = new Map();
    const items = Object.entries(contents).map(([path, bytes])=>{
        const pieces = [];
        for (let at = 0; at < bytes.length; at += CHUNK)
        {
            const plain = bytes.subarray(at, at + CHUNK);
            const packed = new Uint8Array(deflateSync(plain));
            chunks.set(md5(packed), packed);
            pieces.push({ md5: md5(plain), compressedMd5: md5(packed), size: plain.length,
                compressedSize: packed.length });
        }
        return { type: 'DepotFile', path, chunks: pieces,
            ...support.includes(path) ? { flags: ['support'] } : {} };
    });
    const manifest = new Uint8Array(deflateSync(JSON.stringify({ version: 2, depot: { items } })));
    return { hash: md5(manifest), manifest, chunks };
}

function game(){
    const info = new TextEncoder().encode(JSON.stringify({ playTasks: [
        { type: 'FileTask', isPrimary: true, path: 'bin\\Game.exe', arguments: '-safe' }] }));
    const main = depot({ 'bin\\Game.exe': noise(30_000, 1), 'data\\level.pak': noise(50_000, 2),
        'app\\game.cfg': noise(100, 3) }, ['app\\game.cfg']);
    const english = depot({ 'goggame-100.info': info, 'data\\speech.pak': noise(9_000, 4) });
    const german = depot({ 'goggame-100.info': info, 'data\\speech.pak': noise(9_000, 5) });
    const engine = depot({ 'engine\\engine.dll': noise(20_000, 6) });
    const build = { baseProductId: '100', installDirectory: 'Game', dependencies: ['Engine'],
        products: [{ productId: '100', name: 'Game' }], depots: [
            { productId: '100', manifest: main.hash, languages: ['*'], size: 80_100 },
            { productId: '100', manifest: english.hash, languages: ['en-US'], size: 9_000 },
            { productId: '100', manifest: german.hash, languages: ['de-DE'], size: 9_000 },
        ] };
    const repository = new Uint8Array(deflateSync(JSON.stringify({ depots: [
        { dependencyId: 'Engine', manifest: engine.hash, internal: true, size: 20_000,
            executable: { path: '', arguments: '' } }] })));
    /** @type {Map<string, Uint8Array>} */
    const served = new Map();
    for (const one of [main, english, german])
    {
        served.set(`${GOG_CDN}/content-system/v2/meta/${galaxyPath(one.hash)}`, one.manifest);
        for (const [hash, bytes] of one.chunks)
        {
            for (const host of ['one.example', 'two.example'])
            {
                served.set(`https://${host}/token=t${host === 'one.example' ? 1 : 2}`
                    + `/content-system/v2/store/100/${galaxyPath(hash)}`, bytes);
            }
        }
    }
    served.set(`${GOG_CDN}/content-system/v2/dependencies/meta/${galaxyPath(engine.hash)}`,
        engine.manifest);
    for (const [hash, bytes] of engine.chunks)
    {
        served.set(`https://deps.example/content-system/v2/dependencies/store/${galaxyPath(hash)}`,
            bytes);
    }
    served.set('https://repo.example/manifest', repository);
    const asked = { chunks: 0 };
    /** @type {Set<string>} Addresses that answer damaged bytes. */
    const damaged = new Set();
    /** @param {string} url */
    const get = async url=>{
        const bytes = served.get(url);
        if (!bytes)
        {
            return new Response(null, { status: 404 });
        }
        if (/\/store\//.test(url))
        {
            asked.chunks++;
        }
        const answer = damaged.has(url) ? bytes.map((byte, at)=>(at === 5 ? byte ^ 1 : byte))
            : bytes;
        return new Response(answer.slice(), { status: 200 });
    };
    const plan = { build, links: { 100: SECURE },
        dependencies: { manifest: 'https://repo.example/manifest', link: OPEN } };
    return { plan, get, asked, damaged, served };
}

/** Every file of a bundle held in memory, by path. @param {Uint8Array} container */
async function filesOf(container){
    const bundle = await openBundle(async(at, length)=>container.slice(at, at + length),
        (codec, bytes)=>{
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
            bytes.set(stored.subarray(from, to), (block.index - one.firstBlock) * bundle.blockSize
                + from);
        }
        files.set(one.path, bytes);
    }
    return files;
}

test('an install into a bundle in place: the language\'s depots, the dependency, the program',
    async()=>{
        const { plan, get, damaged, served } = game();
        // The first endpoint damages one chunk: the second gives it.
        damaged.add([...served.keys()].find(url=>url.startsWith('https://one.example/'))
            ?? '');
        const handle = memoryFile();
        const stages = /** @type {string[]} */ ([]);
        const done = await installGogBundle({ handle, plan, language: 'de-DE', fetch: get,
            onProgress: ({ stage })=>stages.at(-1) !== stage && stages.push(stage) });
        assert.deepEqual(stages, ['downloading', 'finishing']);
        const files = await filesOf(handle.bytes());
        assert.deepEqual([...files.keys()], ['__support\\app\\game.cfg', 'bin\\Game.exe',
            'data\\level.pak', 'data\\speech.pak', 'engine\\engine.dll', 'goggame-100.info']);
        assert.deepEqual(files.get('data\\speech.pak'), noise(9_000, 5), 'the German depot\'s');
        assert.deepEqual(files.get('engine\\engine.dll'), noise(20_000, 6));
        assert.equal(done.executable, 'bin\\Game.exe');
        assert.equal(done.arguments, '-safe');
        assert.equal(done.language, 'de-DE');
        assert.deepEqual(done.entry, noise(30_000, 1));
        assert.equal(done.bundle.bytes, handle.getSize());
    });

test('an install stopped part way goes on from what it saved; another language starts over',
    async()=>{
        const { plan, get, asked } = game();
        const whole = memoryFile();
        await installGogBundle({ handle: whole, plan, fetch: get });
        const every = asked.chunks;

        const handle = memoryFile();
        /** @type {import('./install.js').InstallProgress | null} */
        let saved = null;
        const stop = new AbortController();
        let landed = 0;
        await assert.rejects(installGogBundle({ handle, plan, fetch: get, jobs: 1,
            signal: stop.signal,
            onSave: progress=>{
                saved = { stamp: progress.stamp, done: progress.done.slice() };
            },
            onProgress: ({ done })=>{
                if (done > 0 && ++landed === 3)
                {
                    stop.abort();
                }
            } }), { name: 'AbortError' });
        assert.ok(saved, 'what was done is saved as the run stops');
        const before = asked.chunks;
        await installGogBundle({ handle, plan, fetch: get, resume: saved });
        assert.equal(asked.chunks - before + 3, every, 'each chunk once across the two runs');
        assert.deepEqual(handle.bytes(), whole.bytes(), 'the bundle a run never stopped makes');

        const again = asked.chunks;
        await installGogBundle({ handle, plan, fetch: get, resume: saved, language: 'de-DE' });
        assert.equal(asked.chunks - again, every, 'every chunk again');
    });

test('a build whose product has no link, or no repository for its dependencies, says so',
    async()=>{
        const { plan, get } = game();
        await assert.rejects(installGogBundle({ handle: memoryFile(), fetch: get,
            plan: { ...plan, links: {} } }), /no link to product 100/);
        await assert.rejects(installGogBundle({ handle: memoryFile(), fetch: get,
            plan: { build: plan.build, links: plan.links } }), /needs Engine/);
    });
