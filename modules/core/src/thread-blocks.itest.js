/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a thread's blocks being given back: its environment block, its
 * thread-local array and its copies of the images' thread-local templates are
 * taken when it is made and released once it has ended and runs nowhere, so a
 * program that makes a thread per task and joins each has only ever had a few
 * alive. They came from the process's startup span, which never frees: a few
 * hundred threads into a process's life the next CreateThread found no room,
 * and its failure took the run down.
 *
 * What it must not cost: a block handed to the next thread is that thread's
 * alone and fresh -- its own self pointer and id, the template and not what the
 * last owner wrote over it -- and a handle still open to a thread whose block
 * has gone answers as before.
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
const THREAD_MARK = 0x22220000;
/** Not a handle: CloseHandle answers ERROR_INVALID_HANDLE through the thread's block. */
const NOT_A_HANDLE = 0x0dead000;
const ERROR_INVALID_HANDLE = 6;

/** Several times as many threads as the startup span held blocks for. */
const THREADS = 2000;

/**
 * What went wrong, as bits of the exit code: what a thread saw (1 its block
 * not naming itself, 2 not its own id, 4 the host's last error not in it, 8 an
 * exception frame not kept there, 16 no thread-local block, 32 not the
 * template, 64 not the template's zeroes) and 128 a thread refused.
 */
const FAULTS = [['the block not naming itself', 1], ['another thread\'s id', 2],
    ['the host\'s last error elsewhere', 4], ['the exception frame lost', 8],
    ['no thread-local block', 16], ['not the template', 32], ['not the template\'s zeroes', 64],
    ['CreateThread refused', 128]];

