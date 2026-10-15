/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Two arms of the calling-convention benchmark timed in pairs (`measurePaired`):
 * for each workload the ratio B / A of every pair, its median, and how many
 * pairs B won -- a sign test that the machine's noise between runs does not
 * decide, as it decides two arms' medians taken apart.
 *
 *     node --no-liftoff modules/cork/bench/calls/paired.mjs [options]
 *
 *   --a state  --b state-live   the arms (default: cork's call, and its ceiling)
 *   --depth n             chain depth (default 8)
 *   --pairs n             pairs (default 15)
 *   --ms n                milliseconds a run (default 200)
 *   --only farcry,spread  workloads (default all)
 *   --tier name           what the flags chose, written into the result
 *   --out file.json       every pair's values
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { measurePaired } from './calls.mjs';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const a = flag('--a', 'state');
const b = flag('--b', 'state-live');
const depth = Number(flag('--depth', '8'));
const pairs = Number(flag('--pairs', '15'));
const ms = Number(flag('--ms', '200'));
const only = flag('--only', '');
const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));
const workloads = profiles.workloads.filter((/** @type {any} */ w)=>
    only === '' || only.split(',').includes(w.name));

const result = {
    tier: flag('--tier', 'not given'),
    environment: { runtime: `node ${process.version}`, v8: process.versions.v8, arch: arch(),
        platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'not recorded',
        cores: cpus().length, power: 'not recorded' },
    options: { a, b, depth, pairs, ms },
    /** @type {any[]} */
    rows: [],
};
for (const w of workloads)
{
    const values = await measurePaired({ ...w, depth }, a, b, { pairs, ms });
    const ratios = values.map(v=>v.ratio).sort((x, y)=>x - y);
    const median = ratios[ratios.length >> 1];
    const won = ratios.filter(r=>r < 1).length;
    result.rows.push({ workload: w.name, values, median, won });
    console.log(`${w.name.padEnd(9)} ${b}/${a} median ${median.toFixed(3)}`
        + `  [${ratios[0].toFixed(3)} .. ${ratios[ratios.length - 1].toFixed(3)}]`
        + `  ${b} faster in ${won} of ${ratios.length}`);
}
const out = flag('--out', '');
if (out !== '')
{
    writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
}
