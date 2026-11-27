/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The channel's wakes: a side ending its turn notifies only when the other
 * sleeps on the word (Cellar's bell, `Word.SLEEPING`), and no wake is lost for it --
 * two threads hand turns back and forth thousands of times, each always
 * sleeping, each never sleeping, and a mix, and every turn arrives. How long
 * a wait looks first follows the cores the slices out leave free (`lookFor`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { BELL_BYTES, BUSY_BESIDE, Bell, CHANNEL_BYTES, SPARE_SPIN_MS, SPIN_MS, Turn, Word,
    channelOf, lookFor } from './executor-channel.js';

const CHANNEL_URL = new URL('./executor-channel.js', import.meta.url).href;

/** The other side: answers each `RUN` with `DONE` and the value one more. */
const ANSWERER = `
import { workerData, parentPort } from 'node:worker_threads';
import { Turn, channelOf } from ${JSON.stringify(CHANNEL_URL)};
const channel = channelOf(workerData.buffer, null, workerData.spinMs);
for (let round = 0; round < workerData.rounds; round++)
{
    channel.await(Turn.DONE);
    channel.say(Turn.DONE, channel.value() + 1);
}
parentPort.postMessage({ ...channel.counts });
`;

/**
 * Hands `rounds` turns to a worker and back, each side looking `spinMs` before
 * it sleeps.
 *
 * @param {number} rounds @param {number} mineMs @param {number} theirsMs
 */
async function handTurns(rounds, mineMs, theirsMs){
    const buffer = new SharedArrayBuffer(CHANNEL_BYTES);
    const channel = channelOf(buffer, null, mineMs);
    Atomics.store(channel.words, Word.STATE, Turn.DONE);
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(ANSWERER)}`),
        { workerData: { buffer, rounds, spinMs: theirsMs } });
    const theirs = new Promise((resolve, reject)=>{
        worker.once('message', resolve);
        worker.once('error', reject);
    });
    const began = performance.now();
    for (let round = 0; round < rounds; round++)
    {
        channel.say(Turn.RUN, round);
        assert.equal(channel.await(Turn.RUN), Turn.DONE);
        assert.equal(channel.value(), round + 1, `round ${round}`);
    }
    const counts = /** @type {Record<string, number>} */ (await theirs);
    const elapsedMs = performance.now() - began;
    await worker.terminate();
    assert.equal(Atomics.load(channel.words, Word.SLEEPING), 0, 'no sleeper left counted');
    return { mine: channel.counts, theirs: counts, elapsedMs };
}

/**
 * What holds of a hand-over whatever the load: no side sleeps before it has
 * looked `…Ms` (so its sleeps fit in the time the run took), and no side
 * notifies the other more often than the other slept.
 *
 * @param {Awaited<ReturnType<typeof handTurns>>} run
 * @param {number} mineMs @param {number} theirsMs
 */
function assertLooksFirst(run, mineMs, theirsMs){
    const said = JSON.stringify(run);
    const unlooked = `a sleep with no look before it: ${said}`;
    if (mineMs > 0)
    {
        assert.ok(run.mine.slept <= run.elapsedMs / mineMs, unlooked);
    }
    if (theirsMs > 0)
    {
        assert.ok(run.theirs.slept <= run.elapsedMs / theirsMs, unlooked);
    }
    assert.ok(run.mine.woke <= run.theirs.slept, `a notify with nobody asleep: ${said}`);
    assert.ok(run.theirs.woke <= run.mine.slept, `a notify with nobody asleep: ${said}`);
}

test('a turn ended while the other side looks wakes nothing, and one it sleeps through wakes it',
    async()=>{
        // Both always asleep by their turn's end: every turn wakes the other,
        // or the hand-over would stop for good.
        const asleep = await handTurns(2000, 0, 0);
        assert.equal(asleep.mine.said, 2000);
        assert.equal(asleep.theirs.said, 2000);
        assert.ok(asleep.mine.slept > 0 && asleep.theirs.slept > 0, JSON.stringify(asleep));
        assert.ok(asleep.mine.woke > 0 && asleep.theirs.woke > 0, JSON.stringify(asleep));
        // Both looking for longer than the other takes. A side sleeps only
        // after a whole look of its own, and is notified only when it sleeps,
        // so however long a loaded machine keeps the other off its core -- a
        // look that runs out is a sleep it took fairly -- the sleeps are few
        // and each notify has a sleeper. A second, the longest look a wait
        // takes, is long past a hand-over.
        const awake = await handTurns(2000, 1000, 1000);
        assertLooksFirst(awake, 1000, 1000);
        // One sleeping, one looking: the sleeper is woken, the looker only
        // when a look of its own ran out.
        const mixed = await handTurns(2000, 1000, 0);
        assertLooksFirst(mixed, 1000, 0);
        assert.ok(mixed.mine.woke > 0, JSON.stringify(mixed));
    });

test('a wait looks long while the slices out leave a core free, briefly when they do not', ()=>{
    const bell = new Int32Array(new SharedArrayBuffer(BELL_BYTES));
    const look = lookFor(bell, 4);
    // Nothing out: the process's executor and the graphics worker on two of four.
    assert.equal(look(), SPARE_SPIN_MS);
    Atomics.store(bell, Bell.RUNNING, 4 - BUSY_BESIDE - 1);
    assert.equal(look(), SPARE_SPIN_MS, 'one core still free');
    Atomics.store(bell, Bell.RUNNING, 4 - BUSY_BESIDE);
    assert.equal(look(), SPIN_MS, 'every core taken');
    Atomics.store(bell, Bell.RUNNING, 0);
    // An unknown host looks briefly.
    assert.equal(lookFor(bell, undefined)(), SPIN_MS);
    assert.equal(lookFor(null, 16)(), SPIN_MS);
    // A machine of two cores has none to spare beside the two threads.
    assert.equal(lookFor(bell, 2)(), SPIN_MS);
});
