/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translator's stand from the command line (`stand.js`; the page is
 * `index.html`): the micro workloads on the guest's own clock, their work held
 * to `expected.json` and their time per arm.
 *
 *     node tools/bench/stand.mjs [--roots A,B] [--bits 32|64|both] [--only a,b]
 *         [--warm N] [--rounds N] [--window MS] [--work] [--write] [--json]
 *
 *   --roots   checkouts to compare (default this one); the first is the base
 *   --work    the work alone, no time: what a gate runs (exit 1 on a difference)
 *   --write   record the last arm's work (the newest checkout) as `expected.json`
 *   --window  virtual milliseconds of guest work a timed round runs (default 30)
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { geomean, runStand } from './stand.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EXPECTED = join(HERE, 'expected.json');
const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const option = (name, fallback)=>(args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]
    : fallback);
const roots = option('roots', resolve(HERE, '../..')).split(',').map(root=>resolve(root));
const widths = { 32: [32], 64: [64], both: [32, 64] }[option('bits', 'both')] ?? [32, 64];
const only = option('only', '');
const workOnly = args.includes('--work') || args.includes('--write');

/** @param {string} root */
async function armOf(root){
    const { createCorkHost } = await import(pathToFileURL(
        join(root, 'modules/core/src/layers/cpu/internal/cork-host.js')).href);
    const engine = await import(pathToFileURL(join(root, 'modules/cork/src/index.js')).href);
    return { createCorkHost, engine, label: root };
}

/** The workloads of the first checkout, by width. @param {string} root */
function workloadsOf(root){
    return widths.flatMap(bits=>{
        const dir = join(root, 'modules/cork/bench/micro', bits === 64 ? 'images64' : 'images');
        return readdirSync(dir).filter(file=>file.endsWith('.bin')).sort()
            .map(file=>({ name: file.slice(0, -4), bits: /** @type {32 | 64} */ (bits),
                image: new Uint8Array(readFileSync(join(dir, file))) }));
    }).filter(one=>only === '' || only.split(',').some(prefix=>one.name.startsWith(prefix)));
}

const recorded = JSON.parse(readFileSync(EXPECTED, 'utf8'));
const warm = Number(option('warm', String(recorded.warm)));
const arms = await Promise.all(roots.map(armOf));
const rows = await runStand(arms, workloadsOf(roots[0]), {
    warm, rounds: Number(option('rounds', '7')), windowMs: Number(option('window', '30')),
    now: ()=>performance.now(), timed: !workOnly,
    expected: warm === recorded.warm ? recorded.workloads : undefined,
    onRow: row=>{
        if (args.includes('--json'))
        {
            console.log(JSON.stringify(row));
            return;
        }
        const work = row.expected === null ? 'not recorded' : row.expected ? 'as recorded'
            : 'DIFFERS from the record';
        const time = row.mips === undefined ? ''
            : `${row.mips.map((/** @type {number} */ m)=>m.toFixed(0).padStart(6)).join(' /')} MIPS`
                + (row.ratio.length > 1 ? `  ratio ${row.ratio.slice(1)
                    .map((/** @type {number} */ r)=>r.toFixed(3)).join(' ')}` : '')
                + `  noise ±${(row.noise * 100).toFixed(1)} %`;
        const parted = row.same ? '' : ', arms differ';
        console.log(`${row.name.padEnd(24)} ${time}  work ${work}${parted}`);
    },
});
if (!workOnly && !args.includes('--json'))
{
    for (const bits of widths)
    {
        const mean = geomean(rows.filter(row=>row.bits === bits));
        if (mean !== null)
        {
            const each = mean.map(m=>m.toFixed(0)).join(' / ');
            console.log(`geometric mean, ${bits}-bit: ${each} MIPS`);
        }
    }
}
if (args.includes('--write'))
{
    // A run of some workloads keeps the others' record (`--only`); another
    // `--warm` starts the record afresh.
    const kept = warm === recorded.warm ? recorded.workloads : {};
    writeFileSync(EXPECTED, `${JSON.stringify({ warm, workloads: { ...kept, ...Object.fromEntries(
        rows.map(row=>[row.name, { bits: row.bits, work: row.work.at(-1) }])) } }, null, 1)}\n`);
    console.log(`expected.json: ${rows.length} workloads at ${warm} iterations`);
}
else if (rows.some(row=>row.expected === false || !row.same))
{
    process.exitCode = 1;
}
