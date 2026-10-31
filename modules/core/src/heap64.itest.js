/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit process's heap, through `createApp`: every block HeapAlloc and
 * malloc hand out starts on 16 bytes, Windows x64's
 * MEMORY_ALLOCATION_ALIGNMENT, the small blocks the guest's own routines
 * hand out and the large ones the host's alike. Code built for x64 stores
 * XMM registers into a block with `movdqa` -- a jmp_buf at a structure's
 * start -- and faults on one eight bytes off. The program ORs the low four
 * bits of every block into its exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** The sizes asked for, small and large, each twice so a cache is drawn from too. */
const SIZES = [1, 8, 24, 40, 56, 0x510, 1, 8, 24, 40, 56, 0x510, 0x2000, 100];

test('a 64-bit process\'s heap blocks start on 16 bytes, HeapAlloc\'s and malloc\'s',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            bits: 64, codeSize: 0x400,
            imports: { 'KERNEL32.dll': ['GetProcessHeap', 'HeapAlloc', 'ExitProcess'],
                'msvcrt.dll': ['malloc'] },
            code: ({ iat, code })=>{
                /** @type {number[]} */
                const bytes = [];
                /** @param {number[]} op @param {string} name  a call through a slot */
                const slot = (op, name)=>{
                    bytes.push(...op, ...u32(iat(name) - (code(bytes.length) + op.length + 4)));
                };
                bytes.push(0x48, 0x83, 0xec, 0x28); // sub rsp, 40
                bytes.push(0x31, 0xdb); // xor ebx, ebx
                slot([0xff, 0x15], 'GetProcessHeap');
                bytes.push(0x48, 0x89, 0xc6); // mov rsi, rax
                for (const size of SIZES)
                {
                    bytes.push(0x48, 0x89, 0xf1, 0x31, 0xd2); // mov rcx, rsi; xor edx, edx
                    bytes.push(0x41, 0xb8, ...u32(size)); // mov r8d, size
                    slot([0xff, 0x15], 'HeapAlloc');
                    bytes.push(0x09, 0xc3); // or ebx, eax
                    bytes.push(0xb9, ...u32(size)); // mov ecx, size
                    slot([0xff, 0x15], 'malloc');
                    bytes.push(0x09, 0xc3); // or ebx, eax
                }
                bytes.push(0x83, 0xe3, 0x0f, 0x89, 0xd9); // and ebx, 15; mov ecx, ebx
                slot([0xff, 0x15], 'ExitProcess');
                return bytes;
            },
        });
        const app = await createApp({ executable: program, engine: 'cork' });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), 0, 'no block had a low bit set');
    });
