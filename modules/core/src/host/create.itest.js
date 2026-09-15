/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The package's `createApp` on a thread with no worker and no display: the
 * engine behind the port protocol, answering the same controller a page holds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../index.js';

const PREBUILT = new URL('../../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../../test/fixtures/hello.exe', import.meta.url);

test('hello.exe runs through the package entry, headless, on this thread', async()=>{
    const [wasm, exe] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(FIXTURE),
    ]);
    const app = await createApp({
        host: 'thread',
        executable: new Uint8Array(exe),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    assert.equal(app.host, 'thread');
    assert.equal(app.canvas, null);

    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    const code = await app.run({ maxTurns: 200000 });
    assert.equal(code, 0);
    assert.equal(output.join(''), 'Hello from Bottlify\r\n');

    const layers = await app.diagnostics();
    const cpu = layers.find((/** @type {any} */ layer)=>layer.name === 'cpu');
    assert.ok(cpu.metrics.instructions > 0, 'the reads that cross the port answer as promises');
    assert.ok((await app.log.recent(10)).length >= 0, 'the keeper answers with a promise');
    await app.dispose();
});
