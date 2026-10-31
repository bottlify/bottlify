/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program of the universal runtime: it imports the C library through the
 * `api-ms-win-crt-*` API sets, which Windows 10 resolves to ucrtbase.dll by its
 * schema, prints through `__stdio_common_vfprintf` to the stream
 * `__acrt_iob_func` hands it, and never loads msvcrt.dll -- whose image held
 * the standard streams, so they were records at address zero before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

const STDIO = 'api-ms-win-crt-stdio-l1-1-0.dll';
const RUNTIME = 'api-ms-win-crt-runtime-l1-1-0.dll';

test('a program of the universal runtime prints through its API sets, bound to ucrtbase',
    { timeout: 60000 }, async t=>{
        const executable = buildExe({
            imports: {
                [STDIO]: ['__acrt_iob_func', '__stdio_common_vfprintf'],
                [RUNTIME]: ['exit'],
                'KERNEL32.dll': ['GetModuleHandleA'],
            },
            data: {
                format: cString('%s %d\n'),
                word: cString('ucrt'),
                set: cString(STDIO),
                ucrt: cString('ucrtbase.dll'),
            },
            codeSize: 0x80,
            code: ({ iat, at })=>[
                0x6a, 42, //                                    push 42
                0x68, ...u32(at('word')), //                    push "ucrt": the va_list
                0x89, 0xe6, //                                  mov esi, esp
                0x6a, 0x01, //                                  push 1: stdout
                0xff, 0x15, ...u32(iat('__acrt_iob_func')),
                0x83, 0xc4, 0x04, //                            add esp, 4
                0x56, //                                        push esi: args
                0x6a, 0x00, //                                  push 0: locale
                0x68, ...u32(at('format')), //                  push format
                0x50, //                                        push eax: the stream
                0x6a, 0x00, 0x6a, 0x00, //                      push 0, 0: the options
                0xff, 0x15, ...u32(iat('__stdio_common_vfprintf')),
                0x83, 0xc4, 0x20, //                            add esp, 24 + the two values
                0x68, ...u32(at('set')),
                0xff, 0x15, ...u32(iat('GetModuleHandleA')),
                0x89, 0xc3, //                                  mov ebx, eax
                0x68, ...u32(at('ucrt')),
                0xff, 0x15, ...u32(iat('GetModuleHandleA')),
                0x39, 0xd8, //                                  cmp eax, ebx
                0x0f, 0x95, 0xc0, //                            setne al
                0x0f, 0xb6, 0xc0, //                            movzx eax, al
                0x85, 0xdb, //                                  test ebx, ebx
                0x75, 0x05, //                                  jnz +5
                0xb8, ...u32(2), //                             mov eax, 2: no module at all
                0x50, //                                        push eax
                0xff, 0x15, ...u32(iat('exit')),
            ],
        });
        const app = await createApp({ executable });
        t.after(()=>app.dispose());
        let printed = '';
        app.on('output', (/** @type {{ text: string }} */ { text })=>{
            printed += text;
        });

        const code = await app.run({ timeoutMs: 30000 });

        assert.equal(printed, 'ucrt 42\n', 'printed to the stream __acrt_iob_func gave');
        assert.equal(code, 0, 'the API set is ucrtbase.dll by handle, as Windows answers it');
    });
