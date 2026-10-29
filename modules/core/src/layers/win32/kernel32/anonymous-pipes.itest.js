/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CreatePipe's pair read and written by a guest, through a duplicate of the
 * write end after the original is closed -- what a program does that hands
 * one end of a pipe to another process and keeps the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

test('an anonymous pipe carries bytes through a duplicate of its write end', { timeout: 60000 },
    async t=>{
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['CreatePipe', 'DuplicateHandle', 'CloseHandle',
                'WriteFile', 'ReadFile', 'ExitProcess'] },
            data: { r: [0, 0, 0, 0], w: [0, 0, 0, 0], d: [0, 0, 0, 0], n: [0, 0, 0, 0],
                hi: [104, 105], got: [0, 0, 0, 0] },
            codeSize: 0x90,
            code: ({ iat, at })=>[
                // CreatePipe(&r, &w, NULL, 0)
                0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(at('w')), 0x68, ...u32(at('r')),
                0xff, 0x15, ...u32(iat('CreatePipe')),
                // DuplicateHandle(-1, w, -1, &d, 0, FALSE, DUPLICATE_SAME_ACCESS)
                0x6a, 0x02, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(at('d')), 0x6a, 0xff,
                0xff, 0x35, ...u32(at('w')), 0x6a, 0xff,
                0xff, 0x15, ...u32(iat('DuplicateHandle')),
                // CloseHandle(w): the duplicate keeps the pipe whole
                0xff, 0x35, ...u32(at('w')), 0xff, 0x15, ...u32(iat('CloseHandle')),
                // WriteFile(d, "hi", 2, &n, NULL)
                0x6a, 0x00, 0x68, ...u32(at('n')), 0x6a, 0x02, 0x68, ...u32(at('hi')),
                0xff, 0x35, ...u32(at('d')), 0xff, 0x15, ...u32(iat('WriteFile')),
                // ReadFile(r, got, 4, &n, NULL)
                0x6a, 0x00, 0x68, ...u32(at('n')), 0x6a, 0x04, 0x68, ...u32(at('got')),
                0xff, 0x35, ...u32(at('r')), 0xff, 0x15, ...u32(iat('ReadFile')),
                // exit (n << 8) | got[0]
                0xa1, ...u32(at('n')), 0xc1, 0xe0, 0x08,
                0x0f, 0xb6, 0x0d, ...u32(at('got')), 0x09, 0xc8,
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const app = await createApp({ executable, engine: 'cork' });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30000 }), (2 << 8) | 'h'.charCodeAt(0));
    });
