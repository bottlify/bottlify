/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslatorPool } from './pool.js';

/**
 * A pool over workers that are cells and records: the test says how busy each
 * was, and reads what the pool told the processes.
 */
function fakePool(perProcess = 4, extra = {}){
    let clock = 0;
    /** @type {{ posts: any[], busy: Int32Array | null, epoch: number, terminated: boolean }[]} */
    const workers = [];
    /** @type {Map<number, { lent: number[], recalled: number[] }>} */
    const seen = new Map();
    const pool = createTranslatorPool({
        perProcess,
        now: ()=>clock,
        windowMs: 1e9,
        driver: { trialWindows: 2 },
        ...extra,
        open: async()=>{
            const worker = { posts: /** @type {any[]} */ ([]),
                busy: /** @type {Int32Array | null} */ (null), epoch: 0, terminated: false };
            workers.push(worker);
            return {
                post: message=>{
                    worker.posts.push(message);
                    if (message.busy)
                    {
                        worker.busy = new Int32Array(message.busy.buffer);
                        worker.epoch = message.busy.epoch;
                    }
                    message.serve?.close();
                },
                terminate: ()=>{
                    worker.terminated = true;
                },
            };
        },
    });
    /** By process: the milliseconds it emitted on its own thread, as `demand` answers. */
    const demands = new Map();
    /** @param {number} id @param {boolean} [says]  whether it answers `demand` */
    const add = (id, says = false)=>{
        const record = { lent: /** @type {number[]} */ ([]), recalled: /** @type {number[]} */ ([]) };
        seen.set(id, record);
        demands.set(id, 0);
        return pool.addProcess(id, {
            lend: (port, token)=>{
                port.close();
                record.lent.push(token);
            },
            recall: token=>record.recalled.push(token),
            ...says ? { demand: ()=>demands.get(id) ?? 0 } : {},
        });
    };
    /**
     * A window of `ms` in which the workers of the process were busy for these
     * shares, in the order the pool lent them.
     * @param {number} ms @param {number[]} shares
     */
    const window = async(ms, shares)=>{
        const lent = workers.filter(one=>one.busy !== null);
        shares.forEach((share, i)=>{
            const busy = lent[i]?.busy;
            if (busy)
            {
                // Tenths of a millisecond; a region a millisecond of work.
                Atomics.add(busy, 0, Math.round(share * ms * 10));
                Atomics.add(busy, 1, Math.round(share * ms));
            }
        });
        clock += ms;
        pool.tick();
        // A worker opened for a join is lent a turn later.
        await new Promise(resolve=>setImmediate(resolve));
    };
    /**
     * A window in which each process's workers were busy for these shares, by
     * process, in the order the pool lent them to it.
     * @param {number} ms @param {Record<number, number[]>} byProcess
     */
    const windowOf = async(ms, byProcess)=>{
        for (const [id, shares] of Object.entries(byProcess))
        {
            const tokens = seen.get(Number(id))?.lent ?? [];
            const recalled = new Set(seen.get(Number(id))?.recalled ?? []);
            const live = tokens.filter(token=>!recalled.has(token));
            shares.forEach((share, i)=>{
                const busy = workers[workerOfToken(live[i])]?.busy;
                if (busy)
                {
                    Atomics.add(busy, 0, Math.round(share * ms * 10));
                    Atomics.add(busy, 1, Math.round(share * ms));
                }
            });
        }
        clock += ms;
        pool.tick();
        await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));
    };
    /** Which opened worker a token was lent through, by the order of the serve posts. */
    const workerOfToken = (/** @type {number | undefined} */ token)=>{
        if (token === undefined)
        {
            return -1;
        }
        // Each lend posts `serve` to its worker and then hands the process a token, one
        // after another: the token-th serve post is the token's worker.
        let n = 0;
        for (const [index, worker] of workers.entries())
        {
            for (const message of worker.posts)
            {
                if (message.serve && ++n === token)
                {
                    return index;
                }
            }
        }
        return -1;
    };
    return { pool, workers, seen, add, window, windowOf, demands };
}

test('a process is lent a worker at its start, and more while its workers are busy', async()=>{
    const { pool, seen, add, window } = fakePool();
    try
    {
        await add(1);
        assert.equal(seen.get(1)?.lent.length, 1, 'its first');
        await window(500, [0.95]);
        assert.equal(seen.get(1)?.lent.length, 2, 'a second joins at 95 %');
        await window(500, [0.9, 0.1]);
        assert.equal(seen.get(1)?.lent.length, 2, 'not at 90 % and 10 %');
        // The join's trial: two windows with both busy, emitting twice as much.
        await window(500, [0.9, 0.85]);
        await window(500, [0.9, 0.85]);
        assert.equal(seen.get(1)?.lent.length, 2, 'none joins while a join is weighed');
        await window(500, [0.9, 0.85]);
        assert.equal(seen.get(1)?.lent.length, 3);
        assert.deepEqual(pool.diagnostics().byProcess, { 1: 3 });
        // All idle: it waits, and the two that joined are asked back at once.
        await window(500, [0, 0, 0]);
        assert.equal(seen.get(1)?.recalled.length, 2);
        assert.deepEqual(pool.diagnostics().byProcess, { 1: 1 });
        assert.deepEqual(pool.diagnostics().journal.map(one=>one.kind),
            ['start', 'join', 'join', 'leave', 'leave']);
    }
    finally
    {
        pool.dispose();
    }
});

