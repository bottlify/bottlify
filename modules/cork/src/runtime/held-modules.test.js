/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The modules translated code is held in, by heat. Without tail calls into
 * another instance (`crossTailCalls`) the hottest regions of two full modules
 * crossing into each other are gathered into one (`gatherAfter`), and a relink
 * puts the regions run lately apart from the rest (`relinkCold`). Past a
 * ceiling (`cacheBytes`) the modules gone longest without running are let go
 * and brought back from the store when asked for. Each runs as the program
 * runs without it: the same registers and memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLayout, pagesFor, tablesSize } from './layout.js';
import { createCorkRuntime } from './runtime.js';
import { memoryTranslationStore } from './cache.js';
import { features as probeFeatures } from '../wasm/features.js';
import { random } from '../testing/seeded-pieces.js';

/** A machine of 4 MiB with cork's own layout and a runtime over it. @param {Record<string, unknown>} config */
function machine(config){
    const layout = ownLayout({ ramSize: 4 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
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
        /** @param {number} at @param {number} length */
        read(at, length){
            return [...bytes().subarray(layout.ramBase + at, layout.ramBase + at + length)];
        },
        /** @param {number} index @param {number} value */
        setReg(index, value){
            view().setUint32(layout.regs + index * 4, value >>> 0, true);
        },
        /** @param {number} index */
        reg(index){
            return view().getUint32(layout.regs + index * 4, true);
        },
        eip(){
            return view().getUint32(layout.eip, true);
        },
    };
}

/** @param {number} value */
const le32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** `call target` placed at `at`. @param {number} at @param {number} target */
const call = (at, target)=>[0xe8, ...le32(target - (at + 5))];
const turn = ()=>new Promise(resolve=>setTimeout(resolve, 5));
/** @param {ReturnType<typeof machine>} m */
const diagnostics = m=>/** @type {any} */ (m.runtime.diagnostics());

/**
 * Translates until the condition holds, the worker and the store answering on
 * their own turns.
 * @param {ReturnType<typeof machine>} m @param {() => boolean} done
 */
async function until(m, done){
    while (!done())
    {
        await m.runtime.translatePending();
        await turn();
    }
    assert.ok(done(), 'the translator answered');
}

/** @param {ReturnType<typeof machine>} m */
async function untilWorkerLoaded(m){
    while (diagnostics(m).worker !== 'ready')
    {
        await turn();
    }
    assert.equal(diagnostics(m).worker, 'ready', 'the worker loaded');
}

/**
 * Runs from `at` to its halt, as the engine's slices do: each exit entered
 * again where it left, an address with no entry translated first -- or
 * brought back from the store -- and the translator given its turn between
 * slices, where a module may be let go. What is held is read at each.
 *
 * @param {ReturnType<typeof machine>} m @param {number} at
 * @param {{ budget?: number, held?: number[] }} [options]  held: each slice's `heldBytes`
 */
async function runToHalt(m, at, { budget = 1_000_000, held } = {}){
    let eip = at;
    for (let slices = 0; slices < 1_000_000; slices++)
    {
        if (m.runtime.entryOf(eip) < 0)
        {
            m.runtime.noteHot(eip, 0, 64);
            await until(m, ()=>m.runtime.entryOf(eip) >= 0);
        }
        const exit = m.runtime.run(m.runtime.entryOf(eip), budget);
        if (exit.kind === 'halt')
        {
            return slices;
        }
        assert.ok(exit.kind === 'untranslated' || exit.kind === 'budget', exit.kind);
        eip = m.eip();
        if (held !== undefined)
        {
            await m.runtime.translatePending();
            held.push(diagnostics(m).heldBytes);
        }
    }
    assert.fail('the program halted');
}

test('two full modules crossing into each other have their hottest regions gathered into one,'
    + ' and the crossings stop', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return;
    }
    // A loop at LOOP calling F, each in a module of four with three stubs:
    // neither may take the other whole (`relinkRegions` 4), nor the region it
    // crosses into alone (both full), so no merge.
    const LOOP = 0x2000;
    const F = 0x3000;
    const DATA = 0x9000;
    const ROUND = 300_000;
    /** @param {Record<string, unknown>} config */
    const program = async config=>{
        const m = machine({ leafCalls: false, dispatch: true, worker: true, callReturn: false,
            crossTailCalls: false, batchRegions: 4, maxBatchRegions: 4, relinkRegions: 4,
            relinkAfter: 0, ...config });
        try
        {
            m.write(LOOP, [0xb9, ...le32(ROUND), ...call(LOOP + 5, F), 0x49, 0x75, 0xf8, 0xf4]);
            m.write(F, [0x42, 0x01, 0x15, ...le32(DATA), 0xc3]);
            const stubs = (/** @type {number} */ from)=>[0, 1, 2].map(i=>from + i * 0x10);
            for (const stub of [...stubs(LOOP + 0x100), ...stubs(F + 0x100)])
            {
                m.write(stub, [0xc3]);
            }
            await untilWorkerLoaded(m);
            for (const batch of [[F, ...stubs(F + 0x100)], [LOOP, ...stubs(LOOP + 0x100)]])
            {
                batch.forEach(at=>m.runtime.noteHot(at, 0, 64));
                await until(m, ()=>batch.every(at=>m.runtime.entryOf(at) >= 0));
            }
            assert.equal(diagnostics(m).relinked ?? 0, 0);
            /** @type {number[]} */
            const crossings = [];
            for (let round = 0; round < 3; round++)
            {
                const before = diagnostics(m).crossingsAll;
                m.setReg(4, 0x80000);
                await runToHalt(m, LOOP);
                crossings.push(diagnostics(m).crossingsAll - before);
                // The translator reads the crossings and, where it gathers,
                // the worker builds the module.
                for (let i = 0; i < 20; i++)
                {
                    await m.runtime.translatePending();
                    await turn();
                }
                if (round === 0 && config.gatherAfter !== 0)
                {
                    await until(m, ()=>(diagnostics(m).relinked ?? 0) >= 2);
                }
            }
            const d = diagnostics(m);
            return { crossings, gathers: d.gathers, gathered: d.gathered, merges: d.merges,
                state: [m.reg(0), m.reg(1), m.reg(2), m.reg(3), m.reg(4), ...m.read(DATA, 16)] };
        }
        finally
        {
            await m.runtime.flush();
        }
    };
    const gathered = await program({ gatherAfter: 1000 });
    const kept = await program({ gatherAfter: 0 });
    assert.deepEqual(gathered.state, kept.state, 'the same registers and memory');
    assert.equal(gathered.state[2], 3 * ROUND);
    assert.equal(kept.merges, 0, 'no merge joins two full modules');
    assert.deepEqual(kept.crossings, [2 * ROUND, 2 * ROUND, 2 * ROUND], 'each call and return');
    assert.equal(gathered.crossings[0], 2 * ROUND);
    assert.equal(gathered.gathers, 1);
    assert.equal(gathered.gathered, 2, 'the loop and its callee, not the stubs');
    assert.deepEqual(gathered.crossings.slice(1), [0, 0], 'the two in one module');
});

