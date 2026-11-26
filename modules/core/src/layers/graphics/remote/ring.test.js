/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND, createRingMemory, openRingIn, openRingOut } from './ring.js';
import { createReader } from './wire.js';

const NONE = ()=>undefined;

/**
 * A ring's two ends, what the reading end took kept as copies with their kind,
 * number and time, and where each body lay.
 *
 * @param {number} capacity @param {(kind: number) => boolean | void} [answer]
 */
function pair(capacity, answer = ()=>true){
    const memory = createRingMemory(capacity);
    const out = openRingOut(memory);
    /** @type {{ kind: number, bytes: Uint8Array, number: number, time: number, shared: boolean,
     *     start: number }[]} */
    const taken = [];
    const into = openRingIn(memory, (kind, buffer, start, length, number, time)=>{
        taken.push({ kind, bytes: new Uint8Array(buffer, start, length).slice(), number, time,
            shared: buffer === memory.data, start });
        return answer(kind);
    });
    return { memory, out, into, taken };
}

/** @param {number} length @param {number} seed */
const bytesOf = (length, seed)=>Uint8Array.from({ length }, (_, at)=>(at * 7 + seed) & 0xff);

/** Turns of the event loop: a wait for room settles on one. */
const turns = async(count = 4)=>{
    for (let turn = 0; turn < count; turn++)
    {
        await new Promise(resolve=>setImmediate(resolve));
    }
};

test('a batch is built where it is read, its bytes at a multiple of eight, and read in order',
    ()=>{
        const { out, into, taken } = pair(64 << 10);
        const reader = createReader({ ref: NONE, service: NONE });
        for (let batch = 0; batch < 40; batch++)
        {
            out.writer.value(new Float64Array([batch, batch / 2]), NONE);
            out.writer.value(`batch ${batch}`, NONE);
            assert.equal(out.writer.placed(), true, 'with room, the writer builds in the ring');
            out.publish(KIND.BATCH, 1000 + batch);
            into.drain();
        }
        assert.equal(taken.length, 40);
        assert.equal(out.figures().inPlace, 40);
        assert.equal(out.figures().copiedIn, 0, 'nothing was copied in');
        for (const [batch, record] of taken.entries())
        {
            assert.equal(record.shared, true);
            assert.equal(record.start % 8, 0);
            assert.equal(record.time, 1000 + batch);
            const values = [];
            const view = record.bytes;
            // The value's own Float64Array needs its eight-aligned place.
            values.push(reader.value(view.buffer, view.length));
            assert.deepEqual([...values[0]], [batch, batch / 2]);
        }
    });

test('a batch that outgrows its room goes on in the writer\'s own buffer and is copied in whole',
    ()=>{
        const { out, into, taken } = pair(64 << 10);
        // Half the ring at most is a record: 40 KiB fits none placed in the
        // 32 KiB the first reservation can give once something is held.
        out.writer.value(bytesOf(100, 1), NONE);
        out.publish(KIND.BATCH, 0);
        out.writer.value(bytesOf(20 << 10, 2), NONE);
        assert.equal(out.writer.placed(), true);
        out.writer.value(bytesOf(12 << 10, 3), NONE);
        assert.equal(out.writer.placed(), false, 'past its room, the batch left it');
        out.publish(KIND.BATCH, 0);
        into.drain();
        assert.equal(taken.length, 2);
        assert.equal(out.writer.figures().spilled, 1);
        assert.ok(out.figures().copiedIn > (32 << 10), 'the spilled batch was copied in');
        const reader = createReader({ ref: NONE, service: NONE });
        const view = taken[1].bytes;
        const first = reader.value(view.buffer, view.length);
        assert.deepEqual(first, bytesOf(20 << 10, 2));
    });

