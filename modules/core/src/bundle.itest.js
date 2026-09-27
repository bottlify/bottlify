/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
import { BOTTLE_REGISTRY_PATH, createApp, READ_AHEAD_BYTES } from './app.js';
import { writeBundle } from './bundle-node.js';
import { createHive, HKEY_LOCAL_MACHINE, REG_SZ } from './layers/win32/advapi32/registry.js';

/** The fixture's blocks, small so a read of a few bytes still misses one. */
const BLOCK_SIZE = 64 * 1024;

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/session.exe', import.meta.url);

/** What the fixture reads and prints, planted in the bundle rather than written. */
const PLANTED = 'FROM-BTL';

/**
 * Builds a bundle holding one file the fixture will read, and hands back a
 * range fetcher over it plus a count of how much was actually asked for.
 *
 * @param {string} contents what the fixture reads out of the bundle
 * @param {number} [filler] bytes of padding nothing ever reads
 */
async function bundleWith(contents, filler = 300 * 1024){
    const root = await mkdtemp(join(tmpdir(), 'btl-src-'));
    const out = await mkdtemp(join(tmpdir(), 'btl-out-'));
    await mkdir(join(root, 'Data'), { recursive: true });
    await writeFile(join(root, 'save.dat'), contents);
    // Incompressible on purpose: padding that compressed away would make the
    // bundle tiny and the assertions about what was fetched meaningless.
    await writeFile(join(root, 'Data', 'big.bin'), randomBytes(filler));

    const path = join(out, 'bundle.btl');
    const summary = await writeBundle({ root, output: path, blockSize: BLOCK_SIZE });
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

test('a program reads a file out of a bundle, fetching only what it touches',
    { timeout: 30000 }, async t=>{
        const source = await bundleWith(PLANTED);
        t.after(()=>source.cleanup());
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
            // Mounted at the root rather than in an installation directory: this
            // fixture asks for an absolute path, and what is under test here is
            // the transport -- a read that misses, waits for its block and is
            // retried -- not where a bundle is mounted.
            bundle: { fetch: source.fetch, prefix: '' },
        });
        t.after(()=>app.dispose());

        let printed = '';
        app.on('output', (/** @type {any} */ payload)=>{
            printed += payload.text;
        });

        const exitCode = await app.run({ maxTurns: 20000, timeoutMs: 20000 });

        assert.equal(exitCode, 0);
        assert.equal(printed, PLANTED,
            'the bytes came out of the bundle, through a read that had to wait for them');

        // A miss brings the window around it rather than the block alone, so
        // what bounds a read of an eight-byte file is the window and not the
        // bundle: a fixture smaller than one window is fetched whole and that
        // is correct. What must not happen is a second window for one small
        // read, or a request for a range nothing asked about.
        assert.ok(source.fetched.bytes <= READ_AHEAD_BYTES + BLOCK_SIZE,
            `one window at most was fetched (${source.fetched.bytes} for a window of`
            + ` ${READ_AHEAD_BYTES})`);
        assert.ok(source.fetched.calls <= 4,
            `a handful of requests brought it in (${source.fetched.calls})`);
    });

test('what the bundle holds is visible to the program, and stays read-only',
    { timeout: 30000 }, async t=>{
        const source = await bundleWith(PLANTED);
        t.after(()=>source.cleanup());
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
            // Mounted at the root rather than in an installation directory: this
            // fixture asks for an absolute path, and what is under test here is
            // the transport -- a read that misses, waits for its block and is
            // retried -- not where a bundle is mounted.
            bundle: { fetch: source.fetch, prefix: '' },
        });
        t.after(()=>app.dispose());

        await app.run({ maxTurns: 20000, timeoutMs: 20000 });

        // The fixture writes the file after reading it. What it wrote belongs
        // to the session; the bundle underneath is untouched, which is what
        // makes a bundle cacheable by content and shareable between players.
        const session = app.session.export();
        assert.deepEqual(session.map((/** @type {any} */ file)=>file.path), ['C:\\save.dat']);
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

test('a session arriving from outside lands on the volume the bundle is mounted on',
    { timeout: 30000 }, async t=>{
        // The bundle mount puts a fresh writable layer over the bundle. A
        // session laid down before it went with the layer that was replaced: a
        // program's saved profile was written faithfully, kept faithfully, and
        // never seen again on the next start.
        const source = await bundleWith(PLANTED);
        t.after(()=>source.cleanup());
        const [wasm, exe] = await Promise.all([
            readFile(new URL('v86.wasm', PREBUILT)),
            readFile(FIXTURE),
        ]);
        const kept = { path: 'C:\\Save\\profile.w3p', bytes: new Uint8Array([1, 2, 3]) };

        const app = await createApp({
            executable: new Uint8Array(exe),
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
            bundle: { fetch: source.fetch, prefix: '' },
            storage: { load: async()=>({ files: [kept], registry: null }) },
        });
        t.after(()=>app.dispose());

        const paths = app.session.export().map((/** @type {any} */ file)=>file.path);
        assert.ok(paths.includes(kept.path), `the session's file is on the volume: ${paths}`);
    });

