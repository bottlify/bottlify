/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A C runtime sorting with the program's own comparator: the fixture sorts six
 * integers through msvcrt's qsort.
 *
 * qsort is code in the guest's msvcrt, so the comparator is called with a
 * `call` and nothing crosses to the host for it; the array comes back sorted,
 * the same every time. Calling the guest from the host -- what this fixture
 * once exercised, when qsort was a handler -- is held by the bridge's own
 * tests and by every window procedure and APC.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/qsort.exe', import.meta.url);

/** What the fixture starts with, and what qsort must make of it. */
const INPUT = [7, 3, 9, 1, 8, 2];
const SORTED = [...INPUT].sort((a, b)=>a - b);

/**
 * Runs the fixture and decodes the array it writes back.
 *
 * It reports the raw bytes rather than formatted text, so a wrong answer says
 * what it actually was instead of merely failing to match.
 *
 * Disposes before returning, success or failure: the machine is one per
 * process, and a caller that runs this in a loop needs the previous one gone
 * before the next `createApp` -- a second machine boots onto the same
 * process-wide state and fails with "already booted", so waiting for the test
 * to end to dispose (a `t.after`) is too late here.
 */
async function runFixture(){
    const [wasm, exe] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(FIXTURE),
    ]);

    const app = await createApp({
        executable: new Uint8Array(exe),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    try
    {
        /** @type {number[]} */
        const bytes = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>{
            for (const character of text)
            {
                bytes.push(character.charCodeAt(0));
            }
        });

        const exitCode = await app.run({ timeoutMs: 8000 });
        const values = [];
        for (let at = 0; at + 4 <= bytes.length; at += 4)
        {
            values.push((bytes[at] | (bytes[at + 1] << 8)
                | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0);
        }

        const diagnostics = app.diagnostics();
        return { values, exitCode, diagnostics };
    }
    finally
    {
        await app.dispose();
    }
}

test('a guest comparator decides the order, and the array comes back sorted',
    { timeout: 15000 }, async()=>{
        const { values, exitCode } = await runFixture();

        assert.deepEqual(values, SORTED);
        assert.equal(exitCode, 0);
    });

test('the comparator runs in the guest: no call back from the host',
    { timeout: 15000 }, async()=>{
        const { diagnostics } = await runFixture();
        const bridge = diagnostics.find((/** @type {any} */ d)=>d.name === 'bridge');
        assert.equal(bridge.metrics.callbacks, 0,
            'qsort calls the comparator itself, where a handler called it from the host');
        assert.equal(bridge.metrics.failure, null);
    });

test('the answer is the same every time', { timeout: 60000 }, async()=>{
    // A callback path that is right only sometimes is not right: the frame is
    // built at an address that depends on where the thread happened to stop.
    const runs = [];
    for (let run = 0; run < 5; run++)
    {
        runs.push((await runFixture()).values);
    }

    assert.deepEqual(runs, new Array(5).fill(SORTED));
});
