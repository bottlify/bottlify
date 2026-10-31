/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit window program through `createApp` (`test/fixtures/src/window64.c`
 * says which properties): its class, its window, the structures the system
 * hands its procedure and fills for it in their 64-bit layouts, its
 * pointer-sized longs, its message loop and a paint with GDI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/window64.exe', import.meta.url);

test('a 64-bit program registers a class, makes a window, paints it and quits',
    { timeout: 120000 }, async t=>{
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            commandLine: '"C:\\window64.exe"' });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 100000 });
        const text = output.join('');
        const lines = text.split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [], text);
        assert.equal(lines.length, 22, `every check was reached:\n${text}`);
        assert.equal(code, 0, text);
    });
