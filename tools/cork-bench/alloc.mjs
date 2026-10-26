/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What translating allocates: workloads of `bench.mjs` run cold on the cork
 * host in this thread, every region formed and emitted here, under V8's
 * sampling heap profiler with collected objects kept -- the garbage a
 * translation makes, by the function that made it.
 *
 *   node tools/cork-bench/alloc.mjs [name...] [--top N] [--depth D] [--json FILE]
 *
 * Prints, per workload and in all, the bytes sampled and the regions formed,
 * and the sites that allocated most (a site is the allocating function and the
 * D - 1 callers above it). Objects only V8 makes -- a number boxed where it
 * does not fit a small integer -- count too; JavaScriptCore does not box them.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';

const flag = (name, fallback)=>{
    const at = process.argv.indexOf(name);
    return at < 0 ? fallback : process.argv[at + 1];
};
const top = Number(flag('--top', '25'));
const depth = Number(flag('--depth', '2'));
const images = new URL('images/', import.meta.url);
const wanted = process.argv.slice(2).filter((arg, i, all)=>!arg.startsWith('--')
    && !all[i - 1]?.startsWith('--'));
const names = readdirSync(images).filter(file=>file.endsWith('.bin')).map(file=>file.slice(0, -4))
    .filter(name=>wanted.length === 0 || wanted.includes(name));

const { createCorkHost } = await import('../../modules/core/src/layers/cpu/internal/cork-host.js');
const engine = await import('../../modules/cork/src/index.js');

const session = new Session();
session.connect();
await session.post('HeapProfiler.enable');

/** @type {Map<string, number>} */
const sites = new Map();
let total = 0;
const rows = [];
for (const name of names)
{
    const host = createCorkHost({ engine, memorySize: 16 << 20, trapPort: 0xb077,
        entryVector: 0x7000, initialStack: 0x800000, cork: { worker: false } });
    host.writePhysical(0x401000, readFileSync(new URL(`${name}.bin`, images)));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, 0x401000, true);
    host.writePhysical(0x7000, vector);
    await session.post('HeapProfiler.startSampling', { samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    host.runSlice(100_000);
    while (!host.halted())
    {
        await host.cork().translatePending();
        host.runSlice(100_000);
    }
    await host.cork().flush();
    const { profile } = await session.post('HeapProfiler.stopSampling');
    let bytes = 0;
    const walk = (node, stack)=>{
        const frame = node.callFrame;
        const here = `${frame.functionName || '(anonymous)'} ${frame.url.replace(/^.*\//, '')}`
            + `:${frame.lineNumber + 1}`;
        const chain = [here, ...stack].slice(0, depth);
        if (node.selfSize > 0)
        {
            const key = chain.join(' < ');
            sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
            bytes += node.selfSize;
        }
        for (const child of node.children)
        {
            walk(child, chain);
        }
    };
    walk(profile.head, []);
    total += bytes;
    const d = host.cork().diagnostics();
    rows.push({ name, regions: d.regions, mb: +(bytes / (1 << 20)).toFixed(1),
        kbPerRegion: d.regions > 0 ? Math.round(bytes / 1024 / d.regions) : null });
}
console.table(rows);
console.log(`in all: ${(total / (1 << 20)).toFixed(1)} MB sampled`);
const ranked = [...sites].sort((a, b)=>b[1] - a[1]).slice(0, top);
for (const [site, bytes] of ranked)
{
    console.log(`${(bytes / (1 << 20)).toFixed(1).padStart(8)} MB ${(100 * bytes / total).toFixed(1)
        .padStart(5)}%  ${site}`);
}
const out = flag('--json', null);
if (out)
{
    writeFileSync(out, JSON.stringify({ rows, total, sites: ranked }, null, 2));
}
