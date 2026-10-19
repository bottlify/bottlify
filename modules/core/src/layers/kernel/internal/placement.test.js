/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Placement, createPlacement } from './placement.js';

/** One thread doing all of a program's work, as the share each thread does. */
const ONE_THREAD = ()=>({ main: 1 });

/**
 * A program whose frames come every `frameMs[mode]` milliseconds (none where
 * absent) and whose executors retire `retiredPerMs[mode]` instructions a
 * millisecond, shared between its threads as `shares` says at the time, run
 * for `ms` in steps of a turn. Either may change with the time (`frameMsAt`).
 *
 * @param {{ frameMs?: Record<string, number>, retiredPerMs: Record<string, number>, ms: number,
 *     fixed?: 'spread' | 'concentrate' | null, busyShare?: Record<string, number> | null,
 *     shares?: (clock: number) => Record<string, number>,
 *     frameMsAt?: (clock: number) => Record<string, number> | undefined }} program
 */
function run({ frameMs, retiredPerMs, ms, fixed = null, busyShare = null, shares = ONE_THREAD,
    frameMsAt = ()=>frameMs })
{
    let clock = 0;
    /** @type {Map<string, number>} */
    const work = new Map();
    const placement = createPlacement({ now: ()=>clock, fixed, work: ()=>new Map(work) });
    let retired = 0;
    let busy = 0;
    let nextFrame = 0;
    /** @type {Record<string, number>} */
    const time = { spread: 0, concentrate: 0 };
    /** When each trial began. @type {number[]} */
    const began = [];
    for (; clock < ms; clock += 2)
    {
        const mode = placement.mode();
        time[mode] += 2;
        retired += 2 * retiredPerMs[mode];
        for (const [name, share] of Object.entries(shares(clock)))
        {
            work.set(name, (work.get(name) ?? 0) + 2 * retiredPerMs[mode] * share);
        }
        busy += 2 * (busyShare?.[mode] ?? 0);
        const frames = frameMsAt(clock);
        if (frames && clock >= nextFrame)
        {
            placement.frame();
            nextFrame = clock + frames[mode];
        }
        const trialing = placement.trialing();
        placement.tick(retired, busyShare ? busy : null);
        if (!trialing && placement.trialing())
        {
            began.push(clock);
        }
    }
    return { placement, time, began };
}

test('a program whose frames come faster concentrated is run concentrated, '
    + 'whatever it retires', ()=>{
    // Spread retires more -- threads spinning on their jobs -- and draws fewer frames.
    const { placement, time } = run({ frameMs: { spread: 170, concentrate: 125 },
        retiredPerMs: { spread: 900_000, concentrate: 600_000 }, ms: 120_000 });
    assert.equal(placement.mode(), Placement.CONCENTRATE);
    const said = placement.diagnostics();
    assert.ok(said.trials === 1 && said.concentrate === 1, JSON.stringify(said));
    assert.equal(said.byFrames, 1, 'measured by frames');
    assert.ok(time.concentrate > 4 * time.spread, `mostly concentrated: ${JSON.stringify(time)}`);
});

test('a program with no frames that retires twice as much spread is run spread, '
    + 'and not tried again while it stays so', ()=>{
    const { placement, time } = run({ retiredPerMs: { spread: 2_000_000, concentrate: 1_000_000 },
        ms: 300_000, shares: ()=>({ main: 0.5, worker: 0.5 }) });
    assert.equal(placement.mode(), Placement.SPREAD);
    const said = placement.diagnostics();
    assert.ok(said.trials === 1 && said.spread === 1, JSON.stringify(said));
    assert.equal(said.byFrames, 0);
    assert.equal(said.moved, 0, 'the threads\' shares as they were after the trial');
    assert.ok(time.concentrate < 2000, `concentrated only in the trial: ${JSON.stringify(time)}`);
});

test('spreading must win by the margin: a few percent stays concentrated', ()=>{
    const { placement } = run({ frameMs: { spread: 97, concentrate: 100 },
        retiredPerMs: { spread: 1, concentrate: 1 }, ms: 60_000 });
    assert.equal(placement.mode(), Placement.CONCENTRATE);
});

