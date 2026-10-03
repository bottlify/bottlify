/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddbToBgra, dibToBgra, groupImageId, planesToBgra } from './cursors.js';

/** The four pixels of the two masks: black, white, the screen, the screen inverted. */
const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];
const INVERTED = [0, 0, 0, 255];

/** @param {Uint8Array} bgra */
const pixels = bgra=>Array.from({ length: bgra.length / 4 },
    (_, index)=>[...bgra.subarray(index * 4, index * 4 + 4)]);

/**
 * A BITMAPINFOHEADER for an icon or cursor image, its height counting both masks.
 *
 * @param {number} width @param {number} height @param {number} depth @param {number} [used]
 */
function header(width, height, depth, used = 0){
    const bytes = new Uint8Array(40);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 40, true);
    view.setInt32(4, width, true);
    view.setInt32(8, height * 2, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, depth, true);
    view.setUint32(32, used, true);
    return [...bytes];
}

test('CreateCursor\'s planes: AND keeps the screen, XOR colours or inverts it', ()=>{
    // As documented for CreateCursor: AND 0 XOR 0 is black, AND 0 XOR 1 white,
    // AND 1 XOR 0 the screen, AND 1 XOR 1 the screen inverted. Rows are WORD
    // aligned, so a 4-pixel row takes two bytes.
    const and = Uint8Array.of(0b00110000, 0, 0b10000000, 0);
    const xor = Uint8Array.of(0b01010000, 0, 0b10000000, 0);
    assert.deepEqual(pixels(planesToBgra(4, 2, and, xor)),
        [BLACK, WHITE, CLEAR, INVERTED, INVERTED, BLACK, BLACK, BLACK]);
});

test('CreateIcon\'s colour bitmap is device-dependent, its rows padded to a word: 32, 16 and '
    + '4 bits', ()=>{
    // Two pixels a row: the first shows its colour, the second is masked away.
    const and = Uint8Array.of(0b01000000, 0);
    const deep = Uint8Array.of(10, 20, 30, 0, 40, 50, 60, 0);
    assert.deepEqual([...ddbToBgra(2, 1, 32, and, deep)], [10, 20, 30, 255, 0, 0, 0, 255],
        'blue, green, red, and the masked pixel inverts where its colour is not black');
    // 5-5-5: red 31, green 0, blue 0 is 0x7c00; the row is four bytes already.
    const high = Uint8Array.of(0x00, 0x7c, 0, 0);
    assert.deepEqual([...ddbToBgra(2, 1, 16, and, high)].slice(0, 4), [0, 0, 248, 255]);
    // Four bits: colour 12 is blue in the sixteen, 0 black; one byte, padded to two.
    const low = Uint8Array.of(0xc0, 0);
    assert.deepEqual([...ddbToBgra(2, 1, 4, and, low)], [255, 0, 0, 255, 0, 0, 0, 0]);
});

test('a monochrome image is read bottom row first through its two-colour table', ()=>{
    const bytes = Uint8Array.from([
        ...header(2, 2, 1),
        0, 0, 0, 0, 255, 255, 255, 0,     // black, white
        0b01000000, 0, 0, 0,              // XOR, the bottom row: black, white
        0b10000000, 0, 0, 0,              // XOR, the top row: white, black
        0b00000000, 0, 0, 0,              // AND, the bottom row
        0b01000000, 0, 0, 0,              // AND, the top row: the second pixel is the screen
    ]);
    const picture = dibToBgra(bytes);
    assert.equal(picture?.width, 2);
    assert.equal(picture?.height, 2, 'the header\'s height counts both masks');
    assert.deepEqual(pixels(picture?.bgra ?? new Uint8Array()), [WHITE, CLEAR, BLACK, WHITE]);
});

test('a 32-bit image with alpha is drawn by its alpha, and a 4-bit one by its table', ()=>{
    const alpha = Uint8Array.from([
        ...header(1, 2, 32),
        10, 20, 30, 128,                  // the bottom row
        40, 50, 60, 0,                    // the top row
        0xff, 0, 0, 0, 0xff, 0, 0, 0,     // an AND mask that is not read
    ]);
    assert.deepEqual(pixels(dibToBgra(alpha)?.bgra ?? new Uint8Array()),
        [[40, 50, 60, 0], [10, 20, 30, 128]]);

    const table = [...new Array(16)].flatMap((_, index)=>[index, index * 2, index * 3, 0]);
    const nibbles = Uint8Array.from([
        ...header(2, 1, 4, 16), ...table,
        0x30, 0, 0, 0,                    // colours 3 and 0
        0b01000000, 0, 0, 0,              // the second is the screen
    ]);
    assert.deepEqual(pixels(dibToBgra(nibbles)?.bgra ?? new Uint8Array()),
        [[3, 6, 9, 255], CLEAR]);
});

test('an image it cannot read is no picture, not a wrong one', ()=>{
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ...new Array(40).fill(0));
    assert.equal(dibToBgra(png), null, 'a PNG-compressed entry');
    assert.equal(dibToBgra(Uint8Array.from(header(32, 32, 32))), null, 'bits cut short');
    assert.equal(dibToBgra(Uint8Array.from(header(2, 2, 16))), null, 'a depth icons do not use');
});

test('a group directory offers the deepest image of the size asked for, or its first', ()=>{
    /** @param {[number, number, number][]} entries  width, depth, id @param {boolean} cursor */
    const group = (entries, cursor)=>{
        const bytes = new Uint8Array(6 + entries.length * 14);
        const view = new DataView(bytes.buffer);
        view.setUint16(2, cursor ? 2 : 1, true);
        view.setUint16(4, entries.length, true);
        entries.forEach(([width, depth, id], index)=>{
            const at = 6 + index * 14;
            if (cursor)
            {
                view.setUint16(at, width, true);
                view.setUint16(at + 2, width * 2, true);
            }
            else
            {
                bytes[at] = width & 0xff;
                bytes[at + 1] = width & 0xff;
            }
            view.setUint16(at + 6, depth, true);
            view.setUint16(at + 12, id, true);
        });
        return bytes;
    };
    assert.equal(groupImageId(group([[16, 32, 1], [32, 1, 2], [32, 32, 3]], true), true, 32), 3);
    assert.equal(groupImageId(group([[48, 8, 7], [64, 8, 8]], true), true, 32), 7);
    assert.equal(groupImageId(group([[256, 32, 4], [32, 4, 5]], false), false, 256), 4,
        'an icon entry names 256 as 0');
    assert.equal(groupImageId(new Uint8Array(4), true, 32), null);
});
