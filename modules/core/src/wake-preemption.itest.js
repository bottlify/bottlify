/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread that wakes one of higher priority gives it the processor at once,
 * as Windows does: the woken thread runs before the next instruction of the
 * thread that woke it. One of the same priority waits its turn. Both are what
 * one processor does -- with several the woken thread runs on another, beside
 * the thread that woke it -- so these programs run on one (`ONE_PROCESSOR`).
 *
 * The program starts a worker that waits on an event and, when it wakes,
 * writes a flag. The main thread lets it reach the wait, sets the event, and
 * exits with the flag as it reads it straight after SetEvent returns: 1 when
 * the worker ran in between, 0 when it did not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_OFFSET = 0x80;

/** A machine of one processor, whatever the run's default. */
const ONE_PROCESSOR = { cpu: { cores: 1 } };

/** @param {number} priority  The worker's, relative, as SetThreadPriority takes it. */
function buildWakeExe(priority){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['CreateEventA', 'CreateThread', 'SetThreadPriority', 'Sleep',
                'SetEvent', 'WaitForSingleObject', 'ExitProcess'],
        },
        codeSize: 0x100,
        data: { event: [0, 0, 0, 0], flag: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            const main = [
                // event = CreateEventA(NULL, FALSE, FALSE, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateEventA')),
                0xa3, ...u32(at('event')),
                // CreateThread(NULL, 0, worker, NULL, 0, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                // SetThreadPriority(thread, priority)
                0x6a, priority & 0xff,
                0x50,
                0xff, 0x15, ...u32(iat('SetThreadPriority')),
                // Sleep(20): the worker reaches its wait
                0x6a, 20,
                0xff, 0x15, ...u32(iat('Sleep')),
                // SetEvent(event)
                0xff, 0x35, ...u32(at('event')),
                0xff, 0x15, ...u32(iat('SetEvent')),
                // ExitProcess(flag), the flag as it is the moment SetEvent returns
                0xff, 0x35, ...u32(at('flag')),
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const worker = [
                // WaitForSingleObject(event, INFINITE)
                0x6a, 0xff,
                0xff, 0x35, ...u32(at('event')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                // flag = 1
                0xc7, 0x05, ...u32(at('flag')), ...u32(1),
                0x31, 0xc0, //                       xor eax, eax
                0xc2, 0x04, 0x00, //                 ret 4
            ];
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

/**
 * Slices are not ended by the clock (`sliceMs`): the main thread's slice is the
 * scheduler's to end, and one ended by the clock between SetEvent and the read
 * of the flag -- an interpreting slice's 8 ms, on a loaded machine -- let a
 * worker of the same priority in there, the turn's end and not the wake.
 *
 * @param {number} priority
 */
async function flagAfterSetEvent(priority){
    const app = await createApp({ executable: buildWakeExe(priority), ...ONE_PROCESSOR,
        cork: { config: { sliceMs: Infinity } } });
    try
    {
        return await app.run({ timeoutMs: 30_000 });
    }
    finally
    {
        await app.dispose();
    }
}

test('a worker of higher priority runs the moment the event it waits on is set', async()=>{
    assert.equal(await flagAfterSetEvent(2), 1, 'THREAD_PRIORITY_HIGHEST: before SetEvent returns');
});

test('a worker of the same priority waits for the thread that set its event', async()=>{
    assert.equal(await flagAfterSetEvent(0), 0, 'THREAD_PRIORITY_NORMAL: not yet');
});

const F_OFFSET = 0xc0;
const LATE_WORKER_OFFSET = 0x100;

/**
 * F(x) answers x + 1. Called with 0 -- by the main thread -- it first sets the
 * event a HIGHEST worker waits on, so the worker runs inside the main thread's
 * call; the worker calls F(10), which sleeps before answering, so the main
 * thread's call returns while the worker's is still open. The program exits
 * with 100 * F(0) + F(10): 111.
 */
function buildInterleavedExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['CreateEventA', 'CreateThread', 'SetThreadPriority', 'Sleep',
                'SetEvent', 'WaitForSingleObject', 'ExitProcess'],
        },
        codeSize: 0x180,
        data: { event: [0, 0, 0, 0], thread: [0, 0, 0, 0], flag: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            const callF = (/** @type {number} */ from)=>
                [0xe8, ...u32((code(F_OFFSET) - (code(from) + 5)) | 0)];
            const main = [
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateEventA')),
                0xa3, ...u32(at('event')),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(LATE_WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0xa3, ...u32(at('thread')),
                0x6a, 0x02, 0x50, //                    SetThreadPriority(thread, HIGHEST)
                0xff, 0x15, ...u32(iat('SetThreadPriority')),
                0x6a, 20, 0xff, 0x15, ...u32(iat('Sleep')),
                0x6a, 0x00, //                          push 0
            ];
            main.push(...callF(main.length)); //        call F
            main.push(
                0x50, //                                push eax
                0x6a, 0xff, 0xff, 0x35, ...u32(at('thread')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                0x58, //                                pop eax
                0x6b, 0xc0, 0x64, //                    imul eax, eax, 100
                0x03, 0x05, ...u32(at('flag')), //      add eax, [flag]
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            );
            const f = [
                0x8b, 0x44, 0x24, 0x04, //              mov eax, [esp+4]
                0x85, 0xc0, //                          test eax, eax
                0x75, 0x12, //                          jnz other (+18)
                0xff, 0x35, ...u32(at('event')), //     push [event]
                0xff, 0x15, ...u32(iat('SetEvent')),
                0x31, 0xc0, 0x40, //                    xor eax, eax; inc eax
                0xc2, 0x04, 0x00, //                    ret 4
                // other:
                0x6a, 0x1e, 0xff, 0x15, ...u32(iat('Sleep')), // Sleep(30)
                0x8b, 0x44, 0x24, 0x04, 0x40, //        mov eax, [esp+4]; inc eax
                0xc2, 0x04, 0x00, //                    ret 4
            ];
            const worker = [
                0x6a, 0xff, 0xff, 0x35, ...u32(at('event')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                0x6a, 0x0a, //                          push 10
            ];
            worker.push(...callF(LATE_WORKER_OFFSET + worker.length));
            worker.push(0xa3, ...u32(at('flag')), 0x31, 0xc0, 0xc2, 0x04, 0x00);
            return [
                ...main, ...new Array(F_OFFSET - main.length).fill(0x90),
                ...f, ...new Array(LATE_WORKER_OFFSET - F_OFFSET - f.length).fill(0x90),
                ...worker,
            ];
        },
    });
}

test('a watched routine returns each thread to its own caller when threads interleave inside it',
    async()=>{
        const app = await createApp({ executable: buildInterleavedExe() });
        try
        {
            /** @type {{ name: string, result: number }[]} */
            const answers = [];
            app.on('guest-return', (/** @type {any} */ back)=>answers.push(back));
            app.debug.hook(0x401000 + F_OFFSET, { label: 'F', argBytes: 4, lengths: [4, 2] });
            assert.equal(await app.run({ timeoutMs: 30_000 }), 111,
                'F(0) answered 1 to the main thread, F(10) 11 to the worker');
            assert.deepEqual(answers.map(back=>back.result).sort((a, b)=>a - b), [1, 11]);
        }
        finally
        {
            await app.dispose();
        }
    });

const CS_WORKER_OFFSET = 0xc0;

/**
 * The main thread sets the event a HIGHEST worker waits on while holding a
 * critical section the worker takes next, writes 7 still inside it, and
 * leaves. The worker wakes at the set, finds the section held, and gets it
 * the moment it is left: it reads 7 and writes 8 before the main thread runs
 * on, which exits with what the worker wrote.
 */
function buildSectionExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['InitializeCriticalSection', 'EnterCriticalSection',
                'LeaveCriticalSection', 'CreateEventA', 'CreateThread', 'SetThreadPriority',
                'Sleep', 'SetEvent', 'WaitForSingleObject', 'ExitProcess'],
        },
        codeSize: 0x140,
        data: { cs: new Array(24).fill(0), event: [0, 0, 0, 0], flag: [0, 0, 0, 0],
            seen: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            const main = [
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('InitializeCriticalSection')),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00, //   manual reset
                0xff, 0x15, ...u32(iat('CreateEventA')),
                0xa3, ...u32(at('event')),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(CS_WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0x6a, 0x02, 0x50, 0xff, 0x15, ...u32(iat('SetThreadPriority')),
                0x6a, 20, 0xff, 0x15, ...u32(iat('Sleep')),
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('EnterCriticalSection')),
                0xff, 0x35, ...u32(at('event')), 0xff, 0x15, ...u32(iat('SetEvent')),
                0xc7, 0x05, ...u32(at('flag')), ...u32(7), //            flag = 7, still inside
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('LeaveCriticalSection')),
                0xff, 0x35, ...u32(at('seen')), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const worker = [
                0x6a, 0xff, 0xff, 0x35, ...u32(at('event')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('EnterCriticalSection')),
                0xa1, ...u32(at('flag')), //                             mov eax, [flag]
                0x40, //                                                 inc eax
                0xa3, ...u32(at('seen')), //                             mov [seen], eax
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('LeaveCriticalSection')),
                0x31, 0xc0, 0xc2, 0x04, 0x00,
            ];
            return [...main, ...new Array(CS_WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

test('a worker woken inside a critical section takes it the moment it is left', async()=>{
    const app = await createApp({ executable: buildSectionExe(), ...ONE_PROCESSOR });
    try
    {
        assert.equal(await app.run({ timeoutMs: 30_000 }), 8,
            'the worker read what was written inside the section, before the waker ran on');
    }
    finally
    {
        await app.dispose();
    }
});

/**
 * The same hand-over with the worker waiting the way an I/O worker does: on
 * any of two manual-reset events, its work and its quit.
 */
function buildSectionAnyExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['InitializeCriticalSection', 'EnterCriticalSection',
                'LeaveCriticalSection', 'CreateEventA', 'CreateThread', 'SetThreadPriority',
                'Sleep', 'SetEvent', 'WaitForMultipleObjects', 'ExitProcess'],
        },
        codeSize: 0x160,
        data: { cs: new Array(24).fill(0), events: [0, 0, 0, 0, 0, 0, 0, 0], flag: [0, 0, 0, 0],
            seen: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            const event = [0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateEventA'))];
            const main = [
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('InitializeCriticalSection')),
                ...event, 0xa3, ...u32(at('events')),
                ...event, 0xa3, ...u32(at('events') + 4),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(0xe0)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0x6a, 0x02, 0x50, 0xff, 0x15, ...u32(iat('SetThreadPriority')),
                0x6a, 20, 0xff, 0x15, ...u32(iat('Sleep')),
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('EnterCriticalSection')),
                0xff, 0x35, ...u32(at('events')), 0xff, 0x15, ...u32(iat('SetEvent')),
                0xc7, 0x05, ...u32(at('flag')), ...u32(7),
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('LeaveCriticalSection')),
                0xff, 0x35, ...u32(at('seen')), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const worker = [
                0x6a, 0xff, 0x6a, 0x00, 0x68, ...u32(at('events')), 0x6a, 0x02,
                0xff, 0x15, ...u32(iat('WaitForMultipleObjects')),
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('EnterCriticalSection')),
                0xa1, ...u32(at('flag')), 0x40, 0xa3, ...u32(at('seen')),
                0x68, ...u32(at('cs')), 0xff, 0x15, ...u32(iat('LeaveCriticalSection')),
                0x31, 0xc0, 0xc2, 0x04, 0x00,
            ];
            return [...main, ...new Array(0xe0 - main.length).fill(0x90), ...worker];
        },
    });
}

