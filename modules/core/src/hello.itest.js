/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Phase 1 acceptance: the fixture executable runs under Bottlify and produces
 * the same output real Windows produces from the same file.
 *
 * This drives `createApp` -- the surface a consumer gets -- rather than reaching
 * into the layers, so it exercises the module graph, the region map and the
 * trap channel the way anything else would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/hello.exe', import.meta.url);

/** What the same binary prints when Windows runs it. */
const EXPECTED_OUTPUT = 'Hello from Bottlify\r\n';

async function startApp(){
    const [wasm, exe] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(FIXTURE),
    ]);

    return createApp({
        executable: new Uint8Array(exe),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
}

test('hello.exe prints what it prints on Windows, then exits cleanly', async()=>{
    const app = await startApp();
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));

    const code = await app.run({ timeoutMs: 8000 });

    assert.equal(output.join(''), EXPECTED_OUTPUT, 'same bytes real Windows writes to stdout');
    assert.equal(code, 0, "the guest's own exit code");
    await app.dispose();
});

test('the image lands where its headers ask, and every import is bound', async()=>{
    const app = await startApp();
    await app.run({ timeoutMs: 8000 });

    assert.equal(app.image.base, 0x400000, 'the fixture has no relocations and cannot move');
    assert.equal(app.image.entryPoint, 0x401000);
    assert.deepEqual(app.image.unresolved, [], 'nothing the fixture imports is missing');
    await app.dispose();
});

test('diagnostics describe the run afterwards', async()=>{
    const app = await startApp();
    await app.run({ timeoutMs: 8000 });

    const byName = Object.fromEntries(app.diagnostics().map((/** @type {any} */ d)=>[d.name, d]));

    assert.equal(byName.cpu.metrics.protectedMode, true, 'the ROM switched the CPU over');
    assert.ok(byName.cpu.metrics.instructions > 0);
    assert.equal(byName.cpu.metrics.traps, 5,
        'the park slot, the callback sentinel, and the three imports');

    for (const fn of ['GetStdHandle', 'WriteFile', 'ExitProcess'])
    {
        assert.ok(byName.win32.metrics.implemented.includes(fn), `${fn} is implemented`);
    }
    assert.equal(byName.win32.metrics.exitCode, 0);

    assert.equal(byName.loader.metrics.images, 1);
    assert.deepEqual(byName.loader.metrics.unresolved, []);

    // The layout is in the snapshot because a wrong one usually explains a fault
    // faster than the fault does.
    const layout = byName.memory.metrics.layout.join(' ');
    for (const region of ['entry-vector', 'stack', 'thunks', 'image'])
    {
        assert.ok(layout.includes(region), `${region} is mapped`);
    }
    await app.dispose();
});

test('a detached log sink stops receiving output', async()=>{
    const app = await startApp();
    /** @type {string[]} */
    const kept = [];
    /** @type {string[]} */
    const dropped = [];
    /** @param {number} _handle @param {string} text */
    const sink = (_handle, text)=>dropped.push(text);

    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>kept.push(text));
    app.attachLog(sink);
    app.detachLog(sink);

    await app.run({ timeoutMs: 8000 });

    assert.equal(kept.join(''), EXPECTED_OUTPUT);
    assert.deepEqual(dropped, [], 'detached before the run, so it saw nothing');
    await app.dispose();
});
