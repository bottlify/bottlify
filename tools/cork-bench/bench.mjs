/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cork benchmark: C programs of the shapes games run -- a bytecode
 * interpreter, a tree, virtual calls, sorting, strings, a CRC and an LZ
 * decoder, x87 and SSE float math, a game's entity update, a message pump,
 * a loading phase's fifteen hundred functions each run a few times, a
 * loop calling a routine that patches its own code, which crosses from
 * translated code into the interpreter and back on every call, calls through a
 * table of 8, 512 or 4096 small functions, in order or scattered, where only
 * the number of distinct targets changes (`calls*`), and the x87 float ones
 * again under single precision control, as Direct3D leaves it (`pc24`) --
 * compiled to i386 (`build.sh`, `images/`) and run on the cork host, as a
 * launch runs a program.
 *
 *   node tools/cork-bench/bench.mjs [name...] [--warm N] [--iters N] [--reps N]
 *       [--cork JSON] [--root DIR] [--json] [--store fresh | --seed DIR | --capture DIR]
 *
 * Each rep makes a fresh host, times its first iteration (`coldMs`: the
 * interpreter, the translator and the tier-up, what a new stretch of code
 * costs), runs `--warm` iterations and times `--iters` more (`usPerIter`, the
 * best rep: translated code in its steady state). `firstMs` is the first
 * rep's first iteration alone: in a process that has run nothing before --
 * the first workload named, or any under `compare.mjs`, which runs each in a
 * process of its own -- the engine's own JavaScript and wasm are cold too, as
 * at a launch, where `coldMs` leaves the first reps out to time the
 * translator warm. `eax` is the program's own
 * checksum and must not change with the engine. `--cork` is the translator's
 * configuration (`{"translate":false}` times the interpreter alone), `--root`
 * a checkout whose engine to run, so one tree compares against another
 * (`compare.mjs`). A steady-state figure moves by five to ten per cent between
 * processes; `node --no-liftoff` takes the baseline tier out of it.
 *
 * With a translation store every rep's host gets a fresh one in memory, open
 * before the host starts as a launch's start leaves it, and the event loop
 * turns between slices, as a launch's frames let the store's answers come
 * back: `--store fresh` is an empty store (a bottle's first run),
 * `--seed DIR` one seeded from `DIR/<name>.seed` before the host starts (the
 * rows say `hits` in the first iteration and the seeding's `seedMs`), and
 * `--capture DIR` writes the first rep's store, once its iterations are done,
 * to `DIR/<name>.seed`.
 */

import '../chromium-v8.mjs';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const warm = Number(flag('--warm', '20'));
const iters = Number(flag('--iters', '40'));
const reps = Number(flag('--reps', '5'));
const cork = JSON.parse(flag('--cork', '{}'));
const root = pathToFileURL(resolve(flag('--root', new URL('../..', import.meta.url).pathname)) + '/');
const only = args.filter((one, at)=>!one.startsWith('--') && !args[at - 1]?.startsWith('--'));

const seedDir = flag('--seed', '');
const captureDir = flag('--capture', '');
const withStore = flag('--store', '') === 'fresh' || seedDir !== '' || captureDir !== '';

const { createCorkHost } = await import(
    new URL('modules/core/src/layers/cpu/internal/cork-host.js', root).href);
const engine = await import(new URL('modules/cork/src/index.js', root).href);
const stores = withStore ? await import(
    new URL('modules/core/src/layers/cpu/internal/translation-store.js', root).href) : null;
const { seedRecords } = await import(new URL('modules/cork/src/runtime/cache.js', root).href);

const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;
const images = new URL('images/', import.meta.url);
const names = readdirSync(images).filter(file=>file.endsWith('.bin'))
    .map(file=>file.slice(0, -4)).filter(name=>only.length === 0
        || only.some(prefix=>name.startsWith(prefix))).sort();

/** @param {Uint8Array} image @param {any} store */
function makeHost(image, store){
    const host = createCorkHost({
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, cork: store === null ? cork : { ...cork, store },
    });
    host.writePhysical(IMAGE_BASE, image);
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    return host;
}

/**
 * One call of the program's main, to its `hlt`: slices of the scheduler's
 * quantum, the translator fed between them as frames feed it.
 *
 * @param {ReturnType<typeof makeHost>} host
 */
function iteration(host){
    let retired = host.runSlice(100_000);
    while (!host.halted())
    {
        host.cork().translatePending().catch(()=>{});
        retired += host.runSlice(100_000);
    }
    return retired;
}

/**
 * The same with a store: the event loop turns between slices, so a batch's
 * lookups come back and are published, as between a launch's frames.
 *
 * @param {ReturnType<typeof makeHost>} host
 */
async function storedIteration(host){
    let retired = host.runSlice(100_000);
    while (!host.halted())
    {
        host.cork().translatePending().catch(()=>{});
        await new Promise(turned=>setImmediate(turned));
        retired += host.runSlice(100_000);
    }
    return retired;
}

/** A host's iteration, with or without a store. @param {ReturnType<typeof makeHost>} host */
const run = async host=>(withStore ? storedIteration(host) : iteration(host));

/** @param {number[]} values */
const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];

const rows = [];
for (const name of names)
{
    const image = readFileSync(new URL(`${name}.bin`, images));
    const seed = seedDir === '' ? null : readFileSync(join(seedDir, `${name}.seed`));
    /** @type {number[]} */
    const steady = [];
    /** @type {number[]} */
    const colds = [];
    /** @type {number[]} */
    const hits = [];
    /** @type {number[]} */
    const seedings = [];
    let summary = null;
    for (let rep = 0; rep < reps; rep++)
    {
        const store = stores === null ? null
            : await stores.createDirectoryTranslationStore(stores.createMemoryDirectory(), 'bench');
        await store?.prepare?.();
        if (seed !== null)
        {
            const seedAt = performance.now();
            await store.seed(new Uint8Array(seed));
            seedings.push(performance.now() - seedAt);
        }
        const host = makeHost(image, store);
        const coldAt = performance.now();
        await run(host);
        colds.push(performance.now() - coldAt);
        if (store !== null)
        {
            hits.push(host.cork().diagnostics().cacheHits);
        }
        for (let i = 1; i < warm; i++)
        {
            await run(host);
        }
        const before = host.cork().counters();
        const exits = /** @type {Record<string, number>} */ ({ ...before.exits });
        const startedAt = performance.now();
        let retired = 0;
        for (let i = 0; i < iters; i++)
        {
            retired += await run(host);
        }
        steady.push((performance.now() - startedAt) * 1000 / iters);
        if (captureDir !== '' && rep === 0)
        {
            await host.cork().flush();
            mkdirSync(captureDir, { recursive: true });
            writeFileSync(join(captureDir, `${name}.seed`), await store.exportSeed(
                { select: (/** @type {any} */ records)=>seedRecords(records, stores.fileNameOf) }));
        }
        const after = host.cork().counters();
        summary = {
            instructions: retired / iters,
            share: (after.retired - before.retired) / retired,
            regions: after.regions,
            exits: Object.fromEntries(Object.entries(after.exits)
                .map(([kind, count])=>[kind, (count - exits[kind]) / iters])
                .filter(([, count])=>count > 0)),
            eax: (host.readReg32('eax') >>> 0).toString(16),
        };
    }
    if (summary === null)
    {
        continue;
    }
    const best = Math.min(...steady);
    rows.push({
        name,
        // The first reps warm the engine's own JavaScript, as a title's first seconds do.
        coldMs: Number(median(colds.length > 3 ? colds.slice(2) : colds).toFixed(2)),
        firstMs: Number(colds[0].toFixed(2)),
        usPerIter: Number(best.toFixed(1)),
        nsPerInstr: Number((best * 1000 / summary.instructions).toFixed(3)),
        instructions: Math.round(summary.instructions),
        share: Number(summary.share.toFixed(3)),
        regions: summary.regions,
        exits: JSON.stringify(summary.exits),
        eax: summary.eax,
        ...(hits.length > 0 ? { hits: median(hits) } : {}),
        ...(seedings.length > 0 ? { seedMs: Number(median(seedings).toFixed(2)) } : {}),
    });
}
if (args.includes('--json'))
{
    console.log(JSON.stringify(rows));
}
else
{
    console.table(rows);
}
