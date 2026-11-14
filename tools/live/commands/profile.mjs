/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `live.mjs profile`: where a thread's time went, from a CPU profile sampled
 * now from a worker of the running launcher, or from a `.cpuprofile` already
 * on disk (`--file`: one this command wrote, a `game.mjs --cpu-profile` run's,
 * one DevTools saved). One reader, three views:
 *
 *   (default)          how much was idle and collection, the functions by self
 *                      and by inclusive time, and every stretch of `--min` ms
 *                      or more outside translated guest code with when it
 *                      began -- the pauses a guest thread waited through;
 *   --callers REGEX    who calls the matching function: the paths up from it,
 *                      folded to `--depth` callers, by the samples under it;
 *   --drops FRAMES     what the dropped frames did that the ordinary ones did
 *                      not: a report's `game-<stamp>-frames.json` laid over the
 *                      profile by its anchor (`ANCHOR` in profile.mjs), each
 *                      function's self ms a frame in the drops against the rest.
 *
 *   node tools/live/live.mjs profile [seconds=20] [worker] [--min 50] [--out FILE]
 *   node tools/live/live.mjs profile --file F.cpuprofile [--callers REGEX [--depth 4]]
 *       [--drops F-frames.json [--from S] [--to S] [--cause NAME]] [--top 20]
 *
 * `worker` picks `graphics`, `executor`, `translator` (the n-th as
 * `executor#2`); the engine's worker without one. A profile sampled now is
 * written to `--out` (dbg/worker.cpuprofile) for the other views and DevTools.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { frameDrops } from '../../../modules/core/src/frame-drops.js';
import { option } from '../../common.mjs';

/** A frame as the views name it. @param {any} frame */
const nameOf = frame=>`${frame.functionName || '(anonymous)'} `
    + `${String(frame.url).split('/').pop()}:${frame.lineNumber + 1}`;

/** Translated regions are wasm with no script URL; the interpreter is too. @param {any} frame */
const isGuest = frame=>frame.url === ''
    && /^(r[0-9a-f]{8}|wasm-function|runInteger|x87|js-to-wasm)/.test(frame.functionName);

/** @param {Map<string, number>} table @param {number} count */
const top = (table, count)=>[...table].sort((a, b)=>b[1] - a[1]).slice(0, count);

/**
 * The default view: self and inclusive time, and the stretches outside guest code.
 *
 * @param {any} profile @param {{ minMs?: number, top?: number, began?: number }} [options]
 * @returns {string[]}
 */
export function timeView(profile, { minMs = 50, top: count = 20, began } = {}){
    const byId = new Map(profile.nodes.map((/** @type {any} */ node)=>[node.id, node]));
    /** @type {Map<number, number>} */
    const parent = new Map();
    for (const node of profile.nodes)
    {
        for (const child of node.children ?? [])
        {
            parent.set(child, node.id);
        }
    }
    /** @type {Map<string, number>} */
    const self = new Map();
    /** @type {Map<string, number>} */
    const inclusive = new Map();
    /** @type {{ at: number, ms: number, self: Map<string, number> }[]} */
    const stretches = [];
    /** @type {{ at: number, ms: number, self: Map<string, number> } | null} */
    let stretch = null;
    let clock = 0;
    let idle = 0;
    let collection = 0;
    profile.samples.forEach((/** @type {number} */ id, /** @type {number} */ index)=>{
        const ms = (profile.timeDeltas[index] ?? 0) / 1000;
        clock += ms;
        const frame = byId.get(id).callFrame;
        const name = nameOf(frame);
        self.set(name, (self.get(name) ?? 0) + ms);
        idle += frame.functionName === '(idle)' ? ms : 0;
        collection += frame.functionName === '(garbage collector)' ? ms : 0;
        const seen = new Set();
        for (let at = id; at !== undefined; at = parent.get(at))
        {
            const outer = nameOf(byId.get(at).callFrame);
            if (!seen.has(outer))
            {
                seen.add(outer);
                inclusive.set(outer, (inclusive.get(outer) ?? 0) + ms);
            }
        }
        if (isGuest(frame) || frame.functionName === '(idle)')
        {
            if (stretch && stretch.ms >= minMs)
            {
                stretches.push(stretch);
            }
            stretch = null;
            return;
        }
        stretch ??= { at: clock, ms: 0, self: new Map() };
        stretch.ms += ms;
        stretch.self.set(name, (stretch.self.get(name) ?? 0) + ms);
    });
    const total = Math.max(clock, 1e-9);
    const share = (/** @type {number} */ ms)=>`${(100 * ms / total).toFixed(1).padStart(5)}%`;
    const when = (/** @type {number} */ at)=>(began === undefined ? `${(at / 1000).toFixed(1)} s`
        : new Date(began + at).toLocaleTimeString());
    return [
        `${clock.toFixed(0)} ms sampled: idle ${share(idle)},`
            + ` garbage collection ${share(collection)}`,
        'self:', ...top(self, count).map(([name, ms])=>`  ${share(ms)}  ${name}`),
        'inclusive:', ...top(inclusive, count).map(([name, ms])=>`  ${share(ms)}  ${name}`),
        `stretches of ${minMs} ms or more outside guest code: ${stretches.length}`,
        ...stretches.slice(0, count).map(({ at, ms, self: own })=>
            `  ${when(at)} ${ms.toFixed(0)} ms: `
            + top(own, 4).map(([name, spent])=>`${name}=${spent.toFixed(0)}`).join(', ')),
    ];
}

