/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The processor is described once, in `kernel32/processor.js`, and every way
 * a program asks about it answers from that record. This runs the program
 * that asks all of them -- the CPUID instruction included -- and holds the
 * record to what the emulated processor itself says, so the two cannot drift
 * apart when the emulator does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { CPUID } from './layers/win32/kernel32/processor.js';

/** Leaf 1's EDX bit saying the package holds more than one logical processor. */
const HTT = 1 << 28;

for (const cores of [1, 4])
{
    test(`every description of the processor agrees with CPUID, and the record is CPUID (${cores})`,
        { timeout: 60000 }, async t=>{
            const exe = await readFile(new URL('../test/fixtures/processor.exe', import.meta.url));
            const app = await createApp({
                executable: new Uint8Array(exe),
                cpu: { cores },
            });
            t.after(()=>app.dispose());
            /** @type {string[]} */
            const output = [];
            app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
                output.push(text));

            const code = await app.run({ timeoutMs: 20000 });

            const [first, ...lines] = output.join('').split('\r\n').filter(Boolean);
            const [signature, ecx, edx] = first.split(' ').slice(1).map(Number);
            // The record is one processor's; more set HTT and nothing else in it.
            assert.deepEqual({ signature, ecx, edx }, { signature: CPUID.signature, ecx: CPUID.ecx,
                edx: (cores > 1 ? CPUID.edx | HTT : CPUID.edx) >>> 0 },
            'the record is what the processor answers');
            assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [],
                `every description agrees with it:\n${output.join('')}`);
            assert.equal(lines.length, 11);
            assert.equal(code, 0);
        });
}
