/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A batch formed over several calls (`holdMs`), the guest running between
 * them, and the store's hits compiled off the thread and published a few at a
 * call: what they publish runs as what a batch formed and published whole
 * publishes (the gate of the second path), and a region formed before the
 * guest wrote its code over is not what runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryTranslationStore } from './cache.js';
import { machine, observe, piece, translateUntil, untilTranslatorsLoaded }
    from '../testing/seeded-pieces.js';

/** A share no region fits in: every call forms one candidate and leaves the rest. */
const ONE_A_CALL = { holdMs: 1e-6 };

for (const seed of [21, 22, 23, 24])
{
    test(`a batch formed and published a region a call runs as one formed and published whole`
        + ` (seed ${seed})`, async()=>{
        const config = { worker: true, translators: 1, batchRegions: 4, maxBatchRegions: 4 };
        const whole = await observe(seed, { ...config, holdMs: 0 });
        const parts = await observe(seed, { ...config, ...ONE_A_CALL });
        assert.ok(!whole.runs.includes('untranslated'), 'every start translated');
        assert.equal(whole.formedInPart, 0);
        assert.ok(parts.formedInPart > 0, 'batches were formed over several calls');
        assert.ok(parts.publishedInPart > 0, 'translators\' answers published over several');
        assert.deepEqual(parts.runs, whole.runs);
    });
}

for (const seed of [31, 32, 33])
{
    test(`the store's hits compiled apart and published a few at a call run as published at`
        + ` once (seed ${seed})`, async()=>{
        const config = { worker: true, translators: 1, batchRegions: 4, maxBatchRegions: 4,
            bundleId: 'test' };
        const store = memoryTranslationStore();
        const filled = await observe(seed, { ...config, store, holdMs: 0 });
        const whole = await observe(seed, { ...config, store, holdMs: 0 });
        const parts = await observe(seed, { ...config, store, ...ONE_A_CALL });
        assert.ok(!filled.runs.includes('untranslated'), 'every start translated');
        assert.equal(whole.compiledApart, 0);
        assert.ok(whole.cacheHits > 0 && parts.cacheHits > 0, 'the store answered both');
        assert.ok(parts.compiledApart > 0, 'modules compiled off the thread');
        assert.ok(parts.publishedInPart > 0, 'hits published over several calls');
        assert.deepEqual(whole.runs, filled.runs);
        assert.deepEqual(parts.runs, filled.runs);
    });
}

for (const seed of [41, 42])
{
    test(`regions a relink moves a region a call run as moved at once (seed ${seed})`,
        async()=>{
            const config = { worker: true, translators: 1, batchRegions: 2, maxBatchRegions: 2,
                relinkAfter: 2, relinkRegions: 4 };
            const whole = await observe(seed, { ...config, holdMs: 0 });
            const parts = await observe(seed, { ...config, ...ONE_A_CALL });
            assert.ok(!whole.runs.includes('untranslated'), 'every start translated');
            assert.ok(whole.relinked > 0 && parts.relinked > 0, 'relinks moved regions');
            assert.deepEqual(parts.runs, whole.runs);
        });
}

/**
 * What a start runs to from cleared registers: its exit, retired count and registers.
 * @param {ReturnType<typeof machine>} m @param {number} at
 */
const runFrom = (m, at)=>{
    for (let r = 0; r < 8; r++)
    {
        m.setReg(r, r === 4 ? 0x80000 : 0);
    }
    const exit = m.runtime.run(m.runtime.entryOf(at), 1_000_000);
    return [exit.kind, exit.retired, m.reg(0), m.reg(1), m.reg(3)];
};

