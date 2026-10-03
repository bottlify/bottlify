/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The floating-point environment a thread starts with: the
 * first thread and every thread it creates start at the x87 control word 0x27f
 * and an MXCSR of 0x1f80, as Wine's thread tests hold Windows to, whatever the
 * creator set before it created them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

test('a thread starts with Windows\' floating-point environment',
    { timeout: 60000 }, async t=>{
        const exe = await readFile(new URL('../test/fixtures/fpuenv.exe', import.meta.url));
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
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [],
            output.join(''));
        assert.equal(lines.length, 6);
        assert.equal(code, 0);
    });
