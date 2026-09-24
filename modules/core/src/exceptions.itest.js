/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Exceptions as compiled programs raise and handle them.
 *
 * The fixtures are built by a compiler against the system's C runtime -- see
 * `scripts/build-fixtures.mjs` -- because the frames and tables exception
 * handling runs on are the compiler's, and a hand-assembled imitation of them
 * would only test that it agrees with itself. Each fixture checks a property
 * per line and prints `ok` or `FAIL` with its name, so a failure here says
 * which property broke.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/**
 * @param {import('node:test').TestContext} t
 * @param {string} name
 */
async function run(t, name){
    const [wasm, exe] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(new URL(`../test/fixtures/${name}.exe`, import.meta.url)),
    ]);
    const app = await createApp({
        executable: new Uint8Array(exe),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    const code = await app.run({ timeoutMs: 20000 });
    const bridge = app.diagnostics().find((/** @type {any} */ entry)=>entry.name === 'bridge');
    return { code, text: output.join(''), suspended: bridge?.metrics?.suspended };
}

/**
 * Every line the fixture printed, as property and outcome.
 *
 * @param {string} text
 */
const verdicts = text=>text.split('\r\n').filter(Boolean).map(line=>({
    ok: line.startsWith('ok   '),
    property: line.slice(5),
}));

test('structured exceptions: raised, faulted, nested, and left by longjmp', { timeout: 60000 },
    async t=>{
        const { code, text, suspended } = await run(t, 'seh');
        const lines = verdicts(text);

        assert.deepEqual(lines.filter(line=>!line.ok).map(line=>line.property), [],
            `every property holds:\n${text}`);
        assert.equal(lines.length, 9, 'and every one was reached');
        assert.equal(code, 0);
        assert.equal(suspended, 0,
            'no host call is left waiting: each handler that found its block let go of the stack');
    });

test('C++ exceptions: catch, destroy, rethrow, across a callback and two threads',
    { timeout: 60000 }, async t=>{
        const { code, text, suspended } = await run(t, 'cxxeh');
        const lines = verdicts(text);

        assert.deepEqual(lines.filter(line=>!line.ok).map(line=>line.property), [],
            `every property holds:\n${text}`);
        assert.equal(lines.length, 13, 'and every one was reached');
        assert.equal(code, 0);
        assert.equal(suspended, 0);
    });

test('a C++ exception nothing catches ends the process with its code', { timeout: 60000 },
    async t=>{
        const { code, text } = await run(t, 'unhandled');

        assert.equal(text, 'throwing\r\n', 'nothing after the throw ran');
        assert.equal(code, 0xe06d7363, 'the exception code is the exit code, as on Windows');
    });