/** @param {number} threads  made and joined, one after another */
function program(threads){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'GetExitCodeThread',
            'CloseHandle', 'ExitProcess'] },
        codeSize: WORKER_OFFSET + 0x100,
        data: {
            template: [...u32(TEMPLATE_MARK), ...new Array(28).fill(0)],
            index: u32(0),
            threadId: u32(0), handle: u32(0), previous: u32(0), exitCode: u32(0),
            failures: u32(0),
        },
        tls: { template: 'template', index: 'index' },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** `or ebx, bit` unless the flags say equal. @param {number} bit */
            const unlessEqual = bit=>[0x74, 0x03, 0x83, 0xcb, bit];

            // The previous thread's answer, read through the handle the main
            // thread kept open past making the next one, then the handle closed.
            const checkPrevious = (()=>{
                const read = [
                    0x68, ...u32(at('exitCode')), 0x50, ...call('GetExitCodeThread'),
                    0xa1, ...u32(at('exitCode')), //            mov eax, [exitCode]
                    0x09, 0x05, ...u32(at('failures')), //      or [failures], eax
                    0xff, 0x35, ...u32(at('previous')), ...call('CloseHandle'),
                ];
                return [
                    0xa1, ...u32(at('previous')), //            mov eax, [previous]
                    0x85, 0xc0, 0x74, read.length, //           test eax, eax; jz past
                    ...read,
                ];
            })();
            const done = [...checkPrevious,
                0xff, 0x35, ...u32(at('failures')), ...call('ExitProcess')];
            // CreateThread(NULL, 0, worker, NULL, 0, &threadId), joined.
            const create = [
                0x68, ...u32(at('threadId')), 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(WORKER_OFFSET)), 0x6a, 0x00, 0x6a, 0x00,
                ...call('CreateThread'),
            ];
            const rest = [
                0xa3, ...u32(at('handle')), //                  mov [handle], eax
                0x6a, 0xff, 0x50, ...call('WaitForSingleObject'),
                ...checkPrevious,
                0xa1, ...u32(at('handle')), 0xa3, ...u32(at('previous')),
                0x4e, //                                        dec esi
            ];
            const refused = [0x81, 0x0d, ...u32(at('failures')), ...u32(128)]; // or [failures], 128
            const loopLength = create.length + 4 + refused.length + 2 + rest.length + 6;
            const main = [
                0xbe, ...u32(threads), //                       mov esi, threads
                ...create,
                0x85, 0xc0, 0x75, refused.length + 2, //        test eax, eax; jnz made
                ...refused, 0xeb, rest.length + 6, //           jmp done
                ...rest,
                0x0f, 0x85, ...u32(-loopLength >>> 0), //       jnz loop
                ...done,
            ];
            // Its first dword the template's, its last the template's zero,
            // each then written over for the next owner of the memory to find.
            const local = [
                0x81, 0x38, ...u32(TEMPLATE_MARK), ...unlessEqual(32), // cmp dword [eax], MARK
                0x83, 0x78, 0x1c, 0x00, ...unlessEqual(64), //  cmp dword [eax+0x1c], 0
                0xc7, 0x00, ...u32(THREAD_MARK), //             mov dword [eax], THREAD_MARK
                0xc7, 0x40, 0x1c, ...u32(THREAD_MARK), //       mov dword [eax+0x1c], THREAD_MARK
            ];
            const worker = [
                0x53, 0x31, 0xdb, //                            push ebx; xor ebx, ebx
                // The block FS is based at, naming itself.
                0x64, 0xa1, ...u32(0x18), //                    mov eax, fs:[0x18]
                0x3b, 0x40, 0x18, ...unlessEqual(1), //         cmp eax, [eax+0x18]
                // This thread's id, as CreateThread told its maker.
                0x64, 0xa1, ...u32(0x24), //                    mov eax, fs:[0x24]
                0x3b, 0x05, ...u32(at('threadId')), ...unlessEqual(2),
                // A last error the host writes into the block it holds for the
                // thread, read where FS says the block is.
                0x68, ...u32(NOT_A_HANDLE), ...call('CloseHandle'),
                0x64, 0xa1, ...u32(0x34), //                    mov eax, fs:[0x34]
                0x83, 0xf8, ERROR_INVALID_HANDLE, ...unlessEqual(4),
                // An exception frame, registered and taken off again.
                0x68, ...u32(code(WORKER_OFFSET)), //           push handler
                0x64, 0xff, 0x35, ...u32(0), //                 push dword fs:[0]
                0x64, 0x89, 0x25, ...u32(0), //                 mov fs:[0], esp
                0x64, 0xa1, ...u32(0), //                       mov eax, fs:[0]
                0x39, 0xe0, ...unlessEqual(8), //               cmp eax, esp
                0x64, 0x8f, 0x05, ...u32(0), //                 pop dword fs:[0]
                0x83, 0xc4, 0x04, //                            add esp, 4
                // The thread-local block: the compiler's own sequence.
                0x8b, 0x0d, ...u32(at('index')), //            mov ecx, [_tls_index]
                0x64, 0xa1, ...u32(0x2c), //                    mov eax, fs:[0x2c]
                0x8b, 0x04, 0x88, //                            mov eax, [eax+ecx*4]
                0x85, 0xc0, 0x75, 0x05, //                      test eax, eax; jnz have
                0x83, 0xcb, 16, 0xeb, local.length, //          or ebx, 16; jmp end
                ...local,
                0x89, 0xd8, 0x5b, 0xc2, 0x04, 0x00, //          end: mov eax, ebx; pop ebx; ret 4
            ];
            if (main.length > WORKER_OFFSET)
            {
                throw new Error(`the program's main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

/**
 * The exit code, the process heap's account and the scheduler's, after a run.
 *
 * @param {number} threads @param {number} cores
 */
async function run(threads, cores){
    const app = await createApp({ executable: program(threads), cpu: { cores, eager: true } });
    try
    {
        const code = (await app.run({ timeoutMs: 160_000 })) >>> 0;
        const tables = await app.diagnostics();
        const byName = Object.fromEntries((Array.isArray(tables) ? tables : [])
            .map(table=>[table.name, table]));
        return {
            code,
            heap: byName.win32?.metrics?.heap ?? null,
            scheduler: byName.kernel?.metrics?.scheduler ?? byName.kernel?.metrics ?? null,
        };
    }
    finally
    {
        await app.dispose();
    }
}

for (const cores of [1, 2])
{
    test(`${THREADS} threads made and joined one after another each have blocks of their own, and`
        + ` give them back, on ${cores} executor${cores > 1 ? 's' : ''}`, { timeout: 170_000 },
    async()=>{
        const { code, heap, scheduler } = await run(THREADS, cores);
        assert.equal(code, 0, `${FAULTS.filter(([, bit])=>code & /** @type {number} */ (bit))
            .map(([what])=>what).join(', ')} (${code})`);
        // Taken from the process heap, which has room for every thread's
        // blocks kept: only its account says they were given back. After one
        // thread it holds what it holds after all of them.
        const once = await run(1, cores);
        assert.ok(heap !== null && once.heap !== null, 'the process heap gives its account');
        assert.deepEqual({ blocks: heap.blocks, used: heap.used },
            { blocks: once.heap.blocks, used: once.heap.used },
            `the heap after ${THREADS} threads, against after one`);
        if (cores > 1)
        {
            // Where a thread runs depends on whether the other executor is
            // free when it is made: alone nearly every one runs there, with
            // the machine's other cores busy two in five. What the gate needs
            // is hundreds given back from there, not a share.
            assert.ok(scheduler?.executorSlices >= THREADS / 10,
                `${scheduler?.executorSlices} slices on the other executor: the threads ran there`);
        }
    });
}
