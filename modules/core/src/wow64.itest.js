/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit program and its children on one 64-bit machine
 * (`test/fixtures/src/wow64.c`, `wow64_child.c`): the 32-bit child runs under
 * WOW64 and says so every way a program asks, the 64-bit one does not, and the
 * parent starts both through its 64-bit STARTUPINFO and PROCESS_INFORMATION and
 * reads their exit codes. A run of a 32-bit program alone is on a 32-bit
 * machine, as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

/** @param {string} name */
const fixture = name=>readFile(new URL(`../test/fixtures/${name}.exe`, import.meta.url));

test('a 64-bit program starts a 32-bit child under WOW64 and a 64-bit one beside it',
    { timeout: 120000 }, async t=>{
        const [parent, child, hello] = await Promise.all(
            ['wow64', 'wow64_child', 'hello64'].map(fixture));
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\wow64.exe',
            engine: 'cork',
            storage: { load: async()=>({ files: [
                { path: 'C:\\App\\wow64_child.exe', bytes: new Uint8Array(child) },
                { path: 'C:\\App\\hello64.exe', bytes: new Uint8Array(hello) },
            ] }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 100000 });
        const text = output.join('');
        const lines = text.split(/\r?\n/).filter(Boolean);
        assert.deepEqual(lines.filter(line=>line.includes('FAIL')), [], text);
        assert.equal(lines.filter(line=>/^(child )?ok {3}/.test(line)).length, 11,
            `every check was reached, the child's five among them:\n${text}`);
        assert.ok(lines.includes('hello from x64, fib(25)=75025'), 'and the 64-bit child ran');
        assert.equal(code, 0, text);
    });

test('a 32-bit program alone is on a 32-bit machine: no WOW64', { timeout: 60000 }, async t=>{
    const app = await createApp({ executable: new Uint8Array(await fixture('wow64_child')),
        engine: 'cork' });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
        output.push(text));
    const code = await app.run({ timeoutMs: 50000 });
    const lines = output.join('').split('\r\n').filter(Boolean);
    assert.deepEqual(lines.map(line=>line.slice(0, 10)), ['child FAIL', 'child ok  ',
        'child FAIL', 'child FAIL', 'child FAIL'],
    `only GetSystemInfo's answer is the same on a 32-bit machine:\n${output.join('')}`);
    assert.equal(code, 4);
});
