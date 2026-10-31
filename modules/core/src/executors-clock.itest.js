/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The clock read by threads on two executors at once:
 * QueryPerformanceCounter's guest routine answers each thread later than its
 * last answer while the engine moves the clock underneath and the other
 * thread takes answers of its own -- the counter read whole between two looks
 * at the block's sequence, the last answer moved by `lock cmpxchg8b`.
 *
 * Two workers each ask CALLS times and count the answers not later than
 * their previous one; the program exits with the count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { assemble, buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_AT = 0x100;
const CALLS = 100_000;

function buildProgram(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess',
            'QueryPerformanceCounter'] },
        codeSize: 0x200,
        data: { errors: u32(0), first: u32(0), second: u32(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** CreateThread(NULL, 0, worker, NULL, 0, NULL) into `slot` @param {string} slot */
            const start = slot=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at(slot))];
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            const main = [...start('first'), ...start('second'), ...wait('first'),
                ...wait('second'), 0xff, 0x35, ...u32(at('errors')), ...call('ExitProcess')];
            const worker = assemble([
                0x53, 0x56, 0x57, //                       push ebx, esi, edi
                0x83, 0xec, 0x08, //                       sub esp, 8: the answer
                0xbb, ...u32(CALLS), //                    mov ebx, CALLS
                0x31, 0xf6, 0x31, 0xff, //                 edi:esi, the last answer, 0
                { label: 'ask' },
                0x54, //                                   push esp: where it goes
                ...call('QueryPerformanceCounter'),
                0x8b, 0x04, 0x24, //                       mov eax, [esp]
                0x8b, 0x54, 0x24, 0x04, //                 mov edx, [esp+4]
                0x39, 0xfa, { jump: 'ja', to: 'later' }, // cmp edx, edi
                { jump: 'jb', to: 'earlier' },
                0x39, 0xf0, { jump: 'ja', to: 'later' }, // cmp eax, esi
                { label: 'earlier' },
                0xf0, 0xff, 0x05, ...u32(at('errors')), // lock inc dword [errors]
                { label: 'later' },
                0x89, 0xc6, 0x89, 0xd7, //                 the last answer: this one
                0x4b, { jump: 'jnz', to: 'ask' }, //       dec ebx
                0x83, 0xc4, 0x08, 0x5f, 0x5e, 0x5b, //     add esp, 8; pop edi, esi, ebx
                0x31, 0xc0, 0xc2, 0x04, 0x00, //           xor eax, eax; ret 4
            ]);
            if (main.length > WORKER_AT)
            {
                throw new Error(`main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc), ...worker];
        },
    });
}

test('the performance counter answers every thread later each time, on two executors at once',
    { timeout: 120_000 }, async()=>{
        const app = await createApp({ executable: buildProgram(),
            cpu: { cores: 2 } });
        try
        {
            const errors = await app.run({ timeoutMs: 90_000 });
            const tables = await app.diagnostics();
            const kernel = (Array.isArray(tables) ? tables : [])
                .find(table=>table.name === 'kernel');
            const scheduler = kernel?.metrics?.scheduler ?? kernel?.metrics;
            assert.equal(errors >>> 0, 0, 'answers not later than the same thread\'s last');
            assert.ok(scheduler?.mostAtOnce >= 2, 'the two threads ran at once');
        }
        finally
        {
            await app.dispose();
        }
    });
