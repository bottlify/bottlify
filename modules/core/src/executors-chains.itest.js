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
    const app = await createApp({ executable, cpu: { cores, eager: true } });
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

test('three threads computing on two executors take turns there a turn long, not a slice',
    async()=>{
        // One more thread than the executors: the other executor's is wanted by
        // a waiting thread at every slice's end. It gives it up when it has held
        // it a turn (`executorHoldMs`), not after each quantum, which took a
        // round trip through the process every 50 us and left it idle for
        // almost half its time.
        const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
            { first: [0, 0, 0, 0], second: [0, 0, 0, 0], third: [0, 0, 0, 0] },
            ({ call, at, start })=>{
                /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
                const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                    ...call('WaitForSingleObject')];
                return {
                    main: [...start('first'), ...start('second'), ...start('third'),
                        ...wait('first'), ...wait('second'), ...wait('third'),
                        0x6a, 0x07, ...call('ExitProcess')],
                    worker: [
                        0xb9, ...u32(LOOPS * 2), //        mov ecx, 2 * LOOPS
                        0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                        0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
                    ],
                };
            });
        const app = await createApp({ executable, cpu: { cores: 2, eager: true } });
        try
        {
            const began = performance.now();
            assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
            const ms = performance.now() - began;
            const tables = await app.diagnostics();
            const kernel = (Array.isArray(tables) ? tables : [])
                .find(table=>table.name === 'kernel');
            const scheduler = kernel?.metrics?.scheduler ?? kernel?.metrics;
            // A turn a millisecond is about one a millisecond; a quantum each, ten.
            assert.ok(scheduler?.executorSlices > 0 && scheduler.executorSlices < ms * 3,
                `${scheduler?.executorSlices} slices elsewhere in ${Math.round(ms)} ms`);
        }
        finally
        {
            await app.dispose();
        }
    });

test('a thread started while the first still ran, left alone when the first waits for it, comes'
    + ' to the process\'s own executor', async()=>{
    // Started while the main thread runs here, the worker goes to the other
    // executor; once the main thread waits, this one has nothing to run and
    // takes the worker over: its code is translated here for this executor's
    // own layout, and its calls into the host cross nothing.
    const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
        { first: [0, 0, 0, 0] }, ({ call, at, start })=>({
            main: [...start('first'), 0x6a, 0xff, 0xff, 0x35, ...u32(at('first')),
                ...call('WaitForSingleObject'), 0x6a, 0x07, ...call('ExitProcess')],
            worker: [
                0xb9, ...u32(LOOPS * 5), //        mov ecx, 5 * LOOPS
                0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
            ],
        }));
    const { code, scheduler } = await run(executable, 2);
    assert.equal(code, 7);
    const shared = JSON.parse(scheduler?.sharedTime ?? '{}');
    const here = shared.hereRetired ?? 0;
    const total = here + (shared.elsewhereRetired ?? 0);
    // Three hundred million instructions; a few milliseconds' worth elsewhere,
    // not a chain of a quarter of a second, before it comes.
    assert.ok(total >= LOOPS * 10 && here > total * 0.75,
        `${here} of ${total} instructions on the process's own executor`);
});

test('a program of one thread on a machine of four opens no executor past the process\'s own',
    async()=>{
        const executable = buildProgram(['ExitProcess'], {}, ({ call })=>({
            main: [
                0xb9, ...u32(LOOPS), //            mov ecx, LOOPS
                0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                0x6a, 0x07, ...call('ExitProcess'),
            ],
            worker: [],
        }));
        const app = await createApp({ executable, cpu: { cores: 4 } });
        try
        {
            assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
            const tables = await app.diagnostics();
            const cpu = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'cpu');
            assert.deepEqual(cpu?.metrics?.executors, [], 'no worker opened for a thread alone');
        }
        finally
        {
            await app.dispose();
        }
    });

test('two threads computing open the executor they want, and run at once on it', async()=>{
    const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
        { first: [0, 0, 0, 0], second: [0, 0, 0, 0] }, ({ call, at, start })=>{
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            return {
                main: [...start('first'), ...start('second'), ...wait('first'), ...wait('second'),
                    0x6a, 0x07, ...call('ExitProcess')],
                worker: [
                    0xb9, ...u32(LOOPS * 10), //       mov ecx, 10 * LOOPS
                    0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                    0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
                ],
            };
        });
    const app = await createApp({ executable, cpu: { cores: 4 } });
    try
    {
        assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
        const tables = await app.diagnostics();
        const byName = Object.fromEntries((Array.isArray(tables) ? tables : [])
            .map(table=>[table.name, table]));
        const scheduler = byName.kernel?.metrics?.scheduler ?? byName.kernel?.metrics;
        // Opened as the ready threads wanted them: the main thread may still
        // have been ready beside the two as they started, never more.
        const opened = byName.cpu?.metrics?.executors?.length ?? 0;
        assert.ok(opened >= 1 && opened <= 2, `${opened} executors opened of the 3 there are`);
        assert.ok(scheduler?.mostAtOnce >= 2, 'the two ran at once once it opened');
    }
    finally
    {
        await app.dispose();
    }
});

