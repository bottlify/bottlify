/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread's fibre-local values are called back and cleared before its
 * libraries hear DLL_THREAD_DETACH, and its block stays until they have: a
 * DllMain that reads FlsGetValue then gets NULL and success, as on Windows
 * (Wine's loader.c dll_entry_point). The block was freed before the
 * libraries were told, so the read failed with ERROR_INVALID_PARAMETER.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** What verdict() answers when no thread's detach was heard. */
const UNHEARD = 0xff;

/**
 * probe.dll: its process attach allocates an index, a thread's attach sets a
 * value there, a thread's detach reads it back with its last error; verdict()
 * answers that value or'd with that error, 0 when both are as on Windows.
 */
function probe(){
    return buildExe({
        dll: true,
        imageBase: 0x15000000,
        imports: { 'KERNEL32.dll': ['FlsAlloc', 'FlsSetValue', 'FlsGetValue', 'GetLastError'] },
        codeSize: 0x100,
        data: { index: u32(0), value: u32(0), error: u32(0), seen: u32(0) },
        exports: [{ name: 'verdict', offset: 0xc0 }],
        code: ({ iat, at })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            const attach = [0x6a, 0x00, ...call('FlsAlloc'), 0xa3, ...u32(at('index'))];
            const thread = [0x68, ...u32(0x31415), 0xff, 0x35, ...u32(at('index')),
                ...call('FlsSetValue')];
            const detach = [0xff, 0x35, ...u32(at('index')), ...call('FlsGetValue'),
                0xa3, ...u32(at('value')), ...call('GetLastError'), 0xa3, ...u32(at('error')),
                0xc7, 0x05, ...u32(at('seen')), ...u32(1)];
            const done = [0xb8, ...u32(1), 0xc2, 0x0c, 0x00];
            // Each case: cmp eax, reason; jne next; its body; jmp done.
            /** @type {[number, number[]][]} */
            const cases = [[1, attach], [2, thread], [3, detach]];
            const sizes = cases.map(([, body])=>3 + 2 + body.length + 2);
            /** @type {number[]} */
            const main = [0x8b, 0x44, 0x24, 0x08];
            cases.forEach(([reason, body], index)=>{
                const after = sizes.slice(index + 1).reduce((sum, size)=>sum + size, 0);
                main.push(0x83, 0xf8, reason, 0x75, body.length + 2, ...body, 0xeb, after);
            });
            main.push(...done);
            const verdict = [
                0xa1, ...u32(at('seen')), 0x85, 0xc0, 0x74, 0x0c, // mov eax, [seen]; jz none
                0xa1, ...u32(at('error')), 0x0b, 0x05, ...u32(at('value')), 0xc3,
                0xb8, ...u32(UNHEARD), 0xc3, //                       none: mov eax, UNHEARD
            ];
            return [...main, ...new Array(0xc0 - main.length).fill(0xcc), ...verdict];
        },
    });
}

/** Makes a thread that returns at once, waits for it, and exits with verdict(). */
function program(){
    return buildExe({
        imports: {
            'probe.dll': ['verdict'],
            'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
        },
        codeSize: 0x80,
        code: ({ iat, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** @param {number} routine */
            const main = routine=>[
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(routine), 0x6a, 0x00, 0x6a, 0x00,
                ...call('CreateThread'),
                0x6a, 0xff, 0x50, ...call('WaitForSingleObject'), // push INFINITE; push eax
                ...call('verdict'), 0x50, ...call('ExitProcess'),
            ];
            const routine = [0x31, 0xc0, 0xc2, 0x04, 0x00]; //  xor eax, eax; ret 4
            const at = main(0).length;
            return [...main(code(at)), ...routine];
        },
    });
}

test('a library told of a thread\'s end reads its fibre-local value as NULL, and success',
    { timeout: 60000 }, async t=>{
        const app = await createApp({
            executable: program(),
            imagePath: 'C:\\App\\fls.exe',
            storage: { load: async()=>({ files: [
                { path: 'C:\\App\\probe.dll', bytes: probe() }] }) },
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 40000 }), 0,
            'NULL and ERROR_SUCCESS (87 when the block was gone, 0xff when no detach was heard)');
    });
