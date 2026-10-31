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
 *                                    [--video] [--no-trace] [--command-line STRING]
 *                                    [--windows NAME] [--quantum N] [--cores N] [--coi]
 *                                    [--worker] [--threads]
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint, openPage } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { frameSpread } from './frame-window.mjs';
import { summariseAllocations } from './profile.mjs';
import { openBundle } from '../btl.mjs';
import { placementOf } from '../../modules/installer/src/prefix.js';
import { windowsVersion } from '../../modules/core/src/layers/win32/kernel32/versions.js';

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
        // The arguments the title believes it was started with, so a run can
        // set one cvar (`+set logFile 1`) without editing its files.
        commandLine: argv.includes('--command-line')
            ? argv[argv.indexOf('--command-line') + 1]
            : null,
        // The Windows the title runs under, over the one its manifest names.
        windows: argv.includes('--windows') ? argv[argv.indexOf('--windows') + 1] : null,
        /** How long to watch once the title is up. */
        seconds: number('--seconds', 60),
        // How long to let it start first. Measuring through loading measures
        // loading, and every phase of that is one no frame ever pays.
        settle: number('--settle', 20),
        // A cinematic is minutes long and is not the steady state either.
        video: argv.includes('--video'),
        // Sample where the guest's instruction pointer is, once a turn.
        profile: argv.includes('--profile'),
        // Sample what the engine allocates during the window, by the
        // function that allocated it. A heap that grows ten megabytes a
        // frame is collected as often, and a collection slows everything on
        // the thread at once, which no phase of ours can see.
        allocations: argv.includes('--allocations'),
        // Guest instructions per scheduler turn. Worth varying: it is the one
        // number that decides how long a thread may hold the machine.
        quantum: number('--quantum', 0),
        // The processors the program is told it has and the executors that run
        // its threads (`cpu.cores`); 0 leaves the engine's default.
        cores: number('--cores', 0),
        // The page cross-origin isolated, so its memory is shared (the `isolated`
        // mode) -- which more than one core needs, and the product's page is.
        coi: argv.includes('--coi') || number('--cores', 0) > 1,
        // The engine in a worker of the page's, as the product runs it: a page's
        // own thread may not wait on shared memory, which other executors need.
        worker: argv.includes('--worker') || number('--cores', 0) > 1,
        // Each thread's last placements and the executors' time, with the report.
        threads: argv.includes('--threads'),
        // Without the per-call string peeks the report's trace would otherwise
        // carry: they read guest memory on every host call, which is a cost
        // the engine outside this harness does not pay.
        trace: !argv.includes('--no-trace'),
    };
}

