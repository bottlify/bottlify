/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The upload path end to end, over a real socket: a prefix goes in one side and
 * a bundle the engine's own reader can open comes out the other.
 *
 * Only a real server answers the questions worth asking here -- what a part
 * out of order does, what an unauthenticated request gets, and whether the
 * bytes land where the header says they do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The engine's own reader, which is not published.
import { openBundle } from '../../../core/src/layers/filesystem/internal/bundle/format.js';
import { Codec } from '@bottlify/core/bundle';
import { collectFrom, publish } from '../index.js';
import { createBottleServer, manifestChanges } from './index.js';

const TOKEN = 'a-secret-nobody-else-has';

/** @param {number} codec @param {Uint8Array} stored */
const decode = (codec, stored)=>codec === Codec.DEFLATE_RAW
    ? new Uint8Array(zlib.inflateRawSync(stored))
    : stored;

/** @param {string} text */
const bytes = text=>new TextEncoder().encode(text);

/**
 * An engine that has just finished running an installer: what it wrote, and
 * what its registry holds.
 *
 * @param {{ path: string, bytes: Uint8Array }[]} files
 */
const finishedApp = files=>({
    session: { export: ()=>files },
    registry: ()=>({ toJSON: ()=>({ roots: [{ id: 0x80000002, key: { name: 'HKLM' } }] }) }),
});

/** Starts a server in a directory of its own and hands back both. */
async function serving(){
    const root = await mkdtemp(join(tmpdir(), 'bottlify-bottles-'));
    const server = createBottleServer({ root, token: TOKEN, port: 0 });
    const port = await server.listen();
    return {
        root,
        endpoint: { url: `http://127.0.0.1:${port}`, token: TOKEN },
        async stop(){
            await server.close();
            await rm(root, { recursive: true, force: true });
        },
    };
}

/**
 * Opens a bundle on disk through the engine's reader, which is the only reader
 * whose opinion of this file matters.
 *
 * @param {string} path
 */
async function readBundle(path){
    const handle = await open(path, 'r');
    /** @param {number} offset @param {number} length */
    const fetchRange = async(offset, length)=>{
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        return new Uint8Array(buffer);
    };
    const bundle = await openBundle(fetchRange, decode);
    return { bundle, fetchRange, close: ()=>handle.close() };
}

test('a prefix becomes a bundle the engine can open, and a manifest beside it', async()=>{
    const host = await serving();
    try
    {
        const app = finishedApp([
            { path: 'C:\\Install\\Setup.exe', bytes: bytes('the distribution itself') },
            { path: 'C:\\Games\\Title\\title.exe', bytes: bytes('MZ program') },
            { path: 'C:\\Games\\Title\\data\\art.mpq', bytes: new Uint8Array(3000).fill(3) },
        ]);

        const prefix = collectFrom(app, {
            name: 'Setup.exe',
            bytes: bytes('the distribution itself'),
        });
        const { answer } = await publish({
            prefix,
            endpoint: host.endpoint,
            id: 'a-title',
            // A title's own launch arguments (a bundle-side cvar, say) are not a
            // field this package knows about; they must still reach the file
            // unchanged, the same way `title` and `entry` do.
            manifest: { title: 'A Title', commandLine: '+set s_realTimeDecoding 0' },
        });

        // What was seeded before the run is not part of what came out of it.
        assert.equal(prefix.root, 'C:\\Games\\Title');
        assert.deepEqual(prefix.files.map(file=>file.path).sort(),
            ['.bottlify\\registry.json', 'data\\art.mpq', 'title.exe']);

        const { bundle, close } = await readBundle(join(host.root, 'a-title', 'bundle.btl'));
        const program = bundle.find('title.exe');
        assert.ok(program, 'the program the installer wrote is not in the bundle');
        assert.equal(program.size, 10);
        assert.ok(bundle.find('.bottlify\\registry.json'), 'the registry travels with the files');
        await close();

        const manifest = JSON.parse(
            await readFile(join(host.root, 'a-title', 'manifest.json'), 'utf8'));
        assert.equal(manifest.id, 'a-title');
        assert.equal(manifest.title, 'A Title');
        assert.equal(manifest.entry, 'title.exe');
        assert.equal(manifest.commandLine, '+set s_realTimeDecoding 0');
        assert.equal(manifest.bundle.format, 'btl/2');
        // Computed on this side, because a browser cannot hash incrementally.
        assert.match(manifest.bundle.sha256, /^[0-9a-f]{64}$/);
        assert.equal(answer.manifest.id, 'a-title');
    }
    finally
    {
        await host.stop();
    }
});

