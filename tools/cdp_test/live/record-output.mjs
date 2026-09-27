/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Records what the person hears: the launcher's sound output, sample for
 * sample, uncompressed, taken off the output node itself.
 *
 *   node tools/cdp_test/live/record-output.mjs arm
 *       installs the tap in the open tab; the next title started there is
 *       recorded (the launcher makes its output node anew for every start)
 *   node tools/cdp_test/live/record-output.mjs save [seconds=20] [file=dbg/output.wav]
 *       writes the last seconds heard as 16-bit stereo WAV
 *
 * The tap wraps AudioWorkletNode so every node made after the load also feeds
 * a recorder that keeps the last two minutes in memory; it changes nothing the
 * person hears.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from './connect.mjs';

const [command = 'save', ...rest] = process.argv.slice(2);
const { cdp, sessionId, evaluate } = await connect();

const TAP = `(()=>{
    const Original = globalThis.AudioWorkletNode;
    if (!Original || globalThis.__outputTap) return;
    const tap = globalThis.__outputTap = { rate: 0, chunks: [], frames: 0, limit: 0 };
    globalThis.AudioWorkletNode = class extends Original {
        constructor(context, name, options){
            super(context, name, options);
            tap.rate = context.sampleRate;
            tap.limit = context.sampleRate * 120;
            const recorder = context.createScriptProcessor(4096, 2, 2);
            recorder.onaudioprocess = event=>{
                const left = event.inputBuffer.getChannelData(0).slice();
                const right = event.inputBuffer.getChannelData(1).slice();
                tap.chunks.push([left, right]);
                tap.frames += left.length;
                while (tap.frames - tap.chunks[0][0].length > tap.limit)
                {
                    tap.frames -= tap.chunks.shift()[0].length;
                }
            };
            this.connect(recorder);
            const sink = context.createGain();
            sink.gain.value = 0;
            recorder.connect(sink);
            sink.connect(context.destination);
        }
    };
})()`;

if (command === 'arm')
{
    await evaluate(TAP);
    // Held attached, so the tap is put back into every page this tab loads:
    // a script added through a session lasts only as long as the session.
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: TAP }, sessionId);
    console.log('armed: start the title again in this tab; it is recorded from then on'
        + ' (this stays running to keep the tap across reloads; stop it when done)');
    setInterval(()=>{}, 1 << 30);
    await new Promise(()=>{});
    process.exit(0);
}

const seconds = Number(rest[0] ?? 20);
const file = rest[1] ?? 'dbg/output.wav';
const got = await evaluate(`(()=>{ const tap = globalThis.__outputTap;
    if (!tap || tap.chunks.length === 0) return null;
    const want = Math.min(tap.frames, Math.round(tap.rate * ${seconds}));
    const out = new Int16Array(want * 2);
    let at = want;
    for (let chunk = tap.chunks.length - 1; chunk >= 0 && at > 0; chunk--)
    {
        const [left, right] = tap.chunks[chunk];
        for (let i = left.length - 1; i >= 0 && at > 0; i--)
        {
            at--;
            out[at * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)));
            out[at * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)));
        }
    }
    let text = '';
    const bytes = new Uint8Array(out.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000)
    {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { rate: tap.rate, data: btoa(text) };
})()`);
if (!got)
{
    console.log('nothing recorded: arm, start the title again, then play');
    process.exit(1);
}
const pcm = Buffer.from(got.data, 'base64');
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(got.rate, 24);
header.writeUInt32LE(got.rate * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, Buffer.concat([header, pcm]));
console.log(`${file}: ${(pcm.length / 4 / got.rate).toFixed(1)} s at ${got.rate} Hz`);
process.exit(0);
