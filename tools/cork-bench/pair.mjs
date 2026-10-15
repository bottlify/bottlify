/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cork-bench paired in one node process (`paired.js`): a host for every arm,
 * blocks of iterations alternated, each arm reported as the median of the
 * rounds' ratios to the first arm with its quartiles. Arms name a tree each
 * (`root`, default this one) and a translator configuration (`cork`), as
 * `browser.mjs` takes them:
 *
 *     node --no-liftoff tools/cork-bench/pair.mjs [name...] --arms JSON
 *         [--warm 100] [--rounds 40] [--block 10] [--json]
 *
 * Two arms of the same tree are the control: their ratio is 1 within the
 * quartiles a run on this machine gives.
 */

import '../chromium-v8.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paired, summarise } from './paired.js';

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {string} */ fallback)=>
    (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
/** @type {Record<string, { root?: string, cork?: object }>} */
const arms = JSON.parse(flag('--arms', '{"a":{},"b":{}}'));
const labels = Object.keys(arms);
const plan = { warm: Number(flag('--warm', '100')), rounds: Number(flag('--rounds', '40')),
    block: Number(flag('--block', '10')) };
const only = args.filter((one, at)=>!one.startsWith('--') && !args[at - 1]?.startsWith('--'));
const images = new URL('images/', import.meta.url);
const names = readdirSync(images).filter(file=>file.endsWith('.bin'))
    .map(file=>file.slice(0, -4)).filter(name=>only.length === 0
        || only.some(prefix=>name.startsWith(prefix))).sort();

const loaded = [];
for (const label of labels)
{
    const tree = arms[label].root ?? new URL('../..', import.meta.url).pathname;
    const root = pathToFileURL(`${resolve(tree)}/`);
    loaded.push({
        ...await import(new URL('modules/core/src/layers/cpu/internal/cork-host.js', root).href),
        engine: await import(new URL('modules/cork/src/index.js', root).href),
        cork: arms[label].cork ?? {},
    });
}
const rows = [];
for (const name of names)
{
    const { times, eax } = paired(loaded, readFileSync(new URL(`${name}.bin`, images)), plan);
    rows.push(...summarise(labels, times).map((row, at)=>({ name, ...row, eax: eax[at] })));
}
if (args.includes('--json'))
{
    console.log(JSON.stringify(rows));
}
else
{
    for (const row of rows)
    {
        console.log(`${row.name.padEnd(16)} ${row.label.padEnd(10)}`
            + ` median ${row.median.toFixed(1)} us  ratio ${row.ratio.toFixed(3)}`
            + ` [${row.q25.toFixed(3)} ${row.q75.toFixed(3)}]`
            + `  eax ${row.eax}`);
    }
}
