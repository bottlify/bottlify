/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How a browser's garbage collector takes the WebAssembly memories a thread
 * holds: a worker of a cross-origin-isolated page holds HOLDERS shared memories
 * of GIB GiB each (memory64 past 4 GiB), then allocates 256 KiB buffers for a
 * few seconds as a cold start does, and V8's own trace of that worker's
 * collections is read back: how many were full ones, how many of those V8 made
 * for "external memory pressure", their pauses, and the global limit it ended
 * with. Chrome counts every memory a thread holds by its length against that
 * limit, about 8 GiB a thread: past it the thread collects whole every few
 * megabytes. Node does not count them at all, so the question is the browser's.
 *
 *   node tools/read/wasm-memory-gc.mjs [GIBxHOLDERS,...=3x1,3x2,4x2,8x1] [--seconds 6]
 *
 * CDP_TEST_CHROME names the browser (`tools/lib/browser.mjs`).
 */
import http from 'node:http';
import { launch, shutdown } from '../lib/browser.mjs';
import { CdpEndpoint, openPage } from '../lib/cdp.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--seconds');
const seconds = at >= 0 ? Number(args.splice(at, 2)[1]) : 6;
const arms = (args[0] ?? '3x1,3x2,4x2,8x1').split(',').map(arm=>arm.split('x').map(Number));

/** @param {number} gib @param {number} holders */
const workerSource = (gib, holders)=>`
const memories = [];
for (let i = 0; i < ${holders}; i++)
{
    if (${gib} > 4)
    {
        const memory = new WebAssembly.Memory({ initial: 16n, maximum: ${gib * 16384}n,
            shared: true, address: 'i64' });
        memory.grow(${gib * 16384 - 16}n);
        memories.push(memory);
    }
    else
    {
        memories.push(new WebAssembly.Memory({ initial: ${Math.min(gib * 16384, 65535)},
            maximum: 65536, shared: true }));
    }
}
const kept = [];
const from = performance.now();
(function step(){
    for (let i = 0; i < 40; i++)
    {
        kept.push(new ArrayBuffer(256 * 1024));
        if (kept.length > 400) kept.splice(0, 200);
    }
    if (performance.now() - from < ${seconds * 1000}) setTimeout(step, 1);
    else postMessage(memories.map(memory=>memory.buffer.byteLength));
})();`;

/** @type {string} */
let worker = '';
const server = http.createServer((request, response)=>{
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (request.url === '/worker.js')
    {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(worker);
        return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<script>window.go = ()=>new Promise(done=>{'
        + ' const w = new Worker("/worker.js"); w.onmessage = e=>done(e.data);'
        + ' w.onerror = e=>done({ error: e.message }); });</script>');
});
await new Promise(done=>server.listen(0, '127.0.0.1', ()=>done(null)));
const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
const browser = await launch();
const cdp = new CdpEndpoint(browser.browserWs);
await cdp.open();
/** @param {number} bytes */
const mb = bytes=>`${Math.round(bytes / 2 ** 20)} MB`;
try
{
    for (const [gib, holders] of arms)
    {
        worker = workerSource(gib, holders);
        const { targetId, sessionId } = await openPage(cdp, `http://127.0.0.1:${port}/`);
        await new Promise(done=>setTimeout(done, 500));
        /** @type {any[]} */
        const events = [];
        const collect = (/** @type {any} */ params)=>events.push(...params.value);
        const unsubscribe = cdp.on('Tracing.dataCollected', collect);
        /** @type {() => void} */
        let unsubscribeEnd = ()=>{};
        const complete = new Promise(done=>{
            unsubscribeEnd = cdp.on('Tracing.tracingComplete', done);
        });
        await cdp.send('Tracing.start', { transferMode: 'ReportEvents',
            traceConfig: { includedCategories: ['disabled-by-default-v8.gc'] } });
        const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.go()',
            awaitPromise: true, returnByValue: true }, sessionId);
        await cdp.send('Tracing.end');
        await complete;
        unsubscribe();
        unsubscribeEnd();
        await cdp.send('Target.closeTarget', { targetId });
        if (!Array.isArray(result.value))
        {
            console.log(`${gib} GiB x ${holders}: the worker could not hold them`
                + ` (${JSON.stringify(result.value)})`);
            continue;
        }
        /** @type {Map<number, any[]>} */
        const byThread = new Map();
        for (const event of events)
        {
            if (event.name === 'V8.GCTraceGCNVP')
            {
                const record = JSON.parse(event.args.value);
                byThread.set(event.tid, [...byThread.get(event.tid) ?? [], record]);
            }
        }
        // The worker: the thread whose limit holds the memories.
        const records = [...byThread.values()].sort((a, b)=>(b.at(-1).global_allocation_limit ?? 0)
            - (a.at(-1).global_allocation_limit ?? 0))[0];
        if (!records)
        {
            console.log(`${gib} GiB x ${holders}: not measured (the trace carried no collection)`);
            continue;
        }
        const full = records.filter(one=>one.gc === 'mc' || one.gc === 'mmc');
        const pressed = full.filter(one=>one.reason === 'external memory pressure');
        const paused = full.reduce((total, one)=>total + (one.pause ?? 0), 0);
        console.log(`${gib} GiB x ${holders} (${mb(gib * holders * 2 ** 30)} held):`
            + ` ${full.length} full collections in ${seconds} s,`
            + ` ${pressed.length} for external memory pressure, ${paused.toFixed(0)} ms paused;`
            + ` global limit ${mb(records.at(-1).global_allocation_limit ?? 0)}`);
    }
}
finally
{
    await shutdown(browser);
    server.close();
}
process.exit(0);
