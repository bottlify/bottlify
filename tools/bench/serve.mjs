/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Serves the checkout for the stand's page (`tools/bench/index.html`), cross-origin
 * isolated so a worker's clock is fine-grained, and prints its address -- or, with
 * `--check`, opens it in headless Chromium, runs it and prints what it found: the
 * stand's gate in a browser (exit 1 where the work differs from `expected.json` or
 * the page failed).
 *
 *     node tools/bench/serve.mjs [--dir DIR] [--port N]
 *     node tools/bench/serve.mjs [--dir DIR] --check [--timed] [--runs N] [--bits 32|64]
 *         [--agent STRING]
 *
 * `--dir` serves what `build.mjs` made (the page with two builds of cork) instead
 * of the checkout. `--check` runs the work alone unless `--timed`; `--agent` has
 * the browser name itself so (an iPhone's: the page then asks of cork what an
 * iPhone needs, and holds the work to that record). The browser
 * is CDP_TEST_CHROME or the first `tools/lib/browser.mjs` finds.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../lib/server.mjs';
import { launch, launchWithGpu, shutdown } from '../lib/browser.mjs';
import { CdpEndpoint, openPage } from '../lib/cdp.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const option = (name, fallback)=>(args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]
    : fallback);
// What build.mjs made, or the checkout itself.
const root = args.includes('--dir') ? resolve(option('dir', '')) : REPO;
const server = await serveStatic({ sandboxDir: root, srcDir: root,
    extra: [{ prefix: '/', root }], coi: true, port: Number(option('port', '0')) });
const url = `http://127.0.0.1:${server.port}/${root === REPO ? 'tools/bench/' : ''}index.html`;
if (!args.includes('--check'))
{
    console.log(`the stand: ${url}`);
}
else
{
    // As another browser says it is: what it asks of cork follows its agent string.
    const agent = option('agent', '');
    const browser = agent === '' ? await launch()
        : await launchWithGpu({ extraFlags: [`--user-agent=${agent}`] });
    const cdp = new CdpEndpoint(browser.browserWs);
    try
    {
        await cdp.open();
        const { sessionId } = await openPage(cdp, url);
        // An evaluation sent while the page is still loading can go unanswered:
        // each one waits two seconds at most and the loops below ask again.
        /** @param {string} expression */
        const evaluate = expression=>Promise.race([
            cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
                .then((/** @type {any} */ answer)=>answer.result?.value, ()=>undefined),
            new Promise(res=>setTimeout(()=>res(undefined), 2000)),
        ]);
        while (await evaluate('window.standReady === true') !== true)
        {
            await new Promise(res=>setTimeout(res, 100));
        }
        const bits = option('bits', '32,64');
        const button = args.includes('--timed') ? 'run' : 'workOnly';
        const runs = JSON.stringify(option('runs', '1'));
        await evaluate(`document.getElementById('bits').value = ${JSON.stringify(bits)};`
            // A count the page does not offer is added to its choices.
            + `document.getElementById('runs').add(new Option(${runs}));`
            + `document.getElementById('runs').value = ${runs};`
            + `document.getElementById(${JSON.stringify(button)}).click()`);
        let report;
        let said = '';
        while ((report = await evaluate('window.standReport ?? null')) === null)
        {
            // A line a run, as it starts.
            const status = String(await evaluate('document.getElementById("status").textContent'));
            const run = /^run \d+/.exec(status)?.[0];
            if (run !== undefined && run !== said)
            {
                console.error(run);
                said = run;
            }
            await new Promise(res=>setTimeout(res, 500));
        }
        if (report.error)
        {
            console.log(`the page failed: ${report.error}`);
            process.exitCode = 1;
        }
        else
        {
            /** @param {number[]} values */
            const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];
            const differ = report.work.filter((/** @type {any} */ row)=>row.expected !== true);
            for (const row of report.work)
            {
                const timed = report.runs.map((/** @type {any[]} */ rows)=>rows
                    .find(one=>one.name === row.name)).filter(Boolean);
                const time = timed.length === 0 ? '' : `${report.arms.map((/** @type {any} */ _,
                    /** @type {number} */ arm)=>median(timed.map((/** @type {any} */ one)=>one.mips[arm]))
                    .toFixed(0).padStart(6)).join(' /')} MIPS  `;
                const work = row.expected === true ? 'as recorded'
                    : row.expected === false ? 'DIFFERS' : 'not recorded';
                const parted = row.same ? '' : ', arms differ';
                console.log(`${row.name.padEnd(24)} ${time}work ${work}${parted}`);
            }
            console.log(`settings: ${JSON.stringify(report.settings)}`);
            const named = report.device.userAgent.match(/Chrome\/[\d.]+/)?.[0]
                ?? report.device.userAgent;
            const verdict = differ.length === 0 ? 'work as recorded everywhere'
                : `work differs in ${differ.length}`;
            console.log(`${named}: ${report.work.length} workloads, ${report.arms.length} build(s),`
                + ` ${report.seconds.toFixed(0)} s, ${verdict}`);
            process.exitCode = differ.length === 0 ? 0 : 1;
        }
    }
    finally
    {
        cdp.close();
        await shutdown(browser);
        await server.close();
    }
}
