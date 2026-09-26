/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ReadFileEx and WriteFileEx from a guest program, as Wine's file and pipe
 * tests have them: the transfer happens at the OVERLAPPED's offset, the
 * completion routine is not called before the call returns but at the
 * thread's next alertable wait -- which then answers WAIT_IO_COMPLETION --
 * with the error, the count and the OVERLAPPED; and a read at the end of the
 * file fails with ERROR_HANDLE_EOF and queues nothing. The program checks one
 * property per bit of its exit code.
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

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

const GENERIC_READ_WRITE = 0xc0000000;
const OPEN_EXISTING = 3;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const WAIT_IO_COMPLETION = 0xc0;
const ERROR_HANDLE_EOF = 38;

/**
 * Exit code bits: the read was accepted (1) and its routine not yet called
 * (2); SleepEx then answered WAIT_IO_COMPLETION (4) having called it once (8)
 * with four bytes (0x10) and the OVERLAPPED (0x20), the bytes from offset two
 * (0x40). The write was accepted (0x80), its routine called at the next
 * alertable sleep (0x100) with two bytes (0x200). A read at the end failed
 * (0x400) with ERROR_HANDLE_EOF (0x800) and queued nothing (0x1000).
 */
const ALL = 0x1fff;

function buildProgram(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateFileA', 'ReadFileEx', 'WriteFileEx', 'SleepEx',
            'GetLastError', 'ExitProcess'] },
        data: {
            name: cString('C:\\App\\data.bin'),
            text: cString('XY'),
            // OVERLAPPED: Internal, InternalHigh, Offset, OffsetHigh, hEvent.
            overlapped: [...u32(0), ...u32(0), ...u32(2), ...u32(0), ...u32(0)],
            buffer: new Array(16).fill(0),
            calls: [0, 0, 0, 0], error: [0, 0, 0, 0], count: [0, 0, 0, 0], seen: [0, 0, 0, 0],
        },
        codeSize: 0x200,
        code: ({ iat, at, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            const push = (/** @type {number} */ value)=>[0x68, ...u32(value)];
            /** or ebx, bit -- six bytes, which is what each skip jumps over. */
            const flag = (/** @type {number} */ bit)=>[0x81, 0xcb, ...u32(bit)];
            const JNE = 0x75;
            const JE = 0x74;
            /** @param {string} name @param {number} value @param {number} bit */
            const holds = (name, value, bit)=>[
                0x81, 0x3d, ...u32(at(name)), ...u32(value), JNE, 6, ...flag(bit),
            ];
            /** @param {number} offset */
            const offsetIs = offset=>[0xc7, 0x05, ...u32(at('overlapped') + 8), ...u32(offset)];
            const alertableSleep = [0x6a, 0x01, 0x6a, 0x00, ...call('SleepEx')];

            /** @param {number} routine */
            const main = routine=>[
                0x31, 0xdb, //                                       xor ebx, ebx
                0x6a, 0x00, ...push(FILE_FLAG_OVERLAPPED), 0x6a, OPEN_EXISTING, 0x6a, 0x00,
                0x6a, 0x00, ...push(GENERIC_READ_WRITE), ...push(at('name')),
                ...call('CreateFileA'),
                0x89, 0xc6, //                                       mov esi, eax
                ...push(routine), ...push(at('overlapped')), 0x6a, 16, ...push(at('buffer')),
                0x56, ...call('ReadFileEx'),
                0x85, 0xc0, JE, 6, ...flag(0x1),
                ...holds('calls', 0, 0x2),
                ...alertableSleep,
                0x3d, ...u32(WAIT_IO_COMPLETION), JNE, 6, ...flag(0x4),
                ...holds('calls', 1, 0x8),
                ...holds('count', 4, 0x10),
                ...holds('seen', at('overlapped'), 0x20),
                ...holds('buffer', 0x66656463, 0x40), //             "cdef"
                ...offsetIs(6),
                ...push(routine), ...push(at('overlapped')), 0x6a, 2, ...push(at('text')),
                0x56, ...call('WriteFileEx'),
                0x85, 0xc0, JE, 6, ...flag(0x80),
                ...alertableSleep,
                ...holds('calls', 2, 0x100),
                ...holds('count', 2, 0x200),
                ...offsetIs(8),
                ...push(routine), ...push(at('overlapped')), 0x6a, 16, ...push(at('buffer')),
                0x56, ...call('ReadFileEx'),
                0x85, 0xc0, JNE, 6, ...flag(0x400),
                ...call('GetLastError'),
                0x3d, ...u32(ERROR_HANDLE_EOF), JNE, 6, ...flag(0x800),
                ...alertableSleep,
                ...holds('calls', 2, 0x1000),
                0x53, ...call('ExitProcess'), //                     push ebx
            ];
            // VOID CALLBACK routine(DWORD error, DWORD count, LPOVERLAPPED):
            // records its arguments and counts the call.
            const routine = [
                0x8b, 0x44, 0x24, 0x04, 0xa3, ...u32(at('error')),
                0x8b, 0x44, 0x24, 0x08, 0xa3, ...u32(at('count')),
                0x8b, 0x44, 0x24, 0x0c, 0xa3, ...u32(at('seen')),
                0xff, 0x05, ...u32(at('calls')), //                  inc dword [calls]
                0xc2, 0x0c, 0x00, //                                 ret 12
            ];
            const length = main(0).length;
            return [...main(code(length)), ...routine];
        },
    });
}

test('ReadFileEx and WriteFileEx finish through a routine run at an alertable wait',
    { timeout: 60000 }, async t=>{
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const app = await createApp({
            executable: buildProgram(),
            imagePath: 'C:\\App\\FileEx.exe',
            files: [{ path: 'C:\\App\\data.bin', bytes: new TextEncoder().encode('abcdef') }],
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
        });
        t.after(()=>app.dispose());

        const code = await app.run({ timeoutMs: 40000 });
        assert.equal(code, ALL, `missing bits 0x${(ALL & ~code).toString(16)}`);
    });
