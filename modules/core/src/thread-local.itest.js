/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of an image's thread-local block: every thread has its own copy of
 * the template, in the slot the loader gave the image, the process's first
 * thread and every one made after it alike. A thread made later had none, so
 * its thread-local variables were linear address zero and up, the same bytes
 * for every such thread: one thread's per-thread state was another's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_OFFSET = 0x200;
/** The template's first dword, as every thread's copy starts. */
const TEMPLATE_MARK = 0x5eed1234;
const MAIN_MARK = 0x11110000;
const THREAD_MARK = 0x22220000;

/**
 * What a thread made by CreateThread finds in its block, as bits of the exit
 * code: 1 none, 2 the first thread's, 4 not the template, 8 the first thread's
 * value changed by the other's write.
 */
function program(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess'] },
        codeSize: 0x400,
        data: {
            template: [...u32(TEMPLATE_MARK), ...new Array(28).fill(0)],
            index: u32(0),
            mainBlock: u32(0), threadBlock: u32(0), threadSaw: u32(0), handle: u32(0),
        },
        tls: { template: 'template', index: 'index' },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            // eax = fs:[0x2c][_tls_index]: the compiler's own sequence
            const block = [
                0x8b, 0x0d, ...u32(at('index')), //            mov ecx, [_tls_index]
                0x64, 0xa1, ...u32(0x2c), //                    mov eax, fs:[0x2c]
                0x8b, 0x04, 0x88, //                            mov eax, [eax+ecx*4]
            ];
            const main = [
                ...block, 0xa3, ...u32(at('mainBlock')),
                0xc7, 0x00, ...u32(MAIN_MARK), //               mov dword [eax], MAIN_MARK
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at('handle')),
                0x6a, 0xff, 0xff, 0x35, ...u32(at('handle')), ...call('WaitForSingleObject'),
                0x31, 0xdb, //                                  xor ebx, ebx
                0xa1, ...u32(at('threadBlock')), //             mov eax, [threadBlock]
                0x85, 0xc0, 0x75, 0x03, 0x83, 0xcb, 0x01, //    null: bit 0
                0x3b, 0x05, ...u32(at('mainBlock')), //         cmp eax, [mainBlock]
                0x75, 0x03, 0x83, 0xcb, 0x02, //                the first thread's: bit 1
                0x81, 0x3d, ...u32(at('threadSaw')), ...u32(TEMPLATE_MARK),
                0x74, 0x03, 0x83, 0xcb, 0x04, //                not the template: bit 2
                0x8b, 0x0d, ...u32(at('mainBlock')), //         mov ecx, [mainBlock]
                0x81, 0x39, ...u32(MAIN_MARK), //               cmp dword [ecx], MAIN_MARK
                0x74, 0x03, 0x83, 0xcb, 0x08, //                changed by the other: bit 3
                0x53, ...call('ExitProcess'),
            ];
            const worker = [
                ...block, 0xa3, ...u32(at('threadBlock')),
                0x85, 0xc0, 0x74, 0x0e, //                      jz done
                0x8b, 0x08, 0x89, 0x0d, ...u32(at('threadSaw')), // threadSaw = [eax]
                0xc7, 0x00, ...u32(THREAD_MARK), //             mov dword [eax], THREAD_MARK
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                done: return 0
            ];
            if (main.length > WORKER_OFFSET)
            {
                throw new Error(`the program's main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

for (const cores of [1, 2])
{
    test(`a thread made by CreateThread has its own copy of the image's thread-local block, on ${
        cores} executor${cores > 1 ? 's' : ''}`, async()=>{
        const app = await createApp({ executable: program(), cpu: { cores, eager: true } });
        try
        {
            const code = (await app.run({ timeoutMs: 30_000 })) >>> 0;
            assert.equal(code, 0, `${[['none', 1], ['the first thread\'s', 2],
                ['not the template', 4], ['the first thread\'s value overwritten', 8]]
                .filter(([, bit])=>code & /** @type {number} */ (bit))
                .map(([what])=>what).join(', ')} (${code})`);
        }
        finally
        {
            await app.dispose();
        }
    });
}
