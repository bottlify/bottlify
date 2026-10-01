/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs the benchmark's workloads in headless Chromium, each run in a fresh tab
 * and a dedicated worker of a bundle `build.mjs` made, and reports each
 * configuration's best guest instructions per second beside the first's.
 *
 *     node modules/cork/bench/browser/suite.mjs '<configurations>' [options]
 *
 * The configurations are a JSON object of labels, each naming its `bundle`
 * (default the label), its `engine` (cork or emulator) and its translator
 * configuration (`cork`):
 *
 *     '{"cork":{"bundle":"head"},"v86":{"bundle":"head","engine":"emulator"}}'
 *
 *   --variants x87,sse    which builds (default both)
 *   --only a,b,c          workloads to run (default all)
 *   --reps n              runs of each, the fastest kept (default 2)
 *   --out file.jsonl      one JSON line per run
 *   --js-flags '<flags>'  V8's flags, for a diagnostic run
 *   --scale k             each workload at k times its own iterations; with bin/peload
 *                         the processor runs them too, its rate is shown beside,
 *                         and it answers the checksum
 *
 * At a workload's own iterations a run is a few hundred milliseconds, and the
 * load, the translation and the engine's compiles were from a quarter to most of
 * it: such a run measures the start. Ten times them leaves a few per cent of
 * that, and what is left is the translated code's own rate.
 *
 * The browser is CDP_TEST_CHROME or the first `tools/cdp_test/browser.mjs`
 * finds. The configurations are interleaved and their order turned round every
 * rep, so a drift in the machine's speed falls on all of them alike.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../../..');
const BIN = resolve(HERE, '../bin');
const WORKLOADS = ['vm', 'entities', 'math', 'path', 'lz', 'containers', 'spread', 'api'];
/** Each workload's own iterations, as `src/main.cpp` has them. */
const ITERATIONS = /** @type {Record<string, number>} */ ({
    vm: 4, entities: 200, math: 120, path: 300, lz: 6, containers: 4, spread: 100, api: 40,
});
/** A job with no answer by then is run once more, and counted a failure if it fails again. */
const JOB_LIMIT_MS = 120_000;

