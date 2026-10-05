/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A child in a worker of its own (roadmap/v2, stage 2): its machine in that
 * worker, the run's registry, volume, windows and ids answered from the
 * parent's thread across a link. The compiled parent starts its child twice
 * and checks, one property per line, what each left: the exit code, the file
 * it wrote, the registry value it set, a wait for any of a set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { READ_AHEAD_BYTES, createApp } from './app.js';
import { writeBundle } from './bundle-node.js';
import { buildExe } from '../../../tools/make-pe.mjs';

test('a child in a worker of its own leaves its parent its file, its registry value and its code',
    { timeout: 120000 }, async t=>{
        const [parent, child] = await Promise.all([
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            engine: 'cork',
            mode: 'workers',
            processWorkers: true,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        /** @type {any[]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>started.push(event));
        const code = await app.run({ timeoutMs: 60000 });
        const lines = output.join('').split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>line.startsWith('FAIL')), [], output.join(''));
        assert.equal(lines.filter(line=>line.startsWith('ok   ')).length, 10, output.join(''));
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')),
            ['child: first', 'child: second', 'parent: done'],
            'each child\'s output reached the run, before the parent went on');
        assert.equal(code, 0);
        assert.deepEqual(started.map(event=>event.worker), [true, true],
            'both ran in workers of their own');
    });

test('a child in a worker of its own reads what the run\'s bundle has not fetched yet',
    { timeout: 120000 }, async t=>{
        const u32 = (/** @type {number} */ value)=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
        // CreateFileA("C:\\z\\data.bin", GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, 0, 0);
        // ReadFile(it, &byte, 1, &read, 0); ExitProcess(byte)
        const child = buildExe({
            imports: { 'KERNEL32.dll': ['CreateFileA', 'ReadFile', 'ExitProcess'] },
            data: { path: [...Buffer.from('C:\\z\\data.bin'), 0], byte: u32(0), read: u32(0) },
            code: ({ iat, at })=>[
                0x6a, 0, 0x6a, 0, 0x6a, 3, 0x6a, 0, 0x6a, 1, 0x68, ...u32(0x80000000),
                0x68, ...u32(at('path')), 0xff, 0x15, ...u32(iat('CreateFileA')),
                0x6a, 0, 0x68, ...u32(at('read')), 0x6a, 1, 0x68, ...u32(at('byte')), 0x50,
                0xff, 0x15, ...u32(iat('ReadFile')),
                0xff, 0x35, ...u32(at('byte')), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const parent = buildExe({
            imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject',
                'GetExitCodeProcess', 'ExitProcess'] },
            data: {
                command: [...Buffer.from('C:\\a.exe'), 0],
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
        await writeFile(join(root, 'a.exe'), child);
        // Far enough past the image that fetching it does not bring the data.
        await mkdir(join(root, 'm'));
        await writeFile(join(root, 'm', 'big.bin'), randomBytes(4 * READ_AHEAD_BYTES));
        await mkdir(join(root, 'z'));
        await writeFile(join(root, 'z', 'data.bin'), Uint8Array.of(0x2a));
        const path = join(out, 'bundle.btl');
        await writeBundle({ root, output: path, blockSize: 64 * 1024 });
        const handle = await open(path, 'r');
        t.after(()=>handle.close());
        /** @type {[number, number][]} */
        const asked = [];
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\parent.exe',
            engine: 'cork',
            mode: 'workers',
            processWorkers: true,
            bundle: { prefix: '', store: null, fetch: async(offset, length)=>{
                asked.push([offset, length]);
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, offset);
                return new Uint8Array(buffer);
            } },
        });
        t.after(()=>app.dispose());
        /** @type {any[]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>started.push(event.worker));
        const before = { count: 0 };
        app.on('process-started', ()=>{
            before.count = asked.length;
        });
        assert.equal(await app.run({ timeoutMs: 60000 }), 0x2a,
            'the child read its byte out of the bundle');
        assert.deepEqual(started, [true]);
        assert.ok(asked.length > before.count,
            'and the read was a miss the run fetched for it, across the link');
    });