test('a request without the token is refused', async()=>{
    const host = await serving();
    try
    {
        const response = await fetch(`${host.endpoint.url}/bottles/x/blocks?at=0`, {
            method: 'POST',
            body: 'anything',
        });
        assert.equal(response.status, 401);
    }
    finally
    {
        await host.stop();
    }
});

test('a part that does not follow the last one is refused rather than leaving a hole', async()=>{
    const host = await serving();
    try
    {
        const post = (/** @type {number} */ at)=>fetch(
            `${host.endpoint.url}/bottles/gap/blocks?at=${at}`,
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${TOKEN}` },
                body: new Uint8Array(16),
            });

        assert.equal((await post(0)).status, 200);
        // A hole would be zeroes the digest never saw, so the bundle's recorded
        // digest would describe something that is not in the file.
        assert.equal((await post(999)).status, 409);
    }
    finally
    {
        await host.stop();
    }
});

test('an id that would name a path is refused', async()=>{
    const host = await serving();
    try
    {
        const response = await fetch(
            `${host.endpoint.url}/bottles/${encodeURIComponent('../escape')}/blocks?at=0`,
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${TOKEN}` },
                body: new Uint8Array(4),
            });
        assert.equal(response.status, 400);
    }
    finally
    {
        await host.stop();
    }
});

test('an install that produced nothing is refused before anything is uploaded', async()=>{
    const host = await serving();
    try
    {
        const media = { name: 'Setup.exe', bytes: bytes('MZ') };
        const app = finishedApp([{ path: 'C:\\Install\\Setup.exe', bytes: media.bytes }]);
        await assert.rejects(
            publish({
                prefix: collectFrom(app, media),
                endpoint: host.endpoint,
                id: 'empty',
            }),
            /no files/);
    }
    finally
    {
        await host.stop();
    }
});

