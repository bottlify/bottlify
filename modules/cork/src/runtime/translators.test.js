/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Several translators to one runtime: each takes a batch of its own, so that
 * many are out at once, and what they publish runs as what one translator,
 * or none, publishes (the gate of the second path).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_VERSION, moduleDigest, packRegion, unpackRegion } from './cache.js';
import { relinkBatch } from './emit-built.js';
import { machine, observe, piece, translateUntil, untilTranslatorsLoaded }
    from '../testing/seeded-pieces.js';

test('three translators take a batch each, all out at once, and each is published', async()=>{
    // With forming unbounded: a first region formed on a cold start takes the
    // share (`holdMs`), and the asks after it wait for it to come back.
    const m = machine({ worker: true, translators: 3, batchRegions: 1, maxBatchRegions: 1,
        holdMs: 0 });
    try
    {
        await untilTranslatorsLoaded(m, 3);
        const starts = [0x2000, 0x3000, 0x4000];
        starts.forEach((at, i)=>m.write(at, piece(i, 100, 3).code));
        let most = 0;
        for (const at of starts)
        {
            m.runtime.noteHot(at, 0, 2);
            await m.runtime.translatePending();
            most = Math.max(most, /** @type {any} */ (m.runtime.diagnostics()).batchesOut);
        }
        assert.ok(most >= 2, `${most} batches out at once`);
        await translateUntil(m, ()=>starts.every(at=>m.runtime.entryOf(at) >= 0));
        for (const at of starts)
        {
            assert.ok(m.runtime.entryOf(at) >= 0, `${at.toString(16)} published`);
        }
    }
    finally
    {
        await m.runtime.flush();
    }
});

test('a candidate a batch out holds as a block is not formed again beside it', async()=>{
    const m = machine({ worker: true, translators: 2, batchRegions: 1, maxBatchRegions: 1 });
    try
    {
        await untilTranslatorsLoaded(m, 2);
        const { code, loop } = piece(1, 100, 3);
        m.write(0x2000, code);
        m.runtime.noteHot(0x2000, 0, 2);
        await m.runtime.translatePending();
        // The loop's head, met while the piece's region is with a translator.
        m.runtime.noteHot(0x2000 + loop, 0, 64);
        await m.runtime.translatePending();
        await translateUntil(m, ()=>m.runtime.entryOf(0x2000) >= 0);
        assert.ok(m.runtime.entryOf(0x2000 + loop) >= 0, 'the head is an entry of the region');
        assert.equal(m.runtime.diagnostics().regions, 1, 'the head is not a region of its own');
    }
    finally
    {
        await m.runtime.flush();
    }
});

// The gate: seeded programs translated inline, by one translator, and by three
// with their batches out at once run alike, start by start.
for (const seed of [11, 12, 13, 14])
{
    test(`what three translators publish runs as what one and none publish (seed ${seed})`,
        async()=>{
            const { runs: inline } = await observe(seed, {});
            const { runs: one } = await observe(seed, { worker: true, translators: 1 });
            const { runs: three } = await observe(seed, { worker: true, translators: 3 });
            assert.ok(!inline.includes('untranslated'), 'inline translated every start');
            assert.deepEqual(one, inline, 'one translator');
            assert.deepEqual(three, inline, 'three translators');
        });
}

test('a module a translator answers is stored under what its bytes hash to, packed as here',
    async()=>{
        /** @type {Map<string, Uint8Array>} */
        const records = new Map();
        const store = {
            get: async(/** @type {string} */ key)=>records.get(key) ?? null,
            put: async(/** @type {string} */ key, /** @type {Uint8Array} */ bytes)=>{
                records.set(key, bytes);
            },
        };
        const m = machine({ worker: true, translators: 1, store, bundleId: 'test' });
        try
        {
            await untilTranslatorsLoaded(m, 1);
            const starts = [0x2000, 0x3000];
            starts.forEach((at, i)=>m.write(at, piece(i, 100, 3).code));
            for (const at of starts)
            {
                m.runtime.noteHot(at, 0, 2);
            }
            await translateUntil(m, ()=>starts.every(at=>m.runtime.entryOf(at) >= 0));
            const modules = [...records].filter(([key])=>key.includes('/module/'));
            assert.ok(modules.length > 0, 'a module stored');
            for (const [key, bytes] of modules)
            {
                const { module } = /** @type {any} */ (unpackRegion(bytes, CACHE_VERSION));
                assert.ok(key.endsWith(`/module/${moduleDigest(module)}`), key);
                assert.deepEqual(bytes, packRegion({ module, labels: [], cut: [], entryTop: 0,
                    instructions: 0 }, CACHE_VERSION));
            }
        }
        finally
        {
            await m.runtime.flush();
        }
    });