test('a relink puts the regions entered lately in one module and the rest in small ones',
    async()=>{
        if (!probeFeatures().tailCalls)
        {
            return;
        }
        // The loop and its callee each in a batch of its own with stubs never
        // run, eight regions in four batches: the relink after them puts the
        // two that ran into one module and the six stubs into three of two.
        const LOOP = 0x2000;
        const F = 0x3000;
        const m = machine({ leafCalls: false, dispatch: true, worker: true, callReturn: false,
            crossTailCalls: false, batchRegions: 2, maxBatchRegions: 2, relinkRegions: 8,
            relinkCold: 2, relinkAfter: 4, gatherAfter: 0, mergeAfter: 0 });
        try
        {
            m.write(LOOP, [0xb9, ...le32(1000), ...call(LOOP + 5, F), 0x49, 0x75, 0xf8, 0xf4]);
            m.write(F, [0x42, 0xc3]);
            const stubs = [0, 1, 2, 3, 4, 5].map(i=>0x4000 + i * 0x10);
            stubs.forEach(at=>m.write(at, [0xc3]));
            await untilWorkerLoaded(m);
            const batches = [[F, stubs[0]], [LOOP, stubs[1]], stubs.slice(2, 4), stubs.slice(4)];
            for (const batch of batches)
            {
                // The loop and its callee run before the last batch, so the
                // relink it starts finds them entered.
                if (batch[0] === stubs[4])
                {
                    m.setReg(4, 0x80000);
                    await runToHalt(m, LOOP);
                    assert.equal(diagnostics(m).crossingsAll, 2000);
                }
                batch.forEach(at=>m.runtime.noteHot(at, 0, 64));
                await until(m, ()=>batch.every(at=>m.runtime.entryOf(at) >= 0));
            }
            await until(m, ()=>(diagnostics(m).relinked ?? 0) >= 8);
            const d = diagnostics(m);
            assert.equal(d.relinks, 1);
            assert.equal(d.heldModules, 4, 'the two that ran in one, the stubs in three');
            const before = d.crossingsAll;
            m.setReg(2, 0);
            m.setReg(4, 0x80000);
            await runToHalt(m, LOOP);
            assert.equal(m.reg(2), 1000);
            assert.equal(diagnostics(m).crossingsAll - before, 0,
                'the loop and its callee together');
        }
        finally
        {
            await m.runtime.flush();
        }
    });

