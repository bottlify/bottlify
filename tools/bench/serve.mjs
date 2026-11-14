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
 *     node tools/bench/serve.mjs [--port N]
 *     node tools/bench/serve.mjs --check [--timed] [--bits 32|64]
 *
 * `--check` runs the work alone unless `--timed`. The browser is CDP_TEST_CHROME
 * or the first `tools/lib/browser.mjs` finds.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../lib/server.mjs';
import { launch, shutdown } from '../lib/browser.mjs';
import { CdpEndpoint, openPage } from '../lib/cdp.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const option = (name, fallback)=>(args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]
    : fallback);
const server = await serveStatic({ sandboxDir: REPO, srcDir: REPO,
    extra: [{ prefix: '/', root: REPO }], coi: true, port: Number(option('port', '0')) });
const url = `http://127.0.0.1:${server.port}/tools/bench/index.html`;
if (!args.includes('--check'))
{
    console.log(`the stand: ${url}`);
}
else
{
    const browser = await launch();
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
        await evaluate(`document.getElementById('bits').value = ${JSON.stringify(bits)};`
            + `document.getElementById(${JSON.stringify(button)}).click()`);
        let report;
        let said = '';
        while ((report = await evaluate('window.standReport ?? null')) === null)
        {
            const status = await evaluate('document.getElementById("status").textContent');
            if (status !== said && /^\d+ of/.test(status) && !status.startsWith(said.split(' ')[0]))
            {
                console.error(status);
            }
            said = status;
            await new Promise(res=>setTimeout(res, 500));
        }
        if (report.error)
        {
            console.log(`the page failed: ${report.error}`);
            process.exitCode = 1;
        }
        else
        {
            const differ = report.rows.filter((/** @type {any} */ row)=>row.expected !== true);
            for (const row of report.rows)
            {
                const time = row.mips ? `${row.mips[0].toFixed(0).padStart(6)} MIPS`
                    + `  noise ±${(row.noise * 100).toFixed(1)} %  ` : '';
                const work = row.expected === true ? 'as recorded'
                    : row.expected === false ? 'DIFFERS' : 'not recorded';
                console.log(`${row.name.padEnd(24)} ${time}work ${work}`);
            }
            const named = report.device.userAgent.match(/Chrome\/[\d.]+/)?.[0]
                ?? report.device.userAgent;
            const verdict = differ.length === 0 ? 'work as recorded everywhere'
                : `work differs in ${differ.length}`;
            console.log(`${named}: ${report.rows.length} workloads in`
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
