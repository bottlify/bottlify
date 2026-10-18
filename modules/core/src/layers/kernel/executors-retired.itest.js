/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What each thread retired is the same on any number of executors (the
 * scheduler's `byThread`), and the cpu's count is every thread's together.
 *
 * A program of two threads that take turns: the main thread, pinned to the
 * first processor, runs a generator loop and hands a frame to a render thread
 * pinned to the second, which makes calls only the host answers -- each one,
 * from another executor, answered by the process's own between the main
 * thread's instructions -- and hands the frame back. What a thread retires
 * depends on what it finds: a wait on an event already set takes a shorter way
 * through WaitForSingleObject's guest code than one that blocks, as on Windows.
 * So nothing here is left to the executors' timing: every hand-over signals
 * and waits in one call (SignalObjectAndWait), whose wait always blocks, since
 * the other thread is waiting for that very signal; the render thread calls
 * the host three times before each of its signals, which the main thread's
 * executor answers no faster than one at its first wait; and the last frame
 * ends in ExitThread, which the main thread waits for.
 *
 * A call that ended the turn of the thread making it once charged the rest of
 * the quantum as retired; with the render thread on another executor every
 * hand-over did, a third more instructions than the main thread ran.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../app.js';
import { buildExe } from '../../../../../tools/make-pe.mjs';

const FRAMES = 24;
const ROUNDS = 400_000;
/** The render thread's calls into the host before each signal. */
const CALLS = 3;
const RENDER = 0x200;
const A = 1103515245;
const C = 12345;

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** What the main thread exits with: the generator after every round, its low seven bits. */
function checksum(){
    let value = 1;
    for (let round = 0; round < FRAMES * ROUNDS; round++)
    {
        value = (Math.imul(value, A) + C) | 0;
    }
    return value & 0x7f;
}

function program(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'SignalObjectAndWait', 'WaitForSingleObject',
            'CreateThread', 'ResumeThread', 'GetCurrentThread', 'SetThreadAffinityMask', 'GetACP',
            'ExitThread', 'ExitProcess'] },
        codeSize: 0x400,
        data: { go: u32(0), done: u32(0), thread: u32(0), frames: u32(FRAMES), result: u32(0) },
        code: ({ iat, at, code })=>{
            const call = (/** @type {string} */ name)=>[0xff, 0x15, ...u32(iat(name))];
            /** push [name] @param {string} name */
            const pushWord = name=>[0xff, 0x35, ...u32(at(name))];
            /** An auto-reset event, not signalled, into `name`. @param {string} name */
            const event = name=>[0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, ...call('CreateEventA'),
                0xa3, ...u32(at(name))];
            const main = [
                ...event('go'),
                ...event('done'),
                ...call('GetCurrentThread'), 0x6a, 0x01, 0x50, // the first processor alone
                ...call('SetThreadAffinityMask'),
                0x6a, 0, 0x6a, 0x04, 0x6a, 0, 0x68, ...u32(code(RENDER)), 0x6a, 0, 0x6a, 0,
                ...call('CreateThread'), 0xa3, ...u32(at('thread')), // CREATE_SUSPENDED
                0x6a, 0x02, ...pushWord('thread'), ...call('SetThreadAffinityMask'),
                ...pushWord('thread'), ...call('ResumeThread'),
                // Its first calls answered, it says it is ready.
                0x6a, 0xff, ...pushWord('done'), ...call('WaitForSingleObject'),
                0xb8, ...u32(1), //                         mov eax, 1
            ];
            const round = [
                0x69, 0xc0, ...u32(A), //                   L: imul eax, eax, A
                0x05, ...u32(C), //                            add eax, C
                0x49, //                                       dec ecx
            ];
            const frame = [
                0xb9, ...u32(ROUNDS), //                    F: mov ecx, ROUNDS
                ...round, 0x0f, 0x85, ...u32(-(round.length + 6)), // jnz L
                0xa3, ...u32(at('result')), //                 mov [result], eax
                // The frame back, or on the last the render thread's end.
                0x8b, 0x15, ...u32(at('done')), //             mov edx, [done]
                0x83, 0x3d, ...u32(at('frames')), 0x01, //     cmp dword [frames], 1
                0x75, 0x06, //                                 jne +6
                0x8b, 0x15, ...u32(at('thread')), //           mov edx, [thread]
                // SignalObjectAndWait(go, edx, INFINITE, FALSE)
                0x6a, 0x00, 0x6a, 0xff, 0x52, ...pushWord('go'), ...call('SignalObjectAndWait'),
                0xa1, ...u32(at('result')), //                 mov eax, [result]
                0xff, 0x0d, ...u32(at('frames')), //           dec dword [frames]
            ];
            main.push(...frame, 0x0f, 0x85, ...u32(-(frame.length + 6)), // jnz F
                0x83, 0xe0, 0x7f, 0x50, ...call('ExitProcess')); // ExitProcess(eax & 0x7f)
            const calls = [...call('GetACP'), 0x4b]; //      H: call GetACP; dec ebx
            // SignalObjectAndWait(done, go, INFINITE, FALSE)
            const handBack = [0x6a, 0x00, 0x6a, 0xff, ...pushWord('go'), ...pushWord('done'),
                ...call('SignalObjectAndWait')];
            const turn = [
                0xbb, ...u32(CALLS), //                     T: mov ebx, CALLS
                ...calls, 0x75, (-(calls.length + 2)) & 0xff, // jnz H
                0x4e, //                                       dec esi
                0x74, handBack.length + 2, //                  jz last
                ...handBack,
            ];
            const render = [
                // Its first turn is the one that says it is ready: one more than the frames.
                0xbe, ...u32(FRAMES + 1), //                   mov esi, FRAMES + 1
                ...turn, 0xeb, (-(turn.length + 2)) & 0xff, // jmp T
                0x6a, 0x00, ...call('ExitThread'), //    last: ExitThread(0)
            ];
            if (main.length > RENDER)
            {
                throw new Error(`the main thread's code takes ${main.length} bytes`);
            }
            return [...main, ...new Array(RENDER - main.length).fill(0x90), ...render];
        },
    });
}

