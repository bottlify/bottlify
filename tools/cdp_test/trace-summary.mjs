/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A performance trace a person recorded in the browser (DevTools' Performance
 * panel, saved as `Trace-*.json.gz`), read for where the time went: each
 * thread's busy time as a share of the trace, and for every thread the
 * sampler covered, its JavaScript functions by self time. Which thread a slow
 * scene was spent on -- the engine worker, the graphics worker, the page, the
 * GPU process -- and what in it, without opening the panel.
 *
 *   node tools/cdp_test/trace-summary.mjs <Trace-*.json.gz>
 *
 * A function is named with its file and line in the build that ran; the
 * readable build (`BOTTLIFY_READABLE=1`) keeps the engine's own names.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const raw = JSON.parse(gunzipSync(readFileSync(process.argv[2])).toString());
const events = Array.isArray(raw) ? raw : raw.traceEvents;
/** @type {Map<string, string>} */
const names = new Map();
for (const event of events)
{
    if (event.ph === 'M' && event.name === 'thread_name')
    {
        names.set(`${event.pid}:${event.tid}`, event.args.name);
    }
}

// Busy time: the tasks each thread's scheduler ran, summed.
/** @type {Map<string, number>} */
const busy = new Map();
let first = Infinity;
let last = 0;
for (const event of events)
{
    if (event.ts)
    {
        first = Math.min(first, event.ts);
        last = Math.max(last, event.ts + (event.dur ?? 0));
    }
    if (event.ph === 'X' && event.dur
        && (event.name === 'RunTask' || event.name === 'ThreadControllerImpl::RunTask'))
    {
        const key = `${event.pid}:${event.tid}`;
        busy.set(key, (busy.get(key) ?? 0) + event.dur);
    }
}
const span = (last - first) / 1000;
console.log(`span ${span.toFixed(0)} ms`);
for (const [key, us] of [...busy].sort((a, b)=>b[1] - a[1]).slice(0, 12))
{
    console.log(`${(names.get(key) ?? key).padEnd(28)} busy`
        + ` ${(us / 1000).toFixed(0).padStart(6)} ms`
        + `  ${(us / 10 / span).toFixed(0)}%`);
}

// The sampler's profiles: each a tree of nodes and the samples that land on them.
/** @type {Map<string, { tid: number, pid: number, nodes: Map<number, any>,
 *     samples: number[], deltas: number[] }>} */
const profiles = new Map();
for (const event of events)
{
    if (event.name !== 'Profile' && event.name !== 'ProfileChunk')
    {
        continue;
    }
    const id = `${event.pid}:${event.id}`;
    let profile = profiles.get(id);
    if (!profile)
    {
        profile = { tid: event.tid, pid: event.pid, nodes: new Map(), samples: [], deltas: [] };
        profiles.set(id, profile);
    }
    const chunk = event.args?.data?.cpuProfile;
    for (const node of chunk?.nodes ?? [])
    {
        profile.nodes.set(node.id, node);
    }
    profile.samples.push(...chunk?.samples ?? []);
    profile.deltas.push(...event.args?.data?.timeDeltas ?? []);
}
for (const [id, profile] of profiles)
{
    /** @type {Map<string, number>} */
    const self = new Map();
    for (let at = 0; at < profile.samples.length; at++)
    {
        const frame = profile.nodes.get(profile.samples[at])?.callFrame;
        const key = frame
            ? `${frame.functionName || '(anonymous)'} `
                + `${String(frame.url ?? '').split('/').pop()}:${frame.lineNumber + 1}`
            : '?';
        self.set(key, (self.get(key) ?? 0) + (profile.deltas[at + 1] ?? 0));
    }
    const total = [...self.values()].reduce((sum, us)=>sum + us, 0);
    if (total < 50000)
    {
        continue;
    }
    const thread = names.get(`${profile.pid}:${profile.tid}`) ?? profile.tid;
    console.log(`
== profile ${id}, thread ${thread}, ${(total / 1000).toFixed(0)} ms sampled`);
    for (const [key, us] of [...self].sort((a, b)=>b[1] - a[1]).slice(0, 18))
    {
        console.log(`  ${(us / 1000).toFixed(0).padStart(6)} ms`
            + ` ${(us / total * 100).toFixed(1).padStart(5)}%  ${key}`);
    }
}
