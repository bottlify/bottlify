/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program built against the core API sets, as a browser's executable is:
 * `api-ms-win-core-*` binds to kernel32 (kernelbase's functions, which are
 * kernel32's here) and the registry's sets to advapi32, and GetModuleHandle
 * names a set's module as the library's own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, moduleKeyOf } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

test('the core sets are kernel32, the registry and tracing sets advapi32, winrt neither', ()=>{
    assert.equal(moduleKeyOf('api-ms-win-core-file-l1-1-0.dll'), 'kernel32');
    assert.equal(moduleKeyOf('API-MS-WIN-CORE-LIBRARYLOADER-L1-2-0.DLL'), 'kernel32');
    assert.equal(moduleKeyOf('api-ms-win-core-localregistry-l1-1-0.dll'), 'advapi32');
    assert.equal(moduleKeyOf('api-ms-win-core-registry-l1-1-0.dll'), 'advapi32');
    assert.equal(moduleKeyOf('api-ms-win-eventing-provider-l1-1-0.dll'), 'advapi32');
    assert.equal(moduleKeyOf('api-ms-win-security-base-l1-1-0.dll'), 'advapi32');
    assert.equal(moduleKeyOf('api-ms-win-core-winrt-l1-1-0.dll'), 'api-ms-win-core-winrt-l1-1-0');
    assert.equal(moduleKeyOf('api-ms-win-crt-heap-l1-1-0.dll'), 'ucrtbase');
});

test('a program importing the core sets is bound to kernel32 and advapi32',
    { timeout: 60000 }, async t=>{
        const SET = 'api-ms-win-core-processthreads-l1-1-0.dll';
        const executable = buildExe({
            imports: {
                [SET]: ['GetCurrentProcessId', 'ExitProcess'],
                'api-ms-win-core-localregistry-l1-1-0.dll': ['RegCloseKey'],
                'KERNEL32.dll': ['GetModuleHandleA'],
            },
            data: { set: cString(SET), kernel: cString('kernel32.dll') },
            codeSize: 0x80,
            code: ({ iat, at })=>[
                0x68, ...u32(at('set')),
                0xff, 0x15, ...u32(iat('GetModuleHandleA')),
                0x89, 0xc3, //                                  mov ebx, eax
                0x68, ...u32(at('kernel')),
                0xff, 0x15, ...u32(iat('GetModuleHandleA')),
                0x29, 0xd8, //                                  sub eax, ebx: 0 when one module
                0x89, 0xc6, //                                  mov esi, eax
                0x85, 0xdb, //                                  test ebx, ebx
                0x75, 0x05, //                                  jnz +5
                0xbe, ...u32(100), //                           mov esi, 100: no module at all
                0xff, 0x15, ...u32(iat('GetCurrentProcessId')),
                0x85, 0xc0, //                                  test eax, eax
                0x75, 0x05, //                                  jnz +5
                0xbe, ...u32(200), //                           mov esi, 200: no process id
                0x6a, 0x00, //                                  push 0
                0xff, 0x15, ...u32(iat('RegCloseKey')), //      ERROR_INVALID_HANDLE
                0x01, 0xf0, //                                  add eax, esi
                0x50, //                                        push eax
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const app = await createApp({ executable, engine: 'cork' });
        t.after(()=>app.dispose());
        const code = await app.run({ timeoutMs: 30000 });
        assert.equal(code, 6, 'RegCloseKey(NULL) answered, the set kernel32 by handle');
    });
