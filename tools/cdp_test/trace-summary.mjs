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
 *
 * Read an event at a time: a trace of a minute of play is past half a
 * gigabyte of JSON, more than one string may hold. Also printed: each
 * thread's garbage collection, and the longest tasks with where in the trace
 * they ran -- what a frame rate falling to nothing for a moment was spent on.
 */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

/** @type {any[]} */
const events = [];
/** The trace's own events, one a line as DevTools saves them, or whole when it is small. */
const lines = createInterface({ input: createReadStream(process.argv[2]).pipe(createGunzip()),
    crlfDelay: Infinity });
let inEvents = false;
/** @type {string[]} */
const whole = [];
for await (const line of lines)
{
    const text = line.trim();
    if (!inEvents)
    {
        whole.push(line);
        if (text.startsWith('"traceEvents"'))
        {
            inEvents = true;
            whole.length = 0;
        }
        continue;
    }
    if (!text.startsWith('{'))
    {
        continue;
    }
    const event = JSON.parse(text.endsWith(',') ? text.slice(0, -1) : text);
    // Only what is summed below is kept: a trace's events are millions.
    if (event.ph === 'M' || event.ph === 'X' || event.name === 'Profile'
        || event.name === 'ProfileChunk' || event.ts)
    {
        events.push(event.ph === 'X' || event.ph === 'M' || event.name === 'Profile'
            || event.name === 'ProfileChunk' ? event : { ts: event.ts });
    }
}
if (!inEvents)
{
    const raw = JSON.parse(whole.join('\n'));
    events.push(...Array.isArray(raw) ? raw : raw.traceEvents);
}
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

// Garbage collection by thread, and the longest tasks: a moment the frame rate
// fell to nothing is a task that held a thread, or a collection.
/** @type {Map<string, number>} */
const gc = new Map();
/** @type {{ key: string, ts: number, dur: number }[]} */
const tasks = [];
for (const event of events)
{
    if (event.ph !== 'X' || !event.dur)
    {
        continue;
    }
    const key = `${event.pid}:${event.tid}`;
    if (/^(MajorGC|MinorGC|V8\.GC_MARK_COMPACTOR|V8\.GC_SCAVENGER)$/.test(event.name))
    {
        gc.set(key, (gc.get(key) ?? 0) + event.dur);
    }
    if (event.name === 'RunTask' || event.name === 'ThreadControllerImpl::RunTask')
    {
        tasks.push({ key, ts: event.ts, dur: event.dur });
    }
}
for (const [key, us] of [...gc].sort((a, b)=>b[1] - a[1]).slice(0, 8))
{
    console.log(`${(names.get(key) ?? key).padEnd(28)} gc  `
        + ` ${(us / 1000).toFixed(0).padStart(6)} ms`);
}
console.log('\nlongest tasks (at, from the trace\'s start):');
tasks.sort((a, b)=>b.dur - a.dur);
for (const task of tasks.slice(0, 20))
{
    console.log(`  ${(task.dur / 1000).toFixed(0).padStart(6)} ms at`
        + ` ${((task.ts - first) / 1000).toFixed(0).padStart(6)} ms`
        + `  ${names.get(task.key) ?? task.key}`
        + `  (${task.key})`);
}
// What the five longest held: the events inside each on its thread, by name.
for (const task of tasks.slice(0, 5))
{
    /** @type {Map<string, number>} */
    const inside = new Map();
    for (const event of events)
    {
        if (event.ph === 'X' && event.dur && `${event.pid}:${event.tid}` === task.key
            && event.ts >= task.ts && event.ts < task.ts + task.dur
            && event.name !== 'RunTask' && event.name !== 'ThreadControllerImpl::RunTask')
        {
            inside.set(event.name, (inside.get(event.name) ?? 0) + event.dur);
        }
    }
    console.log(`\n  inside the ${(task.dur / 1000).toFixed(0)} ms task at`
        + ` ${((task.ts - first) / 1000).toFixed(0)} ms:`);
    for (const [name, us] of [...inside].sort((a, b)=>b[1] - a[1]).slice(0, 8))
    {
        console.log(`    ${(us / 1000).toFixed(1).padStart(7)} ms  ${name}`);
    }
}