/**
 * One run on `cores` executors, opened before the program starts.
 *
 * @param {Uint8Array} executable @param {number} cores
 */
async function run(executable, cores){
    const app = await createApp({ executable, cpu: { cores, eager: true } });
    try
    {
        const code = await app.run({ timeoutMs: 120_000, maxTurns: Number.MAX_SAFE_INTEGER });
        const tables = await app.diagnostics();
        /** @param {string} name */
        const layer = name=>(Array.isArray(tables) ? tables : []).find(table=>table.name === name);
        const kernel = layer('kernel')?.metrics ?? {};
        const cpu = layer('cpu')?.metrics ?? {};
        // "name instructions state ..." a thread, " | " between them.
        /** @type {Record<string, number>} */
        const threads = {};
        for (const row of String(kernel.byThread ?? '').split(' | '))
        {
            const [name, instructions] = row.split(' ');
            threads[name] = Number(instructions);
        }
        return { code, threads, total: cpu.instructions,
            crossings: JSON.parse(kernel.sharedTime ?? '{}').crossings ?? 0,
            elsewhere: (cpu.executors ?? []).reduce((/** @type {number} */ sum,
                /** @type {any} */ one)=>sum + (one.instructions ?? 0), 0) };
    }
    finally
    {
        await app.dispose();
    }
}

test('each thread retires as many instructions on two and three executors as on one, and the cpu '
    + 'counts them all', { timeout: 300_000 }, async()=>{
    const executable = program();
    const one = await run(executable, 1);
    assert.equal(one.code, checksum(), 'the program ran to its end');
    const names = Object.keys(one.threads).sort();
    assert.equal(names.length, 2, `two threads: ${names}`);
    const main = one.threads.main;
    assert.ok(main >= FRAMES * ROUNDS * 3, `the main thread ran its rounds: ${main}`);
    assert.equal(one.total, names.reduce((sum, name)=>sum + one.threads[name], 0),
        'one executor: the count is the threads\'');
    // Two runs on two executors: the second is timed otherwise.
    for (const cores of [2, 2, 3])
    {
        const many = await run(executable, cores);
        assert.equal(many.code, one.code, `${cores} executors: the same result`);
        assert.deepEqual(many.threads, one.threads,
            `${cores} executors: each thread retired what it retired on one`);
        assert.equal(many.total, main + one.threads[names.find(name=>name !== 'main') ?? ''],
            `${cores} executors: the count is every thread's together`);
        assert.ok(many.elsewhere > 0, `${cores} executors: the render thread ran on another`);
        assert.ok(many.crossings >= (FRAMES - 1) * CALLS,
            `${cores} executors: its calls crossed back (${many.crossings})`);
    }
});
