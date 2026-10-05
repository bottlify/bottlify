/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * QueryPerformanceCounter read in a spin loop advances at the rate of time,
 * not of the reads. Each answer being later than the last (qpc.itest.js) is
 * paid for by one tick per read where the clock stands still, so a counter
 * whose tick is coarser than a read runs ahead of the clock by the number of
 * reads: a program that waits on it, times its frames by it or measures the
 * processor's speed against it (the time-stamp counter's delta over the
 * counter's) saw time pass several times faster than it did.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** How long the program spins, as the counter counts it, in milliseconds. */
const SPIN_MS = 200;

/**
 * A program that spins on the counter until a tenth of a second of its ticks
 * have passed, then exits.
 */
function buildSpinExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': [
            'QueryPerformanceCounter', 'QueryPerformanceFrequency', 'ExitProcess'] },
        codeSize: 0x100,
        data: {
            frequency: new Array(8).fill(0),
            start: new Array(8).fill(0),
            current: new Array(8).fill(0),
        },
        code: ({ iat, at })=>{
            const read = (/** @type {string} */ name)=>[0x68, ...u32(at(name)),
                0xff, 0x15, ...u32(iat('QueryPerformanceCounter'))];
            const body = [
                ...read('current'),
                0xa1, ...u32(at('current')), //                 mov eax, [current]
                0x2b, 0x05, ...u32(at('start')), //             sub eax, [start]
                0x8b, 0x15, ...u32(at('current') + 4), //       mov edx, [current+4]
                0x1b, 0x15, ...u32(at('start') + 4), //         sbb edx, [start+4]
            ];
            const exit = [0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))];
            const compare = [0x39, 0xd8]; //                     cmp eax, ebx
            // jnz exit, then jb loop back over everything.
            const tail = [0x75, compare.length + 2];
            const back = -(body.length + tail.length + compare.length + 2);
            return [
                0x68, ...u32(at('frequency')), //               QueryPerformanceFrequency(&f)
                0xff, 0x15, ...u32(iat('QueryPerformanceFrequency')),
                0xa1, ...u32(at('frequency')), //               mov eax, [f]
                0x31, 0xd2, //                                  xor edx, edx
                0xb9, ...u32(1000 / SPIN_MS), //                mov ecx, 1000 / SPIN_MS
                0xf7, 0xf1, //                                  div ecx
                0x89, 0xc3, //                                  mov ebx, eax  (ticks to spin for)
                ...read('start'),
                ...body, ...tail, ...compare,
                0x72, back & 0xff, //                           jb loop
                ...exit,
            ];
        },
    });
}

test('a spin on QueryPerformanceCounter takes as long as the counter says', async()=>{
    const app = await createApp({ executable: buildSpinExe() });
    try
    {
        const began = performance.now();
        assert.equal(await app.run({ timeoutMs: 20000 }), 0);
        const took = performance.now() - began;
        // The run includes the start, so this can only be longer than the
        // spin; a counter running ahead of time makes it shorter.
        assert.ok(took >= SPIN_MS * 0.9,
            `${SPIN_MS} ms of counter took ${took.toFixed(0)} ms`);
    }
    finally
    {
        await app.dispose();
    }
});
