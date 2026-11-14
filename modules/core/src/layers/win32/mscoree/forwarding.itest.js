/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mscoree as a program reaches it on Windows 7: a compiled program imports
 * GetCORVersion from it and calls it twice. With a shim implementation where
 * the .NET Framework 4 puts it, both calls reach that library's export with
 * the program's arguments and stack as they came, and only the first crosses
 * into the host; without one, both answer CLR_E_SHIM_RUNTIMELOAD, and
 * _CorExeMain ends the process, said as a loss. On XP there is no mscoree of
 * the engine's, and its file version on 7 is past what the .NET Framework
 * 4.8's setup asks for. Its export 142, by number alone, is GetVersionExW.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';
import { CLR_E_SHIM_RUNTIMELOAD, STATUS_DLL_NOT_FOUND } from './functions.js';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
/** @param {string} text */
const ansi = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

const SHIM = 'C:\\WINDOWS\\Microsoft.NET\\Framework\\v4.0.30319\\mscoreei.dll';
/** What the program's two calls add up to, with the stack as it was, or BAD. */
const BAD = 0xbad;

/** GetCORVersion(buffer, 32, &length) twice: the sum, BAD when ESP moved. */
const twice = buildExe({
    imports: { 'mscoree.dll': ['GetCORVersion'], 'KERNEL32.dll': ['ExitProcess'] },
    data: { buffer: new Array(64).fill(0), length: u32(0) },
    codeSize: 0x60,
    code: ({ iat, at })=>{
        const call = [0x68, ...u32(at('length')), 0x6a, 0x20, 0x68, ...u32(at('buffer')),
            0xff, 0x15, ...u32(iat('GetCORVersion'))];
        return assemble([
            0x89, 0xe3, //                         mov ebx, esp
            ...call,
            0x89, 0xc6, //                         mov esi, eax
            ...call,
            0x01, 0xc6, //                         add esi, eax
            0x39, 0xe3, //                         cmp ebx, esp
            { jump: 'jz', to: 'out' },
            0xbe, ...u32(BAD), //                  mov esi, BAD
            { label: 'out' },
            0x56, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ]);
    },
});

/**
 * The shim's implementation, as far as this program needs it: GetCORVersion
 * answers its second argument plus 0x100 and takes its three off the stack.
 */
const shim = buildExe({
    dll: true,
    imageBase: 0x10000000,
    imports: { 'KERNEL32.dll': ['GetCurrentThreadId'] },
    exports: [{ name: 'GetCORVersion', offset: 0x10 }],
    codeSize: 0x20,
    code: ()=>[
        0xb8, ...u32(1), 0xc2, 0x0c, 0x00, //  DllMain: mov eax, TRUE; ret 12
        ...new Array(0x10 - 8).fill(0xcc),
        0x8b, 0x44, 0x24, 0x08, //             mov eax, [esp+8]
        0x05, ...u32(0x100), //                add eax, 0x100
        0xc2, 0x0c, 0x00, //                   ret 12
    ],
});

/**
 * @param {Uint8Array} executable
 * @param {{ windows?: import('../kernel32/versions.js').WindowsName,
 *     files?: { path: string, bytes: Uint8Array }[] }} [options]
 */
async function run(executable, options = {}){
    const app = await createApp({ executable, imagePath: 'C:\\App\\managed.exe',
        windows: 'win7', ...options });
    /** @type {any[]} */
    const said = [];
    app.on('divergence', (/** @type {any} */ event)=>said.push(event));
    app.on('loss', (/** @type {any} */ event)=>said.push({ ...event, kind: 'loss' }));
    try
    {
        const code = (await app.run({ timeoutMs: 60_000 })) >>> 0;
        const tables = await app.diagnostics();
        const bridge = (Array.isArray(tables) ? tables : [])
            .find(table=>table.name === 'bridge');
        /** @type {string[]} */
        const byFunction = bridge?.metrics?.byFunction ?? [];
        /** @param {string} name */
        const crossings = name=>Number(byFunction.find(line=>line.startsWith(`${name} `))
            ?.split(' ')[1] ?? 0);
        return { code, said, crossings };
    }
    finally
    {
        await app.dispose();
    }
}