test('the process\'s first thread keeps the process\'s own executor when the executor a thread'
    + ' it started wants opens', async()=>{
    // The main thread calls into the host CALLS times while its worker spins
    // on a word it sets after; the worker's executor opens while both are
    // ready, and the worker, if asked about first, is still not the one given
    // this executor: the main thread's calls are answered where it runs, not
    // crossing from the other executor between this one's turns.
    const CALLS = 20_000;
    // Instructions between two calls: the main thread's run, a few hundred
    // milliseconds, is longer than an executor takes to open.
    const BETWEEN = 5_000;
    const executable = buildProgram(
        ['CreateThread', 'WaitForSingleObject', 'GetCurrentProcessId', 'ExitProcess'],
        { first: [0, 0, 0, 0], stop: [0, 0, 0, 0] }, ({ call, at, start })=>({
            main: [
                ...start('first'),
                0xbe, ...u32(CALLS), //            mov esi, CALLS
                ...call('GetCurrentProcessId'), // L: call [GetCurrentProcessId]
                0xb9, ...u32(BETWEEN), //          mov ecx, BETWEEN
                0x49, 0x75, 0xfd, //               M: dec ecx; jnz M
                0x4e, 0x75, 0xef, //               dec esi; jnz L
                0xc7, 0x05, ...u32(at('stop')), ...u32(1), // mov dword [stop], 1
                0x6a, 0xff, 0xff, 0x35, ...u32(at('first')), ...call('WaitForSingleObject'),
                0x6a, 0x07, ...call('ExitProcess'),
            ],
            worker: [
                0x83, 0x3d, ...u32(at('stop')), 0x00, // W: cmp dword [stop], 0
                0x74, 0xf7, //                     je W
                0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
            ],
        }));
    // Which thread is asked about first once the executor opens is the run
    // loop's turn order at that moment: without the first thread's home, one
    // run in three put it on the other executor (13592 crossings), so three.
    for (let attempt = 0; attempt < 3; attempt++)
    {
        const app = await createApp({ executable, cpu: { cores: 4 } });
        try
        {
            assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
            const tables = await app.diagnostics();
            const kernel = (Array.isArray(tables) ? tables : [])
                .find(table=>table.name === 'kernel');
            const shared = JSON.parse((kernel?.metrics?.scheduler ?? kernel?.metrics)
                ?.sharedTime ?? '{}');
            assert.ok(shared.crossings !== undefined,
                'the scheduler counts the others\' crossings');
            assert.ok(shared.crossings < CALLS / 10, `run ${attempt}: ${shared.crossings} of the`
                + ` main thread's ${CALLS} calls crossed from another executor`);
        }
        finally
        {
            await app.dispose();
        }
    }
});

test('a thread on another executor calling into the host is answered at the process\'s next back'
    + ' edge while the process\'s own thread only computes', async()=>{
    // The worker calls into the host CALLS times; the main thread spins on a
    // word the worker sets after, never calling. Each call is answered inside
    // the main thread's turn, which the other executor's ask interrupts
    // (`interruptProcess`): its turns stay long, not one a call -- where the
    // asks waited for the turn's end, a turn was a quantum, and each call
    // waited 0.57 ms for it.
    const CALLS = 20_000;
    const executable = buildProgram(
        ['CreateThread', 'WaitForSingleObject', 'GetCurrentProcessId', 'ExitProcess'],
        { first: [0, 0, 0, 0], done: [0, 0, 0, 0] }, ({ call, at, start })=>({
            main: [
                ...start('first'),
                0x83, 0x3d, ...u32(at('done')), 0x00, // S: cmp dword [done], 0
                0x74, 0xf7, //                     je S
                0x6a, 0xff, 0xff, 0x35, ...u32(at('first')), ...call('WaitForSingleObject'),
                0x6a, 0x07, ...call('ExitProcess'),
            ],
            worker: [
                0xbe, ...u32(CALLS), //            mov esi, CALLS
                ...call('GetCurrentProcessId'), // L: call [GetCurrentProcessId]
                0x4e, 0x75, 0xf7, //               dec esi; jnz L
                0xc7, 0x05, ...u32(at('done')), ...u32(1), // mov dword [done], 1
                0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
            ],
        }));
    const app = await createApp({ executable, cpu: { cores: 2, eager: true } });
    try
    {
        assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
        const tables = await app.diagnostics();
        const byName = Object.fromEntries((Array.isArray(tables) ? tables : [])
            .map(table=>[table.name, table]));
        const scheduler = byName.kernel?.metrics?.scheduler ?? byName.kernel?.metrics;
        const shared = JSON.parse(scheduler?.sharedTime ?? '{}');
        assert.ok(shared.crossings >= CALLS, `${shared.crossings} calls crossed from the worker`);
        assert.ok(byName.cpu?.metrics?.interrupts > 0, 'the process\'s slices were interrupted');
        assert.ok(scheduler.turns * 20 < shared.crossings,
            `${scheduler.turns} turns of the process's own for ${shared.crossings} crossings`);
    }
    finally
    {
        await app.dispose();
    }
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

/** CONTEXT_i386 | CONTEXT_CONTROL: eip, esp and the flags. */
const CONTEXT_CONTROL = 0x10001;

for (const cores of [1, 2])
{
    test(`a thread suspended while it runs stops, on ${cores} executor${cores > 1 ? 's' : ''}`,
        async()=>{
            // SuspendThread stops a thread on another processor a little
            // later, as on Windows; reading its context waits for the stop.
            const executable = buildProgram(['CreateThread', 'SuspendThread', 'ExitProcess',
                'Sleep', 'GetThreadContext'], { runner: [0, 0, 0, 0], count: [0, 0, 0, 0],
                seen: [0, 0, 0, 0],
                context: [...u32(CONTEXT_CONTROL), ...new Array(0x2c8).fill(0)] },
            ({ call, at, start })=>({
                main: [
                    ...start('runner'),
                    0x6a, 0x64, ...call('Sleep'), //                         Sleep(100)
                    0xff, 0x35, ...u32(at('runner')), ...call('SuspendThread'),
                    0x68, ...u32(at('context')), 0xff, 0x35, ...u32(at('runner')),
                    ...call('GetThreadContext'), //       GetThreadContext(runner, &context)
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
