/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createDecoder } from './decoder.js';

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
