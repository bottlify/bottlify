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
import { Tables, ownLayout, pagesFor } from './layout.js';
import { createCorkRuntime } from './runtime.js';

/** @param {Record<string, unknown>} config */
function machine(config = {}){
    const layout = ownLayout({ ramSize: 4 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    view().setUint8(layout.x87Empty, 0xff);
    view().setUint16(layout.x87Control, 0x37f, true);
    const runtime = createCorkRuntime({
        memory, layout, config,
        read: address=>bytes()[layout.ramBase + address],
        imports: { trap: ()=>0, getEflags: ()=>view().getUint32(layout.eflags, true),
            x87Read: ()=>0, rdtsc: ()=>0n },
    });
    return {
        runtime,
        /** @param {number} at @param {number[]} code */
        write(at, code){
            bytes().set(code, layout.ramBase + at);
        },
        /** @param {number} index @param {number} value */
        setReg(index, value){
            view().setUint32(layout.regs + index * 4, value >>> 0, true);
        },
        /** @param {number} index */
        reg(index){
            return view().getUint32(layout.regs + index * 4, true);
        },
    };
}

/** @param {ReturnType<typeof machine>} m @param {number} count */
async function untilTranslatorsLoaded(m, count){
    for (let i = 0; i < 500; i++)
    {
        const d = m.runtime.diagnostics();
        if (/** @type {any} */ (d).translatorsReady === count)
        {
            return;
        }
        await new Promise(resolve=>setTimeout(resolve, 10));
    }
    assert.fail('the translators loaded');
}

/** @param {ReturnType<typeof machine>} m @param {() => boolean} done */
async function translateUntil(m, done){
    for (let i = 0; i < 400 && !done(); i++)
    {
        await m.runtime.translatePending();
        await new Promise(resolve=>setTimeout(resolve, 5));
    }
}

/**
 * mov eax, a; mov ecx, n; L: add eax, k; xor ebx, eax; dec ecx; jnz L; hlt
 * @param {number} a @param {number} n @param {number} k
 * @returns {{ code: number[], loop: number }}  loop: the offset of L
 */
function piece(a, n, k){
    const le = (/** @type {number} */ v)=>[v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff,
        (v >>> 24) & 0xff];
    const code = [0xb8, ...le(a), 0xb9, ...le(n), 0x05, ...le(k), 0x31, 0xc3, 0x49, 0x75, 0, 0xf4];
    // jnz back to L (offset 10): rel8 from the end of the jnz.
    code[code.length - 2] = (10 - (code.length - 1)) & 0xff;
    return { code, loop: 10 };
}

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

/** A small seeded generator (mulberry32). @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A seeded program of pieces, its starts and loop heads noted hot in a seeded
 * order and batch size, translated until every start has an entry; then each
 * start run from the same registers. What every run is observed to do.
 *
 * @param {number} seed @param {Record<string, unknown>} config
 */
async function observe(seed, config){
    const next = random(seed);
    const size = 1 + Math.floor(next() * 6);
    const m = machine({ batchRegions: size, maxBatchRegions: size, ...config });
    /** @type {{ at: number, loop: number }[]} */
    const pieces = [];
    for (let i = 0; i < 24; i++)
    {
        const at = 0x2000 + i * 0x40;
        const { code, loop } = piece(Math.floor(next() * 1e9), 1 + Math.floor(next() * 300),
            Math.floor(next() * 1e9));
        m.write(at, code);
        pieces.push({ at, loop: at + loop });
    }
    try
    {
        if (config.worker === true)
        {
            await untilTranslatorsLoaded(m, /** @type {number} */ (config.translators));
        }
        const noted = pieces.flatMap(({ at, loop })=>(next() < 0.5 ? [at, loop] : [at]))
            .sort(()=>next() - 0.5);
        for (const at of noted)
        {
            m.runtime.noteHot(at, 0, 2 + Math.floor(next() * 60));
            if (next() < 0.5)
            {
                await m.runtime.translatePending();
            }
        }
        await translateUntil(m, ()=>pieces.every(({ at })=>m.runtime.entryOf(at) >= 0));
        return pieces.map(({ at })=>{
            if (m.runtime.entryOf(at) < 0)
            {
                return 'untranslated';
            }
            for (let r = 0; r < 8; r++)
            {
                m.setReg(r, r === 4 ? 0x80000 : 0);
            }
            const exit = m.runtime.run(m.runtime.entryOf(at), 1_000_000);
            return [exit.kind, exit.retired, m.reg(0), m.reg(1), m.reg(3)].join(',');
        });
    }
    finally
    {
        await m.runtime.flush();
    }
}

// The gate: seeded programs translated inline, by one translator, and by three
// with their batches out at once run alike, start by start.
for (const seed of [11, 12, 13, 14])
{
    test(`what three translators publish runs as what one and none publish (seed ${seed})`,
        async()=>{
            const inline = await observe(seed, {});
            const one = await observe(seed, { worker: true, translators: 1 });
            const three = await observe(seed, { worker: true, translators: 3 });
            assert.ok(!inline.includes('untranslated'), 'inline translated every start');
            assert.deepEqual(one, inline, 'one translator');
            assert.deepEqual(three, inline, 'three translators');
        });
}
