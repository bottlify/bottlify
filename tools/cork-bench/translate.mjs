/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What translating costs: the translation worker's whole load on a workload,
 * recorded once and run again alone, so one emitter can be timed against
 * another on the same regions.
 *
 *   node tools/cork-bench/translate.mjs capture DIR [name...] [--iters N] [--seconds S]
 *       [--root TREE] [--cork JSON]
 *   node tools/cork-bench/translate.mjs replay DIR [name...] [--passes N] [--root TREE]
 *       [--roots '{"base":"TREE","new":"TREE"}'] [--no-cache] [--json]
 *
 * `capture` runs each workload of `bench.mjs` on the cork host with a
 * translation worker, as a browser launch runs one, for at least `--iters`
 * iterations and `--seconds` seconds, and keeps every message the runtime
 * posts to the worker in `DIR/<name>.cap`: the batches, the relinks and the
 * merges, each with its jobs, the copy of their pages and the options.
 * `replay` does the worker's work on each message again in this thread --
 * forming the regions from the pages, emitting, encoding (`relinkBatch`) and
 * compiling -- `--passes` times, and reports per workload the first pass
 * (`coldMs`: in a process of its own, the emitter's JavaScript is cold, as at
 * a launch) and the median of the passes after the second (`warmMs`), split
 * into forming, emitting, encoding and compiling, per region and per x86
 * instruction, with the collector's time and the bytes allocated
 * (`v8.GCProfiler`, which sees the heap at each collection), and a digest of
 * every module emitted: two trees whose digests agree emitted the same bytes.
 * `jobs` counts every region emitted, `again` those a message before had
 * emitted already (a relink's or a merge's). `--root` is the checkout whose
 * emitter to run; `--roots` runs several in this process, their passes
 * alternating, so each round's figures share the machine's conditions, and
 * `ratio` is the median over the rounds of each tree's time over the first's.
 * `--no-cache` replays without what a worker keeps of what it emitted
 * (`createEmitCache`), for how much of a tree's figure is that.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GCProfiler, deserialize } from 'node:v8';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const [mode, dir] = args;
const root = pathToFileURL(resolve(flag('--root', fileURLToPath(new URL('../..', import.meta.url)))) + '/');
const only = args.slice(2).filter((one, at, list)=>!one.startsWith('--')
    && !list[at - 1]?.startsWith('--'));
const images = new URL('images/', import.meta.url);
/** @param {string[]} available */
const pick = available=>available.filter(name=>only.length === 0
    || only.some(prefix=>name.startsWith(prefix))).sort();

async function capture(){
    const iters = Number(flag('--iters', '20'));
    const seconds = Number(flag('--seconds', '3'));
    const cork = JSON.parse(flag('--cork', '{}'));
    const { createCorkHost } = await import(
        new URL('modules/core/src/layers/cpu/internal/cork-host.js', root).href);
    const engine = await import(new URL('modules/cork/src/index.js', root).href);
    mkdirSync(dir, { recursive: true });
    const names = pick(readdirSync(images).filter(file=>file.endsWith('.bin'))
        .map(file=>file.slice(0, -4)));
    for (const name of names)
    {
        const out = resolve(dir, `${name}.cap`);
        if (existsSync(out))
        {
            rmSync(out);
        }
        // The worker is made after the runtime asks for it, and takes the
        // environment as it is then.
        process.env.CORK_CAPTURE_OUT = out;
        process.env.CORK_CAPTURE_WORKER = new URL('modules/cork/src/runtime/translator.worker.js',
            root).href;
        const host = createCorkHost({
            engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: 0x7000,
            initialStack: 0x800000,
            cork: { ...cork, workerUrl: new URL('capture.worker.mjs', import.meta.url).href },
        });
        host.writePhysical(0x401000, readFileSync(new URL(`${name}.bin`, images)));
        const vector = new Uint8Array(4);
        new DataView(vector.buffer).setUint32(0, 0x401000, true);
        host.writePhysical(0x7000, vector);
        const startedAt = performance.now();
        let done = 0;
        while (done < iters || performance.now() - startedAt < seconds * 1000)
        {
            // Slices with a turn of the event loop between them, which is
            // when the worker's answers are published.
            host.runSlice(100_000);
            while (!host.halted())
            {
                host.cork().translatePending().catch(()=>{});
                await new Promise(turn=>setImmediate(turn));
                host.runSlice(100_000);
            }
            done++;
        }
        const d = host.cork().diagnostics();
        await host.cork().flush();
        console.log(`${name}: ${done} iterations, ${d.regions} regions, ${d.modules} modules,`
            + ` ${d.relinks} relinks (${d.relinked} regions relinked), ${d.merges} merges,`
            + ` ${d.reforms} reforms, eax ${(host.readReg32('eax') >>> 0).toString(16)}`);
    }
}

/** @param {string} path */
function messagesOf(path){
    const bytes = readFileSync(path);
    const messages = [];
    for (let at = 0; at + 4 <= bytes.length;)
    {
        const length = bytes.readUInt32LE(at);
        messages.push(deserialize(bytes.subarray(at + 4, at + 4 + length)));
        at += 4 + length;
    }
    return messages;
}

/** @param {number[]} values */
const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];

/**
 * One pass over a workload's messages, as one worker's life: what its emitter
 * keeps between messages, where the tree's has something to keep, starts empty.
 *
 * @param {any} built  a tree's `emit-built.js`
 * @param {any[]} messages
 */
