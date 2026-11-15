/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameRateToTime, imageSize, mulDiv, timeToFrameRate } from './formats.js';

/** @param {string} code */
const fourcc = code=>`{${[...code].map(c=>c.charCodeAt(0)).reverse()
    .map(byte=>byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`
    + '-0000-0010-8000-00AA00389B71}';
const RGB24 = '{00000014-0000-0010-8000-00AA00389B71}';
const RGB8 = '{00000029-0000-0010-8000-00AA00389B71}';
const FLOAT16 = '{00000071-0000-0010-8000-00AA00389B71}';

test('a frame rate becomes its time a frame, the known rates their rounded own', ()=>{
    for (const [numerator, denominator, time] of [[60000, 1001, 166833], [30000, 1001, 333667],
        [24000, 1001, 417188], [60, 1, 166667], [30, 1, 333333], [24, 1, 416667], [39, 1, 256410],
        [120, 1, 83333], [0, 0, 0], [0, 1001, 0]])
    {
        assert.equal(frameRateToTime(numerator, denominator), BigInt(time),
            `${numerator}/${denominator}`);
    }
});

test('a time a frame becomes a rate: a known one within 30 ticks, else reduced, held to 10 s', ()=>{
    for (const [time, numerator, denominator] of [[166863, 60000, 1001], [166803, 60000, 1001],
        [333637, 30000, 1001], [417218, 24000, 1001], [166697, 60, 1], [199970, 50, 1],
        [256410, 1000000, 25641], [83333, 10000000, 83333], [100000001, 1, 10],
        [200000000, 1, 10], [20000000, 1, 2], [2000000, 5, 1], [0, 0, 0]])
    {
        assert.deepEqual(timeToFrameRate(BigInt(time)), { numerator, denominator }, `${time}`);
    }
});

test('MFllMulDiv keeps the product whole, truncates, and answers the largest for a zero divisor',
    ()=>{
        const max = (1n << 63n) - 1n;
        assert.equal(mulDiv(0n, 0n, 0n, 0n), max);
        assert.equal(mulDiv(1000000n, 1000000n, 2n, 0n), 500000000000n);
        assert.equal(mulDiv(max, 3n, max, 1n), 3n);
        assert.equal(mulDiv(-10000n, 3n, 100n, 0n), -300n);
        assert.equal(mulDiv(2n, 0n, 3n, 5n), 1n);
        assert.equal(mulDiv(2n, 1n, 1n, -3n), -1n);
        assert.equal(mulDiv(max, 4n, 8n, 0n), max / 2n);
        assert.equal(mulDiv(max, 4n, 0x100000000n, 0n), 0x1ffffffffn);
    });

test('a frame\'s size: RGB rows padded to a DWORD, packed and planar YUV by their widths', ()=>{
    /** @type {[string, number, number, number][]} */
    const cases = [
        [RGB8, 3, 5, 20], [RGB24, 4, 3, 36], [RGB24, 1, 1, 4], [FLOAT16, 3, 5, 120],
        ['{E436EB7D-524F-11CE-9F53-0020AF0BA770}', 4, 3, 36],
        [fourcc('AYUV'), 1, 2, 8], [fourcc('YUY2'), 4, 3, 24], [fourcc('UYVY'), 2, 1, 4],
        [fourcc('IMC1'), 1, 1, 4], [fourcc('IMC3'), 4, 3, 24],
        [fourcc('NV12'), 1, 3, 9], [fourcc('NV12'), 3, 2, 12], [fourcc('NV12'), 650, 850, 828750],
        [fourcc('IMC2'), 3, 5, 30], [fourcc('YV12'), 1, 1, 3], [fourcc('NV11'), 1, 3, 18],
        [fourcc('P010'), 1, 2, 12], [fourcc('P010'), 3, 2, 24], [RGB24, 2, 0, 0]];
    for (const [subtype, width, height, size] of cases)
    {
        assert.equal(imageSize(subtype, width, height), size, `${subtype} ${width}x${height}`);
    }
    assert.equal(imageSize('{00000000-0000-0000-C000-000000000046}', 1, 1), null,
        'IUnknown is no subtype');
});
