/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Floating-point arguments and results of the system's functions in a 64-bit
 * process, through `createApp` (`test/fixtures/src/float64.c` says which):
 * floats and doubles among the first four arguments in the XMM register of
 * their position, results in XMM0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/float64.exe', import.meta.url);

test('a 64-bit program passes and is answered floats and doubles in XMM registers',
    { timeout: 120000 }, async t=>{
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            commandLine: '"C:\\float64.exe"', engine: 'cork' });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 100000 });
        const text = output.join('');
        const lines = text.split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [], text);
        assert.equal(lines.length, 16, `every check was reached:\n${text}`);
        assert.equal(code, 0, text);
    });
