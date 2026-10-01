/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs the benchmark's workloads in headless Chromium, each run in a fresh tab
 * and a dedicated worker of a bundle `build.mjs` made, and reports each
 * configuration's best guest instructions per second beside the first's.
 *
 *     node modules/cork/bench/browser/suite.mjs '<configurations>' [options]
 *
 * The configurations are a JSON object of labels, each naming its `bundle`
 * (default the label), its `engine` (cork or emulator) and its translator
 * configuration (`cork`):
 *
 *     '{"cork":{"bundle":"head"},"v86":{"bundle":"head","engine":"emulator"}}'
 *
 *   --variants x87,sse    which builds (default both)
 *   --only a,b,c          workloads to run (default all)
 *   --reps n              runs of each, the fastest kept (default 2)
 *   --out file.jsonl      one JSON line per run
 *   --js-flags '<flags>'  V8's flags, for a diagnostic run
 *
 * The browser is CDP_TEST_CHROME or the first `tools/cdp_test/browser.mjs`
 * finds. The configurations are interleaved and their order turned round every
 * rep, so a drift in the machine's speed falls on all of them alike.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../../..');
const BIN = resolve(HERE, '../bin');
const WORKLOADS = ['vm', 'entities', 'math', 'path', 'lz', 'containers', 'spread', 'api'];
/** A job with no answer by then is run once more, and counted a failure if it fails again. */
const JOB_LIMIT_MS = 120_000;

const tool = (/** @type {string} */ name)=>import(pathToFileURL(join(REPO, 'tools/cdp_test', name)).href);
const { CdpEndpoint } = await tool('cdp.mjs');
const { serveStatic } = await tool('server.mjs');
const { launchWithGpu, shutdown } = await tool('browser.mjs');

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {string} */ fallback)=>
    (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
/** @type {Record<string, { bundle?: string, engine?: string, cork?: object }>} */
const configs = JSON.parse(args[0] ?? '{"head":{}}');
const labels = Object.keys(configs);
const variants = flag('--variants', 'x87,sse').split(',');
const only = flag('--only', WORKLOADS.join(',')).split(',');
const reps = Number(flag('--reps', '2'));
const out = flag('--out', '');
const jsFlags = flag('--js-flags', '');
/** @type {Record<string, Record<string, string>>} */
const expected = JSON.parse(readFileSync(resolve(HERE, '../expected.json'), 'utf8'));
if (out)
{
    writeFileSync(out, '');
}

const server = await serveStatic({
    sandboxDir: HERE,
    srcDir: join(REPO, 'modules/core/src'),
    extra: [{ prefix: '/b/', root: join(HERE, 'bundles') }, { prefix: '/exe/', root: BIN }],
    // Shared memory, which the engine's workers need, is only handed to an isolated page.
    coi: true,
});
// The launcher that takes extra flags; the GPU it asks for goes unused here.
const browser = await launchWithGpu({ extraFlags: jsFlags ? [`--js-flags=${jsFlags}`] : [] });
const cdp = new CdpEndpoint(browser.browserWs);
const started = Date.now();

/** @type {Record<string, Record<string, number>>} label -> "variant workload" -> best MIPS */
const best = {};
/** @type {string[]} */
const wrong = [];
/** @type {string[]} */
const unanswered = [];

/** @type {((payload: string) => void) | null} */
let waiter = null;

/**
 * A tab of the job's own, closed after it, so its renderer and the job's
 * workers go with it: a worker's memory is not all handed back while its page
 * lives, and runs accumulated in one renderer until it was killed.
 */
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
        await new Promise(r=>setTimeout(r, 50));
    }
}

/**
 * One run of one workload under one configuration.
 *
 * @param {string} label @param {string} variant @param {string} workload
 * @returns {Promise<any>}
 */
async function job(label, variant, workload){
    const config = configs[label];
    const options = {
        engine: config.engine ?? 'cork',
        cork: config.cork ?? {},
        commandLine: `"C:\\app.exe" ${workload}`,
    };
    const tab = await newTab();
    try
    {
        /** @type {Promise<string>} */
        const answer = new Promise(res=>{
            waiter = res;
            setTimeout(()=>{
                if (waiter === res)
                {
                    waiter = null;
                    res(JSON.stringify({ error: 'no answer', unanswered: true }));
                }
            }, JOB_LIMIT_MS);
        });
        await cdp.send('Runtime.evaluate', {
            expression: `job(${JSON.stringify(config.bundle ?? label)},`
                + ` '/exe/bench-${variant}.exe', ${JSON.stringify(options)})`,
            returnByValue: true,
        }, tab.sessionId);
        return JSON.parse(await answer);
    }
    finally
    {
        await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(()=>{});
    }
}

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
    console.error(`${version.product}, V8 ${version.jsVersion}`);
    for (let rep = 0; rep < reps; rep++)
    {
        for (const variant of variants)
        {
            for (const workload of only)
            {
                for (const label of rep % 2 ? [...labels].reverse() : labels)
                {
                    let run = await job(label, variant, workload);
                    if (run.unanswered)
                    {
                        unanswered.push(`${label} ${variant} ${workload} rep ${rep}`);
                        run = await job(label, variant, workload);
                    }
                    const checksum = run.code === null || run.code === undefined
                        ? null : run.code.toString(16).padStart(8, '0');
                    const ok = checksum !== null && checksum === expected[variant]?.[workload];
                    if (!ok)
                    {
                        wrong.push(`${label} ${variant} ${workload}: ${checksum}`
                            + `${run.error ? ` ${String(run.error).slice(0, 300)}` : ''}`);
                    }
                    const key = `${variant} ${workload}`;
                    const scores = best[label] ??= {};
                    scores[key] = Math.max(scores[key] ?? 0, ok ? run.mips : 0);
                    if (out)
                    {
                        appendFileSync(out, `${JSON.stringify({ label, rep, variant, workload,
                            ...run, ok })}\n`);
                    }
                    console.error(`${label.padEnd(12)} rep ${rep}  ${key.padEnd(16)}`
                        + `${Math.round(run.mips ?? 0).toString().padStart(6)} MIPS`
                        + `  ${ok ? 'ok' : 'WRONG'}`);
                }
            }
        }
    }
}
finally
{
    cdp.close();
    await shutdown(browser);
    await server.close();
}

/** @param {number[]} values */
const geomean = values=>Math.exp(values.reduce((s, v)=>s + Math.log(v), 0) / values.length);
const keys = Object.keys(best[labels[0]] ?? {});
/** @param {number} value @param {number} first @param {number} i */
const cell = (value, first, i)=>
    `${Math.round(value)}${i ? ` (${(value / first).toFixed(2)}x)` : ''}`.padStart(16);
console.log(['MIPS'.padEnd(16), ...labels.map(l=>l.padStart(16))].join(''));
for (const key of keys)
{
    console.log([key.padEnd(16),
        ...labels.map((l, i)=>cell(best[l][key], best[labels[0]][key], i))].join(''));
}
const means = labels.map(l=>geomean(keys.map(k=>Math.max(best[l][k], 1e-9))));
console.log(['geomean'.padEnd(16), ...means.map((g, i)=>cell(g, means[0], i))].join(''));
if (unanswered.length)
{
    console.log(`no answer in ${JOB_LIMIT_MS / 1000} s, run again: ${unanswered.join('; ')}`);
}
console.log(wrong.length ? `WRONG:\n${wrong.join('\n')}` : 'every checksum is the processor\'s');
console.log(`${((Date.now() - started) / 1000).toFixed(0)} s`);
// Nothing left to wait for: a socket the browser left half-open would hold the process.
process.exit(wrong.length ? 1 : 0);