test('a worker given back is lent again before a new one is opened', async()=>{
    const { pool, workers, seen, add, window } = fakePool();
    try
    {
        await add(1);
        await window(500, [1]);
        await window(500, [0, 0]);
        assert.equal(workers.length, 2);
        await add(2);
        assert.equal(seen.get(2)?.lent.length, 1);
        assert.equal(workers.length, 2, 'the idle one went to the new process');
    }
    finally
    {
        pool.dispose();
    }
});

test('no more than perProcess for one process; a process\'s exit trims the idle ones', async()=>{
    const { pool, workers, seen, add, window } = fakePool(2);
    try
    {
        await add(1);
        await window(500, [1]);
        await window(500, [1, 1]);
        await window(500, [1, 1]);
        assert.equal(seen.get(1)?.lent.length, 2, 'two at most');
        pool.removeProcess(1);
        assert.equal(pool.diagnostics().workers, 1, 'one kept for the next process');
        assert.equal(workers.filter(one=>one.terminated).length, 1);
    }
    finally
    {
        pool.dispose();
    }
});

test('a batch under way counts in the window it runs in, not only once it is done', async()=>{
    const { pool, workers, seen, add, window } = fakePool();
    try
    {
        await add(1);
        // The first worker began a batch 280 ms ago, on the clock every thread shares,
        // and is still on it: the window it ran through was all work.
        await new Promise(resolve=>setTimeout(resolve, 300));
        const [first] = workers;
        const began = performance.timeOrigin + performance.now() - first.epoch - 280;
        Atomics.store(/** @type {Int32Array} */ (first.busy), 2, Math.round(began));
        await window(250, [0]);
        assert.equal(seen.get(1)?.lent.length, 2, 'it was busy: a second joins');
    }
    finally
    {
        pool.dispose();
    }
});

test('a process is lent its first worker past the run\'s capacity; none joins past it, and'
    + ' one joins again once the run has room', async()=>{
    const { pool, workers, seen, add, windowOf } = fakePool(4, { capacity: 2 });
    try
    {
        await add(1);
        await add(2);
        await add(3);
        assert.equal(workers.length, 3, 'a first for each: one waiting for a lend interprets');
        assert.deepEqual(pool.diagnostics().byProcess, { 1: 1, 2: 1, 3: 1 });
        assert.equal(pool.diagnostics().waiting, 0);
        await windowOf(500, { 1: [1], 2: [0], 3: [0] });
        await windowOf(500, { 1: [1], 2: [0], 3: [0] });
        assert.equal(seen.get(1)?.lent.length, 1, 'busy, and no worker joins past the capacity');
        pool.removeProcess(2);
        pool.removeProcess(3);
        assert.equal(pool.diagnostics().workers, 2, 'one in use and one sleeper');
        await windowOf(500, { 1: [1] });
        await windowOf(500, { 1: [1] });
        assert.equal(seen.get(1)?.lent.length, 2, 'the sleeper joins it');
        assert.equal(workers.length, 3, 'and none was opened for that');
    }
    finally
    {
        pool.dispose();
    }
});

test('a process idle past its rest gives back its first worker, sleepers past one are closed,'
    + ' and it is lent one again once it emits on its own thread', async()=>{
    const { pool, workers, seen, add, windowOf, demands } = fakePool(4,
        { capacity: 4, restAfterMs: 2000 });
    try
    {
        await add(1, true);
        await add(2, true);
        await add(3, true);
        assert.equal(workers.length, 3);
        // The first two wait on something; the third translates. Idle from the
        // first window's end, they rest 2 s after it.
        for (let n = 0; n < 5; n++)
        {
            await windowOf(500, { 1: [0], 2: [0], 3: [0.5] });
        }
        assert.equal(seen.get(1)?.recalled.length, 1, 'its first, after 2 s idle');
        assert.equal(seen.get(2)?.recalled.length, 1);
        assert.equal(seen.get(3)?.recalled.length, 0, 'the busy one keeps its');
        assert.deepEqual(pool.diagnostics().byProcess, { 1: 0, 2: 0, 3: 1 });
        assert.equal(workers.filter(one=>one.terminated).length, 1,
            'one sleeper kept, the other closed');
        assert.equal(pool.diagnostics().workers, 2);
        // Idle and saying nothing: no worker comes back.
        await windowOf(500, { 3: [0.5] });
        assert.equal(seen.get(1)?.lent.length, 1);
        // It emitted on its own thread: it wants one, and the sleeper is lent.
        demands.set(1, 40);
        await windowOf(500, { 3: [0.5] });
        assert.equal(seen.get(1)?.lent.length, 2, 'lent again');
        assert.equal(workers.length, 3, 'the sleeper, not a new one');
        assert.ok(pool.diagnostics().journal.some(one=>one.kind === 'rest'));
        assert.ok(pool.diagnostics().journal.some(one=>one.kind === 'lend'));
    }
    finally
    {
        pool.dispose();
    }
});

test('a process that cannot say what it emitted keeps its first worker', async()=>{
    const { pool, seen, add, windowOf } = fakePool(4, { restAfterMs: 1000 });
    try
    {
        await add(1);
        for (let n = 0; n < 6; n++)
        {
            await windowOf(500, { 1: [0] });
        }
        assert.equal(seen.get(1)?.recalled.length, 0);
    }
    finally
    {
        pool.dispose();
    }
});
