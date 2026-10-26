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
 * that calls the program back, quadword answers in RAX, the pointers in
 * localeconv's structure and CommandLineToArgvW's array, and critical sections
 * three threads take at once, whose uncontended entries and leaves stay in the
 * guest.
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
        const layer = (/** @type {string} */ name)=>app.diagnostics()
            .find((/** @type {any} */ found)=>found.name === name);
        const sections = layer('win32')?.metrics?.criticalSections;
        /** @type {Map<string, number>} */
        const hot = new Map(layer('bridge')?.metrics?.hot ?? []);
        // 1 804 the program's own (the loader lock's at each thread's start and end besides).
        assert.ok(sections.entered >= 1804 && sections.left === sections.entered,
            JSON.stringify(sections));
        assert.ok(sections.waits > 0 && sections.wakes === sections.waits,
            JSON.stringify(sections));
        assert.equal(hot.get('KERNEL32.dll!EnterCriticalSection'), sections.waits,
            'an entry crosses only to wait');
        assert.equal(hot.get('KERNEL32.dll!LeaveCriticalSection'), sections.wakes,
            'a leave only to wake');
    });
