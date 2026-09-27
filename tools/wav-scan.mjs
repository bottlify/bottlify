/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What is wrong in a recording, and where: stretches of digital silence inside
 * sound (a gap), sample-to-sample jumps far beyond what the signal around them
 * does (a click), and stretches that are an exact copy of something heard
 * shortly before (a repeat, with how far back it came from).
 *
 *   node tools/wav-scan.mjs <file.wav> [--from S] [--to S]
 *
 * 16-bit PCM WAV, any rate, mono or stereo; the left channel is scanned.
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const file = argv.find(argument=>!argument.startsWith('--'));
/** @param {string} flag @param {number} fallback */
const option = (flag, fallback)=>{
    const at = argv.indexOf(flag);
    return at >= 0 ? Number(argv[at + 1]) : fallback;
};
if (!file)
{
    console.log('usage: node tools/wav-scan.mjs <file.wav> [--from S] [--to S]');
    process.exit(2);
}

const bytes = readFileSync(file);
let rate = 0;
let channels = 0;
/** @type {Buffer | null} */
let data = null;
for (let at = 12; at + 8 <= bytes.length;)
{
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ')
    {
        channels = bytes.readUInt16LE(at + 10);
        rate = bytes.readUInt32LE(at + 12);
    }
    else if (id === 'data')
    {
        data = bytes.subarray(at + 8, at + 8 + size);
    }
    at += 8 + size + (size & 1);
}
if (!data || !rate)
{
    console.log('not a PCM WAV');
    process.exit(1);
}
const all = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
const frames = Math.floor(all.length / channels);
const first = Math.floor(option('--from', 0) * rate);
const last = Math.min(frames, Math.floor(option('--to', frames / rate) * rate));
/** @param {number} frame */
const sample = frame=>all[frame * channels];
const time = (/** @type {number} */ frame)=>(frame / rate).toFixed(3);

const events = [];

// Gaps: 5 ms or more of exact zero with sound within 50 ms either side.
const minimumGap = Math.round(rate * 0.005);
for (let frame = first; frame < last;)
{
    if (sample(frame) !== 0)
    {
        frame++;
        continue;
    }
    let end = frame;
    while (end < last && sample(end) === 0)
    {
        end++;
    }
    const around = Math.round(rate * 0.05);
    const loud = (/** @type {number} */ from, /** @type {number} */ to)=>{
        for (let at = Math.max(first, from); at < Math.min(last, to); at++)
        {
            if (Math.abs(sample(at)) > 300)
            {
                return true;
            }
        }
        return false;
    };
    if (end - frame >= minimumGap && loud(frame - around, frame) && loud(end, end + around))
    {
        events.push([frame, `gap of ${((end - frame) * 1000 / rate).toFixed(1)} ms of silence`]);
    }
    frame = end;
}

// Clicks: a step more than eight times the typical step of the 10 ms around it.
const window = Math.round(rate * 0.01);
for (let frame = first + window; frame < last - window; frame++)
{
    const step = Math.abs(sample(frame) - sample(frame - 1));
    if (step < 2000)
    {
        continue;
    }
    let sum = 0;
    for (let at = frame - window; at < frame + window; at++)
    {
        sum += Math.abs(sample(at) - sample(at - 1));
    }
    const typical = sum / (2 * window);
    if (step > 8 * typical)
    {
        events.push([frame,
            `click: a step of ${step} where the signal steps ${typical.toFixed(0)}`]);
        frame += window;
    }
}

// Repeats: a 20 ms stretch with sound in it that equals one from up to 2 s before.
const span = Math.round(rate * 0.02);
const back = Math.round(rate * 2);
/** @type {Map<string, number>} */
const seen = new Map();
const keyOf = (/** @type {number} */ at)=>{
    let key = '';
    for (let i = 0; i < 16; i++)
    {
        key += `${sample(at + i * Math.floor(span / 16))},`;
    }
    return key;
};
for (let frame = first; frame + span < last; frame += Math.floor(span / 4))
{
    let energy = 0;
    for (let i = 0; i < span; i += 8)
    {
        energy += Math.abs(sample(frame + i));
    }
    if (energy / (span / 8) < 300)
    {
        continue;
    }
    const key = keyOf(frame);
    const earlier = seen.get(key);
    if (earlier !== undefined && frame - earlier >= span && frame - earlier <= back)
    {
        let same = true;
        for (let i = 0; i < span && same; i++)
        {
            same = sample(frame + i) === sample(earlier + i);
        }
        if (same)
        {
            const ago = ((frame - earlier) * 1000 / rate).toFixed(0);
            events.push([frame, `repeat of what played ${ago} ms before`]);
            frame += span;
            continue;
        }
    }
    seen.set(key, frame);
}

events.sort((a, b)=>a[0] - b[0]);
console.log(`${file}: ${((last - first) / rate).toFixed(1)} s at ${rate} Hz,`
    + ` ${events.length} events`);
for (const [frame, what] of events)
{
    console.log(`${time(frame)} s  ${what}`);
}
