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
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBundle, Codec }
    from '../../../core/src/layers/filesystem/internal/bundle/format.js';
import { collectFrom, publish } from '../index.js';
import { createBottleServer } from './index.js';

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
            manifest: { title: 'A Title' },
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
