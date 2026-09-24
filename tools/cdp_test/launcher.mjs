/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where the launcher's thread goes while a title runs.
 *
 * The frame harness measures the engine on its own page, and the launcher is
 * a different path: a real audio thread, a decoder, a settings panel, and its
 * own way of putting a frame on the screen. A fix measured on the harness is
 * not proven until it has been driven through here, and this is the
 * instrument for that: it starts a title in the launcher the way a person
 * does -- a card, then Play -- lets it settle, and samples the page's main
 * thread with the browser's own profiler. What comes back is which functions
 * the time went to, by self time, in the engine and around it.
 *
 *   node tools/cdp_test/launcher.mjs <bundle-id> [--seconds 30] [--settle 40]
 *       [--url http://127.0.0.1:5180/] [--heap]
 *
 * The launcher has to be running already (`npm run ui`).
 */

import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { summarise } from './profile.mjs';

const argv = process.argv.slice(2);
const bundleId = argv.find(arg=>!arg.startsWith('--')) ?? 'warcraft-iii-frozen-throne';
/** @param {string} flag @param {number} fallback */
const number = (flag, fallback)=>{
    const at = argv.indexOf(flag);
    return at >= 0 ? Number(argv[at + 1]) : fallback;
};
/** @param {string} flag @param {string} fallback */
const text = (flag, fallback)=>{
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : fallback;
};
const options = {
    seconds: number('--seconds', 30),
    settle: number('--settle', 40),
    url: text('--url', 'http://127.0.0.1:5180/'),
    heap: argv.includes('--heap'),
    // A window the person can watch, unless they said otherwise: what they see
    // there is the thing being measured.
    headed: !argv.includes('--headless'),
    // Settings to write into the launcher before it starts, as the panel
    // would have saved them: `--settings {"traceStrings":false}`.
    settings: text('--settings', ''),
};

/** @param {number} ms */
const sleep = ms=>new Promise(resolve=>setTimeout(resolve, ms));


const browser = await launchWithGpu({ headed: options.headed });
/** @type {CdpEndpoint | null} */
let cdp = null;
try
{
    cdp = new CdpEndpoint(browser.browserWs);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: options.url });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    /** @param {string} expression */
    const evaluate = async expression=>{
        const answer = await cdp.send('Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (answer.exceptionDetails)
        {
            throw new Error(answer.exceptionDetails.exception?.description
                ?? answer.exceptionDetails.text);
        }
        return answer.result?.value;
    };
    /**
     * Waits for an expression to answer something truthy, the way a person
     * waits for the page to show what they are about to click.
     *
     * @param {string} expression @param {number} timeoutMs
     */
    const until = async(expression, timeoutMs)=>{
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline)
        {
            const value = await evaluate(expression).catch(()=>null);
            if (value)
            {
                return value;
            }
            await sleep(250);
        }
        throw new Error(`the launcher never showed: ${expression}`);
    };

    if (options.settings)
    {
        // Saved the way the panel saves them, then the page is loaded again so
        // the launcher reads them the way it reads a person's.
        await until(`document.readyState === 'complete'`, 30000);
        await evaluate(`localStorage.setItem('bottlify.settings', JSON.stringify({
            ...JSON.parse(localStorage.getItem('bottlify.settings') ?? '{}'),
            ...${options.settings} }))`);
        await cdp.send('Page.reload', {}, sessionId);
        console.log(`settings: ${options.settings}`);
    }

    // The library link, the card, then Play: the launcher routes by path and
    // picks by click. The link is clicked rather than navigated to so the
    // router sees a history entry, the way it does under a person.
    const libraryLink = `[...document.querySelectorAll('a')]`
        + `.find(one=>one.getAttribute('href') === '/library')`;
    await until(`Boolean(${libraryLink})`, 30000);
    await evaluate(`${libraryLink}.click()`);
    await until(`document.querySelectorAll('.MuiCard-root').length > 0`, 30000);
    const clicked = await evaluate(`(()=>{
        const cards = [...document.querySelectorAll('.MuiCard-root')];
        const card = cards.find(one=>/${bundleId.split('-')[0]}/i.test(one.textContent));
        if (!card) return 'no card: ' + cards.map(one=>one.textContent.slice(0, 30)).join(' | ');
        card.click();
        return 'ok';
    })()`);
    if (clicked !== 'ok')
    {
        throw new Error(clicked);
    }
    const playButton = `[...document.querySelectorAll('button')]`
        + `.find(one=>one.textContent.trim() === 'Play')`;
    await until(`Boolean(${playButton})`, 10000);
    await evaluate(`${playButton}.click()`);
    console.log(`started ${bundleId} in the launcher; letting it settle for ${options.settle}s`);
    // A click on the canvas is how a person skips the intro; the same click,
    // as a real mouse event, a few times while the title is starting.
    const clickCanvas = async()=>{
        const rect = await evaluate(`(()=>{
            const canvas = document.querySelector('canvas');
            if (!canvas) return null;
            const r = canvas.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        if (!rect)
        {
            return false;
        }
        for (const type of ['mousePressed', 'mouseReleased'])
        {
            await cdp.send('Input.dispatchMouseEvent',
                { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, sessionId);
        }
        return true;
    };
    for (let elapsed = 0; elapsed < options.settle; elapsed += 5)
    {
        await sleep(5000);
        if (elapsed >= 10 && await clickCanvas())
        {
            console.log(`clicked the canvas at ${elapsed + 5}s`);
        }
    }

    const stage = await evaluate(`document.body.innerText.slice(0, 400)`);
    console.log(`the page says: ${String(stage).replace(/\s+/g, ' ').slice(0, 200)}`);

    await cdp.send('Profiler.enable', {}, sessionId);
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 }, sessionId);
    if (options.heap)
    {
        await cdp.send('HeapProfiler.enable', {}, sessionId);
        await cdp.send('HeapProfiler.startSampling', {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
        }, sessionId);
    }
    // What reaches the screen: an animation frame callback runs once for
    // every frame the browser composes while the page is visible, so counting
    // them is counting the frames a person could have seen -- whatever the
    // engine presented in between.
    // And what the engine put there: the launcher takes the canvas's current
    // texture once per frame it presents, so counting those is counting the
    // frames the engine drew into the canvas.
    await evaluate(`(()=>{
        window.__bottlifyFrames = 0;
        const count = ()=>{ window.__bottlifyFrames++; requestAnimationFrame(count); };
        requestAnimationFrame(count);
        window.__bottlifyPresents = 0;
        const taken = GPUCanvasContext.prototype.getCurrentTexture;
        GPUCanvasContext.prototype.getCurrentTexture = function(){
            window.__bottlifyPresents++;
            return taken.call(this);
        };
    })()`);
    await cdp.send('Profiler.start', {}, sessionId);
    console.log(`sampling the launcher's thread for ${options.seconds}s`);
    const startedAt = Date.now();
    const drawnBefore = await evaluate('window.__bottlifyFrames');
    const presentedBefore = await evaluate('window.__bottlifyPresents');
    await sleep(options.seconds * 1000);
    const { profile } = await cdp.send('Profiler.stop', {}, sessionId);
    const drawn = (await evaluate('window.__bottlifyFrames')) - drawnBefore;
    const presented = (await evaluate('window.__bottlifyPresents')) - presentedBefore;
    const windowMs = Date.now() - startedAt;
    const summary = summarise(profile, windowMs);

    console.log(`frames the engine drew into the canvas: ${presented} in ${windowMs} ms`
        + ` = ${(presented * 1000 / windowMs).toFixed(1)} per second`);
    console.log(`frames the browser composed for the screen: ${drawn}`
        + ` = ${(drawn * 1000 / windowMs).toFixed(1)} per second`);
    console.log(`the thread was busy ${(summary.busyShare * 100).toFixed(0)}% of ${windowMs} ms`
        + ` (${summary.sampledMs.toFixed(0)} ms sampled)`);
    console.log('by file:');
    for (const row of summary.files)
    {
        console.log(`  ${(row.share * 100).toFixed(1).padStart(5)}%`
            + `  ${row.ms.toFixed(0).padStart(7)} ms  ${row.name}`);
    }
    console.log('by function, self time:');
    for (const row of summary.functions)
    {
        console.log(`  ${(row.share * 100).toFixed(1).padStart(5)}%`
            + `  ${row.ms.toFixed(0).padStart(7)} ms  ${row.name}`);
    }
    if (options.heap)
    {
        const { profile: heap } = await cdp.send('HeapProfiler.stopSampling', {}, sessionId);
        /** @type {Map<string, number>} */
        const bySite = new Map();
        let total = 0;
        /** @param {any} node */
        const walk = node=>{
            const frame = node.callFrame ?? {};
            const file = String(frame.url ?? '').split('/').pop() || '<native>';
            const size = Number(node.selfSize ?? 0);
            if (size > 0)
            {
                const line = (frame.lineNumber ?? -1) + 1;
                const key = `${frame.functionName || '<anonymous>'} ${file}:${line}`;
                bySite.set(key, (bySite.get(key) ?? 0) + size);
                total += size;
            }
            for (const child of node.children ?? [])
            {
                walk(child);
            }
        };
        walk(heap.head);
        console.log(`allocated in the window: ${(total / 1024 / 1024).toFixed(1)} MiB`
            + ` (${(total / 1024 / 1024 / (windowMs / 1000)).toFixed(1)} MiB/s)`);
        const sites = [...bySite].sort((left, right)=>right[1] - left[1]).slice(0, 20);
        for (const [site, bytes] of sites)
        {
            console.log(`  ${(bytes / total * 100).toFixed(1).padStart(5)}%  ${(bytes / 1024 / 1024).toFixed(1).padStart(7)} MiB  ${site}`);
        }
    }
}
finally
{
    cdp?.close();
    await shutdown(browser);
}
