/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The frames a watched window actually holds.
 *
 * The profiler hands back a ring of its latest frames, and the ring is not the
 * window: a window that drew nothing still finds frames in it from before it
 * opened, and one longer than the ring finds only its tail. Each frame carries
 * the index it was presented at, and the snapshot taken as the window opened
 * says which index came next, so the two can be told apart.
 */

/** @param {number} value */
const asMs = value=>`${value.toFixed(2)}ms`;

/** @param {number[]} sorted @param {number} share */
const quantile = (sorted, share)=>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];

/**
 * @param {{ frames: number }} before  The profiler's snapshot as the window opened.
 * @param {{ frames: number, recentFrames: { index: number, ms: number }[] }} after
 * @returns {{ ms: number[], lines: string[] }}  The frame times, and how to say them.
 */
export function frameSpread(before, after){
    const ms = after.recentFrames
        .filter(frame=>frame.index >= before.frames)
        .map(frame=>frame.ms);
    const presented = after.frames - before.frames;
    if (ms.length === 0)
    {
        return { ms, lines: ['  no frame finished inside the window'] };
    }
    const sorted = [...ms].sort((one, two)=>one - two);
    const lines = [`  median ${asMs(quantile(sorted, 0.5))}`
        + `   ninety-fifth ${asMs(quantile(sorted, 0.95))}`
        + `   worst ${asMs(quantile(sorted, 1))}`];
    if (ms.length < presented)
    {
        lines.push(`  (the last ${ms.length} of ${presented} frames; the profiler keeps no more)`);
    }
    return { ms, lines };
}
