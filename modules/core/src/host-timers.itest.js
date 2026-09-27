/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The host keeps its own time while a program runs: a timer the host set comes
 * due when it said, however busy the guest is.
 *
 * Nothing in the guest's world waits on a host timer -- its sleeps, timeouts
 * and WM_TIMERs are on its own clock -- but much of what the host does for it
 * does: a present held until the device finishes a frame, a wait for the
 * vertical blank, a select() that times out, a file read or a fetch answering,
 * a translation coming back from its worker, the emulator's compiled code
 * being installed. The run loop gives the host a turn between scheduler
 * turns; this holds it to one the host's timers and I/O get too.
 *
 * The program only counts, for ever. While it runs for a second and a half,
 * the test sets a 5 ms timer again each time one fires and reads a file again
 * each time a read answers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** How long the program runs, in wall milliseconds. */
const RUN_MS = 1500;

/** What each timer asks for. */
const TIMER_MS = 5;

/**
 * Late past this is a timer that waited for something other than a turn: a
 * turn of this program is a fraction of a millisecond on either engine, and
 * the loop gives the host a turn at least every few, so this is room for a
 * loaded machine.
 */
const LATE_MS = 250;

/**
 * `inc dword [counter]; jmp` to the inc. The counter is a page past the code:
 * a store into the page the code is on would have the emulator throw its
 * compiled code away on every pass.
 */
function buildCountingExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        codeSize: 0x1000,
        data: { counter: u32(0) },
        code: ({ at })=>[0xff, 0x05, ...u32(at('counter')), 0xeb, 0xf8],
    });
}

/** @param {'cork' | 'emulator'} engine */
async function runCounting(engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable: buildCountingExe(),
        engine,
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    const file = await open(new URL(import.meta.url), 'r');
    try
    {
        const state = { running: true };
        /** @type {number[]} */
        const late = [];
        const arm = ()=>{
            const set = performance.now();
            setTimeout(()=>{
                late.push(performance.now() - set - TIMER_MS);
                if (state.running)
                {
                    arm();
                }
            }, TIMER_MS);
        };
        let reads = 0;
        const reading = (async()=>{
            const buffer = Buffer.alloc(64);
            while (state.running)
            {
                await file.read(buffer, 0, buffer.length, 0);
                reads++;
            }
        })();
        arm();
        await assert.rejects(app.run({ timeoutMs: RUN_MS, maxTurns: 1e12 }),
            /did not finish within/, 'the program counts until it is stopped');
        state.running = false;
        await reading;
        const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
        return { late, reads, compiledSteps: cpu?.metrics?.jit?.compiledSteps ?? null };
    }
    finally
    {
        await file.close();
        await app.dispose();
    }
}

for (const engine of /** @type {const} */ (['cork', 'emulator']))
{
    test(`a host timer comes due on time while a program runs under ${engine}`,
        { timeout: 30000 }, async t=>{
            const { late, reads } = await runCounting(engine);
            const worst = Math.max(...late);
            t.diagnostic(`${late.length} timers, the latest ${worst.toFixed(1)} ms late;`
                + ` ${reads} reads`);
            // A timer that came due only when the run ended fired once, and
            // RUN_MS late.
            assert.ok(late.length >= 30,
                `${late.length} ${TIMER_MS} ms timers in ${RUN_MS} ms of running`);
            assert.ok(worst < LATE_MS, `a ${TIMER_MS} ms timer came ${worst.toFixed(1)} ms late`);
            assert.ok(reads >= 30, `${reads} file reads answered in ${RUN_MS} ms of running`);
        });
}

test("the emulator's compiled code arrives while the program runs", { timeout: 30000 }, async()=>{
    // The emulator compiles a hot page into a module of its own and installs
    // it when the compile answers, which is a task of the host's; until then
    // it interprets.
    const { compiledSteps } = await runCounting('emulator');
    assert.ok(compiledSteps !== null && compiledSteps > 0,
        `the emulator ran ${compiledSteps} steps of compiled code`);
});
