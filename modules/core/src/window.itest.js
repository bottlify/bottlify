/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Phase 3 acceptance: a windowed program runs its own message loop and answers
 * input with its own code.
 *
 * The fixture registers a window class, makes a window, and pumps messages until
 * it is told to quit. Its window procedure is guest code, so every message it
 * handles crosses the boundary twice -- into a host function that waits, out
 * through a callback into the program, and back with a result that decides what
 * happens next. It reports the wParam it was sent, which is a number only the
 * guest could have produced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/window.exe', import.meta.url);

/** The message the fixture answers, and the value it is asked to remember. */
const WM_APP_PROBE = 0x0401;
const WM_CLOSE = 0x0010;
const PROBE_VALUE = 0x2a;

/**
 * Runs the fixture, feeds it the probe and then a close, and decodes what its
 * window procedure recorded.
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

    /** @type {number[]} */
    const bytes = [];
    app.on('output', (/** @type {any} */ payload)=>{
        for (const character of payload.text)
        {
            bytes.push(character.charCodeAt(0));
        }
    });

    // Delivered from outside the machine, the way a keystroke would be: the
    // program is already waiting in GetMessage by the time these arrive.
    setTimeout(()=>{
        app.post({ message: WM_APP_PROBE, wParam: PROBE_VALUE });
        setTimeout(()=>app.post({ message: WM_CLOSE }), 20);
    }, 40);

    const exitCode = await app.run({ maxTurns: 20000 });
    const seen = bytes.length >= 4
        ? (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
        : null;

    const diagnostics = app.diagnostics();
    await app.dispose();
    return { seen, exitCode, diagnostics };
}

test('the program answers a message with its own window procedure', async()=>{
    const { seen, exitCode } = await runFixture();

    assert.equal(seen, PROBE_VALUE,
        'the value came back through guest code that decided what to do with it');
    assert.equal(exitCode, 0);
});

test('the whole path was used, not shortcut', async()=>{
    const { diagnostics } = await runFixture();
    const byName = Object.fromEntries(diagnostics.map((/** @type {any} */ d)=>[d.name, d]));

    // Four trips into the guest: the WM_CREATE the window is told about, the
    // probe, the close, and the destroy the close produced. Fewer means
    // something was answered on our side that the program was supposed to
    // answer.
    assert.equal(byName.bridge.metrics.callbacks, 4);
    assert.equal(byName.bridge.metrics.deepestCallback, 1);
    assert.equal(byName.bridge.metrics.failure, null);

    const called = byName.bridge.metrics.lastCall;
    assert.equal(called, 'KERNEL32.dll!ExitProcess', 'it ended by asking, not by running out');
});

test('a program with nothing to do waits instead of spinning', async()=>{
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

    // Nothing is ever posted, so the program sits in GetMessage. What must not
    // happen is the loop deciding that is a deadlock or a program that ended:
    // waiting for input is the normal state of a windowed program.
    const finished = app.run({ maxTurns: 400 });
    await assert.rejects(finished, /did not finish within/);
    await app.dispose();
});

test('a machine waiting for a message still lets its own clock run', async()=>{
    // A thread suspended on a host call is parked on `hlt` and still counts as
    // runnable, so the scheduler never reaches the branch that jumps the clock
    // to the next deadline; and the loop credits the guest only for the turns
    // it actually ran. Waiting for a message is therefore time that nothing
    // credits, and a windowed program spends most of its life there.
    //
    // What that costs is not a slow clock but a stalled program: every timed
    // wait in the guest waits far longer than it asked for -- a sleep, a
    // timeout, a WM_TIMER, a wave cursor -- including the ones that would have
    // produced the message the machine is idling for. Measured on a real title,
    // crediting this took a run from three presented frames to two hundred and
    // twenty-one.
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

    await assert.rejects(app.run({ maxTurns: 600 }), /did not finish within/);
    const kernel = app.diagnostics()
        .find((/** @type {any} */ layer)=>layer.name === 'kernel');
    const time = kernel.metrics.time;
    await app.dispose();

    assert.ok(time.wallMs > 0, 'the run took measurable time');
    assert.ok(time.virtualMs > time.wallMs / 2,
        `the guest was credited ${time.virtualMs}ms of ${time.wallMs}ms that really passed`);
});
