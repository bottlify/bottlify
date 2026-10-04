/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
    createDoorbell, createRingMemory, doorbellOf, openRing, waitDoorbell,
} from './ring.js';

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
}

/** A record whose bytes say which it is: its number, then that number's low byte over and over. */
function record(/** @type {number} */ n, /** @type {number} */ length){
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length; at++)
    {
        bytes[at] = at < 4 ? (n >>> (at * 8)) & 0xff : (n + at) & 0xff;
    }
    return bytes;
}

test('records come out in order, whole, across every wrap, and a full ring refuses rather than'
    + ' overwrites', ()=>{
    for (let seed = 1; seed <= 50; seed++)
    {
        const next = random(seed);
        const ring = openRing(createRingMemory(256));
        /** @type {Uint8Array[]} */
        const queued = [];
        let sent = 0;
        for (let step = 0; step < 2000; step++)
        {
            if (next() < 0.55)
            {
                const length = Math.floor(next() * (ring.maxRecord + 1));
                const bytes = record(sent, length);
                if (ring.write(bytes))
                {
                    queued.push(bytes);
                    sent++;
                }
                else
                {
                    assert.ok(queued.length > 0, 'refused only while something is held');
                }
            }
            else
            {
                const got = ring.peek();
                const want = queued.shift();
                assert.deepEqual(got, want ?? null, `seed ${seed} step ${step}`);
                if (got)
                {
                    ring.release();
                }
            }
        }
        ring.drain(got=>assert.deepEqual(got, queued.shift()));
        assert.equal(queued.length, 0);
        assert.equal(ring.held(), 0);
    }
});

test('an empty record is a record, and one longer than half the ring is refused outright', ()=>{
    const ring = openRing(createRingMemory(64));
    assert.equal(ring.write(new Uint8Array(0)), true);
    assert.deepEqual(ring.peek(), new Uint8Array(0));
    ring.release();
    assert.equal(ring.peek(), null);
    assert.throws(()=>ring.write(new Uint8Array(ring.maxRecord + 1)), /longer than/);
});

test('the doorbell counts writes, and a wait on a stale count returns at once', ()=>{
    const ring = openRing(createRingMemory(64));
    const seen = doorbellOf(ring.bell);
    ring.write(Uint8Array.of(1));
    assert.equal(waitDoorbell(ring.bell, seen, 1000), 'not-equal',
        'a write between the look and the wait is not slept through');
    assert.equal(waitDoorbell(ring.bell, doorbellOf(ring.bell), 5), 'timed-out');
});

test('rings that share a doorbell wake their reader whichever is written', ()=>{
    const bell = createDoorbell();
    const first = openRing(createRingMemory(64, bell));
    const second = openRing(createRingMemory(64, bell));
    const seen = doorbellOf(bell);
    second.write(Uint8Array.of(2));
    assert.equal(waitDoorbell(bell, seen, 1000), 'not-equal');
    assert.equal(first.peek(), null);
    assert.deepEqual(second.peek(), Uint8Array.of(2));
});

/**
 * A worker running `body` with the ring memories, the module's URL as `ring`.
 *
 * @param {string} body  an async function's body, given `memory`, `memories` and the ring module
 * @param {any} data
 */
function inWorker(body, data){
    const source = `
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.ring).then(async(ringModule)=>{
            const run = async(memory, data, ring)=>{ ${body} };
            parentPort.postMessage(await run(workerData.memory, workerData.data, ringModule));
        });`;
    return new Worker(source, { eval: true,
        workerData: { ring: new URL('./ring.js', import.meta.url).href, memory: data.memory,
            data } });
}

test('a reader asleep on the doorbell is woken by each write from another thread, and reads all'
    + ' of them in order', { timeout: 30000 }, async()=>{
    const memory = createRingMemory(1024);
    const count = 20000;
    const reader = inWorker(`
        const r = ring.openRing(memory);
        let expected = 0;
        let sleeps = 0;
        while (expected < data.count)
        {
            const seen = ring.doorbellOf(r.bell);
            const took = r.drain(bytes=>{
                const n = bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24;
                if (n !== expected || bytes.length !== 4 + (n % 61))
                    throw new Error('out of order at ' + n);
                expected++;
            });
            if (took === 0)
            {
                sleeps++;
                if (ring.waitDoorbell(r.bell, seen, 5000) === 'timed-out')
                    throw new Error('lost a wake-up at ' + expected);
            }
        }
        return { expected, sleeps };`, { memory, count });
    /** @type {{ error: Error | null }} */
    const reading = { error: null };
    const result = new Promise((resolve, reject)=>{
        reader.once('message', resolve);
        reader.once('error', error=>{
            reading.error = error;
            reject(error);
        });
    });
    result.catch(()=>{});
    const writer = openRing(memory);
    for (let n = 0; n < count && !reading.error; n++)
    {
        const bytes = record(n, 4 + (n % 61));
        while (!writer.write(bytes) && !reading.error)
        {
            // The reader is behind: the page's side would wait on the ring's
            // room word; this thread may not block, so it yields instead.
            await new Promise(resolve=>setImmediate(resolve));
        }
        if (n % 1000 === 0)
        {
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
    }
    const { expected, sleeps } = /** @type {any} */ (await result);
    assert.equal(expected, count);
    assert.ok(sleeps > 0, 'the reader did sleep on the doorbell');
    await reader.terminate();
});

test('a writer that may block waits for the reader to make room, and gives up after its time',
    { timeout: 30000 }, async()=>{
        const memory = createRingMemory(64);
        const writer = inWorker(`
        const w = ring.openRing(memory);
        const bytes = new Uint8Array(w.maxRecord);
        let written = 0;
        for (let n = 0; n < 50; n++)
        {
            if (!w.writeWaiting(bytes, 5000)) throw new Error('timed out at ' + n);
            written++;
        }
        const late = w.write(bytes) && w.write(bytes) && w.writeWaiting(bytes, 20);
        return { written, late };`, { memory });
        const result = new Promise((resolve, reject)=>{
            writer.once('message', resolve);
            writer.once('error', reject);
        });
        const reader = openRing(memory);
        let read = 0;
        while (read < 50)
        {
            read += reader.drain(()=>{});
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
        const { written, late } = /** @type {any} */ (await result);
        assert.equal(written, 50);
        assert.equal(late, false, 'with nobody reading, a full ring times out');
        await writer.terminate();
    });
