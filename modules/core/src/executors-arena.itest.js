/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One translation for every executor of a process past its own (roadmap/v2,
 * stage 3): their translations are made for the process's shared layout, the
 * same bytes on each, and kept in one arena all of them and their translators
 * share. A routine made hot by a thread on one of them and then run by a
 * thread on another is not emitted there again: the second takes the first's
 * functions from the arena. (The process's own executor translates for a
 * layout of its own, its state at constant addresses.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_OFFSET = 0x100;
const ROUTINE_OFFSET = 0x140;
/** Times round the routine's loop: long enough to be translated wherever it runs. */
const LOOPS = 5_000_000;

/**
 * The main thread starts a worker held to the second executor, waits for it,
 * then another held to the third and waits for it, and exits with what the
 * routine answered: each runs the routine, on an executor of its own.
 */
function buildExecutable(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'SetThreadAffinityMask', 'ResumeThread',
            'WaitForSingleObject', 'ExitProcess'] },
        codeSize: ROUTINE_OFFSET + 0x40,
        data: { worker: [0, 0, 0, 0], answer: [0, 0, 0, 0] },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** call ROUTINE from `from` @param {number} from */
            const callRoutine = from=>[0xe8, ...u32(ROUTINE_OFFSET - (from + 5))];
            /** A worker held to executor `index`, started and waited for. @param {number} index */
            const runOn = index=>[
                // CreateThread(NULL, 0, worker, NULL, CREATE_SUSPENDED, NULL)
                0x6a, 0x00, 0x6a, 0x04, 0x6a, 0x00, 0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at('worker')),
                0x6a, 1 << index, 0xff, 0x35, ...u32(at('worker')),
                ...call('SetThreadAffinityMask'),
                0xff, 0x35, ...u32(at('worker')), ...call('ResumeThread'),
                0x6a, 0xff, 0xff, 0x35, ...u32(at('worker')), ...call('WaitForSingleObject'),
            ];
            const main = [...runOn(1), ...runOn(2),
                0xff, 0x35, ...u32(at('answer')), ...call('ExitProcess')]; // ExitProcess([answer])
            const worker = [...callRoutine(WORKER_OFFSET),
                0xa3, ...u32(at('answer')), //           mov [answer], eax
                0x31, 0xc0, 0xc2, 0x04, 0x00]; //        xor eax, eax; ret 4
            const routine = [
                0xb9, ...u32(LOOPS), //                  mov ecx, LOOPS
                0x31, 0xc0, //                           xor eax, eax
                0x01, 0xc8, //                           L: add eax, ecx
                0xc1, 0xc0, 0x03, //                        rol eax, 3
                0x49, 0x75, 0xf8, //                        dec ecx; jnz L
                0x25, 0xff, 0x00, 0x00, 0x00, //         and eax, 0xff
                0xc3, //                                 ret
            ];
            if (main.length > WORKER_OFFSET)
            {
                throw new Error(`main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90),
                ...worker, ...new Array(ROUTINE_OFFSET - WORKER_OFFSET - worker.length).fill(0x90),
                ...routine];
        },
    });
}

/** What the routine answers, as x86 computes it. */
function expected(){
    let eax = 0;
    for (let ecx = LOOPS; ecx > 0; ecx--)
    {
        eax = (eax + ecx) >>> 0;
        eax = ((eax << 3) | (eax >>> 29)) >>> 0;
    }
    return eax & 0xff;
}

test('a routine a thread made hot on one executor is taken from the process\'s arena on another',
    { timeout: 120_000 }, async()=>{
        const app = await createApp({ executable: buildExecutable(), cpu: { cores: 3 } });
        try
        {
            const code = await app.run({ timeoutMs: 60_000 });
            const tables = await app.diagnostics();
            const cpu = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'cpu');
            const arena = cpu?.metrics?.cork?.arena;
            assert.equal(code >>> 0, expected());
            assert.ok(arena, 'the process has an arena');
            // Looked up on both, written by the first: one emission for the two.
            assert.ok(arena.hits > 0 && arena.writes < arena.lookups,
                `the arena: ${JSON.stringify(arena)}`);
        }
        finally
        {
            await app.dispose();
        }
    });
