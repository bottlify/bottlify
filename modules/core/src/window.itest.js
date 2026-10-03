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

const FIXTURE = new URL('../test/fixtures/window.exe', import.meta.url);

/** The message the fixture answers, and the value it is asked to remember. */
const WM_APP_PROBE = 0x0401;
const WM_CLOSE = 0x0010;
const PROBE_VALUE = 0x2a;

/**
 * Runs the fixture, feeds it the probe and then a close, and decodes what its
 * window procedure recorded.
 *
 * @param {import('node:test').TestContext} t
 */
async function runFixture(t){
    const exe = await readFile(FIXTURE);

    const app = await createApp({
        executable: new Uint8Array(exe),
    });
    t.after(()=>app.dispose());

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

    const exitCode = await app.run({ maxTurns: 20000, timeoutMs: 15000 });
    const seen = bytes.length >= 4
        ? (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
        : null;

    const diagnostics = app.diagnostics();
    return { seen, exitCode, diagnostics };
}

test('the program answers a message with its own window procedure',
    { timeout: 20000 }, async t=>{
        const { seen, exitCode } = await runFixture(t);

        assert.equal(seen, PROBE_VALUE,
            'the value came back through guest code that decided what to do with it');
        assert.equal(exitCode, 0);
    });

test('the whole path was used, not shortcut', { timeout: 20000 }, async t=>{
    const { diagnostics } = await runFixture(t);
    const byName = Object.fromEntries(diagnostics.map((/** @type {any} */ d)=>[d.name, d]));

    // Six trips into the guest: the WM_NCCREATE and WM_CREATE the window is
    // told about as it is made, the probe, the close, and the WM_DESTROY and
    // WM_NCDESTROY the close produced, sent from inside the close's own
    // handling, which is the one nesting. The window is made hidden and never
    // shown, so nothing activates it. Fewer means something was answered on
    // our side that the program was supposed to answer.
    assert.equal(byName.bridge.metrics.callbacks, 6);
    assert.equal(byName.bridge.metrics.deepestCallback, 2);
    assert.equal(byName.bridge.metrics.failure, null);

    const called = byName.bridge.metrics.lastCall;
    assert.equal(called, 'KERNEL32.dll!ExitProcess', 'it ended by asking, not by running out');
});

/**
 * An app disposed when the test ends, however it ends: the machine is one per
 * process, and an app a failed assertion left behind fails every later test
 * with "already booted" and keeps the process alive after the run.
 *
 * @param {import('node:test').TestContext} t
 */
async function startApp(t){
    const exe = await readFile(FIXTURE);
    const app = await createApp({
        executable: new Uint8Array(exe),
    });
    t.after(()=>app.dispose());
    return app;
}

test('a program with nothing to do waits instead of spinning', { timeout: 15000 }, async t=>{
    const app = await startApp(t);

    // Nothing is ever posted, so the program sits in GetMessage. What must not
    // happen is the loop deciding that is a deadlock or a program that ended:
    // waiting for input is the normal state of a windowed program.
    //
    // Bounded by the clock and not by turns: the turn budget counts turns the
    // guest worked, and a program with nothing to do works none, so a budget
    // of turns never runs out on it. That is the contract, not a defect -- a
    // wait of seconds is tens of thousands of idle turns -- and a caller who
    // needs such a program back asks for a time.
    const startedAt = Date.now();
    const finished = app.run({ timeoutMs: 500 });
    await assert.rejects(finished, /did not finish within 500 ms/);
    const took = Date.now() - startedAt;
    assert.ok(took < 2500, `the bound is a bound: back after ${took}ms, not whenever`);

    const kernel = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'kernel');
    assert.ok(kernel.metrics.turns < 100,
        `waiting cost ${kernel.metrics.turns} scheduler turns: the machine looked, not spun`);
});

test('a machine waiting for a message still lets its own clock run', { timeout: 30000 }, async t=>{
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
    //
    // The contract pinned here is that the clock moves at all while parked, not
    // by how much relative to the wall clock: that ratio depends on how often
    // this process gets the CPU, so a machine sharing it with another `npm
    // test` run can be credited less than half of the wall time and still be
    // behaving correctly. Monotonic growth across several waits is true
    // regardless of load.
    const app = await startApp(t);
    const virtualMsAt = ()=>app.diagnostics()
        .find((/** @type {any} */ layer)=>layer.name === 'kernel').metrics.time.virtualMs;

    const samples = [];
    for (let turn = 0; turn < 5; turn++)
    {
        await assert.rejects(app.run({ timeoutMs: 300 }), /did not finish within/);
        samples.push(virtualMsAt());
    }

    for (let turn = 1; turn < samples.length; turn++)
    {
        assert.ok(samples[turn] > samples[turn - 1],
            `turn ${turn}: the virtual clock did not advance while parked `
            + `(${samples[turn - 1]}ms -> ${samples[turn]}ms)`);
    }
});