// The sampler's profiles: each a tree of nodes and the samples that land on them.
/** @type {Map<string, { tid: number, pid: number, start: number, nodes: Map<number, any>,
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
        profile = { tid: event.tid, pid: event.pid, start: 0, nodes: new Map(), samples: [],
            deltas: [] };
        profiles.set(id, profile);
    }
    if (event.name === 'Profile')
    {
        profile.start = event.args?.data?.startTime ?? event.ts;
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
== profile ${id}, thread ${thread} (${profile.pid}:${profile.tid}),`
        + ` ${(total / 1000).toFixed(0)} ms sampled`);
    for (const [key, us] of [...self].sort((a, b)=>b[1] - a[1]).slice(0, 18))
    {
        console.log(`  ${(us / 1000).toFixed(0).padStart(6)} ms`
            + ` ${(us / total * 100).toFixed(1).padStart(5)}%  ${key}`);
    }
}

// The five longest tasks again, by what their thread's sampler caught in them.
/** @param {any} profile @param {number} from @param {number} to */
const sampledIn = (profile, from, to)=>{
    /** @type {Map<string, number>} */
    const self = new Map();
    let at = profile.start;
    for (let index = 0; index < profile.samples.length; index++)
    {
        at += profile.deltas[index] ?? 0;
        if (at < from || at >= to)
        {
            continue;
        }
        const frame = profile.nodes.get(profile.samples[index])?.callFrame;
        const key = frame ? `${frame.functionName || '(anonymous)'} `
            + `${String(frame.url ?? '').split('/').pop()}:${frame.lineNumber + 1}` : '?';
        self.set(key, (self.get(key) ?? 0) + (profile.deltas[index + 1] ?? 0));
    }
    return self;
};
for (const task of tasks.slice(0, 5))
{
    const [pid, tid] = task.key.split(':').map(Number);
    const profile = [...profiles.values()].find(one=>one.pid === pid && one.tid === tid);
    if (!profile)
    {
        continue;
    }
    console.log(`
== sampled in the ${(task.dur / 1000).toFixed(0)} ms task at`
        + ` ${((task.ts - first) / 1000).toFixed(0)} ms (${task.key})`);
    for (const [key, us] of [...sampledIn(profile, task.ts, task.ts + task.dur)]
        .sort((a, b)=>b[1] - a[1]).slice(0, 10))
    {
        console.log(`  ${(us / 1000).toFixed(0).padStart(6)} ms  ${key}`);
    }
}

// `--window FROM-TO` (milliseconds from the trace's start): each sampled
// thread's functions inside that stretch alone -- a slow frame a report names,
// found again in the trace by its time.
const windowAt = process.argv.indexOf('--window');
if (windowAt > 0)
{
    const [from, to] = String(process.argv[windowAt + 1]).split('-').map(Number);
    for (const profile of profiles.values())
    {
        const self = sampledIn(profile, first + from * 1000, first + to * 1000);
        const busyUs = [...self].filter(([key])=>!key.startsWith('(idle)'))
            .reduce((sum, [, us])=>sum + us, 0);
        if (busyUs < 20_000)
        {
            continue;
        }
        console.log(`\n== ${from}-${to} ms, ${names.get(`${profile.pid}:${profile.tid}`) ?? ''}`
            + ` (${profile.pid}:${profile.tid}), ${(busyUs / 1000).toFixed(0)} ms busy`);
        for (const [key, us] of [...self].sort((a, b)=>b[1] - a[1]).slice(0, 12))
        {
            console.log(`  ${(us / 1000).toFixed(0).padStart(6)} ms  ${key}`);
        }
        // And by the script each function is in: the guest's own translated
        // code (a module per region, `r<address>`), the translator, the engine.
        /** @type {Map<string, number>} */
        const byFile = new Map();
        for (const [key, us] of self)
        {
            const file = /^r[0-9a-f]{8} /.test(key) ? '(guest code)'
                : key.slice(key.lastIndexOf(' ') + 1).replace(/:(\d+|NaN)$/, '') || '?';
            byFile.set(file, (byFile.get(file) ?? 0) + us);
        }
        console.log('  by script:', [...byFile].sort((a, b)=>b[1] - a[1]).slice(0, 8)
            .map(([file, us])=>`${file} ${(us / 1000).toFixed(0)} ms`).join(', '));
    }
}

// `--buckets MS`: each of the four busiest threads' busy share in every
// stretch of that length, as a row of percentages -- where in the trace a
// thread was held, to find a report's slow frame by its shape.
const bucketsAt = process.argv.indexOf('--buckets');
if (bucketsAt > 0)
{
    const width = Number(process.argv[bucketsAt + 1]) * 1000;
    const count = Math.ceil((last - first) / width);
    for (const [key] of [...busy].sort((a, b)=>b[1] - a[1]).slice(0, 4))
    {
        const share = new Array(count).fill(0);
        for (const task of tasks)
        {
            if (task.key !== key)
            {
                continue;
            }
            for (let at = task.ts; at < task.ts + task.dur;)
            {
                const index = Math.floor((at - first) / width);
                const end = Math.min(task.ts + task.dur, first + (index + 1) * width);
                share[index] += end - at;
                at = end;
            }
        }
        console.log(`\n${names.get(key) ?? key} (${key}), busy % per ${width / 1000} ms:`);
        console.log(share.map(us=>String(Math.round(us / width * 100)).padStart(4)).join(''));
    }
}
