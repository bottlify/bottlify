/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Samples the live engine worker for N seconds and prints where its time
 * went: how much was idle, garbage collection, the heaviest functions by self
 * and inclusive time, and every stretch of at least MIN ms spent outside
 * translated guest code with the wall-clock moment it began -- the pauses a
 * guest thread (a sound mixer, say) waited through.
 *
 *   node tools/cdp_test/live/worker-profile.mjs [seconds=20] [minMs=50]
 *
 * The raw profile is written to dbg/worker.cpuprofile for DevTools.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from './connect.mjs';

const seconds = Number(process.argv[2] ?? 20);
const minMs = Number(process.argv[3] ?? 50);
const { cdp, engineWorker } = await connect();
const worker = await engineWorker();
if (!worker)
{
    console.log('the page has no worker');
    process.exit(1);
}
await cdp.send('Profiler.enable', {}, worker.sessionId);
await cdp.send('Profiler.setSamplingInterval', { interval: 250 }, worker.sessionId);
const began = Date.now();
await cdp.send('Profiler.start', {}, worker.sessionId);
await new Promise(done=>setTimeout(done, seconds * 1000));
const { profile } = await cdp.send('Profiler.stop', {}, worker.sessionId);
mkdirSync('dbg', { recursive: true });
writeFileSync('dbg/worker.cpuprofile', JSON.stringify(profile));

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
/** @param {number} id */
const nameOf = id=>{
    const frame = byId.get(id).callFrame;
    return `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}`
        + `:${frame.lineNumber + 1}`;
};
// Translated regions are wasm with no script URL; the interpreter is too.
/** @param {number} id */
const isGuest = id=>{
    const frame = byId.get(id).callFrame;
    return frame.url === '' && /^(r[0-9a-f]{8}|wasm-function|runInteger|x87|js-to-wasm)/
        .test(frame.functionName);
};

/** @type {Map<string, number>} */
const self = new Map();
/** @type {Map<string, number>} */
const inclusive = new Map();
/** @type {{ at: number, ms: number, self: Map<string, number> }[]} */
const stretches = [];
/** @type {{ at: number, ms: number, self: Map<string, number> } | null} */
let stretch = null;
let clock = 0;
for (let index = 0; index < profile.samples.length; index++)
{
    const ms = profile.timeDeltas[index] / 1000;
    clock += ms;
    const id = profile.samples[index];
    const name = nameOf(id);
    self.set(name, (self.get(name) ?? 0) + ms);
    const seen = new Set();
    for (let at = id; at !== undefined; at = parent.get(at))
    {
        const outer = nameOf(at);
        if (!seen.has(outer))
        {
            seen.add(outer);
            inclusive.set(outer, (inclusive.get(outer) ?? 0) + ms);
        }
    }
    if (isGuest(id) || name.startsWith('(idle)'))
    {
        if (stretch && stretch.ms >= minMs)
        {
            stretches.push(stretch);
        }
        stretch = null;
        continue;
    }
    stretch ??= { at: clock, ms: 0, self: new Map() };
    stretch.ms += ms;
    stretch.self.set(name, (stretch.self.get(name) ?? 0) + ms);
}
/** @param {Map<string, number>} table @param {number} count */
const top = (table, count)=>[...table].sort((a, b)=>b[1] - a[1]).slice(0, count);
const total = [...self.values()].reduce((sum, ms)=>sum + ms, 0);
console.log(`${worker.url}: ${total.toFixed(0)} ms sampled`);
console.log('self:');
for (const [name, ms] of top(self, 20))
{
    console.log(`  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${name}`);
}
console.log('inclusive:');
for (const [name, ms] of top(inclusive, 20))
{
    console.log(`  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${name}`);
}
console.log(`stretches of ${minMs} ms or more outside guest code: ${stretches.length}`);
for (const { at, ms, self: own } of stretches)
{
    console.log(`  ${new Date(began + at).toLocaleTimeString()} ${ms.toFixed(0)} ms: `
        + top(own, 4).map(([name, spent])=>`${name}=${spent.toFixed(0)}`).join(', '));
}
process.exit(0);
