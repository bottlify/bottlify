/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How long a span of frames took, from the presents file the game report
 * writes beside itself (`game-<stamp>-presents.json`).
 *
 *   node tools/frame-span.mjs <presents.json>... [--skip N] [--frames N] [--seconds A-B]
 *
 * The span starts `--skip` frames (default 100) after the end of the load --
 * the last gap of 1.5 s or more in the first two thirds of the run -- and runs
 * `--frames` (default 500) frames. A program whose simulation
 * advances one step a frame (Doom 3's `com_fixedTic 1`) draws the same frames
 * in every run it is given no input in, so two runs over the same span did the
 * same work and their milliseconds a frame compare.
 *
 * And how evenly the span's frames came: the gaps between its presents at the
 * median, the 95th and 99th percentile and the worst, and how many were a
 * hitch -- over twice the median, or over 100 ms. A mean that holds while
 * these move is a run that stutters at the same frame rate. `--frames 0` runs
 * the span to the last present. `--seconds A-B` takes the presents from A to B
 * seconds after the first instead, as the report's frame series counts them:
 * for a program whose load ends in frames of their own (a film).
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {number} */ fallback)=>(
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const skip = flag('--skip', 100);
const frames = flag('--frames', 500);
const seconds = args.includes('--seconds')
    ? args[args.indexOf('--seconds') + 1].split('-').map(Number) : null;
const files = args.filter((one, at)=>!one.startsWith('--') && !args[at - 1]?.startsWith('--'));

for (const file of files)
{
    /** @type {number[]} */
    const times = JSON.parse(readFileSync(file, 'utf8'));
    // The load is over at the last long stall of the first two thirds: a map
    // load stalls for seconds at a time, and play after it does not.
    let loaded = -1;
    for (let i = 1; i < times.length * 2 / 3; i++)
    {
        if (times[i] - times[i - 1] >= 1500)
        {
            loaded = i;
        }
    }
    let from = loaded + skip;
    let to = frames > 0 ? from + frames : times.length - 1;
    if (seconds !== null)
    {
        from = times.findIndex(at=>at - times[0] >= seconds[0] * 1000);
        to = times.findLastIndex(at=>at - times[0] <= seconds[1] * 1000);
        if (from < 0 || to <= from)
        {
            console.log(`${file}: ${times.length} presents, none ${args[args.indexOf('--seconds')
                + 1]} s after the first`);
            continue;
        }
    }
    else if (loaded < 0 || to >= times.length)
    {
        console.log(`${file}: ${times.length} presents, no span of ${frames} frames`
            + ` ${skip} after the load`);
        continue;
    }
    const ms = times[to] - times[from];
    const count = to - from;
    console.log(`${file}: frames ${from}-${to} (load ended at ${loaded}):`
        + ` ${(ms / count).toFixed(1)} ms a frame, ${(1000 * count / ms).toFixed(1)} fps`);
    const gaps = times.slice(from + 1, to + 1).map((at, i)=>at - times[from + i]);
    const sorted = [...gaps].sort((left, right)=>left - right);
    const at = (/** @type {number} */ share)=>sorted[Math.min(sorted.length - 1,
        Math.floor(sorted.length * share))];
    const median = at(0.5);
    const over = (/** @type {number} */ bound)=>gaps.filter(gap=>gap > bound).length;
    console.log(`  gaps ms: median ${median.toFixed(1)}, p95 ${at(0.95).toFixed(1)},`
        + ` p99 ${at(0.99).toFixed(1)}, max ${at(1).toFixed(1)}; hitches: ${over(2 * median)}`
        + ` over twice the median, ${over(100)} over 100 ms, of ${gaps.length}`);
}
