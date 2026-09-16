/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FRAME_COLUMNS, FRAME_MIRROR, PHASE_ROWS, PhaseKind, createProfiler,
} from './profiler.js';

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

test('a frame says what its worst moment was made of', ()=>{
    const { at } = harness();

    at(0).beginFrame();
    at(0).begin('guest', PhaseKind.GUEST);
    at(5).end('guest', { instructions: 1000 });
    at(5).begin('idle-fetch-wait', PhaseKind.HOST);
    at(45).end('idle-fetch-wait');
    at(45).begin('guest', PhaseKind.GUEST);
    at(45).compiled(2);
    at(75).end('guest', { instructions: 5000000 });
    at(75).begin('draw', PhaseKind.HOST);
    at(85).end('draw');
    const frame = at(85).endFrame();

    assert.deepEqual(frame.longest, { name: 'idle-fetch-wait', ms: 40 },
        'the one thing the frame waited longest for');
    assert.deepEqual(frame.longestGuest, { ms: 30, instructions: 5000000 },
        'the longest slice, with what it retired');
    assert.equal(frame.waits, 1);
    assert.equal(frame.compiles, 2);

    // The next frame starts clean, and a copy handed out does not change
    // when the slot is reused.
    at(85).beginFrame();
    at(85).begin('guest', PhaseKind.GUEST);
    at(86).end('guest', { instructions: 10 });
    const next = at(86).endFrame();
    assert.deepEqual(next.longest, { name: 'guest', ms: 1 });
    assert.equal(next.waits, 0);
    assert.equal(next.compiles, 0);
    assert.equal(frame.longest.ms, 40);
});

test('a frame keeps what its owner counted into it, by name', ()=>{
    const { at } = harness();
    at(0).beginFrame();
    at(0).note('instructions', 100);
    at(1).note('instructions', 50);
    at(1).note('interpreted', 7);
    const frame = at(2).endFrame();
    assert.deepEqual(frame.notes, { instructions: 150, interpreted: 7 });
    at(2).beginFrame();
    assert.deepEqual(at(3).endFrame().notes, {}, 'the next frame starts with none');
    assert.equal(frame.notes.instructions, 150, 'and the copy handed out keeps its own');
});

test('a phase can stand for several, and is weighed as all of them', ()=>{
    // A caller that times one crossing in eight passes the eight as the
    // weight: the row counts eight, its time is eight times the sample, and
    // the phase around it is relieved of the same.
    const { profiler, at } = harness();

    at(0).beginFrame();
    at(0).begin('guest', PhaseKind.GUEST);
    at(10).begin('trap');
    at(11).end('trap', { weight: 8 });
    at(20).end('guest');
    at(20).endFrame();

    const rows = profiler.snapshot().phases;
    const trap = rows.find((/** @type {any} */ row)=>row.name === 'trap');
    assert.equal(trap.count, 8);
    assert.equal(trap.totalMs, 8, 'one millisecond, eight times over');
    assert.equal(trap.selfMs, 8);
    const guest = rows.find((/** @type {any} */ row)=>row.name === 'guest');
    assert.equal(guest.selfMs, 12, 'the guest phase gave up the eight, not the one');
});

test('a weight scales the estimate over a window, never what one occurrence measured', ()=>{
    // One crossing of ten milliseconds timed as eight: the aggregate rises by
    // eighty, which is what the eight are estimated to have cost. The frame it
    // ended in saw one ten-millisecond phase, and says so -- a longest of
    // eighty would name a freeze that never happened.
    const { profiler, at } = harness();

    at(0).beginFrame();
    at(0).begin('guest', PhaseKind.GUEST);
    at(20).begin('trap');
    assert.equal(at(30).end('trap', { weight: 8 }), 10, 'end() answers what was measured');
    at(60).end('guest');
    const frame = at(100).endFrame();

    const trap = profiler.snapshot().phases.find((/** @type {any} */ row)=>row.name === 'trap');
    assert.equal(trap.totalMs, 80);
    assert.equal(trap.selfMs, 80);
    assert.equal(trap.worstMs, 10, 'the worst occurrence is one occurrence');
    assert.deepEqual(frame.longest, { name: 'guest', ms: 60 },
        'the sixty-millisecond slice, not a trap of eighty that never happened');
    assert.equal(frame.byKind.host, 10, 'the frame measured ten milliseconds of ours');
    assert.equal(frame.byKind.guest, 50);
    assert.equal(frame.sampled.host, 70, 'and estimates seventy more for the untimed seven');
    assert.equal(frame.sampled.guest, -70, 'which the guest stood for');
    assert.equal(frame.hostShare, 0.1, 'a frame is measured, not estimated');
    assert.equal(profiler.snapshot().hostShare, 0.8, 'the window is estimated');
});

test('weighted parent, unweighted child: self = (1 - 0.5) * 8 = 4', ()=>{
    // The child was measured once and stands for itself alone; the parent
    // stands for eight. Subtracting the child's raw time from the parent's
    // raw time before scaling by the parent's own weight is what keeps the
    // parent's self time from also multiplying the child's by eight.
    const { profiler, at } = harness();

    at(0).beginFrame();
    at(0).begin('parent');
    at(0).begin('child');
    at(0.5).end('child');
    at(1).end('parent', { weight: 8 });
    at(1).endFrame();

    const parent = profiler.snapshot().phases.find((/** @type {any} */ row)=>row.name === 'parent');
    assert.equal(parent.selfMs, 4);
});