test('frames as fast either way are weighed by how busy each kept the process\'s executor', ()=>{
    // Held to the display's rate both ways: concentrated, every thread on the
    // process's executor, which the main thread then waits behind.
    const frameMs = { spread: 16, concentrate: 16 };
    const retiredPerMs = { spread: 1, concentrate: 1 };
    const roomier = run({ frameMs, retiredPerMs, ms: 60_000,
        busyShare: { spread: 0.55, concentrate: 0.95 } });
    assert.equal(roomier.placement.mode(), Placement.SPREAD);
    assert.match(roomier.placement.diagnostics().last, /a tie: busy 0\.55 and 0\.95/);
    // As busy either way, or not measured: the safer way, as before.
    assert.equal(run({ frameMs, retiredPerMs, ms: 60_000,
        busyShare: { spread: 0.9, concentrate: 0.92 } }).placement.mode(), Placement.CONCENTRATE);
    assert.equal(run({ frameMs, retiredPerMs, ms: 60_000 }).placement.mode(),
        Placement.CONCENTRATE);
});

test('a fixed way is kept and never tried against the other', ()=>{
    for (const fixed of /** @type {const} */ (['spread', 'concentrate']))
    {
        const { placement, time } = run({ fixed, frameMs: { spread: 200, concentrate: 100 },
            retiredPerMs: { spread: 1, concentrate: 1 }, ms: 60_000 });
        assert.equal(placement.mode(), fixed);
        assert.equal(placement.diagnostics().trials, 0);
        assert.equal(time[fixed === 'spread' ? 'concentrate' : 'spread'], 0);
    }
});

test('a program that begins presenting after a load decided by what it retired is tried again'
    + ' within seconds, not after the hold', ()=>{
    // A game's load: no frames, its threads retiring twice as much spread. Then
    // its play: a frame every 125 ms concentrated, every 170 spread.
    let clock = 0;
    const placement = createPlacement({ now: ()=>clock });
    let retired = 0;
    let nextFrame = 0;
    const PLAY_AT = 110_000;
    let concentratedAt = -1;
    for (; clock < PLAY_AT + 30_000; clock += 2)
    {
        const mode = placement.mode();
        retired += 2 * (mode === Placement.SPREAD ? 2_000_000 : 1_000_000);
        if (clock >= PLAY_AT && clock >= nextFrame)
        {
            placement.frame();
            nextFrame = clock + (mode === Placement.SPREAD ? 170 : 125);
        }
        placement.tick(retired);
        if (clock < PLAY_AT)
        {
            assert.equal(clock < 2000 || placement.diagnostics().byFrames === 0, true);
        }
        else if (concentratedAt < 0 && placement.mode() === Placement.CONCENTRATE
            && placement.diagnostics().byFrames > 0)
        {
            concentratedAt = clock;
        }
    }
    const said = placement.diagnostics();
    assert.ok(said.spread === 1 && said.trials === 2, `the load ran spread, the play tried once: ${
        JSON.stringify(said)}`);
    assert.ok(concentratedAt > 0 && concentratedAt - PLAY_AT < 12_000,
        `the play concentrated ${concentratedAt - PLAY_AT} ms in: ${JSON.stringify(said)}`);
    assert.equal(placement.mode(), Placement.CONCENTRATE);
});

test('a game far slower spread is tried once, its slow window ended early, and runs'
    + ' concentrated', ()=>{
    // The Crysis demo's timedemo on four cores: a frame every 110 ms concentrated,
    // 450 spread, where its threads spinning on their jobs retire more.
    const { placement, time } = run({ frameMs: { spread: 450, concentrate: 110 },
        retiredPerMs: { spread: 900_000, concentrate: 600_000 }, ms: 300_000 });
    const said = placement.diagnostics();
    assert.equal(placement.mode(), Placement.CONCENTRATE);
    assert.ok(said.trials === 1 && said.byFrames === 1, JSON.stringify(said));
    assert.ok(time.spread < 0.03 * (time.spread + time.concentrate),
        `spread ${time.spread} ms of ${time.spread + time.concentrate}`);
});