test('a bottle\'s settings change in its manifest, and nothing its upload made does', async()=>{
    const host = await serving();
    try
    {
        const prefix = collectFrom(finishedApp([
            { path: 'C:\\Install\\Setup.exe', bytes: bytes('the distribution') },
            { path: 'C:\\Games\\Title\\game.exe', bytes: bytes('MZ program') },
        ]), { name: 'Setup.exe', bytes: bytes('the distribution') });
        await publish({ prefix, endpoint: host.endpoint, id: 'settled',
            manifest: { title: 'Game', entry: 'game.exe' } });
        const send = (/** @type {any} */ body, token = TOKEN)=>fetch(
            `${host.endpoint.url}/bottles/settled/manifest`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: JSON.stringify(body),
            });
        const response = await send({ title: 'Renamed', labels: ['demo', 'benchmark'],
            kind: 'application', windows: 'win7', graphics: 'directx9' });
        assert.equal(response.status, 200);
        const written = JSON.parse(
            await readFile(join(host.root, 'settled', 'manifest.json'), 'utf8'));
        assert.deepEqual(
            [written.title, written.labels, written.kind, written.windows, written.graphics],
            ['Renamed', ['demo', 'benchmark'], 'application', 'win7', 'directx9']);
        assert.equal(written.entry, 'game.exe', 'the entry is the upload\'s');
        assert.ok(written.bundle.sha256, 'and so is the bundle record');

        assert.equal((await send({ entry: 'other.exe' })).status, 400, 'not a setting');
        assert.equal((await send({ labels: ['retail'] })).status, 400, 'not a label');
        assert.equal((await send({ title: 'x' }, 'wrong')).status, 401);
        const nowhere = await fetch(`${host.endpoint.url}/bottles/nowhere/manifest`, {
            method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' });
        assert.equal(nowhere.status, 404);
    }
    finally
    {
        await host.stop();
    }
});

test('only the settings of a bottle are taken, each checked', ()=>{
    assert.deepEqual(manifestChanges({ version: ' 1.2 ', kind: 'game', labels: ['test', 'test'] }),
        { fields: { version: '1.2', kind: 'game', labels: ['test'] } });
    assert.deepEqual(manifestChanges({ description: ' What it is. ' }),
        { fields: { description: 'What it is.' } });
    assert.ok('refused' in manifestChanges({ description: 'x'.repeat(2001) }));
    assert.deepEqual(manifestChanges({ source: ' https://example.org/demo ' }),
        { fields: { source: 'https://example.org/demo' } });
    assert.deepEqual(manifestChanges({ source: '' }), { fields: { source: '' } });
    assert.ok('refused' in manifestChanges({ source: 'javascript:alert(1)' }));
    assert.deepEqual(manifestChanges({ year: 1999, rightsHolder: ' Ubisoft ' }),
        { fields: { year: 1999, rightsHolder: 'Ubisoft' } });
    assert.ok('refused' in manifestChanges({ year: '1999' }));
    assert.ok('refused' in manifestChanges({ year: 1800 }));
    assert.ok('refused' in manifestChanges({ rightsHolder: 'x'.repeat(201) }));
    assert.ok('refused' in manifestChanges({ kind: 'movie' }));
    assert.ok('refused' in manifestChanges({ windows: '../etc' }));
    assert.ok('refused' in manifestChanges(['title']));
});

test('a cover and a wallpaper go beside the manifest, and a new one replaces the old', async()=>{
    const host = await serving();
    try
    {
        const prefix = collectFrom(finishedApp([
            { path: 'C:\\Games\\Title\\game.exe', bytes: bytes('MZ program') },
        ]), { name: 'Setup.exe', bytes: bytes('the distribution') });
        await publish({ prefix, endpoint: host.endpoint, id: 'pictured',
            manifest: { title: 'Game', entry: 'game.exe' } });
        const send = (/** @type {string} */ slot, /** @type {string} */ type,
            /** @type {Uint8Array<ArrayBuffer>} */ body, id = 'pictured')=>fetch(
            `${host.endpoint.url}/bottles/${id}/art/${slot}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': type },
                body,
            });
        const directory = join(host.root, 'pictured');

        const first = await send('cover', 'image/png', bytes('first cover'));
        assert.equal(first.status, 200);
        const named = (await first.json()).manifest.coverLarge;
        assert.match(named, /^\.\/cover-[0-9a-f]{12}\.png$/);
        assert.equal(await readFile(join(directory, named.slice(2)), 'utf8'), 'first cover');

        assert.equal((await send('cover', 'image/webp', bytes('second cover'))).status, 200);
        assert.equal((await send('wallpaper', 'image/jpeg', bytes('a wallpaper'))).status, 200);
        const written = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
        assert.match(written.coverLarge, /^\.\/cover-[0-9a-f]{12}\.webp$/);
        assert.equal(written.coverSmall, written.coverLarge, 'the card shows the same cover');
        assert.match(written.wallpaper, /^\.\/wallpaper-[0-9a-f]{12}\.jpg$/);
        assert.equal(written.entry, 'game.exe', 'nothing else in the manifest moves');
        const pictures = (await readdir(directory)).filter(file=>/^(cover|wallpaper)-/.test(file));
        assert.deepEqual(pictures.sort(),
            [written.coverLarge.slice(2), written.wallpaper.slice(2)].sort(),
            'the first cover is gone, and nothing half-written is left');

        assert.equal((await send('cover', 'text/html', bytes('<p>'))).status, 400, 'not a picture');
        assert.equal((await send('cover', 'image/png', new Uint8Array(0))).status, 400, 'empty');
        assert.equal((await send('icon', 'image/png', bytes('x'))).status, 404, 'not a place');
        assert.equal((await send('cover', 'image/png', bytes('x'), 'nowhere')).status, 404);
    }
    finally
    {
        await host.stop();
    }
});

test('a bottle is removed whole, and only a bottle is', async()=>{
    const host = await serving();
    try
    {
        const prefix = collectFrom(finishedApp([
            { path: 'C:\\Games\\Title\\game.exe', bytes: bytes('MZ program') },
        ]), { name: 'Setup.exe', bytes: bytes('the distribution') });
        await publish({ prefix, endpoint: host.endpoint, id: 'unwanted',
            manifest: { title: 'Old', entry: 'game.exe' } });
        const remove = (/** @type {string} */ id, token = TOKEN)=>fetch(
            `${host.endpoint.url}/bottles/${id}`, {
                method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });

        assert.equal((await remove('unwanted', 'wrong')).status, 401);
        assert.equal((await remove('unwanted')).status, 200);
        assert.deepEqual(await readdir(host.root), [], 'nothing of it is left');
        assert.equal((await remove('unwanted')).status, 404, 'a second time there is nothing');
        assert.equal((await remove('.hidden')).status, 400, 'a name that is not an id is refused');
    }
    finally
    {
        await host.stop();
    }
});
