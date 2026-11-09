/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the run did over the next N seconds, not since it started: frames
 * presented, the engine thread's phases (guest; trap; idle-host, a thread
 * parked on a host call that answers later; yield; idle-message-wait) and
 * the host calls that took the most time, each as the difference of two
 * readings. A run's totals mix its menus and loads into the scene being
 * measured; a window of the scene is what a slow frame is made of.
 *
 *   node tools/cdp_test/live/phases.mjs [seconds=10] [windows=1] [top=8]
 *
 * The first process of the run answers (`diagnostics`); a child's are asked
 * through `app.debug.diagnosticsOf(id)`.
 */
import { connect } from './connect.mjs';

const seconds = Number(process.argv[2] ?? 10);
const windows = Number(process.argv[3] ?? 1);
const top = Number(process.argv[4] ?? 8);
const { evaluate } = await connect();

const READ = `(async()=>{
    const d = await window.__bottlify__.app.diagnostics();
    const of = name=>(Array.isArray(d) ? d.find(x=>x.name === name) : d[name])?.metrics ?? {};
    const phases = {};
    for (const line of of('log').topPhases ?? [])
    {
        const m = String(line).match(/^(\\S+) \\S+ x(\\d+) self=([\\d.]+)/);
        if (m) phases[m[1]] = [Number(m[2]), Number(m[3])];
    }
    const calls = {};
    for (const line of of('bridge').byFunction ?? [])
    {
        const m = String(line).match(/^(\\S+) (\\d+) (\\d+)ms/);
        if (m) calls[m[1]] = [Number(m[2]), Number(m[3])];
    }
    return JSON.stringify({ at: Date.now(), phases, calls,
        shown: of('graphics').presenter?.shown ?? null });
})()`;

/** @returns {Promise<any>} */
const read = async()=>JSON.parse(await evaluate(READ));

for (let window = 0; window < windows; window++)
{
    const before = await read();
    await new Promise(done=>setTimeout(done, seconds * 1000));
    const after = await read();
    const span = (after.at - before.at) / 1000;
    const frames = after.shown === null ? 'not measured' : after.shown - (before.shown ?? 0);
    console.log(`${span.toFixed(1)} s: ${frames} frames`);
    /** @param {Record<string, number[]>} now @param {Record<string, number[]>} then */
    const deltas = (now, then)=>Object.keys(now).map(name=>[name,
        now[name][1] - (then[name]?.[1] ?? 0), now[name][0] - (then[name]?.[0] ?? 0)])
        .filter(([, ms, count])=>Number(ms) > 0 || Number(count) > 0)
        .sort((a, b)=>Number(b[1]) - Number(a[1]));
    for (const [name, ms, count] of deltas(after.phases, before.phases).slice(0, top))
    {
        console.log(`  phase ${String(name).padEnd(20)} ${(Number(ms) / 1000).toFixed(2)} s`
            + `  x${count}`);
    }
    for (const [name, ms, count] of deltas(after.calls, before.calls).slice(0, top))
    {
        console.log(`  call  ${String(ms).padStart(6)} ms  x${String(count).padEnd(8)} ${name}`);
    }
}
process.exit(0);
