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
import { machine, observe, piece, translateUntil, untilTranslatorsLoaded }
    from '../testing/seeded-pieces.js';

test('three translators take a batch each, all out at once, and each is published', async()=>{
    const m = machine({ worker: true, translators: 3, batchRegions: 1, maxBatchRegions: 1 });
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
