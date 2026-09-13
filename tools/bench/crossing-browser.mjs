/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The same loop as `crossing.mjs`, run on a browser's page thread with the
 * browser's own sampling profiler on it.
 *
 * The engine's cost per call is not the same number in Node and in a browser
 * -- the clocks, the wasm-to-JS boundary and the garbage collector all differ
 * -- and the figure that matters is the browser's. This runs the loop there,
 * reports microseconds a turn the same way, and folds the CPU profile into
 * the functions the thread spent its time in.
 *
 * Usage: node tools/bench/crossing-browser.mjs [--calls N] [--kind id|tick|heap]
 *     [--profile-calls] [--trace-strings] [--rounds R] [--top N]
 */

import { launch, shutdown } from '../cdp_test/browser.mjs';
import { CdpEndpoint } from '../cdp_test/cdp.mjs';
import { serveStatic } from '../cdp_test/server.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PACKAGE_DIR = join(TOOL_ROOT, '..', '..', 'modules', 'core');

const flags = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>{
    const at = flags.indexOf(name);
    return at === -1 ? fallback : flags[at + 1];
};
const CALLS = Number(flag('--calls', '1000000'));
const KIND = flag('--kind', 'id');
const ROUNDS = Number(flag('--rounds', '3'));
const TOP = Number(flag('--top', '40'));
const PROFILE_CALLS = flags.includes('--profile-calls');
const TRACE_STRINGS = flags.includes('--trace-strings');

process.argv.length = 2;
const { buildLoopExe } = await import('./crossing.mjs');

/**
 * Self time per function from a CPU profile, heaviest first.
 *
 * @param {any} profile
 * @param {number} keep
 */
function summarise(profile, keep){
    /** @type {Map<number, any>} */
    const nodes = new Map(profile.nodes.map((/** @type {any} */ node)=>[node.id, node]));
    /** @type {Map<number, number>} */
    const selfMicros = new Map();
    profile.samples.forEach((/** @type {number} */ id, /** @type {number} */ index)=>{
        selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0));
    });
    /** @type {Map<string, number>} */
    const byFunction = new Map();
    let total = 0;
    for (const [id, micros] of selfMicros)
    {
        const frame = nodes.get(id)?.callFrame ?? {};
        const file = String(frame.url ?? '').split('/').pop()
            || `(${frame.functionName || 'program'})`;
        const line = (frame.lineNumber ?? -1) + 1;
        const name = `${frame.functionName || '(anonymous)'} ${file}:${line}`;
        byFunction.set(name, (byFunction.get(name) ?? 0) + micros);
        total += micros;
    }
    const rows = [...byFunction].sort((left, right)=>right[1] - left[1]).slice(0, keep);
    return { totalMs: total / 1000, rows };
}

const server = await serveStatic({ sandboxDir: PACKAGE_DIR, srcDir: join(PACKAGE_DIR, 'src') });
const browser = await launch();
/** @type {CdpEndpoint | null} */
let cdp = null;
try
{
    cdp = new CdpEndpoint(browser.browserWs);
    await cdp.open();
    const pageUrl = `http://127.0.0.1:${server.port}/sandbox/test/page/index.html`;
    const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    cdp.on('Runtime.exceptionThrown', params=>{
        console.error(`page: ${params.exceptionDetails?.exception?.description}`);
    });
    cdp.on('Runtime.consoleAPICalled', params=>{
        console.log(`  page ${params.args.map((/** @type {any} */ a)=>a.value).join(' ')}`);
    });

    /** @param {string} expression */
    const evaluate = async expression=>{
        const answer = await cdp.send('Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true, timeout: 600_000 }, sessionId);
        if (answer.exceptionDetails)
        {
            throw new Error(answer.exceptionDetails.exception?.description
                ?? answer.exceptionDetails.text);
        }
        return answer.result?.value;
    };

    // The page is created and asked in the same breath; until it has a
    // location of its own, a module specifier has nothing to resolve against.
    while (await evaluate('location.pathname') !== '/sandbox/test/page/index.html')
    {
        await new Promise(settle=>setTimeout(settle, 50));
    }
    await evaluate(`(async()=>{
        const { createApp } = await import('/sandbox/src/app.js');
        const wasm = await fetch('/sandbox/vendor/prebuilt/v86.wasm').then(r=>r.arrayBuffer());
        window.__bench = async(exe, options)=>{
            const bytes = Uint8Array.from(atob(exe), c=>c.charCodeAt(0));
            const app = await createApp({
                executable: bytes,
                v86: { moduleUrl: new URL('/sandbox/vendor/prebuilt/libv86.mjs', location.href).href,
                    wasmBytes: wasm },
                ...options,
            });
            try
            {
                const started = performance.now();
                const code = await app.run({ timeoutMs: 600000 });
                const took = performance.now() - started;
                if (code !== 0) throw new Error('the guest exited with ' + code);
                const cpu = app.diagnostics().find(d=>d.name === 'cpu');
                const jit = cpu && cpu.metrics && cpu.metrics.jit || {};
                console.log('jit: compiled ' + jit.compiledSteps + ' interpreted '
                    + jit.interpretedSteps + ' dispatches ' + jit.interpretedDispatches
                    + ' chained ' + jit.chained + ' missed ' + jit.chainMissed
                    + ' pages ' + jit.interpPages);
                return took;
            }
            finally
            {
                await app.dispose();
            }
        };
    })()`);

    const options = JSON.stringify({ profileCalls: PROFILE_CALLS, traceStrings: TRACE_STRINGS });
    /** @param {string} kind */
    const bestOf = async kind=>{
        const exe = Buffer.from(buildLoopExe(CALLS, kind)).toString('base64');
        let best = Infinity;
        for (let round = 0; round < ROUNDS; round++)
        {
            const took = Number(
                await evaluate(`window.__bench(${JSON.stringify(exe)}, ${options})`));
            best = Math.min(best, took);
            console.log(`${kind} round ${round + 1}: ${took.toFixed(0)} ms`);
        }
        return best;
    };

    const bare = await bestOf('none');
    await cdp.send('Profiler.enable', {}, sessionId);
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 }, sessionId);
    await cdp.send('Profiler.start', {}, sessionId);
    const best = await bestOf(KIND);
    const { profile } = await cdp.send('Profiler.stop', {}, sessionId);

    const perCall = (best - bare) * 1000 / CALLS;
    console.log(`${KIND}: ${CALLS} turns, bare loop ${bare.toFixed(0)} ms,`
        + ` best ${best.toFixed(0)} ms -> ${perCall.toFixed(2)} us a turn (browser)`);
    const summary = summarise(profile, TOP);
    console.log(`profile: ${summary.totalMs.toFixed(0)} ms sampled over ${ROUNDS} rounds`);
    for (const [name, micros] of summary.rows)
    {
        console.log(`${(micros / 1000).toFixed(1).padStart(8)} ms`
            + ` ${(100 * micros / summary.totalMs / 1000).toFixed(1).padStart(5)}%  ${name}`);
    }
}
finally
{
    cdp?.close();
    await shutdown(browser);
    await server.close();
}