function pass(built, messages){
    const hash = createHash('sha256');
    const seen = new Set();
    const sum = { total: 0, form: 0, emit: 0, encode: 0, compile: 0, gcMs: 0, allocatedMb: 0,
        jobs: 0, again: 0, failed: 0, instructions: 0, bytesOut: 0, digest: '' };
    const cache = args.includes('--no-cache') ? undefined : built.createEmitCache?.();
    const profiler = new GCProfiler();
    const usedAt = process.memoryUsage().heapUsed;
    profiler.start();
    for (const data of messages)
    {
        const options = { ...data.options, timings: true };
        const startAt = performance.now();
        const batch = data.relink
            ? built.relinkBatch(data.relink, data.layout, data.features, options, cache)
            : built.emitBatch(data.jobs ?? [], data.layout, data.features, options, cache);
        const builtAt = performance.now();
        new WebAssembly.Module(batch.module);
        const compiledAt = performance.now();
        sum.total += compiledAt - startAt;
        sum.emit += batch.emitMs;
        sum.encode += batch.encodeMs;
        sum.form += builtAt - startAt - batch.emitMs - batch.encodeMs;
        sum.compile += compiledAt - builtAt;
        hash.update(batch.module).update(JSON.stringify(batch.results));
        sum.bytesOut += batch.module.length;
        for (const [i, job] of (data.relink?.jobs ?? data.jobs ?? []).entries())
        {
            const key = data.relink
                ? `${job.entry}:${job.entryTop}:${job.hash}:${JSON.stringify(job.targets)}`
                : `${job.region.entry}:${job.entryTop}:${job.region.hash}`;
            sum.jobs++;
            sum.again += seen.has(key) ? 1 : 0;
            seen.add(key);
            const result = batch.results[i];
            if (result.ok)
            {
                sum.instructions += result.region.instructions;
            }
            else
            {
                sum.failed++;
            }
        }
    }
    const gc = profiler.stop();
    let allocated = 0;
    let usedBefore = usedAt;
    for (const one of gc?.statistics ?? [])
    {
        sum.gcMs += one.cost / 1000;
        allocated += Math.max(0, one.beforeGC.heapStatistics.usedHeapSize - usedBefore);
        usedBefore = one.afterGC.heapStatistics.usedHeapSize;
    }
    allocated += Math.max(0, process.memoryUsage().heapUsed - usedBefore);
    sum.allocatedMb = allocated / (1 << 20);
    sum.digest = hash.digest('hex').slice(0, 16);
    return sum;
}

async function replay(){
    const passes = Math.max(1, Number(flag('--passes', '5')));
    // `--roots '{"base":"DIR","new":"DIR"}'`: trees side by side in this
    // process, their passes alternating, each round's figures sharing the
    // machine's conditions; the ratio is the median of the rounds' own.
    /** @type {Record<string, string>} */
    const roots = JSON.parse(flag('--roots', 'null')) ?? { tree: root.href };
    /** @type {Record<string, any>} */
    const trees = {};
    for (const [label, path] of Object.entries(roots))
    {
        const at = path.startsWith('file:') ? path : pathToFileURL(resolve(path)).href + '/';
        trees[label] = await import(new URL('modules/cork/src/runtime/emit-built.js', at).href);
    }
    const labels = Object.keys(trees);
    const names = pick(readdirSync(dir).filter(file=>file.endsWith('.cap'))
        .map(file=>file.slice(0, -4)));
    const rows = [];
    for (const name of names)
    {
        const messages = messagesOf(resolve(dir, `${name}.cap`));
        /** @type {Record<string, ReturnType<typeof pass>[]>} */
        const timed = Object.fromEntries(labels.map(label=>[label, []]));
        for (let round = 0; round < passes; round++)
        {
            for (const label of round % 2 === 0 ? labels : [...labels].reverse())
            {
                timed[label].push(pass(trees[label], messages));
            }
        }
        for (const label of labels)
        {
            const all = timed[label];
            const from = all.length > 2 ? 2 : 0;
            const warm = all.slice(from);
            /** @param {'total' | 'form' | 'emit' | 'encode' | 'compile' | 'gcMs' | 'allocatedMb'} key */
            const warmOf = key=>median(warm.map(one=>one[key]));
            const [cold] = all;
            const base = timed[labels[0]];
            rows.push({
                name, ...(labels.length > 1 ? { tree: label } : {}), messages: messages.length,
                jobs: cold.jobs, again: cold.again, failed: cold.failed,
                instructions: cold.instructions, kbOut: Math.round(cold.bytesOut / 1024),
                coldMs: Number(cold.total.toFixed(1)),
                coldUsPerRegion: Number((cold.total * 1000 / cold.jobs).toFixed(1)),
                warmMs: Number(warmOf('total').toFixed(1)),
                warmUsPerRegion: Number((warmOf('total') * 1000 / cold.jobs).toFixed(1)),
                warmNsPerInstr: Number((warmOf('total') * 1e6 / cold.instructions).toFixed(0)),
                ...(labels.length > 1 ? { ratio: Number(median(warm.map((one, i)=>
                    one.total / base[i + from].total)).toFixed(3)) } : {}),
                form: Number(warmOf('form').toFixed(1)),
                emit: Number(warmOf('emit').toFixed(1)),
                encode: Number(warmOf('encode').toFixed(1)),
                compile: Number(warmOf('compile').toFixed(1)),
                gcMs: Number(warmOf('gcMs').toFixed(1)),
                allocMb: Number(warmOf('allocatedMb').toFixed(1)),
                digest: cold.digest,
            });
        }
    }
    if (args.includes('--json'))
    {
        console.log(JSON.stringify(rows));
    }
    else
    {
        console.table(rows);
    }
}

if (mode === 'capture')
{
    await capture();
}
else if (mode === 'replay')
{
    await replay();
}
else
{
    console.error('usage: translate.mjs capture|replay DIR [name...] [options]');
    process.exitCode = 2;
}
