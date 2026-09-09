/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Making a failure happen again, on demand.
 *
 * A crash a person reaches by clicking through a menu is the hardest kind to
 * work on: it takes a minute of somebody's attention to produce, it cannot be
 * put in a test, and each attempt costs the same minute again. What it needs is
 * not another report but a way to press the same buttons without a person.
 *
 * So a scenario here is data, not code: a list of steps -- wait, click, type,
 * hide the page, look -- written in a small JSON file beside the bundle or
 * given on the command line. The tool runs them against a real browser, and the
 * moment the engine reports a fault it prints the whole trace and stops with a
 * failing status. That makes a crash a thing that can be re-run after a change
 * rather than re-described, and a scenario file is the record of what it takes.
 *
 *     node tools/cdp_test/repro.mjs <bundle-id> [--scenario <file.json>]
 *                                   [--seconds 120] [--video] [--keep]
 *
 * A scenario is `{ "steps": [ ... ] }`, each step one of:
 *
 *     { "wait": 5000 }                       milliseconds
 *     { "click": [400, 300] }                canvas coordinates, left button
 *     { "type": "escape" }                   a key, by name or character
 *     { "hide": 8000 }                       put the page in the background
 *     { "note": "the campaign menu" }        printed, so a log reads as a path
 *     { "until": "frames > 100", "for": 30000 }   wait for a condition
 *
 * With no scenario it simply runs and watches, which is the shortest way to ask
 * "does this still crash on its own".
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { openBundle } from '../btl.mjs';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_ROOT = resolve(TOOL_ROOT, '..', '..');
const PACKAGE_DIR = join(REPO_ROOT, 'modules', 'core');
const BUNDLES_DIR = join(REPO_ROOT, 'bundles');
const REPORTS_DIR = join(TOOL_ROOT, 'reports');

/** @param {string[]} argv */
function parse(argv){
    /** @param {string} flag @param {string | null} fallback */
    const value = (flag, fallback)=>{
        const at = argv.indexOf(flag);
        return at === -1 ? fallback : argv[at + 1];
    };
    return {
        id: argv.find(argument=>!argument.startsWith('--')
            && argv[argv.indexOf(argument) - 1] !== '--scenario'
            && argv[argv.indexOf(argument) - 1] !== '--seconds'),
        scenario: value('--scenario', null),
        seconds: Number(value('--seconds', '120')),
        video: argv.includes('--video'),
        // Leaves the browser open at the end, for looking at what the last step
        // reached. Off by default: an abandoned browser is the one thing that
        // makes the next run unreliable.
        keep: argv.includes('--keep'),
    };
}

/** Keys a scenario may name, beyond a single printable character. */
const KEYS = {
    escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 0x1b },
    enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 0x0d },
    space: { code: 'Space', key: ' ', windowsVirtualKeyCode: 0x20 },
    tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 0x09 },
    backspace: { code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 0x08 },
};

const options = parse(process.argv.slice(2));
if (!options.id)
{
    console.error('usage: node tools/cdp_test/repro.mjs <bundle-id>'
        + ' [--scenario file.json] [--seconds 120] [--video] [--keep]');
    process.exit(2);
}

const directory = join(BUNDLES_DIR, options.id);
if (!existsSync(join(directory, 'bundle.btl')))
{
    console.error(`no bundle at ${join(directory, 'bundle.btl')}`);
    process.exit(2);
}

/** @type {{ steps: any[] }} */
let scenario = { steps: [] };
const scenarioPath = options.scenario
    ?? (existsSync(join(directory, 'repro.json')) ? join(directory, 'repro.json') : null);
if (scenarioPath)
{
    scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
    console.log(`scenario: ${scenarioPath}, ${scenario.steps.length} step(s)`);
}

const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const opened = await openBundle(join(directory, 'bundle.btl'));
const executable = await opened.read(manifest.entry);
await opened.close();

