/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program linked for large stacks keeps many threads alive at once, as on
 * Windows, where a thread's stack is address space like any other: the threads'
 * pool holds sixteen stacks of four megabytes, and a thread past them takes its
 * stack from the process's free address space rather than failing to be made.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { assemble, buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const THREADS = 40;
const WORKER_AT = 0x200;

/**
 * Starts THREADS threads that each wait on one event, each asking a megabyte's
 * commit (so the reserve is the image's), lets them all go and exits with how
 * many were made.
 */
function program(){
    const exe = buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'CreateThread', 'SetEvent', 'Sleep',
            'WaitForSingleObject', 'ExitProcess'] },
        codeSize: WORKER_AT + 0x100,
        data: { event: u32(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            const main = assemble([
                0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00, 0x6a, 0x00, ...call('CreateEventA'),
                0xa3, ...u32(at('event')),
                0x31, 0xdb, //                                 xor ebx, ebx (made)
                0xbe, ...u32(THREADS), //                      mov esi, THREADS
                { label: 'start' },
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                0x68, ...u32(0x100000), 0x6a, 0x00, ...call('CreateThread'),
                0x85, 0xc0, { jump: 'jz', to: 'next' }, //      test eax, eax; jz next
                0x43, //                                       inc ebx
                { label: 'next' },
                0x4e, { jump: 'jnz', to: 'start' }, //         dec esi; jnz start
                // All of them alive at once, then let go.
                0x6a, 0x32, ...call('Sleep'),
                0xff, 0x35, ...u32(at('event')), ...call('SetEvent'),
                0x6a, 0x32, ...call('Sleep'),
                0x53, ...call('ExitProcess'), //               ExitProcess(made)
            ]);
            const worker = assemble([
                0x6a, 0xff, 0xff, 0x35, ...u32(at('event')), ...call('WaitForSingleObject'),
                0x31, 0xc0, 0xc2, 0x04, 0x00, //               xor eax, eax; ret 4
            ]);
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc), ...worker];
        },
    });
    // Linked for a five-megabyte stack, as a game engine may be.
    const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
    const optional = view.getUint32(0x3c, true) + 24;
    view.setUint32(optional + 72, 0x500000, true);
    return exe;
}

test('a program linked for five-megabyte stacks keeps forty threads alive at once', {
    timeout: 120_000 }, async t=>{
    const app = await createApp({ executable: program() });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 60_000 }), THREADS,
        'every CreateThread made its thread');
});