test('what the program never read is fetched anyway, in the gaps', { timeout: 120000 }, async t=>{
    // The fixture reads save.dat and nothing else. Data\big.bin is
    // incompressible filler it never opens, so if those blocks arrive, they
    // arrived because nothing was being read rather than because something
    // asked for them.
    //
    // Deliberately larger than one read-ahead window: a bundle that fits inside
    // the window one miss already brings in is whole before the filler ever
    // looks at it, which would leave the filler nothing to show for itself.
    const source = await bundleWith(PLANTED, 2 * READ_AHEAD_BYTES);
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

    // The machine is one per process and the filler runs until this app is
    // disposed, so both happen however the test ends -- a failed assertion that
    // skipped them left the process with live handles and node never exited.
    t.after(async()=>{
        await app.dispose();
        await source.cleanup();
    });

    /** @type {any} */
    let filled = null;
    /** @type {(() => void) | null} */
    let reported = null;
    /** @type {Promise<void>} */
    const fillerMoved = new Promise(resolve=>{
        reported = ()=>resolve();
    });
    app.on('bundle-prefetch', (/** @type {any} */ payload)=>{
        filled = payload;
        reported?.();
    });

    // Bounded in wall time as well as turns: a program parked on a block whose
    // fetch never answered works no turn at all, so the turn budget never runs
    // out on it and the clock is the only bound that returns.
    assert.equal(await app.run({ maxTurns: 20000, timeoutMs: 60000 }), 0);

    // The filler is best effort and only moves in the gaps, so the program is
    // free to exit before it has reported. Wait for its first report with a
    // deadline: a filler that never moves is a failure, not a wait for ever.
    /** @type {ReturnType<typeof setTimeout> | null} */
    let expire = null;
    const deadline = new Promise((unused, reject)=>{
        expire = setTimeout(()=>reject(
            new Error('the background filler never reported progress')), 60000);
    });
    try
    {
        await Promise.race([fillerMoved, deadline]);
    }
    finally
    {
        if (expire !== null)
        {
            clearTimeout(expire);
        }
    }

    // What matters is that it moved at all and never got ahead of the reads.
    assert.ok(filled, 'the filler reported progress');
    assert.ok(filled.resident > 1, `only ${filled.resident} block(s) ever arrived`);
    assert.ok(filled.resident <= filled.blocks);
});

test('the registry a bottle carries is the machine\'s from the start, under what the session saved',
    { timeout: 30000 }, async t=>{
        // An installer's keys went into the bottle as a file and no further: a
        // launcher that finds its game installed by the key its setup made
        // offered to install it again.
        const installed = createHive();
        const key = installed.create(/** @type {any} */ (installed.root(HKEY_LOCAL_MACHINE)),
            'SOFTWARE\\Vendor\\Game\\1.0').key;
        const text = (/** @type {string} */ value)=>new TextEncoder().encode(`${value}\0`);
        installed.setValue(key, 'InstallDir', REG_SZ, text('C:\\Games\\Game'));
        installed.setValue(key, 'Language', REG_SZ, text('English'));

        const root = await mkdtemp(join(tmpdir(), 'btl-src-'));
        const out = await mkdtemp(join(tmpdir(), 'btl-out-'));
        const [folder, file] = BOTTLE_REGISTRY_PATH.split('\\');
        await mkdir(join(root, folder), { recursive: true });
        await writeFile(join(root, folder, file), JSON.stringify(installed.toJSON()));
        await writeFile(join(root, 'game.dat'), randomBytes(200 * 1024));
        const path = join(out, 'bundle.btl');
        await writeBundle({ root, output: path, blockSize: BLOCK_SIZE });
        const handle = await open(path, 'r');
        t.after(async()=>{
            await handle.close();
            await rm(root, { recursive: true, force: true });
            await rm(out, { recursive: true, force: true });
        });
        /** @param {number} offset @param {number} length */
        const fetch = async(offset, length)=>{
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, offset);
            return new Uint8Array(buffer);
        };

        // The session this bottle saved last time: the language changed since.
        const saved = createHive();
        saved.setValue(saved.create(/** @type {any} */ (saved.root(HKEY_LOCAL_MACHINE)),
            'SOFTWARE\\Vendor\\Game\\1.0').key, 'Language', REG_SZ, text('French'));

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
            bundle: { fetch, store: null },
            storage: { load: async()=>({ files: [], registry: saved.toJSON() }) },
        });
        t.after(()=>app.dispose());

        const hive = app.registry();
        const game = hive.open(hive.root(HKEY_LOCAL_MACHINE), 'SOFTWARE\\Vendor\\Game\\1.0');
        assert.ok(game, 'the installation\'s key is there before the program runs');
        const read = (/** @type {string} */ name)=>{
            const value = hive.getValue(game, name);
            return value ? new TextDecoder().decode(value.data).replace(/\0$/, '') : null;
        };
        assert.equal(read('InstallDir'), 'C:\\Games\\Game');
        assert.equal(read('Language'), 'French', 'what the session saved since is kept');
    });
