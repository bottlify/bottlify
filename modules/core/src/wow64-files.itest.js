/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WOW64's file system redirection as a 32-bit program on a 64-bit Windows
 * meets it (`wow64-files.js`): a file it creates in the system folder lands in
 * SysWOW64; with redirection turned off for its thread
 * (Wow64DisableWow64FsRedirection) it lands in System32, and back on
 * (Wow64RevertWow64FsRedirection) in SysWOW64 again; Sysnative is System32. A
 * 32-bit program alone, on a 32-bit Windows, has its System32.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
/** @param {string} text */
const ansi = text=>[...Buffer.from(`${text}\0`, 'latin1')];

const NAMES = {
    on: 'C:\\WINDOWS\\system32\\probe-on.txt',
    off: 'C:\\WINDOWS\\system32\\probe-off.txt',
    native: 'C:\\WINDOWS\\Sysnative\\probe-native.txt',
    again: 'C:\\WINDOWS\\system32\\probe-again.txt',
};

/** Creates each file in turn, redirection off for the second, then exits 0. */
function program(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateFileA', 'CloseHandle', 'Wow64DisableWow64FsRedirection',
            'Wow64RevertWow64FsRedirection', 'ExitProcess'] },
        data: { ...Object.fromEntries(Object.entries(NAMES).map(([key, path])=>[key, ansi(path)])),
            old: [0, 0, 0, 0] },
        codeSize: 0x100,
        code: ({ iat, at })=>{
            /** @param {string} name */
            const create = name=>[
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x02, 0x6a, 0x00, 0x6a, 0x00, // template..share
                0x68, ...u32(0x40000000),                       // GENERIC_WRITE
                0x68, ...u32(at(name)),
                0xff, 0x15, ...u32(iat('CreateFileA')),
                0x50, 0xff, 0x15, ...u32(iat('CloseHandle')),
            ];
            return [
                ...create('on'),
                0x68, ...u32(at('old')), 0xff, 0x15, ...u32(iat('Wow64DisableWow64FsRedirection')),
                ...create('off'),
                0xff, 0x35, ...u32(at('old')),
                0xff, 0x15, ...u32(iat('Wow64RevertWow64FsRedirection')),
                ...create('native'),
                ...create('again'),
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
}

/** @param {any} app @param {string} folder */
const namesIn = (app, folder)=>app.files.list(folder)
    .map((/** @type {any} */ entry)=>entry.path.slice(entry.path.lastIndexOf('\\') + 1))
    .filter((/** @type {string} */ name)=>name.startsWith('probe-')).sort();

test('a 32-bit program on a 64-bit Windows reaches SysWOW64 for its system folder, unless its'
    + ' thread turned that off, and System32 as Sysnative', { timeout: 60000 }, async t=>{
    const app = await createApp({ executable: program(), machine: 'amd64' });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 50000 }), 0);
    assert.deepEqual(namesIn(app, 'C:\\WINDOWS\\SysWOW64'), ['probe-again.txt', 'probe-on.txt']);
    assert.deepEqual(namesIn(app, 'C:\\WINDOWS\\system32'), ['probe-native.txt', 'probe-off.txt']);
});

/** A library of each width that does nothing but load. @param {32 | 64} bits */
const library = bits=>buildExe({ dll: true, bits, imageBase: bits === 64 ? 0x180000000 : 0x10000000,
    imports: {}, codeSize: 0x10,
    code: ()=>[0xb8, 1, 0, 0, 0, bits === 64 ? 0xc3 : 0xc2, ...bits === 64 ? [] : [0x0c, 0x00]] });

test('a 32-bit program on a 64-bit Windows loads a system library from SysWOW64, where the'
    + ' 32-bit one is, not the 64-bit one in System32', { timeout: 60000 }, async t=>{
    const loader = buildExe({
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'ExitProcess'] },
        data: { name: ansi('wowprobe.dll') },
        code: ({ iat, at })=>[
            0x68, ...u32(at('name')), 0xff, 0x15, ...u32(iat('LoadLibraryA')),
            0x85, 0xc0, 0x0f, 0x94, 0xc0, 0x0f, 0xb6, 0xc0,  // test eax, eax; sete al; movzx
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const app = await createApp({ executable: loader, imagePath: 'C:\\App\\loader.exe',
        machine: 'amd64', files: [
            { path: 'C:\\WINDOWS\\SysWOW64\\wowprobe.dll', bytes: library(32) },
            { path: 'C:\\WINDOWS\\system32\\wowprobe.dll', bytes: library(64) },
        ] });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 50000 }), 0, 'LoadLibraryA found the 32-bit one');
});

test('a 32-bit program on a 32-bit Windows over a 64-bit one\'s volume is told it is not under'
    + ' WOW64, and still reaches the 32-bit libraries in SysWOW64', { timeout: 60000 }, async t=>{
    // Exits with a bit a wrong answer each: 1 IsWow64Process said TRUE, 2 the
    // library did not load, 4 GetNativeSystemInfo named another processor than the i386.
    const probe = buildExe({
        imports: { 'KERNEL32.dll': ['IsWow64Process', 'LoadLibraryA', 'GetNativeSystemInfo',
            'ExitProcess'] },
        data: { name: ansi('wowprobe.dll'), out: [0, 0, 0, 0], info: new Array(36).fill(0) },
        codeSize: 0x80,
        code: ({ iat, at })=>[
            0x68, ...u32(at('out')), 0x6a, 0xff, 0xff, 0x15, ...u32(iat('IsWow64Process')),
            0x68, ...u32(at('info')), 0xff, 0x15, ...u32(iat('GetNativeSystemInfo')),
            0x68, ...u32(at('name')), 0xff, 0x15, ...u32(iat('LoadLibraryA')),
            0x85, 0xc0, 0x0f, 0x94, 0xc0, 0x0f, 0xb6, 0xc0,  // test eax, eax; sete al; movzx
            0x01, 0xc0,                                      // add eax, eax
            0x0b, 0x05, ...u32(at('out')),                   // or eax, [out]
            0x0f, 0xb7, 0x0d, ...u32(at('info')),            // movzx ecx, word [info]
            0x85, 0xc9, 0x0f, 0x95, 0xc1, 0x0f, 0xb6, 0xc9,  // test ecx, ecx; setne cl; movzx
            0xc1, 0xe1, 0x02, 0x09, 0xc8,                    // shl ecx, 2; or eax, ecx
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const app = await createApp({ executable: probe, imagePath: 'C:\\App\\probe.exe',
        machine: 'x86', layout: 'amd64', files: [
            { path: 'C:\\WINDOWS\\SysWOW64\\wowprobe.dll', bytes: library(32) },
            { path: 'C:\\WINDOWS\\system32\\wowprobe.dll', bytes: library(64) },
        ] });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 50000 }), 0);
});

test('a 32-bit program on a 32-bit Windows has its System32', { timeout: 60000 }, async t=>{
    const app = await createApp({ executable: program() });
    t.after(()=>app.dispose());
    await app.run({ timeoutMs: 50000 });
    assert.deepEqual(namesIn(app, 'C:\\WINDOWS\\system32'),
        ['probe-again.txt', 'probe-off.txt', 'probe-on.txt'],
        'redirection is WOW64\'s: turning it off is refused there, and nothing moves');
});
