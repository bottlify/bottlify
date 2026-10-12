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
 *       [--wait SECONDS]
 *
 * Writes the profile (`.cpuprofile`, which DevTools opens) and prints the
 * functions by self time as a share of the samples, then by total time. The
 * profiler slows the thread it watches: read the shares, not the
 * milliseconds. DRIVE_PROFILE names the driver's profile directory
 * (dbg/chrome-profile by default).
 *
 * A worker already running when the tool attaches may answer nothing: the
 * engine worker's target did not answer `Profiler.enable` that way. So the
 * tool also does what DevTools does for a worker it is to debug from its
 * start: auto-attach with `waitForDebuggerOnStart`, on the page and on every
 * worker it attaches to, so a worker started after that -- the engine worker
 * when a title starts, and the workers the engine worker starts itself --
 * waits before its first script; its profiler is started while it waits, and
 * `Runtime.runIfWaitingForDebugger` lets it go. Start the title after the tool
 * says it is armed; it waits up to `--wait` seconds (120) for the thread
 * asked for before it samples.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CdpEndpoint } from '../cdp.mjs';

const args = process.argv.slice(2);
/** @param {string} flag @param {string} fallback */
const option = (flag, fallback)=>{
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
// The values of the flags are not the seconds, whatever they look like.
const valued = new Set(['--thread', '--out', '--wait'].map(flag=>args.indexOf(flag))
    .filter(at=>at >= 0).map(at=>at + 1));
const seconds = Number(args.find((arg, at)=>!valued.has(at) && /^\d+(\.\d+)?$/.test(arg)) ?? 8);
const thread = new RegExp(option('--thread', 'engine\\.worker'));
const out = option('--out', `dbg/engine-${Date.now()}.cpuprofile`);
const waitSeconds = Number(option('--wait', '120'));

const [port, path] = readFileSync(`${process.env.DRIVE_PROFILE ?? 'dbg/chrome-profile'}`
    + '/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const cdp = new CdpEndpoint(`ws://127.0.0.1:${port}${path}`);
await cdp.open();

/**
 * A command that gives up after `ms` rather than the endpoint's thirty
 * seconds: a worker that does not answer is reported, not waited on.
 *
 * @param {string} method @param {any} params @param {string} sessionId @param {number} [ms]
 */
const ask = (method, params, sessionId, ms = 5000)=>Promise.race([
    cdp.send(method, params, sessionId),
    new Promise((_, refuse)=>setTimeout(()=>refuse(new Error(`${method}: no answer in ${ms} ms`)),
        ms)),
]);

const { targetInfos } = await cdp.send('Target.getTargets');
const page = targetInfos.find((/** @type {any} */ one)=>one.type === 'page'
    && /127.0.0.1:5180/.test(one.url));
if (!page)
{
    console.log('no launcher tab to profile');
    process.exit(1);
}

/**
 * Every thread being sampled, by session: its target's address where it has
 * one, and whether it was caught at its start or attached while running.
 *
 * @type {Map<string, { url: string, fromStart: boolean }>}
 */
const sampled = new Map();
/** What the threads that would not be sampled said, for the answer at the end. @type {string[]} */
const refused = [];
/**
 * Auto-attach on a session, waiting new workers at their start, then its
 * profiler started. A worker caught waiting is let go whatever happens: one
 * left waiting would hold the program.
 *
 * @param {string} sessionId @param {{ url: string, waiting: boolean }} target
 */
const sample = async(sessionId, { url, waiting })=>{
    try
    {
        // A dedicated worker's own workers are reached through its session:
        // the engine worker starts the graphics worker and the others.
        await ask('Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
        await ask('Profiler.enable', {}, sessionId);
        await ask('Profiler.setSamplingInterval', { interval: 200 }, sessionId);
        await ask('Profiler.start', {}, sessionId);
        sampled.set(sessionId, { url, fromStart: waiting });
    }
    catch (e){
        refused.push(`${url || 'a worker'}${waiting ? ' (caught at its start)' : ''}: `
            + `${e instanceof Error ? e.message : e}`);
    }
    finally
    {
        if (waiting)
        {
            await ask('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(()=>{});
        }
    }
};
cdp.on('Target.attachedToTarget', (/** @type {any} */ event)=>{
    if (event.targetInfo?.type === 'worker')
    {
        sample(event.sessionId, { url: String(event.targetInfo.url ?? ''),
            waiting: event.waitingForDebugger === true });
    }
});
const { sessionId: pageSession } = await cdp.send('Target.attachToTarget',
    { targetId: page.targetId, flatten: true });
await sample(pageSession, { url: page.url, waiting: false });
// The workers already running come as events once auto-attach is on.
await new Promise(done=>setTimeout(done, 1500));
/** Whether a thread whose target names the one asked for is being sampled. */
const caught = ()=>[...sampled.values()].some(one=>thread.test(one.url));
if (!caught())
{
    console.log(`armed: start the title now; waiting up to ${waitSeconds} s for ${thread}`);
    const until = Date.now() + waitSeconds * 1000;
    while (!caught() && Date.now() < until)
    {
        await new Promise(done=>setTimeout(done, 250));
    }
}
await new Promise(done=>setTimeout(done, seconds * 1000));
// Nothing started after this waits for a debugger that is going away.
await ask('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false,
    flatten: true }, pageSession).catch(()=>{});
/** @type {any} */
let profile = null;
/** @type {Set<string>} */
const scripts = new Set();
for (const [sessionId, { url }] of sampled)
{
    // A worker may have ended meanwhile, and its session with it.
    const taken = (await ask('Profiler.stop', {}, sessionId, 15000).catch(()=>null))?.profile;
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(()=>{});
    if (!taken)
    {
        continue;
    }
    const urls = new Set(taken.nodes.map((/** @type {any} */ node)=>
        String(node.callFrame.url).split('/').pop()).filter(Boolean));
    urls.forEach(one=>scripts.add(one));
    if (!profile && (thread.test(url) || [...urls].some(one=>thread.test(one))))
    {
        profile = taken;
    }
}
if (!profile)
{
    console.log(`no thread ran ${thread}; the scripts sampled: ${[...scripts].join(', ')}`);
    for (const line of refused)
    {
        console.log(`  not sampled: ${line}`);
    }
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
console.log(`${sampled.size} threads sampled; ${thread}: ${total} samples in ${seconds} s`
    + ` -> ${out}`);
console.log(`\nby self time\n${top(self)}`);
console.log(`\nby total time\n${top(inclusive)}`);
cdp.close();
