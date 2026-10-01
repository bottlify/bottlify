/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a frame of draws costs the thread that makes it, in a browser over a
 * real device: each scene of `tools/graphics-scenes.mjs` in a worker of its
 * own, as the engine's worker runs the graphics layer, and the medians of a
 * frame's parts on that thread -- the calls before the present (`record`), the
 * present and the replay onto the device (`replay`), the rest of the frame
 * (`tail`) -- with the wait for the device's own work (`gpu`) beside them.
 *
 *     node tools/graphics-bench/run.mjs [--roots head=.,new=../other]
 *         [--scenes a,b] [--draws N] [--frames F] [--warm W] [--reps R]
 *
 * `--model` gives the Direct3D devices no backend, so a frame is the calls'
 * cost to the device's own model alone: what the thread keeps of a frame whose
 * rendering is somebody else's.
 *
 * `--roots` names checkouts whose graphics layer is measured, each against
 * this checkout's scenes; the runs are interleaved and the fastest of `--reps`
 * kept. The browser is CDP_TEST_CHROME or the first `tools/cdp_test/browser.mjs`
 * finds; without a GPU it is SwiftShader's, whose device work is the CPU's and
 * says nothing about a real one, while the thread's own part still does.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../cdp_test/server.mjs';
import { launchWithGpu, shutdown } from '../cdp_test/browser.mjs';
import { CdpEndpoint } from '../cdp_test/cdp.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {string} */ fallback)=>
    (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const roots = flag('--roots', 'head=.').split(',').map(pair=>{
    const [label, dir] = pair.split('=');
    return { label, dir: resolve(REPO, dir) };
});
const scenes = flag('--scenes', 'd3d9-shader,d3d9-lit,d3d8-lit,ddraw-32').split(',');
const draws = Number(flag('--draws', '400'));
const frames = Number(flag('--frames', '200'));
const warm = Number(flag('--warm', '30'));
const reps = Number(flag('--reps', '3'));
const modelOnly = args.includes('--model');

const server = await serveStatic({
    sandboxDir: HERE,
    srcDir: join(REPO, 'modules/core/src'),
    extra: [
        { prefix: '/tools/', root: join(REPO, 'tools') },
        ...roots.map(({ label, dir })=>({ prefix: `/g/${label}/`,
            root: join(dir, 'modules/core/src') })),
    ],
    coi: true,
});
const browser = await launchWithGpu();
const cdp = new CdpEndpoint(browser.browserWs);
/** @type {((payload: string) => void) | null} */
let waiter = null;

/** One scene's run under one root, in a tab of its own. @param {string} label @param {string} scene */
async function job(label, scene){
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    try
    {
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Runtime.addBinding', { name: 'report' }, sessionId);
        await cdp.send('Page.navigate',
            { url: `http://127.0.0.1:${server.port}/sandbox/page.html` }, sessionId);
        for (let i = 0; ; i++)
        {
            const ready = await cdp.send('Runtime.evaluate',
                { expression: 'window.ready === true', returnByValue: true }, sessionId);
            if (ready.result?.value === true)
            {
                break;
            }
            if (i > 200)
            {
                throw new Error('the bench page never loaded');
            }
            await new Promise(done=>setTimeout(done, 50));
        }
        /** @type {Promise<string>} */
        const answer = new Promise(done=>{
            waiter = done;
        });
        const options = { scene, draws, frames, warm, root: `/g/${label}/layers/graphics`, modelOnly };
        await cdp.send('Runtime.evaluate',
            { expression: `job(${JSON.stringify(options)})`, returnByValue: true }, sessionId);
        return JSON.parse(await answer);
    }
    finally
    {
        await cdp.send('Target.closeTarget', { targetId }).catch(()=>{});
    }
}

try
{
    await cdp.open();
    cdp.on('Runtime.bindingCalled', (/** @type {any} */ p)=>{
        if (p.name === 'report' && waiter)
        {
            const answered = waiter;
            waiter = null;
            answered(p.payload);
        }
    });
    /** @type {Map<string, any>} */
    const best = new Map();
    for (let rep = 0; rep < reps; rep++)
    {
        for (const scene of scenes)
        {
            const order = rep % 2 === 0 ? roots : [...roots].reverse();
            for (const { label } of order)
            {
                const run = await job(label, scene);
                if (run.error)
                {
                    throw new Error(`${label} ${scene}: ${run.error}`);
                }
                const key = `${scene} ${label}`;
                const was = best.get(key);
                if (!was || run.record + run.replay + run.tail < was.record + was.replay + was.tail)
                {
                    best.set(key, run);
                }
                console.error(`${label.padEnd(8)} rep ${rep}  ${scene}`);
            }
        }
    }
    const adapter = [...best.values()][0]?.adapter;
    console.log(`ms a frame on the thread, ${draws} draws, median of ${frames}`
        + ` (adapter ${adapter}${modelOnly ? ', the devices\' model alone' : ''})`);
    console.log(`${'scene'.padEnd(20)}${'root'.padEnd(10)}`
        + ['record', 'replay', 'tail', 'thread', 'us/draw', 'gpu'].map(h=>h.padStart(9)).join(''));
    for (const scene of scenes)
    {
        for (const { label } of roots)
        {
            const run = best.get(`${scene} ${label}`);
            const thread = run.record + run.replay + run.tail;
            const cells = [run.record, run.replay, run.tail, thread, thread * 1000 / draws,
                run.gpu];
            console.log(`${scene.padEnd(20)}${label.padEnd(10)}`
                + cells.map(cell=>cell.toFixed(2).padStart(9)).join(''));
        }
    }
}
finally
{
    await shutdown(browser);
    server.close?.();
}
