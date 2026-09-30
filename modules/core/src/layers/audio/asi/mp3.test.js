/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrameHeader, id3Length, splitFrames, scanFrames } from './mp3.js';

/** MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo: 417 bytes a frame. */
const MPEG1_HEADER = [0xff, 0xfb, 0x90, 0x00];
/** MPEG-2 layer III, 64 kbit/s, 22.05 kHz, mono, padded: 208 + 1 bytes. */
const MPEG2_HEADER = [0xff, 0xf3, 0x82, 0xc0];

/**
 * A stream of `count` frames, each filled with its own index.
 *
 * @param {number} count @param {number[]} header @param {number} length
 */
function stream(count, header = MPEG1_HEADER, length = 417){
    const bytes = new Uint8Array(count * length);
    for (let index = 0; index < count; index++)
    {
        bytes.fill(index + 1, index * length, (index + 1) * length);
        bytes.set(header, index * length);
    }
    return bytes;
}

test('a header says how long its frame is and what is in it', ()=>{
    const one = parseFrameHeader(new Uint8Array(MPEG1_HEADER), 0);
    assert.deepEqual(one, {
        version: 1, bitrate: 128000, sampleRate: 44100, channels: 2, length: 417, samples: 1152,
    });
    const two = parseFrameHeader(new Uint8Array(MPEG2_HEADER), 0);
    assert.deepEqual(two, {
        version: 2, bitrate: 64000, sampleRate: 22050, channels: 1, length: 209, samples: 576,
    });
});

test('what is not a layer III header is refused', ()=>{
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb]), 0), null, 'too short');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfd, 0x90, 0]), 0), null, 'layer II');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0xf0, 0]), 0), null, 'bad bitrate');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0x9c, 0]), 0), null, 'bad rate');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xeb, 0x90, 0]), 0), null,
        'the reserved version');
});

test('an ID3v2 tag at the front is stepped over', ()=>{
    const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x02, 0x01]);
    assert.equal(id3Length(tag), 10 + 257);
    const withFooter = Uint8Array.from(tag);
    withFooter[5] = 0x10;
    assert.equal(id3Length(withFooter), 10 + 257 + 10);
    assert.equal(id3Length(new Uint8Array(MPEG1_HEADER)), 0);
});

test('the stream is cut at its frames, and a false sync inside one is not a frame', ()=>{
    const bytes = stream(3);
    // A sync pattern in the middle of frame two, where audio data may carry one.
    bytes.set(MPEG1_HEADER, 417 + 100);
    const frames = splitFrames(bytes);
    assert.deepEqual(frames.map(frame=>frame.offset), [0, 417, 834]);
    assert.equal(frames[0].header.length, 417);
});

test('a tag in front and a truncated frame at the end are both left out', ()=>{
    const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
    const bytes = new Uint8Array([...tag, ...stream(2), ...MPEG1_HEADER, 0, 0]);
    assert.deepEqual(splitFrames(bytes).map(frame=>frame.offset), [15, 15 + 417]);
});

test('a partial buffer yields only the frames it can confirm, and says where to resume', ()=>{
    const bytes = stream(3);
    // Two frames and most of a third: the second is confirmed by the third's
    // header, the third waits for what follows it.
    const partial = scanFrames(bytes, 0, 417 * 2 + 300, false);
    assert.deepEqual(partial.frames.map(frame=>frame.offset), [0, 417]);
    assert.equal(partial.next, 834, 'resume at the unconfirmed frame, not past it');
    const rest = scanFrames(bytes, partial.next, bytes.length, true);
    assert.deepEqual(rest.frames.map(frame=>frame.offset), [834]);
    assert.equal(rest.next, bytes.length);
    // Fewer bytes than a header: nothing yet, and nothing consumed.
    assert.deepEqual(scanFrames(bytes, 0, 3, false), { frames: [], next: 0 });
});
