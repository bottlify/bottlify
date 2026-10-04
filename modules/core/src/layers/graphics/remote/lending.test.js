/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { LEND, LEND_SLOTS, STASH_BYTES, createBorrower, createLender,
    createLendingBuffers, mayWait } from './lending.js';

/** A lender and a borrower over one memory, on this thread. */
function pair(){
    const buffers = createLendingBuffers();
    const memory = new Uint8Array(new SharedArrayBuffer(1 << 16));
    const lender = createLender({ ...buffers, memory });
    const borrow = createBorrower({ ...buffers, memory });
    /** @param {number} slot @param {number} address @param {number} length */
    const read = (slot, address, length)=>{
        /** @type {number[]} */
        let seen = [];
        borrow(slot, address, length, bytes=>{
            seen = [...bytes];
        });
        return seen;
    };
    return { buffers, memory, lender, read };
}

test('a thread that may block can lend', ()=>{
    assert.equal(mayWait(), true);
});

test('a lend the played side reads first is read in place, and a claim after it costs nothing',
    ()=>{
        const { memory, lender, read } = pair();
        memory.set([1, 2, 3, 4], 0x100);
        const slot = lender.lend(0x100, 4);
        assert.ok(slot >= 0);
        assert.deepEqual(read(slot, 0x100, 4), [1, 2, 3, 4]);
        lender.claim(0x100, 4);
        memory.set([9, 9, 9, 9], 0x100);
        assert.equal(lender.diagnostics().stashed, 0);
        assert.equal(lender.diagnostics().waited, 0);
    });

test('a lend claimed before the played side reads it is read as it was at the lend', ()=>{
    const { memory, lender, read } = pair();
    memory.set([1, 2, 3, 4], 0x100);
    const slot = lender.lend(0x100, 4);
    lender.claim(0x102, 8);
    memory.set([9, 9, 9, 9], 0x100);
    assert.deepEqual(read(slot, 0x100, 4), [1, 2, 3, 4]);
    assert.deepEqual(lender.diagnostics(), { lent: 1, lentBytes: 4, stashed: 1,
        stashedBytes: 4, waited: 0, waitedMs: 0 });
});

test('a claim leaves the lends it does not overlap to be read in place', ()=>{
    const { memory, lender, read } = pair();
    memory.set([1, 2, 3, 4], 0x100);
    const slot = lender.lend(0x100, 4);
    lender.claim(0x104, 4);
    lender.claim(0x0fc, 4);
    memory.set([7, 7, 7, 7], 0x100);
    assert.deepEqual(read(slot, 0x100, 4), [7, 7, 7, 7]);
    assert.equal(lender.diagnostics().stashed, 0);
});

test('a range outside the memory the played side sees is not lent', ()=>{
    const { lender } = pair();
    assert.equal(lender.lend((1 << 16) - 2, 4), -1);
    assert.equal(lender.lend(0x100, 0), -1);
});

test('every slot taken, a lend waits for one the played side is done with', ()=>{
    const { lender, read } = pair();
    /** @type {number[]} */
    const slots = [];
    for (let index = 0; index < LEND_SLOTS; index++)
    {
        slots.push(lender.lend(0x100, 4));
    }
    assert.equal(new Set(slots).size, LEND_SLOTS);
    assert.equal(lender.lend(0x100, 4), -1, 'none free: the bytes go as before');
    read(slots[7], 0x100, 4);
    assert.equal(lender.lend(0x100, 4), slots[7], 'the slot read is free again');
});

test('the stash gives back what the played side has read, and wraps round to it', ()=>{
    const { buffers, memory, lender, read } = pair();
    const states = new Int32Array(buffers.slots);
    const size = 1 << 12;
    const parts = STASH_BYTES / size;
    /** @param {number} value */
    const round = value=>{
        /** @type {number[]} */
        const slots = [];
        for (let index = 0; index < parts * 3 / 4; index++)
        {
            memory[0x1000] = value;
            const slot = lender.lend(0x1000, size);
            lender.claim(0x1000, 1);
            assert.equal(Atomics.load(states, slot * 2), LEND.STASHED);
            slots.push(slot);
        }
        for (const slot of slots)
        {
            assert.equal(read(slot, 0x1000, size)[0], value);
        }
    };
    round(1);
    round(2);
    round(3);
    assert.equal(lender.diagnostics().stashed, 3 * parts * 3 / 4);
    assert.equal(lender.diagnostics().waited, 0);
});

test('a range larger than the stash, or than the room left in it, is not lent', ()=>{
    const buffers = createLendingBuffers();
    const memory = new Uint8Array(new SharedArrayBuffer(STASH_BYTES + (1 << 16)));
    const lender = createLender({ ...buffers, memory });
    assert.equal(lender.lend(0, STASH_BYTES + 1), -1);
    assert.ok(lender.lend(0, STASH_BYTES - 16) >= 0);
    assert.equal(lender.lend(0, 32), -1, 'the room is the first lend\'s until it is read');
    assert.ok(lender.lend(0, 16) >= 0);
});

test('a claim on a lend the played side is reading waits for the read to finish', async()=>{
    const buffers = createLendingBuffers();
    const memory = new Uint8Array(new SharedArrayBuffer(1 << 16));
    memory.fill(5, 0, 4096);
    const thread = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const states = new Int32Array(workerData.slots);
        const memory = new Uint8Array(workerData.memory);
        parentPort.once('message', ({ slot, length })=>{
            // As createBorrower reads it in place, slowly.
            Atomics.compareExchange(states, slot * 2, 1, 2);
            parentPort.postMessage('reading');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
            const sum = memory.subarray(0, length).reduce((a, b)=>a + b, 0);
            Atomics.store(states, slot * 2, 3);
            Atomics.notify(states, slot * 2);
            parentPort.postMessage(sum);
        });
    `, { eval: true, workerData: { slots: buffers.slots, memory: memory.buffer } });
    const lender = createLender({ ...buffers, memory });
    const slot = lender.lend(0, 4096);
    /** @type {any[]} */
    const said = [];
    const reading = new Promise(done=>thread.once('message', done));
    thread.on('message', message=>said.push(message));
    thread.postMessage({ slot, length: 4096 });
    await reading;
    lender.claim(0, 1);
    memory.fill(0, 0, 4096);
    while (said.length < 2)
    {
        await new Promise(done=>setTimeout(done, 5));
    }
    assert.equal(said[1], 5 * 4096, 'the played side read the bytes of the lend');
    assert.equal(lender.diagnostics().waited, 1);
    assert.equal(lender.diagnostics().stashed, 0);
    await thread.terminate();
});
