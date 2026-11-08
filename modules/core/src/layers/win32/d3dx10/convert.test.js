/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertTexels, converts } from './convert.js';

/** @param {Uint8Array} bytes */
const floats = bytes=>[...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)];
/** @param {Uint8Array} bytes */
const halves = bytes=>[...new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)];

test('R8_UNORM into R32_FLOAT: each byte over 255', ()=>{
    assert.ok(converts(61, 41));
    assert.deepEqual(floats(convertTexels(61, 41, Uint8Array.from([0, 51, 255]), 3)),
        [0, Math.fround(0.2), 1]);
});

test('into and out of half floats, rounded to nearest even', ()=>{
    const source = new Uint8Array(new Float32Array([1, 0.5, -2, 65504, 2 ** -24, 1 + 2 ** -11])
        .buffer);
    assert.deepEqual(halves(convertTexels(41, 54, source, 6)),
        [0x3c00, 0x3800, 0xc000, 0x7bff, 0x0001, 0x3c00], 'a tie goes to the even fraction');
    const back = convertTexels(54, 41, Uint8Array.from([0x00, 0x3c, 0x01, 0x00, 0x00, 0xfc]), 3);
    assert.deepEqual(floats(back), [1, 2 ** -24, -Infinity]);
});

test('BGRA into RGBA, X written as 255, a missing channel read as 0 and alpha as 1', ()=>{
    assert.deepEqual([...convertTexels(87, 28, Uint8Array.from([1, 2, 3, 4]), 1)], [3, 2, 1, 4]);
    assert.deepEqual([...convertTexels(88, 28, Uint8Array.from([1, 2, 3, 9]), 1)],
        [3, 2, 1, 255], 'B8G8R8X8: its fourth byte is no alpha');
    assert.deepEqual([...convertTexels(65, 28, Uint8Array.from([7]), 1)], [0, 0, 0, 7], 'A8');
    assert.deepEqual([...convertTexels(61, 87, Uint8Array.from([9]), 1)], [0, 0, 9, 255], 'R8');
    assert.deepEqual([...convertTexels(41, 61, new Uint8Array(new Float32Array([2, -1]).buffer),
        2)], [255, 0], 'clamped into the unsigned range');
    assert.equal(converts(71, 28), false, 'blocks are not texels');
});