const tool = (/** @type {string} */ name)=>import(pathToFileURL(join(REPO, 'tools/cdp_test', name)).href);
const { CdpEndpoint } = await tool('cdp.mjs');
const { serveStatic } = await tool('server.mjs');
const { launchWithGpu, shutdown } = await tool('browser.mjs');

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {string} */ fallback)=>
    (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
/** @type {Record<string, { bundle?: string, engine?: string, cork?: object }>} */
const configs = JSON.parse(args[0] ?? '{"head":{}}');
const labels = Object.keys(configs);
const variants = flag('--variants', 'x87,sse').split(',');
const only = flag('--only', WORKLOADS.join(',')).split(',');
const reps = Number(flag('--reps', '2'));
const out = flag('--out', '');
const jsFlags = flag('--js-flags', '');
const scale = Number(flag('--scale', '1'));
const PELOAD = join(BIN, 'peload');
const haveNative = existsSync(PELOAD);
/** @type {Record<string, Record<string, string>>} */
const expected = JSON.parse(readFileSync(resolve(HERE, '../expected.json'), 'utf8'));
if (out)
{
    writeFileSync(out, '');
}

const server = await serveStatic({
    sandboxDir: HERE,
    srcDir: join(REPO, 'modules/core/src'),
    extra: [{ prefix: '/b/', root: join(HERE, 'bundles') }, { prefix: '/exe/', root: BIN }],
    // Shared memory, which the engine's workers need, is only handed to an isolated page.
    coi: true,
});
// The launcher that takes extra flags; the GPU it asks for goes unused here.
const browser = await launchWithGpu({ extraFlags: jsFlags ? [`--js-flags=${jsFlags}`] : [] });
const cdp = new CdpEndpoint(browser.browserWs);
const started = Date.now();

/**
 * The fastest run of each label, build, workload and scale.
 * @type {Map<string, { ms: number, instructions: number }>}
 */
const fastest = new Map();
/** @param {{ ms: number, instructions: number }} run @param {string} key */
const keep = (run, key)=>{
    const was = fastest.get(key);
    if (was === undefined || run.ms < was.ms)
    {
        fastest.set(key, { ms: run.ms, instructions: run.instructions });
    }
};
/** The processor's checksum of each build, workload and scale, from bin/peload. @type {Map<string, string>} */
const nativeSums = new Map();

/**
 * The processor's run of one workload: its milliseconds and checksum.
 *
 * @param {string} variant @param {string} workload @param {number} iterations
 */
function native(variant, workload, iterations){
    const result = spawnSync(PELOAD, [join(BIN, `bench-${variant}.exe`), workload,
        String(iterations)], { encoding: 'utf8' });
    const ns = /native-ns (\d+)/.exec(result.stderr);
    const line = /^\S+ \d+ ([0-9a-f]{8})/m.exec(result.stdout);
    if (!ns || !line)
    {
        throw new Error(`peload ${variant} ${workload} ${iterations}: ${result.stderr}`);
    }
    return { ms: Number(ns[1]) / 1e6, checksum: line[1] };
}
/** @type {string[]} */
const wrong = [];
/** @type {string[]} */
const unanswered = [];

/** @type {((payload: string) => void) | null} */
let waiter = null;

/**
 * A tab of the job's own, closed after it, so its renderer and the job's
 * workers go with it: a worker's memory is not all handed back while its page
 * lives, and runs accumulated in one renderer until it was killed.
 */
async function newTab(){
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.addBinding', { name: 'report' }, sessionId);
    await cdp.send('Page.navigate',
        { url: `http://127.0.0.1:${server.port}/sandbox/page.html` }, sessionId);
    for (let i = 0; ; i++)
    {
        const ready = await cdp.send('Runtime.evaluate',
            { expression: 'window.ready === true', returnByValue: true }, sessionId);
        if (ready.result?.value === true)
        {
            return { targetId, sessionId };
        }
        if (i > 200)
        {
            throw new Error('the bench page never loaded');
        }
        await new Promise(r=>setTimeout(r, 50));
    }
}

/**
 * One run of one workload under one configuration.
 *
 * @param {string} label @param {string} variant @param {string} workload
 * @returns {Promise<any>}
 */
async function job(label, variant, workload, iterations){
    const config = configs[label];
    const options = {
        engine: config.engine ?? 'cork',
        cork: config.cork ?? {},
        commandLine: `"C:\\app.exe" ${workload} ${iterations}`,
    };
    const tab = await newTab();
    try
    {
        /** @type {Promise<string>} */
        const answer = new Promise(res=>{
            waiter = res;
            setTimeout(()=>{
                if (waiter === res)
                {
                    waiter = null;
                    res(JSON.stringify({ error: 'no answer', unanswered: true }));
                }
            }, JOB_LIMIT_MS);
        });
        await cdp.send('Runtime.evaluate', {
            expression: `job(${JSON.stringify(config.bundle ?? label)},`
                + ` '/exe/bench-${variant}.exe', ${JSON.stringify(options)})`,
            returnByValue: true,
        }, tab.sessionId);
        return JSON.parse(await answer);
    }
    finally
    {
        await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(()=>{});
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
    const version = await cdp.send('Browser.getVersion');
    console.error(`${version.product}, V8 ${version.jsVersion}`);
    for (let rep = 0; rep < reps; rep++)
    {
        for (const variant of variants)
        {
            for (const workload of only)
            {
                const iterations = ITERATIONS[workload] * scale;
                const at = `${variant} ${workload}`;
                if (haveNative)
                {
                    const processor = native(variant, workload, iterations);
                    nativeSums.set(at, processor.checksum);
                    keep({ ms: processor.ms, instructions: 0 }, `native ${at}`);
                }
                const want = nativeSums.get(at)
                    ?? (scale === 1 ? expected[variant]?.[workload] : undefined);
                for (const label of rep % 2 ? [...labels].reverse() : labels)
                {
                    let run = await job(label, variant, workload, iterations);
                    if (run.unanswered)
                    {
                        unanswered.push(`${label} ${at} rep ${rep}`);
                        run = await job(label, variant, workload, iterations);
                    }
                    const checksum = run.code === null || run.code === undefined
                        ? null : run.code.toString(16).padStart(8, '0');
                    // A longer run with no processor to answer it is unchecked.
                    const ok = checksum !== null && (want === undefined || checksum === want);
                    if (!ok)
                    {
                        wrong.push(`${label} ${at}: ${checksum}`
                            + `${run.error ? ` ${String(run.error).slice(0, 300)}` : ''}`);
                    }
                    if (ok)
                    {
                        keep(run, `${label} ${at}`);
                    }
                    if (out)
                    {
                        appendFileSync(out, `${JSON.stringify({ label, rep, variant, workload,
                            iterations, ...run, ok })}\n`);
                    }
                    console.error(`${label.padEnd(12)} rep ${rep}  ${at.padEnd(18)}`
                        + `${Math.round(run.mips ?? 0).toString().padStart(6)} MIPS`
                        + `  ${ok ? want === undefined ? '?' : 'ok' : 'WRONG'}`);
                }
            }
        }
    }
}
finally
{
    cdp.close();
    await shutdown(browser);
    await server.close();
}

/** @param {number[]} values */
const geomean = values=>Math.exp(values.reduce((s, v)=>s + Math.log(v), 0) / values.length);
const keys = variants.flatMap(variant=>only.map(workload=>`${variant} ${workload}`));
/**
 * A label's instructions a second at a workload, of its fastest run. The
 * processor's are the instructions the first label ran over its milliseconds.
 *
 * @param {string} label @param {string} key
 */
const rate = (label, key)=>{
    const run = fastest.get(`${label} ${key}`);
    const instructions = label === 'native'
        ? fastest.get(`${labels[0]} ${key}`)?.instructions ?? 0 : run?.instructions ?? 0;
    return run ? instructions / run.ms / 1000 : 0;
};
const columns = haveNative ? [...labels, 'native'] : labels;
/** @param {number} value @param {number} first @param {number} i */
const cell = (value, first, i)=>
    `${Math.round(value)}${i ? ` (${(value / first).toFixed(2)}x)` : ''}`.padStart(16);
console.log([(scale === 1 ? 'MIPS' : `MIPS, x${scale}`).padEnd(16),
    ...columns.map(l=>l.padStart(16))].join(''));
for (const key of keys)
{
    console.log([key.padEnd(16),
        ...columns.map((l, i)=>cell(rate(l, key), rate(labels[0], key), i))].join(''));
}
const means = columns.map(l=>geomean(keys.map(k=>Math.max(rate(l, k), 1e-9))));
console.log(['geomean'.padEnd(16), ...means.map((g, i)=>cell(g, means[0], i))].join(''));
if (unanswered.length)
{
    console.log(`no answer in ${JOB_LIMIT_MS / 1000} s, run again: ${unanswered.join('; ')}`);
}
console.log(wrong.length ? `WRONG:\n${wrong.join('\n')}` : 'every checksum is the processor\'s');
console.log(`${((Date.now() - started) / 1000).toFixed(0)} s`);
// Nothing left to wait for: a socket the browser left half-open would hold the process.
process.exit(wrong.length ? 1 : 0);
