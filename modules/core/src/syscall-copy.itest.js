/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ntdll's system calls run wherever their bytes are copied: on Windows each is
 * a few position-independent instructions entering the kernel, and a program
 * may copy one elsewhere and call the copy (Wine's ntdll virtual.c,
 * test_syscalls, "syscall thunk copy").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

const STATUS_INVALID_HANDLE = 0xc0000008;

test('a copy of NtClose\'s bytes closes a handle as NtClose does', { timeout: 60_000 }, async t=>{
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['GetModuleHandleA', 'GetProcAddress', 'VirtualAlloc',
            'CreateEventA', 'ExitProcess'] },
        data: { ntdll: cString('ntdll.dll'), name: cString('NtClose') },
        codeSize: 0x100,
        code: ({ iat, at })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {number} code ExitProcess(code), 8 bytes. */
            const exit = code=>[0x6a, code, ...call('ExitProcess')];
            return [
                0x68, ...u32(at('ntdll')), ...call('GetModuleHandleA'),
                0x68, ...u32(at('name')), 0x50, ...call('GetProcAddress'),
                0x89, 0xc6, //                          mov esi, eax
                0x6a, 0x40, 0x68, ...u32(0x1000), 0x68, ...u32(0x1000), 0x6a, 0,
                ...call('VirtualAlloc'),
                0x89, 0xc7, //                          mov edi, eax
                0x57, 0xb9, ...u32(8), 0xf3, 0xa5, 0x5f, // 32 bytes: rep movsd
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, ...call('CreateEventA'),
                0x89, 0xc3, //                          mov ebx, eax
                0x53, 0xff, 0xd7, //                    push ebx / call edi
                0x85, 0xc0, 0x74, 8, ...exit(2), //     closed
                0x53, 0xff, 0xd7, //                    and again
                0x3d, ...u32(STATUS_INVALID_HANDLE), 0x74, 8, ...exit(3),
                ...exit(100),
            ];
        },
    });
    const app = await createApp({ executable });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 30_000 }), 100,
        '2: the copy did not close the event; 3: closing it twice was not refused');
});
