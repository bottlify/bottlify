/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createDecoder, decoderSession } from './decoder.js';

/**
 * The binary is a build artifact and is not in git, so these tests say what is
 * missing and skip rather than fail on a machine that has not fetched it:
 * `npm run fetch:video-decoder`.
 */
const ARTIFACT = new URL('../../../../vendor/prebuilt/video-decoder.wasm', import.meta.url);

async function loadDecoder(){
    try
    {
        return await createDecoder(await readFile(ARTIFACT));
    }
    catch (e){
        if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT')
        {
            return null;
        }
        throw e;
    }
}

const MISSING = 'video-decoder.wasm is absent: run `npm run fetch:video-decoder`';

/**
 * A complete, minimal WAV: the smallest real container this build can open, and
 * enough to prove the whole path -- demux, decode, resample, hand back PCM --
 * without a fixture in the repository.
 *
 * @param {Int16Array} samples @param {number} rate
 * @returns {Uint8Array}
 */
function wav(samples, rate){
    const data = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const file = new Uint8Array(44 + data.length);
    const header = new DataView(file.buffer);
    const ascii = (/** @type {number} */ at, /** @type {string} */ text)=>{
        for (let i = 0; i < text.length; i++)
        {
            file[at + i] = text.charCodeAt(i);
        }
    };
    ascii(0, 'RIFF');
    header.setUint32(4, 36 + data.length, true);
    ascii(8, 'WAVEfmt ');
    header.setUint32(16, 16, true);        // fmt chunk size
    header.setUint16(20, 1, true);         // PCM
    header.setUint16(22, 1, true);         // mono
    header.setUint32(24, rate, true);
    header.setUint32(28, rate * 2, true);  // bytes per second
    header.setUint16(32, 2, true);         // block align
    header.setUint16(34, 16, true);        // bits per sample
    ascii(36, 'data');
    header.setUint32(40, data.length, true);
    file.set(data, 44);
    return file;
}

test('a file the build cannot make sense of is refused by name', async t=>{
    const decoder = await loadDecoder();
    if (!decoder)
    {
        return t.skip(MISSING);
    }
    assert.throws(
        ()=>decoder.open(new Uint8Array(4096).fill(0x5a)),
        /not recognised|neither video nor audio/);
});

test('an empty file is refused rather than opened', async t=>{
    const decoder = await loadDecoder();
    if (!decoder)
    {
        return t.skip(MISSING);
    }
    assert.throws(()=>decoder.open(new Uint8Array(0)), /media:/);
});

test('a clip reports what it holds, and hands back every sample of it', async t=>{
    const decoder = await loadDecoder();
    if (!decoder)
    {
        return t.skip(MISSING);
    }
    const samples = Int16Array.from({ length: 400 }, (_, i)=>(i * 37) % 4096 - 2048);
    const clip = decoder.open(wav(samples, 8000));

    assert.equal(clip.hasAudio, true);
    assert.equal(clip.hasVideo, false);
    assert.equal(clip.sampleRate, 8000);
    assert.equal(clip.channels, 1);
    assert.equal(clip.frame(), null);

    /** @type {number[]} */
    const decoded = [];
    let status = '';
    for (let guard = 0; guard < 64 && status !== 'end'; guard++)
    {
        status = clip.decode();
        const pcm = clip.readAudio();
        if (pcm)
        {
            decoded.push(...pcm);
        }
    }
    // Whatever was still held when the stream ended is still ours to take.
    const tail = clip.readAudio();
    if (tail)
    {
        decoded.push(...tail);
    }

    assert.equal(status, 'end');
    assert.deepEqual(decoded, [...samples]);

    clip.close();
    assert.throws(()=>clip.decode(), /closed clip/);
});

test('a decoded clip is counted, and closeAll lets go of it', async t=>{
    const decoder = await loadDecoder();
    if (!decoder)
    {
        return t.skip(MISSING);
    }
    const clip = decoder.open(wav(new Int16Array(64), 22050));
    assert.equal(decoder.diagnostics().clips, 1);
    clip.decode();
    assert.ok(clip.audioPending() > 0, 'the samples are waiting to be taken');

    decoder.closeAll();
    assert.equal(decoder.diagnostics().clips, 0);
});

