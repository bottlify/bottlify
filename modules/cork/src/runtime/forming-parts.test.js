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
import { features as probeFeatures } from '../wasm/features.js';
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

/**
 * A store that answers at once, as a directory store in a worker does through its synchronous
 * handle (`getNow`).
 * @returns {import('../../../core/src/layers/cpu/engine.js').TranslationStore}
 */
function storeNow(){
    /** @type {Map<string, Uint8Array>} */
    const records = new Map();
    return {
        get: async key=>records.get(key) ?? null,
        getNow: key=>records.get(key) ?? null,
        put: async(key, bytes)=>{
            records.set(key, bytes);
        },
    };
}

for (const seed of [34, 35, 36])
{
    test(`a batch's lookups answered a record a call run as answered at once (seed ${seed})`,
        async()=>{
            const config = { worker: true, translators: 1, batchRegions: 4, maxBatchRegions: 4,
                bundleId: 'test' };
            const store = storeNow();
            const filled = await observe(seed, { ...config, store, holdMs: 0 });
            const whole = await observe(seed, { ...config, store, holdMs: 0 });
            const parts = await observe(seed, { ...config, store, ...ONE_A_CALL });
            assert.ok(!filled.runs.includes('untranslated'), 'every start translated');
            assert.equal(whole.lookedUpInPart, 0);
            assert.ok(whole.cacheHits > 0 && parts.cacheHits > 0, 'the store answered both');
            assert.ok(parts.lookedUpInPart > 0, 'answers read over several calls');
            assert.deepEqual(whole.runs, filled.runs);
            assert.deepEqual(parts.runs, filled.runs);
        });
}

for (const seed of [51, 52, 53])
{
    test(`a batch formed a region a call while another executor waits for this thread runs as`
        + ` one formed whole (seed ${seed})`, async()=>{
        const config = { worker: true, translators: 1, batchRegions: 4, maxBatchRegions: 4,
            holdMs: 0 };
        const whole = await observe(seed, config);
        const asked = await observe(seed, { ...config, awaited: ()=>true });
        assert.ok(!whole.runs.includes('untranslated'), 'every start translated');
        assert.equal(whole.answeredFirst, 0);
        assert.ok(asked.answeredFirst > 0 && asked.formedInPart > 0,
            'forming stopped at a region for the ask');
        assert.deepEqual(asked.runs, whole.runs);
    });
}

