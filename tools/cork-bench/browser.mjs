/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cork-bench in headless Chromium: the workloads `bench.mjs` runs in node, each
 * run in a fresh tab and a dedicated worker, the engine Chrome's V8 compiles
 * rather than node's. Arms name a tree each (`root`, default this one) and a
 * translator configuration (`cork`), so one tree is measured against another:
 *
 *     node tools/cork-bench/browser.mjs [name...] [--arms JSON] [--runs N]
 *         [--warm N] [--iters N] [--paired [--rounds N] [--block N]]
 *         [--js-flags FLAGS] [--json]
 *
 *     --arms '{"base":{"root":"/tmp/base"},"head":{},"off":{"cork":{"floatSingles":false}}}'
 *     --arms '{"one":{},"two":{"executors":2,"cork":{"atomic":true}}}'  (a process of two)
 *
 * A run is one tab: a cold iteration, `--warm` more, then `--iters` timed
 * (`usPerIter`). The arms are interleaved and their order turned round every
 * run, so a drift in the machine's speed falls on all of them alike; each
 * arm's runs are reported raw with their median and least. With `--paired`
 * a run is every arm in one worker (`paired.js`): `--warm` iterations each
 * (default 100), then `--rounds` rounds of `--block` iterations alternated,
 * and each arm is reported as the median of the rounds' ratios to the first
 * arm, with its quartiles -- the measurement to trust for an effect of a few
 * per cent. `eax` is the program's own checksum: the same in every run of an
 * arm, and of any arms whose arithmetic is the same.
 *
 * The browser is CDP_TEST_CHROME or the first `tools/cdp_test/browser.mjs`
 * finds; the page is cross-origin isolated, as the engine's shared memory needs.
 */

import { readdirSync } from 'node:fs';
import { summarise } from './paired.js';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
/** A run with no answer by then is counted a failure. */
const JOB_LIMIT_MS = 300_000;

