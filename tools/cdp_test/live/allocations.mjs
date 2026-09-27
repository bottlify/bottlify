/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which functions of the live engine worker allocate the most bytes over N
 * seconds, collected garbage included: the source of a heap that churns and
 * of the collector pausing the engine thread.
 *
 *   node tools/cdp_test/live/allocations.mjs [seconds=15]
 */
import { connect } from './connect.mjs';

const seconds = Number(process.argv[2] ?? 15);
const { cdp, engineWorker } = await connect();
const worker = await engineWorker();
if (!worker)
{
    console.log('the page has no worker');
    process.exit(1);
}
await cdp.send('HeapProfiler.enable', {}, worker.sessionId);
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true },
worker.sessionId);
await new Promise(done=>setTimeout(done, seconds * 1000));
const { profile } = await cdp.send('HeapProfiler.stopSampling', {}, worker.sessionId);

/** @type {Map<string, number>} */
const self = new Map();
/** @type {Map<string, number>} */
const inclusive = new Map();
/** @param {any} node @param {string[]} stack */
const walk = (node, stack)=>{
    const frame = node.callFrame;
    const name = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}`
        + `:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
    self.set(name, (self.get(name) ?? 0) + node.selfSize);
    const within = [...stack, name];
    for (const outer of new Set(within))
    {
        inclusive.set(outer, (inclusive.get(outer) ?? 0) + node.selfSize);
    }
    for (const child of node.children)
    {
        walk(child, within);
    }
};
walk(profile.head, []);
const mb = (/** @type {number} */ bytes)=>(bytes / 1048576).toFixed(1).padStart(8);
const total = [...self.values()].reduce((sum, bytes)=>sum + bytes, 0);
console.log(`${mb(total)} MB allocated in ${seconds} s (sampled)`);
for (const [name, bytes] of [...self].sort((a, b)=>b[1] - a[1]).slice(0, 25))
{
    console.log(`self ${mb(bytes)} MB  ${name}`);
}
for (const [name, bytes] of [...inclusive].sort((a, b)=>b[1] - a[1]).slice(0, 30))
{
    console.log(`incl ${mb(bytes)} MB  ${name}`);
}
process.exit(0);
