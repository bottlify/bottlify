/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * QueryPerformanceCounter read over and over by a real program: every answer
 * later than the one before, inside one slice too. The guest's clock is
 * credited between slices, so two reads inside one found the same counter,
 * and a program timing a stretch of its own code by two reads -- Diablo II's
 * single-player server, which times each of its ticks so -- took a zero for
 * time that had passed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** Reads of the counter, back to back. */
const READS = 1000;

/**
 * A program that reads the counter READS times and exits with how many
 * answers were no later than the one before.
 */
function buildCounterExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['QueryPerformanceCounter', 'ExitProcess'] },
        codeSize: 0x100,
        data: { previous: new Array(8).fill(0), current: new Array(8).fill(0) },
        code: ({ iat, at })=>[
            0x31, 0xf6, //                                  xor esi, esi
            0xbf, ...u32(READS), //                         mov edi, READS
            0x68, ...u32(at('previous')), //                QueryPerformanceCounter(&previous)
            0xff, 0x15, ...u32(iat('QueryPerformanceCounter')),
            // loop:
            0x68, ...u32(at('current')), //                 QueryPerformanceCounter(&current)
            0xff, 0x15, ...u32(iat('QueryPerformanceCounter')),
            0xa1, ...u32(at('current')), //                 mov eax, [current]
            0x8b, 0x15, ...u32(at('current') + 4), //       mov edx, [current+4]
            0x3b, 0x15, ...u32(at('previous') + 4), //      cmp edx, [previous+4]
            0x77, 11, //                                    ja later
            0x72, 8, //                                     jb notLater
            0x3b, 0x05, ...u32(at('previous')), //          cmp eax, [previous]
            0x77, 1, //                                     ja later
            // notLater:
            0x46, //                                        inc esi
            // later:
            0xa3, ...u32(at('previous')), //                mov [previous], eax
            0x89, 0x15, ...u32(at('previous') + 4), //      mov [previous+4], edx
            0x4f, //                                        dec edi
            0x75, 0xc9, //                                  jnz loop
            0x56, //                                        push esi
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

test('QueryPerformanceCounter answers later every time a program asks, inside one slice too',
    async()=>{
        const app = await createApp({ executable: buildCounterExe() });
        try
        {
            assert.equal(await app.run({ timeoutMs: 8000 }), 0,
                'no answer no later than the one before it');
        }
        finally
        {
            await app.dispose();
        }
    });
