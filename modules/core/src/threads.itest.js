/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

/**
 * Phase 2 acceptance: a multithreaded program produces the same, deterministic
 * result under Bottlify that it produces under Windows.
 *
 * The fixture starts two workers that each increment one counter a hundred
 * times under a mutex, while the main thread waits for both and writes the
 * total. Whatever order the threads run in and wherever they are preempted, the
 * answer must be exactly two hundred. A scheduler that loses an increment,
 * resumes a thread onto the wrong state, or lets both into the critical section
 * gives a different number -- and the number says how badly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/threads.exe', import.meta.url);

/** What the same binary produces under Windows: two workers, a hundred each. */
const EXPECTED_TOTAL = 200;

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

/**
 * Runs the fixture and decodes the counter it writes.
 *
 * The program reports its result as four raw bytes rather than formatted text,
 * so a wrong answer says what it actually was instead of just failing to match.
 */
async function runFixture(){
    const app = await startApp();
    /** @type {number[]} */
    const bytes = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>{
        for (const character of text)
        {
            bytes.push(character.charCodeAt(0));
        }
    });

    const exitCode = await app.run();
    const total = bytes.length >= 4
        ? (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
        : null;

    const diagnostics = app.diagnostics();
    await app.dispose();
    return { total, exitCode, diagnostics };
}

test('two threads contending on a mutex produce the Windows answer', async()=>{
    const { total, exitCode } = await runFixture();

    assert.equal(total, EXPECTED_TOTAL,
        'every increment survived preemption and the critical section held');
    assert.equal(exitCode, 0);
});

test('the threads really did run, and really did take turns', async()=>{
    const { diagnostics } = await runFixture();
    const byName = Object.fromEntries(diagnostics.map((/** @type {any} */ d)=>[d.name, d]));

    // Three threads: main plus two workers, all of them finished.
    assert.equal(byName.kernel.metrics.threads, 3);
    assert.equal(byName.kernel.metrics.byState.terminated, 2, 'both workers ended');

    // If the scheduler had run each thread to completion in turn, this would be
    // 3. Contention on the mutex forces many more, and that is the point: the
    // counter above survived all of them.
    assert.ok(byName.kernel.metrics.switches > 3,
        `threads interleaved (${byName.kernel.metrics.switches} switches)`);
    assert.ok(byName.kernel.metrics.turns > 3);

    // Nothing is left waiting on anything.
    assert.deepEqual(byName.kernel.metrics.waiting, []);
});

test('the answer is the same every time', async()=>{
    // Determinism is the actual acceptance criterion: a scheduler that is right
    // only sometimes is not right. Ten runs rather than a hundred keeps the test
    // honest about cost -- each one boots a fresh emulator.
    const totals = [];
    for (let run = 0; run < 10; run++)
    {
        totals.push((await runFixture()).total);
    }

    assert.deepEqual(totals, new Array(10).fill(EXPECTED_TOTAL));
});
