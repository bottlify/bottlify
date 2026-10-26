/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An x86-64 program on what a 64-bit process is given at its own width,
 * through `createApp` (`test/fixtures/src/win64.c` says which): the thread
 * and process blocks GS reaches, the static thread-local storage and TLS
 * callback of its own directory, a second thread and its start and end told
 * to the callback, a wait on an array of quadword handles, a runtime routine
 * that calls the program back, quadword answers in RAX, and the pointers in
 * localeconv's structure and CommandLineToArgvW's array.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/win64.exe', import.meta.url);

test('an x86-64 program finds its blocks, thread-local storage and answers at 64 bits',
    { timeout: 120000 }, async t=>{
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            commandLine: '"C:\\win64.exe" one two', engine: 'cork' });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 100000 });
        const text = output.join('');
        assert.doesNotMatch(text, /FAILED/, text);
        assert.match(text, /^ok the TLS callback heard the thread start and end/m);
        assert.match(text, /failed 0\n$/, text);
        assert.equal(code, 0);
    });
