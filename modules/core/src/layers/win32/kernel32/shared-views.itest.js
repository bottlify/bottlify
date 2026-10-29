/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shared memory between two guest processes, as a client and its helper
 * process pass state: the parent makes a named page-file section and writes
 * a word into its view; the child opens the section by name, reads the word
 * through a view of its own and writes the next one; the parent, once the
 * child has ended, reads what the child wrote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);
/** @param {number} size */
const zeros = size=>new Array(size).fill(0);

const CHILD = 'C:\\App\\child.exe';
const NAME = 'Local\\bottlify_shared';

/** The child: the section by name, its first word plus one written after it. */
const child = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['OpenFileMappingA', 'MapViewOfFile', 'ExitProcess'] },
    data: { name: cString(NAME) },
    codeSize: 0x40,
    code: ({ iat, at })=>[
        0x68, ...u32(at('name')),
        0x6a, 0x00, //                                  push FALSE
        0x68, ...u32(0xf001f), //                       push FILE_MAP_ALL_ACCESS
        0xff, 0x15, ...u32(iat('OpenFileMappingA')),
        0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, //          the whole section
        0x68, ...u32(0xf001f),
        0x50, //                                        push the mapping
        0xff, 0x15, ...u32(iat('MapViewOfFile')),
        0x8b, 0x08, //                                  mov ecx, [eax]
        0x41, //                                        inc ecx
        0x89, 0x48, 0x04, //                            mov [eax + 4], ecx
        0x51, //                                        push ecx
        0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** The parent: the section, a word in it, the child, then the child's word. */
const parent = ()=>buildExe({
    imports: {
        'KERNEL32.dll': ['CreateFileMappingA', 'MapViewOfFile', 'CreateProcessA',
            'WaitForSingleObject', 'ExitProcess'],
    },
    data: {
        name: cString(NAME),
        line: cString(CHILD),
        si: [...u32(68), ...zeros(64)],
        pi: zeros(16),
    },
    codeSize: 0x80,
    code: ({ iat, at })=>[
        // CreateFileMappingA(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, 4096, name)
        0x68, ...u32(at('name')),
        0x68, ...u32(4096),
        0x6a, 0x00, 0x6a, 0x04, 0x6a, 0x00, 0x6a, 0xff,
        0xff, 0x15, ...u32(iat('CreateFileMappingA')),
        0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
        0x68, ...u32(0xf001f),
        0x50,
        0xff, 0x15, ...u32(iat('MapViewOfFile')),
        0x89, 0xc6, //                                  mov esi, eax
        0xc7, 0x06, ...u32(0x1234), //                  mov dword [esi], 0x1234
        // CreateProcessA(NULL, line, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)
        0x68, ...u32(at('pi')),
        0x68, ...u32(at('si')),
        0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
        0x68, ...u32(at('line')),
        0x6a, 0x00,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        0x6a, 0xff,
        0xff, 0x35, ...u32(at('pi')),
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0xff, 0x76, 0x04, //                            push dword [esi + 4]
        0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

test('a word one process writes into a shared section the other reads, and back',
    { timeout: 120000 }, async t=>{
        const app = await createApp({
            executable: parent(),
            imagePath: 'C:\\App\\parent.exe',
            files: [{ path: CHILD, bytes: child() }],
            engine: 'cork',
        });
        t.after(()=>app.dispose());
        /** @type {number[]} */
        const children = [];
        app.on('process-resumed', (/** @type {any} */ event)=>children.push(event.code));
        const code = await app.run({ timeoutMs: 60000 });
        assert.deepEqual(children, [0x1235], 'the child read the parent\'s word');
        assert.equal(code, 0x1235, 'and the parent the child\'s');
    });
