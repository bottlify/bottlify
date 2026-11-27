/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { createReader, openKeeper } from '@bottlify/cellar';
import { formRegion } from '../region.js';
import { createEmitCache, relinkBatch } from './emit-built.js';
import { entryOf, keptEmitCache, keptName, putAll, readEntry, readingSpace } from './kept.js';
import { ownLayout } from './layout.js';
import { machine, piece, translateUntil, untilTranslatorsLoaded } from '../testing/seeded-pieces.js';

const FEATURES = { simd: true, tailCalls: true, defaultNaNNegative: false };
const OPTIONS = { hash: true, place: true, trapPort: 0xb077, profileCalls: true };
const FORM = { maxBlocks: 128, maxBytes: 8192, leafCalls: true };
const BASE = 0x401000;
const PREFIX = 'cork/';
const layout = ownLayout({ ramSize: 16 << 20 });

/** @param {number} n @returns {import('./kept.js').KeptFunction} */
const kept = n=>({ typeIndex: n % 7, locals: [n, n + 1], body: new Uint8Array(64).fill(n & 0xff),
    hints: [n], region: { labels: [[n, 0]], cut: [], entryTop: 0, instructions: n } });

/**
 * A run's cache as the core holds it: a keeper, the reader on its thread, and
 * the space cork keeps through (`cork/`, bodies that stay however long idle,
 * never on a disk); `join` hands another thread what it reads it over.
 *
 * @param {number} [budget]
 */
async function cellarOf(budget = 8 << 20){
    /** @type {Set<(message: any) => void>} */
    const told = new Set();
    const keeper = await openKeeper({ budget, segmentBytes: 1 << 20,
        announce: message=>told.forEach(tell=>tell(message)) });
    const reader = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, options)=>keeper.reserve(name, length, options),
            raise: (name, options)=>keeper.raise(name, options),
            raiseLater: name=>{
                keeper.raise(name);
            },
            drop: name=>{
                keeper.drop(name);
            },
        } });
    told.add(message=>reader.adopt(message));
    /** @type {import('./kept.js').KeptSpace} */
    const space = {
        with: (name, read)=>reader.with(PREFIX + name, read),
        put: (name, bytes)=>reader.put(PREFIX + name, bytes, { disk: 'never', idle: 'stay' }),
    };
    return {
        keeper, reader, space,
        /** A reader of the same cache that asks the keeper nothing, as a worker's. */
        readOnly(){
            const other = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
                keeper: { reserve: ()=>null, raise: ()=>false, raiseLater(){}, drop(){} } });
            told.add(message=>other.adopt(message));
            return readingSpace((name, read)=>other.with(PREFIX + name, read));
        },
        /** @param {(message: any) => void} post */
        join(post){
            told.add(post);
            return { shared: keeper.shared, segments: keeper.segmentBuffers() };
        },
        close: ()=>keeper.close(),
    };
}

test('a kept function is handed back under its key and shape only, from any reader of the run',
    async()=>{
        const run = await cellarOf();
        const cache = keptEmitCache(run.space);
        cache.keep('a', [1, 2], kept(1));
        assert.deepEqual(cache.take('a', [1, 2]), kept(1));
        assert.equal(cache.take('a', [1, 3]), undefined, 'another shape');
        assert.equal(cache.take('a', [1]), undefined, 'a shorter shape');
        assert.equal(cache.take('b', [1, 2]), undefined, 'another key');
        // A second keep of the same function - a second thread that emitted it
        // too - writes nothing; another under the key is the newer, kept.
        const replaced = run.keeper.figures().replaced;
        cache.keep('a', [1, 2], kept(1));
        assert.equal(run.keeper.figures().replaced, replaced, 'the same body, not written again');
        cache.keep('a', [1, 2], kept(2));
        assert.deepEqual(cache.take('a', [1, 2]), kept(2));
        // A key past ASCII, and keys one unit apart.
        cache.keep('clé:1', [7], kept(3));
        assert.deepEqual(cache.take('clé:1', [7]), kept(3));
        assert.equal(cache.take('clè:1', [7]), undefined);
        assert.deepEqual(keptEmitCache(run.readOnly()).take('a', [1, 2]), kept(2),
            'another thread\'s reader');
        assert.equal(cache.hits, 3);
        run.close();
    });

test('an entry read whole is the key, the shape and the function kept', ()=>{
    const entry = entryOf('cl\u00e9:4198400', [2 ** 31 + 4, -1.5], kept(6));
    const bytes = new Uint8Array(entry.length);
    entry.write(bytes, 0);
    assert.deepEqual(readEntry(bytes), { key: 'cl\u00e9:4198400', shape: [2 ** 31 + 4, -1.5],
        kept: kept(6) });
});