/**
 * A translator a test answers for: the batches posted to it, and the word it sends back.
 * @returns {{ adapter: import('./translator.js').WorkerAdapter, batches: any[],
 *     say: (data: any) => void, terminated: () => boolean }}
 */
function fakeTranslator(){
    /** @type {(data: any) => void} */
    let heard = ()=>{};
    /** @type {any[]} */
    const batches = [];
    let terminated = false;
    return {
        batches,
        say: data=>heard(data),
        terminated: ()=>terminated,
        adapter: {
            post(message){
                if (message.ready === true)
                {
                    setTimeout(()=>heard({ ready: true }), 0);
                    return;
                }
                batches.push(message);
            },
            onMessage(listener){ heard = listener; },
            onLost(){},
            terminate(){ terminated = true; },
        },
    };
}

/** @param {number} ms */
const later = ms=>new Promise(resolve=>setTimeout(resolve, ms));

test('a worker that says it goes on keeps its batch past the limit, and the answer is published',
    async()=>{
        // A worker short of a processor: its batch takes several limits' time, a word
        // before each region. Given up by when the batch went, its work was thrown
        // away and the next batch waited behind it, late in its turn - for ever.
        const m = machine({ worker: true, translators: 0, inFlightMs: 150 });
        const fake = fakeTranslator();
        try
        {
            m.runtime.attachTranslator?.(fake.adapter);
            m.write(0x2000, piece(1, 100, 3).code);
            m.runtime.noteHot(0x2000, 0, 2);
            while (fake.batches.length === 0)
            {
                await m.runtime.translatePending();
                await later(5);
            }
            const [{ id, relink, layout, features, options }] = fake.batches;
            for (let n = 0; n < 12; n++)
            {
                fake.say({ id, alive: 0 });
                await later(50);
                await m.runtime.translatePending();
            }
            assert.equal(m.runtime.diagnostics().refused['worker: no answer'], undefined,
                'six limits on, the batch is still its worker\'s');
            assert.equal(fake.batches.length, 1, 'and nothing was sent behind it');
            fake.say({ id, batch: relinkBatch(relink, layout, features, options), compiled: null });
            await translateUntil(m, ()=>m.runtime.entryOf(0x2000) >= 0);
            assert.ok(m.runtime.entryOf(0x2000) >= 0, 'published from the late answer');
            assert.ok(!fake.terminated());
        }
        finally
        {
            await m.runtime.flush();
        }
    });

test('a worker gone silent on a region loses its batch and goes; the region is not asked for again',
    async()=>{
        const m = machine({ worker: true, translators: 0, inFlightMs: 150 });
        const fake = fakeTranslator();
        try
        {
            m.runtime.attachTranslator?.(fake.adapter);
            m.write(0x2000, piece(1, 100, 3).code);
            m.write(0x3000, piece(2, 100, 3).code);
            m.runtime.noteHot(0x2000, 0, 2);
            while (fake.batches.length === 0)
            {
                await m.runtime.translatePending();
                await later(5);
            }
            const [{ id, relink }] = fake.batches;
            fake.say({ id, alive: 0 });
            // Nothing more from it: the limit, and the event loop round twice.
            for (let n = 0; n < 12 && !fake.terminated(); n++)
            {
                await later(50);
                await m.runtime.translatePending();
            }
            const d = /** @type {any} */ (m.runtime.diagnostics());
            assert.equal(d.refused['worker: no answer'], 1);
            assert.ok(fake.terminated(), 'the worker that answers no more is let go');
            const why = Object.keys(d.refusedWhy).find(key=>key.startsWith('worker: no answer'));
            assert.match(why ?? '', /a batch of 1 at 2000, silent at 2000/);
            assert.equal(relink.jobs[0].entry, 0x2000);
            // Its answer, should it come after all, is nobody's.
            assert.ok(m.runtime.entryOf(0x2000) < 0);
            // What is asked for next is emitted here: no translator is left.
            m.runtime.noteHot(0x3000, 0, 2);
            await translateUntil(m, ()=>m.runtime.entryOf(0x3000) >= 0);
            assert.ok(m.runtime.entryOf(0x3000) >= 0, 'translation goes on without it');
            m.runtime.noteHot(0x2000, 0, 64);
            await m.runtime.translatePending();
            await later(20);
            await m.runtime.translatePending();
            assert.ok(m.runtime.entryOf(0x2000) < 0, 'the region it stopped at stays out');
        }
        finally
        {
            await m.runtime.flush();
        }
    });
