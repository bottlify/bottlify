/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a program linked for a base in the heap's span is placed: one linked for ASLR where
 * programs usually are, one that is not at its own base, as Windows keeps it. The program
 * exits with the high half of what GetModuleHandle(NULL) answers - its base.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/** @param {boolean} dynamicBase */
function program(dynamicBase){
    return buildExe({
        imports: { 'KERNEL32.dll': ['GetModuleHandleA', 'ExitProcess'] },
        imageBase: 0x10000000,
        dynamicBase,
        // A relocation directory, so the image may move; the code below holds no
        // absolute address of its own.
        data: { anchor: u32(0) },
        relocations: { anchor: [0] },
        code: ({ iat, code })=>{
            // call $+5; pop ebx: ebx is the address of the pop, and every call goes
            // through [ebx + the distance to its IAT slot].
            const here = code(5);
            /** @param {string} name */
            const call = name=>[0xff, 0x93, ...u32((iat(name) - here) >>> 0)];
            return [0xe8, 0, 0, 0, 0, 0x5b, 0x6a, 0, ...call('GetModuleHandleA'),
                0xc1, 0xe8, 0x10, 0x50, ...call('ExitProcess')];
        },
    });
}

for (const [dynamicBase, expected] of /** @type {const} */ ([[true, 0x40], [false, 0x1000]]))
{
    test(`a program linked for 0x10000000 ${dynamicBase ? 'with' : 'without'} DYNAMIC_BASE runs`
        + ` at 0x${(expected << 16).toString(16)}`, { timeout: 30000 }, async t=>{
        const app = await createApp({ executable: program(dynamicBase),
            imagePath: 'C:\\App\\based.exe' });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 20000 }), expected);
    });
}
