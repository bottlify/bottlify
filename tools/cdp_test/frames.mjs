/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a frame's time goes.
 *
 * The scenario beside this one answers what a whole run cost, which is the
 * wrong question for a frame rate: a run is dominated by starting up, and the
 * thing anyone wants to change is what the next frame costs once a title is up.
 * So this one lets the title settle, watches for a fixed window, and reports
 * per frame -- how much of one was ours and how much the guest's, which phases
 * made it up, and how the slow frames differ from the ordinary ones.
 *
 * A frame is counted where the engine presents, so it is the program's own
 * frame rather than anything this tool imposes.
 *
 *     node tools/cdp_test/frames.mjs <bundle-id> [--seconds 60] [--settle 20]
 *                                    [--video]
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

/** @param {string[]} argv */
function parse(argv){
    /** @param {string} flag @param {number} fallback */
    const number = (flag, fallback)=>{
        const at = argv.indexOf(flag);
        return at === -1 ? fallback : Number(argv[at + 1]);
    };
    return {
        id: argv.find(argument=>!argument.startsWith('--')),
        /** How long to watch once the title is up. */
        seconds: number('--seconds', 60),
        // How long to let it start first. Measuring through loading measures
        // loading, and every phase of that is one no frame ever pays.
        settle: number('--settle', 20),
        // A cinematic is minutes long and is not the steady state either.
        video: argv.includes('--video'),
    };
}

/** @param {number} value */
const asMs = value=>`${value.toFixed(2)}ms`;

