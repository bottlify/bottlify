/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * RtlUnwind in a 64-bit process, through `createApp`: RtlUnwindEx from the
 * caller's context, which sends the thread to the target with the value in
 * RAX and does not return -- what the x64 CRT's longjmp calls it for, and
 * loops on should it come back. The routine calling it has no unwind data,
 * so it is a leaf to the unwinder and its frame is RSP; the target frame is
 * that one. Exit 0x55 is the landing's; 1 is RtlUnwind returning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** Where the routine and the landing are in the code. */
const HELPER = 0x40;
const LANDING = 0x80;

test('a 64-bit RtlUnwind lands at its target with the value and does not return',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            bits: 64, codeSize: 0xc0,
            imports: { 'KERNEL32.dll': ['RtlUnwind', 'ExitProcess'] },
            code: ({ iat, code })=>{
                /** @param {number} at @param {number[]} op @param {number} to */
                const rel = (at, op, to)=>[...op, ...u32(to - (code(at) + op.length + 4))];
                const main = [
                    0x48, 0x83, 0xec, 0x28, // sub rsp, 40
                    ...rel(4, [0xe8], code(HELPER)), // call helper
                    0x31, 0xc9, // xor ecx, ecx: the helper came back
                    ...rel(11, [0xff, 0x15], iat('ExitProcess')),
                ];
                const helper = [
                    0x48, 0x89, 0xe1, // mov rcx, rsp: this frame
                    ...rel(HELPER + 3, [0x48, 0x8d, 0x15], code(LANDING)), // lea rdx, [landing]
                    0x45, 0x31, 0xc0, // xor r8d, r8d: no record
                    0x41, 0xb9, ...u32(0x55), // mov r9d, 0x55
                ];
                helper.push(...rel(HELPER + helper.length, [0xff, 0x15], iat('RtlUnwind')));
                helper.push(0xb9, ...u32(1)); // mov ecx, 1: RtlUnwind came back
                helper.push(...rel(HELPER + helper.length, [0xff, 0x15], iat('ExitProcess')));
                const landing = [
                    0x89, 0xc1, // mov ecx, eax
                    ...rel(LANDING + 2, [0xff, 0x15], iat('ExitProcess')),
                ];
                return [...main, ...new Array(HELPER - main.length).fill(0xcc),
                    ...helper, ...new Array(LANDING - HELPER - helper.length).fill(0xcc),
                    ...landing];
            },
        });
        const app = await createApp({ executable: program, engine: 'cork' });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), 0x55);
    });
