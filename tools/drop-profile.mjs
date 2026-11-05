/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the dropped frames did that the ordinary ones did not: a game report's
 * frames (`game-<stamp>-frames.json`) laid over the engine worker's CPU profile
 * (`game-<stamp>-cpu-0.cpuprofile`, from `game.mjs --worker --cpu-profile N`),
 * each function's self time per frame in the drops of a cause against the
 * ordinary frames of the same stretch.
 *
 *   node tools/drop-profile.mjs <report base> [--from S] [--to S] [--cause NAME] [--top N]
 *
 * The base is the report's path without its suffix. `--from`/`--to` take the
 * frames between those seconds of the frames' own time (as the scenes are
 * printed by the report), `--cause` the drops of one cause (all by default).
 *
 * The two clocks are laid together by the profile's anchor (`ANCHOR` in
 * cdp_test/profile.mjs): the worker's performance.now() when a function of its
 * own name began, and that function's first sample on the profile's clock. A
 * profile without one is refused rather than guessed at.
 */

import { readFileSync } from 'node:fs';
import { frameDrops } from '../modules/core/src/frame-drops.js';

const args = process.argv.slice(2);
const base = args.find((arg, place)=>!arg.startsWith('--')
    && !args[place - 1]?.startsWith('--'));
/** @param {string} name @param {number} fallback */
const flag = (name, fallback)=>(args.includes(name)
    ? Number(args[args.indexOf(name) + 1]) : fallback);
const cause = args.includes('--cause') ? args[args.indexOf('--cause') + 1] : null;
const top = flag('--top', 25);
if (!base)
{
    console.error('usage: node tools/drop-profile.mjs <report base> [--from S] [--to S] '
        + '[--cause NAME] [--top N]');
    process.exit(2);
}

const profile = JSON.parse(readFileSync(`${base}-cpu-0.cpuprofile`, 'utf8'));
/** @type {any[]} */
const frames = JSON.parse(readFileSync(`${base}-frames.json`, 'utf8'));
if (typeof profile.bottlifyAnchor !== 'number')
{
    console.error('the profile has no anchor: made before tools/cdp_test/profile.mjs set one');
    process.exit(1);
}
if (!frames.every(frame=>typeof frame.startedAt === 'number'))
{
    console.error('the frames have no start times: made before the harness kept them');
    process.exit(1);
}

/** @type {Map<number, any>} */
const nodes = new Map(profile.nodes.map((/** @type {any} */ node)=>[node.id, node]));
/** Each sample's time on the profile's clock, in microseconds, and its node. */
const times = [];
let clock = profile.startTime;
for (let i = 0; i < profile.samples.length; i++)
{
    clock += profile.timeDeltas[i] ?? 0;
    times.push(clock);
}
const anchorAt = profile.samples.findIndex((/** @type {number} */ id)=>
    nodes.get(id).callFrame.functionName === '__bottlifyAnchor__');
if (anchorAt < 0)
{
    console.error('the anchor was never sampled');
    process.exit(1);
}
// Microseconds on the profile's clock at the worker's performance.now() of 0.
const offset = times[anchorAt] - profile.bottlifyAnchor * 1000;

let at = 0;
for (const frame of frames)
{
    at += frame.ms;
    frame.at = at;
}
const from = flag('--from', 0) * 1000;
const to = flag('--to', Infinity) * 1000;
const stretch = frames.filter(frame=>frame.at >= from && frame.at < to && frame.ms < 1000);
const report = frameDrops(stretch);
const dropped = new Set(report.drops.filter(drop=>cause === null || drop.cause === cause)
    .map(drop=>drop.index));
const anyDrop = new Set(report.drops.map(drop=>drop.index));

/**
 * Self time by function over a set of frames, per frame.
 *
 * @param {any[]} chosen
 */
function selfTime(chosen){
    /** @type {Map<string, number>} */
    const by = new Map();
    let total = 0;
    for (const frame of chosen)
    {
        const start = offset + frame.startedAt * 1000;
        const end = start + frame.ms * 1000;
        // Samples are sorted by time: find the first at or after the start.
        let lo = 0;
        let hi = times.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            if (times[mid] < start)
            {
                lo = mid + 1;
            }
            else
            {
                hi = mid;
            }
        }
        for (let i = lo; i < times.length && times[i] < end; i++)
        {
            const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000;
            const f = nodes.get(profile.samples[i]).callFrame;
            const key = `${f.functionName || '(anonymous)'}`
                + ` ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
            by.set(key, (by.get(key) ?? 0) + ms);
            total += ms;
        }
    }
    const count = Math.max(1, chosen.length);
    return { by: new Map([...by].map(([key, ms])=>[key, ms / count])), total: total / count };
}

const drops = selfTime(stretch.filter(frame=>dropped.has(frame.index)));
const ordinary = selfTime(stretch.filter(frame=>!anyDrop.has(frame.index)));
console.log(`${stretch.length} frames, ${dropped.size} drops${cause ? ` (${cause})` : ''};`
    + ` sampled ${drops.total.toFixed(2)} ms a drop,`
    + ` ${ordinary.total.toFixed(2)} ms an ordinary frame`);
console.log('  extra ms a drop  drop  ordinary  function');
const keys = new Set([...drops.by.keys(), ...ordinary.by.keys()]);
const rows = [...keys].map(key=>[key, (drops.by.get(key) ?? 0) - (ordinary.by.get(key) ?? 0)])
    .sort((one, two)=>Number(two[1]) - Number(one[1])).slice(0, top);
for (const [key, extra] of rows)
{
    const drop = (drops.by.get(String(key)) ?? 0).toFixed(3).padStart(6);
    const usual = (ordinary.by.get(String(key)) ?? 0).toFixed(3).padStart(8);
    console.log(`  ${Number(extra).toFixed(3).padStart(14)}  ${drop}  ${usual}  ${key}`);
}