test('a region formed before the guest wrote its code over is not what runs', async()=>{
    const m = machine({ worker: true, translators: 1, batchRegions: 2, maxBatchRegions: 2,
        ...ONE_A_CALL });
    const written = piece(7, 50, 11).code;
    const reference = machine({});
    try
    {
        await untilTranslatorsLoaded(m, 1);
        m.write(0x2000, piece(1, 100, 3).code);
        m.write(0x3000, piece(2, 100, 5).code);
        // The hotter first, so it is the one formed before the write.
        m.runtime.noteHot(0x2000, 0, 64);
        m.runtime.noteHot(0x3000, 0, 2);
        await m.runtime.translatePending();
        assert.equal(/** @type {any} */ (m.runtime.diagnostics()).formedInPart, 1,
            'one formed, the other left');
        m.write(0x2000, written);
        await translateUntil(m, ()=>m.runtime.entryOf(0x3000) >= 0);
        assert.ok(m.runtime.entryOf(0x3000) >= 0, 'the batch was published');
        assert.ok(m.runtime.entryOf(0x2000) < 0, 'not the region of the bytes written over');
        m.runtime.noteHot(0x2000, 0, 64);
        await translateUntil(m, ()=>m.runtime.entryOf(0x2000) >= 0);

        reference.write(0x2000, written);
        reference.runtime.noteHot(0x2000, 0, 64);
        await reference.runtime.translatePending();
        assert.deepEqual(runFrom(m, 0x2000), runFrom(reference, 0x2000));
    }
    finally
    {
        await m.runtime.flush();
        await reference.runtime.flush();
    }
});

test('a batch left half formed is formed on with no further ask', async()=>{
    const m = machine({ worker: true, translators: 1, batchRegions: 3, maxBatchRegions: 3,
        ...ONE_A_CALL });
    try
    {
        await untilTranslatorsLoaded(m, 1);
        const starts = [0x2000, 0x3000, 0x4000];
        starts.forEach((at, i)=>m.write(at, piece(i, 100, 3).code));
        for (const at of starts)
        {
            m.runtime.noteHot(at, 0, 2);
        }
        await m.runtime.translatePending();
        // Only the event loop from here: the runtime calls itself back.
        for (let i = 0; i < 200 && !starts.every(at=>m.runtime.entryOf(at) >= 0); i++)
        {
            await new Promise(resolve=>setTimeout(resolve, 5));
        }
        assert.deepEqual(starts.map(at=>m.runtime.entryOf(at) >= 0), [true, true, true]);
        assert.equal(/** @type {any} */ (m.runtime.diagnostics()).formedInPart, 2);
    }
    finally
    {
        await m.runtime.flush();
    }
});

/**
 * A translator lent as a pool lends one, which says it is ready and then holds
 * every batch it is given: busy for as long as a test wants.
 */
function heldTranslator(){
    /** @type {any[]} */
    const held = [];
    /** @type {((data: any) => void) | null} */
    let answer = null;
    return {
        held,
        ready: ()=>answer?.({ ready: true }),
        adapter: {
            post: (/** @type {any} */ message)=>{
                if (message?.ready !== true)
                {
                    held.push(message);
                }
            },
            onMessage: (/** @type {(data: any) => void} */ handler)=>{
                answer = handler;
            },
            onLost: ()=>{},
            terminate: ()=>{},
        },
    };
}

const turn = ()=>new Promise(resolve=>setTimeout(resolve, 5));

test('a batch formed whole after the pool took its translator back waits for another one',
    async()=>{
        const m = machine({ worker: true, translators: 0, batchRegions: 2, maxBatchRegions: 2,
            ...ONE_A_CALL });
        const busy = heldTranslator();
        const taken = heldTranslator();
        try
        {
            m.runtime.attachTranslator?.(busy.adapter);
            busy.ready();
            m.runtime.attachTranslator?.(taken.adapter);
            taken.ready();
            [0x2000, 0x3000, 0x4000].forEach((at, i)=>m.write(at, piece(i, 100, 3).code));
            m.runtime.noteHot(0x2000, 0, 64);
            await m.runtime.translatePending();
            assert.equal(busy.held.length, 1, 'the first batch is with the first translator');
            m.runtime.noteHot(0x3000, 0, 2);
            m.runtime.noteHot(0x4000, 0, 2);
            const diagnostics = ()=>/** @type {any} */ (m.runtime.diagnostics());
            // Asked until the credit the first batch spent has come back.
            for (let i = 0; i < 200 && diagnostics().formedInPart === 0; i++)
            {
                await turn();
                await m.runtime.translatePending();
            }
            assert.equal(diagnostics().formedInPart, 1, 'one of the two formed');
            // The pool takes back the translator the batch was taken for, idle meanwhile.
            m.runtime.detachTranslator?.(taken.adapter);
            for (let i = 0; i < 200 && diagnostics().formedWaiting === 0; i++)
            {
                await turn();
                await m.runtime.translatePending();
            }
            assert.ok(diagnostics().formedWaiting > 0, 'formed whole, and waiting');
            assert.deepEqual([m.runtime.entryOf(0x3000), m.runtime.entryOf(0x4000)], [-1, -1],
                'not emitted on this thread');
            const lent = heldTranslator();
            m.runtime.attachTranslator?.(lent.adapter);
            lent.ready();
            for (let i = 0; i < 200 && lent.held.length === 0; i++)
            {
                await turn();
            }
            assert.equal(lent.held.length, 1, 'the translator lent next takes it');
            assert.equal(lent.held[0].relink.jobs.length, 2);
        }
        finally
        {
            await m.runtime.flush();
        }
    });

