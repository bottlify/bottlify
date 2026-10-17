/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The executors' order gate: a message passed between
 * two threads through plain stores alone -- the payload, then a flag after it,
 * and an answer back -- arrives whole, as x86 orders stores, with the two
 * threads on two executors running at once. No locked instruction, no call
 * into the host between them: what orders the payload before the flag is the
 * order of the stores and of the loads alone.
 *
 * The producer fills `length` words from a generator seeded by the run and
 * raises the flag to the round's number; the consumer, spinning on the flag,
 * computes the same words and counts those it found otherwise, then answers
 * with the round's number, which the producer waits for before the next one.
 * The program exits with the count.
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
const ROUNDS = 3000;
const MULTIPLIER = 1103515245;
const INCREMENT = 12345;

/**
 * The words of each round, made the same way by both threads: esi steps a
 * linear congruential generator, one step a word.
 *
 * @returns {number[]}  imul esi, esi, MULTIPLIER; add esi, INCREMENT
 */
const step = ()=>[0x69, 0xf6, ...u32(MULTIPLIER), 0x81, 0xc6, ...u32(INCREMENT)];

/** @param {number} seed @param {number} length  words a message carries, 1 to 64 */
function buildProgram(seed, length){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess'] },
        codeSize: 0x400,
        data: {
            flag: u32(0), answer: u32(0), errors: u32(0), handle: u32(0),
            payload: new Array(64 * 4).fill(0),
        },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            const main = assemble([
                // CreateThread(NULL, 0, consumer, NULL, 0, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at('handle')),
                0xbe, ...u32(seed), //                                mov esi, seed
                0xbb, ...u32(1), //                                   mov ebx, 1
                { label: 'round' },
                0x31, 0xc9, //                                        xor ecx, ecx
                { label: 'fill' },
                ...step(),
                0x89, 0x34, 0x8d, ...u32(at('payload')), //           mov [payload + ecx*4], esi
                0x41, //                                              inc ecx
                0x81, 0xf9, ...u32(length), { jump: 'jb', to: 'fill' }, // cmp ecx, length
                0x89, 0x1d, ...u32(at('flag')), //                    mov [flag], ebx
                { label: 'wait' },
                0xf3, 0x90, //                                        pause
                0x39, 0x1d, ...u32(at('answer')), { jump: 'jnz', to: 'wait' }, // cmp [answer], ebx
                0x43, //                                              inc ebx
                0x81, 0xfb, ...u32(ROUNDS + 1), { jump: 'jb', to: 'round' },
                0x6a, 0xff, 0xff, 0x35, ...u32(at('handle')), ...call('WaitForSingleObject'),
                0xff, 0x35, ...u32(at('errors')), ...call('ExitProcess'),
            ]);
            const worker = assemble([
                0xbe, ...u32(seed), //                                mov esi, seed
                0xbb, ...u32(1), //                                   mov ebx, 1
                { label: 'round' },
                0xf3, 0x90, //                                        pause
                0x39, 0x1d, ...u32(at('flag')), { jump: 'jnz', to: 'round' }, // cmp [flag], ebx
                0x31, 0xc9, //                                        xor ecx, ecx
                { label: 'check' },
                ...step(),
                0x39, 0x34, 0x8d, ...u32(at('payload')), //           cmp [payload + ecx*4], esi
                { jump: 'jz', to: 'same' },
                0xff, 0x05, ...u32(at('errors')), //                  inc dword [errors]
                { label: 'same' },
                0x41, //                                              inc ecx
                0x81, 0xf9, ...u32(length), { jump: 'jb', to: 'check' }, // cmp ecx, length
                0x89, 0x1d, ...u32(at('answer')), //                  mov [answer], ebx
                0x43, //                                              inc ebx
                0x81, 0xfb, ...u32(ROUNDS + 1), { jump: 'jb', to: 'round' },
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                      xor eax, eax; ret 4
            ]);
            if (main.length > WORKER_AT)
            {
                throw new Error(`main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc), ...worker];
        },
    });
}

/** The run's seeds: a message's words and its length follow from each. */
const SEEDS = [0x2545f491, 0x9e3779b9, 0x00c0ffee];

for (const seed of SEEDS)
{
    const length = 1 + seed % 64;
    test(`a message passed through plain stores arrives whole on two executors (seed `
        + `0x${seed.toString(16)}, ${length} words)`, { timeout: 120_000 }, async()=>{
        const app = await createApp({ executable: buildProgram(seed, length),
            cpu: { cores: 2, eager: true } });
        try
        {
            const errors = await app.run({ timeoutMs: 90_000 });
            const tables = await app.diagnostics();
            const kernel = (Array.isArray(tables) ? tables : [])
                .find(table=>table.name === 'kernel');
            const scheduler = kernel?.metrics?.scheduler ?? kernel?.metrics;
            assert.equal(errors >>> 0, 0, 'words the consumer found other than the producer wrote');
            assert.ok(scheduler?.mostAtOnce >= 2, 'the two threads ran at once');
        }
        finally
        {
            await app.dispose();
        }
    });
}
