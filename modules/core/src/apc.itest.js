/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Asynchronous procedure calls, as a compiled program queues and waits for
 * them: run by their thread in an alertable wait and never in any other, from
 * QueueUserAPC and from a waitable timer's completion routine. The fixture is
 * built by `scripts/build-fixtures.mjs` and prints one line per property.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

test('APCs run in alertable waits, on their own thread, and nowhere else', { timeout: 60000 },
    async t=>{
        const [wasm, exe] = await Promise.all([
            readFile(new URL('v86.wasm', PREBUILT)),
            readFile(new URL('../test/fixtures/apc.exe', import.meta.url)),
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

        const lines = output.join('').split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [],
            `every property holds:\n${output.join('')}`);
        assert.equal(lines.length, 9, 'and every one was reached');
        assert.equal(code, 0);
    });
