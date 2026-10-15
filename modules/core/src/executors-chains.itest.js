/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of an executor keeping its thread past a slice (roadmap/v2, stage 3):
 * while no ready thread waits for an executor, another executor runs its thread
 * slice after slice without a word to the process -- a word a slice cost as much
 * as the slice's own work, and 7-Zip's benchmark had the second of two
 * executors waiting on the process for over half its time.
 *
 * What it must not cost: a thread that sleeps on the process's own executor
 * wakes at its time, though the other executor says nothing until then; and a
 * thread suspended while it runs on another executor stops there.
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

/**
 * A program of a main thread and a worker routine at `WORKER_OFFSET`.
 *
 * @param {string[]} imports  KERNEL32's, CreateThread among them
 * @param {Record<string, number[]>} data
 * @param {(tools: { call: (name: string) => number[], at: (name: string) => number,
 *     start: (slot: string) => number[] }) => { main: number[], worker: number[] }} parts
 */
function buildProgram(imports, data, parts){
    return buildExe({
        imports: { 'KERNEL32.dll': imports },
        codeSize: WORKER_OFFSET + 0x40,
        data,
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** CreateThread(NULL, 0, worker, NULL, 0, NULL), the handle to `slot`. @param {string} slot */
            const start = slot=>[
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at(slot)),
            ];
            const { main, worker } = parts({ call, at, start });
            if (main.length > WORKER_OFFSET)
            {
                throw new Error(`the program's main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

/**
 * The exit code, and the scheduler's account.
 *
 * @param {Uint8Array} executable @param {number} cores
 */
async function run(executable, cores){
    const app = await createApp({ executable, cpu: { cores } });
    try
    {
        const code = await app.run({ timeoutMs: 60_000 });
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        return { code: code >>> 0,
            scheduler: kernel?.metrics?.scheduler ?? kernel?.metrics ?? null };
    }
    finally
    {
        await app.dispose();
    }
}

/** Times round a worker's loop: 60 million instructions, a thousand quanta and more. */
const LOOPS = 30_000_000;

test('two threads computing on two executors keep them, not handing their thread back a slice'
    + ' at a time -- the one whose own executor is taken running on the process\'s', async()=>{
    // The main thread counts as a thread of the process's executor, so both
    // workers call the other executor theirs: one runs there, the other here.
    const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
        { first: [0, 0, 0, 0], second: [0, 0, 0, 0] }, ({ call, at, start })=>{
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            return {
                main: [...start('first'), ...start('second'), ...wait('first'), ...wait('second'),
                    0x6a, 0x07, ...call('ExitProcess')],
                worker: [
                    0xb9, ...u32(LOOPS), //            mov ecx, LOOPS
                    0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                    0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
                ],
            };
        });
    const { code, scheduler } = await run(executable, 2);
    assert.equal(code, 7);
    assert.ok(scheduler?.mostAtOnce >= 2, 'both workers at once');
    // A slice a quantum would be six hundred; kept, a few, as the thread on the
    // process's executor moves to its own once the first is done.
    assert.ok(scheduler?.executorSlices > 0 && scheduler.executorSlices < 60,
        `${scheduler?.executorSlices} slices on the other executor`);
});

test('a thread sleeping on the process\'s executor wakes at its time while the other executor'
    + ' runs a thread that never calls into the host', async()=>{
    const SLEEPS = 5;
    const SLEEP_MS = 20;
    const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess',
        'Sleep', 'GetTickCount'], {
        spinner: [0, 0, 0, 0], flag: [0, 0, 0, 0], count: [0, 0, 0, 0], began: [0, 0, 0, 0],
    }, ({ call, at, start })=>({
        main: [
            ...start('spinner'),
            ...call('GetTickCount'), 0xa3, ...u32(at('began')),
            ...Array.from({ length: SLEEPS }, ()=>[0x6a, SLEEP_MS, ...call('Sleep')]).flat(),
            ...call('GetTickCount'), 0x2b, 0x05, ...u32(at('began')), //  sub eax, [began]
            0x89, 0xc3, //                                                 mov ebx, eax
            0xc7, 0x05, ...u32(at('flag')), ...u32(1), //                 mov [flag], 1
            0x6a, 0xff, 0xff, 0x35, ...u32(at('spinner')), ...call('WaitForSingleObject'),
            0x53, ...call('ExitProcess'), //                               ExitProcess(ebx)
        ],
        worker: [
            0xff, 0x05, ...u32(at('count')), //                L: inc [count]
            0x83, 0x3d, ...u32(at('flag')), 0x00, //           cmp [flag], 0
            0x74, 0xf1, //                                     je L
            0x31, 0xc0, 0xc2, 0x04, 0x00, //                   xor eax, eax; ret 4
        ],
    }));
    const { code } = await run(executable, 2);
    // What it slept, give or take the host's turns -- not the quarter of a
    // second each the other executor goes without a word.
    assert.ok(code >= SLEEPS * SLEEP_MS && code < SLEEPS * SLEEP_MS + 250,
        `${SLEEPS} sleeps of ${SLEEP_MS} ms took ${code} ms`);
});

for (const cores of [1, 2])
{
    test(`a thread suspended while it runs stops, on ${cores} executor${cores > 1 ? 's' : ''}`,
        async()=>{
            const executable = buildProgram(['CreateThread', 'SuspendThread', 'ExitProcess',
                'Sleep'], { runner: [0, 0, 0, 0], count: [0, 0, 0, 0], seen: [0, 0, 0, 0] },
            ({ call, at, start })=>({
                main: [
                    ...start('runner'),
                    0x6a, 0x64, ...call('Sleep'), //                         Sleep(100)
                    0xff, 0x35, ...u32(at('runner')), ...call('SuspendThread'),
                    0x6a, 0x32, ...call('Sleep'), //                         Sleep(50)
                    0xa1, ...u32(at('count')), 0xa3, ...u32(at('seen')), // seen = count
                    0x6a, 0x3c, ...call('Sleep'), //                         Sleep(60)
                    0xa1, ...u32(at('count')), 0x2b, 0x05, ...u32(at('seen')),
                    0x50, ...call('ExitProcess'), //               ExitProcess(count - seen)
                ],
                worker: [
                    0xff, 0x05, ...u32(at('count')), //            L: inc [count]
                    0xeb, 0xf8, //                                 jmp L
                ],
            }));
            const { code } = await run(executable, cores);
            assert.equal(code, 0, `${code} increments after the thread was suspended`);
        });
}
