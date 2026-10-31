/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Table-based structured exception handling in a 64-bit process, through
 * `createApp` (`test/fixtures/src/seh64.c` says which): a raised exception and
 * processor faults reaching their `__except` filter through the images' unwind
 * tables, a `__finally` the unwind runs on the way, and a hundred faults in a
 * row. No handler chain at FS:[0] is involved -- a 64-bit thread has none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/seh64.exe', import.meta.url);

test('a 64-bit program dispatches exceptions through its unwind tables',
    { timeout: 120000 }, async t=>{
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            commandLine: '"C:\\seh64.exe"' });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 100000 });
        const text = output.join('');
        assert.doesNotMatch(text, /FAIL/, text);
        assert.match(text, /^ok {3}a raised exception reaches its __except block$/m, text);
        assert.match(text, /^ok {3}a divide by zero is an exception$/m, text);
        assert.match(text, /^ok {3}a __finally runs as the stack unwinds past it$/m, text);
        assert.match(text, /^ok {3}an inner __finally runs before the outer __except$/m, text);
        assert.match(text, /^ok {3}a hundred faults in a row$/m, text);
        assert.match(text, /^ok {3}a __finally around the __except that took it runs once/m,
            text);
        assert.equal(code, 0, text);
    });
