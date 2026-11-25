/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRingMemory } from '../../vendor/cellar/cellar.js';
import { createInboundReader, createInboundWriter } from './inbound.js';
import { ringPacing } from './ring-pacing.js';

/** @param {any[]} received */
function pacingOver(/** @type {any[]} */ received, deps = {}){
    const memory = createRingMemory(4096);
    let macrotasks = 0;
    const pacing = ringPacing({
        inbound: createInboundReader(memory, message=>received.push(message)),
        macrotask: ()=>{
            macrotasks++;
            return new Promise(resolve=>setImmediate(resolve));
        },
        now: ()=>performance.now(),
        intervalMs: 4,
        ...deps,
    });
    return { memory, pacing, macrotasks: ()=>macrotasks };
}

const idle = { timer: true, sleep: true, deadlineMs: null, wakes: [] };

test('an idle engine sleeps on the doorbell and a write from another thread wakes it at once',
    { timeout: 20000 }, async()=>{
        /** @type {any[]} */
        const received = [];
        // The sleeps begun, counted where the writer reads them: it writes once
        // the engine is on its second, whatever the machine's load, and the
        // doorbell's count read before that sleep ends it however the two
        // threads' steps fall.
        const asleep = new Int32Array(new SharedArrayBuffer(4));
        const { memory, pacing, macrotasks } = pacingOver(received, {
            /**
             * @param {import('../../vendor/cellar/cellar.js').Doorbell} bell
             * @param {number} seen @param {number} timeoutMs
             */
            sleep: (bell, seen, timeoutMs)=>{
                Atomics.add(asleep, 0, 1);
                Atomics.notify(asleep, 0);
                return bell.wait(seen, timeoutMs, 0);
            },
        });
        const writer = new Worker(`
            const { workerData } = require('node:worker_threads');
            import(workerData.inbound).then(({ createInboundWriter })=>{
                const ring = createInboundWriter(workerData.memory);
                while (Atomics.load(workerData.asleep, 0) < 2)
                {
                    Atomics.wait(workerData.asleep, 0, Atomics.load(workerData.asleep, 0), 1000);
                }
                ring.send({ type: 'input', event: { kind: 'key', code: 'KeyQ' } },
                    ()=>{ throw new Error('posted'); });
            });`, { eval: true, workerData: {
            inbound: new URL('./inbound.js', import.meta.url).href, memory, asleep } });
        while (received.length === 0)
        {
            await pacing.wait(idle);
        }
        assert.deepEqual(received, [{ type: 'input', event: { kind: 'key', code: 'KeyQ' } }]);
        // What says the doorbell woke it rather than the sleep's own bound
        // (IDLE_SLEEP_MS): the wait that saw the record ended before its time.
        // A clock would say the same only on a machine that is not busy.
        assert.ok(pacing.counts().woken >= 1, JSON.stringify(pacing.counts()));
        assert.ok(pacing.counts().slept > 1, 'it slept, on its bound, until the write');
        assert.equal(macrotasks(), 0, 'the event loop was not asked for anything');
        await writer.terminate();
    });

test('a timed sleep that ends a timer\'s grain late is learned, and the wait still ends at the'
    + ' deadline: the rest of it spun', ()=>{
    // Windows' timer: a blocking wait of 1 ms slept 8-15 ms, up to 29. A
    // process in a worker of its own whose program sleeps a millisecond at a
    // time fired its timers and its sound events that late, and the sound
    // thread fed a 20 ms buffer too late to keep it full.
    let clock = 0;
    /** @type {number[]} */
    const asked = [];
    const { pacing } = pacingOver([], {
        now: ()=>(clock += 0.05),
        /** @param {any} _bell @param {number} _seen @param {number} timeoutMs */
        sleep: (_bell, _seen, timeoutMs)=>{
            asked.push(timeoutMs);
            clock += timeoutMs + 12;
            return 'timed-out';
        },
    });
    /** @param {number} deadlineMs */
    const onClock = deadlineMs=>{
        const from = clock;
        pacing.wait({ ...idle, deadlineMs });
        return clock - from;
    };
    assert.ok(onClock(1) > 12, 'the first sleep finds the grain');
    assert.ok(onClock(2) <= 2.2, 'a deadline inside the grain is spun to');
    assert.deepEqual(asked, [1], 'with no sleep');
    assert.ok(onClock(40) <= 40.2, 'a longer one sleeps short of the deadline by the grain');
    assert.ok(asked[1] < 30, `asked ${asked[1]} ms`);
    assert.equal(pacing.counts().woken, 0);
});

test('a sleep ends at the guest\'s own deadline, and a message already written is read rather than'
    + ' slept through', ()=>{
    /** @type {any[]} */
    const received = [];
    const { memory, pacing } = pacingOver(received);
    const started = performance.now();
    pacing.wait({ ...idle, deadlineMs: 15 });
    const slept = performance.now() - started;
    assert.ok(slept >= 14, `${slept.toFixed(1)} ms: to the deadline, not short of it`);
    assert.equal(pacing.counts().woken, 0, 'the deadline ended it: nothing rang');
    createInboundWriter(memory).send({ type: 'visibility', hidden: true }, ()=>{});
    pacing.wait({ ...idle, deadlineMs: 1000 });
    assert.equal(pacing.counts().slept, 1, 'the record was there: no sleep');
    assert.deepEqual(received, [{ type: 'visibility', hidden: true }]);
});

