/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMinimp3Decoder } from './minimp3.js';
import { parseFrameHeader } from './mp3.js';

/** MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo, and nothing coded: silence. */
const frame = new Uint8Array(417);
frame.set([0xff, 0xfb, 0x90, 0x00]);
const header = /** @type {import('./mp3.js').FrameHeader} */ (parseFrameHeader(frame, 0));

test('each frame fed comes back in the call, a whole frame of samples', ()=>{
    const decoder = createMinimp3Decoder();
    /** @type {Int16Array[]} */
    const out = [];
    const stream = decoder.open(header, pcm=>out.push(pcm), error=>assert.fail(String(error)));
    for (let index = 0; index < 3; index++)
    {
        stream.feed(frame, header);
        assert.equal(out.length, index + 1, 'answered inside feed');
    }
    assert.ok(out.every(pcm=>pcm.length === 1152 * 2 && pcm.every(sample=>sample === 0)));
    assert.equal(decoder.diagnostics?.().opens, 1);
});

test('a frame that decodes to nothing is padded to its length', ()=>{
    const decoder = createMinimp3Decoder();
    /** @type {Int16Array[]} */
    const out = [];
    const stream = decoder.open(header, pcm=>out.push(pcm), error=>assert.fail(String(error)));
    stream.feed(frame.subarray(0, 8), header);
    assert.equal(out[0].length, 1152 * 2);
    assert.equal(decoder.diagnostics?.().paddedFrames, 1);
});
