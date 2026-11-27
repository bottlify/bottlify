/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A software sound mixer's x87 inner loops ([`program.js`](program.js)) on the cork host, as a
 * launch runs a program: each kernel in an image of its own, then all four in one. A call of
 * the program's `main` mixes one block of 1024 samples.
 *
 *     node modules/cork/bench/mixer/run.mjs [kernel...] [--warm N] [--iters N] [--reps N]
 *         [--cores N] [--ram MiB] [--cork JSON] [--json]
 *
 * Each rep makes a fresh host, runs `--warm` blocks (the interpreter, the translator, the
 * tier-up), then times `--iters` more. `usBlock` is the median rep's microseconds a block,
 * `min`/`max` the fastest and slowest rep (`--json` adds every rep's); `nsSample` the
 * median over the block's samples, `mips` guest instructions a second at the median,
 * `share` the instructions retired in translated code. `--cores 3` lays the memory out for
 * three executors with `atomic` on, as a process on a machine of several runs. After the
 * timed blocks the whole data area -- the outputs and every filter's and delay line's state
 * -- must equal what `reference` computes for the same number of blocks, byte for byte, or
 * the run fails.
 */

import { performance } from 'node:perf_hooks';
import { arch, cpus, platform } from 'node:os';
import { createCorkHost } from '../../../core/src/layers/cpu/internal/cork-host.js';
import * as engine from '../../src/index.js';
import { assemble, initialData, reference, DATA, DATA_SIZE, IMAGE_BASE, KERNELS, SAMPLES }
    from './program.js';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const warm = Number(flag('--warm', '30'));
const iters = Number(flag('--iters', '60'));
const reps = Number(flag('--reps', '7'));
const cores = Number(flag('--cores', '1'));
const ram = Number(flag('--ram', '16'));
const cork = { ...JSON.parse(flag('--cork', '{}')), ...(cores > 1 ? { atomic: true } : {}) };
const named = args.filter((one, at)=>!one.startsWith('--') && !args[at - 1]?.startsWith('--'));
const runs = named.length > 0 ? named.map(name=>(name === 'all' ? [...KERNELS] : [name]))
    : [...KERNELS.map(name=>[name]), [...KERNELS]];
for (const run of runs)
{
    if (run.some(name=>!(/** @type {readonly string[]} */ (KERNELS)).includes(name)))
    {
        throw new Error(`mixer: kernels are ${KERNELS.join(', ')} and all`);
    }
}

const ENTRY_VECTOR = 0x7000;

/** @param {Uint8Array} image */
function makeHost(image){
    const host = createCorkHost({
        engine, memorySize: ram << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, cork, ...(cores > 1 ? { executors: cores } : {}),
    });
    host.writePhysical(IMAGE_BASE, image);
    host.writePhysical(DATA, initialData());
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    return host;
}

/**
 * One call of `main`, to its `hlt`, in slices of the scheduler's quantum with the translator
 * fed between them, as frames feed it.
 *
 * @param {ReturnType<typeof makeHost>} host
 */
function block(host){
    let retired = host.runSlice(100_000);
    while (!host.halted())
    {
        host.cork().translatePending().catch(()=>{});
        retired += host.runSlice(100_000);
    }
    return retired;
}

/** @param {number[]} values */
const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];

const rows = [];
for (const run of runs)
{
    const image = assemble(run);
    /** @type {number[]} */
    const times = [];
    let summary = null;
    for (let rep = 0; rep < reps; rep++)
    {
        const host = makeHost(image);
        for (let i = 0; i < warm; i++)
        {
            block(host);
        }
        const before = host.cork().counters();
        let retired = 0;
        const startedAt = performance.now();
        for (let i = 0; i < iters; i++)
        {
            retired += block(host);
        }
        times.push((performance.now() - startedAt) * 1000 / iters);
        const after = host.cork().counters();
        if (rep === 0)
        {
            const expected = initialData();
            for (let i = 0; i < warm + iters; i++)
            {
                reference(expected, run);
            }
            const got = host.readPhysical(DATA, DATA_SIZE);
            const wrong = expected.findIndex((value, at)=>got[at] !== value);
            if (wrong >= 0)
            {
                throw new Error(`mixer: ${run.join('+')} differs from the reference at DATA+0x`
                    + `${wrong.toString(16)}: ${got[wrong]} where ${expected[wrong]} is right`);
            }
        }
        summary = {
            instructions: retired / iters,
            share: (after.retired - before.retired) / retired,
            regions: after.regions,
        };
    }
    if (summary === null)
    {
        continue;
    }
    const us = median(times);
    rows.push({
        kernel: run.length === KERNELS.length ? 'all' : run[0],
        usBlock: Number(us.toFixed(1)),
        min: Number(Math.min(...times).toFixed(1)),
        max: Number(Math.max(...times).toFixed(1)),
        nsSample: Number((us * 1000 / SAMPLES).toFixed(1)),
        instructions: Math.round(summary.instructions),
        mips: Math.round(summary.instructions / us),
        share: Number(summary.share.toFixed(3)),
        regions: summary.regions,
        checked: 'ok',
        ...(args.includes('--json') ? { reps: times.map(one=>Number(one.toFixed(1))) } : {}),
    });
}
const conditions = `node ${process.version} ${platform()}-${arch()}`
    + `, ${cpus()[0]?.model ?? 'cpu not recorded'}, ${cores} executor${cores > 1 ? 's' : ''}`
    + `, ${reps} reps of ${iters} blocks after ${warm}`
    + `, cork ${JSON.stringify(cork)}`;
if (args.includes('--json'))
{
    console.log(JSON.stringify({ conditions, rows }));
}
else
{
    console.log(conditions);
    console.table(rows);
}
