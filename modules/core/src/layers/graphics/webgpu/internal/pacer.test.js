/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every test here drives a clock by hand and fires the display's ticks itself,
 * so a frame interval is an exact number rather than whatever the machine
 * running the suite felt like. A pacer measured against a real clock would
 * report a different distribution on a busy machine, which is the one thing a
 * stutter diagnostic must not do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer } from './pacer.js';

/** @param {Partial<import('./pacer.js').PacerOptions>} [overrides] */
function harness(overrides){
    let clock = 0;
    let shown = 0;
    /** @type {(() => void)[]} */
    const ticks = [];
    const pacer = createPacer({
        now: ()=>clock,
        schedule: tick=>ticks.push(tick),
        ...overrides,
    });
    return {
        pacer,
        show: ()=>shown++,
        shown: ()=>shown,
        /** @param {number} ms */
        advance(ms){
            clock += ms;
        },
        /**
         * Fires every tick armed so far, as one display refresh would. A tick
         * that re-arms itself lands after this batch, not inside it.
         *
         * @returns {number} how many were armed
         */
        refresh(){
            const armed = ticks.splice(0);
            armed.forEach(tick=>tick());
            return armed.length;
        },
    };
}

test('a request is never shown to the caller that made it', ()=>{
    const h = harness();
    h.pacer.request(h.show);
    assert.equal(h.shown(), 0, 'nothing travels before the display is ready');
    assert.equal(h.pacer.diagnostics().waiting, true);
    assert.equal(h.refresh(), 1);
    assert.equal(h.shown(), 1);
    assert.equal(h.pacer.diagnostics().waiting, false);
});

test('several requests inside one refresh are one delivery and the rest are coalesced', ()=>{
    const h = harness();
    h.pacer.request(h.show);
    h.pacer.request(h.show);
    h.pacer.request(h.show);
    assert.equal(h.refresh(), 1, 'one tick was armed for the three');
    assert.equal(h.shown(), 1);
    const report = h.pacer.diagnostics();
    assert.equal(report.requests, 3);
    assert.equal(report.delivered, 1);
    assert.equal(report.coalesced, 2);
    assert.equal(report.intervals.count, 0, 'one delivery closes no interval');
});

test('a superseded frame is dropped rather than shown late', ()=>{
    const h = harness();
    let older = 0;
    let newer = 0;
    h.pacer.request(()=>older++);
    h.pacer.request(()=>newer++);
    h.refresh();
    assert.equal(older, 0);
    assert.equal(newer, 1, 'the newest frame is the one the display gets');
});

test('the distribution names the frames that took more than one refresh', ()=>{
    const h = harness();
    // Deliveries at 0, 16, 32, 65, 115 ms: two on time, one that slipped a
    // refresh, one past the 30 FPS floor the thresholds break the build at.
    [0, 16, 16, 33, 50].forEach(step=>{
        h.advance(step);
        h.pacer.request(h.show);
        h.refresh();
    });
    assert.equal(h.shown(), 5);
    const { intervals } = h.pacer.diagnostics();
    assert.equal(intervals.count, 4);
    assert.equal(intervals.minMs, 16);
    assert.equal(intervals.maxMs, 50);
    assert.deepEqual(intervals.periods, { 1: 2, 2: 1, 3: 1, '4+': 0 });
    assert.equal(intervals.slow, 1, 'the 50 ms gap is slower than the floor, the 33 ms one is not');
    assert.equal(intervals.meanMs, 115 / 4);
    assert.equal(intervals.fps, 1000 / (115 / 4));
    assert.equal(intervals.p50Ms, 16);
    assert.equal(intervals.p95Ms, 50);
    assert.equal(intervals.p99Ms, 50);
    assert.ok(intervals.deviationMs > 14 && intervals.deviationMs < 15,
        'an even 28.75 ms cadence would read zero; this one does not');
});

