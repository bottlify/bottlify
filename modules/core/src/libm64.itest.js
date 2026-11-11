/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * logf and expf in a 64-bit process, through `createApp`: guest code, not a
 * trap -- a world built procedurally asks for them a hundred thousand times a
 * second. logf(e) is 1, expf(2) 7.39; logf(0) is still the host's, minus
 * infinity with errno set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

test('a 64-bit process\'s logf and expf run in the guest, and hands only its edges to the host',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            bits: 64, codeSize: 0x100,
            imports: { 'KERNEL32.dll': ['ExitProcess'], 'ucrtbase.dll': ['logf', 'expf'] },
            code: ({ iat, code })=>{
                /** @type {number[]} */
                const bytes = [];
                /** @param {string} name  a call through its slot */
                const call = name=>{
                    bytes.push(0xff, 0x15, ...u32(iat(name) - (code(bytes.length) + 6)));
                };
                bytes.push(0x48, 0x83, 0xec, 0x28); // sub rsp, 40
                bytes.push(0xb8, ...u32(0x402df854), 0x66, 0x0f, 0x6e, 0xc0); // xmm0 = e
                call('logf');
                bytes.push(0xf3, 0x0f, 0x2d, 0xd8); // cvtss2si ebx, xmm0: 1
                bytes.push(0xb8, ...u32(0x40000000), 0x66, 0x0f, 0x6e, 0xc0); // xmm0 = 2
                call('expf');
                bytes.push(0xf3, 0x0f, 0x2d, 0xc0, 0x01, 0xc3); // ebx += expf(2), 7
                bytes.push(0x0f, 0x57, 0xc0); // xorps xmm0, xmm0
                call('logf');
                bytes.push(0x66, 0x0f, 0x7e, 0xc0); // movd eax, xmm0: -inf's bits
                bytes.push(0x3d, ...u32(0xff800000), 0x75, 0x03, 0x83, 0xc3, 0x10); // +16 if so
                bytes.push(0x89, 0xd9); // mov ecx, ebx
                call('ExitProcess');
                return bytes;
            },
        });
        const app = await createApp({ executable: program });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), 24,
            'logf(e) is 1, expf(2) 7, logf(0) minus infinity');
        const calls = /** @type {any} */ (app.diagnostics()
            .find((/** @type {any} */ layer)=>layer.name === 'bridge'))?.metrics?.byFunction ?? [];
        const logf = calls.find((/** @type {string} */ line)=>line.startsWith('ucrtbase.dll!logf '));
        assert.match(logf ?? '', /^ucrtbase\.dll!logf 1 /, 'the host saw logf(0) alone');
        assert.equal(calls.find((/** @type {string} */ line)=>line.startsWith('ucrtbase.dll!expf ')),
            undefined, 'and no expf');
    });