const server = await serveStatic({
    sandboxDir: PACKAGE_DIR,
    srcDir: join(PACKAGE_DIR, 'src'),
    extra: [{ prefix: '/bundle/', root: directory }],
});
const browser = await launchWithGpu();
/** @type {CdpEndpoint | null} */
let cdp = null;
let reproduced = false;
try
{
    cdp = new CdpEndpoint(browser.browserWs);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', {
        url: `http://127.0.0.1:${server.port}/sandbox/test/page/game/index.html`,
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);

    /** @param {string} expression */
    const evaluate = async expression=>{
        const answer = await cdp.send('Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (answer.exceptionDetails)
        {
            throw new Error(String(answer.exceptionDetails.exception?.description).slice(0, 300));
        }
        return answer.result.value;
    };
    /** @param {number} delay */
    const sleep = delay=>new Promise(done=>setTimeout(done, delay));

    for (let tries = 0; tries < 60; tries++)
    {
        await sleep(500);
        const gpu = await evaluate('window.__bottlify__ && window.__bottlify__.gpu'
            + ' ? window.__bottlify__.gpu.then(g=>JSON.stringify(g)) : null');
        if (gpu)
        {
            const handle = JSON.parse(gpu);
            if (!handle.available)
            {
                console.error(`no WebGPU device: ${handle.reason}`);
                process.exit(3);
            }
            break;
        }
    }

    // The run is started and not awaited: the whole point is to act on the page
    // while the title is up, and the answer arrives when it stops.
    const run = evaluate(`window.__bottlify__.start(${JSON.stringify({
        exe: Buffer.from(executable).toString('base64'),
        bundleUrl: `http://127.0.0.1:${server.port}/bundle/bundle.btl`,
        imagePath: `C:\\App\\${manifest.entry}`,
        maxTurns: Number.MAX_SAFE_INTEGER,
        video: options.video,
    })})`);

    /** Whatever the engine has already said went wrong, or null. */
    const failureNow = async()=>{
        const text = await evaluate(
            'window.__bottlify__.frameReport ? window.__bottlify__.frameReport() : null');
        if (!text)
        {
            return null;
        }
        const seen = JSON.parse(text);
        return seen.failure ?? null;
    };

    /**
     * Sleeps, but stops early and loudly the moment the engine faults. Every
     * wait in a scenario goes through here, so a crash is noticed at the step
     * that caused it rather than at the end of the list.
     *
     * @param {number} ms
     * @returns {Promise<boolean>} whether a failure was seen
     */
    const watch = async ms=>{
        const until = Date.now() + ms;
        while (Date.now() < until)
        {
            await sleep(Math.min(500, until - Date.now()));
            const failed = await Promise.race([
                run.then(()=>'stopped', ()=>'stopped'),
                Promise.resolve(null),
            ]);
            if (failed === 'stopped')
            {
                return true;
            }
            if (await failureNow())
            {
                return true;
            }
        }
        return false;
    };

    /** @param {number} x @param {number} y */
    const click = async(x, y)=>{
        for (const type of ['mousePressed', 'mouseReleased'])
        {
            await cdp.send('Input.dispatchMouseEvent', {
                type, x, y, button: 'left', clickCount: 1,
                buttons: type === 'mousePressed' ? 1 : 0,
            }, sessionId);
            await sleep(40);
        }
    };

    /** @param {string} what */
    const type = async what=>{
        const named = KEYS[/** @type {keyof typeof KEYS} */ (what.toLowerCase())];
        const key = named ?? {
            code: `Key${what.toUpperCase()}`, key: what,
            windowsVirtualKeyCode: what.toUpperCase().charCodeAt(0),
        };
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }, sessionId);
        if (!named)
        {
            await cdp.send('Input.dispatchKeyEvent',
                { type: 'char', text: what, ...key }, sessionId);
        }
        await sleep(30);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, sessionId);
    };

    /**
     * Puts the page in the background for a while, the way minimising a window
     * does: a second tab is brought to the front, which is the only thing that
     * makes a real browser stop animation frames and throttle timers. Anything
     * that only works while somebody is looking at it fails here.
     *
     * @param {number} ms
     */
    const hide = async ms=>{
        const other = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const attached = await cdp.send('Target.attachToTarget',
            { targetId: other.targetId, flatten: true });
        await cdp.send('Page.bringToFront', {}, attached.sessionId);
        const faulted = await watch(ms);
        await cdp.send('Page.bringToFront', {}, sessionId);
        await cdp.send('Target.closeTarget', { targetId: other.targetId });
        return faulted;
    };

    /** @param {any} step */
    const perform = async step=>{
        if (step.note !== undefined)
        {
            console.log(`  · ${step.note}`);
        }
        if (step.click)
        {
            await click(step.click[0], step.click[1]);
            return watch(step.after ?? 500);
        }
        if (step.type !== undefined)
        {
            await type(String(step.type));
            return watch(step.after ?? 500);
        }
        if (step.hide !== undefined)
        {
            return hide(Number(step.hide));
        }
        if (step.until !== undefined)
        {
            const until = Date.now() + Number(step['for'] ?? 30000);
            while (Date.now() < until)
            {
                if (await watch(500))
                {
                    return true;
                }
                const met = await evaluate('(()=>{ const r = window.__bottlify__.frameReport'
                    + ' ? JSON.parse(window.__bottlify__.frameReport()) : null;'
                    + ` return r ? Boolean(${step.until}) : false; })()`);
                if (met)
                {
                    return false;
                }
            }
            console.log(`  · gave up waiting for ${step.until}`);
            return false;
        }
        return watch(Number(step.wait ?? 1000));
    };

    console.log(`running ${manifest.title}`);
    for (const step of scenario.steps)
    {
        reproduced = await perform(step);
        if (reproduced)
        {
            break;
        }
    }
    if (!reproduced)
    {
        // Whatever time is left after the scripted path, spent watching. A
        // crash that needs a few seconds of the menu running is still a crash.
        const spent = scenario.steps.reduce(
            (total, step)=>total + Number(step.wait ?? step.hide ?? step.after ?? 500), 0);
        reproduced = await watch(Math.max(0, options.seconds * 1000 - spent));
    }

    const answer = await Promise.race([run.catch(e=>({ error: String(e) })),
        sleep(2000).then(()=>null)]);
    const report = JSON.parse(await evaluate(
        'window.__bottlify__.frameReport ? window.__bottlify__.frameReport() : "null"')
        ?? 'null') ?? {};

    console.log('');
    if (reproduced || report.failure || answer?.error)
    {
        console.log('REPRODUCED');
        const failure = report.failure ?? answer ?? {};
        console.log(`  ${failure.reason ?? ''} ${failure.message ?? failure.error ?? ''}`.trim());
        if (failure.trace)
        {
            console.log('');
            console.log(failure.trace);
        }
        await mkdir(REPORTS_DIR, { recursive: true });
        const where = join(REPORTS_DIR, `repro-${options.id}.json`);
        await writeFile(where, JSON.stringify({ scenario, failure, report }, null, 2));
        console.log('');
        console.log(`written to ${where}`);
    }
    else
    {
        console.log('NOT REPRODUCED');
        console.log(`  ${report.frames ?? 0} frames, ${report.instructions ?? 0} instructions`);
    }
}
finally
{
    if (!options.keep)
    {
        cdp?.close();
        await shutdown(browser);
    }
    await server.close();
}

process.exit(reproduced ? 1 : 0);
