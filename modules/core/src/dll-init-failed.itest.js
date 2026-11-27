/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library whose initialisation fails is not loaded: a DllMain that answers
 * FALSE to DLL_PROCESS_ATTACH is told DLL_PROCESS_DETACH and unloaded, and one
 * that raises is ended by the loader's own frame, its exception never reaching
 * the program. Either way LoadLibrary answers NULL with ERROR_DLL_INIT_FAILED
 * and the library is not among the process's modules (DllMain's contract;
 * Wine's kernel32:loader loads libraries whose entry points fault).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const ERROR_DLL_INIT_FAILED = 1114;
/** What the program exits with when the library was loaded after all. */
const LOADED = 0xee;

/**
 * A library whose DllMain runs `attach` on DLL_PROCESS_ATTACH and answers
 * TRUE to every other reason.
 *
 * @param {number[]} attach  ends with the answer in EAX and `ret 12`
 */
const library = attach=>buildExe({
    dll: true,
    imageBase: 0x10000000,
    imports: { 'KERNEL32.dll': ['GetCurrentThreadId'] },
    code: ()=>[
        0x83, 0x7c, 0x24, 0x08, 0x01, // cmp dword [esp+8], DLL_PROCESS_ATTACH
        0x74, 0x08, // je attach
        0xb8, ...u32(1), // mov eax, TRUE
        0xc2, 0x0c, 0x00, // ret 12
        ...attach,
    ],
});

/** A program that loads C:\App\lib.dll and exits with the error, or LOADED. */
const program = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetModuleHandleA', 'GetLastError',
        'ExitProcess'] },
    data: { name: [...'C:\\App\\lib.dll'].map(c=>c.charCodeAt(0)).concat(0) },
    code: ({ iat, at })=>{
        const call = (/** @type {string} */ name)=>[0xff, 0x15, ...u32(iat(name))];
        const loaded = [0x68, ...u32(LOADED), ...call('ExitProcess')];
        const check = [0x85, 0xc0, 0x75, 0x00]; // test eax, eax / jnz loaded (patched)
        const body = [
            0x68, ...u32(at('name')), ...call('LoadLibraryA'), ...check,
            ...call('GetLastError'), 0x89, 0xc3, // mov ebx, eax
            0x68, ...u32(at('name')), ...call('GetModuleHandleA'), ...check,
            0x53, ...call('ExitProcess'),
        ];
        // Each jnz skips to the exit with LOADED placed after the body.
        let index = -1;
        while ((index = body.indexOf(0x75, index + 1)) >= 0)
        {
            if (body[index - 2] === 0x85 && body[index - 1] === 0xc0)
            {
                body[index + 1] = body.length - (index + 2);
            }
        }
        return [...body, ...loaded];
    },
});

/** @param {Uint8Array} lib */
const run = async(/** @type {any} */ t, lib)=>{
    const app = await createApp({
        executable: program(), imagePath: 'C:\\App\\main.exe',
        storage: { load: async()=>({ files: [{ path: 'C:\\App\\lib.dll', bytes: lib }] }) },
    });
    t.after(()=>app.dispose());
    return await app.run({ timeoutMs: 30_000 }) >>> 0;
};

test('a DllMain that answers FALSE fails the load and leaves no module', { timeout: 60_000 },
    async t=>{
        // attach: xor eax, eax / ret 12
        assert.equal(await run(t, library([0x31, 0xc0, 0xc2, 0x0c, 0x00])), ERROR_DLL_INIT_FAILED);
    });

test('a DllMain that faults fails the load, the program never seeing the exception',
    { timeout: 60_000 }, async t=>{
        // attach: mov eax, [0] / ret 12
        assert.equal(await run(t, library([0xa1, ...u32(0), 0xc2, 0x0c, 0x00])),
            ERROR_DLL_INIT_FAILED);
    });

test('a DllMain that answers TRUE is loaded', { timeout: 60_000 }, async t=>{
    assert.equal(await run(t, library([0xb8, ...u32(1), 0xc2, 0x0c, 0x00])), LOADED);
});
