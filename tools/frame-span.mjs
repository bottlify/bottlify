/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How long a span of frames took, from the presents file the game report
 * writes beside itself (`game-<stamp>-presents.json`).
 *
 *   node tools/frame-span.mjs <presents.json>... [--skip N] [--frames N]
 *
 * The span starts `--skip` frames (default 100) after the end of the load --
 * the last gap of 1.5 s or more in the first two thirds of the run -- and runs
 * `--frames` (default 500) frames. A program whose simulation
 * advances one step a frame (Doom 3's `com_fixedTic 1`) draws the same frames
 * in every run it is given no input in, so two runs over the same span did the
 * same work and their milliseconds a frame compare.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {number} */ fallback)=>(
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const skip = flag('--skip', 100);
const frames = flag('--frames', 500);
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
    const from = loaded + skip;
    const to = from + frames;
    if (loaded < 0 || to >= times.length)
    {
        console.log(`${file}: ${times.length} presents, no span of ${frames} frames`
            + ` ${skip} after the load`);
        continue;
    }
    const ms = times[to] - times[from];
    console.log(`${file}: frames ${from}-${to} (load ended at ${loaded}):`
        + ` ${(ms / frames).toFixed(1)} ms a frame, ${(1000 * frames / ms).toFixed(1)} fps`);
}
