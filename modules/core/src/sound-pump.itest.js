/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run loop pumps the sound before it yields to the host and otherwise at
 * most once a millisecond (`SOUND_PUMP_MS` in `app.js`), not once a turn: a
 * program that keeps the loop turning tens of thousands of times a second
 * spent a pump on every turn, all of them with nothing to do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createMacrotask, pagePacing } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** The loop's clock: a turn's worth of milliseconds. */
const TURN_MS = 0.1;

test('a program that turns the loop over and over is pumped for sound a few times a'
    + ' millisecond at most, and still is', { timeout: 60000 }, async t=>{
    // h = CreateEventA(0, 1, 0, 0); for (;;) WaitForSingleObject(h, 1000):
    // every thread in a timed wait, as a game waiting on its GPU is, and the
    // loop turning until the deadline comes.
    const program = buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'WaitForSingleObject'] },
        code: ({ iat })=>{
            const call = (/** @type {string} */ name)=>[0xff, 0x15,
                ...[0, 8, 16, 24].map(shift=>(iat(name) >>> shift) & 0xff)];
            return [
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00, ...call('CreateEventA'),
                0x89, 0xc6,                                     // mov esi, eax
                0x68, 0xe8, 0x03, 0x00, 0x00, 0x56,             // push 1000; push esi
                ...call('WaitForSingleObject'),
                0xeb, 0x100 - 14,                               // jmp to the push
            ];
        },
    });
    // The loop's clock is its turns, a tenth of a millisecond each: what the
    // gate lets through is then the gate's, not how many turns a busy machine
    // fitted into a millisecond of wall time. The page's pacing, as a run
    // without one of its own gets, on that clock.
    let turns = 0;
    const breathe = createMacrotask();
    t.after(()=>breathe.close());
    const paced = pagePacing({ macrotask: breathe, hidden: ()=>false, now: ()=>turns * TURN_MS });
    const pacing = { ...paced, yield: (/** @type {any} */ pending)=>{
        turns++;
        return paced.yield(pending);
    } };
    const app = await createApp({ executable: program, imagePath: 'C:\\spin.exe',
        engine: 'cork', pacing });
    t.after(()=>app.dispose());
    // It never ends: the run is cut at its time, as a runaway.
    await assert.rejects(app.run({ timeoutMs: 1500 }), /did not finish/);
    const tables = app.diagnostics();
    const audio = tables.find((/** @type {any} */ table)=>table.name === 'audio')?.metrics;
    assert.ok(audio && audio.pumps > 0, 'the sound is pumped');
    assert.ok(turns > 4 * audio.pumps, `${audio.pumps} pumps in ${turns} turns`);
    // Once a millisecond at most, whatever the loop does meanwhile.
    const elapsedMs = turns * TURN_MS;
    assert.ok(audio.pumps <= elapsedMs + 1, `${audio.pumps} pumps in ${elapsedMs} ms of turns`);
});
