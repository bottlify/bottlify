/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * KUSER_SHARED_DATA as a program reads it: by address, with no call.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../../../app.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24 & 0xff];

/** @param {'winxp' | 'win7'} [windows] */
async function exitCode(windows){
    // Two gigabytes, as a game is given: the page is at the top of them.
    const memorySize = 0x80000000;
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['GetTickCount', 'ExitProcess'] },
        codeSize: 0x80,
        data: {},
        code: ({ iat })=>[
            0xa1, ...u32(0x7ffe026c), //               mov eax, [NtMajorVersion]
            0xc1, 0xe0, 0x08, //                       shl eax, 8
            0x0b, 0x05, ...u32(0x7ffe0270), //         or eax, [NtMinorVersion]
            0x89, 0xc3, //                             mov ebx, eax
            0xff, 0x15, ...u32(iat('GetTickCount')),
            0x2b, 0x05, ...u32(0x7ffe0320), //         sub eax, [TickCount.LowPart]
            0x83, 0xf8, 0x40, //                       cmp eax, 64: the page's ticks keep up
            0x72, 0x05, //                             jb ok
            0xbb, ...u32(0xdead), //                   mov ebx, 0xdead
            0x53, //                                   ok: push ebx
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const app = await createApp({ executable, memorySize, ...(windows ? { windows } : {}) });
    try
    {
        return await app.run({ timeoutMs: 60_000 }) >>> 0;
    }
    finally
    {
        await app.dispose();
    }
}

test('the shared page says the version every other road says, and keeps the tick count', async()=>{
    assert.equal(await exitCode(), 0x0501, 'XP by default: NtMajorVersion 5, NtMinorVersion 1');
    assert.equal(await exitCode('win7'), 0x0601);
});
