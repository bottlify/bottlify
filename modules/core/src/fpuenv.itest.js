/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The floating-point environment a thread starts with, on every engine: the
 * first thread and every thread it creates start at the x87 control word 0x27f
 * and an MXCSR of 0x1f80, as Wine's thread tests hold Windows to, whatever the
 * creator set before it created them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

for (const engine of /** @type {const} */ (['emulator', 'cork']))
{
    test(`a thread starts with Windows' floating-point environment (${engine})`,
        { timeout: 60000 }, async t=>{
            const [wasm, exe] = await Promise.all([
                readFile(new URL('v86.wasm', PREBUILT)),
                readFile(new URL('../test/fixtures/fpuenv.exe', import.meta.url)),
            ]);
            const app = await createApp({
                executable: new Uint8Array(exe),
                engine,
                v86: {
                    moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                    wasmBytes: wasm.buffer.slice(wasm.byteOffset,
                        wasm.byteOffset + wasm.byteLength),
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
                output.join(''));
            assert.equal(lines.length, 6);
            assert.equal(code, 0);
        });
}
