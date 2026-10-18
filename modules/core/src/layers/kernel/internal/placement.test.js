/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Placement, createPlacement } from './placement.js';

/**
 * A program whose frames come every `frameMs[mode]` milliseconds (none where
 * absent) and whose executors retire `retiredPerMs[mode]` instructions a
 * millisecond, run for `ms` in steps of a turn.
 *
 * @param {{ frameMs?: Record<string, number>, retiredPerMs: Record<string, number>, ms: number,
 *     fixed?: 'spread' | 'concentrate' | null }} program
 */
function run({ frameMs, retiredPerMs, ms, fixed = null }){
    let clock = 0;
    const placement = createPlacement({ now: ()=>clock, fixed });
    let retired = 0;
    let nextFrame = 0;
    /** @type {Record<string, number>} */
    const time = { spread: 0, concentrate: 0 };
    for (; clock < ms; clock += 2)
    {
        const mode = placement.mode();
        time[mode] += 2;
        retired += 2 * retiredPerMs[mode];
        if (frameMs && clock >= nextFrame)
        {
            placement.frame();
            nextFrame = clock + frameMs[mode];
        }
        placement.tick(retired);
    }
    return { placement, time };
}

test('a program whose frames come faster concentrated is run concentrated, '
    + 'whatever it retires', ()=>{
    // Spread retires more -- threads spinning on their jobs -- and draws fewer frames.
    const { placement, time } = run({ frameMs: { spread: 170, concentrate: 125 },
        retiredPerMs: { spread: 900_000, concentrate: 600_000 }, ms: 120_000 });
    assert.equal(placement.mode(), Placement.CONCENTRATE);
    const said = placement.diagnostics();
    assert.ok(said.trials >= 2 && said.concentrate === said.trials, JSON.stringify(said));
    assert.equal(said.byFrames, said.trials, 'measured by frames');
    assert.ok(time.concentrate > 4 * time.spread, `mostly concentrated: ${JSON.stringify(time)}`);
});

test('a program with no frames that retires twice as much spread is run spread, '
    + 'and tried less often while it stays so', ()=>{
    const { placement, time } = run({ retiredPerMs: { spread: 2_000_000, concentrate: 1_000_000 },
        ms: 300_000 });
    assert.equal(placement.mode(), Placement.SPREAD);
    const said = placement.diagnostics();
    assert.ok(said.trials >= 3 && said.spread === said.trials, JSON.stringify(said));
    assert.equal(said.byFrames, 0);
    assert.ok(said.holdMs > 30_000, 'the hold grows while the same way wins');
    assert.ok(time.spread > 15 * time.concentrate, `mostly spread: ${JSON.stringify(time)}`);
});

test('spreading must win by the margin: a few percent stays concentrated', ()=>{
    const { placement } = run({ frameMs: { spread: 97, concentrate: 100 },
        retiredPerMs: { spread: 1, concentrate: 1 }, ms: 60_000 });
    assert.equal(placement.mode(), Placement.CONCENTRATE);
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
    assert.ok(said.spread >= 2, `the load ran spread: ${JSON.stringify(said)}`);
    assert.ok(concentratedAt > 0 && concentratedAt - PLAY_AT < 12_000,
        `the play concentrated ${concentratedAt - PLAY_AT} ms in: ${JSON.stringify(said)}`);
    assert.equal(placement.mode(), Placement.CONCENTRATE);
    assert.equal(said.holdMs, 30_000, 'the hold starts over with the new measure');
});

test('a game far slower spread is tried a few times, its slow windows ended early, and runs'
    + ' concentrated', ()=>{
    // The Crysis demo's timedemo on four cores: a frame every 110 ms concentrated,
    // 450 spread, where its threads spinning on their jobs retire more.
    const { placement, time } = run({ frameMs: { spread: 450, concentrate: 110 },
        retiredPerMs: { spread: 900_000, concentrate: 600_000 }, ms: 300_000 });
    const said = placement.diagnostics();
    assert.equal(placement.mode(), Placement.CONCENTRATE);
    assert.ok(said.trials <= 4 && said.byFrames === said.trials, JSON.stringify(said));
    assert.ok(time.spread < 0.03 * (time.spread + time.concentrate),
        `spread ${time.spread} ms of ${time.spread + time.concentrate}`);
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
