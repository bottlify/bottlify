/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every five seconds: the tab's renderer process private memory (Windows
 * only) and each worker's JS heap. A leak is a line that only climbs; memory
 * the renderer holds beyond the heaps is ArrayBuffers and wasm memories --
 * `big-buffers.mjs` says whose.
 *
 *   node tools/cdp_test/live/memory-watch.mjs > dbg/memory-watch.log
 */
import { execFileSync } from 'node:child_process';
import { connect } from './connect.mjs';

const { cdp, workers } = await connect();
const all = await workers();

/** The largest renderer of the shared profile, in MB; -1 where it cannot be read. */
const renderer = ()=>{
    try
    {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            'Get-CimInstance Win32_Process -Filter "name=\'chrome.exe\'" | Where-Object { '
            + '$_.CommandLine -match \'chrome-profile\''
            + ' -and $_.CommandLine -match \'type=renderer\''
            + ' } | ForEach-Object { [int]($_.PrivatePageCount/1MB) }']).toString();
        return Math.max(...out.split(/\s+/).filter(Boolean).map(Number));
    }
    catch {
        return -1;
    }
};

for (;;)
{
    const heaps = [];
    for (const worker of all)
    {
        const heap = await Promise.race([
            cdp.send('Runtime.getHeapUsage', {}, worker.sessionId).catch(()=>null),
            new Promise(done=>setTimeout(()=>done(null), 3000)),
        ]);
        const name = worker.url.split('/').pop();
        heaps.push(heap ? `${name} ${Math.round(heap.usedSize / 1048576)}/`
            + `${Math.round(heap.totalSize / 1048576)}` : `${name} busy`);
    }
    console.log(`${new Date().toLocaleTimeString()} renderer=${renderer()}MB `
        + `heaps[used/total MB]: ${heaps.join(', ')}`);
    await new Promise(done=>setTimeout(done, 5000));
}
