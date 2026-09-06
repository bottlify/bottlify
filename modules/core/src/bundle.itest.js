/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Phase 4, the last piece: a program reads a file out of a bundle it never
 * downloaded whole.
 *
 * The bundle is never held in memory -- these are gigabytes in the real case --
 * so a read of a block that is not here yet is a miss, the guest thread is
 * parked while the block is fetched, and the read is retried. This checks that
 * the whole of that path works from a real program's ReadFile, and that only
 * the blocks actually touched are ever fetched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { writeBundle } from '../../../tools/btl.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/session.exe', import.meta.url);

/** What the fixture reads and prints, planted in the bundle rather than written. */
const PLANTED = 'FROM-BTL';

/**
 * Builds a bundle holding one file the fixture will read, and hands back a
 * range fetcher over it plus a count of how much was actually asked for.
 */
async function bundleWith(/** @type {string} */ contents){
    const root = await mkdtemp(join(tmpdir(), 'btl-src-'));
    const out = await mkdtemp(join(tmpdir(), 'btl-out-'));
    await mkdir(join(root, 'Data'), { recursive: true });
    await writeFile(join(root, 'save.dat'), contents);
    // Large, and incompressible on purpose: a filler that compressed away would
    // make the bundle tiny and the assertion below meaningless.
    await writeFile(join(root, 'Data', 'big.bin'), randomBytes(300 * 1024));

    const path = join(out, 'bundle.btl');
    const summary = await writeBundle({ root, output: path, blockSize: 64 * 1024 });
    const handle = await open(path, 'r');

    const fetched = { calls: 0, bytes: 0 };
    return {
        summary,
        fetched,
        /** @param {number} offset @param {number} length */
        fetch: async(offset, length)=>{
            fetched.calls++;
            fetched.bytes += length;
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, offset);
            return new Uint8Array(buffer);
        },
        cleanup: async()=>{
            await handle.close();
            await rm(root, { recursive: true, force: true });
            await rm(out, { recursive: true, force: true });
        },
    };
}

test('a program reads a file out of a bundle, fetching only what it touches', async()=>{
    const source = await bundleWith(PLANTED);
    const [wasm, exe] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(FIXTURE),
    ]);

    const app = await createApp({
        executable: new Uint8Array(exe),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
        bundle: { fetch: source.fetch },
    });

    let printed = '';
    app.on('output', (/** @type {any} */ payload)=>{
        printed += payload.text;
    });

    const exitCode = await app.run({ maxTurns: 20000 });
    await app.dispose();

    assert.equal(exitCode, 0);
    assert.equal(printed, PLANTED,
        'the bytes came out of the bundle, through a read that had to wait for them');

    // The bundle is 300 KiB of payload in 64 KiB blocks. A read of an eight-byte
    // file must not have pulled the whole thing across.
    assert.ok(source.fetched.bytes < source.summary.bytes / 2,
        `only part of the bundle was fetched (${source.fetched.bytes} of ${source.summary.bytes})`);

    await source.cleanup();
});

test('what the bundle holds is visible to the program, and stays read-only', async()=>{
    const source = await bundleWith(PLANTED);
    const [wasm, exe] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(FIXTURE),
    ]);

    const app = await createApp({
        executable: new Uint8Array(exe),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
        bundle: { fetch: source.fetch },
    });

    await app.run({ maxTurns: 20000 });

    // The fixture writes the file after reading it. What it wrote belongs to the
    // session; the bundle underneath is untouched, which is what makes a bundle
    // cacheable by content and shareable between players.
    const session = app.session.export();
    assert.deepEqual(session.map((/** @type {any} */ file)=>file.path), ['C:\\save.dat']);

    await app.dispose();
    await source.cleanup();
});

/**
 * Somewhere to keep blocks, over ordinary buffers. Node has no OPFS, so without
 * this the cache falls back to the heap and the background filler stays off --
 * which is right, and would leave it untested.
 */
function fakeStore(){
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @param {string} path @returns {Uint8Array} */
    const bytesOf = path=>files.get(path) ?? new Uint8Array(0);

    return {
        /** @param {string} path */
        async open(path){
            if (!files.has(path))
            {
                files.set(path, new Uint8Array(0));
            }
        },
        /** @param {string} path */
        stat: path=>files.has(path) ? { size: bytesOf(path).length } : null,
        /** @param {string} path @param {number} at @param {number} length */
        read: (path, at, length)=>bytesOf(path).slice(at, at + length),
        /** @param {string} path @param {number} at @param {Uint8Array} bytes */
        write(path, at, bytes){
            const held = bytesOf(path);
            if (held.length >= at + bytes.length)
            {
                held.set(bytes, at);
                return;
            }
            const grown = new Uint8Array(at + bytes.length);
            grown.set(held);
            grown.set(bytes, at);
            files.set(path, grown);
        },
        /** @param {string} path @param {number} size */
        truncate(path, size){
            files.set(path, new Uint8Array(size));
        },
    };
}

test('what the program never read is fetched anyway, in the gaps', async()=>{
    // The fixture reads save.dat and nothing else. Data\big.bin is 300 KiB of
    // incompressible filler it never opens, so if those blocks arrive, they
    // arrived because nothing was being read rather than because something
    // asked for them.
    const source = await bundleWith(PLANTED);
    const [wasm, exe] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(FIXTURE),
    ]);

    const app = await createApp({
        executable: new Uint8Array(exe),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
        bundle: { fetch: source.fetch, store: fakeStore(), id: 'filled' },
    });

    /** @type {any} */
    let filled = null;
    app.on('bundle-prefetch', (/** @type {any} */ payload)=>{
        filled = payload;
    });

    assert.equal(await app.run({ maxTurns: 20000 }), 0);

    // The run ends when the program does, and the filler only moves in the gaps,
    // so what matters is that it moved at all and never got ahead of the reads.
    assert.ok(filled, 'the filler reported progress');
    assert.ok(filled.resident > 1, `only ${filled.resident} block(s) ever arrived`);
    assert.ok(filled.resident <= filled.blocks);

    await app.dispose();
    await source.cleanup();
});