test('a batch formed whole while the only translator is replaced waits for the one loading',
    async()=>{
        const m = machine({ worker: true, translators: 0, batchRegions: 2, maxBatchRegions: 2,
            ...ONE_A_CALL });
        const first = heldTranslator();
        try
        {
            m.runtime.attachTranslator?.(first.adapter);
            first.ready();
            [0x3000, 0x4000].forEach((at, i)=>m.write(at, piece(i, 100, 3).code));
            m.runtime.noteHot(0x3000, 0, 2);
            m.runtime.noteHot(0x4000, 0, 2);
            const diagnostics = ()=>/** @type {any} */ (m.runtime.diagnostics());
            // Taken back right after the call that formed one of the two, before
            // the runtime's own call back forms the other.
            for (let i = 0; i < 200 && diagnostics().formedInPart === 0; i++)
            {
                await turn();
                await m.runtime.translatePending();
            }
            assert.equal(diagnostics().formedInPart, 1, 'one of the two formed');
            // The pool takes the idle translator back and lends another, still loading.
            m.runtime.detachTranslator?.(first.adapter);
            const next = heldTranslator();
            m.runtime.attachTranslator?.(next.adapter);
            for (let i = 0; i < 200 && diagnostics().formedWaiting === 0; i++)
            {
                await turn();
                await m.runtime.translatePending();
            }
            assert.ok(diagnostics().formedWaiting > 0, 'formed whole, and waiting');
            assert.deepEqual([m.runtime.entryOf(0x3000), m.runtime.entryOf(0x4000)], [-1, -1],
                'not emitted on this thread');
            next.ready();
            for (let i = 0; i < 200 && next.held.length === 0; i++)
            {
                await turn();
            }
            assert.equal(next.held.length, 1, 'the translator loaded takes it');
            assert.equal(next.held[0].relink.jobs.length, 2);
        }
        finally
        {
            await m.runtime.flush();
        }
    });

test('regions formed again with copies of their loops are formed a share at a call', async()=>{
    const m = machine({ worker: true, translators: 1, ...ONE_A_CALL });
    // mov ecx, 1000; L: call F; dec ecx; jnz L; hlt; F: inc edx; ret -- F is a block
    // of the loop, which the region is formed with no entry into.
    const loop = [0xb9, 0xe8, 0x03, 0, 0, 0xe8, 0x04, 0, 0, 0, 0x49, 0x75, 0xf8, 0xf4, 0x42, 0xc3];
    const starts = [0x2000, 0x3000];
    try
    {
        await untilTranslatorsLoaded(m, 1);
        for (const at of starts)
        {
            m.write(at, loop);
            m.runtime.noteHot(at, 0, 64);
        }
        await translateUntil(m, ()=>starts.every(at=>m.runtime.entryOf(at) >= 0));
        assert.deepEqual(starts.map(at=>m.runtime.entryOf(at + 14)), [-1, -1]);
        for (const at of starts)
        {
            for (let i = 0; i < 64; i++)
            {
                m.runtime.missAt?.(at + 14);
            }
        }
        const copied = ()=>/** @type {any} */ (m.runtime.diagnostics()).copied;
        for (let i = 0; i < 200 && copied() === 0; i++)
        {
            await turn();
            await m.runtime.translatePending();
        }
        assert.equal(copied(), 1, 'one formed again in the call that found the share spent');
        await translateUntil(m, ()=>starts.every(at=>m.runtime.entryOf(at + 14) >= 0));
        assert.equal(copied(), 2, 'and the other in a call after');
        for (const at of starts)
        {
            m.setReg(4, 0x80000);
            m.setReg(2, 0);
            assert.equal(m.runtime.run(m.runtime.entryOf(at), 1_000_000).kind, 'halt');
            assert.equal(m.reg(2), 1000);
        }
    }
    finally
    {
        await m.runtime.flush();
    }
});
