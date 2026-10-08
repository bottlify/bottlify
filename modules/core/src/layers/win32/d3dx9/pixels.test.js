/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FMT, decodeTexels, encodeTexels, halve, layoutOf, resample } from './pixels.js';

/** Four texels, b g r a each, that every format can hold exactly at its depth. */
const SAMPLE = Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 255, 0, 255]);

test('an uncompressed format encodes and decodes back to what it can hold', ()=>{
    for (const format of [FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.R8G8B8, FMT.A8B8G8R8,
        FMT.X8B8G8R8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.X4R4G4B4])
    {
        const encoded = encodeTexels(format, SAMPLE, 2, 2);
        assert.equal(encoded.length, layoutOf(format, 2, 2).rowBytes * 2, String(format));
        const back = decodeTexels(format, encoded, 2, 2);
        const alpha = /** @type {number[]} */ ([FMT.A8R8G8B8, FMT.A8B8G8R8, FMT.A1R5G5B5,
            FMT.A4R4G4B4]).includes(format);
        const expected = Uint8Array.from(SAMPLE, (v, i)=>(i % 4 === 3 && !alpha ? 255 : v));
        assert.deepEqual(back, expected, String(format));
    }
});

test('the bytes of each layout are the documented ones', ()=>{
    // A8R8G8B8 is b, g, r, a in memory; R5G6B5 of pure red is 0xf800, little-endian.
    const red = Uint8Array.from([0, 0, 255, 128]);
    assert.deepEqual([...encodeTexels(FMT.A8R8G8B8, red, 1, 1)], [0, 0, 255, 128]);
    assert.deepEqual([...encodeTexels(FMT.A8B8G8R8, red, 1, 1)], [255, 0, 0, 128]);
    assert.deepEqual([...encodeTexels(FMT.R5G6B5, red, 1, 1)], [0x00, 0xf8]);
    assert.deepEqual([...encodeTexels(FMT.A1R5G5B5, red, 1, 1)], [0x00, 0xfc]);
    assert.deepEqual([...encodeTexels(FMT.A4R4G4B4, red, 1, 1)], [0x00, 0x8f]);
    assert.deepEqual([...encodeTexels(FMT.L8, Uint8Array.from([255, 255, 255, 9]), 1, 1)], [255]);
    assert.deepEqual([...encodeTexels(FMT.A8L8, Uint8Array.from([0, 0, 0, 77]), 1, 1)], [0, 77]);
    assert.deepEqual([...decodeTexels(FMT.A8, Uint8Array.from([40]), 1, 1)], [0, 0, 0, 40]);
});

test('a DXT1 block decodes as the format describes, both of its modes', ()=>{
    // c0 = white, c1 = black: four colours, the two between at thirds.
    const four = Uint8Array.from([0xff, 0xff, 0x00, 0x00, 0b11100100, 0, 0, 0]);
    const texels = decodeTexels(FMT.DXT1, four, 4, 4);
    assert.deepEqual([...texels.subarray(0, 16)],
        [255, 255, 255, 255, 0, 0, 0, 255, 170, 170, 170, 255, 85, 85, 85, 255]);
    // c0 <= c1: three colours and transparent black at index 3.
    const three = Uint8Array.from([0x00, 0x00, 0xff, 0xff, 0b11100100, 0, 0, 0]);
    const punched = decodeTexels(FMT.DXT1, three, 4, 4);
    assert.deepEqual([...punched.subarray(8, 16)], [128, 128, 128, 255, 0, 0, 0, 0]);
});

test('DXT3 keeps four bits of alpha a texel, DXT5 interpolates between two', ()=>{
    const colour = [0xff, 0xff, 0x00, 0x00, 0, 0, 0, 0];
    const dxt3 = Uint8Array.from([0xf0, 0, 0, 0, 0, 0, 0, 0, ...colour]);
    const a3 = decodeTexels(FMT.DXT3, dxt3, 4, 4);
    assert.deepEqual([a3[3], a3[7]], [0, 255]);
    // a0 = 255 > a1 = 0: eight levels; texel 0 takes index 2, a sixth of the way, 219.
    const dxt5 = Uint8Array.from([255, 0, 2, 0, 0, 0, 0, 0, ...colour]);
    const a5 = decodeTexels(FMT.DXT5, dxt5, 4, 4);
    assert.deepEqual([a5[3], a5[7]], [219, 255]);
});

test('an encoded block decodes close to what went in, its alpha kept', ()=>{
    const width = 8;
    const height = 8;
    const bgra = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++)
    {
        bgra.set([i * 4 % 256, 128, 255 - i * 4 % 256, i < 32 ? 255 : 0], i * 4);
    }
    for (const format of [FMT.DXT1, FMT.DXT3, FMT.DXT5])
    {
        const back = decodeTexels(format, encodeTexels(format, bgra, width, height), width, height);
        let worst = 0;
        for (let i = 0; i < bgra.length; i++)
        {
            if (i % 4 === 3)
            {
                // DXT1 has one bit of alpha, the others four or interpolated eight levels.
                assert.ok(Math.abs(back[i] - bgra[i]) <= (format === FMT.DXT3 ? 17 : 0),
                    `${format} alpha at ${i}`);
            }
            else if (format !== FMT.DXT1 || bgra[i - (i % 4) + 3] >= 128)
            {
                worst = Math.max(worst, Math.abs(back[i] - bgra[i]));
            }
        }
        assert.ok(worst <= 24, `${format}: worst colour error ${worst}`);
    }
});

test('a level halves by averaging two by two, an odd edge repeated', ()=>{
    const bgra = Uint8Array.from([0, 0, 0, 0, 4, 4, 4, 4, 8, 8, 8, 8,
        12, 12, 12, 12, 16, 16, 16, 16, 20, 20, 20, 20]);
    const half = halve(bgra, 3, 2);
    assert.deepEqual([half.width, half.height], [1, 1]);
    assert.deepEqual([...half.bgra], [8, 8, 8, 8]);
    assert.deepEqual([...resample(Uint8Array.from([1, 2, 3, 4]), 1, 1, 2, 1)],
        [1, 2, 3, 4, 1, 2, 3, 4]);
});
