/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's floating-point status in a 64-bit process, through
 * `createApp`: _statusfp runs as its host handler there, and reads SSE's
 * status from MXCSR -- an engine checks it once a frame, and the handler
 * without MXCSR ended the process. The program raises the zero-divide flag
 * with ldmxcsr, asks _statusfp, then clears it with _clearfp and asks again;
 * the two answers are its exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** _SW_ZERODIVIDE, as _statusfp names SSE's ZE flag. */
const SW_ZERODIVIDE = 0x8;

test('a 64-bit process\'s _statusfp and _clearfp read and clear MXCSR\'s flags',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            bits: 64, codeSize: 0x100,
            imports: { 'KERNEL32.dll': ['ExitProcess'],
                'msvcrt.dll': ['_statusfp', '_clearfp'] },
            code: ({ iat, code })=>{
                /** @type {number[]} */
                const bytes = [];
                /** @param {string} name  a call through its slot */
                const call = name=>{
                    bytes.push(0xff, 0x15, ...u32(iat(name) - (code(bytes.length) + 6)));
                };
                bytes.push(0x48, 0x83, 0xec, 0x28); // sub rsp, 40
                bytes.push(0xc7, 0x44, 0x24, 0x20, ...u32(0x1f84)); // mov dword [rsp+32], ZE set
                bytes.push(0x0f, 0xae, 0x54, 0x24, 0x20); // ldmxcsr [rsp+32]
                call('_statusfp');
                bytes.push(0x89, 0xc3); // mov ebx, eax
                call('_clearfp');
                call('_statusfp');
                bytes.push(0xc1, 0xe0, 0x08, 0x09, 0xc3); // shl eax, 8; or ebx, eax
                bytes.push(0x89, 0xd9); // mov ecx, ebx
                call('ExitProcess');
                return bytes;
            },
        });
        const app = await createApp({ executable: program });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), SW_ZERODIVIDE,
            'the flag raised, then cleared');
    });
