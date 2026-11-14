/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every garbage collection of the page's threads over N seconds, from V8's
 * own trace (`disabled-by-default-v8.gc`): per thread, the minor and the full
 * ones, why each was made, their pauses, and, read off the last, the old
 * generation and the "global" sum V8 schedules full collections by, against
 * its limit. A CPU profile says only that collection took the time; this says
 * which collector and why: allocation, an old space at its limit, external
 * memory. A thread whose global sum sits at its limit collects whole at every
 * few megabytes, whatever allocates them.
 *
 *   node tools/live/live.mjs memory gc [seconds=6]
 *
 * One full collection of the engine worker is asked for first, so that it
 * reports even when it would not have collected in the window.
 */
import { CdpEndpoint } from '../../cdp_test/cdp.mjs';
import { PORT, connect } from '../connect.mjs';

const seconds = Number(process.argv[2] ?? 6);
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = new CdpEndpoint(version.webSocketDebuggerUrl);
await browser.open();
/** @type {any[]} */
const events = [];
browser.on('Tracing.dataCollected', (/** @type {any} */ params)=>events.push(...params.value));
const complete = new Promise(done=>browser.on('Tracing.tracingComplete', done));
await browser.send('Tracing.start', { transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['disabled-by-default-v8.gc'] } });
const { cdp, engineWorker } = await connect();
const engine = await engineWorker();
if (engine)
{
    await cdp.send('HeapProfiler.collectGarbage', {}, engine.sessionId).catch(()=>{});
}
await new Promise(done=>setTimeout(done, seconds * 1000));
await browser.send('Tracing.end');
await Promise.race([complete, new Promise(done=>setTimeout(done, 60000))]);

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
if (byThread.size === 0)
{
    console.log('no collection was traced: the trace category gave nothing');
    process.exit(1);
}
/** @param {number} bytes */
const mb = bytes=>`${(bytes / 1048576).toFixed(0)} MB`;
const threads = [...byThread].sort((a, b)=>(b[1].at(-1).end_object_size ?? 0)
    - (a[1].at(-1).end_object_size ?? 0));
for (const [tid, records] of threads)
{
    const last = records.at(-1);
    /** @type {Map<string, { count: number, pause: number }>} */
    const kinds = new Map();
    for (const one of records)
    {
        const why = one.collector_reason ? ` (${one.collector_reason})` : '';
        const key = `${one.gc} ${one.reason}${why}`;
        const kind = kinds.get(key) ?? { count: 0, pause: 0 };
        kind.count++;
        kind.pause += one.pause ?? 0;
        kinds.set(key, kind);
    }
    console.log(`thread ${tid}: ${records.length} collections,`
        + ` objects ${mb(last.end_object_size ?? 0)},`
        + ` old ${mb(last.end_old_gen_consumed_size ?? 0)},`
        + ` global ${mb(last.end_global_consumed_size ?? 0)}`
        + ` of a limit of ${mb(last.global_allocation_limit ?? 0)}`);
    for (const [key, kind] of [...kinds].sort((a, b)=>b[1].pause - a[1].pause))
    {
        console.log(`  ${String(kind.count).padStart(4)} x ${key},`
            + ` ${kind.pause.toFixed(0)} ms paused`);
    }
}
process.exit(0);
