/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What waking an idle worker costs, in the browser: a batch posted with its
 * buffer transferred (2 KiB and 64 KiB) against its bytes put in shared memory
 * and `Atomics.notify` to a reader waiting in `Atomics.waitAsync` -- the two
 * ways the graphics worker's batches were and are handed over. A batch every
 * 8 ms, `n` a run, `rounds` of the three modes alternated, in headless
 * Chromium with cross-origin isolation (`wake-latency/`).
 *
 *     node tools/run/wake-latency.mjs [--n 400] [--rounds 6]
 *
 * Prints each run's median and 90th percentile of the sender's cost and of
 * the way to the reader, in microseconds, then each mode's medians of runs.
 */

import { fileURLToPath } from 'node:url';
import { launch, shutdown } from '../lib/browser.mjs';
import { CdpEndpoint, openPage } from '../lib/cdp.mjs';
import { serveStatic } from '../lib/server.mjs';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const page = fileURLToPath(new URL('./wake-latency/', import.meta.url));
const server = await serveStatic({ sandboxDir: page, srcDir: page, coi: true });
const browser = await launch();
const cdp = new CdpEndpoint(browser.browserWs);
await cdp.open();
const { sessionId } = await openPage(cdp, `${/** @type {any} */ (server).url
    ?? `http://127.0.0.1:${/** @type {any} */ (server).port}`}/sandbox/index.html?n=${
    flag('--n', '400')}&rounds=${flag('--rounds', '6')}`);
/** @type {any[] | null} */
let results = null;
for (let look = 0; look < 1200 && !results; look++)
{
    await new Promise(done=>setTimeout(done, 500));
    const answer = await cdp.send('Runtime.evaluate',
        { expression: 'JSON.stringify(globalThis.__result ?? null)', returnByValue: true },
        sessionId);
    results = JSON.parse(answer.result.value ?? 'null');
}
if (!results)
{
    console.error('wake-latency: the page gave no answer');
    process.exit(1);
}
/** @param {number[]} values @param {number} q */
const quantile = (values, q)=>{
    const sorted = [...values].sort((a, b)=>a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};
/** @param {number} ms */
const us = ms=>(ms * 1000).toFixed(1);
for (const run of results)
{
    console.log(`round ${run.round} ${run.mode.padEnd(6)} send us median ${us(quantile(run.send,
        0.5))} p90 ${us(quantile(run.send, 0.9))} | arrival us median ${us(quantile(run.arrival,
        0.5))} p90 ${us(quantile(run.arrival, 0.9))}`);
}
for (const mode of ['post', 'post64', 'ring'])
{
    const runs = results.filter(run=>run.mode === mode);
    console.log(`${mode}: medians of runs: send ${runs.map(run=>us(quantile(run.send, 0.5)))
        .join(' ')}; arrival ${runs.map(run=>us(quantile(run.arrival, 0.5))).join(' ')}`);
}
await shutdown(browser);
/** @type {any} */ (server).close?.();
process.exit(0);
