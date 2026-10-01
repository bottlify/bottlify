/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMp3AcmCodec } from './mp3acm.js';

/** MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo, and nothing coded: silence. */
const FRAME = new Uint8Array(417);
FRAME.set([0xff, 0xfb, 0x90, 0x00]);
const FRAME_PCM = 1152 * 2 * 2;

/** @param {number} rate @param {number} channels @param {number} [tag] */
const format = (rate, channels, tag = 0x55)=>({
    tag, channels, rate, blockAlign: tag === 1 ? channels * 2 : 1, bits: tag === 1 ? 16 : 0,
    samplesPerBlock: 0, coefficients: [], averageBytes: 16000,
});

test('the driver lists MPEG Layer-3 at the rates and channels MPEG audio has', ()=>{
    const codec = createMp3AcmCodec();
    assert.equal(codec.tag, 0x55);
    const listed = codec.formats.map(one=>`${one.rate}/${one.channels}`);
    assert.ok(listed.includes('22050/2') && listed.includes('44100/1') && listed.includes('8000/2'));
    const stereo = codec.formats.find(one=>one.rate === 44100 && one.channels === 2);
    const view = new DataView(/** @type {any} */ (stereo).bytes.buffer);
    assert.equal(view.getUint16(16, true), 12, 'an MPEGLAYER3WAVEFORMAT extension');
    assert.equal(view.getUint16(18, true), 1, 'MPEGLAYER3_ID_MPEG');
});

test('it decodes to 16-bit PCM of the stream\'s own rate and channels, and nothing else', ()=>{
    const codec = createMp3AcmCodec();
    assert.ok(codec.converts(format(44100, 2), format(44100, 2, 1)));
    assert.equal(codec.converts(format(44100, 2), format(22050, 2, 1)), false);
    assert.equal(codec.converts(format(44100, 2), format(44100, 1, 1)), false);
});

test('a stream takes whole frames that fit, past a tag in front, and leaves a cut one', ()=>{
    const codec = createMp3AcmCodec();
    const stream = codec.open(format(44100, 2), format(44100, 2, 1));
    const id3 = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 2, 0, 0]);
    const source = new Uint8Array(id3.length + FRAME.length * 3 + 100);
    source.set(id3);
    for (let index = 0; index < 3; index++)
    {
        source.set(FRAME, id3.length + index * FRAME.length);
    }
    source.set(FRAME.subarray(0, 100), id3.length + FRAME.length * 3);
    const first = stream.convert(source, FRAME_PCM * 2);
    assert.equal(first.output.length, FRAME_PCM * 2, 'as many frames as the room holds');
    assert.equal(first.consumed, id3.length + FRAME.length * 2);
    const rest = stream.convert(source.subarray(first.consumed), FRAME_PCM * 4);
    assert.equal(rest.output.length, FRAME_PCM, 'the cut frame waits for its bytes');
    assert.equal(rest.consumed, FRAME.length);
    assert.equal(stream.size(FRAME.length * 3, true) >= FRAME_PCM * 3, true,
        'the size it asks for holds what it decodes');
});
