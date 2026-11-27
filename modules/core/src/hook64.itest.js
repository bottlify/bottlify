/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit program's window hooks through `createApp` (`test/fixtures/src/hook64.c`
 * says which): each hook procedure called with the structures a hook is handed
 * in their 64-bit layouts, SendInput's 40-byte INPUT records, CallNextHookEx
 * along the chain, and nothing called once unhooked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/hook64.exe', import.meta.url);

test('a 64-bit program\'s CBT, GetMessage, keyboard and mouse hooks are called with its layouts',
    { timeout: 120000 }, async t=>{
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            commandLine: '"C:\\hook64.exe"' });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 100000 });
        const text = output.join('');
        const lines = text.split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [], text);
        assert.equal(lines.length, 9, `every check was reached:\n${text}`);
        assert.equal(code, 0, text);
    });
