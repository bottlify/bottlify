/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every frame the launcher tab composed over N seconds, as JPEGs, with their
 * times and sizes (`Page.startScreencast`). A screenshot taken now and then
 * can miss a flicker entirely, and in this tab it can show the canvas black
 * while the screen shows a picture; what the compositor sent is what the
 * person saw. Frames of two sizes taking turns - a picture and an empty
 * screen - are a flicker, and the index says how often.
 *
 *   node tools/live/live.mjs cast [seconds=10] [dir=dbg/cast]
 *
 * Writes <dir>/f0000.jpg ... and <dir>/index.txt (frame, seconds, bytes),
 * and prints how many frames came and how many of them are near the
 * smallest size (an empty or black screen).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from '../connect.mjs';

const seconds = Number(process.argv[2] ?? 10);
const dir = process.argv[3] ?? 'dbg/cast';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const { cdp, sessionId } = await connect();
/** @type {{ index: number, at: number, bytes: number }[]} */
const frames = [];
const began = Date.now();
cdp.on('Page.screencastFrame', (/** @type {any} */ params)=>{
    const bytes = Buffer.from(params.data, 'base64');
    const index = frames.length;
    writeFileSync(`${dir}/f${String(index).padStart(4, '0')}.jpg`, bytes);
    frames.push({ index, at: (Date.now() - began) / 1000, bytes: bytes.length });
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId)
        .catch(()=>{});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 700,
    maxHeight: 600, everyNthFrame: 1 }, sessionId);
await new Promise(done=>setTimeout(done, seconds * 1000));
await cdp.send('Page.stopScreencast', {}, sessionId).catch(()=>{});
writeFileSync(`${dir}/index.txt`, frames.map(one=>`${one.index} ${one.at.toFixed(3)} ${one.bytes}`)
    .join('\n'));
const smallest = Math.min(...frames.map(one=>one.bytes));
const empty = frames.filter(one=>one.bytes < smallest * 1.2).length;
console.log(`${frames.length} frames in ${seconds} s, ${empty} of them near the smallest`
    + ` (${smallest} bytes): ${dir}`);
process.exit(0);