test('mscoree forwards each call to mscoreei as it came, crossing into the host once',
    { timeout: 120_000 }, async()=>{
        const { code, crossings } = await run(twice, { files: [{ path: SHIM, bytes: shim }] });
        assert.equal(code, 2 * (0x20 + 0x100), 'both calls reached the shim, the stack kept');
        assert.equal(crossings('mscoree.dll!GetCORVersion'), 1,
            'the second call stayed in the guest');
    });

test('without the .NET Framework, mscoree answers that the runtime cannot be loaded',
    { timeout: 120_000 }, async()=>{
        const { code, said } = await run(twice);
        assert.equal(code, (2 * CLR_E_SHIM_RUNTIMELOAD) >>> 0);
        assert.equal(said.filter(event=>event.kind === 'loss').length, 0,
            'the documented answer is no loss');
    });

test('without the .NET Framework, _CorExeMain ends the process and says why',
    { timeout: 120_000 }, async()=>{
        const managed = buildExe({
            imports: { 'mscoree.dll': ['_CorExeMain'] },
            code: ({ iat })=>[0xff, 0x25, ...u32(iat('_CorExeMain'))],
        });
        const { code, said } = await run(managed);
        assert.equal(code, STATUS_DLL_NOT_FOUND);
        const loss = said.find(event=>event.api === '_CorExeMain');
        assert.ok(loss, 'said');
        assert.match(loss.detail, /no \.NET Framework is installed/);
    });

test('Windows XP has no mscoree of the engine\'s; 7\'s is new enough for .NET 4.8\'s setup',
    { timeout: 120_000 }, async()=>{
        const probe = buildExe({
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'ExitProcess'],
                'VERSION.dll': ['GetFileVersionInfoA', 'VerQueryValueA'] },
            data: { name: ansi('mscoree.dll'),
                path: ansi('C:\\WINDOWS\\system32\\mscoree.dll'), root: ansi('\\'),
                block: new Array(0x800).fill(0), info: u32(0), size: u32(0) },
            codeSize: 0x80,
            code: ({ iat, at })=>assemble([
                // On XP: LoadLibraryA("mscoree.dll"), the exit code.
                0x68, ...u32(at('name')), 0xff, 0x15, ...u32(iat('LoadLibraryA')),
                0x85, 0xc0, { jump: 'jz', to: 'out' },
                // Otherwise the file version's major and minor, read through
                // GetFileVersionInfoA and VerQueryValueA("\").
                0x68, ...u32(at('block')), 0x68, ...u32(0x800), 0x6a, 0x00,
                0x68, ...u32(at('path')), 0xff, 0x15, ...u32(iat('GetFileVersionInfoA')),
                0x68, ...u32(at('size')), 0x68, ...u32(at('info')), 0x68, ...u32(at('root')),
                0x68, ...u32(at('block')), 0xff, 0x15, ...u32(iat('VerQueryValueA')),
                0x8b, 0x05, ...u32(at('info')), //          mov eax, [info]
                0x8b, 0x40, 0x08, //                        mov eax, [eax+8]  dwFileVersionMS
                { label: 'out' },
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ]),
        });
        assert.equal((await run(probe, { windows: 'winxp' })).code, 0, 'XP: not found');
        const seven = (await run(probe)).code;
        assert.ok(seven >= 0x00040000, `7: version ${seven.toString(16)} is at least 4.0`);
    });

test('mscoree\'s export 142, which has no name, is GetVersionExW', { timeout: 120_000 },
    async()=>{
        // GetProcAddress(LoadLibraryA("mscoree.dll"), 142) called with an
        // OSVERSIONINFOW: the exit code is its major version times 100 plus its minor.
        const probe = buildExe({
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetProcAddress', 'ExitProcess'] },
            data: { name: ansi('mscoree.dll'), info: [...u32(276), ...new Array(272).fill(0)] },
            codeSize: 0x60,
            code: ({ iat, at })=>assemble([
                0x68, ...u32(at('name')), 0xff, 0x15, ...u32(iat('LoadLibraryA')),
                0x68, ...u32(142), 0x50, 0xff, 0x15, ...u32(iat('GetProcAddress')),
                0x85, 0xc0, { jump: 'jz', to: 'out' },
                0x68, ...u32(at('info')), 0xff, 0xd0, //    call eax
                0x6b, 0x05, ...u32(at('info') + 4), 100, // imul eax, [major], 100
                0x03, 0x05, ...u32(at('info') + 8), //       add eax, [minor]
                { label: 'out' },
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ]),
        });
        assert.equal((await run(probe)).code, 601);
    });
