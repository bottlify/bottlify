/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAdpcm, parseWave } from './wave.js';

/** @param {string} s */
const text = s=>[...s].map(c=>c.charCodeAt(0));
/** @param {number} v */
const le16 = v=>[v & 0xff, v >>> 8 & 0xff];
/** @param {number} v */
const le32 = v=>[v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, v >>> 24 & 0xff];

/** @param {number[]} chunks */
const riff = chunks=>new Uint8Array([
    ...text('RIFF'), ...le32(4 + chunks.length), ...text('WAVE'), ...chunks,
]);

/** @param {string} tag @param {number[]} body */
const chunk = (tag, body)=>[
    ...text(tag), ...le32(body.length), ...body, ...(body.length & 1 ? [0] : []),
];

/** A mono ADPCM format with the standard first coefficient pair only. */
const adpcmFormat = (channels = 1, blockAlign = 16, samplesPerBlock = 20)=>[
    ...le16(2), ...le16(channels), ...le32(22050), ...le32(22050),
    ...le16(blockAlign), ...le16(4), ...le16(32),
    ...le16(samplesPerBlock), ...le16(2),
    ...le16(256), ...le16(0), // predictor 0: the previous sample as it is
    ...le16(512), ...le16(-256 & 0xffff), // predictor 1: linear extrapolation
];

test('PCM comes out as it went in, past an odd-sized chunk and its pad byte', ()=>{
    const fmt = [
        ...le16(1), ...le16(2), ...le32(44100), ...le32(44100 * 4), ...le16(4), ...le16(16),
    ];
    const wave = parseWave(riff([
        ...chunk('fmt ', fmt), ...chunk('LIST', [1, 2, 3]), ...chunk('data', [9, 8, 7, 6]),
    ]));
    assert.ok(wave);
    assert.deepEqual(wave.format, { sampleRate: 44100, channels: 2, bitsPerSample: 16 });
    assert.deepEqual([...wave.pcm], [9, 8, 7, 6]);
});

test('what is not a WAVE, or is a format nothing decodes, is refused', ()=>{
    assert.equal(parseWave(new Uint8Array([1, 2, 3])), null);
    const mulaw = [...le16(7), ...le16(1), ...le32(8000), ...le32(8000), ...le16(1), ...le16(8)];
    assert.equal(parseWave(riff([...chunk('fmt ', mulaw), ...chunk('data', [1, 2])])), null);
});

/**
 * WAVEFORMATEXTENSIBLE: the tag 0xFFFE, then after the 18-byte header the
 * valid bits, the channel mask and the sub-format GUID that names the
 * encoding -- here KSDATAFORMAT_SUBTYPE_PCM or _IEEE_FLOAT, which differ only
 * in their first dword.
 *
 * @param {number} subtype
 */
const extensible = subtype=>[
    ...le16(0xfffe), ...le16(2), ...le32(22050), ...le32(22050 * 4), ...le16(4), ...le16(16),
    ...le16(22), ...le16(16), ...le32(3),
    ...le32(subtype), ...le16(0), ...le16(0x10),
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

test('an extensible format whose sub-format is PCM is PCM', ()=>{
    const wave = parseWave(riff([
        ...chunk('fmt ', extensible(1)), ...chunk('data', [1, 2, 3, 4]),
    ]));
    assert.ok(wave, 'KSDATAFORMAT_SUBTYPE_PCM');
    assert.deepEqual(wave.format, { sampleRate: 22050, channels: 2, bitsPerSample: 16 });
    assert.deepEqual([...wave.pcm], [1, 2, 3, 4]);
    assert.equal(parseWave(riff([
        ...chunk('fmt ', extensible(3)), ...chunk('data', [1, 2, 3, 4]),
    ])), null, 'KSDATAFORMAT_SUBTYPE_IEEE_FLOAT is not PCM');
    assert.equal(parseWave(riff([
        ...chunk('fmt ', extensible(1).slice(0, 24)), ...chunk('data', [1, 2, 3, 4]),
    ])), null, 'an extensible header too short to carry its sub-format');
});

test('an ADPCM block opens with its two samples and predicts the rest from them', ()=>{
    // Predictor 0 repeats the previous sample, so a run of zero nibbles holds
    // the level; each nibble then scales the step by the adaptation table's
    // 230/256, floored, and a nibble of +1 adds one of the scaled steps.
    const block = [
        0, // predictor 0
        ...le16(64), // delta
        ...le16(1000), // sample1, the newer
        ...le16(-1000 & 0xffff), // sample2, the older
        0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    const fmt = new Uint8Array(adpcmFormat(1, block.length, 20));
    const pcm = new Int16Array(decodeAdpcm(fmt, new Uint8Array(block)).buffer);
    assert.equal(pcm.length, 20);
    assert.deepEqual([...pcm.subarray(0, 6)], [-1000, 1000, 1000, 1000, 1000 + 51, 1051]);
});

test('stereo nibbles alternate channels, left in the high half of each byte', ()=>{
    const block = [
        0, 0,
        ...le16(16), ...le16(16),
        ...le16(100), ...le16(-100 & 0xffff),
        ...le16(0), ...le16(0),
        0x1f, 0x00,
    ];
    const fmt = new Uint8Array(adpcmFormat(2, block.length, 4));
    const pcm = new Int16Array(decodeAdpcm(fmt, new Uint8Array(block)).buffer);
    // Both channels' older samples, then the newer, then left +1 step and
    // right -1 step, then a held level for each.
    assert.deepEqual([...pcm], [0, 0, 100, -100, 116, -116, 116, -116]);
});

test('an ADPCM WAVE is played as 16-bit PCM at its own rate and channel count', ()=>{
    const block = [0, ...le16(16), ...le16(5), ...le16(6), 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const wave = parseWave(riff([
        ...chunk('fmt ', adpcmFormat(1, 16, 20)), ...chunk('data', block),
    ]));
    assert.ok(wave);
    assert.deepEqual(wave.format, { sampleRate: 22050, channels: 1, bitsPerSample: 16 });
    assert.equal(wave.pcm.length, 40);
    assert.deepEqual([...new Int16Array(wave.pcm.buffer, 0, 3)], [6, 5, 5]);
});
