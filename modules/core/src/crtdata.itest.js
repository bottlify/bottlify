/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C runtime's variables, imported as data by a compiled program: the
 * standard streams as the records of `_iob`, the system version the runtime
 * keeps, HUGE_VAL and the environment. The fixture is built by
 * `scripts/build-fixtures.mjs` and prints one line per property, among what it
 * writes to the console on purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

test('the runtime\'s variables are where a program imported them', { timeout: 60000 },
    async t=>{
        const exe = await readFile(new URL('../test/fixtures/crtdata.exe', import.meta.url));
        const app = await createApp({
            executable: new Uint8Array(exe),
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));

        const code = await app.run({ timeoutMs: 20000 });

        const lines = output.join('').split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>line.startsWith('FAIL')), [],
            `every property holds:\n${output.join('')}`);
        assert.equal(lines.filter(line=>line.startsWith('ok   ')).length, 10, 'every one reached');
        assert.equal(code, 0);
    });
