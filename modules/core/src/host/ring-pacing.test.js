/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRingMemory } from '../system/ring.js';
import { createInboundReader, createInboundWriter } from './inbound.js';
import { IDLE_SLEEP_MS, ringPacing } from './ring-pacing.js';

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
        const { memory, pacing, macrotasks } = pacingOver(received);
        const writer = new Worker(`
            const { workerData } = require('node:worker_threads');
            import(workerData.inbound).then(({ createInboundWriter })=>{
                const ring = createInboundWriter(workerData.memory);
                setTimeout(()=>ring.send({ type: 'input', event: { kind: 'key', code: 'KeyQ' } },
                    ()=>{ throw new Error('posted'); }), 20);
            });`, { eval: true, workerData: {
            inbound: new URL('./inbound.js', import.meta.url).href, memory } });
        const started = performance.now();
        let rounds = 0;
        while (received.length === 0 && rounds++ < 1000)
        {
            await pacing.wait(idle);
        }
        const waited = performance.now() - started;
        assert.deepEqual(received, [{ type: 'input', event: { kind: 'key', code: 'KeyQ' } }]);
        assert.ok(waited < 20 + IDLE_SLEEP_MS * 2, `woken in ${waited.toFixed(1)} ms`);
        assert.ok(pacing.counts().woken >= 1, JSON.stringify(pacing.counts()));
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
    assert.ok(slept >= 14 && slept < IDLE_SLEEP_MS, `${slept.toFixed(1)} ms`);
    createInboundWriter(memory).send({ type: 'visibility', hidden: true }, ()=>{});
    const again = performance.now();
    pacing.wait({ ...idle, deadlineMs: 1000 });
    assert.ok(performance.now() - again < 10, 'the record was there: no sleep');
    assert.deepEqual(received, [{ type: 'visibility', hidden: true }]);
});

test('with a host answer outstanding the wait stays on the event loop and ends with it',
    { timeout: 5000 }, async()=>{
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
        setTimeout(answer, 5);
        const started = performance.now();
        await pacing.wait({ ...idle, deadlineMs: 5000, wakes: [answered] });
        assert.ok(performance.now() - started < 1000, 'the answer ended it, not the deadline');
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
        await pacing.yield({ ...quiet, fetching: 1 });
        assert.equal(macrotasks(), 2, 'a fetch in flight is answered on the event loop');
    });
