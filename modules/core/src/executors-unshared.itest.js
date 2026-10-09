/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Executors asked for where memory cannot be shared -- a page that is not
 * cross-origin isolated has no SharedArrayBuffer -- run the program on one, as
 * by default, and the cpu's report says why; the launch does not fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

test('three executors without SharedArrayBuffer run the program on one and say why',
    { timeout: 60_000 }, async()=>{
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            code: ({ iat })=>[0x6a, 0x07, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const shared = globalThis.SharedArrayBuffer;
        // As on a page served without COOP/COEP.
        // @ts-ignore -- removed for the run, put back below
        delete globalThis.SharedArrayBuffer;
        try
        {
            const app = await createApp({ executable, executors: 3 });
            try
            {
                assert.equal(await app.run({ timeoutMs: 30_000 }), 7);
                const tables = await app.diagnostics();
                const cpu = (Array.isArray(tables) ? tables : [])
                    .find(table=>table.name === 'cpu');
                assert.match(String(cpu?.metrics?.executorsRefused),
                    /3 asked, 1 run: no SharedArrayBuffer/);
                assert.deepEqual(cpu?.metrics?.executors, []);
            }
            finally
            {
                await app.dispose();
            }
        }
        finally
        {
            globalThis.SharedArrayBuffer = shared;
        }
    });
