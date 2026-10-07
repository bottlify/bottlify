/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { formRegion } from '../region.js';
import { createArena, openArena } from './arena.js';
import { arenaEmitCache, createEmitCache, relinkBatch } from './emit-built.js';
import { ownLayout } from './layout.js';

const FEATURES = { simd: true, tailCalls: true, defaultNaNNegative: false };
const OPTIONS = { hash: true, place: true, trapPort: 0xb077, profileCalls: true };
const FORM = { maxBlocks: 128, maxBytes: 8192, leafCalls: true };
const BASE = 0x401000;
const layout = ownLayout({ ramSize: 16 << 20 });

/** @param {number} n @returns {import('./arena.js').KeptFunction} */
const kept = n=>({ typeIndex: n % 7, locals: [n, n + 1], body: new Uint8Array(64).fill(n & 0xff),
    hints: [n], region: { labels: [[n, 0]], cut: [], entryTop: 0, instructions: n } });

test('an arena hands back what was kept, under its key and shape only', ()=>{
    const arena = openArena(createArena(1 << 20));
    arena.set('a', [1, 2], kept(1));
    assert.deepEqual(arena.get('a', [1, 2]), kept(1));
    assert.equal(arena.get('a', [1, 3]), undefined, 'another shape');
    assert.equal(arena.get('b', [1, 2]), undefined, 'another key');
    // A second set under the key -- a second worker that emitted it too -- keeps the first.
    arena.set('a', [1, 2], kept(2));
    assert.deepEqual(arena.get('a', [1, 2]), kept(1));
    assert.deepEqual(arena.counts().writes, 1);
});

test('every view of one arena sees what any of them kept', ()=>{
    const buffer = createArena(1 << 20);
    const one = openArena(buffer);
    const other = openArena(buffer);
    one.set('x', [], kept(5));
    assert.deepEqual(other.get('x', []), kept(5));
    assert.equal(one.counts().hits, 1, 'the hits are the arena\'s, every view\'s');
});

test('the oldest segment goes when the arena is full, and a hit in the older half stays', ()=>{
    // Eight segments of 8 KB: entries of about 300 bytes, two dozen to a segment.
    const arena = openArena(createArena(64 << 10, { segments: 8 }));
    arena.set('hot', [], kept(0));
    for (let n = 1; n < 600; n++)
    {
        arena.set(`cold${n}`, [], kept(n));
        // The hot one is looked up all along; the cold ones never again.
        if (n % 20 === 0)
        {
            assert.ok(arena.get('hot', []) !== undefined, `hot kept at ${n}`);
        }
    }
    assert.equal(arena.get('cold1', []), undefined, 'the first cold one is gone');
    assert.ok(arena.get('cold599', []) !== undefined, 'the last one is there');
    assert.ok(arena.counts().refreshed > 0, 'the hot one was copied forward');
});

test('an entry larger than a segment is not kept', ()=>{
    const arena = openArena(createArena(64 << 10, { segments: 8 }));
    arena.set('big', [], { ...kept(1), body: new Uint8Array(16 << 10) });
    assert.equal(arena.get('big', []), undefined);
});

/**
 * Regions at a benchmark program's block starts, as a relink posts them.
 * @param {string} name @param {number} count
 */
function relinkOf(name, count){
    const image = readFileSync(new URL(`../../../../tools/cork-bench/images/${name}.bin`,
        import.meta.url));
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map();
    for (let at = 0; at < image.length; at += 4096)
    {
        const page = new Uint8Array(4096);
        page.set(image.subarray(at, at + 4096));
        pages.set((BASE + at) >>> 12, page);
    }
    const read = (/** @type {number} */ address)=>image[address - BASE] ?? 0;
    const translatable = (/** @type {number} */ address)=>pages.has(address >>> 12);
    /** @type {{ entry: number, entryTop: number, hash: string }[]} */
    const jobs = [];
    const queue = [BASE];
    const seen = new Set(queue);
    while (queue.length > 0 && jobs.length < count)
    {
        const entry = /** @type {number} */ (queue.shift());
        const region = formRegion(read, entry, { ...FORM, translatable });
        jobs.push({ entry, entryTop: 0, hash: region.hash });
        for (const block of region.blocks)
        {
            for (const target of [...block.exit.targets, block.exit.next])
            {
                if (!seen.has(target) && translatable(target))
                {
                    seen.add(target);
                    queue.push(target);
                }
            }
        }
    }
    return { jobs, pages: [...pages], form: FORM };
}

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

