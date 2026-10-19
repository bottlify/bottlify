/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacement } from './placement.js';

/**
 * A program whose frames come every `frameMs(moved, clock)` milliseconds, the
 * moves made so far named in `moved`, its gains for each move `gains(moved,
 * clock)`, run for `ms` in steps of two.
 *
 * @param {{ frameMs: (moved: Set<string>, clock: number) => number,
 *     gains: (moved: Set<string>, clock: number) => Record<string, number>, ms: number,
 *     options?: Record<string, number> }} program
 */
function run({ frameMs, gains, ms, options = {} }){
    let clock = 0;
    /** @type {Set<string>} */
    const moved = new Set();
    /** @type {{ key: string, at: number, undone: boolean }[]} */
    const moves = [];
    const placement = createPlacement({ now: ()=>clock, ...options,
        apply: key=>{
            moved.add(key);
            moves.push({ key, at: clock, undone: false });
        },
        undo: key=>{
            moved.delete(key);
            const last = [...moves].reverse().find(one=>one.key === key);
            if (last)
            {
                last.undone = true;
            }
        } });
    let next = 0;
    let slowFrames = 0;
    for (; clock < ms; clock += 2)
    {
        if (clock >= next)
        {
            placement.frame();
            const each = frameMs(moved, clock);
            slowFrames += each > 50 ? 1 : 0;
            next = clock + each;
        }
        placement.tick(clock * 1000, ()=>new Map(Object.entries(gains(moved, clock))));
    }
    return { placement, moved, moves, slowFrames };
}

test('a move whose gain holds is made once its sum reaches the threshold, and not before', ()=>{
    // A thread that would save 40% of each window here: 0.4 x 250 ms a window
    // builds 300 ms in some three windows, less what leaks.
    /** @type {(moved: Set<string>) => Record<string, number>} */
    const gains = one=>(one.has('in:3') ? {} : { 'in:3': 0.4 });
    const { moves, moved } = run({ ms: 20_000, frameMs: one=>(one.has('in:3') ? 20 : 30), gains });
    assert.equal(moves.length, 1, JSON.stringify(moves));
    assert.ok(moves[0].at >= 750 && moves[0].at <= 1500, `made at ${moves[0].at} ms`);
    assert.ok(moved.has('in:3'), 'and kept: the program went faster');
});

test('no gain, a gain below zero or a burst of a few hundred milliseconds moves nothing', ()=>{
    /** @type {((moved: Set<string>, clock: number) => Record<string, number>)[]} */
    const all = [()=>({}), ()=>({ 'in:3': -0.5, 'out:4': 0 }),
        (_, clock)=>/** @type {Record<string, number>} */ (clock >= 5000 && clock < 5400
            ? { 'in:3': 0.5 } : {})];
    for (const gains of all)
    {
        const { moves } = run({ ms: 30_000, frameMs: ()=>25, gains });
        assert.deepEqual(moves, []);
    }
});

test('one move at a time: the move further past its threshold first, the next once it is checked',
    ()=>{
        /** @type {(moved: Set<string>) => Record<string, number>} */
        const gains = one=>({ ...one.has('in:3') ? {} : { 'in:3': 0.3 },
            ...one.has('in:5') ? {} : { 'in:5': 0.6 } });
        const { moves } = run({ ms: 20_000, frameMs: one=>30 - 5 * one.size, gains });
        assert.deepEqual(moves.map(one=>one.key), ['in:5', 'in:3']);
        assert.ok(moves[1].at - moves[0].at >= 1750,
            `the second ${moves[1].at - moves[0].at} ms on`);
    });

test('a move that leaves the program slower is undone, and proposed again only seldom', ()=>{
    // The reckoning keeps saying the thread gains here; the frames say it does not.
    /** @type {(moved: Set<string>) => Record<string, number>} */
    const gains = one=>(one.has('in:3') ? {} : { 'in:3': 0.4 });
    const { moves, moved, slowFrames, placement } = run({ ms: 120_000,
        frameMs: one=>(one.has('in:3') ? 60 : 30), gains });
    assert.ok(!moved.has('in:3'), 'taken back');
    assert.ok(moves.every(one=>one.undone), JSON.stringify(moves));
    // Each refusal raises the threshold four times: a handful of tries in two minutes, not one
    // every few seconds, and each the check's length of slow frames.
    assert.ok(moves.length >= 2 && moves.length <= 6, `${moves.length} tries`);
    assert.equal(placement.diagnostics().undone, moves.length);
    assert.ok(slowFrames < moves.length * 40, `${slowFrames} slow frames`);
});

test('a gate\'s churn moves something every so often, gains or not', ()=>{
    const { moves } = run({ ms: 2000, frameMs: ()=>20, gains: ()=>({ 'in:3': -1, 'out:4': -1 }),
        options: { churnMs: 50, verifyMs: 10, windowMs: 5 } });
    assert.ok(moves.length >= 10, `${moves.length} moves`);
});
