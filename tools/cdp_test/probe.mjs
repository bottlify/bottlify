/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_ROOT = resolve(TOOL_ROOT, '..', '..');
const SANDBOX_DIR = join(REPO_ROOT, 'modules', 'core', 'test', 'page');
const SRC_DIR = join(REPO_ROOT, 'modules', 'core', 'src');
const REPORTS_DIR = join(TOOL_ROOT, 'reports');

/**
 * @typedef {Object} ProbeResult
 * @property {number} attempt
 * @property {boolean} ok
 * @property {number} pingMs
 * @property {string[]} modules
 * @property {string} screenshot  Path of the saved screenshot, relative to tools/cdp_test.
 * @property {string} pageUrl
 */

/**
 * Runs the acceptance probe: browser → page → worker → ping → screenshot.
 *
 * @param {Object} [options]
 * @param {number} [options.attempts] Retries on transient browser failures.
 * @returns {Promise<ProbeResult>}
 */
export async function probe({ attempts = 3 } = {}){
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++)
    {
        try {
            return await singleProbe(attempt);
        } catch (e){
            lastError = e;
            console.error(`probe attempt ${attempt}/${attempts} failed: ${e.message}`);
        }
    }
    throw lastError;
}

/**
 * @param {number} attempt
 * @returns {Promise<ProbeResult>}
 */
async function singleProbe(attempt){
    const server = await serveStatic({ sandboxDir: SANDBOX_DIR, srcDir: SRC_DIR });
    const browser = await launch();

    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pageUrl = `http://127.0.0.1:${server.port}/sandbox/index.html`;
    const screenshotPath = join(REPORTS_DIR, `probe-${stamp}-a${attempt}.png`);

    let cdp = null;
    try {
        cdp = new CdpEndpoint(browser.browserWs);
        await cdp.open();

        const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Page.enable', {}, sessionId);

        /** @type {string[]} */
        const pageEvents = [];
        cdp.on('Runtime.exceptionThrown', params=>{
            pageEvents.push('exception: '
                + `${params.exceptionDetails?.exception?.description ?? JSON.stringify(params)}`);
        });
        cdp.on('Runtime.consoleAPICalled', params=>{
            const text = (params.args ?? []).map(arg=>arg.value ?? arg.description ?? '').join(' ');
            pageEvents.push(`console: ${text}`);
        });

        /** @type {any} */
        let report = null;
        const expression = `window.__bottlify__ && window.__bottlify__.probe
      ? window.__bottlify__.probe.then((r) => JSON.stringify({ pending: false, value: r }))
      : Promise.resolve(JSON.stringify({ pending: true }))`;

        for (let tick = 0; tick < 200; tick++)
        {
            const result = await cdp.send(
                'Runtime.evaluate',
                { expression, awaitPromise: true, returnByValue: true },
                sessionId,
            );
            if (result.exceptionDetails)
            {
                throw new Error('page probe rejected: '
                    + JSON.stringify(result.exceptionDetails.exception?.description
                        || result.exceptionDetails));
            }
            const parsed = JSON.parse(result.result.value);
            if (!parsed.pending)
            {
                report = parsed.value;
                break;
            }
            await new Promise(resolveDelay=>setTimeout(resolveDelay, 50));
        }
        if (!report)
        {
            let debugText = 'n/a';
            try {
                const debug = await cdp.send(
                    'Runtime.evaluate',
                    {
                        expression: `JSON.stringify({`
                            + ` href: location.href, title: document.title,`
                            + ` out: (document.querySelector("#out") || {}).textContent,`
                            + ` errors: (window.__bottlify__ && window.__bottlify__.errors) || []`
                            + `})`,
                        returnByValue: true,
                    },
                    sessionId,
                );
                debugText = debug.result?.value ?? JSON.stringify(debug);
            } catch (e){
                debugText = `debug-eval failed: ${e.message}`;
            }
            throw new Error(`worker did not answer ping within 10s; page: ${debugText}; `
                + `events: ${pageEvents.join(' | ')}`);
        }

        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));

        return {
            attempt,
            ok: report.ok === true,
            pingMs: report.pingMs,
            modules: report.modules,
            screenshot: `tools/cdp_test/reports/${screenshotPath.split(/[\\/]/).pop()}`,
            pageUrl,
        };
    } finally {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
}

/**
 * Prints a probe run as JSON and exits with a nonzero code on failure.
 *
 * @returns {Promise<number>} process exit code
 */
export async function runProbeAndExit(){
    try {
        const result = await probe();
        console.log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
    } catch (e){
        console.error(`probe failed: ${e.message}`);
        return 1;
    }
}
