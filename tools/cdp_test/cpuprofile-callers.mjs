/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Who calls a function, in a `.cpuprofile` (what `live/worker-profile.mjs`
 * writes to dbg/worker.cpuprofile, or the harness's `--cpu-profile`): every
 * path up from the frames whose name matches, folded to its first few callers
 * and counted by the samples spent in the function under it. A clock read or
 * an accessor that is hot by self time says nothing until it says who asks.
 *
 *   node tools/cdp_test/cpuprofile-callers.mjs <file.cpuprofile> <name regex> [depth=4] [top=15]
 *
 * A frame is matched as `name file:line`, so `^now ` names the browser's
 * `performance.now` and `engine.worker.js:126383` one line of the build.
 */
import { readFileSync } from 'node:fs';

const [file, pattern, depthText, topText] = process.argv.slice(2);
if (!file || !pattern)
{
    console.log('usage: cpuprofile-callers.mjs <file.cpuprofile> <name regex> [depth] [top]');
    process.exit(1);
}
const depth = Number(depthText ?? 4);
const top = Number(topText ?? 15);
const wanted = new RegExp(pattern);
const profile = JSON.parse(readFileSync(file, 'utf8'));

/** @type {Map<number, any>} */
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
/** @param {any} node */
const nameOf = node=>`${node.callFrame.functionName || '(anonymous)'} `
    + `${String(node.callFrame.url).split('/').pop()}:${node.callFrame.lineNumber + 1}`;

/** @type {Map<number, number>} */
const hits = new Map();
for (const id of profile.samples)
{
    hits.set(id, (hits.get(id) ?? 0) + 1);
}
const total = profile.samples.length;

// Every sample whose stack holds a matching frame counts once, for the
// callers above the innermost such frame.
/** @type {Map<string, number>} */
const paths = new Map();
let matched = 0;
for (const [id, count] of hits)
{
    let at = /** @type {number | undefined} */ (id);
    while (at !== undefined && !wanted.test(nameOf(nodes.get(at))))
    {
        at = parents.get(at);
    }
    if (at === undefined)
    {
        continue;
    }
    matched += count;
    const chain = [];
    for (let up = parents.get(at); up !== undefined && chain.length < depth; up = parents.get(up))
    {
        chain.push(nameOf(nodes.get(up)));
    }
    const key = chain.join('  <  ');
    paths.set(key, (paths.get(key) ?? 0) + count);
}
console.log(`${pattern}: ${matched} of ${total} samples (${(matched / total * 100).toFixed(1)}%)`);
for (const [key, count] of [...paths].sort((a, b)=>b[1] - a[1]).slice(0, top))
{
    console.log(`  ${(count / total * 100).toFixed(1).padStart(5)}%  ${key}`);
}
