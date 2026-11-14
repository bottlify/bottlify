/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What happened between two of the launcher's reports of one run (Download
 * report, drive.mjs's `/report`, or a game.mjs report), or since the run began
 * with one: the frames the graphics worker made and the rate, the host calls by
 * the time they took -- calls, seconds, calls a frame, microseconds a call --
 * what was sent to the worker, and the GPU side: the GPU's own time by pass
 * (timestamp queries, a diagnostics build on a device that stamps) and the
 * pipelines built with the part of their key that kept moving -- a value of the
 * state written into a shader builds a pipeline every time it changes. A window
 * of a scene measured, rather than a whole run with its loading in it.
 *
 *   node tools/live/live.mjs diff [<before.json>] <after.json> [--top 30]
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const topAt = argv.indexOf('--top');
const top = topAt >= 0 ? Number(argv[topAt + 1]) : 30;
const files = argv.filter((arg, at)=>!arg.startsWith('--') && at !== topAt + 1);
if (files.length === 0 || files.length > 2)
{
    console.log('usage: report-diff.mjs [<before.json>] <after.json> [--top N]');
    process.exit(1);
}
/** @param {string} file */
const load = file=>JSON.parse(readFileSync(file, 'utf8'));
const b = load(files.at(-1) ?? '');
const a = files.length === 2 ? load(files[0]) : {};
/** @param {any} report @param {string} name */
const metrics = (report, name)=>{
    // A launcher's report keeps the engine's tables under `engine`, game.mjs's at its top.
    const tables = report.engine?.diagnostics ?? report.diagnostics;
    return (Array.isArray(tables) ? tables : Object.values(tables ?? {}))
        .find((/** @type {any} */ table)=>table.name === name)?.metrics;
};
/** @param {any} report @returns {Map<string, { calls: number, ms: number }>} */
const byFunction = report=>new Map((metrics(report, 'bridge')?.byFunction ?? [])
    .map((/** @type {string} */ line)=>/^(\S+) (\d+) (\d+)ms/.exec(line))
    .filter(Boolean)
    .map((/** @type {RegExpExecArray} */ m)=>[m[1].replace(/\{[^}]+\}/, 'I'),
        { calls: Number(m[2]), ms: Number(m[3]) }]));

const worker = (/** @type {any} */ report)=>metrics(report, 'graphics')?.worker;
const frames = (worker(b)?.frames ?? NaN) - (files.length === 2 ? worker(a)?.frames ?? NaN : 0);
const seconds = (Date.parse(b.at) - Date.parse(a.at)) / 1000;
const span = files.length < 2 ? 'since the start'
    : Number.isFinite(seconds) ? `${seconds.toFixed(0)} s` : 'time not in the reports';
const rate = files.length === 2 && Number.isFinite(frames / seconds)
    ? ` (${(frames / seconds).toFixed(1)} fps)` : '';
const was = byFunction(a);
const rows = [...byFunction(b)]
    .map(([name, now])=>({ name, calls: now.calls - (was.get(name)?.calls ?? 0),
        ms: now.ms - (was.get(name)?.ms ?? 0) }))
    .filter(row=>row.calls > 0)
    .sort((x, y)=>y.ms - x.ms);
const hostMs = rows.reduce((sum, row)=>sum + row.ms, 0);
console.log(`${span}, ${Number.isFinite(frames) ? frames : 'not measured:'} frames${rate},`
    + ` host calls ${(hostMs / 1000).toFixed(1)} s`);
const sent = (/** @type {any} */ report)=>worker(report)?.sent;
const shipped = (/** @type {any} */ report)=>worker(report)?.shipped;
if (sent(b))
{
    const mb = (/** @type {number} */ bytes)=>(bytes / 1e6 / frames).toFixed(2);
    console.log(`to the worker a frame: ${mb(sent(b).bytes - (sent(a)?.bytes ?? 0))} MB sent,`
        + ` ${mb((shipped(b)?.buffers ?? 0) - (shipped(a)?.buffers ?? 0))} MB of buffers,`
        + ` ${mb((shipped(b)?.compared ?? 0) - (shipped(a)?.compared ?? 0))} MB compared`);
}
for (const row of rows.slice(0, top))
{
    console.log(row.name.padEnd(46), String(row.calls).padStart(9),
        `${(row.ms / 1000).toFixed(2).padStart(7)} s`,
        `${(row.calls / frames).toFixed(2).padStart(8)}/frame`,
        `${(row.ms / row.calls * 1000).toFixed(0).padStart(6)} us`);
}

