/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread whose stack runs out stops its process. Translated code writes
 * through esp without testing the page, so there is no guard page for a push
 * to touch: a thread pushing past its stack walked on through what lay below
 * it - the other threads' stacks, then the process's copy of the engine's
 * tables - and the engine's thread hung in its entry hash, which the pushes
 * had written over. The scheduler sees the stack pointer past its stack at the
 * next turn (`pastItsStack`) and stops the process on the overflow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/** `push eax; jmp` back to it: a stack that never comes back up. */
const PUSHING = [0x50, 0xeb, 0xfd];

/** A thread that pushes, started by the main thread, which waits for it. */
const program = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess'] },
    codeSize: 0x80,
    code: ({ iat, code })=>[
        0x6a, 0, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(code(0x40)),
        0x6a, 0, 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateThread')),
        0x6a, 0xff, 0x50,
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ].concat(new Array(0x40).fill(0x90)).slice(0, 0x40).concat(PUSHING),
});

// A thread's stack is in the pool, over the gap above the engine's tables: a
// turn's pushes reach no further than that gap. The main thread's stack, low in
// the space, has the engine's first pages and address 0 a megabyte or two below
// it, which a turn of a million pushes passes; that walk ends in a fault of the
// engine's memory, not a hang, and is cork's to stop (an esp floor at back edges).
test('a thread pushing past its stack stops the process on the overflow',
    { timeout: 300_000 }, async()=>{
        const app = await createApp({ executable: program(), imagePath: 'C:\\App\\push.exe' });
        try
        {
            await assert.rejects(app.run({ maxTurns: 100_000 }), (/** @type {any} */ error)=>{
                assert.equal(error.reason, 'guest-fault', String(error.message));
                assert.match(String(error.message), /past the bottom of its stack/);
                return true;
            });
        }
        finally
        {
            await app.dispose();
        }
    });