test('a program whose work moves between its threads for long enough is tried again, and one'
    + ' whose work moves for a few seconds is not', ()=>{
    // Spread draws a frame every 30 ms and concentrated every 60 while the main
    // thread does most of the work; from SHIFT_AT a worker does most of it, and
    // the two ways change places.
    const SHIFT_AT = 100_000;
    const retiredPerMs = { spread: 1000, concentrate: 1000 };
    /** @param {boolean} after */
    const sharesOf = after=>(after ? { main: 0.3, worker: 0.7 } : { main: 0.9, worker: 0.1 });
    const moved = run({ retiredPerMs, ms: 160_000,
        frameMsAt: clock=>(clock < SHIFT_AT ? { spread: 30, concentrate: 60 }
            : { spread: 60, concentrate: 30 }),
        shares: clock=>sharesOf(clock >= SHIFT_AT) });
    const said = moved.placement.diagnostics();
    assert.equal(moved.placement.mode(), Placement.CONCENTRATE);
    assert.ok(said.trials === 2 && said.byWork === 1, JSON.stringify(said));
    assert.ok(moved.began[1] > SHIFT_AT && moved.began[1] - SHIFT_AT <= 16_000,
        `tried again ${moved.began[1] - SHIFT_AT} ms after the work moved`);

    // The same move for three seconds -- a load's burst -- leaves the winner as it is.
    const burst = run({ retiredPerMs, ms: 160_000, frameMs: { spread: 30, concentrate: 60 },
        shares: clock=>sharesOf(clock >= SHIFT_AT && clock < SHIFT_AT + 3000) });
    assert.equal(burst.placement.mode(), Placement.SPREAD);
    const once = burst.placement.diagnostics();
    assert.equal(once.trials, 1, JSON.stringify(once));
});

test('a winner tried on a moment that is not the program\'s is tried again once its speed lies'
    + ' far off the trial\'s, though its threads\' shares hold', ()=>{
    // Call of Duty 4's level restarted: the trial fell on its loading screen,
    // a frame every 6.7 ms concentrated against 66 spread; then its play, 66 ms
    // a frame concentrated against 28 spread, the threads sharing the work as before.
    const PLAY_AT = 20_000;
    const { placement, began } = run({ retiredPerMs: { spread: 1000, concentrate: 1000 },
        ms: 120_000, shares: ()=>({ main: 0.6, worker: 0.4 }),
        frameMsAt: clock=>(clock < PLAY_AT ? { spread: 66, concentrate: 6.7 }
            : { spread: 28, concentrate: 66 }) });
    const said = placement.diagnostics();
    assert.equal(placement.mode(), Placement.SPREAD, JSON.stringify(said));
    assert.ok(said.trials === 2 && said.byWork === 1, JSON.stringify(said));
    assert.ok(began[1] - PLAY_AT <= 16_000, `tried again ${began[1] - PLAY_AT} ms into the play`);
});

test('another pair of ways is weighed alike: the safer one first, no trial while another runs',
    ()=>{
        // The scheduler weighs a trade of processors with the same trial, and
        // two trials at once would each measure the other's switches.
        let clock = 0;
        let other = true;
        const trial = createPlacement({ now: ()=>clock, ways: ['own', 'played'], initial: 'own',
            mayBegin: ()=>!other });
        let retired = 0;
        /** @type {Record<string, number>} */
        const perMs = { own: 100, played: 300 };
        /** @param {number} ms */
        const go = ms=>{
            for (const until = clock + ms; clock < until; clock += 2)
            {
                retired += 2 * perMs[trial.mode()];
                trial.tick(retired);
            }
        };
        go(10_000);
        assert.deepEqual([trial.mode(), trial.trialing(), trial.diagnostics().trials],
            ['own', false, 0], 'the first way kept while another trial runs');
        other = false;
        go(10_000);
        assert.deepEqual([trial.mode(), trial.diagnostics().trials, trial.diagnostics().played],
            ['played', 1, 1], JSON.stringify(trial.diagnostics()));
    });