/**
 * Who calls the functions whose name matches: the time of every sample whose
 * stack holds a matching frame counts once, for the callers above the innermost
 * such frame. Weighed by time, as the default view's self time is: samples come
 * at uneven intervals, and a count of them disagrees with the time they stand for.
 *
 * @param {any} profile @param {RegExp} wanted @param {{ depth?: number, top?: number }} [options]
 * @returns {string[]}
 */
export function callersView(profile, wanted, { depth = 4, top: count = 15 } = {}){
    const nodes = new Map(profile.nodes.map((/** @type {any} */ node)=>[node.id, node]));
    /** @type {Map<number, number>} */
    const parents = new Map();
    for (const node of profile.nodes)
    {
        for (const child of node.children ?? [])
        {
            parents.set(child, node.id);
        }
    }
    /** @type {Map<number, number>} */
    const hits = new Map();
    let total = 0;
    profile.samples.forEach((/** @type {number} */ id, /** @type {number} */ index)=>{
        const ms = (profile.timeDeltas?.[index] ?? 1000) / 1000;
        hits.set(id, (hits.get(id) ?? 0) + ms);
        total += ms;
    });
    total = Math.max(total, 1e-9);
    /** @type {Map<string, number>} */
    const paths = new Map();
    let matched = 0;
    for (const [id, samples] of hits)
    {
        let at = /** @type {number | undefined} */ (id);
        while (at !== undefined && !wanted.test(nameOf(nodes.get(at).callFrame)))
        {
            at = parents.get(at);
        }
        if (at === undefined)
        {
            continue;
        }
        matched += samples;
        const chain = [];
        for (let up = parents.get(at); up !== undefined && chain.length < depth;
            up = parents.get(up))
        {
            chain.push(nameOf(nodes.get(up).callFrame));
        }
        const key = chain.join('  <  ');
        paths.set(key, (paths.get(key) ?? 0) + samples);
    }
    return [`${wanted.source}: ${matched.toFixed(0)} of ${total.toFixed(0)} ms`
        + ` (${(matched / total * 100).toFixed(1)}%)`,
    ...top(paths, count).map(([key, ms])=>
        `  ${(ms / total * 100).toFixed(1).padStart(5)}%  ${key}`)];
}

/**
 * What the dropped frames did that the ordinary ones of the same stretch did not.
 *
 * @param {any} profile @param {any[]} frames
 * @param {{ from?: number, to?: number, cause?: string | null, top?: number }} [options]
 * @returns {string[]}
 */