/**
 * A seeded program of small functions a driver calls in a seeded order, each
 * function translated in a module of its own, run with a ceiling on what is
 * held: what it leaves, the most held at any slice, and the runtime's counts.
 *
 * @param {number} seed @param {Record<string, unknown>} config
 */
async function ceilingRun(seed, config){
    const next = random(seed);
    const DRIVER = 0x2000;
    const FUNCTIONS = 0x3000;
    const DATA = 0x9000;
    const count = 8 + Math.floor(next() * 8);
    const m = machine({ leafCalls: false, batchRegions: 1, maxBatchRegions: 1, relinkAfter: 0,
        store: memoryTranslationStore(), bundleId: 'test', ...config });
    try
    {
        // f_i: add eax, k; xor ebx, eax; add [DATA + 4 i], eax; ret
        const functions = Array.from({ length: count }, (_, i)=>{
            const at = FUNCTIONS + i * 0x40;
            m.write(at, [0x05, ...le32(Math.floor(next() * 2 ** 32)), 0x31, 0xc3,
                0x01, 0x05, ...le32(DATA + i * 4), 0xc3]);
            return at;
        });
        // mov ecx, rounds; L: call f_s0; ...; dec ecx; jnz L; hlt
        const order = Array.from({ length: 6 + Math.floor(next() * 10) },
            ()=>functions[Math.floor(next() * count)]);
        const code = [0xb9, ...le32(10 + Math.floor(next() * 20))];
        for (const target of order)
        {
            code.push(...call(DRIVER + code.length, target));
        }
        code.push(0x49, 0x0f, 0x85, ...le32(5 - (code.length + 7)), 0xf4);
        m.write(DRIVER, code);
        for (const at of [...functions, DRIVER])
        {
            m.runtime.noteHot(at, 0, 64);
            await until(m, ()=>m.runtime.entryOf(at) >= 0);
        }
        m.setReg(4, 0x80000);
        /** @type {number[]} */
        const held = [];
        await runToHalt(m, DRIVER, { held, budget: 200 });
        const d = diagnostics(m);
        return { state: [m.reg(0), m.reg(1), m.reg(3), m.reg(4), ...m.read(DATA, count * 4)],
            most: Math.max(...held), evictions: d.evictions, broughtBack: d.broughtBack,
            cacheHits: d.cacheHits, heldBytes: d.heldBytes, heldModules: d.heldModules };
    }
    finally
    {
        await m.runtime.flush();
    }
}

/** @type {[number, Record<string, boolean>][]} */
const CEILING_RUNS = [[61, {}], [62, {}], [63, { callReturn: false }],
    [64, { dispatch: true, crossTailCalls: false }],
    [65, { dispatch: true, crossTailCalls: false, callReturn: false }]];
for (const [seed, mode] of CEILING_RUNS)
{
    test(`a program run under a ceiling a few modules high, its modules let go and brought back`
        + ` all the time, runs as it does without one (seed ${seed}, ${JSON.stringify(mode)})`,
    async()=>{
        if (mode.dispatch && !probeFeatures().tailCalls)
        {
            return;
        }
        const free = await ceilingRun(seed, { ...mode, cacheBytes: 0 });
        assert.equal(free.evictions, 0);
        // Room for three modules of the size they are on average.
        const cacheBytes = Math.ceil(3 * free.heldBytes / free.heldModules);
        const held = await ceilingRun(seed, { ...mode, cacheBytes });
        assert.deepEqual(held.state, free.state, 'the same registers and memory');
        assert.ok(held.most <= cacheBytes, `held ${held.most} of ${cacheBytes}`);
        assert.ok(held.evictions > 10, `${held.evictions} modules let go`);
        assert.ok(held.broughtBack > 10, `${held.broughtBack} regions brought back`);
        assert.ok(held.cacheHits >= held.broughtBack, 'from the store, not translated again');
    });
}
