/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJpeg } from '@bottlify/core/jpeg';
import { encode as encodeBlocks } from '../../../core/src/layers/media/internal/jpeg.fixture.js';
import { encodeJpeg, fitJpeg } from './preview.js';

/**
 * A JPEG whose every sample is a function of where it is, the chrominance
 * taken at every other sample each way.
 *
 * @param {number} width @param {number} height
 * @param {(x: number, y: number, channel: number) => number} at
 */
function pictureOf(width, height, at){
    const plane = (/** @type {number} */ channel, /** @type {number} */ w,
        /** @type {number} */ h, /** @type {number} */ step)=>({
        data: Uint8Array.from({ length: w * h },
            (_, i)=>at((i % w) * step, Math.floor(i / w) * step, channel)),
        width: w,
        height: h,
    });
    const halfWidth = (width + 1) >> 1;
    const halfHeight = (height + 1) >> 1;
    return encodeJpeg(width, height, [plane(0, width, height, 1),
        plane(1, halfWidth, halfHeight, 2), plane(2, halfWidth, halfHeight, 2)]);
}

/**
 * The largest difference between a decoded channel and what it should be.
 *
 * @param {ReturnType<typeof decodeJpeg>} decoded @param {number} channel
 * @param {(x: number, y: number) => number} expected
 */
function worst(decoded, channel, expected){
    let most = 0;
    for (let y = 0; y < decoded.height; y++)
    {
        for (let x = 0; x < decoded.width; x++)
        {
            const sample = decoded.samples[(y * decoded.width + x) * decoded.components + channel];
            most = Math.max(most, Math.abs(sample - expected(x, y)));
        }
    }
    return most;
}

test('a picture coded and decoded again is the picture, near enough', ()=>{
    // 37 by 23: neither side a whole number of 16-pixel units, so the last
    // units are filled out past the picture.
    const decoded = decodeJpeg(pictureOf(37, 23,
        (x, y, channel)=>[40 + 4 * x + 3 * y, 100 + x, 160 - y][channel]));
    assert.deepEqual([decoded.width, decoded.height, decoded.components], [37, 23, 3]);
    assert.ok(worst(decoded, 0, (x, y)=>40 + 4 * x + 3 * y) <= 3, 'luminance');
    assert.ok(worst(decoded, 1, x=>100 + x) <= 4, 'blue difference');
    assert.ok(worst(decoded, 2, (x, y)=>160 - y) <= 4, 'red difference');

    // Noise uses codes a smooth picture never reaches; it still decodes.
    let seed = 7;
    const noise = ()=>(seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    const noisy = decodeJpeg(pictureOf(64, 48, ()=>noise()));
    assert.deepEqual([noisy.width, noisy.height], [64, 48]);
});

test('the Huffman tables are Annex K\'s, every symbol of each there once', ()=>{
    const bytes = pictureOf(16, 16, ()=>128);
    let at = 2;
    while (!(bytes[at] === 0xff && bytes[at + 1] === 0xc4))
    {
        at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    }
    const end = at + 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    /** @type {Map<number, number[]>} */
    const tables = new Map();
    for (let p = at + 4; p < end;)
    {
        const counts = [...bytes.subarray(p + 1, p + 17)];
        const total = counts.reduce((sum, count)=>sum + count, 0);
        tables.set(bytes[p], [...bytes.subarray(p + 17, p + 17 + total)]);
        p += 17 + total;
    }
    const ac = new Set([0x00, 0xf0]);
    for (let run = 0; run < 16; run++)
    {
        for (let size = 1; size <= 10; size++)
        {
            ac.add((run << 4) | size);
        }
    }
    assert.deepEqual([...tables.keys()], [0x00, 0x10, 0x01, 0x11]);
    for (const [id, symbols] of tables)
    {
        const expected = id & 0x10 ? ac : new Set(Array.from({ length: 12 }, (_, i)=>i));
        assert.equal(symbols.length, expected.size, `table ${id.toString(16)}: none twice`);
        assert.deepEqual(new Set(symbols), expected, `table ${id.toString(16)}: none missing`);
    }
});

test('a cover is fitted into its box, its shape kept and never enlarged', ()=>{
    const level = (/** @type {number} */ x, /** @type {number} */ y)=>20 + x / 12 + y / 18;
    const cover = pictureOf(1200, 1800, (x, y, channel)=>[level(x, y), 128, 128][channel]);

    const small = decodeJpeg(/** @type {Uint8Array} */ (fitJpeg(cover, 400, 600)));
    assert.deepEqual([small.width, small.height], [400, 600]);
    // Each new pixel is the average of the three by three it covers, which
    // on a ramp is the middle one's value.
    assert.ok(worst(small, 0, (x, y)=>level(3 * x + 1, 3 * y + 1)) <= 3, 'the area averaged');

    const wide = decodeJpeg(/** @type {Uint8Array} */ (fitJpeg(cover, 800, 800)));
    assert.deepEqual([wide.width, wide.height], [533, 800], 'the shape kept');
    const tiny = pictureOf(30, 45, ()=>90);
    assert.equal(fitJpeg(tiny, 400, 600), tiny, 'never enlarged, nor coded again for nothing');

    assert.equal(fitJpeg(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10), 400, 600), null,
        'a PNG is not read');
});

test('a grey JPEG comes out grey, and one of four components is not read', ()=>{
    const flat = (/** @type {number} */ value)=>{
        const block = new Array(64).fill(0);
        block[0] = 8 * (value - 128);
        return block;
    };
    const quant = new Array(64).fill(1);
    const grey = encodeBlocks({ width: 16, height: 16, quant,
        components: [{ h: 1, v: 1, blocks: [flat(90), flat(90), flat(90), flat(90)] }] });
    const fitted = decodeJpeg(/** @type {Uint8Array} */ (fitJpeg(Uint8Array.from(grey), 8, 8)));
    assert.deepEqual([fitted.width, fitted.height, fitted.components], [8, 8, 3]);
    assert.ok(worst(fitted, 0, ()=>90) <= 1 && worst(fitted, 1, ()=>128) <= 1
        && worst(fitted, 2, ()=>128) <= 1);

    const cmyk = encodeBlocks({ width: 8, height: 8, quant,
        components: [0, 1, 2, 3].map(()=>({ h: 1, v: 1, blocks: [flat(128)] })) });
    assert.equal(fitJpeg(Uint8Array.from(cmyk), 4, 4), null);
});
