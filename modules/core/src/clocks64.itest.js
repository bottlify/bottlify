/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The clocks of a 64-bit process, through `createApp`: QueryPerformanceCounter
 * and QueryPerformanceFrequency run as guest code there, as they do at 32 bits,
 * rather than as a trap each -- an engine reads the counter millions of times
 * while it loads. Two reads in a row still differ.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

test('a 64-bit process reads its performance counter in the guest, each read later',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            bits: 64, codeSize: 0x100,
            imports: { 'KERNEL32.dll': ['QueryPerformanceCounter', 'QueryPerformanceFrequency',
                'ExitProcess'] },
            code: ({ iat, code })=>{
                /** @type {number[]} */
                const bytes = [];
                /** @param {string} name  a call through its slot */
                const call = name=>{
                    bytes.push(0xff, 0x15, ...u32(iat(name) - (code(bytes.length) + 6)));
                };
                bytes.push(0x48, 0x83, 0xec, 0x48); // sub rsp, 72
                bytes.push(0x48, 0x8d, 0x4c, 0x24, 0x20); // lea rcx, [rsp+32]
                call('QueryPerformanceFrequency');
                bytes.push(0x48, 0x8d, 0x4c, 0x24, 0x28); // lea rcx, [rsp+40]
                call('QueryPerformanceCounter');
                bytes.push(0x48, 0x8d, 0x4c, 0x24, 0x30); // lea rcx, [rsp+48]
                call('QueryPerformanceCounter');
                bytes.push(0x31, 0xc9); // xor ecx, ecx
                // cmp qword [rsp+32], 1e9
                bytes.push(0x48, 0x81, 0x7c, 0x24, 0x20, ...u32(1_000_000_000));
                bytes.push(0x75, 0x02, 0xff, 0xc1); // jne +2; inc ecx
                bytes.push(0x48, 0x8b, 0x44, 0x24, 0x30); // mov rax, [rsp+48]
                bytes.push(0x48, 0x3b, 0x44, 0x24, 0x28); // cmp rax, [rsp+40]
                bytes.push(0x76, 0x03, 0x83, 0xc1, 0x02); // jbe +3; add ecx, 2
                call('ExitProcess');
                return bytes;
            },
        });
        const app = await createApp({ executable: program });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), 3, 'one gigahertz, and later');
        const calls = JSON.stringify(/** @type {any} */ (app.diagnostics()
            .find((/** @type {any} */ layer)=>layer.name === 'bridge'))?.metrics?.byFunction ?? []);
        assert.doesNotMatch(calls, /QueryPerformance/, 'neither went to the host');
    });