test('an even cadence has no variance to report', ()=>{
    const h = harness();
    for (let i = 0; i < 8; i++)
    {
        h.advance(i === 0 ? 0 : 16);
        h.pacer.request(h.show);
        h.refresh();
    }
    const { intervals } = h.pacer.diagnostics();
    assert.equal(intervals.deviationMs, 0);
    assert.equal(intervals.meanMs, 16);
    assert.deepEqual(intervals.periods, { 1: 7, 2: 0, 3: 0, '4+': 0 });
});

test('a scheduler that fires too soon re-arms instead of making anyone wait', ()=>{
    const h = harness({ minIntervalMs: 16 });
    h.pacer.request(h.show);
    h.refresh();
    assert.equal(h.shown(), 1, 'the first delivery has no interval to honour');

    h.advance(4);
    h.pacer.request(h.show);
    assert.equal(h.refresh(), 1);
    assert.equal(h.shown(), 1, 'too soon after the last one');
    assert.equal(h.pacer.diagnostics().heldTicks, 1);
    assert.equal(h.pacer.diagnostics().waiting, true, 'still waiting, and nobody is blocked on it');

    h.advance(20);
    assert.equal(h.refresh(), 1, 'the held tick armed the next one itself');
    assert.equal(h.shown(), 2);
    assert.equal(h.pacer.diagnostics().intervals.minMs, 24);
});

test('flush shows what is waiting now, and the refresh it beat finds nothing', ()=>{
    const h = harness();
    h.pacer.request(h.show);
    h.pacer.flush();
    assert.equal(h.shown(), 1);
    assert.equal(h.refresh(), 1);
    assert.equal(h.shown(), 1);
    assert.equal(h.pacer.diagnostics().idleTicks, 1);

    h.pacer.flush();
    assert.equal(h.shown(), 1, 'nothing waiting, nothing shown');
    assert.equal(h.pacer.diagnostics().idleTicks, 1, 'and a flush is not a wasted refresh');
});

test('the recent window bounds the distribution while the counters stay all-time', ()=>{
    const h = harness({ history: 2 });
    [0, 100, 10, 10, 10].forEach(step=>{
        h.advance(step);
        h.pacer.request(h.show);
        h.refresh();
    });
    const { intervals } = h.pacer.diagnostics();
    assert.equal(intervals.count, 4);
    assert.equal(intervals.maxMs, 100, 'the stall is remembered after it left the window');
    assert.equal(intervals.slow, 1);
    assert.deepEqual(intervals.periods, { 1: 3, 2: 0, 3: 0, '4+': 1 });
    assert.equal(intervals.meanMs, 10, 'while the window says the run recovered');
    assert.equal(intervals.p99Ms, 10);
});

test('an idle pacer reports numbers, not an empty distribution', ()=>{
    const pacer = createPacer({ now: ()=>0, schedule: ()=>undefined });
    assert.deepEqual(pacer.diagnostics(), {
        requests: 0,
        delivered: 0,
        coalesced: 0,
        idleTicks: 0,
        heldTicks: 0,
        waiting: false,
        intervals: {
            count: 0,
            minMs: 0,
            maxMs: 0,
            slow: 0,
            meanMs: 0,
            deviationMs: 0,
            p50Ms: 0,
            p95Ms: 0,
            p99Ms: 0,
            fps: 0,
            periodMs: 1000 / 60,
            floorMs: 1000 / 30,
            periods: { 1: 0, 2: 0, 3: 0, '4+': 0 },
        },
    });
});

test('the target rate shapes the buckets', ()=>{
    const h = harness({ targetFps: 30, floorFps: 15 });
    [0, 33, 66].forEach(step=>{
        h.advance(step);
        h.pacer.request(h.show);
        h.refresh();
    });
    const { intervals } = h.pacer.diagnostics();
    assert.equal(intervals.periodMs, 1000 / 30);
    assert.deepEqual(intervals.periods, { 1: 1, 2: 1, 3: 0, '4+': 0 },
        'a 66 ms gap is two refreshes at 30 FPS, not four at 60');
    assert.equal(intervals.slow, 0, 'and neither reaches a 15 FPS floor');
});