export function dropsView(profile, frames, options = {}){
    const { from = 0, to = Infinity, cause = null, top: count = 25 } = options;
    if (typeof profile.bottlifyAnchor !== 'number')
    {
        return ['not measured: the profile has no anchor (profile.mjs sets one on a harness run)'];
    }
    if (!frames.every(frame=>typeof frame.startedAt === 'number'))
    {
        return ['not measured: the frames have no start times'];
    }
    const nodes = new Map(profile.nodes.map((/** @type {any} */ node)=>[node.id, node]));
    /** Each sample's time on the profile's clock, in microseconds. */
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
        return ['not measured: the anchor was never sampled'];
    }
    // Microseconds on the profile's clock at the worker's performance.now() of 0.
    const offset = times[anchorAt] - profile.bottlifyAnchor * 1000;
    let at = 0;
    const timed = frames.map(frame=>{
        at += frame.ms;
        return { ...frame, at };
    });
    const stretch = timed.filter(frame=>frame.at >= from * 1000 && frame.at < to * 1000
        && frame.ms < 1000);
    const report = frameDrops(stretch);
    const dropped = new Set(report.drops.filter(drop=>cause === null || drop.cause === cause)
        .map(drop=>drop.index));
    const anyDrop = new Set(report.drops.map(drop=>drop.index));
    /** Self ms a frame by function, over a set of frames. @param {any[]} chosen */
    const selfTime = chosen=>{
        /** @type {Map<string, number>} */
        const by = new Map();
        let total = 0;
        for (const frame of chosen)
        {
            const start = offset + frame.startedAt * 1000;
            const end = start + frame.ms * 1000;
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
                const key = nameOf(nodes.get(profile.samples[i]).callFrame);
                by.set(key, (by.get(key) ?? 0) + ms);
                total += ms;
            }
        }
        const many = Math.max(1, chosen.length);
        return { by: new Map([...by].map(([key, ms])=>[key, ms / many])), total: total / many };
    };
    const drops = selfTime(stretch.filter(frame=>dropped.has(frame.index)));
    const ordinary = selfTime(stretch.filter(frame=>!anyDrop.has(frame.index)));
    const keys = new Set([...drops.by.keys(), ...ordinary.by.keys()]);
    const rows = [...keys].map(key=>/** @type {[string, number]} */ ([key,
        (drops.by.get(key) ?? 0) - (ordinary.by.get(key) ?? 0)]))
        .sort((one, two)=>two[1] - one[1]).slice(0, count);
    return [`${stretch.length} frames, ${dropped.size} drops${cause ? ` (${cause})` : ''};`
        + ` sampled ${drops.total.toFixed(2)} ms a drop,`
        + ` ${ordinary.total.toFixed(2)} ms an ordinary frame`,
    '  extra ms a drop  drop  ordinary  function',
    ...rows.map(([key, extra])=>`  ${extra.toFixed(3).padStart(14)}`
        + `  ${(drops.by.get(key) ?? 0).toFixed(3).padStart(6)}`
        + `  ${(ordinary.by.get(key) ?? 0).toFixed(3).padStart(8)}  ${key}`)];
}

/**
 * Samples a worker of the running launcher for some seconds.
 *
 * @param {number} seconds @param {string} [which]
 */
async function sample(seconds, which){
    const { connect } = await import('../connect.mjs');
    const { cdp, engineWorker, workers } = await connect();
    const [wanted, nth] = (which ?? '').split('#');
    const matching = wanted ? (await workers()).filter(one=>one.url.includes(wanted)) : [];
    const worker = wanted ? matching[Math.max(1, Number(nth ?? 1)) - 1] ?? null
        : await engineWorker();
    if (!worker)
    {
        throw new Error(`no worker${wanted ? ` matching ${wanted}` : ''} in the page`);
    }
    await cdp.send('Profiler.enable', {}, worker.sessionId);
    await cdp.send('Profiler.setSamplingInterval', { interval: 250 }, worker.sessionId);
    const began = Date.now();
    await cdp.send('Profiler.start', {}, worker.sessionId);
    await new Promise(done=>setTimeout(done, seconds * 1000));
    const { profile } = await cdp.send('Profiler.stop', {}, worker.sessionId);
    return { profile, began, url: worker.url };
}

/** @param {string[]} args */
export async function run(args){
    const flagged = new Set(['--file', '--callers', '--depth', '--drops', '--from', '--to',
        '--cause', '--top', '--min', '--out']);
    const positional = args.filter((arg, at)=>!arg.startsWith('--') && !flagged.has(args[at - 1]));
    const file = option(args, '--file');
    const count = Number(option(args, '--top', '20'));
    let profile;
    let began;
    if (file)
    {
        profile = JSON.parse(readFileSync(file, 'utf8'));
        console.log(`${file}:`);
    }
    else
    {
        const sampled = await sample(Number(positional[0] ?? 20), positional[1]);
        profile = sampled.profile;
        began = sampled.began;
        const out = option(args, '--out', 'dbg/worker.cpuprofile') ?? 'dbg/worker.cpuprofile';
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(profile));
        console.log(`${sampled.url} (written to ${out}):`);
    }
    const callers = option(args, '--callers');
    const drops = option(args, '--drops');
    const lines = callers ? callersView(profile, new RegExp(callers),
        { depth: Number(option(args, '--depth', '4')), top: count })
        : drops ? dropsView(profile, JSON.parse(readFileSync(drops, 'utf8')), {
            from: Number(option(args, '--from', '0')), to: Number(option(args, '--to', 'Infinity')),
            cause: option(args, '--cause') ?? null, top: count })
            : timeView(profile, { minMs: Number(option(args, '--min', '50')), top: count, began });
    for (const line of lines)
    {
        console.log(line);
    }
}