test('two keys of one name, never one\'s function for the other\'s', async()=>{
    const run = await cellarOf();
    const cache = keptEmitCache(run.space);
    // The body under 'a's name holds another key's entry, as a name two keys
    // hash to alike would.
    const entry = entryOf('not a', [1], kept(4));
    const bytes = new Uint8Array(entry.length);
    entry.write(bytes, 0);
    assert.equal(run.space.put(keptName('a'), bytes), true);
    assert.equal(cache.take('a', [1]), undefined, 'the entry is another key\'s');
    assert.equal(cache.take('not a', [1]), undefined, 'and not under its own name');
    // A body that is no entry at all is no function either.
    run.space.put(keptName('c'), new Uint8Array(12).fill(0xff));
    assert.equal(cache.take('c', []), undefined);
    run.close();
});

test('a function taken is the caller\'s own: the cache\'s bytes may be another\'s after', async()=>{
    const run = await cellarOf();
    const cache = keptEmitCache(run.space);
    cache.keep('k', [2 ** 31 + 4, -1.5], kept(9));
    const first = /** @type {import('./kept.js').KeptFunction} */ (cache.take('k', [2 ** 31 + 4, -1.5]));
    assert.ok(!(first.body.buffer instanceof SharedArrayBuffer), 'a copy of its own');
    first.body.fill(0);
    assert.deepEqual(cache.take('k', [2 ** 31 + 4, -1.5]), kept(9), 'the kept bytes untouched');
    run.close();
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

// The contract against the thread's own cache: seeded runs of keeps and takes,
// keys and shapes drawn from small sets so that takes hit, miss on the shape
// and keep again; with room for all, the run's cache answers each take as the
// thread's own does.
for (const seed of [11, 12, 13, 14])
{
    test(`keeps and takes answer as the thread's own cache does (seed ${seed})`, async()=>{
        const next = random(seed);
        const run = await cellarOf();
        const ours = keptEmitCache(run.space);
        const local = createEmitCache();
        for (let step = 0; step < 2000; step++)
        {
            const key = `ctx:${Math.floor(next() * 60)}:${next() < 0.1 ? 'clé' : 'h'}`;
            const shape = [Math.floor(next() * 3), next() < 0.5 ? 2 ** 32 + 1 : -0.5];
            if (next() < 0.4)
            {
                const n = Math.floor(next() * 1000);
                local.keep(key, shape, kept(n));
                ours.keep(key, shape, kept(n));
            }
            else
            {
                // The thread's own cache hands back its entry, its shape and size beside.
                const theirs = local.take(key, shape);
                assert.deepEqual(ours.take(key, shape), theirs && { typeIndex: theirs.typeIndex,
                    locals: theirs.locals, body: theirs.body, hints: theirs.hints,
                    region: theirs.region }, `step ${step}`);
            }
        }
        assert.equal(ours.hits, local.hits);
        assert.ok(ours.hits > 100);
        run.close();
    });
}

/**
 * Regions at a benchmark program's block starts, as a relink posts them.
 * @param {string} name @param {number} count
 */
function relinkOf(name, count){
    const image = readFileSync(new URL(`../../bench/micro/images/${name}.bin`, import.meta.url));
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

// The gate of the run's cache (a second path beside emitting every function):
// seeded sequences of batches - regions of the benchmark programs in random
// subsets and orders, some checked, some for the wide precision - emitted with
// no cache, with a cache of one thread's own, and through the run's cache by
// three translators in turn, one that writes and two that read and hand their
// keeps over; each batch's module and answers alike in all three.
for (const seed of [1, 2, 3, 4, 5, 6])
{
    test(`batches through the run's cache three translators share are the ones emitted afresh`
        + ` (seed ${seed})`, async()=>{
        const next = random(seed);
        const programs = ['load-x87', 'game-x87', 'sort-x87', 'crc-x87'].map(name=>
            relinkOf(name, 40));
        const run = await cellarOf();
        const readers = [run.readOnly(), run.readOnly()];
        const shared = [keptEmitCache(run.space), ...readers.map(space=>keptEmitCache(space))];
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
            const viaRun = relinkBatch(relink, layout, FEATURES, options, cache);
            hits += cache.hits - before;
            // A reader's keeps reach the run's cache with its answer.
            readers.forEach(space=>putAll(run.space, space.taken()));
            const viaLocal = relinkBatch(relink, layout, FEATURES, options, local);
            assert.deepEqual(viaRun.module, fresh.module, `batch ${batch}: the run's cache`);
            assert.deepEqual(viaRun.results, fresh.results, `batch ${batch}: its answers`);
            assert.deepEqual(viaLocal.module, fresh.module, `batch ${batch}: local`);
        }
        assert.ok(hits > 0, 'the translators took one another\'s functions');
        run.close();
    });
}

test('translators on threads of their own read what the writing thread keeps, never an entry torn',
    async()=>{
        // The writing thread keeps entries whose bytes are a function of their
        // key; two threads read the newest as they go, in place, through
        // readers of their own. An entry read half written answers bytes that
        // do not match its key.
        const run = await cellarOf(4 << 20);
        const cache = keptEmitCache(run.space);
        const progress = new SharedArrayBuffer(8);
        const keptUrl = JSON.stringify(new URL('./kept.js', import.meta.url).href);
        const cellarUrl = JSON.stringify(import.meta.resolve('@bottlify/cellar'));
        const source = `
            const { parentPort, workerData } = require('node:worker_threads');
            Promise.all([import(${keptUrl}), import(${cellarUrl})]).then(async([kept, cellar])=>{
                const reader = cellar.createReader({ shared: workerData.joined.shared,
                    segments: workerData.joined.segments,
                    keeper: { reserve: ()=>null, raise: ()=>false, raiseLater(){}, drop(){} } });
                parentPort.on('message', message=>reader.adopt(message));
                const cache = kept.keptEmitCache(kept.readingSpace(
                    (name, read)=>reader.with('cork/' + name, read)));
                const progress = new Int32Array(workerData.progress);
                // Ready: the writer starts once both readers are.
                Atomics.add(progress, 1, 1);
                let torn = 0, found = 0;
                // Read while the writer writes, and some after: a thread the
                // machine schedules late still reads the newest.
                let after = 0;
                const until = Date.now() + 10000;
                for (let turn = 0; Date.now() < until && after < 200; turn++)
                {
                    // Between its turns a thread hears of the segments the
                    // keeper made (adopt): one that never yields reads only
                    // the segments it was joined with.
                    if (turn % 64 === 63)
                    {
                        await new Promise(resolve=>setImmediate(resolve));
                    }
                    const done = Atomics.load(progress, 0);
                    if (done === 0)
                    {
                        continue;
                    }
                    if (done === 3000)
                    {
                        after++;
                    }
                    const n = done - 1 - Math.floor(Math.random() * Math.min(done, 64));
                    const got = cache.take('k' + n, [n]);
                    if (got !== undefined)
                    {
                        found++;
                        if (got.typeIndex !== n || got.region.own !== n
                            || got.body.length !== 200 + (n % 300)
                            || got.body.some(byte=>byte !== (n & 0xff)))
                        {
                            torn++;
                        }
                    }
                }
                parentPort.postMessage({ torn, found });
            });`;
        const workers = [0, 1].map(()=>{
            /** @type {Worker | null} */
            let worker = null;
            const joined = run.join(message=>worker?.postMessage(message));
            worker = new Worker(source, { eval: true, workerData: { joined, progress } });
            return worker;
        });
        const answers = workers.map(worker=>new Promise((resolve, reject)=>{
            worker.once('message', resolve);
            worker.once('error', reject);
        }));
        const counter = new Int32Array(progress);
        while (Atomics.load(counter, 1) < 2)
        {
            await new Promise(resolve=>setTimeout(resolve, 5));
        }
        for (let n = 0; n < 3000; n++)
        {
            cache.keep(`k${n}`, [n], { typeIndex: n, locals: [], hints: [],
                body: new Uint8Array(200 + (n % 300)).fill(n & 0xff), region: { own: n } });
            Atomics.store(counter, 0, n + 1);
            // The workers hear of segments made between keeps, as a thread does.
            if (n % 100 === 0)
            {
                await new Promise(resolve=>setImmediate(resolve));
            }
        }
        const results = /** @type {{ torn: number, found: number }[]} */ (await Promise.all(answers));
        await Promise.all(workers.map(worker=>worker.terminate()));
        for (const { torn, found } of results)
        {
            assert.equal(torn, 0, 'no entry read torn');
            assert.ok(found > 0, 'each thread found the writer\'s functions');
        }
        run.close();
    });

test('a runtime\'s translation worker hands what it emitted to the run\'s cache, and another'
    + ' runtime of the run takes it there instead of emitting it', async()=>{
    const run = await cellarOf();
    /** @type {import('./kept.js').KeptStore} */
    const store = { space: run.space, prefix: PREFIX, join: post=>run.join(post) };
    const first = machine({ worker: true, translators: 1, kept: store });
    const second = machine({ kept: store });
    try
    {
        await untilTranslatorsLoaded(first, 1);
        const { code } = piece(3, 50, 5);
        first.write(0x2000, code);
        first.runtime.noteHot(0x2000, 0, 2);
        await translateUntil(first, ()=>first.runtime.entryOf(0x2000) >= 0);
        const handed = /** @type {any} */ (first.runtime.diagnostics()).kept;
        assert.ok(handed.handed >= 1, 'the worker handed its function over with its answer');
        // The other runtime forms the same region and emits it inline: the
        // function is taken from the run's cache.
        second.write(0x2000, code);
        second.runtime.noteHot(0x2000, 0, 2);
        await translateUntil(second, ()=>second.runtime.entryOf(0x2000) >= 0);
        const taken = /** @type {any} */ (second.runtime.diagnostics()).kept;
        assert.ok(taken.inlineHits >= 1, 'taken from the run\'s cache, not emitted again');
        assert.equal(second.runtime.run(second.runtime.entryOf(0x2000), 1000).kind, 'halt');
        assert.equal(second.reg(1), 0, 'and it runs as emitted: its loop counted down');
    }
    finally
    {
        await first.runtime.flush();
        await second.runtime.flush();
        run.close();
    }
});
