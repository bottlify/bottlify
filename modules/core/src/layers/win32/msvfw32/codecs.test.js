/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRle, encodeRle8 } from './rle.js';
import { decodeVideo1 } from './video1.js';
import { decodeCinepak, newCinepakState } from './cinepak.js';

test('a run-length picture: runs, an absolute group padded to a word, a move and the end', ()=>{
    // 4x3, bottom row first: row 0 = 7 7 7 1; row 1 = 2 3 4 (absolute) then a move
    // one row up, to row 2 column 3, where 9 is drawn.
    const data = Uint8Array.of(3, 7, 1, 1, 0, 0, 0, 3, 2, 3, 4, 0, 0, 2, 0, 1, 1, 9, 0, 1);
    const pixels = decodeRle(data, 4, 3, 8, new Uint8Array(12).fill(0xee));
    assert.deepEqual([...pixels], [7, 7, 7, 1, 2, 3, 4, 0xee, 0xee, 0xee, 0xee, 9]);
    // Nibbles: a run alternates its two indices; an absolute group of 3 takes two bytes.
    const four = decodeRle(Uint8Array.of(4, 0x12, 0, 3, 0x34, 0x50, 0, 1), 7, 1, 4);
    assert.deepEqual([...four], [1, 2, 1, 2, 3, 4, 5]);
});

test('the encoder writes the frame msrle32 writes, an unchanged row its end of line', ()=>{
    // Wine's msvfw32 test: one row of 32 pixels and the bytes Windows answers.
    const row = new Uint8Array(32);
    row.set([1, 2, 3, 3, 3, 3, 2, 3, 1]);
    assert.deepEqual([...encodeRle8(row, 32, 1, 32, null)],
        [1, 1, 1, 2, 4, 3, 0, 3, 2, 3, 1, 0, 23, 0, 0, 0, 0, 1]);
    assert.deepEqual([...encodeRle8(row, 32, 1, 32, row)], [0, 0, 0, 1]);
    // What it writes reads back as what it was given.
    const picture = Uint8Array.from({ length: 64 }, (_, i)=>(i * 7 % 5 === 0 ? 4 : i % 3));
    assert.deepEqual([...decodeRle(encodeRle8(picture, 16, 4, 16, null), 16, 4, 8)], [...picture]);
});

test('Video 1: a skip keeps the frame before, and the one-, two- and eight-colour blocks', ()=>{
    // 8x4 at 8 bits: block 0 one colour 0x21 (code 0x8021), block 1 two colours.
    const pixels = new Uint8Array(32).fill(0xee);
    // Two colours: flags 0x00ff - the low eight pixels (rows 0-1) take the first colour.
    decodeVideo1(Uint8Array.of(0x21, 0x80, 0xff, 0x00, 5, 6), 8, 4, 8, pixels);
    for (let y = 0; y < 4; y++)
    {
        assert.deepEqual([...pixels.subarray(y * 8, y * 8 + 4)], [0x21, 0x21, 0x21, 0x21]);
        assert.deepEqual([...pixels.subarray(y * 8 + 4, y * 8 + 8)], y < 2 ? [5, 5, 5, 5] : [6, 6,
            6, 6]);
    }
    // A skip of two blocks leaves both as they were.
    const before = pixels.slice();
    decodeVideo1(Uint8Array.of(0x02, 0x84), 8, 4, 8, pixels);
    assert.deepEqual(pixels, before);
    // 16 bits, eight colours: each 2x2 quarter its own pair; flags 0 chooses each pair's second.
    const words = new Uint16Array(16);
    const colours = [0x8001, 2, 3, 4, 5, 6, 7, 8];
    const data = [0x00, 0x00, ...colours.flatMap(c=>[c & 255, c >> 8])];
    decodeVideo1(Uint8Array.from(data), 4, 4, 16, words);
    assert.deepEqual([...words], [2, 2, 4, 4, 2, 2, 4, 4, 6, 6, 8, 8, 6, 6, 8, 8]);
});

test('Cinepak: a key frame of V1 and V4 blocks from full colour codebooks', ()=>{
    /** @param {number} id @param {number[]} body */
    const chunk = (id, body)=>[id, 0, (body.length + 4) >> 8, (body.length + 4) & 255, ...body];
    // V4 entry 0: luma 10 20 30 40, U 0 V 0 (grey); V1 entry 0: luma 100, U 2, V -3.
    const v4 = chunk(0x20, [10, 20, 30, 40, 0, 0]);
    const v1 = chunk(0x22, [100, 100, 100, 100, 2, 0xfd]);
    // An intra image chunk, 8x4: block 0 V4 (flag bit set), block 1 V1 (clear).
    const image = chunk(0x30, [0x80, 0, 0, 0, 0, 0, 0, 0, 0]);
    const strip = [...v4, ...v1, ...image];
    const stripHeader = [0x10, 0, (strip.length + 12) >> 8, (strip.length + 12) & 255,
        0, 0, 0, 0, 0, 4, 0, 8];
    const frame = [0, 0, 0, 0, 0, 8, 0, 4, 0, 1, ...stripHeader, ...strip];
    const rgb = new Uint8Array(8 * 4 * 3);
    decodeCinepak(Uint8Array.from(frame), 8, 4, rgb, newCinepakState());
    const at = (/** @type {number} */ x, /** @type {number} */ y)=>[...rgb.subarray((y * 8 +
        x) * 3, (y * 8 + x) * 3 + 3)];
    // V4 block: each quarter the four lumas of entry 0, as grey.
    assert.deepEqual([at(0, 0), at(1, 0), at(0, 1), at(1, 1)],
        [[10, 10, 10], [20, 20, 20], [30, 30, 30], [40, 40, 40]]);
    assert.deepEqual(at(2, 2), [10, 10, 10]);
    // V1 block: R = Y + 2V, G = Y - U/2 - V, B = Y + 2U - every pixel the same.
    assert.deepEqual(at(4, 0), [94, 102, 104]);
    assert.deepEqual(at(7, 3), [94, 102, 104]);
});
