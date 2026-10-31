/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A window of a frame series (`game.mjs --series N`, `game-<stamp>-series.json`) by thread and
 * by executor, a frame: what each thread retired, the ms it held an executor, the ms it waited
 * ready for one (contention), the ms its slices on another executor waited for the process's
 * answers, and the rate it ran at in the rest; then each executor's slices, answers, idle time
 * and what it retired. A frame rate bound by one thread shows as that thread's held ms near
 * the frame's; one bound by the scheduler as its ready ms.
 *
 *   node tools/cdp_test/thread-window.mjs <series.json> [--from S] [--to S]
 *
 * Without --from/--to the last window; with them, the rows whose time falls in [from, to].
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {any} before  the series row the window starts after
 * @param {any} row     the row it ends at
 * @param {number} [frames]  frames in the window (the rows' sum when several)
 * @returns {string[]}
 */
export function threadWindow(before, row, frames = row.frames){
    const per = 1 / Math.max(1, frames);
    const lines = [`threads a frame from ${(before.at / 1000).toFixed(0)} s to ${
        (row.at / 1000).toFixed(0)} s (${frames} frames, ${((row.at - before.at) * per).toFixed(1)
    } ms wall a frame): M instr, held ms, ready ms, answer-wait ms, host-call ms, crossings,`
        + ' M instr/s computing (held less answer waits)'];
    const rows = Object.entries(row.threadTimes ?? {}).map(([name, now])=>{
        const was = before.threadTimes?.[name] ?? [0, 0, 0, 0, 0, 0];
        const d = now.map((/** @type {number} */ value, /** @type {number} */ at)=>
            (value - was[at]) * per);
        return { name, d };
    }).filter(one=>one.d[0] > 0 || one.d[1] > 0.05 || one.d[2] > 0.05)
        .sort((left, right)=>right.d[0] - left.d[0]);
    for (const { name, d } of rows.slice(0, 10))
    {
        const computing = d[1] - d[3];
        lines.push(`  ${name.padEnd(10)} ${(d[0] / 1e6).toFixed(2).padStart(7)}  ${d[1].toFixed(1)
            .padStart(6)}  ${d[2].toFixed(1).padStart(6)}  ${d[3].toFixed(1).padStart(6)}  ${
            d[4].toFixed(1).padStart(6)}  ${d[5].toFixed(0).padStart(5)}  ${computing > 0.05
            ? (d[0] / computing / 1000).toFixed(0).padStart(5) : '    -'}`);
    }
    const own = row.executors?.own;
    const ownWas = before.executors?.own;
    if (own && ownWas)
    {
        /** @param {string} key */
        const d = key=>(own[key] - ownWas[key]) * per;
        const retired = (d('hereRetired') / 1e6).toFixed(2);
        lines.push(`executors a frame: e0 own slices ${d('hereMs').toFixed(1)} ms`
            + ` (retired ${retired} M), answering ${d('answerMs').toFixed(1)} ms,`
            + ` waiting ${d('waitMs').toFixed(1)} ms,`
            + ` between turns ${d('betweenMs').toFixed(1)} ms,`
            + ` crossings ${d('crossings').toFixed(0)}`);
    }
    for (const one of row.executors?.remotes ?? [])
    {
        const was = before.executors?.remotes
            ?.find((/** @type {any} */ e)=>e.index === one.index);
        if (!was || one.slicesMs === null || was.slicesMs === null)
        {
            lines.push(`  e${one.index}: not measured`);
            continue;
        }
        const slices = (one.slicesMs - was.slicesMs) * per;
        const waits = (one.answerWaitMs - was.answerWaitMs) * per;
        const retired = (one.retired - was.retired) * per;
        const traps = ((one.traps - was.traps) * per).toFixed(0);
        const idle = ((one.idleMs - was.idleMs) * per).toFixed(1);
        const rate = slices - waits > 0.05 ? (retired / (slices - waits) / 1000).toFixed(0) : '-';
        lines.push(`  e${one.index}: slices ${slices.toFixed(1)} ms, answer waits`
            + ` ${waits.toFixed(1)} ms (${traps} traps), idle ${idle} ms,`
            + ` retired ${(retired / 1e6).toFixed(2)} M, ${rate} M/s computing`);
    }
    lines.push(...waitWindow(before, row, frames));
    return lines;
}

/**
 * The host's waits a frame by what was waited on (the kernel's `sync.waits`:
 * taken at once, blocked, a poll timed out) and the semaphores' releases and
 * the wakes among them: which waits guest code could answer.
 *
 * @param {any} before @param {any} row @param {number} frames
 * @returns {string[]}
 */
export function waitWindow(before, row, frames){
    if (typeof row.sync?.waits !== 'string' || typeof before.sync?.waits !== 'string')
    {
        return ['host waits a frame: not measured'];
    }
    const per = 1 / Math.max(1, frames);
    const now = JSON.parse(row.sync.waits);
    const was = JSON.parse(before.sync.waits);
    const lines = ['host waits a frame by kind: taken, blocked, polls timed out'];
    for (const [kind, counts] of Object.entries(now))
    {
        /** @param {string} key */
        const d = key=>((/** @type {any} */ (counts)[key] - (was[kind]?.[key] ?? 0)) * per)
            .toFixed(1);
        lines.push(`  ${kind.padEnd(22)} ${d('taken').padStart(7)} ${d('blocked').padStart(7)}`
            + ` ${d('timedOut').padStart(7)}`);
    }
    const releases = ((row.sync.semaphoreReleases ?? 0) - (before.sync.semaphoreReleases ?? 0))
        * per;
    const wakes = ((row.sync.semaphoreWakes ?? 0) - (before.sync.semaphoreWakes ?? 0)) * per;
    lines.push(`  ReleaseSemaphore ${releases.toFixed(1)}, waking a thread ${wakes.toFixed(1)}`);
    return lines;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    const [file, ...rest] = process.argv.slice(2);
    if (!file)
    {
        console.error('usage: node tools/cdp_test/thread-window.mjs <series.json>'
            + ' [--from S] [--to S]');
        process.exit(2);
    }
    /** @param {string} flag */
    const arg = flag=>{
        const at = rest.indexOf(flag);
        return at < 0 ? null : Number(rest[at + 1]);
    };
    const series = JSON.parse(readFileSync(file, 'utf8'));
    const rows = Array.isArray(series) ? series : series.series ?? series.rows;
    const from = arg('--from');
    const to = arg('--to');
    let first = rows.length - 2;
    let last = rows.length - 1;
    if (from !== null || to !== null)
    {
        const inside = rows.map((/** @type {any} */ r, /** @type {number} */ i)=>[r, i])
            .filter(([r])=>r.at / 1000 >= (from ?? 0) && r.at / 1000 <= (to ?? Infinity))
            .map(([, i])=>i);
        if (inside.length < 2)
        {
            console.error('not measured: fewer than two rows in that window');
            process.exit(1);
        }
        first = inside[0];
        last = inside[inside.length - 1];
    }
    /** @type {any[]} */
    const window = rows.slice(first + 1, last + 1);
    const frames = window.reduce((sum, r)=>sum + r.frames, 0);
    const avg = (/** @type {string} */ key)=>window.reduce((sum, r)=>sum + r[key] * r.frames, 0)
        / Math.max(1, frames);
    const draws = (rows[last].draws - rows[first].draws) / Math.max(1, frames);
    const calls = (rows[last].calls - rows[first].calls) / Math.max(1, frames);
    const instructions = rows[last].instructions === null ? 'not measured'
        : ((rows[last].instructions - rows[first].instructions) / Math.max(1, frames) / 1e6)
            .toFixed(1);
    console.log(`frame ${avg('frameMs').toFixed(1)} ms, host ${avg('hostMs').toFixed(1)} ms,`
        + ` guest ${avg('guestMs').toFixed(1)} ms, draws ${draws.toFixed(0)},`
        + ` host calls ${calls.toFixed(0)}, M instr ${instructions}`);
    for (const line of threadWindow(rows[first], rows[last], frames))
    {
        console.log(line);
    }
}
