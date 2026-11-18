/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit program describes code it made with RtlInstallFunctionTableCallback,
 * as .NET's and Mono's JITs do, and RtlLookupFunctionEntry asks its callback -
 * guest code, called by the system - for the entry of an address in the range.
 * Exit 15: the installation succeeded (1), the lookup answered the callback's
 * entry (2), the callback was asked with the address (4), and the image base
 * written is the range's (8).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** Where the callback and the described range are in the code. */
const CALLBACK = 0xc0;
const RANGE = 0x100;
const CONTEXT = 0x1234;

test('a JIT\'s callback range is looked up through its callback', { timeout: 60000 }, async t=>{
    const program = buildExe({
        bits: 64, codeSize: 0x140,
        imports: { 'KERNEL32.dll': ['RtlInstallFunctionTableCallback', 'RtlLookupFunctionEntry',
            'ExitProcess'] },
        data: { entry: [...u32(0x10), ...u32(0x20), ...u32(0x30)], seen: new Array(8).fill(0),
            base: new Array(8).fill(0) },
        code: ({ iat, at, code })=>{
            /** @type {number[]} */
            const main = [];
            /** @param {number[]} op @param {number} to  a RIP-relative operand */
            const rip = (op, to)=>main.push(...op,
                ...u32(to - (code(main.length) + op.length + 4)));
            main.push(0x48, 0x83, 0xec, 0x38); // sub rsp, 56
            rip([0x48, 0x8d, 0x15], code(RANGE)); // lea rdx, [range]
            main.push(0x48, 0x8d, 0x4a, 0x03); // lea rcx, [rdx + 3]: the identifier
            main.push(0x41, 0xb8, ...u32(0x40)); // mov r8d, 64: its length
            rip([0x4c, 0x8d, 0x0d], code(CALLBACK)); // lea r9, [callback]
            main.push(0x48, 0xc7, 0x44, 0x24, 0x20, ...u32(CONTEXT)); // [rsp+32] = context
            main.push(0x48, 0xc7, 0x44, 0x24, 0x28, ...u32(0)); // [rsp+40] = no DLL
            rip([0xff, 0x15], iat('RtlInstallFunctionTableCallback'));
            main.push(0x0f, 0xb6, 0xd8); // movzx ebx, al
            rip([0x48, 0x8d, 0x0d], code(RANGE + 8)); // lea rcx, [range + 8]
            rip([0x48, 0x8d, 0x15], at('base')); // lea rdx, [base]
            main.push(0x45, 0x31, 0xc0); // xor r8d, r8d
            rip([0xff, 0x15], iat('RtlLookupFunctionEntry'));
            rip([0x48, 0x8d, 0x0d], at('entry')); // lea rcx, [entry]
            // cmp rax, rcx; jne +3; or ebx, 2
            main.push(0x48, 0x39, 0xc8, 0x75, 0x03, 0x83, 0xcb, 0x02);
            rip([0x48, 0x8d, 0x0d], code(RANGE + 8)); // lea rcx, [range + 8]
            rip([0x48, 0x3b, 0x0d], at('seen')); // cmp rcx, [seen]
            main.push(0x75, 0x03, 0x83, 0xcb, 0x04); // jne +3; or ebx, 4
            rip([0x48, 0x8d, 0x0d], code(RANGE)); // lea rcx, [range]
            rip([0x48, 0x3b, 0x0d], at('base')); // cmp rcx, [base]
            main.push(0x75, 0x03, 0x83, 0xcb, 0x08); // jne +3; or ebx, 8
            main.push(0x89, 0xd9); // mov ecx, ebx
            rip([0xff, 0x15], iat('ExitProcess'));

            /** @type {number[]} */
            const callback = [];
            /** @param {number[]} op @param {number} to */
            const cbRip = (op, to)=>callback.push(...op,
                ...u32(to - (code(CALLBACK + callback.length) + op.length + 4)));
            cbRip([0x48, 0x89, 0x0d], at('seen')); // mov [seen], rcx
            callback.push(0x31, 0xc0); // xor eax, eax
            callback.push(0x48, 0x81, 0xfa, ...u32(CONTEXT)); // cmp rdx, context
            callback.push(0x75, 0x07); // jne +7: the wrong context answers NULL
            cbRip([0x48, 0x8d, 0x05], at('entry')); // lea rax, [entry]
            callback.push(0xc3); // ret
            return [...main, ...new Array(CALLBACK - main.length).fill(0xcc),
                ...callback, ...new Array(RANGE - CALLBACK - callback.length).fill(0xcc),
                ...new Array(0x40).fill(0x90)];
        },
    });
    const app = await createApp({ executable: program });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 50000 }), 15);
});
