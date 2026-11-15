/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    bitsFromPicture, maskFromPixels, maskStride, pictureFromBits, scaleBits,
} from './icon-bits.js';

test('a picture\'s transparent pixels are its mask, and the colour is black there', ()=>{
    const bgra = Uint8Array.of(10, 20, 30, 255, 0, 0, 0, 0);
    const bits = bitsFromPicture({ width: 2, height: 1, bgra });
    assert.equal(maskStride(2), 2);
    assert.deepEqual([...bits.mask], [0x40, 0]);
    assert.deepEqual([...(bits.colour ?? [])], [10, 20, 30, 0, 0, 0, 0, 0]);
});

test('a colour mask is set where it is white', ()=>{
    const bgra = Uint8Array.of(255, 255, 255, 0, 254, 255, 255, 0);
    assert.deepEqual([...maskFromPixels({ width: 2, height: 1, bgra })], [0x80, 0]);
});

test('a monochrome icon stretches each half of its mask apart', ()=>{
    // One pixel: AND clear, XOR set - drawn white - stretched to two by two.
    const bits = { width: 1, height: 1, colour: null, mask: Uint8Array.of(0, 0, 0x80, 0) };
    const scaled = scaleBits(bits, 2, 2);
    assert.deepEqual([...scaled.mask], [0, 0, 0, 0, 0xc0, 0, 0xc0, 0]);
    const picture = pictureFromBits(scaled, { x: 1, y: 1 });
    assert.deepEqual([...picture.bgra.subarray(0, 4)], [255, 255, 255, 255]);
});