test('a batch longer than a record goes as parts and is read whole, in its own buffer', ()=>{
    const { out, into, taken } = pair(16 << 10);
    const long = bytesOf(50 << 10, 5);
    out.writer.value(long, NONE);
    out.publish(KIND.BATCH, 7);
    // A small ring: the parts wait for the reader's room, on the event loop.
    assert.ok(out.waiting() > 0);
    return (async()=>{
        for (let round = 0; round < 40 && out.waiting() > 0; round++)
        {
            into.drain();
            await turns(1);
        }
        into.drain();
        assert.equal(out.waiting(), 0);
        assert.equal(taken.length, 1, 'the parts are one record to the reader');
        assert.equal(taken[0].kind, KIND.BATCH);
        assert.equal(taken[0].time, 7);
        assert.equal(taken[0].shared, false);
        assert.ok(out.figures().parts >= 7);
        const reader = createReader({ ref: NONE, service: NONE });
        assert.deepEqual(reader.value(taken[0].bytes.buffer, taken[0].bytes.length), long);
    })();
});

test('what finds no room waits in order, every record after it behind it, and goes as room is made',
    async()=>{
        const { out, into, taken } = pair(8 << 10);
        for (let batch = 0; batch < 12; batch++)
        {
            out.writer.value(bytesOf(1500, batch), NONE);
            out.publish(KIND.BATCH, batch);
            if (batch === 6)
            {
                out.mark(99);
            }
        }
        assert.ok(out.waiting() > 0, 'the ring filled before the reader read');
        assert.equal(out.writer.placed(), false);
        for (let round = 0; round < 40 && (out.waiting() > 0 || taken.length < 13); round++)
        {
            into.drain();
            await turns(1);
        }
        assert.deepEqual(taken.map(record=>record.kind === KIND.MARK ? `mark ${record.number}`
            : record.time), [0, 1, 2, 3, 4, 5, 6, 'mark 99', 7, 8, 9, 10, 11]);
        const reader = createReader({ ref: NONE, service: NONE });
        for (const record of taken.filter(one=>one.kind === KIND.BATCH))
        {
            assert.deepEqual(reader.value(record.bytes.buffer, record.bytes.length),
                bytesOf(1500, record.time));
        }
        assert.ok(out.figures().waited > 0);
    });

test('a record held past its taking keeps its bytes, and nothing after it is read until it is given'
    + ' back', ()=>{
    let hold = true;
    const memory = createRingMemory(16 << 10);
    const out = openRingOut(memory);
    /** @type {Uint8Array[]} */
    const views = [];
    const into = openRingIn(memory, (kind, buffer, start, length)=>{
        views.push(new Uint8Array(buffer, start, length));
        if (hold)
        {
            hold = false;
            return false;
        }
        return true;
    });
    out.writer.value(bytesOf(3000, 1), NONE);
    out.publish(KIND.BATCH, 0);
    into.drain();
    const kept = views[0].slice();
    for (let batch = 2; batch < 10; batch++)
    {
        out.writer.value(bytesOf(3000, batch), NONE);
        out.publish(KIND.BATCH, 0);
    }
    assert.equal(into.drain(), 0, 'the held record stops the reading');
    assert.equal(views.length, 1);
    assert.deepEqual(views[0], kept, 'what was written after did not reach its bytes');
    into.resume();
    assert.ok(views.length > 1, 'given back, the records after it are read');
});

test('a close ends the reader\'s serving, once what was written before is read, and the writer\'s'
    + ' wait for room', async()=>{
    let held = 0;
    const { out, into, taken } = pair(4 << 10, ()=>held++ > 0);
    const served = into.serve();
    out.writer.value(bytesOf(1000, 1), NONE);
    out.publish(KIND.BATCH, 1);
    for (let batch = 2; batch < 6; batch++)
    {
        out.writer.value(bytesOf(1000, batch), NONE);
        out.publish(KIND.BATCH, batch);
    }
    await turns();
    assert.equal(taken.length, 1, 'held, the first stops the rest');
    assert.ok(out.waiting() > 0, 'the writer waits for room');
    out.close();
    into.resume();
    await served;
    assert.equal(out.closed(), true);
    assert.equal(into.closed(), true);
    assert.equal(out.waiting(), 0, 'what waited goes nowhere');
    out.writer.value(bytesOf(10, 1), NONE);
    out.publish(KIND.BATCH, 0);
    assert.equal(out.waiting(), 0, 'a batch after the close goes nowhere, quietly');
});
