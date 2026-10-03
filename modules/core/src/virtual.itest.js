/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VirtualAlloc and VirtualFree driven by a compiled program: a reservation
 * placed where the program asked, commits and decommits inside it, and the
 * last error behind each refusal. The fixture prints one line per property.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

test('virtual memory: placed reservations, commits inside them, and why each refusal failed',
    { timeout: 60000 }, async t=>{
        const exe = await readFile(new URL('../test/fixtures/virtual.exe', import.meta.url));
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
            `every property holds:\n${output.join('')}`);
        assert.equal(lines.length, 18, 'and every one was reached');
        assert.equal(code, 0);
    });
