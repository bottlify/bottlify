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
import { createApp } from './app.js';
import {
    BOTTLE_REGISTRY_PATH, BOTTLE_SYSTEM_PATH, READ_AHEAD_BYTES,
} from './process/bundle-mount.js';
import { writeBundle } from './bundle-node.js';
import { createHive, HKEY_LOCAL_MACHINE, REG_SZ } from './layers/win32/advapi32/registry.js';
import { assemble, buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** The fixture's blocks, small so a read of a few bytes still misses one. */
const BLOCK_SIZE = 64 * 1024;

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
    { timeout: 60_000 }, async t=>{
        const source = await bundleWith(PLANTED);
        t.after(()=>source.cleanup());
        const exe = await readFile(FIXTURE);

        const app = await createApp({
            executable: new Uint8Array(exe),
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
        /** @type {boolean[]} */
        const waits = [];
        app.on('bundle-fetching', (/** @type {any} */ payload)=>waits.push(payload.fetching));

        const exitCode = await app.run({ maxTurns: 20000, timeoutMs: 60_000 });

        assert.equal(exitCode, 0);
        assert.equal(printed, PLANTED,
            'the bytes came out of the bundle, through a read that had to wait for them');
        assert.ok(waits.length >= 2 && waits.every((on, i)=>on === (i % 2 === 0)),
            `the wait was told as it began and as it ended, in turn (${waits})`);

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
    { timeout: 60_000 }, async t=>{
        const source = await bundleWith(PLANTED);
        t.after(()=>source.cleanup());
        const exe = await readFile(FIXTURE);

        const app = await createApp({
            executable: new Uint8Array(exe),
            // Mounted at the root rather than in an installation directory: this
            // fixture asks for an absolute path, and what is under test here is
            // the transport -- a read that misses, waits for its block and is
            // retried -- not where a bundle is mounted.
            bundle: { fetch: source.fetch, prefix: '' },
        });
        t.after(()=>app.dispose());

        await app.run({ maxTurns: 20000, timeoutMs: 60_000 });

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
    { timeout: 60_000 }, async t=>{
        // The bundle mount puts a fresh writable layer over the bundle. A
        // session laid down before it went with the layer that was replaced: a
        // program's saved profile was written faithfully, kept faithfully, and
        // never seen again on the next start.
        const source = await bundleWith(PLANTED);
        t.after(()=>source.cleanup());
        const exe = await readFile(FIXTURE);
        const kept = { path: 'C:\\Save\\profile.w3p', bytes: new Uint8Array([1, 2, 3]) };

        const app = await createApp({
            executable: new Uint8Array(exe),
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
    const exe = await readFile(FIXTURE);

    const app = await createApp({
        executable: new Uint8Array(exe),
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
    { timeout: 60_000 }, async t=>{
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

        const exe = await readFile(FIXTURE);
        const app = await createApp({
            executable: new Uint8Array(exe),
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

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * A library exporting `Answer`, which returns 42, its DllMain answering TRUE:
 * made movable and marked a DLL, a relocation directory of one empty block
 * after the code, since it has no absolute address of its own.
 */
function answerLibrary(){
    const file = buildExe({
        imports: { 'KERNEL32.dll': ['GetVersion'] },
        exports: [{ name: 'Answer', offset: 0x10 }],
        codeSize: 0x60,
        code: ()=>[
            0xb8, ...u32(1), 0xc2, 0x0c, 0x00, //       DllMain: mov eax, TRUE; ret 12
            ...new Array(8).fill(0xcc),
            0xb8, ...u32(42), 0xc3, //                  Answer: mov eax, 42; ret
        ],
    });
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const coff = view.getUint32(0x3c, true) + 4;
    const optional = coff + 20;
    view.setUint16(coff + 18, view.getUint16(coff + 18, true) | 0x2000, true);
    view.setUint32(optional + 96 + 5 * 8, 0x1040, true);
    view.setUint32(optional + 96 + 5 * 8 + 4, 8, true);
    view.setUint32(0x240, 0x1000, true);
    view.setUint32(0x244, 8, true);
    return file;
}

test('what a bottle\'s installation left in system32 is found there, and loaded by bare name',
    { timeout: 60_000 }, async t=>{
        // A setup puts the runtime its program links against in system32 --
        // what a DirectX setup installs -- and the program looks nowhere else.
        const root = await mkdtemp(join(tmpdir(), 'btl-src-'));
        const out = await mkdtemp(join(tmpdir(), 'btl-out-'));
        const [folder, system] = BOTTLE_SYSTEM_PATH.split('\\');
        await mkdir(join(root, folder, system), { recursive: true });
        const library = answerLibrary();
        await writeFile(join(root, folder, system, 'runtime.dll'), library);
        await writeFile(join(root, 'game.dat'), randomBytes(1024));
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

        const app = await createApp({
            executable: buildExe({
                imports: { 'runtime.dll': ['Answer'], 'KERNEL32.dll': ['ExitProcess'] },
                code: ({ iat })=>[
                    0xff, 0x15, ...u32(iat('Answer')), //       call [Answer]
                    0x50, //                                    push eax
                    0xff, 0x15, ...u32(iat('ExitProcess')), //  call [ExitProcess]
                ],
            }),
            imagePath: 'C:\\Games\\Game\\Game.exe',
            bundle: { fetch, store: null, prefix: 'Games\\Game' },
        });
        t.after(()=>app.dispose());

        assert.deepEqual([...await app.files.read('C:\\WINDOWS\\system32\\runtime.dll') ?? []],
            [...library],
            'the library is where Windows keeps it');
        const placed = app.files.list('C:\\Games\\Game')
            .map((/** @type {any} */ entry)=>entry.name);
        assert.deepEqual(placed, ['game.dat'], 'and not where the bottle carried it');
        assert.equal(await app.run({ timeoutMs: 60_000 }), 42,
            'the program bound its import to it and called it');
    });

test('a process started from a bundle mounts the run\'s bundle rather than opening it again',
    { timeout: 60000 }, async t=>{
        // The child's image is in the bundle, as a launcher's game is. Its
        // process is handed the parent's mount -- index, block cache, the fill
        // in the gaps -- so the bundle's head is read once for the run.
        const child = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            code: ({ iat })=>[0x6a, 0x07, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const parent = buildExe({
            imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject',
                'GetExitCodeProcess', 'ExitProcess'] },
            data: {
                command: [...Buffer.from('C:\\child.exe'), 0],
                startup: [...u32(68), ...new Array(64).fill(0)],
                info: new Array(16).fill(0),
                code: u32(0),
            },
            codeSize: 0x80,
            code: ({ iat, at })=>[
                0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at('command')), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateProcessA')),
                0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                // GetExitCodeProcess(info.hProcess, &code); ExitProcess(code)
                0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
                0xff, 0x35, ...u32(at('code')),
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const root = await mkdtemp(join(tmpdir(), 'btl-src-'));
        const out = await mkdtemp(join(tmpdir(), 'btl-out-'));
        t.after(()=>rm(root, { recursive: true, force: true }));
        t.after(()=>rm(out, { recursive: true, force: true }));
        await writeFile(join(root, 'child.exe'), child);
        const path = join(out, 'bundle.btl');
        await writeBundle({ root, output: path, blockSize: BLOCK_SIZE });
        const handle = await open(path, 'r');
        t.after(()=>handle.close());
        let heads = 0;
        /** @param {number} offset @param {number} length */
        const readCounting = async(offset, length)=>{
            if (offset === 0)
            {
                heads++;
            }
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, offset);
            return new Uint8Array(buffer);
        };
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\parent.exe',
            bundle: { prefix: '', fetch: readCounting },
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 60_000 }), 7, 'the child ran, from the bundle');
        assert.equal(heads, 1, 'and the bundle\'s head was read once for both processes');
    });

/**
 * A program that reads a file from its start to its end, 16 KiB a ReadFile, as
 * a game loading a level reads an archive, and exits.
 *
 * @param {string} path
 */
function buildReaderExe(path){
    // Placed in the image as data, whose builder spreads it into arguments: more
    // than this and the spread overflows the stack.
    const CHUNK = 0x4000;
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateFileA', 'ReadFile', 'ExitProcess'] },
        codeSize: 0x80,
        data: {
            path: [...path].map(c=>c.charCodeAt(0)).concat(0),
            counted: [0, 0, 0, 0],
            buffer: new Array(CHUNK).fill(0),
        },
        code: ({ iat, at })=>assemble([
            // CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL)
            0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x03, 0x6a, 0x00, 0x6a, 0x01,
            0x68, ...u32(0x80000000), 0x68, ...u32(at('path')),
            0xff, 0x15, ...u32(iat('CreateFileA')),
            0x89, 0xc3, //                                      mov ebx, eax
            { label: 'read' },
            0x6a, 0x00, 0x68, ...u32(at('counted')), 0x68, ...u32(CHUNK),
            0x68, ...u32(at('buffer')), 0x53,
            0xff, 0x15, ...u32(iat('ReadFile')),
            0xa1, ...u32(at('counted')), //                     mov eax, [counted]
            0x85, 0xc0, //                                      test eax, eax
            { jump: 'jnz', to: 'read' },
            0x6a, 0x00,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ]),
    });
}

/**
 * A program that reads 16 KiB of a file at every `STRIDE` bytes, `count` times, as a player
 * seeks through an archive - every read a block no other read touches - and exits.
 *
 * @param {string} path @param {number} count
 */
function buildScatteredReaderExe(path, count){
    const CHUNK = 0x4000;
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateFileA', 'SetFilePointer', 'ReadFile', 'ExitProcess'] },
        codeSize: 0x80,
        data: {
            path: [...path].map(c=>c.charCodeAt(0)).concat(0),
            counted: [0, 0, 0, 0],
            buffer: new Array(CHUNK).fill(0),
        },
        code: ({ iat, at })=>assemble([
            0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x03, 0x6a, 0x00, 0x6a, 0x01,
            0x68, ...u32(0x80000000), 0x68, ...u32(at('path')),
            0xff, 0x15, ...u32(iat('CreateFileA')),
            0x89, 0xc3, //                                      mov ebx, eax
            0x31, 0xf6, //                                      xor esi, esi
            { label: 'read' },
            // SetFilePointer(ebx, esi * STRIDE, NULL, FILE_BEGIN)
            0x6a, 0x00, 0x6a, 0x00,
            0x89, 0xf0, //                                      mov eax, esi
            0xc1, 0xe0, SCATTER_SHIFT, //                       shl eax, SCATTER_SHIFT
            0x50, 0x53,
            0xff, 0x15, ...u32(iat('SetFilePointer')),
            0x6a, 0x00, 0x68, ...u32(at('counted')), 0x68, ...u32(CHUNK),
            0x68, ...u32(at('buffer')), 0x53,
            0xff, 0x15, ...u32(iat('ReadFile')),
            0x46, //                                            inc esi
            0x83, 0xfe, count, //                               cmp esi, count
            { jump: 'jl', to: 'read' },
            0x6a, 0x00,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ]),
    });
}

/** The stride of `buildScatteredReaderExe`'s reads, as a shift: 512 KiB. */
const SCATTER_SHIFT = 19;

test('a read of a bundle in a file on this device waits for its own blocks alone, what is '
    + 'around and ahead of them read behind it', { timeout: 60000 }, async t=>{
    // A bottle kept in the browser is read from its file a range at a time; a miss widened
    // to a window there was waited for whole, eight blocks for each one asked, and a game
    // seeking through its films stood still for all of them at each.
    const READS = 20;
    const source = await bundleWith(PLANTED, READS << SCATTER_SHIFT);
    t.after(()=>source.cleanup());
    // A read of more than the two blocks one ReadFile of 16 KiB can span is one around or
    // ahead of a miss: it never answers, so a read that waited for one never ends.
    let behind = 0;
    /** @param {number} offset @param {number} length */
    const file = (offset, length)=>{
        if (length > 2 * BLOCK_SIZE && source.fetched.calls > 0)
        {
            behind++;
            return new Promise(()=>{});
        }
        return source.fetch(offset, length);
    };
    const app = await createApp({
        executable: buildScatteredReaderExe('C:\\Data\\big.bin', READS),
        bundle: { fetch: file, local: true, prefix: '', store: null, prefetch: false },
    });
    t.after(()=>app.dispose());

    const opened = source.fetched.bytes;
    assert.equal(await app.run({ maxTurns: 200000, timeoutMs: 20000 }), 0);
    assert.ok(source.fetched.bytes - opened >= READS * BLOCK_SIZE, 'every read reached the file');
    assert.ok(behind > 0, 'the blocks around a miss were asked for, behind its read');
});

for (const local of [false, true])
{
    test(local
        ? 'a bundle in a file on this device is read as it is: no checksum, no second read'
        : 'a block that arrives damaged from a server is asked for again', { timeout: 60000 },
    async t=>{
        // A bottle kept in the browser is the only copy there is: a block read
        // again from its file is the same bytes, and nothing could fetch a good
        // one. Checked on every read, a game whose files outgrew the block cache
        // had its engine thread computing the checksums of the same blocks over
        // and over (Outlast's menu: 1.7 s of a minute) while its reads waited.
        const source = await bundleWith(PLANTED, 2 << 20);
        t.after(()=>source.cleanup());
        let damaged = 0;
        let opened = Infinity;
        /** @param {number} offset @param {number} length */
        const flaky = async(offset, length)=>{
            const bytes = await source.fetch(offset, length);
            // The first read after opening loses its last byte to the wire.
            if (source.fetched.calls > opened && damaged === 0)
            {
                damaged++;
                bytes[bytes.length - 1] ^= 0xff;
            }
            return bytes;
        };
        const app = await createApp({
            executable: buildReaderExe('C:\\Data\\big.bin'),
            bundle: { fetch: flaky, ...local ? { local: true } : {}, prefix: '', store: null,
                prefetch: false },
        });
        t.after(()=>app.dispose());
        let retried = 0;
        app.on('bundle-retry', ()=>retried++);
        opened = source.fetched.calls;
        assert.equal(await app.run({ maxTurns: 200000, timeoutMs: 20000 }), 0);
        assert.equal(damaged, 1, 'a read came back damaged');
        assert.equal(retried, local ? 0 : 1, local ? 'the file was read once, as it is'
            : 'the damaged block was asked for again');
    });
}

test('a far bundle is read in wide windows: a forward reader waits for a round trip or two',
    { timeout: 60000 }, async t=>{
        // A bucket this far away: each request waits this long before its bytes,
        // as R2 behind its domain answered a third of a second for any range.
        const LINK_MS = 400;
        const FILE_BYTES = 12 << 20;
        const source = await bundleWith(PLANTED, FILE_BYTES);
        t.after(()=>source.cleanup());
        /** @param {number} offset @param {number} length */
        const far = async(offset, length)=>{
            await new Promise(resolve=>setTimeout(resolve, LINK_MS));
            return source.fetch(offset, length);
        };
        const app = await createApp({
            executable: buildReaderExe('C:\\Data\\big.bin'),
            // Kept on a store, as a browser keeps them; the filler kept out: what
            // is counted is the requests the program's own reads waited for.
            bundle: { fetch: far, prefix: '', prefetch: false, store: fakeStore(), id: 'far' },
        });
        t.after(()=>app.dispose());
        const opened = source.fetched.calls;

        assert.equal(await app.run({ maxTurns: 200000, timeoutMs: 40000 }), 0);

        // Two mebibytes a window, and two more ahead of a forward reader, were
        // four round trips and more for this file; sized by the round trip the
        // opening measured, one window holds all of it.
        const reads = source.fetched.calls - opened;
        assert.ok(reads <= 2, `the file came in ${reads} requests`);
        assert.ok(source.fetched.bytes <= source.summary.bytes + BLOCK_SIZE,
            'nothing was fetched twice');
    });

test('a far bundle with nowhere to keep its blocks is read in near windows, never twice over',
    { timeout: 60000 }, async t=>{
        const LINK_MS = 400;
        const source = await bundleWith(PLANTED, 12 << 20);
        t.after(()=>source.cleanup());
        let widest = 0;
        /** @param {number} offset @param {number} length */
        const far = async(offset, length)=>{
            widest = Math.max(widest, length);
            await new Promise(resolve=>setTimeout(resolve, LINK_MS));
            return source.fetch(offset, length);
        };
        const app = await createApp({
            executable: buildReaderExe('C:\\Data\\big.bin'),
            // No store: the blocks live in a heap cache of a few windows.
            bundle: { fetch: far, prefix: '', store: null, prefetch: false },
        });
        t.after(()=>app.dispose());

        assert.equal(await app.run({ maxTurns: 200000, timeoutMs: 40000 }), 0);

        // A window and what is read ahead of it, as on a near bundle: wider ones
        // would evict each other out of a cache this size.
        assert.ok(widest <= 2 * READ_AHEAD_BYTES + BLOCK_SIZE, `a request of ${widest} bytes`);
        assert.ok(source.fetched.bytes <= source.summary.bytes + BLOCK_SIZE,
            `${source.fetched.bytes} bytes fetched for a bundle of ${source.summary.bytes}`);
    });

test('a preloaded bundle is here whole before the program starts, and nothing it reads waits',
    { timeout: 60000 }, async t=>{
        const source = await bundleWith(PLANTED, 6 << 20);
        t.after(()=>source.cleanup());
        /** @type {any[]} */
        const told = [];
        const app = await createApp({
            executable: buildReaderExe('C:\\Data\\big.bin'),
            bundle: {
                fetch: source.fetch, prefix: '', prefetch: false, store: fakeStore(), id: 'whole',
                preload: true, progress: (/** @type {any} */ state)=>told.push(state),
            },
        });
        t.after(()=>app.dispose());
        const opened = { calls: source.fetched.calls, bytes: source.fetched.bytes };

        const last = told.at(-1);
        assert.ok(last && last.total > 0 && last.bytes === last.total,
            `the preload said it ended whole (${JSON.stringify(last)})`);
        assert.ok(told.length >= 2, 'and said where it began and where it ended');
        assert.ok(opened.bytes >= source.summary.bytes - (1 << 20),
            'the bundle came in before the start');

        let waited = 0;
        app.on('bundle-fetching', ()=>{
            waited++;
        });
        assert.equal(await app.run({ maxTurns: 200000, timeoutMs: 40000 }), 0);
        assert.equal(source.fetched.calls, opened.calls, 'the program read it without a request');
        assert.equal(waited, 0, 'and no wait for the bundle was told');
    });

test('a preload with nowhere to keep the blocks says so and the program reads as it goes',
    { timeout: 60000 }, async t=>{
        const source = await bundleWith(PLANTED);
        t.after(()=>source.cleanup());
        /** @type {any[]} */
        const told = [];
        const app = await createApp({
            executable: buildReaderExe('C:\\Data\\big.bin'),
            bundle: { fetch: source.fetch, prefix: '', store: null, preload: true,
                progress: (/** @type {any} */ state)=>told.push(state) },
        });
        t.after(()=>app.dispose());
        assert.equal(told.length, 1);
        assert.equal(typeof told[0].unbacked, 'string');
        assert.equal(await app.run({ maxTurns: 200000, timeoutMs: 40000 }), 0);
    });

test('a bundle whose program sits past the quota starts, its late blocks read first',
    { timeout: 120_000 }, async t=>{
        // The file the fixture reads is packed after 2048 blocks of filler,
        // the way a game keeps its program past gigabytes of archives. A store
        // whose quota is short of that offset refused the first write of a
        // cache laid out at index * blockSize, and the start failed.
        const filler = 2048 * BLOCK_SIZE;
        const source = await bundleWith(PLANTED, filler + BLOCK_SIZE);
        t.after(()=>source.cleanup());
        const quota = filler / 8;
        const store = fakeStore();
        const files = new Map();
        /** @param {string} path @param {number} at @param {Uint8Array} bytes */
        const write = (path, at, bytes)=>{
            const size = Math.max(store.stat(path)?.size ?? 0, at + bytes.length);
            const total = [...files].reduce((sum, [name, held])=>sum + (name === path ? 0 : held),
                size);
            if (total > quota)
            {
                throw new DOMException('past the quota', 'QuotaExceededError');
            }
            files.set(path, size);
            store.write(path, at, bytes);
        };
        const app = await createApp({
            executable: new Uint8Array(await readFile(FIXTURE)),
            bundle: { fetch: source.fetch, prefix: '', prefetch: false, id: 'late',
                store: { ...store, write } },
        });
        t.after(()=>app.dispose());
        let printed = '';
        app.on('output', (/** @type {any} */ payload)=>{
            printed += payload.text;
        });
        assert.equal(await app.run({ maxTurns: 20000, timeoutMs: 60_000 }), 0);
        assert.equal(printed, PLANTED);
        const packs = [...files.keys()].filter(path=>/\.pack\.\d+$/.test(path));
        assert.ok(packs.length === 1 && (files.get(packs[0]) ?? 0) > BLOCK_SIZE / 2,
            `kept on the store, as long as the blocks read: ${JSON.stringify([...files])}`);
    });
