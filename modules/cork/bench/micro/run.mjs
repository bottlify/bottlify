/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The micro workloads (README, "Micro workloads"): flat images loaded at
 * 0x401000 and run on the cork host to their `hlt`, one call of `main` an
 * iteration -- what the PE benchmark does not cover: the x86-64 twins
 * (`images64/`, `--bits 64`), calls through a table of 8, 512 or 4096 functions
 * in order or scattered (`calls*`), and a routine that patches its own code
 * (`patch`). The 32-bit images are also the fixtures of cork's emitter tests
 * and of the emit digest (`tools/emit-digest.mjs`).
 *
 *   node modules/cork/bench/micro/run.mjs [name...] [--warm N] [--iters N] [--reps N]
 *       [--cork JSON] [--bits 64] [--blocks DIR] [--json]
 *
 * Each rep makes a fresh host and times its first iteration (`coldMs`: the
 * interpreter, the translator and the tier-up), runs `--warm` iterations and
 * times `--iters` more (`usPerIter`, the best rep: translated code in its
 * steady state). `eax` is the program's own checksum and must not change with
 * the engine. `--cork` is the translator's configuration; `--blocks DIR` writes
 * the first rep's block counts to `DIR/<name>.blocks.json`, which
 * `tools/cork-asm.mjs --bin <image> --at 0x401000 --blocks` weighs, with the
 * run's count of each way between regions (`mechanisms`).
 */

import '../../../../tools/chromium-v8.mjs';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCorkHost } from '../../../core/src/layers/cpu/internal/cork-host.js';
import * as engine from '../../src/index.js';
import { median, option } from '../../../../tools/common.mjs';

const args = process.argv.slice(2);
const warm = Number(option(args, '--warm', '20'));
const iters = Number(option(args, '--iters', '40'));
const reps = Number(option(args, '--reps', '5'));
const cork = JSON.parse(option(args, '--cork', '{}') ?? '{}');
const bits = Number(option(args, '--bits', '32'));
const blocksDir = option(args, '--blocks', '') ?? '';
const only = args.filter((one, at)=>!one.startsWith('--') && !args[at - 1]?.startsWith('--'));
if (blocksDir !== '')
{
    cork.blockProfile = true;
}

const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;
const images = new URL(bits === 64 ? 'images64/' : 'images/', import.meta.url);
const names = readdirSync(images).filter(file=>file.endsWith('.bin'))
    .map(file=>file.slice(0, -4)).filter(name=>only.length === 0
        || only.some(prefix=>name.startsWith(prefix))).sort();

/** @param {Uint8Array} image */
function makeHost(image){
    const host = createCorkHost({
        engine, memorySize: 16 << 20, trapPort: 0xb077, entryVector: ENTRY_VECTOR,
        initialStack: 0x800000, cork, ...(bits === 64 ? { bits } : {}),
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

const rows = [];
for (const name of names)
{
    const image = readFileSync(new URL(`${name}.bin`, images));
    /** @type {number[]} */
    const steady = [];
    /** @type {number[]} */
    const colds = [];
    let summary = null;
    for (let rep = 0; rep < reps; rep++)
    {
        const host = makeHost(image);
        const coldAt = performance.now();
        iteration(host);
        colds.push(performance.now() - coldAt);
        for (let i = 1; i < warm; i++)
        {
            iteration(host);
        }
        const before = host.cork().counters();
        const startedAt = performance.now();
        let retired = 0;
        for (let i = 0; i < iters; i++)
        {
            retired += iteration(host);
        }
        steady.push((performance.now() - startedAt) * 1000 / iters);
        if (blocksDir !== '' && rep === 0)
        {
            mkdirSync(blocksDir, { recursive: true });
            const { blockCounts, mechanisms } = host.cork().diagnostics();
            writeFileSync(join(blocksDir, `${name}.blocks.json`),
                JSON.stringify({ blocks: blockCounts, mechanisms }));
        }
        const after = host.cork().counters();
        summary = {
            instructions: retired / iters,
            share: (after.retired - before.retired) / retired,
            regions: after.regions,
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
        usPerIter: Number(best.toFixed(1)),
        nsPerInstr: Number((best * 1000 / summary.instructions).toFixed(3)),
        instructions: Math.round(summary.instructions),
        share: Number(summary.share.toFixed(3)),
        regions: summary.regions,
        eax: summary.eax,
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
