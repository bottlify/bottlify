/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX 10's texel work: formats read and written, the filters as Wine's
 * d3dx11 tests measured them on Windows, and the sRGB curve.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    FILTER, convertGamma, decodeLevel, encodeLevel, hasCodec, isBlockFormat, isSrgb, resize,
    validFilter,
} from './texels.js';

/** One channel's values as RGBA texels (the value in red, alpha 1). @param {number[]} values */
const reds = values=>Float32Array.from(values.flatMap(v=>[v, 0, 0, 1]));
/** @param {Float32Array} rgba */
const redsOf = rgba=>Array.from({ length: rgba.length / 4 }, (_, i)=>rgba[i * 4]);

test('POINT takes the texel a 16.16 step lands on, truncated: three of twelve land short', ()=>{
    const out = resize(reds([0, 1, 2, 3]), 4, 1, 1, 12, 1, 1, FILTER.POINT);
    assert.deepEqual(redsOf(out), [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3]);
    assert.deepEqual(redsOf(resize(reds([0, 1, 2, 3, 4, 5]), 6, 1, 1, 4, 1, 1, FILTER.POINT)),
        [0, 1, 3, 4]);
});

test('LINEAR samples around each centre, wrapping at the edges unless told to mirror', ()=>{
    const wrapped = redsOf(resize(reds([0, 1]), 2, 1, 1, 4, 1, 1, FILTER.LINEAR));
    assert.deepEqual(wrapped, [0.25, 0.25, 0.75, 0.75], 'the first and last reach round');
    const mirrored = redsOf(resize(reds([0, 1]), 2, 1, 1, 4, 1, 1,
        FILTER.LINEAR | FILTER.MIRROR_U));
    assert.deepEqual(mirrored, [0, 0.25, 0.75, 1]);
    assert.deepEqual(redsOf(resize(reds([0, 1, 4, 5]), 4, 1, 1, 2, 1, 1, FILTER.LINEAR)),
        [0.5, 4.5], 'halving averages each pair');
});

test('BOX averages where a size halves to a power of two, else is LINEAR or TRIANGLE', ()=>{
    const box = encodeLevel(28, resize(decodeLevel(28, Uint8Array.of(0, 0, 0, 0, 1, 1, 1, 1),
        2, 1), 2, 1, 1, 1, 1, 1, FILTER.BOX), 1, 1);
    assert.deepEqual([...box], [1, 1, 1, 1], 'half rounds up, as (sum + 2) >> 2');
    const six = reds([0, 6, 12, 18, 24, 30]);
    assert.deepEqual(resize(six, 6, 1, 1, 3, 1, 1, FILTER.BOX),
        resize(six, 6, 1, 1, 3, 1, 1, FILTER.LINEAR), 'halving 6 to 3 is LINEAR');
    assert.deepEqual(resize(six, 6, 1, 1, 4, 1, 1, FILTER.BOX),
        resize(six, 6, 1, 1, 4, 1, 1, FILTER.TRIANGLE), 'any other size is TRIANGLE');
});

test('NONE copies what overlaps and leaves the rest transparent black', ()=>{
    const out = resize(reds([0.5, 0.25]), 2, 1, 1, 3, 2, 1, FILTER.NONE);
    assert.deepEqual([...out], [0.5, 0, 0, 1, 0.25, 0, 0, 1, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a filter is a kind from NONE to BOX and its own flags', ()=>{
    assert.equal(validFilter(FILTER.LINEAR | FILTER.MIRROR_U | FILTER.SRGB_IN), true);
    assert.equal(validFilter(7), false);
    assert.equal(validFilter(0), false);
    assert.equal(validFilter(FILTER.POINT | 0x8), false);
    assert.equal(validFilter(FILTER.BOX | 0x800000), false);
});

test('sRGB in and out are the power 2.2, alpha left as it is', ()=>{
    const rgba = decodeLevel(28, Uint8Array.of(0x30, 0x20, 0x10, 0x00, 0x70, 0x60, 0x50, 0x40), 2,
        1);
    convertGamma(rgba, true);
    assert.deepEqual([...encodeLevel(28, rgba, 2, 1)], [0x06, 0x03, 0x01, 0x00, 0x2a, 0x1e, 0x14,
        0x40]);
    const out = decodeLevel(28, Uint8Array.of(0x30, 0x20, 0x10, 0x00), 1, 1);
    convertGamma(out, false);
    assert.deepEqual([...encodeLevel(28, out, 1, 1)], [0x77, 0x63, 0x48, 0x00]);
    assert.equal(isSrgb(29), true);
    assert.equal(isSrgb(78), true);
    assert.equal(isSrgb(28), false);
});

test('formats read and written: packed, signed, half floats, BGRA and blocks', ()=>{
    /** @param {number} format @param {number[]} bytes @param {number} [w] @param {number} [h] */
    const round = (format, bytes, w = 1, h = 1)=>[...encodeLevel(format,
        decodeLevel(format, Uint8Array.from(bytes), w, h), w, h)];
    for (const [format, bytes] of /** @type {[number, number[]][]} */ ([[85, [0x34, 0x12]],
        [86, [0x34, 0x92]], [115, [0x34, 0x12]], [24, [0x78, 0x56, 0x34, 0x12]],
        [31, [0x81, 0x7f, 0x00, 0xc0]], [10, [0x00, 0x3c, 0x01, 0x80, 0xff, 0x7b, 0, 0]],
        [87, [1, 2, 3, 4]], [13, [0x01, 0x80, 0xff, 0x7f, 0, 0, 0x34, 0x12]]]))
    {
        const expected = format === 31 ? [0x81, 0x7f, 0x00, 0xc0] : bytes;
        assert.deepEqual(round(format, bytes), expected, `format ${format}`);
    }
    // B5G6R5: red in the top five bits.
    assert.deepEqual([...decodeLevel(85, Uint8Array.of(0x00, 0xf8), 1, 1)], [1, 0, 0, 1]);
    // B8G8R8X8: X written as 255, read as nothing.
    assert.deepEqual([...encodeLevel(88, Float32Array.of(1, 0, 0, 0.2), 1, 1)], [0, 0, 255, 255]);
    // BC1 of one colour round trips; BC4 holds one channel.
    const bc1 = [0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0];
    assert.deepEqual(redsOf(decodeLevel(71, Uint8Array.from(bc1), 4, 4)), Array(16).fill(1));
    assert.deepEqual([...decodeLevel(80, Uint8Array.of(200, 200, 0, 0, 0, 0, 0, 0), 4, 4)
        .subarray(0, 4)], [200 / 255, 0, 0, 1].map(Math.fround));
    assert.equal(hasCodec(98), false, 'BC7 has no codec here');
    assert.equal(isBlockFormat(98) && isBlockFormat(71) && !isBlockFormat(28), true);
});
