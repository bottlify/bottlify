/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacement } from './placement.js';

const OPPOSITE = { in: 'out', out: 'in' };

/**
 * A program whose gains for each move are `gains(moved, clock)`, the moves
 * made so far named in `moved`, run for `ms` in steps of two.
 *
 * @param {{ gains: (moved: Set<string>, clock: number) => Record<string, number>, ms: number,
 *     options?: Record<string, number> }} program
 */
function run({ gains, ms, options = {} }){
    let clock = 0;
    /** @type {Set<string>} */
    const moved = new Set();
    /** @type {{ key: string, at: number }[]} */
    const moves = [];
    const placement = createPlacement({ now: ()=>clock, ...options,
        opposite: key=>{
            const [kind, id] = key.split(':');
            return `${OPPOSITE[/** @type {'in' | 'out'} */ (kind)]}:${id}`;
        },
        apply: key=>{
            const [kind, id] = key.split(':');
            moved.delete(`${OPPOSITE[/** @type {'in' | 'out'} */ (kind)]}:${id}`);
            moved.add(key);
            moves.push({ key, at: clock });
        } });
    for (; clock < ms; clock += 2)
    {
        placement.tick(()=>new Map(Object.entries(gains(moved, clock))));
    }
    return { placement, moved, moves };
}

test('a move whose gain holds is made once its sum reaches the threshold, and not before', ()=>{
    // A thread that would save 40% of each window here: 0.4 x 250 ms a window
    // builds 300 ms in some three windows, less what leaks.
    /** @type {(moved: Set<string>) => Record<string, number>} */
    const gains = one=>(one.has('in:3') ? {} : { 'in:3': 0.4 });
    const { moves, moved } = run({ ms: 20_000, gains });
    assert.equal(moves.length, 1, JSON.stringify(moves));
    assert.ok(moves[0].at >= 750 && moves[0].at <= 1500, `made at ${moves[0].at} ms`);
    assert.ok(moved.has('in:3'), 'and kept: nothing says to take it back');
});

test('no gain, a gain below zero or a burst of a few hundred milliseconds moves nothing', ()=>{
    /** @type {((moved: Set<string>, clock: number) => Record<string, number>)[]} */
    const all = [()=>({}), ()=>({ 'in:3': -0.5, 'out:4': 0 }),
        (_, clock)=>/** @type {Record<string, number>} */ (clock >= 5000 && clock < 5400
            ? { 'in:3': 0.5 } : {})];
    for (const gains of all)
    {
        const { moves } = run({ ms: 30_000, gains });
        assert.deepEqual(moves, []);
    }
});

test('one move at a time: the move further past its threshold first, the next once its sum'
    + ' has built again past the window the first fell in', ()=>{
    /** @type {(moved: Set<string>) => Record<string, number>} */
    const gains = one=>({ ...one.has('in:3') ? {} : { 'in:3': 0.3 },
        ...one.has('in:5') ? {} : { 'in:5': 0.6 } });
    const { moves } = run({ ms: 20_000, gains });
    assert.deepEqual(moves.map(one=>one.key), ['in:5', 'in:3']);
    assert.ok(moves[1].at - moves[0].at >= 1000,
        `the second ${moves[1].at - moves[0].at} ms on`);
});

test('a move whose gains then say to take it back is taken back, and a pair that keeps'
    + ' answering each other is made at ever longer gaps', ()=>{
    // The reckoning was wrong about the thread: placed here, its waits say it
    // gains apart; apart, they say it gains here.
    /** @type {(moved: Set<string>) => Record<string, number>} */
    const gains = one=>(one.has('in:3') ? { 'out:3': 0.4 } : { 'in:3': 0.4 });
    const { moves } = run({ ms: 120_000, gains });
    assert.deepEqual(moves.slice(0, 2).map(one=>one.key), ['in:3', 'out:3']);
    assert.ok(moves.length >= 3 && moves.length <= 8, `${moves.length} moves in two minutes`);
    const gaps = moves.slice(1).map((one, i)=>one.at - moves[i].at);
    // Each move back needs twice what the one before it did, less what a
    // half-minute forgives: from a couple of seconds to half a minute and more.
    assert.ok(gaps.slice(1).every(gap=>gap > gaps[0]) && Math.max(...gaps) >= 10 * gaps[0],
        `gaps ${gaps.join(', ')} ms`);
});

test('a gate\'s churn moves something every so often, gains or not', ()=>{
    const { moves } = run({ ms: 2000, gains: ()=>({ 'in:3': -1, 'out:4': -1 }),
        options: { churnMs: 50, windowMs: 5 } });
    assert.ok(moves.length >= 10, `${moves.length} moves`);
});
