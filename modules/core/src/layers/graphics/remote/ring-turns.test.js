/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The thread's turns, as `scheduler.yield` hands them out: each a promise the
 * test settles, so what happens between two is the test's to see. Set before
 * the ring is loaded, which takes the scheduler it finds.
 *
 * @type {(() => void)[]}
 */
const turns = [];
/** @type {any} */ (globalThis).scheduler = {
    yield: ()=>new Promise(resolve=>turns.push(()=>resolve(undefined))),
};
const { KIND, createRingMemory, openRingIn, openRingOut } = await import('./ring.js');

/** Lets every promise settled so far run its reactions. */
const settled = async()=>{
    for (let round = 0; round < 8; round++)
    {
        await undefined;
    }
};

test('a ring served takes one record a task: the thread\'s other tasks run between two, and no'
    + ' turn is waited for after the last', async t=>{
    const memory = createRingMemory(64 << 10);
    const out = openRingOut(memory);
    // Open, a ring's waits keep the process alive: closed however the test ends.
    t.after(()=>{
        out.close();
        turns.splice(0).forEach(turn=>turn());
    });
    /** @type {number[]} */
    const taken = [];
    const into = openRingIn(memory, (kind, buffer, start, length, number, time)=>{
        taken.push(time);
    });
    for (let record = 1; record <= 3; record++)
    {
        out.writer.value(record, ()=>undefined);
        out.publish(KIND.BATCH, record);
    }
    const served = into.serve();
    await settled();
    assert.deepEqual(taken, [1], 'the first, then a turn of the thread');
    assert.equal(turns.length, 1);
    /** @type {() => void} */ (turns.shift())();
    await settled();
    assert.deepEqual(taken, [1, 2]);
    /** @type {() => void} */ (turns.shift())();
    await settled();
    assert.deepEqual(taken, [1, 2, 3]);
    assert.equal(turns.length, 0, 'nothing after the last: the ring\'s bell is waited on instead');
    out.close();
    await served;
});
