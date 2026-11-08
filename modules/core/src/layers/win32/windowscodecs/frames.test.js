/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTAINERS, WINCODEC, cropRows, sniff } from './frames.js';
import { convertRow, formatOf } from './formats.js';
import { GUID } from './layout.js';
import { PALETTE_TYPE, predefinedPalette } from './palettes.js';
import { flippedSource, heldSource, scaledSource } from './sources.js';

/** @param {string} name */
const container = name=>/** @type {import('./frames.js').Container} */ (
    CONTAINERS.find(c=>c.name === name));
/** @param {string} name */
const format = name=>/** @type {import('./formats.js').PixelFormat} */ (
    formatOf(/** @type {Record<string, string>} */ (GUID)[`PixelFormat${name}`]));

/** A 2x2 RLE8 bitmap, colours red and blue, bottom row red red, top blue red. */
function rle8(){
    const header = new Uint8Array(14 + 40 + 8);
    const view = new DataView(header.buffer);
    const data = [2, 0, 0, 0, 1, 1, 1, 0, 0, 1];
    header.set([0x42, 0x4d]);
    view.setUint32(2, header.length + data.length, true);
    view.setUint32(10, header.length, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, 2, true);
    view.setInt32(22, 2, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 8, true);
    view.setUint32(30, 1, true);
    view.setUint32(46, 2, true);
    header.set([0, 0, 255, 0, 255, 0, 0, 0], 54);
    return Uint8Array.from([...header, ...data]);
}

test('RLE comes out as 32bppBGR, its fourth byte 0, its colour table kept', ()=>{
    const bytes = rle8();
    assert.equal(sniff(bytes), container('Bmp'));
    const [frame] = /** @type {NonNullable<import('./frames.js').Container['decode']>} */ (
        container('Bmp').decode)(bytes).frames;
    assert.equal(frame.format, format('32bppBGR'));
    assert.deepEqual(frame.palette, [0xffff0000, 0xff0000ff]);
    assert.deepEqual([...frame.pixels], [255, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0]);
});

test('an icon cut short of its header or pointing past its end is refused as Windows does', ()=>{
    const decode = /** @type {NonNullable<import('./frames.js').Container['decode']>} */ (
        container('Ico').decode);
    assert.throws(()=>decode(Uint8Array.of(0, 0, 1, 0, 1)),
        (/** @type {any} */ e)=>e.hr === WINCODEC.STREAMREAD);
    const entry = new Uint8Array(22);
    const view = new DataView(entry.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, 1, true);
    view.setUint32(14, 100, true);
    view.setUint32(18, 22, true);
    assert.throws(()=>decode(entry), (/** @type {any} */ e)=>e.hr === WINCODEC.BADIMAGE);
});

test('a GIF with no colour table is read with the default one, sized by its screen', ()=>{
    const gif = Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 1, 0, 1, 0, 0x21, 0, 0,
        0x21, 0xf9, 4, 1, 5, 0, 1, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b);
    const image = /** @type {NonNullable<import('./frames.js').Container['decode']>} */ (
        container('Gif').decode)(gif);
    assert.deepEqual(image.palette, [0xff000000, 0x00ffffff, 0xff000000, 0xff000000]);
    assert.equal(image.frames[0].format, format('8bppIndexed'));
});

test('a rectangle of sub-byte pixels is shifted to start its row', ()=>{
    const rows = Uint8Array.of(0b10110000, 0b01000000);
    assert.deepEqual([...cropRows(rows, 1, 1, { x: 1, y: 0, width: 3, height: 2 })],
        [0b01100000, 0b10000000]);
});

test('flip-rotate and nearest scaling move whole pixels', async()=>{
    const source = heldSource({ width: 2, height: 1, format: GUID.PixelFormat8bppGray, dpiX: 96,
        dpiY: 96 }, ()=>null, ()=>({ bytes: Uint8Array.of(1, 2), stride: 2 }));
    const turned = flippedSource(source, 1);
    assert.deepEqual(await turned.describe(null), { width: 1, height: 2,
        format: GUID.PixelFormat8bppGray, dpiX: 96, dpiY: 96 });
    assert.deepEqual([...await turned.copy(null, { x: 0, y: 0, width: 1, height: 2 })], [1, 2]);
    const flipped = flippedSource(source, 8);
    assert.deepEqual([...await flipped.copy(null, { x: 0, y: 0, width: 2, height: 1 })], [2, 1]);
    const scaled = scaledSource(source, 4, 1, 0);
    assert.deepEqual([...await scaled.copy(null, { x: 0, y: 0, width: 4, height: 1 })],
        [1, 1, 2, 2]);
    const averaged = scaledSource(source, 1, 1, 3);
    assert.deepEqual([...await averaged.copy(null, { x: 0, y: 0, width: 1, height: 1 })], [2]);
});

test('formats: float is linear, 5551 takes top bits, CMYK goes both ways', ()=>{
    const float = convertRow(format('32bppBGRA'), format('128bppRGBAFloat'),
        Uint8Array.of(125, 125, 125, 255), 1, null, null);
    const value = new DataView(float.buffer).getFloat32(0, true);
    assert.ok(Math.abs(value - 0.205079) < 1e-5, `125 of 255 is ${value} linear`);
    const packed = convertRow(format('32bppBGRA'), format('16bppBGRA5551'),
        Uint8Array.of(0xff, 0x80, 0x0f, 0xff), 1, null, null);
    assert.equal(packed[0] | packed[1] << 8, 0x1f | 0x10 << 5 | 0x01 << 10 | 0x8000);
    const cmyk = convertRow(format('24bppBGR'), format('32bppCMYK'), Uint8Array.of(0, 0, 255), 1,
        null, null);
    assert.deepEqual([...cmyk], [0, 255, 255, 0]);
    assert.deepEqual([...convertRow(format('32bppCMYK'), format('24bppBGR'), cmyk, 1, null, null)],
        [0, 0, 255]);
});

test('predefined palettes: system colours after a cube, a transparent entry when asked', ()=>{
    const eight = /** @type {number[]} */ (predefinedPalette(PALETTE_TYPE.FIXED_HALFTONE8, true));
    assert.equal(eight.length, 17);
    assert.equal(eight[1], 0xff0000ff, 'blue fastest');
    assert.equal(eight[8], 0xffc0c0c0);
    assert.equal(eight[16], 0);
    const all = /** @type {number[]} */ (predefinedPalette(PALETTE_TYPE.FIXED_HALFTONE256, true));
    assert.equal(all.length, 256);
    assert.equal(all[255], 0);
    assert.deepEqual(predefinedPalette(PALETTE_TYPE.FIXED_BW, true), [0xff000000, 0xffffffff]);
    assert.equal(predefinedPalette(PALETTE_TYPE.MEDIAN_CUT, false), null);
});
