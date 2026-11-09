/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Records a Performance trace of the whole browser for N seconds, as DevTools
 * would, and writes it gzipped for `trace-summary.mjs`: every thread's tasks,
 * JS samples on every worker, garbage collection and wasm compilation. What
 * a page's threads and the browser's own pools (V8's background compile and
 * collection threads, the GPU process) spent a stretch of a run on, without a
 * person pressing record.
 *
 *   node tools/cdp_test/live/record-trace.mjs <out.json.gz> [seconds=10]
 */
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { CdpEndpoint } from '../cdp.mjs';
import { PORT } from './connect.mjs';

const out = process.argv[2];
const seconds = Number(process.argv[3] ?? 10);
if (!out)
{
    console.error('usage: record-trace.mjs <out.json.gz> [seconds]');
    process.exit(2);
}
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = new CdpEndpoint(version.webSocketDebuggerUrl);
await browser.open();
/** @type {any[]} */
const events = [];
browser.on('Tracing.dataCollected', (/** @type {any} */ params)=>events.push(...params.value));
const complete = new Promise(done=>browser.on('Tracing.tracingComplete', done));
await browser.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: {
    includedCategories: ['devtools.timeline', 'v8', 'v8.wasm', 'v8.execute', 'toplevel',
        'disabled-by-default-devtools.timeline', 'disabled-by-default-v8.cpu_profiler',
        'disabled-by-default-v8.gc', 'disabled-by-default-v8.compile', 'gpu'] } });
await new Promise(done=>setTimeout(done, seconds * 1000));
await browser.send('Tracing.end');
await Promise.race([complete, new Promise(done=>setTimeout(done, 120000))]);
const gzip = createGzip();
const file = createWriteStream(out);
gzip.pipe(file);
// One event a line under a line of its own, as DevTools saves a trace.
gzip.write('{\n"traceEvents": [\n');
events.forEach((event, i)=>gzip.write(`${i ? ',\n' : ''}${JSON.stringify(event)}`));
gzip.end('\n]}\n');
await new Promise(done=>file.on('finish', done));
console.log(`${events.length} events over ${seconds} s written to ${out}`);
process.exit(0);