/** @param {any} value @param {string} key @param {number} [depth] @returns {any[]} */
const findAll = (value, key, depth = 0)=>{
    if (!value || typeof value !== 'object' || depth > 14)
    {
        return [];
    }
    const here = key in value ? [value[key]] : [];
    return [...here, ...Object.values(value).flatMap(child=>findAll(child, key, depth + 1))];
};
/** The worker's devices, each with its timing, its programs and its passes. @param {any} report */
const devicesOf = report=>(findAll(report, 'timing').length > 0
    ? findAll(report, 'gpuPasses').filter(Boolean).map((gpuPasses, index)=>({
        gpuPasses,
        fixed: findAll(report, 'fixedPipelines')[index] ?? null,
        programs: findAll(report, 'programs').find(one=>one && 'built' in one) ?? null,
    }))
    : []);

const later = devicesOf(b);
const earlier = devicesOf(a);
if (later.length === 0)
{
    console.log('GPU: no device in the report, not measured');
}
later.forEach((device, index)=>{
    const before = earlier[index];
    const passes = device.gpuPasses;
    console.log(`== GPU device ${index}`);
    if (!passes?.available)
    {
        console.log('GPU time by pass: not measured (no timestamp-query on this device, or a'
            + ' production build)');
    }
    else
    {
        const had = new Map((before?.gpuPasses?.byLabel ?? [])
            .map((/** @type {any} */ entry)=>[entry.label, entry]));
        const timed = passes.frames - (before?.gpuPasses?.frames ?? 0);
        const gpuMs = passes.gpuMs - (before?.gpuPasses?.gpuMs ?? 0);
        console.log(`GPU time: ${gpuMs.toFixed(1)} ms over ${timed} timed submits`
            + ` (${timed > 0 ? (gpuMs / timed).toFixed(2) : '-'} ms each),`
            + ` ${passes.untimed} untimed, ${passes.unpaired ?? 0} passes whose stamps are no time`
            + (passes.lastUnpaired?.length ? ` (last ${passes.lastUnpaired.join(' ')})` : ''));
        passes.byLabel
            .map((/** @type {any} */ entry)=>({ ...entry,
                ms: entry.ms - (had.get(entry.label)?.ms ?? 0),
                passes: entry.passes - (had.get(entry.label)?.passes ?? 0) }))
            .filter((/** @type {any} */ entry)=>entry.passes > 0)
            .sort((/** @type {any} */ x, /** @type {any} */ y)=>y.ms - x.ms)
            .slice(0, 15)
            .forEach((/** @type {any} */ entry)=>console.log(
                `  ${entry.ms.toFixed(1).padStart(9)} ms  ${String(entry.passes).padStart(6)}`
                + ` passes  ${(entry.ms / entry.passes).toFixed(3)} ms each  ${entry.label}`));
    }
    for (const [name, cache, prior] of /** @type {[string, any, any][]} */ ([
        ['fixed-function pipelines', device.fixed, before?.fixed],
        ['shader pipelines', device.programs, before?.programs]]))
    {
        if (!cache)
        {
            console.log(`${name}: not reported`);
            continue;
        }
        const built = cache.built - (prior?.built ?? 0);
        console.log(`${name}: ${built} built, ${cache.reused - (prior?.reused ?? 0)} reused,`
            + ` ${(cache.buildMs ?? 0) - (prior?.buildMs ?? 0)} ms waiting for builds`);
        for (const churn of cache.churn ?? [])
        {
            console.log(`  key part ${churn.part} changed ${churn.count} times,`
                + ` last ${churn.from} -> ${churn.to}`);
        }
        if (built > 0 && (cache.latest ?? []).length > 0)
        {
            console.log(`  last built: ${cache.latest[cache.latest.length - 1].slice(0, 300)}`);
        }
    }
});
