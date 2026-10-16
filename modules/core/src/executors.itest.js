/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The executors' gate (roadmap/v2, stage 3): a program whose threads
 * synchronise through memory alone -- an interlocked counter, a spin lock on
 * `xchg` guarding a plain increment, a compare-and-swap loop -- ends the same
 * with its threads on the process's one executor, taking turns, as on several
 * running at once, where every one of those is a race the atomic variant has
 * to win.
 *
 * Two workers each go round the three N times; the main thread waits for both
 * and exits with a bit for each of the three that reached 2N.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const N = 20_000;
const WORKER_OFFSET = 0x100;

/**
 * @param {boolean} [crossing]  every thread, the main one between starting the workers and
 *     waiting for them, also calls into the host each time round: the others' calls are
 *     then answered inside the calls of the thread on the process's own executor
 */
function buildRaceExe(crossing = false){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess',
            'GetACP'] },
        codeSize: 0x200,
        data: {
            counter: [0, 0, 0, 0], guarded: [0, 0, 0, 0], lock: [0, 0, 0, 0],
            swapped: [0, 0, 0, 0], first: [0, 0, 0, 0], second: [0, 0, 0, 0],
        },
        code: ({ iat, at, code })=>{
            /** CreateThread(NULL, 0, worker, NULL, 0, NULL), the handle to `slot`. @param {string} slot */
            const start = slot=>[
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0xa3, ...u32(at(slot)),
            ];
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[
                0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            ];
            /** cmp dword [name], 2N; jne +3; or ebx, bit @param {string} name @param {number} bit */
            const check = (name, bit)=>[
                0x81, 0x3d, ...u32(at(name)), ...u32(2 * N), 0x75, 0x03, 0x83, 0xcb, bit,
            ];
            // push ecx; call [GetACP]; pop ecx -- what a crossing may clobber, kept
            const cross = crossing ? [0x51, 0xff, 0x15, ...u32(iat('GetACP')), 0x59] : [];
            // mov ecx, N; L: the crossing; dec ecx; jnz L
            const busy = crossing
                ? [0xb9, ...u32(N), ...cross, 0x49, 0x75, -(cross.length + 3) & 0xff]
                : [];
            const main = [
                ...start('first'), ...start('second'), ...busy, ...wait('first'), ...wait('second'),
                0x31, 0xdb, //                                  xor ebx, ebx
                ...check('counter', 1), ...check('guarded', 2), ...check('swapped', 4),
                0x53, 0xff, 0x15, ...u32(iat('ExitProcess')), // ExitProcess(ebx)
            ];
            const body = [
                ...cross,
                0xf0, 0xff, 0x05, ...u32(at('counter')), //        L: lock inc [counter]
                0xb8, ...u32(1), //                                S: mov eax, 1
                0x87, 0x05, ...u32(at('lock')), //                    xchg [lock], eax
                0x85, 0xc0, 0x75, 0xf1, //                            test eax, eax; jnz S
                0xff, 0x05, ...u32(at('guarded')), //                 inc [guarded]
                0xc7, 0x05, ...u32(at('lock')), ...u32(0), //        mov [lock], 0
                0xa1, ...u32(at('swapped')), //                       mov eax, [swapped]
                0x8d, 0x50, 0x01, //                               C: lea edx, [eax+1]
                0xf0, 0x0f, 0xb1, 0x15, ...u32(at('swapped')), //    lock cmpxchg [swapped], edx
                0x75, 0xf3, //                                        jnz C
            ];
            const worker = [
                0xb9, ...u32(N), //                                   mov ecx, N
                ...body,
                0x49, 0x0f, 0x85, ...u32(-(body.length + 1 + 6)), //  dec ecx; jnz L
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                      xor eax, eax; ret 4
            ];
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

/**
 * The exit code, and the scheduler's account of the executors.
 * @param {number} executors @param {boolean} [crossing]
 */
async function race(executors, crossing = false){
    const app = await createApp({ executable: buildRaceExe(crossing), executors,
        cpu: { eager: true } });
    try
    {
        const code = await app.run({ timeoutMs: 60_000 });
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        return { code, scheduler: kernel?.metrics?.scheduler ?? kernel?.metrics ?? null };
    }
    finally
    {
        await app.dispose();
    }
}

test('threads racing through memory end the same on one executor as on three at once', async()=>{
    const one = await race(1);
    assert.equal(one.code, 7, 'one executor, the threads taking turns');
    const three = await race(3);
    assert.equal(three.code, 7, 'three: every counter 2N with the threads at once');
    assert.equal(one.scheduler?.executorSlices, 0, 'one: every slice the process\'s own');
    assert.ok(three.scheduler?.executorSlices > 0, 'three: the threads ran on the others');
    // The main thread runs beside them until it waits: three at once at most.
    assert.ok(three.scheduler?.mostAtOnce >= 2, 'both workers at once');
});

test('the same with every thread calling into the host as it goes, the others\' calls answered '
    + 'inside those of the thread on the process\'s own executor', async()=>{
    const one = await race(1, true);
    assert.equal(one.code, 7, 'one executor');
    const three = await race(3, true);
    assert.equal(three.code, 7, 'three at once');
    assert.equal(three.scheduler?.mostAtOnce, 3, 'the main thread beside both workers');
});