test('clips belong to the machine, the instance to the run', async t=>{
    const instance = await loadDecoder();
    if (!instance)
    {
        return t.skip(MISSING);
    }
    const first = decoderSession(instance);
    const clip = first.open(wav(new Int16Array(64), 22050));
    clip.decode();
    assert.ok(clip.audioPending() > 0, 'the first machine decoded it');
    assert.equal(instance.diagnostics().opened, 1, 'the instance counted the clip');
    assert.equal(instance.diagnostics().clips, 1);

    // What a machine holds is its clips: dropping them leaves the instance --
    // its counters and its memory -- for whoever holds it next.
    first.closeAll();
    assert.equal(instance.diagnostics().clips, 0, 'the machine closed its clip');
    assert.equal(instance.diagnostics().opened, 1, 'the instance kept its count');
    assert.throws(()=>clip.decode(), /closed clip/);

    const second = decoderSession(instance);
    assert.equal(second.instance(), instance, 'both machines share one instance');
    second.open(wav(new Int16Array(32), 22050));
    assert.equal(instance.diagnostics().opened, 2, 'the count continues, not starts over');
    assert.equal(instance.diagnostics().clips, 1, 'the second machine still opens');

    second.closeAll();
    assert.equal(instance.diagnostics().clips, 0);
});

/** MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo, zeros past the header: a silent frame. */
function silentFrame(){
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x00]);
    return frame;
}

const LAYER3 = { formatTag: 0x55, sampleRate: 44100, channels: 2 };
const PREDATES = 'video-decoder.wasm predates the packet-fed audio path: rebuild it';

test('a binary built without the packet-fed path answers null rather than failing', async t=>{
    const decoder = await loadDecoder();
    if (!decoder)
    {
        return t.skip(MISSING);
    }
    if (decoder.audioCapable())
    {
        return t.skip('this binary has the path; the null answer is for one without it');
    }
    assert.equal(decoder.openAudio(LAYER3), null);
    assert.equal(decoder.diagnostics().audioCapable, false);
});

test('an elementary stream is decoded inside the call that fed it', async t=>{
    const decoder = await loadDecoder();
    if (!decoder)
    {
        return t.skip(MISSING);
    }
    if (!decoder.audioCapable())
    {
        return t.skip(PREDATES);
    }
    const stream = decoder.openAudio(LAYER3);
    assert.ok(stream, 'a Layer 3 stream opens');
    assert.equal(stream.sampleRate, 44100);
    assert.equal(stream.channels, 2);
    assert.equal(decoder.diagnostics().clips, 1);

    let total = 0;
    for (let index = 0; index < 4; index++)
    {
        /** @type {Int16Array} */
        const pcm = stream.feed(silentFrame());
        assert.equal(pcm.length, 1152 * 2, `frame ${index} came out whole, in the call`);
        assert.ok(pcm.every(sample=>sample === 0), 'and silent');
        total += pcm.length;
    }
    total += stream.flush().length;
    assert.equal(total, 4 * 1152 * 2, 'every sample fed came out, none twice');
    assert.equal(decoder.diagnostics().audioStreams, 1);

    stream.close();
    stream.close();
    assert.throws(()=>stream.feed(silentFrame()), /closed stream/);
    assert.equal(decoder.diagnostics().clips, 0);
});

test('a stream the build cannot serve fails by name', async t=>{
    const decoder = await loadDecoder();
    if (!decoder)
    {
        return t.skip(MISSING);
    }
    if (!decoder.audioCapable())
    {
        return t.skip(PREDATES);
    }
    assert.throws(()=>decoder.openAudio({ ...LAYER3, formatTag: 0x7777 }), /no decoder/);
    assert.throws(()=>decoder.openAudio({ ...LAYER3, sampleRate: 0 }), /unusable/);
    assert.equal(decoder.diagnostics().clips, 0, 'nothing was left open by a refusal');
});