for (const seed of [54, 55])
{
    test(`a batch's lookups stopped for another executor's ask run as answered at once`
        + ` (seed ${seed})`, async()=>{
        const config = { worker: true, translators: 1, batchRegions: 4, maxBatchRegions: 4,
            bundleId: 'test', holdMs: 0 };
        const store = storeNow();
        const filled = await observe(seed, { ...config, store });
        const asked = await observe(seed, { ...config, store, awaited: ()=>true });
        assert.ok(asked.cacheHits > 0, 'the store answered');
        assert.ok(asked.lookedUpInPart > 0, 'answers read over several calls');
        assert.deepEqual(asked.runs, filled.runs);
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
    /** @type {((reason: string) => void) | null} */
    let lost = null;
    return {
        held,
        ready: ()=>answer?.({ ready: true }),
        lose: ()=>lost?.('gone'),
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
            onLost: (/** @type {(reason: string) => void} */ handler)=>{
                lost = handler;
            },
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

test('nothing is emitted here while the translator loads: the batch waits for it', async()=>{
    const config = { worker: true, translators: 0, batchRegions: 4, maxBatchRegions: 4,
        loadingShare: 1 };
    const starts = [0x2000, 0x3000, 0x4000];
    /** @param {ReturnType<typeof machine>} m */
    const translated = m=>starts.filter(at=>m.runtime.entryOf(at) >= 0).length;
    /** @param {ReturnType<typeof machine>} m */
    const lend = m=>{
        const loading = heldTranslator();
        m.runtime.attachTranslator?.(loading.adapter);
        starts.forEach((at, i)=>m.write(at, piece(i, 100, 3).code));
        for (const at of starts)
        {
            m.runtime.noteHot(at, 0, 2);
        }
        return loading;
    };
    const whole = machine({ ...config, holdMs: 0 });
    const held = machine(config);
    try
    {
        lend(whole);
        await turn();
        await whole.runtime.translatePending();
        assert.equal(translated(whole), starts.length, 'unbounded, one batch emitted here');
        const loading = lend(held);
        for (let i = 0; i < 40; i++)
        {
            await turn();
            await held.runtime.translatePending();
        }
        assert.equal(translated(held), 0, 'nothing emitted here');
        assert.ok(/** @type {any} */ (held.runtime.diagnostics()).formedWaiting > 0,
            'formed, and waiting');
        loading.ready();
        for (let i = 0; i < 200 && loading.held.length === 0; i++)
        {
            await turn();
        }
        assert.equal(loading.held.length, 1, 'the translator loaded takes the batch');
        assert.equal(loading.held[0].relink.jobs.length, starts.length);
    }
    finally
    {
        await whole.runtime.flush();
        await held.runtime.flush();
    }
});

test('with no translator left, a batch emitted here is one region', async()=>{
    const m = machine({ worker: true, translators: 0, batchRegions: 4, maxBatchRegions: 4 });
    const starts = [0x2000, 0x3000, 0x4000];
    const translated = ()=>starts.filter(at=>m.runtime.entryOf(at) >= 0).length;
    // Counted by module, each batch emitted here being one: a call that overdrew the
    // credit (`holdMs`) has the runtime call itself back once it is back, which may be
    // during a turn below, so the regions one of these calls finds new may be two batches.
    const batchesOfOne = ()=>{
        const { regions, modules } = /** @type {any} */ (m.runtime.diagnostics());
        return regions === modules;
    };
    try
    {
        const gone = heldTranslator();
        m.runtime.attachTranslator?.(gone.adapter);
        gone.lose();
        starts.forEach((at, i)=>m.write(at, piece(i, 100, 3).code));
        for (const at of starts)
        {
            m.runtime.noteHot(at, 0, 2);
        }
        for (let i = 0; i < 200 && translated() < starts.length; i++)
        {
            await turn();
            await m.runtime.translatePending();
            assert.ok(batchesOfOne(), 'a region a batch');
        }
        assert.equal(translated(), starts.length, 'each emitted here in a batch of its own');
    }
    finally
    {
        await m.runtime.flush();
    }
});

test('a batch\'s store hits start compiling their modules a share at a call', async()=>{
    const config = { worker: true, translators: 1, bundleId: 'test' };
    const store = memoryTranslationStore();
    const starts = [0x2000, 0x3000, 0x4000, 0x5000];
    /** @param {ReturnType<typeof machine>} m */
    const translated = m=>starts.every(at=>m.runtime.entryOf(at) >= 0);
    // Stored a region a batch: a module of its own each.
    const fill = machine({ ...config, store, batchRegions: 1, maxBatchRegions: 1, holdMs: 0 });
    try
    {
        await untilTranslatorsLoaded(fill, 1);
        starts.forEach((at, i)=>fill.write(at, piece(i, 100, 3).code));
        for (const at of starts)
        {
            fill.runtime.noteHot(at, 0, 2);
        }
        await translateUntil(fill, ()=>translated(fill));
        assert.ok(translated(fill), 'every start translated and stored');
    }
    finally
    {
        await fill.runtime.flush();
    }
    const m = machine({ ...config, store, batchRegions: 4, maxBatchRegions: 4, ...ONE_A_CALL });
    // The compiles started in one run of this thread, at most: the share a call allows.
    const compile = WebAssembly.compile;
    let inRun = 0;
    let most = 0;
    WebAssembly.compile = bytes=>{
        if (inRun++ === 0)
        {
            queueMicrotask(()=>{
                inRun = 0;
            });
        }
        most = Math.max(most, inRun);
        return compile(bytes);
    };
    try
    {
        await untilTranslatorsLoaded(m, 1);
        starts.forEach((at, i)=>m.write(at, piece(i, 100, 3).code));
        for (const at of starts)
        {
            m.runtime.noteHot(at, 0, 2);
        }
        await translateUntil(m, ()=>translated(m));
        assert.ok(translated(m), 'every start published from the store');
        assert.equal(/** @type {any} */ (m.runtime.diagnostics()).compiledApart, starts.length,
            'each hit\'s module compiled once');
        assert.equal(most, 1, 'a module started at a time');
    }
    finally
    {
        WebAssembly.compile = compile;
        await m.runtime.flush();
    }
});

/**
 * At `at`: mov ecx, n; L: mov eax, ecx; and eax, 1; call [TABLE + eax*4]; dec ecx; jnz L; hlt;
 * F: add edx, 1; ret; G: add edx, 3; ret -- an indirect call going to F and G in turn.
 * @param {number} at
 */
const callingLoop = at=>{
    const table = at + 0x100;
    const [f, g] = [at + 21, at + 25];
    const code = [0xb9, 0x40, 0x06, 0, 0, 0x89, 0xc8, 0x83, 0xe0, 0x01,
        0xff, 0x14, 0x85, table & 0xff, table >>> 8 & 0xff, table >>> 16 & 0xff, 0,
        0x49, 0x75, 0xf1, 0xf4, 0x83, 0xc2, 0x01, 0xc3, 0x83, 0xc2, 0x03, 0xc3];
    const slots = [f, g].flatMap(slot=>[slot & 0xff, slot >>> 8 & 0xff, slot >>> 16 & 0xff, 0]);
    return { code, table, slots, f, g };
};

test('regions formed again with their calls\' callees are formed a share at a call', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return; // no transfers, no calls sampled
    }
    // A call is due at its first sample, so both are due in one reading.
    const m = machine({ worker: true, translators: 1, callTargets: true, callReturn: false,
        predictAfter: 1, ...ONE_A_CALL });
    const starts = [0x2000, 0x3000];
    const reforms = ()=>/** @type {any} */ (m.runtime.diagnostics()).reforms;
    /** The loop at `at`, 1600 calls: F and G 800 times each. @param {number} at */
    const run = at=>{
        m.setReg(1, 0);
        m.setReg(2, 0);
        m.setReg(4, 0x80000);
        assert.equal(m.runtime.run(m.runtime.entryOf(at), 1_000_000).kind, 'halt');
        assert.equal(m.reg(2), 800 + 800 * 3);
    };
    try
    {
        await untilTranslatorsLoaded(m, 1);
        for (const at of starts)
        {
            const { code, table, slots, f, g } = callingLoop(at);
            m.write(at, code);
            m.write(table, slots);
            for (const hot of [f, g, at])
            {
                m.runtime.noteHot(hot, 0, 64);
            }
        }
        await translateUntil(m, ()=>starts.every(at=>m.runtime.entryOf(at) >= 0));
        assert.equal(reforms(), 0);
        let most = 0;
        for (let i = 0; i < 400 && reforms() < starts.length; i++)
        {
            starts.forEach(run);
            const before = reforms();
            await m.runtime.translatePending();
            most = Math.max(most, reforms() - before);
            await turn();
        }
        assert.equal(reforms(), starts.length, 'both regions formed again');
        assert.equal(most, 1, 'one a call');
        starts.forEach(run);
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