test('with a host answer outstanding the wait stays on the event loop and ends with it',
    { timeout: 5000 }, async t=>{
        // The deadline's timer on a clock of the test's, never moved: what ends
        // the wait can only be the answer.
        t.mock.timers.enable({ apis: ['setTimeout'] });
        /** @type {any[]} */
        const received = [];
        /** @type {any[]} */
        const blocked = [];
        const { pacing } = pacingOver(received, { sleep: (/** @type {any[]} */ ...args)=>{
            blocked.push(args);
            return 'timed-out';
        } });
        /** @type {() => void} */
        let answer = ()=>{};
        /** @type {Promise<void>} */
        const answered = new Promise(resolve=>{
            answer = ()=>resolve();
        });
        let ended = false;
        const waiting = pacing.wait({ ...idle, deadlineMs: 5000, wakes: [answered] }).then(()=>{
            ended = true;
        });
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(ended, false, 'waiting on the event loop');
        answer();
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(ended, true, 'the answer ended it, not the deadline');
        await waiting;
        assert.deepEqual(blocked, [], 'the thread was never blocked while the event loop owed it');
    });

test('a thread still running gives the event loop a turn when the interval is up, and only then',
    async()=>{
        /** @type {any[]} */
        const received = [];
        let clock = 0;
        const { pacing, macrotasks } = pacingOver(received, { now: ()=>clock });
        const quiet = { suspended: 0, fetching: 0, idlers: 0, spun: 0 };
        assert.equal(pacing.yield(quiet), null);
        clock = 3;
        assert.equal(pacing.yield(quiet), null);
        clock = 5;
        await pacing.yield(quiet);
        assert.equal(macrotasks(), 1);
        assert.equal(pacing.yield({ ...quiet, fetching: 1 }), null,
            'a fetch in flight waits a millisecond while the thread still runs');
        clock = 6;
        await pacing.yield({ ...quiet, fetching: 1 });
        assert.equal(macrotasks(), 2, 'and is then answered on the event loop');
    });

test('with another machine on the thread an idle wait never blocks it: the other goes on',
    { timeout: 5000 }, async()=>{
        /** @type {any[]} */
        const received = [];
        /** @type {any[]} */
        const blocked = [];
        const { pacing } = pacingOver(received, { sleep: (/** @type {any[]} */ ...args)=>{
            blocked.push(args);
            return 'timed-out';
        } });
        pacing.machines?.(2);
        let other = 0;
        const beside = setInterval(()=>other++, 1);
        await pacing.wait({ ...idle, deadlineMs: 20 });
        clearInterval(beside);
        assert.deepEqual(blocked, [], 'the thread was never blocked');
        assert.ok(other > 0, 'the machine beside it had turns while it waited');
        pacing.machines?.(1);
        pacing.wait({ ...idle, deadlineMs: 1 });
        assert.equal(blocked.length, 1, 'alone again, it sleeps on the doorbell');
    });

test('a message posted to the thread is heard by its count: the yield is now, not when the'
    + ' interval is up, and an idle wait goes to the event loop rather than sleeping', async()=>{
    /** @type {any[]} */
    const received = [];
    /** @type {any[]} */
    const blocked = [];
    let clock = 0;
    const posted = { buffer: new SharedArrayBuffer(4), index: 0 };
    const { pacing, macrotasks } = pacingOver(received, { now: ()=>clock, posted,
        sleep: (/** @type {any[]} */ ...args)=>{
            blocked.push(args);
            return 'timed-out';
        } });
    const quiet = { suspended: 0, fetching: 0, idlers: 0, spun: 0 };
    assert.equal(pacing.yield(quiet), null, 'nothing posted, the interval not up');
    Atomics.add(new Int32Array(posted.buffer), 0, 1);
    await pacing.yield(quiet);
    assert.equal(macrotasks(), 1, 'a batch posted: the event loop has it now');
    assert.equal(pacing.yield(quiet), null, 'heard once');
    Atomics.add(new Int32Array(posted.buffer), 0, 1);
    await pacing.wait(idle);
    assert.equal(macrotasks(), 2);
    assert.deepEqual(blocked, [], 'not slept through');
    assert.equal(pacing.counts().heard, 2);
});

test('a wait on the event loop ends at the deadline by the doorbell wait\'s own timeout, with'
    + ' no timer beside it', { timeout: 5000 }, async()=>{
    // A setTimeout nested in the loop's turns is clamped to 4 ms and more:
    // a guest timer due in one woke two to five late a third of the time.
    /** @type {any[]} */
    const received = [];
    const { pacing } = pacingOver(received);
    pacing.machines?.(2);
    const timeouts = globalThis.setTimeout;
    let timers = 0;
    globalThis.setTimeout = /** @type {any} */ ((/** @type {any[]} */ ...args)=>{
        timers++;
        return /** @type {any} */ (timeouts)(...args);
    });
    // Node does not count a pending Atomics.waitAsync as work, so with
    // nothing else on the loop the test would end before the wait did; the
    // interval only keeps the loop open, and ends nothing.
    const open = setInterval(()=>{}, 1000);
    try
    {
        const from = performance.now();
        await pacing.wait({ ...idle, deadlineMs: 3 });
        const waited = performance.now() - from;
        assert.equal(timers, 0, 'no setTimeout');
        assert.ok(waited >= 2.5, `the deadline ended it, not sooner: ${waited.toFixed(1)} ms`);
    }
    finally
    {
        clearInterval(open);
        globalThis.setTimeout = timeouts;
        pacing.machines?.(1);
    }
});
