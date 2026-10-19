/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The launcher's layout at several screen sizes, as screenshots: a phone, a
 * tablet, a laptop and a desktop, each with the page as it opens and, given a
 * card's title, with that card in the grid and with its details
 * open. For judging a layout change by
 * eye on every size at once, without a person resizing a window or holding a
 * phone. Headless, its own profile; nothing of a running launcher tab is
 * touched.
 *
 *   node tools/cdp_test/ui-layout.mjs [card regex] [--url URL] [--out DIR]
 *
 * The launcher runs over TLS on 5180 (`npm run ui`), or `--url` names another,
 * such as https://bottlify.app/library. Pictures land in dbg/ui-layout.
 */

import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';

const SIZES = [
    { name: 'phone', width: 390, height: 844, scale: 3, mobile: true },
    { name: 'phone-landscape', width: 844, height: 390, scale: 3, mobile: true },
    { name: 'tablet', width: 820, height: 1180, scale: 2, mobile: true },
    { name: 'laptop', width: 1366, height: 768, scale: 1, mobile: false },
    { name: 'desktop', width: 1920, height: 1080, scale: 1, mobile: false },
];

const args = process.argv.slice(2);
const option = (/** @type {string} */ name, /** @type {string} */ fallback)=>{
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : fallback;
};
const url = option('--url', 'https://127.0.0.1:5180/library');
const out = resolve(option('--out', 'dbg/ui-layout'));
const card = args[0] ? new RegExp(args[0], 'i') : null;

/** @param {number} ms */
const sleep = ms=>new Promise(done=>setTimeout(done, ms));

await mkdir(out, { recursive: true });
const profileDir = await mkdtemp(join(tmpdir(), 'bottlify-ui-layout-'));
const browser = await launchWithGpu({ profileDir, extraFlags: ['--ignore-certificate-errors'] });
const cdp = new CdpEndpoint(browser.browserWs);
await cdp.open();
try
{
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    /** @param {string} method @param {Record<string, unknown>} [params] */
    const send = (method, params = {})=>cdp.send(method, params, sessionId);
    /** @param {string} expression */
    const evaluate = async expression=>(await send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true })).result?.value;
    /** @param {string} file */
    const shot = async file=>{
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(out, file), Buffer.from(data, 'base64'));
        console.log(join(out, file));
    };
    await send('Page.enable');
    await send('Runtime.enable');
    for (const size of SIZES)
    {
        await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height,
            deviceScaleFactor: size.scale, mobile: size.mobile });
        await send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile });
        await send('Page.navigate', { url });
        // The library fills in from its manifests after the page loads.
        const pictures = 'document.querySelectorAll("img").length > 0';
        for (let i = 0; i < 40 && !(await evaluate(pictures)); i++)
        {
            await sleep(250);
        }
        await sleep(1000);
        await shot(`${size.name}.png`);
        if (!card)
        {
            continue;
        }
        const find = `[...document.querySelectorAll('img[alt]')]
            .find((img) => new RegExp(${JSON.stringify(card.source)}, 'i').test(img.alt))`;
        // The card in the grid first, scrolled to the middle of the screen, then its details.
        if (!(await evaluate(`(() => { const hit = ${find};
            hit?.scrollIntoView({ block: 'center' }); return Boolean(hit); })()`)))
        {
            console.log(`${size.name}: no card's picture is titled like ${card}`);
            continue;
        }
        await sleep(500);
        await shot(`${size.name}-grid.png`);
        await evaluate(`${find}.click()`);
        await sleep(1200);   // the panel slides in
        await shot(`${size.name}-details.png`);
    }
}
finally
{
    await shutdown(browser);
    // The browser lets go of its profile a moment after it exits.
    await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
        .catch(()=>{});
}
