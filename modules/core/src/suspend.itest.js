/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread created with CREATE_SUSPENDED does not run until ResumeThread,
 * whose first call answers a previous count of one; and once it has ended,
 * SuspendThread on it fails with ERROR_ACCESS_DENIED -- as Wine's thread test
 * has both -- and a poll of a set holding it finds it signalled. The program
 * checks one property per bit of its exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const CREATE_SUSPENDED = 0x4;

/**
 * Exit code bits: the thread had not run while its creator slept (1), the
 * first ResumeThread answered one (2), and once resumed it ran (4). Ended,
 * it cannot be suspended (8), and the error says why (0x10); and it is
 * signalled to WaitForMultipleObjects with no time to wait (0x20).
 */
const ALL = 0x3f;
const ERROR_ACCESS_DENIED = 5;

function buildProgram(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'ResumeThread', 'SuspendThread', 'Sleep',
            'WaitForSingleObject', 'WaitForMultipleObjects', 'GetLastError', 'ExitProcess'] },
        data: { ran: [0, 0, 0, 0], handles: [0, 0, 0, 0] },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** or ebx, bit -- six bytes, which is what each skip jumps over. */
            const flag = (/** @type {number} */ bit)=>[0x81, 0xcb, ...u32(bit)];
            const JNE = 0x75;
            /** @param {number} start */
            const main = start=>[
                0x31, 0xdb, //                                   xor ebx, ebx
                0x6a, 0x00, 0x6a, CREATE_SUSPENDED, 0x6a, 0x00, // id, flags, parameter
                0x68, ...u32(start), 0x6a, 0x00, 0x6a, 0x00, //  start, stack, attributes
                ...call('CreateThread'),
                0x89, 0xc6, //                                   mov esi, eax
                0x6a, 50, ...call('Sleep'),
                0x83, 0x3d, ...u32(at('ran')), 0x00, JNE, 6, ...flag(0x1),
                0x56, ...call('ResumeThread'),
                0x83, 0xf8, 0x01, JNE, 6, ...flag(0x2), //       cmp eax, 1
                0x6a, 0xff, 0x56, ...call('WaitForSingleObject'),
                0x83, 0x3d, ...u32(at('ran')), 0x01, JNE, 6, ...flag(0x4),
                0x56, ...call('SuspendThread'),
                0x83, 0xf8, 0xff, JNE, 6, ...flag(0x8), //       cmp eax, -1
                ...call('GetLastError'),
                0x83, 0xf8, ERROR_ACCESS_DENIED, JNE, 6, ...flag(0x10),
                0x89, 0x35, ...u32(at('handles')), //            mov [handles], esi
                0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(at('handles')), 0x6a, 0x01,
                ...call('WaitForMultipleObjects'),
                0x85, 0xc0, JNE, 6, ...flag(0x20), //            WAIT_OBJECT_0
                0x53, ...call('ExitProcess'),
            ];
            const thread = [
                0xc7, 0x05, ...u32(at('ran')), ...u32(1), //     mov dword [ran], 1
                0x31, 0xc0, //                                   xor eax, eax
                0xc2, 0x04, 0x00, //                             ret 4
            ];
            const length = main(0).length;
            return [...main(code(length)), ...thread];
        },
    });
}

test('a thread created suspended waits for ResumeThread, and one ended cannot be suspended',
    { timeout: 60000 }, async t=>{
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const app = await createApp({
            executable: buildProgram(),
            imagePath: 'C:\\App\\Suspend.exe',
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
        });
        t.after(()=>app.dispose());

        const code = await app.run({ timeoutMs: 40000 });
        assert.equal(code, ALL, `missing bits 0x${(ALL & ~code).toString(16)}`);
    });
