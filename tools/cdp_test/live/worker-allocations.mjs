/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Samples what the live engine worker allocates for N seconds and prints the
 * functions that allocated the most, by bytes still sampled and with the
 * stack above each -- the garbage a collector pause is paying for. The
 * sampler sees allocations alive when the profile was taken, and with
 * `includeObjectsCollectedBy*GC` also those already collected, which is the
 * garbage itself.
 *
 *   node tools/cdp_test/live/worker-allocations.mjs [seconds=8] [top=25]
 *
 * The raw profile is written to dbg/worker.heapprofile for DevTools.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from './connect.mjs';

const seconds = Number(process.argv[2] ?? 8);
const top = Number(process.argv[3] ?? 25);
const { cdp, engineWorker } = await connect();
const worker = await engineWorker();
if (!worker)
{
    console.log('the page has no worker');
    process.exit(1);
}
await cdp.send('HeapProfiler.enable', {}, worker.sessionId);
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true },
worker.sessionId);
await new Promise(done=>setTimeout(done, seconds * 1000));
const { profile } = await cdp.send('HeapProfiler.stopSampling', {}, worker.sessionId);
mkdirSync('dbg', { recursive: true });
writeFileSync('dbg/worker.heapprofile', JSON.stringify(profile));

/** @type {Map<string, { bytes: number, stack: string }>} */
const self = new Map();
let total = 0;
/** @param {any} node @param {string[]} path */
const walk = (node, path)=>{
    const frame = node.callFrame;
    const name = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}`
        + `:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
    const here = [name, ...path];
    if (node.selfSize > 0)
    {
        total += node.selfSize;
        const row = self.get(name) ?? { bytes: 0, stack: here.slice(1, 5).join(' < ') };
        row.bytes += node.selfSize;
        self.set(name, row);
    }
    for (const child of node.children ?? [])
    {
        walk(child, here);
    }
};
walk(profile.head, []);
console.log(`allocated ${(total / 1048576).toFixed(1)} MiB sampled in ${seconds} s`
    + ` (${(total / 1048576 / seconds).toFixed(1)} MiB/s)`);
for (const [name, row] of [...self].sort((one, two)=>two[1].bytes - one[1].bytes).slice(0, top))
{
    console.log(`${(row.bytes / 1048576).toFixed(2).padStart(8)} MiB  ${name}`);
    console.log(`            < ${row.stack}`);
}
// The CDP connection would keep the process alive.
process.exit(0);
