/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sound reaches the speaker whole: a program plays a tone of a known pitch
 * and length, the audio worklet takes the output a block at a time on a
 * thread of its own and on its own clock, as the page's audio thread does,
 * and what came out is the tone - as long as it was written, at its pitch,
 * and with no gap inside it. A gap is a block the worklet found short by more
 * than 15 ms (`GAP_FRAMES`), heard as a crackle; the engine runs late and
 * the program's refill misses its moment. Every way a program hands sound
 * over has its case here, on each Windows it is there on. Each run is
 * `tools/fixtures/sound-delivery-run.mjs`, in a worker of its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { RATE, TONE_FRAMES, TONE_HZ } from '../../../tools/fixtures/tone-program.mjs';

/**
 * Run alone, by `npm run test:realtime` (scripts/test-realtime.mjs): beside other
 * tests the gaps are theirs.
 */
const REALTIME = process.env.BOTTLIFY_REALTIME === '1';
const ALONE = 'runs alone, where nothing else takes the processor: npm run test:realtime';

/**
 * The engine's thread held 40 ms every quarter of a second, as a busy frame
 * holds a page's (38-42 ms at worst, measured in a game under a virtual
 * machine): what is to be heard meanwhile must already be in the table.
 */
const STALL = { everyMs: 250, ms: 40 };

/**
 * The shortfall a block may have and still count as whole: 15 ms, the order of
 * what a device on Windows waits between its own events, and the decoding,
 * handing over and wake that carry a refill to it cost time too. A block short
 * by more is a gap.
 */
const GAP_FRAMES = Math.round(RATE * 0.015);

/**
 * @param {string} program @param {string} windows
 * @param {{ everyMs: number, ms: number }} [stall]  the engine's thread held so
 * @param {boolean} [across]  the program in a worker of its own
 * @returns {Promise<{ exit: number | string, heard: { first: number, frames: number,
 *     hz: number, gaps: { at: number, frames: number }[] }, win32: any }>}
 */
const play = (program, windows, stall, across)=>new Promise((resolve, reject)=>{
    const worker = new Worker(new URL('../../../tools/fixtures/sound-delivery-run.mjs',
        import.meta.url), { workerData: { program, windows, stall, across } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code=>reject(new Error(`the run's worker exited (${code}) unanswered`)));
});

/**
 * Each way of handing sound over, what it does, and the Windows it is there on;
 * `todo`, what is known still to fail, and why.
 *
 * @type {{ program: string, on: string[], what: string, todo?: string }[]}
 */
const CASES = [
    { program: 'wasapi', on: ['win7', 'win10'],
        what: 'played as SDL plays to WASAPI, half its buffer at each event' },
    { program: 'wasapi-busy', on: ['win7', 'win10'],
        what: 'fed to WASAPI from a thread of its own while the main thread waits for its frame'
            + ' by QueryPerformanceCounter and Sleep(1)' },
    { program: 'wasapi-heavy', on: ['win7', 'win10'],
        what: 'fed to WASAPI from a thread of its own while the main thread makes frames' },
    { program: 'waveout', on: ['winxp', 'win7', 'win10'],
        what: 'played through waveOut buffers written again as they come back' },
    { program: 'dsound', on: ['winxp', 'win7', 'win10'],
        what: 'streamed into a looping DirectSound buffer behind its play cursor' },
];

for (const { program, on, what, todo } of CASES)
{
    for (const windows of on)
    {
        // In a worker of its own, as where processes run at once: its sound
        // goes onto the table the page reads, not one of its own nobody does.
        for (const [stall, across] of /** @type {const} */ ([[undefined, false], [STALL, false],
            [undefined, true]]))
        {
            const held = stall ? `, the engine held ${stall.ms} ms every ${stall.everyMs} ms` : '';
            const where = across ? ', in a worker of its own' : '';
            test(`on ${windows}, a tone ${what}${held}${where} reaches the worklet whole: its`
                + ' length, its pitch, no gap', { timeout: 60000, todo,
                skip: REALTIME ? false : ALONE },
            async()=>{
                await hear(program, windows, stall, across);
            });
        }
    }
}

/**
 * @param {string} program @param {string} windows
 * @param {{ everyMs: number, ms: number }} [stall]
 * @param {boolean} [across]
 */
async function hear(program, windows, stall, across){
    const { exit, heard, win32 } = await play(program, windows, stall, across);
    if (process.env.SOUND_DEBUG)
    {
        console.log(JSON.stringify({ program, windows, stall: Boolean(stall), exit,
            ...heard,
            gaps: heard.gaps.map(gap=>`${gap.at}+${gap.frames}`).join(' '),
            lost: heard.gaps.reduce((sum, gap)=>sum + gap.frames, 0), ...win32 }));
    }
    assert.equal(exit, 0, 'the program played to the end');
    assert.ok(heard.first >= 0, 'the tone was heard');
    assert.deepEqual(heard.gaps.filter(gap=>gap.frames > GAP_FRAMES), [],
        `no block inside the tone came out more than ${GAP_FRAMES} frames short`);
    assert.ok(Math.abs(heard.frames - TONE_FRAMES) <= 128,
        `as long as it was written: ${heard.frames} frames of ${TONE_FRAMES}`);
    assert.ok(Math.abs(heard.hz - TONE_HZ) < 5, `at its pitch: ${heard.hz.toFixed(1)} Hz`);
}
