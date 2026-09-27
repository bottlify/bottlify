/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Watches the live title's sound four times a second and prints, with the
 * wall-clock time, every change that is heard as a fault: laps replayed
 * (stale), silence the device waited in (held), device blocks that went out
 * empty (starved), jumps the writer made ahead (skipped). A person says when
 * they heard the crackle; the line at that time says which of the four it was.
 *
 *   node tools/cdp_test/live/audio-watch.mjs > dbg/audio-watch.log
 */
import { connect } from './connect.mjs';

const { evaluate } = await connect();
const started = Date.now();
/** @type {any} */
let last = null;
for (;;)
{
    const now = await evaluate(`(async()=>{ const b = window.__bottlify__; if (!b?.app) return null;
        const d = await b.app.diagnostics(); const m = n=>(d.find(l=>l.name===n)||{}).metrics||{};
        const a = m('audio'), k = m('kernel');
        return { stale: a.staleBytes, detail: String(a.bufferDetail), starved: a.starvedBlocks,
            skipped: a.skippedBytes, late: k.lateGaps }; })()`).catch(e=>({ error: String(e) }));
    const at = ((Date.now() - started) / 1000).toFixed(1);
    if (!now || now.error)
    {
        console.log(at, now?.error ?? 'no engine yet');
        await new Promise(done=>setTimeout(done, 2000));
        continue;
    }
    now.held = Number(/held=(\d+)/.exec(now.detail)?.[1] ?? 0);
    if (last)
    {
        const change = ['stale', 'held', 'starved', 'skipped']
            .map(key=>`${key}+${(now[key] ?? 0) - (last[key] ?? 0)}`);
        const late = now.late !== last.late
            ? String(now.late).split(' | ').slice(-2).join(' | ') : '';
        if (change.some(text=>!text.endsWith('+0')) || late)
        {
            console.log(`${at}s ${new Date().toLocaleTimeString()} ${change.join(' ')} ${late}`);
        }
    }
    last = now;
    await new Promise(done=>setTimeout(done, 250));
}
