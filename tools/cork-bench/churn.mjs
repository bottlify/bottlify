/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a long run costs the engine thread besides the guest's own code: the
 * translator building regions again -- relinks, merges, the regions formed
 * again with their indirect calls' callees -- and publishing them, on a program
 * that keeps bringing new code rather than a loop that settles once.
 *
 *   node tools/cork-bench/churn.mjs [name...] [--instructions N] [--cork JSON]
 *       [--against JSON] [--bound R] [--root DIR] [--json]
 *
 * Each workload of `soak/` (`world`: a game's frame of entities, systems and
 * phases, `src/world.mjs`) runs on the cork host with a translation worker,
 * once under `--cork` (default: `callTargets` and `dispatch` on) and once
 * under `--against` (default: both off), each in a process of its own, for
 * `--instructions` guest instructions (default 1.5 G). The worker's answer is
 * waited for before the next slice: a worker on a core of its own that never
 * paces the run, and the same run however loaded the machine is. The engine
 * thread's own CPU time is read around each slice, each `translatePending` and
 * each turn in which the worker's answers are published (Linux's per-thread
 * schedstat; wall time elsewhere, which a loaded machine inflates). Reported:
 * that time per million guest instructions, split three ways; the longest
 * turn and the 99.9th percentile; the regions, modules, relinks, merges and
 * reforms; how many times the worker was sent each region (its first
 * translation and every build after); untranslated exits per million; and a
 * digest of the program's checksum over its first 400 iterations, which the two
 * configurations must agree on.
 *
 * It passes when, on every workload, the digests agree and the engine thread's
 * time per instruction under `--cork` is at most `--bound` (default 1.25) times
 * that under `--against`, and exits 1 otherwise: a feature that costs the engine
 * thread more than it saves over a long run is a regression, however well the
 * benchmark's loops do.
 */

import '../chromium-v8.mjs';
import { execFileSync } from 'node:child_process';
import { openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const root = pathToFileURL(resolve(flag('--root', fileURLToPath(new URL('../..', import.meta.url))))
    + '/');
const soak = new URL('soak/', import.meta.url);

/** The calling thread's CPU milliseconds, or wall milliseconds where the system has no such count. */
const threadMs = (()=>{
    try
    {
        const fd = openSync('/proc/thread-self/schedstat', 'r');
        const buffer = Buffer.alloc(64);
        return ()=>{
            const length = readSync(fd, buffer, 0, 64, 0);
            const text = buffer.toString('latin1', 0, length);
            return Number(text.slice(0, text.indexOf(' '))) / 1e6;
        };
    }
    catch {
        return ()=>performance.now();
    }
})();

/**
 * One run, in this process: a workload under one configuration.
 *
 * @param {string} name @param {Record<string, unknown>} cork @param {number} instructions
 */
async function one(name, cork, instructions){
    const { Worker } = await import('node:worker_threads');
    // Every region the runtime sends the worker, and each answer: the run waits
    // for the answer before the next slice.
    let posted = 0;
    let answered = 0;
    const unanswered = ()=>answered < posted;
    /** @type {Map<string, number>} */
    const sent = new Map();
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(/** @type {any[]} */ ...message){
        posted++;
        for (const job of message[0]?.relink?.jobs ?? [])
        {
            const key = `${job.entry}:${job.entryTop}`;
            sent.set(key, (sent.get(key) ?? 0) + 1);
        }
        return post.apply(this, /** @type {any} */ (message));
    };
    const emit = Worker.prototype.emit;
    Worker.prototype.emit = function(/** @type {string | symbol} */ event, /** @type {any[]} */ ...rest){
        const handled = emit.call(this, event, ...rest);
        answered += event === 'message' ? 1 : 0;
        return handled;
    };
    const { createCorkHost } = await import(
        new URL('modules/core/src/layers/cpu/internal/cork-host.js', root).href);
    const engine = await import(new URL('modules/cork/src/index.js', root).href);
    const host = createCorkHost({
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: 0x800000,
        cork: { workerUrl: new URL('modules/cork/src/runtime/translator.worker.js', root).href,
            ...cork },
    });
    host.writePhysical(0x401000, readFileSync(new URL(`${name}.bin`, soak)));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, 0x401000, true);
    host.writePhysical(0x7000, vector);
    const spent = { slices: 0, pending: 0, answers: 0 };
    /** @type {number[]} */
    const turns = [];
    let retired = 0;
    let iterations = 0;
    let digest = 0x811c9dc5;
    while (retired < instructions)
    {
        const startAt = threadMs();
        retired += host.runSlice(100_000);
        const ranAt = threadMs();
        host.cork().translatePending().catch(()=>{});
        const pendingAt = threadMs();
        await new Promise(turn=>setImmediate(turn));
        while (unanswered())
        {
            await new Promise(turn=>setTimeout(turn, 1));
        }
        const doneAt = threadMs();
        spent.slices += ranAt - startAt;
        spent.pending += pendingAt - ranAt;
        spent.answers += doneAt - pendingAt;
        turns.push(doneAt - startAt);
        if (host.halted())
        {
            if (iterations < 400)
            {
                digest = Math.imul(digest ^ (host.readReg32('eax') >>> 0), 0x01000193) >>> 0;
            }
            iterations++;
        }
    }
    const d = host.cork().diagnostics();
    await host.cork().flush();
    const perM = (/** @type {number} */ ms)=>Number((ms / retired * 1e6).toFixed(3));
    turns.sort((a, b)=>b - a);
    const counts = [...sent.values()];
    return {
        name, cork, instructions: retired, iterations,
        digest: iterations >= 400 ? digest.toString(16) : `only ${iterations} iterations`,
        engineMsPerM: perM(spent.slices + spent.pending + spent.answers),
        slicesMsPerM: perM(spent.slices), pendingMsPerM: perM(spent.pending),
        answersMsPerM: perM(spent.answers),
        worstMs: Number(turns[0].toFixed(1)),
        p999Ms: Number(turns[Math.floor(turns.length / 1000)].toFixed(1)),
        regions: d.regions, modules: d.modules, relinks: d.relinks, relinked: d.relinked,
        merges: d.merges, merged: d.merged ?? null, reforms: d.reforms, copied: d.copied,
        sent: counts.reduce((sum, count)=>sum + count, 0), sentRegions: counts.length,
        sentMost: Math.max(0, ...counts), sentOver4: counts.filter(count=>count > 4).length,
        untranslatedPerM: Number((d.exits.untranslated / retired * 1e6).toFixed(1)),
    };
}

