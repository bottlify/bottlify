/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhaseKind, createProfiler } from './profiler.js';

/**
 * A clock the test sets to an exact reading before every call, so a duration in
 * an assertion is arithmetic rather than a measurement.
 *
 * @param {any} [options]
 */
function harness(options){
    let time = 0;
    const profiler = createProfiler({ now: ()=>time, ...options });
    return {
        profiler,
        /** @param {number} to */
        at(to){
            time = to;
            return profiler;
        },
    };
}

test('a phase inside ours is not counted as ours', ()=>{
    const { at } = harness();

    at(0).beginFrame();
    at(10).begin('present', PhaseKind.HOST);
    at(20).begin('run', PhaseKind.GUEST);
    at(80).end('run');
    assert.equal(at(90).end('present'), 80, 'the outer phase lasted from 10 to 90');
    const frame = at(100).endFrame();

    assert.equal(frame.ms, 100);
    assert.equal(frame.byKind.guest, 60);
    assert.equal(frame.byKind.host, 20, 'the sixty spent in the guest are not ours');
    assert.equal(frame.hostShare, 0.2);
});

test('a phase keeps its total, its self time and its worst hold', ()=>{
    const { profiler, at } = harness();

    at(0).beginFrame();
    at(0).begin('Blt');
    at(5).end('Blt');
    at(5).begin('Blt');
    at(6).begin('upload', PhaseKind.GPU);
    at(26).end('upload');
    at(30).end('Blt');
    at(30).endFrame();

    const rows = profiler.snapshot().phases;
    const blt = rows.find((/** @type {any} */ row)=>row.name === 'Blt');
    assert.equal(blt.count, 2);
    assert.equal(blt.totalMs, 30, '5 plus 25');
    assert.equal(blt.selfMs, 10, 'the 20 the GPU took are not the caller\'s');
    // What a guest thread waited through, which is the cost that outranks the
    // average: the second call held it for 25ms though its own work was 5.
    assert.equal(blt.worstMs, 25);
    assert.equal(rows[0].name, 'upload', 'ordered by self time');
});

test('an unbalanced phase is counted, never thrown and never charged elsewhere', ()=>{
    const { profiler, at } = harness();

    at(0).beginFrame();
    at(0).begin('outer');
    at(5).end('inner');
    at(5).end();
    at(5).endFrame();
    at(5).endFrame();

    const snapshot = profiler.snapshot();
    assert.equal(snapshot.unbalanced, 3, 'a wrong name, an extra end, an extra endFrame');
    assert.equal(snapshot.openPhases, 0);
    // A count says the accounting is wrong; only a name says where.
    assert.deepEqual(snapshot.imbalances, [
        'end(inner) while outer open at depth 1',
        'end() at depth 0',
        'endFrame() with no frame open',
    ]);
});

test('imbalances are named for the first few and only counted after that', ()=>{
    const { profiler, at } = harness();

    for (let turn = 0; turn < 20; turn++)
    {
        at(turn).end('turn');
    }

    const snapshot = profiler.snapshot();
    assert.equal(snapshot.unbalanced, 20);
    assert.equal(snapshot.imbalances.length, 8, 'a loop that misbehaves every turn stays bounded');
    assert.equal(snapshot.imbalances[0], 'end(turn) at depth 0');
    assert.deepEqual(profiler.snapshot().imbalances, snapshot.imbalances,
        'a snapshot hands out a copy, not the ring itself');
});

test('a phase outside a frame is still measured, and charged to no frame', ()=>{
    const { profiler, at } = harness();

    at(0).begin('startup');
    at(500).end('startup');

    const snapshot = profiler.snapshot();
    assert.equal(snapshot.phases[0].selfMs, 500);
    assert.equal(snapshot.frames, 0);
    assert.equal(snapshot.hostShare, 0, 'nothing to take a share of yet');
});

test('the frame history laps, and the frame being measured is not reported', ()=>{
    const { profiler, at } = harness({ frames: 3 });

    for (let index = 0; index < 5; index++)
    {
        at(index * 100).beginFrame();
        at(index * 100 + 10 * index).endFrame();
    }
    assert.deepEqual(profiler.frames().map((/** @type {any} */ f)=>f.index), [2, 3, 4]);

    at(1000).beginFrame();
    assert.deepEqual(profiler.frames().map((/** @type {any} */ f)=>f.index), [3, 4],
        'the open frame has no total yet and would read as a fast one');
});

test('the watched share is taken over the history, and the worst frames are named', ()=>{
    const { profiler, at } = harness({ frames: 10 });

    // Three cheap frames and one where our code ate most of a longer budget.
    const budget = [{ cost: 1, ms: 50 }, { cost: 1, ms: 50 }, { cost: 1, ms: 50 },
        { cost: 40, ms: 90 }];
    let time = 0;
    for (const entry of budget)
    {
        at(time).beginFrame();
        at(time).begin('flip');
        at(time + entry.cost).end('flip');
        time += entry.ms;
        at(time).endFrame();
    }

    const snapshot = profiler.snapshot(2);
    assert.equal(snapshot.averageFrameMs, 60);
    assert.equal(snapshot.hostShare, 43 / 240);
    assert.deepEqual(snapshot.worstFrames.map((/** @type {any} */ f)=>f.hostShare),
        [40 / 90, 1 / 50], 'the frame that stalled is named, not averaged away');
});
