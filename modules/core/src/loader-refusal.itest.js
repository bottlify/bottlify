/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A static import found nowhere: Windows creates the process and its loader
 * ends it in its first thread with STATUS_DLL_NOT_FOUND, before any of it runs;
 * a library Windows carries that the engine does not recreate is the engine's
 * gap, and the program starts (decisions.md A256).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';
import { waitingParent } from '../../../tools/fixtures/spawn-program.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

const STATUS_DLL_NOT_FOUND = 0xc0000135;

/**
 * A program that imports one function of `library` and, if it runs at all,
 * exits with 7.
 *
 * @param {string} library
 */
const importing = library=>buildExe({
    imports: { [library]: ['Anything'], 'KERNEL32.dll': ['ExitProcess'] },
    code: ({ iat })=>[0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))],
});

test('a program whose static import is found nowhere ends with STATUS_DLL_NOT_FOUND before it runs',
    { timeout: 60_000 }, async t=>{
        const app = await createApp({ executable: importing('nowhere.dll') });
        t.after(()=>app.dispose());
        /** @type {any[]} */
        const refused = [];
        app.on('libraries-not-found', (/** @type {any} */ event)=>refused.push(event.names));
        assert.equal((await app.run({ timeoutMs: 30_000 })) >>> 0, STATUS_DLL_NOT_FOUND,
            'the program\'s own exit (7) never ran');
        assert.deepEqual(refused, [['nowhere.dll']], 'said, with the name');
    });

test('an x86-64 program whose static import is found nowhere ends the same way',
    { timeout: 60_000 }, async t=>{
        const app = await createApp({ executable: buildExe({
            bits: 64,
            imports: { 'nowhere.dll': ['Anything'], 'KERNEL32.dll': ['ExitProcess'] },
            code: ({ iat, code })=>{
                // sub rsp, 40 / mov ecx, 7 / call [rip + ExitProcess]
                const head = [0x48, 0x83, 0xec, 0x28, 0xb9, ...u32(7), 0xff, 0x15];
                return [...head, ...u32(iat('ExitProcess') - (code(head.length) + 4))];
            },
        }) });
        t.after(()=>app.dispose());
        assert.equal((await app.run({ timeoutMs: 30_000 })) >>> 0, STATUS_DLL_NOT_FOUND);
    });

test('a library Windows carries and the engine does not recreate lets the program start',
    { timeout: 60_000 }, async t=>{
        // wlanapi.dll is in system32 on Windows and not among the engine's
        // libraries: the gap is the engine's, as it was before this rule.
        const app = await createApp({ executable: importing('wlanapi.dll') });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30_000 }), 7);
    });

test('a library a later Windows brings is found nowhere on an earlier one',
    { timeout: 60_000 }, async t=>{
        // xaudio2_8.dll came with Windows 8: on Windows 7 a program that
        // imports it does not start; on Windows 10 the gap is the engine's.
        const seven = await createApp({ executable: importing('xaudio2_8.dll'), windows: 'win7' });
        t.after(()=>seven.dispose());
        assert.equal((await seven.run({ timeoutMs: 30_000 })) >>> 0, STATUS_DLL_NOT_FOUND);
        const ten = await createApp({ executable: importing('xaudio2_8.dll'), windows: 'win10' });
        t.after(()=>ten.dispose());
        assert.equal(await ten.run({ timeoutMs: 30_000 }), 7);
    });

test('a child whose static import is found nowhere is started and ends with STATUS_DLL_NOT_FOUND',
    { timeout: 60_000 }, async t=>{
        // CreateProcess succeeds, as on Windows; the parent reads the child's
        // exit code and exits with it.
        const app = await createApp({
            executable: waitingParent('C:\\App\\child.exe'),
            imagePath: 'C:\\App\\parent.exe',
            storage: { load: async()=>({ files: [
                { path: 'C:\\App\\child.exe', bytes: importing('nowhere.dll') }] }) },
        });
        t.after(()=>app.dispose());
        assert.equal((await app.run({ timeoutMs: 30_000 })) >>> 0, STATUS_DLL_NOT_FOUND);
    });