/** @param {number} value */
const asMs = value=>`${value.toFixed(2)}ms`;

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
        + (frames > 0 ? `, ${asMs(windowMs / frames)} per frame` : ''));
    say(`  ${(instructions / seconds / 1e6).toFixed(1)}M guest instructions per second`);
    if (draws > 0)
    {
        say(`  ${(draws / Math.max(1, frames)).toFixed(0)} draw calls per frame`);
    }
    say('');

    say('one frame, as the engine measured it:');
    frameSpread(before, after).lines.forEach(say);
    // The share is what says which side to change. Mostly the guest means the
    // answer is the translator; mostly ours means it is the layers.
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

    // The program's threads on the other executors (`cpu.cores`), over the whole run:
    // the kernel's account is not kept per window.
    const kernel = after.layers?.kernel ?? null;
    const opened = after.layers?.cpu?.executors?.length;
    if (kernel && opened !== undefined)
    {
        const shared = JSON.parse(kernel.sharedTime ?? '{}');
        const here = shared.hereRetired ?? 0;
        const elsewhere = shared.elsewhereRetired ?? 0;
        say(`other executors: ${opened} opened, at most ${kernel.mostAtOnce ?? 1} threads at once,`
            + ` ${kernel.executorSlices ?? 0} slices there`
            + (here + elsewhere > 0
                ? `, ${(elsewhere / (here + elsewhere) * 100).toFixed(1)}% of the instructions`
                + ' retired while they ran a thread'
                : '')
            + (after.layers.cpu.executorsRefused ? `; refused: ${after.layers.cpu.executorsRefused}`
                : '')
            + `; memory ${after.layers.cpu.sharedMemory ? 'shared' : 'not shared'}`);
        // Modules each runtime let go past its `cacheBytes` and regions brought back:
        // an executor that keeps doing both is translating its code over and over.
        const own = after.layers.cpu.cork;
        say(`modules let go (brought back): process ${own?.evictions ?? 'not measured'}`
            + ` (${own?.broughtBack ?? 'not measured'})`
            + (after.layers.cpu.executors ?? []).map(one=>`, executor ${one.index}`
                + ` ${one.evictions ?? 'not measured'} (${one.broughtBack ?? 'not measured'})`)
                .join(''));
        if (options.threads)
        {
            // Where each thread ran last and what held the executors: whose
            // turns crossed, and whose waited.
            for (const line of kernel.recentByThread ?? [])
            {
                say(`  ${line}`);
            }
            say(`  busy: ${kernel.busyByThread ?? ''}`);
            say(`  threads: ${kernel.byThread ?? ''}`);
            say(`  placed: ${(kernel.recentPlacements ?? []).join(' ')}`);
            say(`  time: ${JSON.stringify(kernel.time ?? null)}`);
            for (const executor of after.layers.cpu.executors ?? [])
            {
                say(`  executor ${executor.index}: ${JSON.stringify(executor.spent ?? executor)}`);
            }
            say(`  shared: ${kernel.sharedTime ?? ''}`);
        }
        say('');
    }

    if (after.profile)
    {
        say(`where the guest itself was, by instructions retired`
            + ` (${after.profile.samples} samples):`);
        for (const row of after.profile.pages.slice(0, 12))
        {
            say(`  ${(row.share * 100).toFixed(1).padStart(5)}%  ${row.at}`);
        }
        say('');
    }

    if (after.allocations)
    {
        const { total, sites } = after.allocations;
        say(`what the engine allocated in the window, sampled`
            + ` (${(total / 1024 / 1024).toFixed(1)} MiB, ${(total / 1024 / 1024 / seconds).toFixed(1)} MiB/s):`);
        for (const row of sites)
        {
            say(`  ${(row.share * 100).toFixed(1).padStart(5)}%  ${(row.bytes / 1024 / 1024).toFixed(1).padStart(7)} MiB  ${row.site}`);
        }
        say('');
    }

    const messages = after.messages ?? null;
    if (messages)
    {
        const pumped = Object.entries(messages.byMessage ?? {})
            .map(([id, count])=>`${id} x${count}`).join('  ');
        say(`what the loop pumps: ${pumped || 'nothing'}`);
        say(`  ${messages.timers} timer(s) armed`
            + `${(messages.timerIntervals ?? []).length > 0
                ? ` every ${messages.timerIntervals.join(', ')}ms` : ''}`
            + `${messages.timerDue === null ? '' : `, next due at ${messages.timerDue}ms`}`
            + `, ${messages.depth} waiting now`);
        if ((messages.timerTicks ?? 0) > 0)
        {
            say(`  ${messages.timerTicks} tick(s) delivered`
                + `, ${messages.timerLateTicks} late`
                + ` by ${messages.averageTimerLateMs}ms on average`
                + `, worst ${messages.worstTimerLateMs}ms`);
        }
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
    const sent = after.uploads ?? null;
    if (sent && (sent.bufferUploads ?? 0) > 0)
    {
        const sentBefore = before.uploads ?? {};
        const uploads = (sent.bufferUploads ?? 0) - (sentBefore.bufferUploads ?? 0);
        const bytes = (sent.bufferUploadBytes ?? 0) - (sentBefore.bufferUploadBytes ?? 0);
        say(`to the card: ${uploads} buffer upload(s)`
            + `, ${(bytes / 1024 / 1024).toFixed(1)} MiB`
            + `, ${(bytes / 1024 / Math.max(1, frames)).toFixed(0)} KiB per frame`);
        const textures = (sent.textureUploadBytes ?? 0) - (sentBefore.textureUploadBytes ?? 0);
        say(`  textures: ${(sent.textureUploads ?? 0) - (sentBefore.textureUploads ?? 0)} upload(s)`
            + `, ${(textures / 1024 / 1024).toFixed(1)} MiB`);
        say('');
    }

    if (after.trapCapacity > 0)
    {
        const taken = after.traps - (before.traps ?? 0);
        const share = after.traps / after.trapCapacity * 100;
        say(`trap slots: ${after.traps} of ${after.trapCapacity} taken`
            + ` (${share.toFixed(1)}%), ${taken} in this window`);
        say('');
    }

    const wave = after.wave ?? null;
    if (wave && wave.length > 0)
    {
        say(`wave devices: ${wave.length}`);
        for (const device of wave)
        {
            say(`  handle ${device.handle}: ${device.written} buffer(s) written`
                + `, ${((device.bytesWritten ?? 0) / 1024).toFixed(0)} KiB`
                + `, ${device.retired} retired, ${device.queued} queued`
                + `, ${device.owed} notice(s) owed`
                + `${device.paused ? ', PAUSED' : ''}`
                + `, cursor from the ${device.cursor}`);
        }
        say('');
    }
    else if (wave)
    {
        say('wave devices: none opened');
        say('');
    }

    const heard = after.audio ?? null;
    if (heard)
    {
        say(`the sound: ${heard.sink ? 'something is draining it' : 'NOTHING is draining it'}`
            + `, ${heard.buffers ?? 0} buffer(s), ${heard.playing ?? 0} playing`
            + `, ${heard.tracksOpen ?? 0} track(s) open`);
        say(`  ${heard.fedRanges ?? 0} spans read out of them`
            + `, ${((heard.fedBytes ?? 0) / 1024).toFixed(0)} KiB`
            + `, ${heard.behindTurns ?? 0} dropped for being late`);
        say(`  the ring: ${heard.produced ?? 0} produced, ${heard.consumed ?? 0} consumed`);
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
            say(`  the picture is ${held.driftMs ?? 0}ms ahead of the sound`
                + ` (worst ${held.worstDriftMs ?? 0}ms)`
                + `, ${held.soundMs ?? 0}ms of it played`
                + `, ${held.queuedMs ?? 0}ms of it waiting to be played`);
        }
        say('');
    }

    say('the slowest frames, and what they were made of:');
    for (const frame of after.worstFrames.slice(0, 8))
    {
        const parts = Object.entries(frame.byKind)
            .filter(([, value])=>Number(value) > 0)
            .map(([kind, value])=>`${kind} ${asMs(Number(value))}`)
            .join(', ');
        say(`  frame ${String(frame.index).padStart(6)}  ${asMs(frame.ms).padStart(9)}`
            + `   ${parts}`);
        // What the frame's time was made of: one long thing, or many.
        if (frame.longest)
        {
            const slice = frame.longestGuest ?? { ms: 0, instructions: 0 };
            const notes = frame.notes ?? {};
            const retired = notes.instructions ?? 0;
            const guestMs = Number(frame.byKind.guest ?? 0);
            say(`          longest ${frame.longest.name} ${asMs(frame.longest.ms)}`
                + `; longest slice ${asMs(slice.ms)} for ${slice.instructions} instructions`
                + `; ${frame.waits ?? 0} fetch wait(s), ${frame.compiles ?? 0} compile(s)`);
            say(`          ${retired} instructions`
                + ` (${notes.interpreted ?? 0} interpreted)`
                + `${guestMs > 0 ? `, ${(retired / guestMs / 1000).toFixed(1)}M/s in the guest` : ''}`
                + `; host wrote ${((notes.hostWrittenBytes ?? 0) / 1024).toFixed(0)} KiB`
                + ' into the guest'
                + `; JS heap ${((notes.heapDelta ?? 0) / 1024 / 1024).toFixed(1)} MiB`);
        }
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
// The Windows the bottle runs under, refused here by name, as createApp would
// refuse it, before a browser starts.
const windows = options.windows ?? manifest.windows ?? undefined;
windowsVersion(windows);
const opened = await openBundle(join(directory, 'bundle.btl'));
const executable = await opened.read(manifest.entry);
await opened.close();

const server = await serveStatic({
    sandboxDir: PACKAGE_DIR,
    srcDir: join(PACKAGE_DIR, 'src'),
    extra: [
        { prefix: '/bundle/', root: directory },
        // The translator package beside core, where app.js resolves the default engine.
        { prefix: '/cork/', root: join(PACKAGE_DIR, '..', 'cork') },
    ],
    coi: options.coi,
});
const browser = await launchWithGpu();
/** @type {CdpEndpoint | null} */
let cdp = null;
try
{
    cdp = new CdpEndpoint(browser.browserWs);
    await cdp.open();
    const { sessionId } = await openPage(cdp,
        `http://127.0.0.1:${server.port}/sandbox/test/page/game/index.html`
            + (options.worker ? '?worker=1' : ''));
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

    const { prefix: bundlePrefix, imagePath } = placementOf(manifest);
    await evaluate(`window.__bottlify__.start(${JSON.stringify({
        exe: Buffer.from(executable).toString('base64'),
        bundleUrl: `http://127.0.0.1:${server.port}/bundle/bundle.btl`,
        bundlePrefix,
        imagePath,
        // The bundle's own launch arguments, appended after the quoted image
        // path the same way createApp's own default is built, unless
        // `--command-line` overrides them.
        commandLine: options.commandLine
            ?? (manifest.commandLine ? `"${imagePath}" ${manifest.commandLine}` : undefined),
        windows,
        maxTurns: Number.MAX_SAFE_INTEGER,
        video: options.video,
        quantum: options.quantum || undefined,
        cores: options.cores || undefined,
        profile: options.profile || undefined,
        trace: options.trace,
    })}); null`);

    /** Waits until the page has a report and answers with it. */
    const read = async()=>{
        /** @type {string | null} */
        let lastError = null;
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
                // the ordinary case here rather than a failure -- but the last
                // thing it said is kept, because a report that never comes is
                // otherwise indistinguishable from a page that threw.
                lastError = e instanceof Error ? e.message : String(e);
            }
            await sleep(1000);
        }
        throw new Error('the page never produced a frame report'
            + (lastError ? `; the last attempt said: ${lastError}` : ''));
    };

    console.log(`letting ${manifest.title} settle for ${options.settle}s`);
    await sleep(options.settle * 1000);
    if (options.allocations)
    {
        // The engine runs on the page's own thread in this harness, so the
        // page's session is where its allocations are.
        await cdp.send('HeapProfiler.enable', {}, sessionId);
        await cdp.send('HeapProfiler.startSampling', {
            samplingInterval: 32768,
            // Garbage is what a collection is paid for; the default counts
            // only what survived one.
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
        }, sessionId);
    }
    const before = await read();
    const startedAt = Date.now();
    console.log(`watching for ${options.seconds}s`);
    await sleep(options.seconds * 1000);
    const after = await read();
    if (options.allocations)
    {
        const { profile } = await cdp.send('HeapProfiler.stopSampling', {}, sessionId);
        after.allocations = summariseAllocations(profile);
    }

    console.log('');
    console.log(describe(before, after, Date.now() - startedAt));
}
finally
{
    cdp?.close();
    await shutdown(browser);
    await server.close();
}
