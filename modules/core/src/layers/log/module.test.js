/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logModule } from './module.js';

/** @param {any} [config] */
async function open(config){
    let time = 0;
    // Both clocks, and deliberately the same one here: a journal entry is
    // stamped with guest time and a phase is measured against the host's, and
    // a test that could only move one of them could not check the other at all.
    const api = await logModule.create(
        { now: ()=>time, wallClock: ()=>time, ...config });
    return { api, at: (/** @type {number} */ to)=>{ time = to; return api; } };
}

test('the module keeps the contract it is registered under', ()=>{
    assert.equal(logModule.name, 'log');
    assert.deepEqual(logModule.requires, [], 'this layer depends on nothing');
    assert.equal(typeof logModule.diagnostics, 'function');
    assert.deepEqual(logModule.diagnostics().status, 'created');
});

test('configuration is data: levels by name, categories, sinks', async()=>{
    /** @type {any[]} */
    const seen = [];
    const { api } = await open({
        level: 'warn',
        categories: { cpu: 'trace' },
        sinks: [(/** @type {any[]} */ records)=>seen.push(...records)],
    });

    api.info('loader', 'too quiet for the default level');
    api.trace('cpu', 'kept: this category asked for everything');
    api.error('loader', 'kept: {0} is loud enough', 'error');
    api.flush();

    assert.deepEqual(seen.map(record=>record.text),
        ['kept: this category asked for everything', 'kept: error is loud enough']);
    assert.equal(api.levelOf('cpu'), api.Level.TRACE);

    await logModule.dispose();
});

test('a build with no clock says so instead of reporting plausible zeroes', async()=>{
    await logModule.create({});

    const diagnostics = logModule.diagnostics();
    assert.equal(diagnostics.status, 'ready');
    assert.deepEqual(diagnostics.issues, ['No clock was configured: timestamps and durations '
        + 'are all zero.']);

    await logModule.dispose();
});

test('diagnostics carry the share the thresholds watch', async()=>{
    const { api, at } = await open({});

    at(0).beginFrame();
    at(0).begin('present', api.PhaseKind.HOST);
    at(2).begin('run', api.PhaseKind.GUEST);
    at(18).end('run');
    at(20).end('present');
    at(100).endFrame();

    const metrics = logModule.diagnostics().metrics ?? {};
    assert.equal(metrics.frames, 1);
    assert.equal(metrics.hostShare, 0.04, 'four of a hundred milliseconds were ours');
    assert.equal(metrics.journal.capacity, 4096);
    assert.ok(metrics.topPhases[0].startsWith('run guest x1'));

    await logModule.dispose();
    assert.equal(logModule.diagnostics().status, 'created');
});

test('a phase is measured against the host clock, not the guest\'s', async()=>{
    // The guest's clock is credited in lumps from wall time as the scheduler
    // runs, so a phase measured against it reports what the guest was credited
    // rather than what the work cost. Read that way a run of ten minutes
    // reported sixty-eight milliseconds, and every question about where the
    // time went had no answer.
    let guest = 0;
    let wall = 0;
    const api = await logModule.create({ now: ()=>guest, wallClock: ()=>wall });

    api.beginFrame();
    api.begin('run', api.PhaseKind.GUEST);
    // A hundred milliseconds pass, and the guest is credited with one.
    wall = 100;
    guest = 1;
    api.end('run');
    api.endFrame();

    const [top] = logModule.diagnostics().metrics?.topPhases ?? [];
    assert.match(top, /^run guest x1 self=100\.000/, 'what it cost, not what was credited');
    await logModule.dispose();
});

test('with no clock given, phases are measured to better than a millisecond', async()=>{
    // `Date.now` moves in whole milliseconds, so a phase entered tens of
    // thousands of times reads as a column of zeroes and ones -- a distribution
    // rather than a measurement, and worst on the short phases that need it
    // most. Every environment this runs in has `performance.now`, so it is what
    // a build that configures nothing gets.
    const api = await logModule.create({ now: ()=>0 });

    api.begin('spin', api.PhaseKind.HOST);
    // Long enough to be measurable, far shorter than the tick `Date.now` moves
    // in: measured against that clock this is zero almost every time.
    const until = performance.now() + 0.2;
    while (performance.now() < until)
    {
        // Deliberately empty: the point is the wall time, not the work.
    }
    const elapsed = api.end('spin');

    assert.ok(elapsed > 0, `a fifth of a millisecond read as ${elapsed}`);
    assert.ok(!Number.isInteger(elapsed),
        'a whole number every time is the millisecond clock, not a measurement');
    await logModule.dispose();
});

test('the phase table is long enough to hold the loop and the calls together', async()=>{
    // The run loop alone opens ten or so phases per turn. A table cut to eight
    // rows shows those and nothing else -- or the host calls and none of the
    // loop -- and the question this instrument exists for is which of the two
    // the time went to.
    const { api, at } = await open({});
    for (let phase = 0; phase < 20; phase++)
    {
        at(phase * 10).begin(`phase-${phase}`, api.PhaseKind.HOST);
        at(phase * 10 + 5).end(`phase-${phase}`);
    }

    assert.equal((logModule.diagnostics().metrics?.topPhases ?? []).length, 16);
    await logModule.dispose();
});

test('a second instance in one realm does not take the first one\'s journal', async()=>{
    // A process replacement runs `create()` again in the same realm, and the
    // plan for two machines in one worker needs two instances live at once.
    // The journal belongs to the instance, so the first one's api keeps
    // writing to the first one's ring however many times create() runs after.
    const first = await open({});
    first.api.info('boot', 'the first instance');
    const second = await open({});
    second.api.info('boot', 'the second instance');
    first.api.info('boot', 'the first instance still');

    assert.deepEqual(first.api.recent().map((/** @type {any} */ record)=>record.text),
        ['the first instance', 'the first instance still']);
    assert.deepEqual(second.api.recent().map((/** @type {any} */ record)=>record.text),
        ['the second instance']);

    await logModule.dispose();
});

test('a disposed log accepts a write and does nothing', async()=>{
    // A host call that was in flight when the machine was disposed retires
    // afterwards and journals itself. The writer never waits and never throws,
    // and that has to hold once the instance is closed as well: a null
    // dereference here would take down the run the report was being written
    // about.
    const { api } = await open({});
    api.info('boot', 'before dispose');

    await logModule.dispose();

    assert.equal(api.enabled('boot', api.Level.INFO), false);
    assert.doesNotThrow(()=>api.write('info', 'boot', 'after dispose'));
    assert.deepEqual(api.recent(), []);
    assert.deepEqual(api.drain(0).records, []);
    assert.equal(logModule.diagnostics().status, 'created');
});

test('diagnostics still answers for the live instance', async()=>{
    const { api } = await open({});
    api.info('boot', 'one record');

    const diagnostics = logModule.diagnostics();
    assert.equal(diagnostics.status, 'ready');
    assert.equal(diagnostics.metrics?.journal.written, 1);

    await logModule.dispose();
});
