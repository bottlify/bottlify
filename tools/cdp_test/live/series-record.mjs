/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The launcher's performance overlay, look by look, appended to a file as it
 * happens: a binding on the launcher tab, `window.bottlifySeriesSink`, that
 * the overlay calls with every look it takes (fps, the frame by phase, the
 * GPU's time, the guest's threads, memory). What a tab said before it died --
 * out of memory, into swap -- is on disk up to its last second, which a page
 * holding the series itself loses with the page.
 *
 * Runs until stopped; survives the tab's reloads (the binding is the
 * target's). Chart a stretch with `node tools/frame-series.mjs <out> [s] <file>`.
 *   CDP_PORT=<port> node tools/cdp_test/live/series-record.mjs <file.jsonl>
 */
import { appendFileSync } from 'node:fs';
import { connect } from './connect.mjs';

const file = process.argv[2];
if (!file)
{
    console.error('usage: node tools/cdp_test/live/series-record.mjs <file.jsonl>');
    process.exit(2);
}
const { cdp, sessionId } = await connect();
let looks = 0;
cdp.on('Runtime.bindingCalled', (/** @type {any} */ params)=>{
    if (params.name !== 'bottlifySeriesSink')
    {
        return;
    }
    appendFileSync(file, `${params.payload}\n`);
    if (++looks % 60 === 0)
    {
        console.log(`${new Date().toISOString()} ${looks} looks`);
    }
});
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Runtime.addBinding', { name: 'bottlifySeriesSink' }, sessionId);
console.log(`recording the overlay's looks into ${file}`);