test('a worker waiting on any of its events is handed over to the same way', async()=>{
    const app = await createApp({ executable: buildSectionAnyExe(), ...ONE_PROCESSOR });
    try
    {
        assert.equal(await app.run({ timeoutMs: 30_000 }), 8);
    }
    finally
    {
        await app.dispose();
    }
});

/**
 * The set made from guest code a host function called back -- a window
 * procedure under DispatchMessage is where a game's loop runs -- here the
 * procedure EnumDateFormatsA hands its first format to.
 */
function buildCallbackExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['CreateEventA', 'CreateThread', 'SetThreadPriority', 'Sleep',
                'SetEvent', 'WaitForSingleObject', 'EnumDateFormatsA', 'ExitProcess'],
        },
        codeSize: 0x140,
        data: { event: [0, 0, 0, 0], flag: [0, 0, 0, 0], seen: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            const main = [
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateEventA')),
                0xa3, ...u32(at('event')),
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(0x100)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0x6a, 0x02, 0x50, 0xff, 0x15, ...u32(iat('SetThreadPriority')),
                0x6a, 20, 0xff, 0x15, ...u32(iat('Sleep')),
                0x6a, 0x01, //                                  DATE_SHORTDATE
                0x68, ...u32(0x409),
                0x68, ...u32(code(0xc0)), //                    the procedure
                0xff, 0x15, ...u32(iat('EnumDateFormatsA')),
                0xff, 0x35, ...u32(at('seen')), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
            const procedure = [
                0xff, 0x35, ...u32(at('event')), 0xff, 0x15, ...u32(iat('SetEvent')),
                0xa1, ...u32(at('flag')), 0xa3, ...u32(at('seen')),
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                FALSE: no more formats
            ];
            const worker = [
                0x6a, 0xff, 0xff, 0x35, ...u32(at('event')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                0xc7, 0x05, ...u32(at('flag')), ...u32(1),
                0x31, 0xc0, 0xc2, 0x04, 0x00,
            ];
            return [...main, ...new Array(0xc0 - main.length).fill(0x90),
                ...procedure, ...new Array(0x100 - 0xc0 - procedure.length).fill(0x90), ...worker];
        },
    });
}

test('a set made inside a procedure a host function called back hands over at once too', async()=>{
    const app = await createApp({ executable: buildCallbackExe(), ...ONE_PROCESSOR });
    try
    {
        assert.equal(await app.run({ timeoutMs: 30_000 }), 1);
    }
    finally
    {
        await app.dispose();
    }
});
