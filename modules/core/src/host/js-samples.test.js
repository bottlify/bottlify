/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsSampler, summarise } from './js-samples.js';

/**
 * One trace in the API's shape: `main` calls `sync` (twice sampled there),
 * `recurse` calls itself once, an anonymous function from no script, and a
 * sample taken with nothing on the stack.
 */
const TRACE = {
    resources: ['https://example.test/engine/app.js'],
    frames: [
        { name: 'main', resourceId: 0, line: 10 },
        { name: 'sync', resourceId: 0, line: 20 },
        { name: 'recurse', resourceId: 0, line: 30 },
        { name: '' },
    ],
    stacks: [
        { frameId: 0 },
        { frameId: 1, parentId: 0 },
        { frameId: 2, parentId: 0 },
        { frameId: 2, parentId: 2 },
        { frameId: 3, parentId: 0 },
    ],
    samples: [{ stackId: 1 }, { stackId: 1 }, { stackId: 3 }, { stackId: 4 }, {}],
};

test('self counts the leaf, total counts every function on the stack', ()=>{
    const { samples, functions } = summarise(TRACE, 10);

    assert.equal(samples, 4, 'the sample with no stack is not one of the thread\'s');
    assert.deepEqual(functions, [
        { name: 'sync app.js:20', self: 2, total: 2 },
        { name: 'recurse app.js:30', self: 1, total: 1 },
        { name: '(anonymous)', self: 1, total: 1 },
        { name: 'main app.js:10', self: 0, total: 4 },
    ]);
});

test('a function twice on one stack counts once in total', ()=>{
    // Counted per frame, `recurse` would read as on the stack in two samples
    // out of one -- a total above 100% of the time.
    const trace = { ...TRACE, samples: [{ stackId: 3 }] };

    const recurse = summarise(trace, 10).functions.find(row=>row.name.startsWith('recurse'));

    assert.deepEqual(recurse, { name: 'recurse app.js:30', self: 1, total: 1 });
});

test('only the top functions by self are kept, but every sample is counted', ()=>{
    const { samples, functions } = summarise(TRACE, 2);

    assert.equal(samples, 4);
    assert.deepEqual(functions.map(row=>row.name), ['sync app.js:20', 'recurse app.js:30']);
});

test('a trace with no samples answers none rather than failing', ()=>{
    assert.deepEqual(summarise({ ...TRACE, samples: [] }, 5), { samples: 0, functions: [] });
});

/**
 * A stand-in for the browser's `Profiler`: each instance remembers its options
 * and whether it was stopped, and answers `stop()` with `answer()`.
 *
 * @param {{ answer?: () => Promise<any>, refuse?: Error }} [behaviour]
 */
function fakeProfiler({ answer = ()=>Promise.resolve(TRACE), refuse } = {}){
    /** @type {{ options: any, stopped: boolean }[]} */
    const made = [];
    class Profiler {
        /** @param {any} options */
        constructor(options){
            if (refuse)
            {
                throw refuse;
            }
            this.options = options;
            this.stopped = false;
            made.push(this);
        }

        stop(){
            this.stopped = true;
            return answer();
        }
    }
    return { Profiler, made };
}

/** Lets the promise chain behind a window's end run, timers being mocked. */
const settle = ()=>new Promise(resolve=>setImmediate(resolve));

test('each window ends in a summary and the next window opens', async t=>{
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { Profiler, made } = fakeProfiler();
    let clock = 0;
    const sampler = createJsSampler({ windowMs: 100, sampleIntervalMs: 2, top: 3,
        Profiler, now: ()=>clock });
    t.after(sampler.stop);

    assert.deepEqual(sampler.snapshot(),
        { measured: false, reason: 'the first window has not ended yet' });
    assert.equal(made.length, 1);
    // A buffer for twice the window's samples, so a late timer loses nothing.
    assert.deepEqual(made[0].options, { sampleInterval: 2, maxBufferSize: 100 });

    clock = 104;
    t.mock.timers.tick(100);
    await settle();

    const first = sampler.snapshot();
    assert.equal(first.measured, true);
    assert.equal(first.measured && first.windowMs, 104);
    assert.equal(first.measured && first.samples, 4);
    assert.equal(first.measured && first.functions.length, 3);
    assert.equal(made[0].stopped, true);
    assert.equal(made.length, 2, 'the next window has opened');

    clock = 204;
    t.mock.timers.tick(100);
    await settle();

    assert.equal(made.length, 3);
    assert.equal(made[1].stopped, true);
});

test('a sampler the runtime refuses answers measured: false with the reason', async t=>{
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { Profiler, made } = fakeProfiler({
        refuse: new Error('Document-Policy js-profiling is not enabled') });
    const sampler = createJsSampler({ windowMs: 100, Profiler });
    t.after(sampler.stop);

    assert.deepEqual(sampler.snapshot(), { measured: false,
        reason: 'the sampler was refused: Document-Policy js-profiling is not enabled' });

    t.mock.timers.tick(1000);
    await settle();
    assert.equal(made.length, 0, 'a refused sampler is not asked again every window');
});

test('a runtime with no sampler says so', ()=>{
    const sampler = createJsSampler({ Profiler: undefined });

    assert.deepEqual(sampler.snapshot(),
        { measured: false, reason: 'this runtime has no JS Self-Profiling API' });
    sampler.stop();
});

test('a window whose trace fails says so, and the next window still opens', async t=>{
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { Profiler, made } = fakeProfiler({
        answer: ()=>Promise.reject(new Error('buffer lost')) });
    const sampler = createJsSampler({ windowMs: 100, Profiler });
    t.after(sampler.stop);

    t.mock.timers.tick(100);
    await settle();

    assert.deepEqual(sampler.snapshot(),
        { measured: false, reason: 'the sampler failed: buffer lost' });
    assert.equal(made.length, 2);
});

test('stop() stops the running sampler and opens no further window', async t=>{
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { Profiler, made } = fakeProfiler();
    const sampler = createJsSampler({ windowMs: 100, Profiler });

    sampler.stop();
    assert.equal(made[0].stopped, true, 'the browser\'s sampler would otherwise run on');

    t.mock.timers.tick(1000);
    await settle();
    assert.equal(made.length, 1);
    assert.deepEqual(sampler.snapshot(),
        { measured: false, reason: 'the first window has not ended yet' });
});
