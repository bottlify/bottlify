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
function fakePool(perProcess = 4){
    let clock = 0;
    /** @type {{ posts: any[], busy: Int32Array | null, terminated: boolean }[]} */
    const workers = [];
    /** @type {Map<number, { lent: number[], recalled: number[] }>} */
    const seen = new Map();
    const pool = createTranslatorPool({
        perProcess,
        now: ()=>clock,
        windowMs: 1e9,
        open: async()=>{
            const worker = { posts: /** @type {any[]} */ ([]),
                busy: /** @type {Int32Array | null} */ (null), terminated: false };
            workers.push(worker);
            return {
                post: message=>{
                    worker.posts.push(message);
                    if (message.busy)
                    {
                        worker.busy = new Int32Array(message.busy.buffer);
                    }
                    message.serve?.close();
                },
                terminate: ()=>{
                    worker.terminated = true;
                },
            };
        },
    });
    /** @param {number} id */
    const add = id=>{
        const record = { lent: /** @type {number[]} */ ([]), recalled: /** @type {number[]} */ ([]) };
        seen.set(id, record);
        return pool.addProcess(id, {
            lend: (port, token)=>{
                port.close();
                record.lent.push(token);
            },
            recall: token=>record.recalled.push(token),
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
                // A region a millisecond of work: the regions grow as the work does.
                Atomics.add(busy, 0, Math.round(share * ms * 1000));
                Atomics.add(busy, 1, Math.round(share * ms));
            }
        });
        clock += ms;
        pool.tick();
        // A worker opened for a join is lent a turn later.
        await new Promise(resolve=>setImmediate(resolve));
    };
    return { pool, workers, seen, add, window };
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
