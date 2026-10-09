/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program whose only thread sleeps, on a process with executors: the clock
 * is moved to the sleep's end and the thread woken by it runs, as with one
 * executor -- the turn that woke it does not report an idle machine whose
 * every thread has ended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

test('a lone thread that sleeps wakes and runs on three executors', { timeout: 60_000 },
    async()=>{
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['Sleep', 'ExitProcess'] },
            code: ({ iat })=>[
                0x6a, 0x32, 0xff, 0x15, ...u32(iat('Sleep')), //   Sleep(50)
                0x6a, 0x32, 0xff, 0x15, ...u32(iat('Sleep')), //   Sleep(50)
                0x6a, 0x07, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        for (const executors of [1, 3])
        {
            const app = await createApp({ executable, executors });
            try
            {
                assert.equal(await app.run({ timeoutMs: 30_000 }), 7, `${executors} executor(s)`);
            }
            finally
            {
                await app.dispose();
            }
        }
    });
