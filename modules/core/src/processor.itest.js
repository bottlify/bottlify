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

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

test('every description of the processor agrees with CPUID, and the record is CPUID',
    { timeout: 60000 }, async t=>{
        const [wasm, exe] = await Promise.all([
            readFile(new URL('v86.wasm', PREBUILT)),
            readFile(new URL('../test/fixtures/processor.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(exe),
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));

        const code = await app.run({ timeoutMs: 20000 });

        const [first, ...lines] = output.join('').split('\r\n').filter(Boolean);
        const [signature, ecx, edx] = first.split(' ').slice(1).map(Number);
        assert.deepEqual({ signature, ecx, edx },
            { signature: CPUID.signature, ecx: CPUID.ecx, edx: CPUID.edx },
            'the record is what the processor answers');
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [],
            `every description agrees with it:\n${output.join('')}`);
        assert.equal(lines.length, 11);
        assert.equal(code, 0);
    });
