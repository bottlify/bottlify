/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The bound on frames in flight, over a queue whose work finishes only when
 * the test says so: what a presenting call is told to wait on, and when that
 * wait ends.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDevice } from './fake-device.js';
import { DEFAULT_MAX_FRAME_LATENCY, createFrameLatency } from './latency.js';

/** Lets every settled promise's reactions run, and a few rounds of theirs. */
const drain = ()=>new Promise(resolve=>setImmediate(resolve));

/**
 * A queue that finishes work when told, and a frame that goes onto it at
 * each call -- the way a present's replay submits once it runs.
 */
function harness(limit = DEFAULT_MAX_FRAME_LATENCY){
    const gpu = createFakeDevice({ workDone: true });
    const latency = createFrameLatency({ queue: gpu.queue, limit, now: ()=>0 });
    return {
        gpu,
        latency,
        /** One frame submitted, then counted: what the presenting call is answered. */
        present(){
            gpu.queue.submit([]);
            return latency.queued();
        },
    };
}

/** @param {Promise<void> | null} held @returns {{ settled: boolean }} */
function watch(held){
    const state = { settled: false };
    held?.then(()=>{
        state.settled = true;
    });
    return state;
}

test('three frames in flight answer at once; the fourth waits for the oldest to finish',
    async()=>{
        const h = harness();
        assert.equal(h.present(), null);
        assert.equal(h.present(), null);
        assert.equal(h.present(), null);
        const fourth = h.present();
        assert.ok(fourth instanceof Promise, 'the fourth call is told to wait');
        const state = watch(fourth);
        await drain();
        assert.equal(state.settled, false, 'and waits while the device has done nothing');

        h.gpu.finish(1);
        await drain();
        assert.equal(state.settled, true, 'the oldest finishing lets it go');
        const fifth = watch(h.present());
        await drain();
        assert.equal(fifth.settled, false, 'three are in flight again, so the next one waits');
        h.gpu.finish(1);
        await drain();
        assert.equal(fifth.settled, true);
        h.gpu.finish();
        await drain();
        assert.equal(h.present(), null, 'and with the device caught up nothing waits');
    });

test('a frame counts from the call until the device finishes the work submitted with it',
    async()=>{
        // A replay reaches the queue after its pipelines exist, so the frames a
        // call counts may not be on the queue yet: what the device finishes
        // before them says nothing about them.
        const gpu = createFakeDevice({ workDone: true });
        const latency = createFrameLatency({ queue: gpu.queue, limit: 1, now: ()=>0 });
        const replay = ()=>{
            /** @type {() => void} */
            let submit = ()=>{};
            const submitted = new Promise(resolve=>{
                submit = ()=>{
                    gpu.queue.submit([]);
                    resolve(undefined);
                };
            });
            return { submitted, submit };
        };
        gpu.queue.submit([]);
        const first = replay();
        const second = replay();
        assert.equal(latency.queued(first.submitted), null);
        const state = watch(latency.queued(second.submitted));
        gpu.finish();
        await drain();
        assert.equal(state.settled, false,
            'the work before the frames finished, and neither frame is on the queue');

        first.submit();
        await drain();
        assert.equal(state.settled, false, 'the first on the queue, and not finished');
        gpu.finish(1);
        await drain();
        assert.equal(state.settled, true, 'the first finished, and the second may answer');
    });

test('a bound of zero, or a queue that cannot say when work is done, holds nothing',
    async()=>{
        const unbounded = harness(0);
        for (let frame = 0; frame < 20; frame++)
        {
            assert.equal(unbounded.present(), null);
        }
        await drain();
        assert.deepEqual(unbounded.latency.diagnostics(), {
            limit: 0, counting: true, inFlight: 20, peak: 20, frames: 20, held: 0, heldMs: 0,
            waiting: 0,
        }, 'the frames are still counted, so how far behind the device is can be read');

        const silent = createFrameLatency({ queue: createFakeDevice().queue });
        for (let frame = 0; frame < 20; frame++)
        {
            assert.equal(silent.queued(), null);
        }
        assert.equal(silent.diagnostics().counting, false);
        assert.equal(silent.diagnostics().frames, 0);
        assert.equal(createFrameLatency().queued(), null, 'nor does no queue at all');
    });

test('calls waiting at once go one at a time, oldest first, as the frames ahead finish',
    async()=>{
        // Two threads presenting, or two swap chains: one count, and each
        // call waits for the frames queued before its own.
        const h = harness(2);
        h.present();
        h.present();
        const third = watch(h.present());
        const fourth = watch(h.present());
        await drain();
        assert.deepEqual([third.settled, fourth.settled], [false, false]);
        h.gpu.finish(1);
        await drain();
        assert.deepEqual([third.settled, fourth.settled], [true, false]);
        h.gpu.finish(1);
        await drain();
        assert.deepEqual([third.settled, fourth.settled], [true, true]);
        assert.equal(h.latency.diagnostics().held, 2);
    });

test('a frame whose replay failed is finished as soon as that is known', async()=>{
    const h = harness(1);
    assert.equal(h.latency.queued(Promise.reject(new Error('the replay threw'))), null);
    const next = watch(h.present());
    await drain();
    assert.equal(next.settled, true, 'nothing of it will ever be on the queue to wait for');
});

test('a lost device, or a presenter that closes, lets every waiting call go', async()=>{
    const gpu = createFakeDevice({ workDone: true });
    /** @type {(info: any) => void} */
    let lose = ()=>{};
    const lost = new Promise(resolve=>{
        lose = resolve;
    });
    const latency = createFrameLatency({ queue: gpu.queue, limit: 1, lost, now: ()=>0 });
    gpu.queue.submit([]);
    latency.queued();
    const waiting = watch(latency.queued());
    await drain();
    assert.equal(waiting.settled, false);
    lose({ reason: 'unknown' });
    await drain();
    assert.equal(waiting.settled, true, 'a lost device may never say it finished');
    assert.equal(latency.queued(), null, 'and nothing is held after it');

    const closing = harness(1);
    closing.present();
    const held = watch(closing.present());
    closing.latency.close();
    await drain();
    assert.equal(held.settled, true);
    assert.equal(closing.present(), null);
});

test('the diagnostics say how far behind the device is and how often a call waited',
    async()=>{
        let clock = 0;
        const gpu = createFakeDevice({ workDone: true });
        const latency = createFrameLatency({ queue: gpu.queue, limit: 2, now: ()=>clock });
        for (let frame = 0; frame < 3; frame++)
        {
            gpu.queue.submit([]);
            latency.queued();
        }
        await drain();
        assert.deepEqual(latency.diagnostics(), {
            limit: 2, counting: true, inFlight: 3, peak: 3, frames: 3, held: 1, heldMs: 0,
            waiting: 1,
        });
        clock = 25;
        gpu.finish();
        await drain();
        assert.deepEqual(latency.diagnostics(), {
            limit: 2, counting: true, inFlight: 0, peak: 3, frames: 3, held: 1, heldMs: 25,
            waiting: 0,
        });
    });
