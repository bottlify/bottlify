/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What keeping the emitted region functions costs and pays, by keeper: the
 * thread's own LRU (`createEmitCache`), the process's arena (`arenaEmitCache`)
 * and a candidate kept as bodies of a Cellar cache (`cellarEmitCache` below),
 * the cache the run's other caches are kept in (`modules/core/vendor/cellar/`).
 *
 *   node modules/cork/bench/emit-cache.mjs [name...] [--bits 64] [--iters N] [--reps N]
 *       [--json]
 *
 * Each micro workload (README, "Micro workloads") runs `--iters` iterations on
 * the cork host with an arena, its running regions gathered after two batch
 * modules and 100 000 quiet instructions (`relinkAfter`, `relinkQuiet`): the
 * relink a program reaches once it stops meeting new code, brought forward so
 * that a short run reaches it. The arena's counts are the run's lookups and
 * hits. Its entries - the functions the run emitted, as the emitter made them -
 * are then given to each keeper in turn, fresh each rep: every one kept
 * (`keep`), taken back (`hit`), and asked for under a key that is not there
 * (`miss`), each the mean of one op in microseconds, median and range over
 * `--reps` reps, the keepers interleaved. Every keeper must hand back every
 * function as it was kept, or the bench stops: what is compared is the same
 * answers at a different cost.
 */

import '../../../tools/lib/chromium-v8.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { createCorkHost } from '../../core/src/layers/cpu/internal/cork-host.js';
import { createReader, openKeeper } from '../../core/vendor/cellar/cellar.js';
import * as engine from '../src/index.js';
import { createArena, decodeEntry, entryOf, openArena, sameShape } from '../src/runtime/arena.js';
import { arenaEmitCache, createEmitCache } from '../src/runtime/emit-built.js';
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

/** 64 bits of FNV-1a in two lanes, as a short part of a name. @param {string} text */
function digestOf(text){
    let a = 0x811c9dc5;
    let b = 0x050c5d1f;
    for (let i = 0; i < text.length; i++)
    {
        const unit = text.charCodeAt(i);
        a = Math.imul(a ^ unit, 0x01000193);
        b = Math.imul(b ^ (unit + i), 0x01000193);
    }
    return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

/**
 * The candidate: each function a body of a Cellar cache under `prefix`, read
 * in place by any thread with a reader, the entry laid out as the arena lays
 * it (`entryOf`) without the key, which is the body's name. A module's context
 * goes into the names as 64 bits of its signature, and the signature itself is
 * kept once under `prefix + 'c/'` as a body that never goes (`onlyCopy`): a
 * thread that finds another signature there takes its context for another's
 * and keeps nothing under it, so two contexts never share a function.
 *
 * @param {import('../../core/vendor/cellar/cellar.js').Reader} reader
 * @param {string} prefix
 * @returns {import('../src/runtime/emit-built.js').EmitCache}
 */
function cellarEmitCache(reader, prefix){
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    /** Each signature's part of a name, '' for one another context holds. @type {Map<string, string>} */
    const contexts = new Map();
    /** @type {import('../src/runtime/emit-built.js').EmitCache} */
    const cache = {
        hits: 0,
        context(signature){
            let part = contexts.get(signature);
            if (part === undefined)
            {
                const digest = digestOf(signature);
                const name = `${prefix}c/${digest}`;
                let held = reader.with(name, body=>decoder.decode(body));
                if (held === undefined
                    && reader.put(name, encoder.encode(signature),
                        { onlyCopy: true, disk: 'never' }))
                {
                    held = signature;
                }
                part = held === signature ? digest : '';
                contexts.set(signature, part);
            }
            return part;
        },
        take(key, shape){
            // A key of a context kept nothing under (`context`) begins with its ':'.
            if (key.charCodeAt(0) === 58)
            {
                return undefined;
            }
            const entry = reader.with(prefix + key, body=>decodeEntry(body.slice()));
            if (entry === undefined || !sameShape(entry.shape, shape))
            {
                return undefined;
            }
            cache.hits++;
            return entry.kept;
        },
        keep(key, shape, kept){
            if (key.charCodeAt(0) === 58)
            {
                return;
            }
            const entry = entryOf('', shape, kept);
            const name = prefix + key;
            const view = reader.reserve(name, entry.length, { disk: 'never' });
            if (view !== null)
            {
                entry.write(view, 0);
                reader.commit(name);
            }
        },
    };
    return cache;
}

/** @type {Record<string, () => Promise<{ cache: any, close: () => void }>>} */
const keepers = {
    local: async()=>({ cache: createEmitCache(), close: ()=>{} }),
    arena: async()=>({ cache: arenaEmitCache(createArena()), close: ()=>{} }),
    // As the run's cache is read on the keeper's own thread: its calls plain calls.
    cellar: async()=>{
        /** @type {((message: any) => void)[]} */
        const told = [];
        // A larger table and the segments made after reach the reader as they
        // reach every thread reading the run's cache.
        const keeper = await openKeeper({ budget: 48 << 20, segmentBytes: 16 << 20,
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
        // Its first segment and the spare it keeps made now, as the arena's
        // memory is made before it is timed: a run's keeper makes them once.
        reader.put('warm', new Uint8Array(8), { disk: 'never' });
        return { cache: cellarEmitCache(reader, 'cork/1/'), close: ()=>keeper.close() };
    },
};

/** @param {Uint8Array} image @param {SharedArrayBuffer} arena */
function makeHost(image, arena){
    const host = createCorkHost({
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, ...(bits === 64 ? { bits } : {}),
        cork: { arena, relinkAfter: 2, relinkQuiet: 100_000 },
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
 * The arena's entries split into the signature of their module's context and
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
    const arena = createArena();
    const host = makeHost(readFileSync(new URL(`${name}.bin`, images)), arena);
    for (let i = 0; i < iters; i++)
    {
        iteration(host);
    }
    const counts = openArena(arena).counts();
    const entries = splitKeys(openArena(arena).entries());
    const { relinks } = host.cork().diagnostics();
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
        name, relinks, lookups: counts.lookups, hits: counts.hits, functions: entries.length,
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