/** @param {number[]} values @param {number} share */
function quantile(values, share){
    if (values.length === 0)
    {
        return 0;
    }
    const sorted = [...values].sort((one, two)=>one - two);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/**
 * @param {any} before @param {any} after @param {number} windowMs
 * @returns {string}
 */
function describe(before, after, windowMs){
    /** @type {string[]} */
    const lines = [];
    /** @param {string} text */
    const say = text=>lines.push(text);

    const frames = after.frames - before.frames;
    const instructions = after.instructions - before.instructions;
    const draws = (after.graphics?.draws ?? 0) - (before.graphics?.draws ?? 0);
    const seconds = windowMs / 1000;

    say(`watched ${seconds.toFixed(1)}s and saw ${frames} frames`);
    say(`  ${(frames / seconds).toFixed(1)} frames per second`
        + `, ${asMs(frames > 0 ? windowMs / frames : 0)} per frame`);
    say(`  ${(instructions / seconds / 1e6).toFixed(1)}M guest instructions per second`);
    if (draws > 0)
    {
        say(`  ${(draws / Math.max(1, frames)).toFixed(0)} draw calls per frame`);
    }
    say('');

    /** @type {number[]} */
    const spread = after.recentFrames.map((/** @type {any} */ frame)=>frame.ms);
    say('one frame, as the engine measured it:');
    say(`  median ${asMs(quantile(spread, 0.5))}`
        + `   ninety-fifth ${asMs(quantile(spread, 0.95))}`
        + `   worst ${asMs(quantile(spread, 1))}`);
    // The share is what says which side to change. Mostly the guest means the
    // answer is the emulator; mostly ours means it is our own code.
    say(`  ours ${(after.hostShare * 100).toFixed(1)}% of a frame,`
        + ` the guest ${((1 - after.hostShare) * 100).toFixed(1)}%`);
    say('');

    /** @type {Map<string, any>} */
    const was = new Map(before.phases.map((/** @type {any} */ row)=>[row.name, row]));
    const grew = after.phases.map((/** @type {any} */ row)=>{
        const older = was.get(row.name);
        return {
            name: row.name,
            kind: row.kind,
            count: row.count - (older?.count ?? 0),
            selfMs: row.selfMs - (older?.selfMs ?? 0),
            worstMs: row.worstMs,
        };
    }).filter((/** @type {any} */ row)=>row.selfMs > 0)
        .sort((/** @type {any} */ one, /** @type {any} */ two)=>two.selfMs - one.selfMs);

    say('where the time went, per frame:');
    for (const row of grew.slice(0, 18))
    {
        const perFrame = frames > 0 ? row.selfMs / frames : 0;
        const share = windowMs > 0 ? (row.selfMs / windowMs) * 100 : 0;
        say(`  ${asMs(perFrame).padStart(10)}  ${share.toFixed(1).padStart(5)}%`
            + `  ${String(Math.round(row.count / Math.max(1, frames))).padStart(6)}/frame`
            + `  worst ${asMs(row.worstMs).padStart(9)}  ${String(row.kind).padEnd(5)}`
            + ` ${row.name}`);
    }
    say('');

    const slices = after.slices ?? null;
    if (slices && slices.quantum > 0)
    {
        const turns = slices.turns - (before.slices?.turns ?? 0);
        const past = slices.overruns - (before.slices?.overruns ?? 0);
        say(`the slice: ${slices.quantum} instructions asked for`
            + `, ${past} of ${turns} turns ran past it`
            + `${slices.worst > 0 ? `, worst ${slices.worst}` : ''}`);
        say('');
    }

    const messages = after.messages ?? null;
    if (messages)
    {
        const pumped = Object.entries(messages.byMessage ?? {})
            .map(([id, count])=>`${id} x${count}`).join('  ');
        say(`what the loop pumps: ${pumped || 'nothing'}`);
        say(`  ${messages.timers} timer(s) armed`
            + `${messages.timerDue === null ? '' : `, next due at ${messages.timerDue}ms`}`
            + `, ${messages.depth} waiting now`);
        say('');
    }

    if (after.presenter)
    {
        const shown = after.presenter;
        say(`what reached the screen: ${shown.presents} presented`
            + `, ${shown.uploads} uploaded, ${shown.shownByOwner} shown by their owner`);
        if ((shown.failures ?? []).length > 0)
        {
            say(`  refused: ${shown.failures.slice(0, 3).join('; ')}`);
        }
        say('');
    }
    if (after.media && after.media.configured)
    {
        say(`the film: ${after.media.opened ?? 0} opened`
            + `, ${after.media.frames ?? 0} frames decoded`);
        if (after.film)
        {
            const held = after.film;
            say(`  ${held.ticks} ticks carried something, ${held.frames} carried a picture`);
            say(`  shown ${held.shown}`
                + `, no picture ${held.silent}`
                + `, nowhere to show it ${held.noScreen}`
                + `, no room for it ${held.noRoom}`);
        }
        say('');
    }

    say('the slowest frames, and what they were made of:');
    for (const frame of after.worstFrames.slice(0, 5))
    {
        const parts = Object.entries(frame.byKind)
            .filter(([, value])=>Number(value) > 0)
            .map(([kind, value])=>`${kind} ${asMs(Number(value))}`)
            .join(', ');
        say(`  frame ${String(frame.index).padStart(6)}  ${asMs(frame.ms).padStart(9)}`
            + `   ${parts}`);
    }
    return `${lines.join('\n')}\n`;
}

const options = parse(process.argv.slice(2));
if (!options.id)
{
    console.error('usage: node tools/cdp_test/frames.mjs <bundle-id> [--seconds 60]'
        + ' [--settle 20] [--video]');
    process.exit(2);
}

const directory = join(BUNDLES_DIR, options.id);
if (!existsSync(join(directory, 'bundle.btl')))
{
    console.error(`no bundle at ${join(directory, 'bundle.btl')}`);
    process.exit(2);
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

    await evaluate(`window.__bottlify__.start(${JSON.stringify({
        exe: Buffer.from(executable).toString('base64'),
        bundleUrl: `http://127.0.0.1:${server.port}/bundle/bundle.btl`,
        imagePath: `C:\\App\\${manifest.entry}`,
        maxTurns: Number.MAX_SAFE_INTEGER,
        video: options.video,
    })}); null`);

    /** Waits until the page has a report and answers with it. */
    const read = async()=>{
        for (let tries = 0; tries < 300; tries++)
        {
            try
            {
                const text = await evaluate(
                    'window.__bottlify__.frameReport ? window.__bottlify__.frameReport() : null');
                if (text)
                {
                    const seen = JSON.parse(text);
                    if (seen.ready)
                    {
                        return seen;
                    }
                }
            }
            catch (e){
                // The page is holding its own thread inside the guest, which is
                // the ordinary case here rather than a failure.
                void e;
            }
            await sleep(1000);
        }
        throw new Error('the page never produced a frame report');
    };

    console.log(`letting ${manifest.title} settle for ${options.settle}s`);
    await sleep(options.settle * 1000);
    const before = await read();
    const startedAt = Date.now();
    console.log(`watching for ${options.seconds}s`);
    await sleep(options.seconds * 1000);
    const after = await read();

    console.log('');
    console.log(describe(before, after, Date.now() - startedAt));
}
finally
{
    cdp?.close();
    await shutdown(browser);
    await server.close();
}
