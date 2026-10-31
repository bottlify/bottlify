/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the process's own executor kept for the host's answers
 * (`freeTarget` in the kernel's scheduler): a main thread pinned to the first
 * processor computes, a worker pinned to another calls into the host every
 * hundred instructions, and both ask which processor they are on throughout.
 * The first processor is played by another executor, the process's own playing
 * one nothing is pinned to, and no thread is told of a processor its mask does
 * not name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { assemble, buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_AT = 0x200;
/**
 * The worker's calls, two each. A tenth of the three million it made: every
 * one crossing between two threads that a busy machine schedules in turn, a
 * run took past two minutes with four busy processes beside the suite.
 */
const ROUNDS = 300_000;
const OUTER = 100;
const INNER = 400_000;

/**
 * Main pinned to processor 0 computing a little, then waiting; a worker pinned
 * to processor `workerProcessor` calling the host.
 *
 * @param {number} workerProcessor
 */
function buildProgram(workerProcessor){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess',
            'SetThreadAffinityMask', 'GetCurrentThread', 'GetCurrentProcessorNumber', 'GetACP'] },
        codeSize: WORKER_AT + 0x100,
        data: { worker: u32(0), mainWrong: u32(0), workerWrong: u32(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /**
             * SetThreadAffinityMask(GetCurrentThread(), mask)
             * @param {number} mask @returns {any[]}
             */
            const pin = mask=>[...call('GetCurrentThread'), 0x6a, mask, 0x50,
                ...call('SetThreadAffinityMask')];
            /**
             * Counts the processor asked for not being `want` at `slot`.
             * @param {number} want @param {string} slot @returns {any[]}
             */
            const check = (want, slot)=>[...call('GetCurrentProcessorNumber'),
                0x83, 0xf8, want, //                                   cmp eax, want
                { jump: 'jz', to: `${slot}Right` },
                0xff, 0x05, ...u32(at(slot)), //                        inc dword [slot]
                { label: `${slot}Right` }];
            const main = assemble([
                ...pin(1),
                // CreateThread(NULL, 0, worker, NULL, 0, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at('worker')),
                0xbe, ...u32(OUTER), //                                 mov esi, OUTER
                { label: 'outer' },
                0xb9, ...u32(INNER), //                                 mov ecx, INNER
                { label: 'inner' },
                0x49, { jump: 'jnz', to: 'inner' }, //                  dec ecx; jnz inner
                ...check(0, 'mainWrong'),
                0x4e, { jump: 'jnz', to: 'outer' }, //                  dec esi; jnz outer
                0x6a, 0xff, 0xff, 0x35, ...u32(at('worker')), ...call('WaitForSingleObject'),
                // ExitProcess(mainWrong + workerWrong << 16)
                0xa1, ...u32(at('workerWrong')), 0xc1, 0xe0, 0x10, //   mov eax, [w]; shl eax, 16
                0x03, 0x05, ...u32(at('mainWrong')), //                 add eax, [mainWrong]
                0x50, ...call('ExitProcess'),
            ]);
            const worker = assemble([
                ...pin(1 << workerProcessor),
                0xbe, ...u32(ROUNDS), //                                mov esi, ROUNDS
                { label: 'round' },
                ...call('GetACP'),
                ...check(workerProcessor, 'workerWrong'),
                0xb9, ...u32(30), //                                    mov ecx, 30
                { label: 'spin' },
                0x49, { jump: 'jnz', to: 'spin' }, //                   dec ecx; jnz spin
                0x4e, { jump: 'jnz', to: 'round' }, //                  dec esi; jnz round
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                        xor eax, eax; ret 4
            ]);
            if (main.length > WORKER_AT)
            {
                throw new Error(`main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc), ...worker];
        },
    });
}

test('the main thread pinned to the first processor runs on another executor, the process\'s'
    + ' own playing a processor nothing is pinned to, and no thread is told of a processor its'
    + ' mask does not name', { timeout: 900_000 }, async()=>{
    const app = await createApp({ executable: buildProgram(2), cpu: { cores: 3 } });
    try
    {
        // Bounded by the test, not the run: alone it takes about 20 s, under the
        // whole suite and other runs beside it (a load of 12 on four cores) past 120.
        const code = await app.run({ timeoutMs: 840_000 }) >>> 0;
        assert.equal(code, 0, `${code & 0xffff} wrong answers to main, ${code >>> 16} to the`
            + ' worker');
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        const scheduler = kernel?.metrics?.scheduler ?? kernel?.metrics ?? null;
        // Main asks which processor it is on throughout: told 0 every time, with
        // the first processor played by executor 1, it ran there and never here.
        assert.match(String(scheduler?.played ?? null), /^1,0 after \d+$/,
            'the first processor played by executor 1, the second by this one');
    }
    finally
    {
        await app.dispose();
    }
});
