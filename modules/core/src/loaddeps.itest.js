/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library loaded at run time brings in the libraries it imports, and every
 * one of their entry points runs on the thread that called LoadLibrary, as
 * Windows runs them under the loader lock of that thread.
 *
 * The dependencies are loaded after the loader has awaited the file, and by
 * then the processor is another thread's: the libraries come out of a bundle
 * whose blocks arrive a timer later, as over a network, and the program keeps
 * a second thread spinning, so the thread on the processor while a.dll's
 * dependency b.dll is attached is never the one that asked. b.dll's DllMain writes the
 * thread it ran on into an exported variable; the program reads it back and
 * exits with 1 when it was its own thread, 2 when it was another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { writeBundle } from './bundle-node.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/** b.dll: its DllMain stores GetCurrentThreadId in `tid`, which it exports. */
function libraryB(){
    return buildExe({
        dll: true,
        imageBase: 0x10000000,
        imports: { 'KERNEL32.dll': ['GetCurrentThreadId'] },
        // Data starts at the end of the code budget: `tid` is the first of it.
        data: { tid: u32(0) },
        exports: [{ name: 'tid', offset: 0x40 }],
        code: ({ iat, at })=>[
            0x8b, 0x44, 0x24, 0x08, // mov eax, [esp+8]   fdwReason
            0x83, 0xf8, 0x01, // cmp eax, DLL_PROCESS_ATTACH
            0x75, 0x0b, // jne done
            0xff, 0x15, ...u32(iat('GetCurrentThreadId')),
            0xa3, ...u32(at('tid')), // mov [tid], eax
            0xb8, 0x01, 0x00, 0x00, 0x00, // done: mov eax, TRUE
            0xc2, 0x0c, 0x00, // ret 12
        ],
    });
}

/** a.dll: imports `tid` from b.dll, so loading it loads b.dll. */
function libraryA(){
    return buildExe({
        dll: true,
        imageBase: 0x11000000,
        imports: { 'b.dll': ['tid'] },
        code: ()=>[0xb8, 0x01, 0x00, 0x00, 0x00, 0xc2, 0x0c, 0x00],
    });
}

function program(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'LoadLibraryA', 'GetModuleHandleA',
            'GetProcAddress', 'GetCurrentThreadId', 'ExitProcess'] },
        data: { a: cString('a.dll'), b: cString('b.dll'), tid: cString('tid') },
        codeSize: 0x80,
        code: ({ iat, at, code })=>{
            /** @type {number[]} */
            const bytes = [];
            const call = (/** @type {string} */ name)=>bytes.push(0xff, 0x15, ...u32(iat(name)));
            // The worker: a thread that is always ready to run.
            const workerAt = 0x70;
            bytes.push(0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(workerAt)),
                0x6a, 0x00, 0x6a, 0x00);
            call('CreateThread');
            bytes.push(0x68, ...u32(at('a')));
            call('LoadLibraryA');
            bytes.push(0x85, 0xc0); // test eax, eax
            const toFail = [bytes.push(0x74, 0x00) - 1]; // jz fail
            bytes.push(0x68, ...u32(at('b')));
            call('GetModuleHandleA');
            bytes.push(0x68, ...u32(at('tid')), 0x50); // push "tid"; push eax
            call('GetProcAddress');
            bytes.push(0x8b, 0x30); // mov esi, [eax]
            call('GetCurrentThreadId');
            bytes.push(0x39, 0xf0); // cmp eax, esi
            toFail.push(bytes.push(0x75, 0x00) - 1); // jne fail
            bytes.push(0x6a, 0x01);
            call('ExitProcess');
            const fail = bytes.length;
            bytes.push(0x6a, 0x02);
            call('ExitProcess');
            for (const place of toFail)
            {
                bytes[place] = fail - (place + 1);
            }
            while (bytes.length < workerAt)
            {
                bytes.push(0xcc);
            }
            bytes.push(0xeb, 0xfe); // worker: jmp worker
            return bytes;
        },
    });
}

test('a run-time library\'s dependencies attach on the thread that asked for it',
    { timeout: 60000 }, async t=>{
        const root = await mkdtemp(join(tmpdir(), 'deps-src-'));
        const out = await mkdtemp(join(tmpdir(), 'deps-out-'));
        await writeFile(join(root, 'a.dll'), libraryA());
        await writeFile(join(root, 'b.dll'), libraryB());
        const path = join(out, 'bundle.btl');
        await writeBundle({ root, output: path, blockSize: 4096 });
        const handle = await open(path, 'r');
        t.after(async()=>{
            await handle.close();
            await rm(root, { recursive: true, force: true });
            await rm(out, { recursive: true, force: true });
        });
        const app = await createApp({
            executable: program(),
            imagePath: 'C:\\App\\deps.exe',
            bundle: {
                prefix: 'App',
                // A block arrives a timer later, as over a network.
                fetch: async(/** @type {number} */ offset, /** @type {number} */ length)=>{
                    await new Promise(resolve=>setTimeout(resolve, 5));
                    const buffer = Buffer.alloc(length);
                    await handle.read(buffer, 0, length, offset);
                    return new Uint8Array(buffer);
                },
            },
        });
        t.after(()=>app.dispose());
        const code = await app.run({ timeoutMs: 40000 });
        assert.equal(code, 1, 'b.dll attached on another thread than the one loading a.dll');
    });
