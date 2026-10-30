/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRingMemory, waitDoorbell } from '../system/ring.js';
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
            sleep: (/** @type {Parameters<typeof waitDoorbell>} */ ...args)=>{
                Atomics.add(asleep, 0, 1);
                Atomics.notify(asleep, 0);
                return waitDoorbell(...args);
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
