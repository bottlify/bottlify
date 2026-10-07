/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDriverState, decide, median } from './driver.js';

const SETTINGS = { perProcess: 4 };

test('the median of the shares, an even count taking the middle two\'s mean', ()=>{
    assert.equal(median([0.9, 0.1]), 0.5);
    assert.equal(median([0.2, 0.9, 0.8]), 0.8);
    assert.equal(median([]), 0);
});

test('a worker joins when the median comes to 80 %, not when one worker alone is busy', ()=>{
    assert.deepEqual(decide(createDriverState(), [{ id: 1, shares: [0.85] }], 0, SETTINGS),
        [{ kind: 'join', process: 1 }]);
    assert.deepEqual(decide(createDriverState(), [{ id: 1, shares: [0.79] }], 0, SETTINGS), []);
    // Two at 90 % and 10 %: the work does not split, a third would sit idle.
    assert.deepEqual(decide(createDriverState(), [{ id: 1, shares: [0.9, 0.1] }], 0, SETTINGS),
        []);
    assert.deepEqual(decide(createDriverState(), [{ id: 1, shares: [0.9, 0.85] }], 0, SETTINGS),
        [{ kind: 'join', process: 1 }]);
});

test('no more than `perProcess` work for one process, nor perProcess × n in the pool', ()=>{
    const state = createDriverState();
    assert.deepEqual(decide(state, [{ id: 1, shares: [1, 1, 1, 1] }], 0, SETTINGS), []);
    // Two processes: a ceiling of eight, seven working, so one of the two busy ones gains.
    const two = decide(state, [{ id: 1, shares: [1, 1, 1] }, { id: 2, shares: [1, 1, 1, 0.99] }],
        0, SETTINGS);
    assert.deepEqual(two, [{ kind: 'join', process: 1 }]);
});

test('joined workers leave at once when the process waits, and in time when its load falls',
    ()=>{
        const state = createDriverState();
        // Every worker idle: it stopped translating to wait.
        assert.deepEqual(decide(state, [{ id: 1, shares: [0, 0.01, 0] }], 0, SETTINGS),
            [{ kind: 'leave', process: 1 }, { kind: 'leave', process: 1 }]);
        // Low but working: one leaves after three seconds of it, the next three later.
        const low = [{ id: 1, shares: [0.3, 0.2, 0.1] }];
        assert.deepEqual(decide(state, low, 1000, SETTINGS), []);
        assert.deepEqual(decide(state, low, 3500, SETTINGS), []);
        assert.deepEqual(decide(state, low, 4000, SETTINGS), [{ kind: 'leave', process: 1 }]);
        assert.deepEqual(decide(state, low, 5000, SETTINGS), []);
        // A process's first worker never goes.
        assert.deepEqual(decide(state, [{ id: 1, shares: [0] }], 9000, SETTINGS), []);
        assert.deepEqual(decide(state, [{ id: 1, shares: [0.1] }], 20000, SETTINGS), []);
    });

test('a join stays when the process\'s workers emit faster for it, and leaves when they do not',
    ()=>{
        const state = createDriverState();
        // Before: 100 regions a second at 90 %; a worker joins.
        assert.deepEqual(decide(state, [{ id: 1, shares: [0.9], rate: 100 }], 0, SETTINGS),
            [{ kind: 'join', process: 1 }]);
        // Both busy, 160 a second: more than half of what one more adds at best.
        decide(state, [{ id: 1, shares: [0.9, 0.9], rate: 160 }], 500, SETTINGS);
        assert.deepEqual(decide(state, [{ id: 1, shares: [0.9, 0.9], rate: 160 }], 1000,
            SETTINGS), []);
        // A third joins; the rate stays where two had it: the machine has no core to give.
        assert.deepEqual(decide(state, [{ id: 1, shares: [0.9, 0.9], rate: 160 }], 1500,
            SETTINGS), [{ kind: 'join', process: 1 }]);
        decide(state, [{ id: 1, shares: [0.95, 0.9, 0.9], rate: 165 }], 2000, SETTINGS);
        assert.deepEqual(decide(state, [{ id: 1, shares: [0.95, 0.9, 0.9], rate: 162 }], 2500,
            SETTINGS), [{ kind: 'leave', process: 1 }]);
        // Two is its ceiling from now on, however busy they are.
        assert.deepEqual(decide(state, [{ id: 1, shares: [1, 1], rate: 160 }], 3000, SETTINGS), []);
    });

