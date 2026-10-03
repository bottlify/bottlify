/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The graphics acceptance scenario: a guest program draws on a real GPU, and
 * the pixels it produced are checked as numbers.
 *
 * Nothing here looks at a picture. The screenshot beside the report exists for
 * a person who wants to see what happened; what decides the outcome is the
 * colour of four named pixels, compared byte for byte.
 *
 * The report says more than pass or fail, because a frame can be wrong in ways
 * that a pass/fail hides: which calls the program made and what each of them
 * answered, how many pixels of each colour the frame holds, and what the
 * renderer believes it submitted. A frame that was cleared and never drawn on,
 * one that was never cleared, and one that never reached the GPU are three
 * different failures, and each of those numbers separates them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { TRIANGLE_COLOURS, TRIANGLE_REPORT } from '../make-pe.mjs';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_ROOT = resolve(TOOL_ROOT, '..', '..');
const PACKAGE_DIR = join(REPO_ROOT, 'modules', 'core');
const FIXTURE = join(PACKAGE_DIR, 'test', 'fixtures', 'triangle.exe');
const REPORTS_DIR = join(TOOL_ROOT, 'reports');

/**
 * Where the frame is read, and what has to be there.
 *
 * Two points inside the triangle and two outside it, so a frame that was
 * cleared and never drawn on fails differently from one that was never cleared.
 */
const EXPECTED = [
    { name: 'triangle-middle', x: 160, y: 150, colour: TRIANGLE_COLOURS.triangle },
    { name: 'triangle-upper', x: 160, y: 120, colour: TRIANGLE_COLOURS.triangle },
    { name: 'cleared-top-left', x: 10, y: 10, colour: TRIANGLE_COLOURS.clear },
    { name: 'cleared-bottom-right', x: 310, y: 230, colour: TRIANGLE_COLOURS.clear },
];

/**
 * Waits for an expression to answer something other than null, polling.
 *
 * A run takes longer than one CDP command will wait, so the page is asked to
 * leave its result behind rather than to hold the command open.
 *
 * @param {CdpEndpoint} cdp
 * @param {string} sessionId
 * @param {string} expression
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function poll(cdp, sessionId, expression, timeoutMs){
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        const answer = await cdp.send(
            'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true },
            sessionId);
        if (answer.exceptionDetails)
        {
            throw new Error(`page threw: ${JSON.stringify(
                answer.exceptionDetails.exception?.description ?? answer.exceptionDetails)}`);
        }
        if (answer.result.value !== null && answer.result.value !== undefined)
        {
            return JSON.parse(answer.result.value);
        }
        await new Promise(resolveDelay=>setTimeout(resolveDelay, 200));
    }
    throw new Error(`the page did not answer within ${timeoutMs}ms`);
}

/**
 * What the fixture reported, by name rather than by index.
 *
 * @param {number[] | undefined} words
 */
function named(words){
    /** @type {Record<string, string>} */
    const report = {};
    TRIANGLE_REPORT.forEach((name, index)=>{
        report[name] = words && index < words.length
            ? `0x${words[index].toString(16).padStart(8, '0')}`
            : 'not reported';
    });
    return report;
}

/**
 * The pixel checks, as numbers.
 *
 * Alpha is reported and not compared: what a D3DCOLOR's alpha means on a back
 * buffer with no alpha channel is a separate question from whether the colour
 * arrived, and this scenario is asking the second one.
 *
 * @param {any} result
 */
function checks(result){
    /** @param {number} colour */
    const rgb = colour=>[colour >> 16 & 0xff, colour >> 8 & 0xff, colour & 0xff];
    return EXPECTED.map(expectation=>{
        const found = (result.samples ?? []).find(
            (/** @type {any} */ entry)=>entry.name === expectation.name);
        const wanted = rgb(expectation.colour);
        return {
            name: expectation.name,
            at: [expectation.x, expectation.y],
            expected: wanted,
            found: found ? found.rgba.slice(0, 3) : null,
            alpha: found ? found.rgba[3] : null,
            ok: Boolean(found) && wanted.every((value, index)=>value === found.rgba[index]),
        };
    });
}

/**
 * One program, run in the page, with the frame it produced checked.
 *
 * @param {Object} deps
 * @param {CdpEndpoint} deps.cdp
 * @param {string} deps.sessionId
 * @param {Uint8Array} deps.executable
 * @returns {Promise<any>}
 */