if (args[0] === '--one')
{
    console.log(JSON.stringify(await one(args[1], JSON.parse(args[2]), Number(args[3]))));
    process.exit(0);
}

const instructions = Number(flag('--instructions', '1500000000'));
const configs = {
    cork: JSON.parse(flag('--cork', '{"callTargets":true,"dispatch":true}')),
    against: JSON.parse(flag('--against', '{"callTargets":false,"dispatch":false}')),
};
const bound = Number(flag('--bound', '1.25'));
const only = args.filter((arg, at)=>!arg.startsWith('--') && !args[at - 1]?.startsWith('--'));
const names = readdirSync(soak).filter(file=>file.endsWith('.bin')).map(file=>file.slice(0, -4))
    .filter(name=>only.length === 0 || only.some(prefix=>name.startsWith(prefix))).sort();
const rows = [];
let failed = false;
for (const name of names)
{
    /** @type {Record<string, any>} */
    const runs = {};
    for (const [label, cork] of Object.entries(configs))
    {
        runs[label] = JSON.parse(execFileSync(process.execPath,
            [...process.execArgv, fileURLToPath(import.meta.url), '--one', name,
                JSON.stringify(cork), String(instructions), '--root', fileURLToPath(root)],
            { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop() ?? '{}');
        rows.push({ label, ...runs[label], cork: JSON.stringify(cork) });
    }
    const ratio = runs.cork.engineMsPerM / runs.against.engineMsPerM;
    const agree = runs.cork.digest === runs.against.digest;
    const pass = agree && ratio <= bound;
    failed ||= !pass;
    rows.push({ label: pass ? 'PASS' : 'FAIL', name,
        engineMsPerM: Number(ratio.toFixed(2)), digest: agree ? 'agree' : 'DIFFER' });
}
if (args.includes('--json'))
{
    console.log(JSON.stringify(rows));
}
else
{
    console.table(rows);
}
process.exit(failed ? 1 : 0);
