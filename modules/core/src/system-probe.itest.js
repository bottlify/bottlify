/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * LoadLibraryEx of libraries every Windows has, through `createApp`, with
 * LOAD_LIBRARY_SEARCH_SYSTEM32: a statically linked runtime loads cryptnet,
 * cryptbase and msasn1 that way to learn whether the flag is understood, and
 * asked again on every call while they were missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const cString = text=>[...new TextEncoder().encode(text), 0];

const NAMES = ['cryptnet.dll', 'cryptbase.dll', 'msasn1.dll'];
const LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x800;

test('the system libraries a runtime probes with LoadLibraryEx are there',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            codeSize: 0x100,
            imports: { 'KERNEL32.dll': ['LoadLibraryExA', 'ExitProcess'] },
            data: Object.fromEntries(NAMES.map((name, index)=>[`n${index}`, cString(name)])),
            code: ({ iat, at })=>{
            /** @type {number[]} */
                const bytes = [0x31, 0xdb]; // xor ebx, ebx: how many loaded
                NAMES.forEach((_, index)=>{
                    bytes.push(0x68, ...u32(LOAD_LIBRARY_SEARCH_SYSTEM32), 0x6a, 0x00);
                    bytes.push(0x68, ...u32(at(`n${index}`)));
                    bytes.push(0xff, 0x15, ...u32(iat('LoadLibraryExA')));
                    bytes.push(0x85, 0xc0, 0x74, 0x01, 0x43); // test eax, eax; jz +1; inc ebx
                });
                bytes.push(0x53, 0xff, 0x15, ...u32(iat('ExitProcess')));
                return bytes;
            },
        });
        const app = await createApp({ executable: program });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), NAMES.length);
    });