async function runOne({ cdp, sessionId, executable }){
    // The core runs on the page's own thread and its turn loop yields
    // microtasks rather than tasks, so while a program runs nothing else on
    // that page is answered -- this driver included. A generous turn budget
    // would therefore not be generous: it would be a run this driver cannot
    // ask about until it ends. This is enough for a program that draws one
    // frame, and a program that has lost its way gives up inside it.
    const request = JSON.stringify({
        exe: Buffer.from(executable).toString('base64'),
        words: TRIANGLE_REPORT.length,
        maxTurns: 20000,
        samples: EXPECTED.map(entry=>({ name: entry.name, x: entry.x, y: entry.y })),
        // The Direct3D device drawn in the graphics worker, its frame sent back.
        graphicsWorker: process.argv.includes('--graphics-worker')
            && (process.argv[process.argv.indexOf('--graphics-worker') + 1] ?? true),
    });
    await cdp.send('Runtime.evaluate',
        { expression: `window.__bottlify__.start(${request}); null`, returnByValue: true },
        sessionId);

    const result = await poll(cdp, sessionId,
        'window.__bottlify__.result ? JSON.stringify(window.__bottlify__.result) : null',
        180000);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shotPath = join(REPORTS_DIR, `triangle-${stamp}.png`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

    const pixels = checks(result);
    return {
        ran: result.ok === true,
        exitCode: result.exitCode,
        error: result.error,
        reason: result.reason,
        trace: result.trace,
        report: named(result.report),
        frame: result.frame ?? null,
        colours: result.colours ?? null,
        pixels,
        drew: pixels.every(check=>check.ok),
        calls: result.bridge,
        graphics: result.graphics?.seam ?? null,
        renderer: result.graphics?.backend ?? null,
        pageErrors: result.errors ?? [],
        screenshot: `tools/cdp_test/reports/${shotPath.split(/[\\/]/).pop()}`,
    };
}

/**
 * Runs the scenario end to end.
 *
 * @returns {Promise<any>}
 */
export async function triangle(){
    const server = await serveStatic({
        // The whole package, because the page reaches the sources through
        // ordinary relative URLs; giving it a root per directory would mean an
        // import map that says the same thing.
        sandboxDir: PACKAGE_DIR,
        srcDir: join(PACKAGE_DIR, 'src'),
        // The translator package beside core, where app.js resolves the default engine.
        extra: [{ prefix: '/cork/', root: join(PACKAGE_DIR, '..', 'cork') }],
    });
    const browser = await launchWithGpu();
    mkdirSync(REPORTS_DIR, { recursive: true });

    const pageUrl = `http://127.0.0.1:${server.port}/sandbox/test/page/gpu/index.html`;
    /** @type {CdpEndpoint | null} */
    let cdp = null;
    try
    {
        cdp = new CdpEndpoint(browser.browserWs);
        await cdp.open();
        const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Page.enable', {}, sessionId);

        /** @type {string[]} */
        const console_ = [];
        cdp.on('Runtime.exceptionThrown', params=>{
            console_.push(`exception: ${params.exceptionDetails?.exception?.description
                ?? JSON.stringify(params)}`);
        });

        const gpu = await poll(cdp, sessionId,
            'window.__bottlify__ && window.__bottlify__.gpu'
            + ' ? window.__bottlify__.gpu.then(function(g){ return JSON.stringify(g); })'
            + ' : null',
            30000);
        if (!gpu.available)
        {
            return {
                ok: false,
                measured: false,
                reason: `no WebGPU device in this browser: ${gpu.reason}`,
                pageUrl,
                events: console_,
            };
        }

        // The committed fixture rather than a freshly built one: what is checked
        // has to be the file that ships, or the check is of this script.
        const fixture = await runOne({
            cdp, sessionId,
            executable: new Uint8Array(await readFile(FIXTURE)),
        });

        return {
            ok: fixture.drew,
            measured: true,
            adapter: gpu.adapter,
            pageUrl,
            fixture,
            events: console_,
        };
    }
    finally
    {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
}

/**
 * Prints the run as JSON and answers with a process exit code.
 *
 * @returns {Promise<number>}
 */
export async function runTriangleAndExit(){
    try
    {
        const result = await triangle();
        console.log(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
    }
    catch (e){
        console.error(`triangle scenario failed: ${e.stack ?? e.message}`);
        return 1;
    }
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href)
{
    process.exit(await runTriangleAndExit());
}
