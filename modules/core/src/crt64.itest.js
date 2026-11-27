/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An x86-64 program on msvcrt's start-up and kernel32's structures, through
 * `createApp`: the runtime and the system lay out what they hand a 64-bit
 * process with 8-byte pointers (`test/fixtures/src/crt64.c` says which).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/crt64.exe', import.meta.url);

test('an x86-64 program starts on msvcrt and reads 64-bit structures', { timeout: 120000 },
    async t=>{
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            commandLine: '"C:\\crt64.exe" one two' });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 100000 });
        const text = output.join('');
        assert.doesNotMatch(text, /FAILED/, text);
        assert.match(text, /^argv\[2\]=two$/m);
        assert.match(text, /failed 0\nbye\n$/, 'exit ran the handler _onexit registered');
        assert.equal(code, 0);
    });
