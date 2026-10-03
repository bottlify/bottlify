/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * FS names the running thread's TEB whatever a program does to the register:
 * `push fs; pop fs` reloads it from its descriptor, which the thread switch
 * keeps on the thread's TEB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** Exits with FS's selector when FS:[0x18] reads the same TEB after a reload, 1 otherwise. */
const program = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    data: {},
    codeSize: 0x40,
    code: ({ iat })=>[
        0x64, 0xa1, 0x18, 0, 0, 0,                // mov eax, fs:[0x18]
        0x0f, 0xa0, 0x0f, 0xa1,                   // push fs; pop fs
        0x64, 0x8b, 0x1d, 0x18, 0, 0, 0,          // mov ebx, fs:[0x18]
        0x39, 0xd8,                               // cmp eax, ebx
        0x75, 0x09,                               // jne fail
        0x8c, 0xe1,                               // mov ecx, fs
        0x51,                                     // push ecx
        0xff, 0x15, ...u32(iat('ExitProcess')),   // call [ExitProcess]
        0x6a, 0x01,                               // fail: push 1
        0xff, 0x15, ...u32(iat('ExitProcess')),   // call [ExitProcess]
    ],
});

test('a reloaded FS still names the thread\'s TEB', { timeout: 60000 }, async t=>{
    const app = await createApp({ executable: program() });
    t.after(()=>app.dispose());
    const code = await app.run({ timeoutMs: 20000 });
    assert.equal(code, 0x18, 'the same TEB after the reload, and the thread\'s selector');
});