test('a trial is weighed over the windows its work lasts, and none joins meanwhile', ()=>{
    const state = createDriverState();
    decide(state, [{ id: 1, shares: [0.9], rate: 100 }], 0, SETTINGS);
    // The work ran short: the window says nothing of what the join is worth.
    assert.deepEqual(decide(state, [{ id: 1, shares: [0.3, 0.2], rate: 40 }], 500, SETTINGS), []);
    assert.equal(state.ceilings.size, 0);
    // Busy again, and faster: the join stays, and the next may come.
    assert.deepEqual(decide(state, [{ id: 1, shares: [0.9, 0.9], rate: 190 }], 1000, SETTINGS),
        []);
    assert.deepEqual(decide(state, [{ id: 1, shares: [0.9, 0.9], rate: 190 }], 1500, SETTINGS),
        []);
    assert.equal(state.ceilings.size, 0);
    assert.deepEqual(decide(state, [{ id: 1, shares: [0.9, 0.9], rate: 190 }], 2000, SETTINGS),
        [{ kind: 'join', process: 1 }]);
});

/**
 * A recorded load replayed through the driver. The demand is the milliseconds
 * the one worker of the recording was busy in each interval; what k workers
 * do not get through in an interval waits for the next, and each works an
 * even share of what they get through (a fluid model, not the engine: it
 * shows what the driver decides on a real load's shape, not what the load
 * would have cost).
 *
 * @param {[number, number, number | null][]} points
 * @param {number} perProcess
 * @param {boolean} [contended]  the machine has no core to spare: however many
 *     work, together they get through what one does
 */
function replay(points, perProcess, contended = false){
    const state = createDriverState();
    let workers = 1;
    let backlog = 0;
    let most = 1;
    let changes = 0;
    /** @type {[number, number][]} */
    const counts = [];
    let previous = 0;
    for (const [at, busyMs] of points)
    {
        const windowMs = (at - previous) * 1000;
        previous = at;
        backlog += busyMs;
        const capacity = contended ? windowMs : workers * windowMs;
        const done = Math.min(backlog, capacity);
        backlog -= done;
        const share = contended ? (done / windowMs) : done / workers / windowMs;
        const decisions = decide(state, [{ id: 1, shares: new Array(workers).fill(share),
            rate: done / windowMs * 1000 }], at * 1000, { perProcess });
        for (const { kind } of decisions)
        {
            workers += kind === 'join' ? 1 : -1;
            changes++;
        }
        most = Math.max(most, workers);
        counts.push([at, workers]);
    }
    return { most, changes, last: workers, counts };
}

const recorded = JSON.parse(readFileSync(new URL('./recorded-loads.json', import.meta.url),
    'utf8'));

for (const perProcess of [2, 4, 8])
{
    test(`a recorded load (doom-3-demo) gains workers while it loads and gives them back,`
        + ` without swinging (${perProcess} at most)`, ()=>{
        const { most, changes, last, counts } = replay(recorded.doom3, perProcess);
        assert.ok(most >= 2, `joined while loading: ${JSON.stringify(counts)}`);
        assert.ok(most <= perProcess, `${most} at most`);
        assert.equal(last, 1, `back to its first: ${JSON.stringify(counts)}`);
        // Up and down once each per worker, and a little more: a swing is a
        // join and a leave over and over.
        assert.ok(changes <= 2 * perProcess + 4, `${changes} changes: ${JSON.stringify(counts)}`);
    });
}

test('a recorded load on a machine with no core to spare tries one join, and keeps none',
    ()=>{
        const { most, changes, last, counts } = replay(recorded.doom3, 8, true);
        assert.ok(most <= 2, `${most} at most: ${JSON.stringify(counts)}`);
        assert.ok(changes <= 2, `${changes} changes: ${JSON.stringify(counts)}`);
        assert.equal(last, 1);
    });

test('a recorded load whose one worker is never 80 % busy over a window (tron-demo) gains none',
    ()=>{
        // Its windows are three seconds: at most 61 % of one busy.
        const { most, changes } = replay(recorded.tron, 8);
        assert.equal(most, 1);
        assert.equal(changes, 0);
    });