const tool = (/** @type {string} */ name)=>import(pathToFileURL(join(REPO, 'tools/cdp_test', name)).href);
const { CdpEndpoint } = await tool('cdp.mjs');
const { serveStatic } = await tool('server.mjs');
const { launchWithGpu, shutdown } = await tool('browser.mjs');

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {string} */ fallback)=>
    (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
/** @type {Record<string, { root?: string, cork?: object }>} */
const arms = JSON.parse(flag('--arms', '{"head":{}}'));
const labels = Object.keys(arms);
const runs = Number(flag('--runs', '3'));
const warm = Number(flag('--warm', args.includes('--paired') ? '100' : '20'));
const iters = Number(flag('--iters', '400'));
const jsFlags = flag('--js-flags', '');
const json = args.includes('--json');
const pairing = args.includes('--paired');
const rounds = Number(flag('--rounds', '40'));
const block = Number(flag('--block', '10'));
const only = args.filter((one, at)=>!one.startsWith('--') && !args[at - 1]?.startsWith('--'));
const names = readdirSync(join(HERE, 'images')).filter(file=>file.endsWith('.bin'))
    .map(file=>file.slice(0, -4)).filter(name=>only.length === 0
        || only.some(prefix=>name.startsWith(prefix))).sort();

const server = await serveStatic({
    sandboxDir: join(HERE, 'browser'),
    srcDir: join(REPO, 'modules/core/src'),
    extra: labels.map((label, i)=>({ prefix: `/a${i}/`, root: resolve(arms[label].root ?? REPO) })),
    coi: true,
});
const browser = await launchWithGpu({ extraFlags: jsFlags ? [`--js-flags=${jsFlags}`] : [] });
const cdp = new CdpEndpoint(browser.browserWs);

/** @type {((payload: string) => void) | null} */
let waiter = null;

/** A tab of the run's own, closed after it, so its renderer and worker go with it. */
async function newTab(){
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.addBinding', { name: 'report' }, sessionId);
    await cdp.send('Page.navigate',
        { url: `http://127.0.0.1:${server.port}/sandbox/page.html` }, sessionId);
    for (let i = 0; ; i++)
    {
        const ready = await cdp.send('Runtime.evaluate',
            { expression: 'window.ready === true', returnByValue: true }, sessionId);
        if (ready.result?.value === true)
        {
            return { targetId, sessionId };
        }
        if (i > 200)
        {
            throw new Error('the bench page never loaded');
        }
        await new Promise(done=>setTimeout(done, 50));
    }
}

/**
 * One run of one workload under one arm, or under every arm paired (-1).
 *
 * @param {number} arm @param {string} name
 * @returns {Promise<any>}
 */
async function job(arm, name){
    const message = arm < 0
        ? { arms: labels.map((label, i)=>({ root: `/a${i}/`, cork: arms[label].cork ?? {},
            executors: arms[label].executors ?? 1 })), name, warm, rounds, block }
        : { root: `/a${arm}/`, name, warm, iters, cork: arms[labels[arm]].cork ?? {},
            executors: arms[labels[arm]].executors ?? 1 };
    const tab = await newTab();
    try
    {
        /** @type {Promise<string>} */
        const answer = new Promise(done=>{
            waiter = done;
            setTimeout(()=>{
                if (waiter === done)
                {
                    waiter = null;
                    done(JSON.stringify({ error: 'no answer' }));
                }
            }, JOB_LIMIT_MS);
        });
        await cdp.send('Runtime.evaluate',
            { expression: `job(${JSON.stringify(message)})`, returnByValue: true }, tab.sessionId);
        return JSON.parse(await answer);
    }
    finally
    {
        await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(()=>{});
    }
}

/** @param {number[]} values */
const median = values=>{
    const sorted = [...values].sort((a, b)=>a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** @type {Map<string, { values: number[], eax: Set<string>, errors: string[] }>} */
const results = new Map();
/** Under `--paired`, by workload: every round's times, by arm, and the checksums.
 * @type {Map<string, { times: number[][], eax: Set<string>[] }>} */
const pairs = new Map();
try
{
    await cdp.open();
    cdp.on('Runtime.bindingCalled', (/** @type {any} */ p)=>{
        if (p.name === 'report' && waiter)
        {
            const answered = waiter;
            waiter = null;
            answered(p.payload);
        }
    });
    const version = await cdp.send('Browser.getVersion');
    console.error(`${version.product}, V8 ${version.jsVersion}; warm ${warm}, iters ${iters},`
        + ` ${runs} runs an arm`);
    for (let run = 0; run < (pairing ? runs : 0); run++)
    {
        for (const name of names)
        {
            const got = await job(-1, name);
            if (got.error)
            {
                console.error(`${name}: ${String(got.error).slice(0, 300)}`);
                continue;
            }
            const entry = pairs.get(name)
                ?? { times: labels.map(()=>[]), eax: labels.map(()=>new Set()) };
            pairs.set(name, entry);
            got.times.forEach((/** @type {number[]} */ times, /** @type {number} */ at)=>{
                entry.times[at].push(...times);
                entry.eax[at].add(got.eax[at]);
            });
            console.error(`${name} run ${run}: ${summarise(labels, got.times).map(row=>
                `${row.label} ${row.median.toFixed(1)} us ${row.ratio.toFixed(3)}`).join(', ')}`);
        }
    }
    for (let run = 0; run < (pairing ? 0 : runs); run++)
    {
        for (const name of names)
        {
            const order = labels.map((_, i)=>i);
            for (const arm of run % 2 ? order.reverse() : order)
            {
                const key = `${labels[arm]} ${name}`;
                const entry = results.get(key) ?? { values: [], eax: new Set(), errors: [] };
                results.set(key, entry);
                const got = await job(arm, name);
                if (got.error)
                {
                    entry.errors.push(String(got.error).slice(0, 300));
                    console.error(`${key}: ${String(got.error).slice(0, 300)}`);
                    continue;
                }
                entry.values.push(Math.round(got.usPerIter * 10) / 10);
                entry.eax.add(got.eax);
                console.error(`${key.padEnd(28)} run ${run}  ${got.usPerIter.toFixed(1)} us`
                    + `  eax ${got.eax}`);
            }
        }
    }
}
finally
{
    await cdp.close?.();
    await shutdown(browser);
    server.close?.();
}

const paired = [...pairs].flatMap(([name, { times, eax }])=>summarise(labels, times)
    .map((row, at)=>({ name, ...row, eax: [...eax[at]].join(','), rounds: times[at].length })));
if (pairing)
{
    if (json)
    {
        console.log(JSON.stringify(paired));
    }
    for (const row of json ? [] : paired)
    {
        console.log(`${row.name.padEnd(16)} ${row.label.padEnd(10)}`
            + ` median ${row.median.toFixed(1)} us  ratio ${row.ratio.toFixed(3)}`
            + ` [${row.q25.toFixed(3)} ${row.q75.toFixed(3)}]`
            + `  ${row.rounds} rounds  eax ${row.eax}`);
    }
}
const rows = [...results].map(([key, { values, eax, errors }])=>({
    arm: key.split(' ')[0], name: key.split(' ')[1], median: median(values),
    least: Math.min(...values), values, eax: [...eax].join(','), errors: errors.length,
}));
if (json && !pairing)
{
    console.log(JSON.stringify(rows));
}
else if (!pairing)
{
    for (const row of rows)
    {
        console.log(`${row.name.padEnd(16)} ${row.arm.padEnd(10)} median ${row.median.toFixed(1)}`
            + ` least ${row.least.toFixed(1)}  [${row.values.join(' ')}]  eax ${row.eax}`
            + `${row.errors ? `  ${row.errors} failed` : ''}`);
    }
}
