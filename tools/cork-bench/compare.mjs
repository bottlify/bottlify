/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Two or more engines, or configurations, side by side on the benchmark.
 *
 *   node tools/cork-bench/compare.mjs '{"base":["--root","../base"],"new":[]}'
 *       [name...] [--metric usPerIter|coldMs|nsPerInstr] [--runs N] [bench options...]
 *
 * Each configuration is a list of `bench.mjs` arguments (`--root`, `--cork`);
 * node's own flags (`--no-liftoff`) are given to node running this script and
 * pass on to every run. Every workload runs in a process of its own per
 * configuration and run, the configurations interleaved, so one's JIT state
 * does not colour another's; the table has the median of `--runs` runs, the
 * first configuration's figure over each other's as the ratio, and the
 * geometric mean.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const args = process.argv.slice(2);
/** @type {Record<string, string[]>} */
const configs = JSON.parse(args[0]);
const rest = args.slice(1);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
const metric = flag('--metric', 'usPerIter');
const runs = Number(flag('--runs', '1'));
const ours = new Set(['--metric', '--runs']);
const passed = rest.filter((one, at)=>!ours.has(one) && !ours.has(rest[at - 1]));
const only = passed.filter((one, at)=>!one.startsWith('--') && !passed[at - 1]?.startsWith('--'));
const options = passed.filter(one=>!only.includes(one));
const names = readdirSync(new URL('images/', import.meta.url))
    .filter(file=>file.endsWith('.bin')).map(file=>file.slice(0, -4))
    .filter(name=>only.length === 0 || only.some(prefix=>name.startsWith(prefix))).sort();
const bench = new URL('bench.mjs', import.meta.url).pathname;
const labels = Object.keys(configs);

/** @type {Record<string, Record<string, number[]>>} */
const figures = {};
for (const name of names)
{
    for (let run = 0; run < runs; run++)
    {
        for (const label of labels)
        {
            const out = execFileSync(process.execPath,
                [...process.execArgv, bench, name, '--json', ...options, ...configs[label]],
                { maxBuffer: 1 << 26 }).toString();
            for (const row of JSON.parse(out.trim().split('\n').pop() ?? '[]'))
            {
                ((figures[row.name] ??= {})[label] ??= []).push(Number(row[metric]));
            }
        }
    }
}
/** @param {number[]} values */
const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];
/** @param {number[]} values */
const geomean = values=>Math.exp(values.reduce((sum, one)=>sum + Math.log(one), 0) / values.length);
const table = Object.entries(figures).map(([name, byLabel])=>[name,
    Object.fromEntries(labels.map(label=>[label, median(byLabel[label])]))]);
table.push(['geomean', Object.fromEntries(labels.map(label=>[label,
    geomean(table.map(([, row])=>row[label]))]))]);
console.table(table.map(([name, row])=>({
    name,
    ...Object.fromEntries(labels.map((label, at)=>[label, at === 0 ? row[label].toFixed(2)
        : `${row[label].toFixed(2)} (${(row[labels[0]] / row[label]).toFixed(2)}x)`])),
})));