test('a frame whose one sample outweighs it never reports the guest at less than nothing', ()=>{
    // A thirty-seven millisecond crossing in a forty millisecond frame, weighed
    // as eight, stands for far more than the frame held. The frame's split is
    // what the clock saw; the surplus is an estimate and is kept as one.
    const { at } = harness();

    at(0).beginFrame();
    at(0).begin('guest', PhaseKind.GUEST);
    at(1).begin('trap');
    at(38).end('trap', { weight: 8 });
    at(40).end('guest');
    const frame = at(40).endFrame();

    assert.equal(frame.byKind.guest, 3);
    assert.equal(frame.byKind.host, 37);
    assert.equal(frame.byKind.host + frame.byKind.guest, frame.ms, 'the split is the frame');
    assert.deepEqual(frame.longest, { name: 'guest', ms: 40 });
    assert.equal(frame.sampled.host, 37 * 7);
});

test('a frame says how long the machine had nothing of the program\'s to run', ()=>{
    const { at } = harness();

    at(0).beginFrame();
    at(0).begin('guest', PhaseKind.GUEST);
    at(10).end('guest', { instructions: 100 });
    at(10).begin('idle-host');
    at(30).end('idle-host');
    at(30).begin('idle-fetch-wait');
    at(45).end('idle-fetch-wait');
    const frame = at(50).endFrame();

    assert.equal(frame.idleMs, 35, 'both idle turns, whether they waited on a timer or not');
    assert.equal(frame.waits, 1, 'only the one that waited');
    at(50).beginFrame();
    assert.equal(at(60).endFrame().idleMs, 0, 'the next frame starts from nothing');
});

/**
 * A frame table that counts what closing a frame costs: how many columns were
 * stored, and how many rows taken.
 */
function countingTables(){
    let stores = 0;
    let advances = 0;
    /** @param {number} rows @param {number} width */
    const table = (rows, width)=>({
        rows,
        width,
        values: new Float64Array(rows * width),
        /** @param {number} row @param {number} column @param {number} value */
        set(row, column, value){
            stores++;
            this.values[row * width + column] = value;
        },
        /** @param {number} row @param {number} column @param {number} amount */
        add(row, column, amount){
            stores++;
            this.values[row * width + column] += amount;
        },
        used(){},
        advance(){ return advances++ % rows; },
        describe(){ return { buffer: new ArrayBuffer(0), rows, columns: [] }; },
    });
    return {
        cost: ()=>({ stores, advances }),
        reset: ()=>{ stores = 0; advances = 0; },
        tables: { frames: table(8, FRAME_COLUMNS.length), phases: table(PHASE_ROWS, 6) },
    };
}

test('closing a frame stores one row and nothing more, whatever the frame held', ()=>{
    const counted = countingTables();
    const { at } = harness({ tables: counted.tables, frames: 8 });

    at(0).beginFrame();
    at(0).endFrame();
    const { stores, advances } = counted.cost();
    assert.equal(advances, 1);
    assert.equal(stores, FRAME_COLUMNS.length, 'every column of the row, and no other store');

    // The same row, written the same way, for a frame that held hundreds of
    // phases: a frame's close must not walk what the frame did.
    counted.reset();
    at(0).beginFrame();
    for (let turn = 0; turn < 200; turn++)
    {
        at(turn).begin('guest', PhaseKind.GUEST);
        at(turn + 1).end('guest', { instructions: 1000 });
        at(turn + 1).note('instructions', 1000);
    }
    at(300).endFrame();
    assert.equal(counted.cost().advances, 1);
    assert.equal(counted.cost().stores, FRAME_COLUMNS.length + 2 + 200 * 4,
        'the row, the two stores naming a new phase row, and four per close');
});

test('a frame carries the counters of the layers it was given, and zero for the rest', ()=>{
    const counted = countingTables();
    const { profiler, at } = harness({ tables: counted.tables, frames: 8 });
    const cpu = new Float64Array([0, 1000, 0]);

    // One column answered, the rest absent: the row's layout is the same either way.
    profiler.mirror(FRAME_MIRROR.map(entry=>entry.column === 'retired' ? cpu : null),
        FRAME_MIRROR.map(entry=>entry.column === 'retired' ? 1 : 0));
    const row = counted.tables.frames.values;
    const column = (/** @type {string} */ name)=>row[FRAME_COLUMNS.indexOf(name)];
    at(0).beginFrame();
    at(10).endFrame();
    assert.equal(column('retired'), 1000, 'as the counter stood when the frame closed');
    assert.equal(column('entries'), 0, 'a column no layer answers');

    cpu[1] = 4000;
    at(10).beginFrame();
    at(20).endFrame();
    assert.equal(row[FRAME_COLUMNS.length + FRAME_COLUMNS.indexOf('retired')], 4000,
        'the next row carries the next reading, cumulative as the counter is');
});
