/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Mutexes taken and released in the guest (`wait-one.js`, the kernel's
 * `mutex-words.js`) against the host's own, on one executor and on three.
 *
 * Three threads add to a count that is no atomic word -- a load, a pause, a
 * store -- each holding a mutex, taken twice and given back twice, round
 * after round; a worker then ends holding the mutex, and the main thread's
 * wait is told it was abandoned; the program exits with the count and that
 * answer. Built with WaitForSingleObject, which the guest answers for a free
 * mutex, and with WaitForSingleObjectEx(..., FALSE), which only the host does,
 * it must end alike: a lost exclusion loses an add, a lost abandonment a word.
 * And a thread taking and giving back a mutex nobody else wants does it
 * without crossing into the host.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const ROUNDS = 3000;
const WORKER_AT = 0x300;
const ABANDON_AT = 0x380;
const WAIT_ABANDONED = 0x80;

/**
 * @param {boolean} hostWaits  every wait through WaitForSingleObjectEx
 */
function countingProgram(hostWaits){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateMutexA', 'CreateThread', 'WaitForSingleObject',
            'WaitForSingleObjectEx', 'ReleaseMutex', 'ExitProcess'] },
        codeSize: ABANDON_AT + 0x80,
        data: { mutex: u32(0), count: u32(0), first: u32(0), second: u32(0), third: u32(0),
            abandoned: u32(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** The mutex, waited for without end. */
            const take = hostWaits
                ? [0x6a, 0x00, 0x6a, 0xff, 0xff, 0x35, ...u32(at('mutex')),
                    ...call('WaitForSingleObjectEx')]
                : [0x6a, 0xff, 0xff, 0x35, ...u32(at('mutex')), ...call('WaitForSingleObject')];
            const give = [0xff, 0x35, ...u32(at('mutex')), ...call('ReleaseMutex')];
            /** CreateThread(NULL, 0, routine, NULL, 0, NULL), the handle to `slot`. */
            const start = (/** @type {number} */ routine, /** @type {string} */ slot)=>[
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(routine)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at(slot)),
            ];
            /** WaitForSingleObject([slot], INFINITE) */
            const join = (/** @type {string} */ slot)=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            /** @returns {any[]} ROUNDS adds, each holding the mutex taken twice */
            const adds = ()=>[
                0xbe, ...u32(ROUNDS), //                    mov esi, ROUNDS
                { label: 'round' },
                ...take, ...take,
                0x8b, 0x1d, ...u32(at('count')), //         mov ebx, [count]
                0xb9, ...u32(40), //                        mov ecx, 40
                { label: 'pause' },
                0x49, { jump: 'jnz', to: 'pause' }, //      dec ecx; jnz pause
                0x43, //                                    inc ebx
                0x89, 0x1d, ...u32(at('count')), //         mov [count], ebx
                ...give, ...give,
                0x4e, { jump: 'jnz', to: 'round' }, //      dec esi; jnz round
            ];
            const main = assemble([
                // CreateMutexA(NULL, FALSE, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, ...call('CreateMutexA'),
                0xa3, ...u32(at('mutex')),
                ...start(WORKER_AT, 'first'), ...start(WORKER_AT, 'second'),
                ...adds(),
                ...join('first'), ...join('second'),
                ...start(ABANDON_AT, 'third'), ...join('third'),
                ...take, 0xa3, ...u32(at('abandoned')), //  the wait's answer
                ...give,
                // ExitProcess(count + abandoned's answer << 24)
                0xa1, ...u32(at('abandoned')), //           mov eax, [abandoned]
                0xc1, 0xe0, 0x18, //                        shl eax, 24
                0x03, 0x05, ...u32(at('count')), //         add eax, [count]
                0x50, ...call('ExitProcess'),
            ]);
            const worker = assemble([...adds(), 0x31, 0xc0, 0xc2, 0x04, 0x00]);
            // Takes the mutex and ends holding it.
            const abandon = assemble([...take, 0x31, 0xc0, 0xc2, 0x04, 0x00]);
            if (main.length > WORKER_AT || worker.length > ABANDON_AT - WORKER_AT)
            {
                throw new Error(`main ${main.length}, worker ${worker.length} bytes`);
            }
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc), ...worker,
                ...new Array(ABANDON_AT - WORKER_AT - worker.length).fill(0xcc), ...abandon];
        },
    });
}

/**
 * The exit code, and how many calls of each named function crossed into the host.
 *
 * @param {Uint8Array} executable @param {number} cores
 */
async function run(executable, cores){
    const app = await createApp({ executable, cpu: { cores } });
    try
    {
        const code = await app.run({ timeoutMs: 120_000 });
        const tables = await app.diagnostics();
        const bridge = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'bridge');
        /** @param {string} name */
        const crossings = name=>Number((bridge?.metrics?.byFunction ?? [])
            .find((/** @type {string} */ one)=>one.startsWith(`KERNEL32.dll!${name} `))
            ?.split(' ')[1] ?? 0);
        return { code: code >>> 0, waits: crossings('WaitForSingleObject'),
            releases: crossings('ReleaseMutex') };
    }
    finally
    {
        await app.dispose();
    }
}

test('three threads counting under a mutex, then a mutex abandoned, end alike with the guest\'s'
    + ' waits and the host\'s, on one executor and on three', { timeout: 300_000 }, async()=>{
    const expected = ((WAIT_ABANDONED << 24) + 3 * ROUNDS) >>> 0;
    for (const cores of [1, 3])
    {
        const host = await run(countingProgram(true), cores);
        assert.equal(host.code, expected, `${cores} executor(s), the host's waits`);
        const guest = await run(countingProgram(false), cores);
        assert.equal(guest.code, expected, `${cores} executor(s), the guest's waits`);
    }
});

test('a thread taking and giving back a mutex nobody else wants never crosses into the host',
    { timeout: 120_000 }, async()=>{
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['CreateMutexA', 'WaitForSingleObject', 'ReleaseMutex',
                'ExitProcess'] },
            codeSize: 0x100,
            data: { mutex: u32(0) },
            code: ({ iat, at })=>{
            /** @param {string} name */
                const call = name=>[0xff, 0x15, ...u32(iat(name))];
                return assemble([
                    0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, ...call('CreateMutexA'),
                    0xa3, ...u32(at('mutex')),
                    0xbe, ...u32(ROUNDS), //                    mov esi, ROUNDS
                    { label: 'round' },
                    0x6a, 0xff, 0xff, 0x35, ...u32(at('mutex')), ...call('WaitForSingleObject'),
                    0xff, 0x35, ...u32(at('mutex')), ...call('ReleaseMutex'),
                    0x4e, { jump: 'jnz', to: 'round' },
                    0x6a, 0x07, ...call('ExitProcess'),
                ]);
            },
        });
        for (const cores of [1, 3])
        {
            const { code, waits, releases } = await run(executable, cores);
            assert.equal(code, 7);
            assert.ok(waits === 0 && releases === 0,
                `${cores} executor(s): ${waits} waits and ${releases} releases crossed`);
        }
    });
