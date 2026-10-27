/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the run's sharing in shared memory (`shared-sharing.js`) beside
 * the one kept on a thread (`handles.js`'s `createSharing`): seeded programs of
 * opens, closes and questions down both, every answer compared; and threads
 * racing for one file on terms that share nothing, which only one may hold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createSharing, removal } from './handles.js';
import { SLOTS, createSharingMemory, openSharedSharing } from './shared-sharing.js';

/** @param {number} seed */
const random = seed=>{
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
};

/** Keys as the filesystem makes them, and two past what a slot holds whole. */
const KEYS = ['c::data\\pak0.pk4', 'c::data\\pak1.pk4', 'c:', 'c:a', 'd::save\\game.sav',
    `c::${'deep\\'.repeat(70)}one.txt`, `c::${'deep\\'.repeat(70)}two.txt`, 'c::Ā中.txt'];

/** @param {() => any} run */
const outcome = run=>{
    try
    {
        return ['ok', run()];
    }
    catch (e){
        return ['refused', /** @type {any} */ (e).code];
    }
};

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
{
    test(`seed ${seed}: the shared sharing answers every open, close and question as the`
        + ' sharing kept on a thread does', ()=>{
        const next = random(seed);
        const pick = (/** @type {any[]} */ from)=>from[Math.floor(next() * from.length)];
        const kept = createSharing();
        const shared = openSharedSharing(createSharingMemory());
        /** Each open held: its token in each. @type {{ kept: number, shared: number }[]} */
        const held = [];
        let refused = 0;
        for (let step = 0; step < 4000; step++)
        {
            const roll = next();
            if (roll < 0.5 || held.length === 0)
            {
                const key = pick(KEYS);
                const terms = { key, path: key,
                    access: { read: next() < 0.7, write: next() < 0.4, delete: next() < 0.25 },
                    share: { read: next() < 0.7, write: next() < 0.4, delete: next() < 0.5 },
                    inherited: next() < 0.05 };
                const one = outcome(()=>kept.admit(terms));
                const two = outcome(()=>shared.admit(terms));
                assert.equal(two[0], one[0], `step ${step}: admit ${JSON.stringify(terms)}`);
                assert.equal(two[0] === 'ok' ? null : two[1], one[0] === 'ok' ? null : one[1]);
                if (one[0] === 'ok')
                {
                    held.push({ kept: one[1], shared: two[1] });
                }
                else
                {
                    refused++;
                }
            }
            else if (roll < 0.85)
            {
                const open = held.splice(Math.floor(next() * held.length), 1)[0];
                kept.release(open.kept);
                shared.release(open.shared);
                if (next() < 0.1)
                {
                    // A close said twice: the slot may be another open's by now.
                    shared.release(open.shared);
                }
            }
            else if (roll < 0.93)
            {
                // What a rename or a deletion asks: settled, and let go at once.
                const key = pick(KEYS);
                const one = outcome(()=>kept.release(kept.admit(removal(key, key))));
                const two = outcome(()=>shared.release(shared.admit(removal(key, key))));
                assert.equal(two[0], one[0], `step ${step}: removal of ${key}`);
            }
            else
            {
                const key = pick(KEYS);
                assert.equal(shared.isOpen(key), kept.isOpen(key), `step ${step}: isOpen ${key}`);
            }
        }
        assert.ok(refused > 100, `the programs were refused ${refused} times`);
    });
}

test('a run holds as many opens at once as it has slots, and says so past that', ()=>{
    const shared = openSharedSharing(createSharingMemory());
    const terms = { key: 'c::a', path: 'a', access: { read: true, write: false },
        share: { read: true, write: true } };
    const tokens = Array.from({ length: SLOTS }, ()=>shared.admit(terms));
    assert.equal(new Set(tokens).size, SLOTS);
    assert.throws(()=>shared.admit(terms), { code: 'ACCESS_DENIED' });
    shared.release(tokens[17]);
    const again = shared.admit(terms);
    assert.notEqual(again, tokens[17], 'a slot used again is a new token');
    shared.release(tokens[17]);
    assert.equal(shared.isOpen('c::a'), true);
});

test('threads racing for a file on terms that share nothing: one holds it at a time',
    { timeout: 60000 }, async()=>{
        const memory = createSharingMemory();
        const holders = new Int32Array(new SharedArrayBuffer(8));
        const url = new URL('./shared-sharing.js', import.meta.url).href;
        const results = await Promise.all([0, 1, 2, 3].map(()=>new Promise((resolve, reject)=>{
            const worker = new Worker(`
                const { workerData, parentPort } = require('node:worker_threads');
                import(workerData.url).then(({ openSharedSharing })=>{
                    const sharing = openSharedSharing(workerData.memory);
                    const holders = new Int32Array(workerData.holders);
                    const terms = { key: 'c::save.sav', path: 'save.sav',
                        access: { read: true, write: true }, share: { read: false, write: false } };
                    let held = 0;
                    let overlaps = 0;
                    for (let tries = 0; tries < 20000; tries++)
                    {
                        let token;
                        try { token = sharing.admit(terms); } catch { continue; }
                        if (Atomics.add(holders, 0, 1) !== 0) overlaps++;
                        held++;
                        Atomics.sub(holders, 0, 1);
                        sharing.release(token);
                    }
                    parentPort.postMessage({ held, overlaps });
                }).catch(e=>parentPort.postMessage({ error: String(e && e.stack || e) }));`,
            { eval: true, workerData: { url, memory, holders: holders.buffer } });
            worker.once('message', message=>{
                worker.terminate();
                if (message.error)
                {
                    reject(new Error(message.error));
                }
                else
                {
                    resolve(message);
                }
            });
            worker.once('error', reject);
        })));
        for (const { held, overlaps } of /** @type {any[]} */ (results))
        {
            assert.equal(overlaps, 0);
            assert.ok(held > 0);
        }
        assert.equal(openSharedSharing(memory).isOpen('c::save.sav'), false);
    });
