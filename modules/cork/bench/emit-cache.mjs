/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What keeping the emitted region functions costs and pays, by keeper: the
 * thread's own LRU (`createEmitCache`) and the run's Cellar cache
 * (`keptEmitCache`), its functions kept as bodies under `cork/` as the cpu
 * layer keeps them.
 *
 *   node modules/cork/bench/emit-cache.mjs [name...] [--bits 64] [--iters N] [--reps N]
 *       [--json]
 *
 * Each micro workload (README, "Micro workloads") runs `--iters` iterations on
 * the cork host keeping its functions in a run's cache, its running regions
 * gathered after two batch modules and 100 000 quiet instructions
 * (`relinkAfter`, `relinkQuiet`): the relink a program reaches once it stops
 * meeting new code, brought forward so that a short run reaches it. The
 * runtime's counts are the run's hits. The functions the run kept, as the
 * emitter made them, are then given to each keeper in turn, fresh each rep: every one kept
 * (`keep`), taken back (`hit`), and asked for under a key that is not there
 * (`miss`), each the mean of one op in microseconds, median and range over
 * `--reps` reps, the keepers interleaved. Every keeper must hand back every
 * function as it was kept, or the bench stops: what is compared is the same
 * answers at a different cost.
 */

import '../../../tools/lib/chromium-v8.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { createCorkHost } from '../../core/src/layers/cpu/internal/cork-host.js';
import { testAccount } from '../../core/src/layers/cpu/testing.fixture.js';
import { createReader, openKeeper } from '@bottlify/cellar';
import * as engine from '../src/index.js';
import { createEmitCache } from '../src/runtime/emit-built.js';
import { keptEmitCache, readEntry } from '../src/runtime/kept.js';
import { median, option } from '../../../tools/lib/common.mjs';

const args = process.argv.slice(2);
const iters = Number(option(args, '--iters', '60'));
const reps = Number(option(args, '--reps', '15'));
const bits = Number(option(args, '--bits', '32'));
const only = args.filter((one, at)=>!one.startsWith('--') && !args[at - 1]?.startsWith('--'));
const WARM_REPS = 3;
const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;
const images = new URL(bits === 64 ? 'micro/images64/' : 'micro/images/', import.meta.url);
const names = readdirSync(images).filter(file=>file.endsWith('.bin'))
    .map(file=>file.slice(0, -4)).filter(name=>only.length === 0
        || only.some(prefix=>name.startsWith(prefix))).sort();

/**
 * A run's cache as the core holds it: a keeper over `budget`, a reader on its
 * thread, and the space cork keeps through (`cork/`, bodies that stay however
 * long idle, never on a disk); each `put` seen by `onPut` too.
 *
 * @param {number} budget @param {(name: string, bytes: Uint8Array) => void} [onPut]
 */
