/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What happened between two of the launcher's reports of one run (Download
 * report, or drive.mjs's `/report`): the frames the graphics worker made and
 * the rate, the host calls by the time they took -- calls, seconds, calls a
 * frame, microseconds a call -- and what was sent to the worker. A window of a
 * scene measured, rather than a whole run with its loading in it.
 *
 *   node tools/cdp_test/live/report-diff.mjs <before.json> <after.json> [top=30]
 */
import { readFileSync } from 'node:fs';

const [before, after, top = '30'] = process.argv.slice(2);
if (!before || !after)
{
    console.log('usage: report-diff.mjs <before.json> <after.json> [top]');
    process.exit(1);
}
/** @param {string} file */
const load = file=>JSON.parse(readFileSync(file, 'utf8'));
/** @param {any} report @param {string} name */
const metrics = (report, name)=>{
    const tables = report.engine?.diagnostics;
    return (Array.isArray(tables) ? tables : Object.values(tables ?? {}))
        .find((/** @type {any} */ table)=>table.name === name)?.metrics;
};
/** @param {any} report @returns {Map<string, { calls: number, ms: number }>} */
const byFunction = report=>new Map((metrics(report, 'bridge')?.byFunction ?? [])
    .map((/** @type {string} */ line)=>/^(\S+) (\d+) (\d+)ms/.exec(line))
    .filter(Boolean)
    .map((/** @type {RegExpExecArray} */ m)=>[m[1].replace(/\{[^}]+\}/, 'I'),
        { calls: Number(m[2]), ms: Number(m[3]) }]));

const a = load(before);
const b = load(after);
const worker = (/** @type {any} */ report)=>metrics(report, 'graphics')?.worker;
const frames = (worker(b)?.frames ?? NaN) - (worker(a)?.frames ?? NaN);
const seconds = (Date.parse(b.at) - Date.parse(a.at)) / 1000;
const was = byFunction(a);
const rows = [...byFunction(b)]
    .map(([name, now])=>({ name, calls: now.calls - (was.get(name)?.calls ?? 0),
        ms: now.ms - (was.get(name)?.ms ?? 0) }))
    .filter(row=>row.calls > 0)
    .sort((x, y)=>y.ms - x.ms);
const hostMs = rows.reduce((sum, row)=>sum + row.ms, 0);
console.log(`${seconds.toFixed(0)} s, ${frames} frames (${(frames / seconds).toFixed(1)} fps),`
    + ` host calls ${(hostMs / 1000).toFixed(1)} s`);
const sent = (/** @type {any} */ report)=>worker(report)?.sent;
const shipped = (/** @type {any} */ report)=>worker(report)?.shipped;
if (sent(a) && sent(b))
{
    const mb = (/** @type {number} */ bytes)=>(bytes / 1e6 / frames).toFixed(2);
    console.log(`to the worker a frame: ${mb(sent(b).bytes - sent(a).bytes)} MB sent,`
        + ` ${mb((shipped(b)?.buffers ?? 0) - (shipped(a)?.buffers ?? 0))} MB of buffers,`
        + ` ${mb((shipped(b)?.compared ?? 0) - (shipped(a)?.compared ?? 0))} MB compared`);
}
for (const row of rows.slice(0, Number(top)))
{
    console.log(row.name.padEnd(46), String(row.calls).padStart(9),
        `${(row.ms / 1000).toFixed(2).padStart(7)} s`,
        `${(row.calls / frames).toFixed(2).padStart(8)}/frame`,
        `${(row.ms / row.calls * 1000).toFixed(0).padStart(6)} us`);
}
