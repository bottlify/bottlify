/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Frame drops told apart by what grew: a run of ordinary 16 ms frames with one
 * drop of each cause among them, each named by the part of the frame that
 * grew past the ordinary frame's; and the rates of the slowest frames.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameDrops } from './frame-drops.js';

/**
 * An ordinary frame: 10 ms of the guest, 4 of ours, 2 parked, a million
 * instructions, a few interpreted, one module instantiated.
 *
 * @param {Partial<import('./frame-drops.js').FrameLike>} [change]
 * @returns {import('./frame-drops.js').FrameLike}
 */
const frame = (change = {})=>({
    ms: 16, byKind: { guest: 10, host: 4, gpu: 0, present: 0 }, idleMs: 2, waits: 0,
    compiles: 1, instructions: 1e6, notes: { interpreted: 100, heapDelta: 1000 },
    longest: { name: 'trap', ms: 1 }, ...change,
});

test('each drop is named by the part of the frame that grew past the ordinary one', ()=>{
    const frames = Array.from({ length: 200 }, (_, index)=>({ ...frame(), index }));
    /** @type {[number, Partial<import('./frame-drops.js').FrameLike>, string][]} */
    const cases = [
        [10, { ms: 60, byKind: { guest: 54, host: 4 }, compiles: 9 }, 'translation'],
        [20, { ms: 60, byKind: { guest: 54, host: 4 }, notes: { interpreted: 5000 } },
            'translation'],
        [30, { ms: 60, byKind: { guest: 54, host: 4 }, instructions: 5e6 }, 'guest work'],
        [40, { ms: 60, byKind: { guest: 54, host: 4 } }, 'guest slower'],
        [50, { ms: 60, byKind: { guest: 10, host: 48 }, longest: { name: 'drive', ms: 40 } },
            'host drive'],
        [60, { ms: 60, idleMs: 46, waits: 3 }, 'fetch'],
        [70, { ms: 60, idleMs: 46 }, 'waiting'],
        [80, { ms: 60, notes: { heapDelta: -50e6 } }, 'outside the engine: garbage collection'],
        [90, { ms: 60 }, 'outside the engine'],
    ];
    for (const [index, change] of cases)
    {
        frames[index] = { ...frame(change), index };
    }
    const report = frameDrops(frames);
    assert.equal(report.frames, 200);
    assert.equal(report.medianMs, 16);
    assert.equal(report.gpu, 'not measured', 'the record carries no GPU time');
    assert.deepEqual(report.drops.map(drop=>[drop.index, drop.cause]),
        cases.map(([index, , cause])=>[index, cause]));
    assert.equal(report.drops[0].excessMs, 44, 'past the median frame');
    assert.deepEqual(report.byCause, {
        'translation': 2, 'guest work': 1, 'guest slower': 1, 'host drive': 1, 'fetch': 1,
        'waiting': 1, 'outside the engine: garbage collection': 1, 'outside the engine': 1,
    });
});

test('the mean rate, the slowest 1% and 0.1% as rates, and the worst frames', ()=>{
    // 990 frames of 10 ms, 9 of 50 ms and one of 200 ms.
    const frames = [
        ...Array.from({ length: 990 }, ()=>frame({ ms: 10 })),
        ...Array.from({ length: 9 }, ()=>frame({ ms: 50 })),
        frame({ ms: 200 }),
    ];
    const report = frameDrops(frames);
    assert.equal(report.fps.toFixed(3), (1000 * 1000 / (9900 + 450 + 200)).toFixed(3));
    assert.equal(report.low1, 1000 / ((9 * 50 + 200) / 10), 'the slowest ten frames');
    assert.equal(report.low01, 5, 'the slowest frame alone');
    assert.deepEqual(report.worstMs, [200, 50, 50, 50, 50]);
    assert.equal(report.drops.length, 10, 'every frame over twice the median');
});

test('no frames is no report, not zeros dressed as one', ()=>{
    const report = frameDrops([]);
    assert.equal(report.frames, 0);
    assert.deepEqual(report.drops, []);
});
