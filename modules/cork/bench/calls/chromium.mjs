/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page run in headless Chromium for one tier, its result written out:
 *
 *     node modules/cork/bench/calls/chromium.mjs turbofan tf.json [runs] [ms]
 *     node modules/cork/bench/calls/chromium.mjs liftoff lo.json
 *
 * The browser is CDP_TEST_CHROME or the first `tools/cdp_test` finds.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CdpEndpoint } from '../../../../tools/cdp_test/cdp.mjs';
import { launchWithGpu, shutdown } from '../../../../tools/cdp_test/browser.mjs';

const [tier = 'turbofan', out = 'calls.json', runs = '9', ms = '200'] = process.argv.slice(2);
const FLAGS = /** @type {Record<string, string>} */ ({
    turbofan: '--js-flags=--no-liftoff',
    liftoff: '--js-flags=--liftoff --no-wasm-tier-up',
    default: '',
});
const page = fileURLToPath(new URL('./calls.html', import.meta.url));
const browser = await launchWithGpu({ extraFlags: FLAGS[tier] ? [FLAGS[tier]] : [] });
const cdp = new CdpEndpoint(browser.browserWs);
try
{
    await cdp.open?.();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `${pathToFileURL(page).href}?auto=1&tier=${tier}`
        + `&runs=${runs}&ms=${ms}` }, sessionId);
    for (;;)
    {
        await new Promise(resolve=>setTimeout(resolve, 2000));
        const { result } = await cdp.send('Runtime.evaluate', { expression:
            `JSON.stringify({ status: document.getElementById('status')?.textContent,
                result: globalThis.result ?? null })`, returnByValue: true }, sessionId);
        const state = JSON.parse(result.value);
        if (state.result)
        {
            const { product } = await cdp.send('Browser.getVersion', {});
            state.result.environment.browser = product;
            writeFileSync(out, `${JSON.stringify(state.result, null, 1)}\n`);
            console.log(`${tier}: written ${out}`);
            break;
        }
        if (/other registers/.test(state.status ?? ''))
        {
            throw new Error(state.status);
        }
    }
}
finally
{
    await shutdown(browser);
}
