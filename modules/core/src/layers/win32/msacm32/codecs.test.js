/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MS_COEFFICIENTS, decodeImaBlock, decodeMsBlock, imaSamplesPerBlock, msSamplesPerBlock,
} from './codecs.js';

test('an IMA ADPCM block opens with its header sample and steps from there', ()=>{
    // Mono, 12 bytes: the header (100, index 0), then eight bytes of codes.
    const block = new Uint8Array(12);
    new DataView(block.buffer).setInt16(0, 100, true);
    block[4] = 0x07 | 0x00 << 4;   // +7 at step 7, then +0 at the step after
    const samples = imaSamplesPerBlock(block.length, 1);
    assert.equal(samples, 17);
    const out = new Int16Array(samples);
    decodeImaBlock(block, 1, samples, out);
    assert.equal(out[0], 100);
    // code 7 at step 7: 7>>3 + 7>>2 + 7>>1 + 7 = 0 + 1 + 3 + 7
    assert.equal(out[1], 111);
    // index 0 + 8 -> 8, step 16; code 0: 16>>3 = 2
    assert.equal(out[2], 113);
});

test('a stereo IMA ADPCM block takes four bytes of each channel in turn', ()=>{
    const block = new Uint8Array(16);
    const view = new DataView(block.buffer);
    view.setInt16(0, 1000, true);
    view.setInt16(4, -1000, true);
    block[8] = 0x08;   // left: -0 at step 7 (7>>3 = 0)... then code 0
    block[12] = 0x01;  // right: 0 + 7>>2 = +1
    const samples = imaSamplesPerBlock(block.length, 2);
    assert.equal(samples, 9);
    const out = new Int16Array(samples * 2);
    decodeImaBlock(block, 2, samples, out);
    assert.deepEqual([...out.slice(0, 4)], [1000, -1000, 1000, -999]);
});

test('a Microsoft ADPCM block opens with its older sample, then predicts from both', ()=>{
    // Mono: predictor 0 (256, 0), delta 16, sample1 100, sample2 50, then codes.
    const block = new Uint8Array(10);
    const view = new DataView(block.buffer);
    block[0] = 0;
    view.setInt16(1, 16, true);
    view.setInt16(3, 100, true);
    view.setInt16(5, 50, true);
    block[7] = 0x1f;   // +1 then -1
    const samples = msSamplesPerBlock(block.length, 1);
    assert.equal(samples, 8);
    const out = new Int16Array(samples);
    decodeMsBlock(block, 1, samples, MS_COEFFICIENTS, out);
    assert.equal(out[0], 50);
    assert.equal(out[1], 100);
    // (100 * 256 + 50 * 0) >> 8 = 100, + 1 * 16
    assert.equal(out[2], 116);
    // delta (230 * 16) >> 8 = 14, kept at 16; (116 * 256) >> 8 = 116, + -1 * 16
    assert.equal(out[3], 100);
});