async function runCacheOf(budget, onPut = ()=>{}){
    /** @type {((message: any) => void)[]} */
    const told = [];
    const keeper = await openKeeper({ budget, segmentBytes: 16 << 20,
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
    told.push(message=>reader.adopt(message));
    // Its first segment and the spare it keeps made now, before it is timed:
    // a run's keeper makes them once.
    reader.put('warm', new Uint8Array(8), { disk: 'never' });
    /** @type {import('../src/runtime/kept.js').KeptSpace} */
    const space = {
        with: (name, read)=>reader.with(`cork/${name}`, read),
        put(name, bytes){
            onPut(name, bytes);
            return reader.put(`cork/${name}`, bytes, { disk: 'never', idle: 'stay' });
        },
    };
    return {
        space,
        /** A translation worker joined, as the run's `join` joins one. @param {(message: any) => void} post */
        join: post=>{
            told.push(post);
            return { shared: keeper.shared, segments: keeper.segmentBuffers() };
        },
        close: ()=>keeper.close(),
    };
}

/** @type {Record<string, () => Promise<{ cache: any, close: () => void }>>} */
const keepers = {
    local: async()=>({ cache: createEmitCache(), close: ()=>{} }),
    // As the run's cache is read on the keeper's own thread: its calls plain calls.
    cellar: async()=>{
        const { space, close } = await runCacheOf(48 << 20);
        return { cache: keptEmitCache(space), close };
    },
};

/** @param {Uint8Array} image @param {import('../src/runtime/kept.js').KeptStore} kept */
function makeHost(image, kept){
    const host = createCorkHost({ memoryBudget: testAccount(),
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, ...(bits === 64 ? { bits } : {}),
        cork: { kept, relinkAfter: 2, relinkQuiet: 100_000 },
    });
    host.writePhysical(IMAGE_BASE, image);
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    return host;
}

/** One call of the program's main, to its `hlt`. @param {ReturnType<typeof makeHost>} host */
function iteration(host){
    host.runSlice(100_000);
    while (!host.halted())
    {
        host.cork().translatePending().catch(()=>{});
        host.runSlice(100_000);
    }
}

/** @param {any} a @param {any} b */
const sameKept = (a, b)=>a !== undefined && a.typeIndex === b.typeIndex
    && JSON.stringify(a.locals) === JSON.stringify(b.locals)
    && Buffer.compare(Buffer.from(a.body), Buffer.from(b.body)) === 0
    && JSON.stringify(a.hints) === JSON.stringify(b.hints)
    && JSON.stringify(a.region) === JSON.stringify(b.region);

/**
 * The kept entries split into the signature of their module's context and
 * the rest of the key: a signature is JSON, in which `]:` comes only inside a
 * string.
 *
 * @param {{ key: string, shape: number[], kept: any }[]} entries
 */
function splitKeys(entries){
    return entries.map(one=>{
        const at = one.key.indexOf(']:') + 1;
        const signature = one.key.slice(0, at);
        JSON.parse(signature);
        return { ...one, signature, rest: one.key.slice(at) };
    });
}

/**
 * One rep of one keeper: every entry kept, taken back, and missed.
 *
 * @param {string} name @param {ReturnType<typeof splitKeys>} entries
 */
async function rep(name, entries){
    const { cache, close } = await keepers[name]();
    try
    {
        const keys = entries.map(one=>cache.context(one.signature) + one.rest);
        let at = performance.now();
        for (let i = 0; i < entries.length; i++)
        {
            cache.keep(keys[i], entries[i].shape, entries[i].kept);
        }
        const keep = performance.now() - at;
        /** @type {any[]} */
        const got = new Array(entries.length);
        at = performance.now();
        for (let i = 0; i < entries.length; i++)
        {
            got[i] = cache.take(keys[i], entries[i].shape);
        }
        const hit = performance.now() - at;
        let missed = 0;
        at = performance.now();
        for (let i = 0; i < entries.length; i++)
        {
            missed += cache.take(`${keys[i]}~`, entries[i].shape) === undefined ? 1 : 0;
        }
        const miss = performance.now() - at;
        const wrong = entries.filter((one, i)=>!sameKept(got[i], one.kept)).length;
        if (wrong > 0 || missed !== entries.length)
        {
            throw new Error(`${name}: ${wrong} of ${entries.length} functions not handed back as`
                + ` kept, ${entries.length - missed} found under keys never kept`);
        }
        const per = (/** @type {number} */ ms)=>ms * 1000 / entries.length;
        return { keep: per(keep), hit: per(hit), miss: per(miss) };
    }
    finally
    {
        close();
    }
}

const rows = [];
for (const name of names)
{
    // What the run kept, by name: the last body put under each, as the cache holds it.
    /** @type {Map<string, Uint8Array>} */
    const put = new Map();
    const run = await runCacheOf(256 << 20, (one, bytes)=>put.set(one, bytes));
    const host = makeHost(readFileSync(new URL(`${name}.bin`, images)),
        { space: run.space, prefix: 'cork/', join: run.join });
    for (let i = 0; i < iters; i++)
    {
        iteration(host);
    }
    run.close();
    const entries = splitKeys([...put.values()].map(bytes=>readEntry(bytes)));
    const { relinks, kept: counts } = /** @type {any} */ (host.cork().diagnostics());
    /** @type {Record<string, { keep: number[], hit: number[], miss: number[] }>} */
    const times = Object.fromEntries(Object.keys(keepers).map(one=>[one,
        { keep: [], hit: [], miss: [] }]));
    for (let r = 0; r < WARM_REPS + reps && entries.length > 0; r++)
    {
        for (const keeper of Object.keys(keepers))
        {
            const one = await rep(keeper, entries);
            if (r >= WARM_REPS)
            {
                times[keeper].keep.push(one.keep);
                times[keeper].hit.push(one.hit);
                times[keeper].miss.push(one.miss);
            }
        }
    }
    /** @param {number[]} values */
    const spread = values=>(values.length === 0 ? 'not measured'
        : `${median(values).toFixed(2)} [${Math.min(...values).toFixed(2)}-`
            + `${Math.max(...values).toFixed(2)}]`);
    rows.push({
        name, relinks, hits: counts.hits, functions: entries.length,
        bodyBytes: entries.reduce((sum, one)=>sum + one.kept.body.length, 0),
        ...Object.fromEntries(Object.entries(times).flatMap(([keeper, t])=>[
            [`${keeper} hit`, spread(t.hit)], [`${keeper} miss`, spread(t.miss)],
            [`${keeper} keep`, spread(t.keep)]])),
    });
}
if (args.includes('--json'))
{
    console.log(JSON.stringify({ bits, iters, reps, node: process.version, rows }));
}
else
{
    for (const row of rows)
    {
        console.log(JSON.stringify(row));
    }
}
