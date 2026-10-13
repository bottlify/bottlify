/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The calling-convention benchmark in Node: every workload of `profiles.json`
 * at every depth, every arm, then the parameter sweep; a table, and with
 * `--out` one JSON object of every run.
 *
 *     node --no-liftoff modules/cork/bench/calls/run.mjs [options]     # TurboFan
 *     node --liftoff --no-wasm-tier-up modules/cork/bench/calls/run.mjs  # Liftoff
 *
 *   --tier name          what the flags above chose, written into the result
 *   --runs n             timed runs of each (default 9)
 *   --ms n               milliseconds a run (default 200)
 *   --depths 2,8,32      chain depths (default 2,8,32)
 *   --only farcry,spread workloads (default all)
 *   --out file.json      every run's values
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { ARMS, measure, measureSweep, summary } from './calls.mjs';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const runs = Number(flag('--runs', '9'));
const ms = Number(flag('--ms', '200'));
const depths = flag('--depths', '2,8,32').split(',').map(Number);
const only = flag('--only', '');
const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));
const workloads = profiles.workloads.filter((/** @type {any} */ w)=>
    only === '' || only.split(',').includes(w.name));

const result = {
    tier: flag('--tier', 'not given'),
    environment: { runtime: `node ${process.version}`, v8: process.versions.v8, arch: arch(),
        platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'not recorded',
        cores: cpus().length, power: 'not recorded' },
    options: { runs, ms, depths },
    /** @type {any[]} */
    rows: [],
    /** @type {any[]} */
    sweep: [],
};
for (const w of workloads)
{
    for (const depth of depths)
    {
        /** @type {Record<string, ReturnType<typeof summary>>} */
        const by = {};
        /** @type {number[] | null} */
        let registers = null;
        for (const arm of ARMS)
        {
            const run = await measure({ ...w, depth }, arm, { runs, ms });
            if (registers !== null && run.registers.join() !== registers.join())
            {
                throw new Error(`${w.name} at depth ${depth}: ${arm} ended with other registers`);
            }
            registers = run.registers;
            by[arm] = summary(run.nsPerCall);
            result.rows.push({ workload: w.name, depth, arm, nsPerCall: run.nsPerCall,
                moduleBytes: run.moduleBytes, ...by[arm] });
        }
        const line = ARMS.map(arm=>`${arm} ${by[arm].median.toFixed(2)} (±${
            (100 * by[arm].spread).toFixed(0)}%)`).join('  ');
        console.log(`${w.name.padEnd(9)} depth ${String(depth).padStart(2)}  ${line}`
            + `  params/state ${(by.params.median / by.state.median).toFixed(3)}`
            + `  params/state-direct ${(by.params.median / by['state-direct'].median).toFixed(3)}`);
    }
}
for (const k of [2, 4, 5, 6, 7, 8, 10, 12, 16, 20])
{
    const run = await measureSweep(k, { runs, ms: Math.min(ms, 150) });
    const s = summary(run.nsPerCall);
    result.sweep.push({ k, nsPerCall: run.nsPerCall, ...s });
    console.log(`sweep k=${String(k).padStart(2)}  ${s.median.toFixed(2)} ns a call (±${
        (100 * s.spread).toFixed(0)}%)`);
}
const out = flag('--out', '');
if (out !== '')
{
    writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
}