// The gate of the arena (a second path beside emitting every function): seeded
// sequences of batches -- regions of the benchmark programs in random subsets and
// orders, some checked, some for the wide precision -- emitted with no cache,
// with a cache of one thread's own, and through one arena by three translators
// in turn, each batch's module and answers alike in all three.
for (const seed of [1, 2, 3, 4, 5, 6])
{
    test(`batches through an arena three translators share are the ones emitted afresh`
        + ` (seed ${seed})`, ()=>{
        const next = random(seed);
        const programs = ['load-x87', 'game-x87', 'sort-x87', 'crc-x87'].map(name=>
            relinkOf(name, 40));
        const buffer = createArena(1 << 20, { segments: 4 });
        const shared = [arenaEmitCache(buffer), arenaEmitCache(buffer), arenaEmitCache(buffer)];
        const local = createEmitCache();
        let hits = 0;
        for (let batch = 0; batch < 12; batch++)
        {
            const program = programs[Math.floor(next() * programs.length)];
            const jobs = program.jobs.filter(()=>next() < 0.4)
                .map(job=>(next() < 0.2 ? { ...job, checked: true } : job))
                .sort(()=>next() - 0.5);
            const relink = { ...program, jobs };
            const options = next() < 0.3 ? { ...OPTIONS, wide: true } : OPTIONS;
            const fresh = relinkBatch(relink, layout, FEATURES, options);
            const cache = shared[batch % shared.length];
            const before = cache.hits;
            const viaArena = relinkBatch(relink, layout, FEATURES, options, cache);
            hits += cache.hits - before;
            const viaLocal = relinkBatch(relink, layout, FEATURES, options, local);
            assert.deepEqual(viaArena.module, fresh.module, `batch ${batch}: arena`);
            assert.deepEqual(viaArena.results, fresh.results, `batch ${batch}: arena answers`);
            assert.deepEqual(viaLocal.module, fresh.module, `batch ${batch}: local`);
        }
        assert.ok(hits > 0, 'the translators took one another\'s functions');
    });
}

test('translators on threads of their own keep and take through one arena with no torn entry',
    async()=>{
        // Each thread keeps entries whose bytes are a function of their key and
        // looks up the others' as they go: an entry read half written, or one
        // another thread's segment took over under it, answers bytes that do
        // not match its key.
        const buffer = createArena(256 << 10, { segments: 4 });
        const gate = new SharedArrayBuffer(4);
        const arenaUrl = JSON.stringify(new URL('./arena.js', import.meta.url).href);
        const source = `
            const { parentPort, workerData } = require('node:worker_threads');
            import(${arenaUrl}).then(({ openArena })=>{
                const arena = openArena(workerData.buffer);
                // All three start together, so each finds the others' entries.
                const gate = new Int32Array(workerData.gate);
                Atomics.add(gate, 0, 1);
                while (Atomics.load(gate, 0) < 3)
                {
                    Atomics.wait(gate, 0, Atomics.load(gate, 0), 1);
                }
                let torn = 0, found = 0;
                for (let n = 0; n < 4000; n++)
                {
                    const own = workerData.id * 100000 + n;
                    const fill = own & 0xff;
                    arena.set('k' + own, [own], { typeIndex: own, locals: [], hints: [],
                        body: new Uint8Array(200 + (own % 300)).fill(fill), region: { own } });
                    const other = ((workerData.id + 1) % 3) * 100000
                        + Math.floor(Math.random() * n);
                    const got = arena.get('k' + other, [other]);
                    if (got !== undefined)
                    {
                        found++;
                        if (got.typeIndex !== other || got.region.own !== other
                            || got.body.length !== 200 + (other % 300)
                            || got.body.some(byte=>byte !== (other & 0xff)))
                        {
                            torn++;
                        }
                    }
                }
                parentPort.postMessage({ torn, found });
            });`;
        const results = await Promise.all([0, 1, 2].map(id=>new Promise((resolve, reject)=>{
            const worker = new Worker(source, { eval: true, workerData: { buffer, gate, id } });
            worker.once('message', resolve);
            worker.once('error', reject);
        })));
        for (const { torn, found } of /** @type {{ torn: number, found: number }[]} */ (results))
        {
            assert.equal(torn, 0, 'no entry read torn');
            assert.ok(found > 0, 'the threads found one another\'s entries');
        }
    });
