/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a processor played by the process's own executor
 * (`playPinned` in the kernel's scheduler): a main thread pinned to the first
 * processor computes, a worker pinned to the second calls into the host every
 * hundred instructions, and both ask which processor they are on throughout.
 * With the trade the worker runs on the process's executor and its calls are
 * answered there, and the trial that weighs the trade keeps it, the worker
 * going faster so; without it each call crosses from the other executor.
 * Either way no thread is told of a processor its mask does not name, through
 * the trial's trades back and forth too, and the program ends alike.
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
const ROUNDS = 3_000_000;
const OUTER = 100;
const INNER = 400_000;

/**
 * Main pinned to processor 0 computing a little, then waiting; a worker pinned
 * to processor 1 calling the host. Main computes briefly so the trial weighs
 * the worker: its instructions retired are what the trial measures.
 */
function buildProgram(workerProcessor = 1){
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

/**
 * The exit code and the scheduler's account of a run on two executors.
 *
 * @param {Uint8Array} executable @param {boolean} playPinned
 */
async function run(executable, playPinned, cpu = {}){
    const app = await createApp({ executable,
        cpu: { cores: 2, eager: true, placement: 'spread', playPinned, ...cpu } });
    try
    {
        const code = await app.run({ timeoutMs: 120_000 });
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        const scheduler = kernel?.metrics?.scheduler ?? kernel?.metrics ?? null;
        return { code: code >>> 0, played: scheduler?.played ?? null,
            placement: JSON.parse(scheduler?.placement ?? '{}'),
            crossings: JSON.parse(scheduler?.sharedTime ?? '{}').crossings ?? -1 };
    }
    finally
    {
        await app.dispose();
    }
}

test('a worker pinned to the second processor and bound to the host has it played by the'
    + ' process\'s executor; no thread is told of a processor its mask does not name, played or'
    + ' not', { timeout: 300_000 }, async()=>{
    const executable = buildProgram();
    const fixed = await run(executable, false);
    assert.equal(fixed.code, 0, `fixed: ${fixed.code & 0xffff} wrong answers to main, `
        + `${fixed.code >>> 16} to the worker`);
    assert.deepEqual([fixed.played, fixed.placement.moves], ['', 0],
        'no trade nor move where none is asked for');
    const played = await run(executable, true);
    assert.equal(played.code, 0, `played: ${played.code & 0xffff} wrong answers to main, `
        + `${played.code >>> 16} to the worker`);
    assert.match(String(played.played), /^1,0 after \d+$/, 'processor 1 played here, 0 there, at'
        + ` the end: ${JSON.stringify(played.placement)}`);
    assert.ok(played.placement.moves >= 1,
        `its gains made it: ${JSON.stringify(played.placement)}`);
    assert.ok(fixed.crossings > ROUNDS && played.crossings < fixed.crossings / 2,
        `the worker's calls crossed ${fixed.crossings} times fixed, ${played.crossings} played`);
});

test('with freeHost the main thread pinned to the first processor runs on another executor, the'
    + ' process\'s own playing a processor nothing is pinned to, and no thread is told of a'
    + ' processor its mask does not name', { timeout: 300_000 }, async()=>{
    const freed = await run(buildProgram(2), true, { cores: 3, freeHost: true });
    assert.equal(freed.code, 0, `${freed.code & 0xffff} wrong answers to main, `
        + `${freed.code >>> 16} to the worker`);
    // Main asks which processor it is on throughout: told 0 every time, with
    // the first processor played by executor 1, it ran there and never here.
    assert.match(String(freed.played), /^1,0 after \d+$/,
        'the first processor played by executor 1, the second by this one');
    assert.deepEqual([freed.placement.moves], [0], 'and no move beside it');
});
