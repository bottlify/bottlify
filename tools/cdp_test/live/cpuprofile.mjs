/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A CPU profile of one thread of the running launcher -- the engine worker by
 * default -- taken from the browser the live driver (`drive.mjs`) keeps up,
 * without restarting it: the driver's browser is found through the
 * DevToolsActivePort file its profile directory holds.
 *
 *   node tools/cdp_test/live/cpuprofile.mjs [seconds] [--thread REGEX] [--out FILE]
 *
 * Writes the profile (`.cpuprofile`, which DevTools opens) and prints the
 * functions by self time as a share of the samples, then by total time. The
 * profiler slows the thread it watches: read the shares, not the
 * milliseconds. DRIVE_PROFILE names the driver's profile directory
 * (dbg/chrome-profile by default).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CdpEndpoint } from '../cdp.mjs';

const args = process.argv.slice(2);
/** @param {string} flag @param {string} fallback */
const option = (flag, fallback)=>{
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const seconds = Number(args.find(arg=>/^\d+(\.\d+)?$/.test(arg)) ?? 8);
const thread = new RegExp(option('--thread', 'engine\\.worker'));
const out = option('--out', `dbg/engine-${Date.now()}.cpuprofile`);

const [port, path] = readFileSync(`${process.env.DRIVE_PROFILE ?? 'dbg/chrome-profile'}`
    + '/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const cdp = new CdpEndpoint(`ws://127.0.0.1:${port}${path}`);
await cdp.open();

// A dedicated worker is reached through the session of whoever started it:
// auto-attach on the page's session hands over its workers, and on each of
// those, theirs. Their targets carry neither address nor title, so every one
// is sampled and the thread is told by the scripts its samples ran in.
const { targetInfos } = await cdp.send('Target.getTargets');
const page = targetInfos.find((/** @type {any} */ one)=>one.type === 'page'
    && /127.0.0.1:5180/.test(one.url));
if (!page)
{
    console.log('no launcher tab to profile');
    process.exit(1);
}
/** @type {string[]} */
const sessions = [];
/** @param {string} sessionId */
const sample = async sessionId=>{
    await cdp.send('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    await cdp.send('Profiler.enable', {}, sessionId);
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 }, sessionId);
    await cdp.send('Profiler.start', {}, sessionId);
    sessions.push(sessionId);
};
cdp.on('Target.attachedToTarget', (/** @type {any} */ event)=>{
    if (event.targetInfo?.type === 'worker')
    {
        sample(event.sessionId).catch(()=>{});
    }
});
const { sessionId: pageSession } = await cdp.send('Target.attachToTarget',
    { targetId: page.targetId, flatten: true });
await sample(pageSession);
// The workers' sessions come as events once auto-attach is on.
await new Promise(done=>setTimeout(done, 1500));
await new Promise(done=>setTimeout(done, seconds * 1000));
/** @type {any} */
let profile = null;
/** @type {Set<string>} */
const scripts = new Set();
for (const sessionId of sessions)
{
    // A worker may have ended meanwhile, and its session with it.
    const taken = (await cdp.send('Profiler.stop', {}, sessionId).catch(()=>null))?.profile;
    if (!taken)
    {
        continue;
    }
    const urls = new Set(taken.nodes.map((/** @type {any} */ node)=>
        String(node.callFrame.url).split('/').pop()).filter(Boolean));
    urls.forEach(url=>scripts.add(url));
    if (!profile && [...urls].some(url=>thread.test(url)))
    {
        profile = taken;
    }
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(()=>{});
}
if (!profile)
{
    console.log(`no thread ran ${thread}; the scripts sampled: ${[...scripts].join(', ')}`);
    process.exit(1);
}
writeFileSync(out, JSON.stringify(profile));

/** @type {Map<number, any>} */
const nodes = new Map(profile.nodes.map((/** @type {any} */ node)=>[node.id, node]));
/** @type {Map<number, number>} */
const hits = new Map();
for (const id of profile.samples)
{
    hits.set(id, (hits.get(id) ?? 0) + 1);
}
const total = profile.samples.length;
/** @param {any} node */
const nameOf = node=>{
    const frame = node.callFrame;
    const file = String(frame.url).split('/').pop();
    return `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`;
};
/** @type {Map<string, number>} */
const self = new Map();
/** @type {Map<number, number>} */
const parent = new Map();
for (const node of profile.nodes)
{
    for (const child of node.children ?? [])
    {
        parent.set(child, node.id);
    }
    self.set(nameOf(node), (self.get(nameOf(node)) ?? 0) + (hits.get(node.id) ?? 0));
}
// Total: each sample counted once for every distinct function on its stack.
/** @type {Map<string, number>} */
const inclusive = new Map();
for (const [id, count] of hits)
{
    const seen = new Set();
    for (let at = /** @type {number | undefined} */ (id); at !== undefined; at = parent.get(at))
    {
        const name = nameOf(nodes.get(at));
        if (!seen.has(name))
        {
            seen.add(name);
            inclusive.set(name, (inclusive.get(name) ?? 0) + count);
        }
    }
}
/** @param {Map<string, number>} table */
const top = table=>[...table].sort((a, b)=>b[1] - a[1]).slice(0, 25)
    .map(([name, count])=>`${(100 * count / total).toFixed(1).padStart(5)}%  ${name}`).join('\n');
console.log(`${sessions.length} threads sampled; ${thread}: ${total} samples in ${seconds} s`
    + ` -> ${out}`);
console.log(`\nby self time\n${top(self)}`);
console.log(`\nby total time\n${top(inclusive)}`);
cdp.close();
