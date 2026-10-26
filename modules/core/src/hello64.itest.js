/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The first x86-64 program, through `createApp`: a PE32+ image linked above
 * 4 GiB is placed below it, runs in long mode on cork's long-mode interpreter,
 * calls the host through the x64 convention and ends with the exit code it
 * computed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/hello64.exe', import.meta.url);

test('an x86-64 console program prints its line and exits with 0', { timeout: 120000 }, async t=>{
    const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
        engine: 'cork' });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    const code = await app.run({ timeoutMs: 100000 });
    assert.equal(output.join(''), 'hello from x64, fib(25)=75025\n');
    assert.equal(code, 0, 'the program checked its own arithmetic');
});
