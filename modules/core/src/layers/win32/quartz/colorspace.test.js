/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertFrame, layoutOf, rgbType } from './colorspace.js';
import { FORMAT_VIDEO_INFO, MEDIATYPE_VIDEO } from './filter.js';

const RGB8 = '{E436EB7A-524F-11CE-9F53-0020AF0BA770}';
const RGB565 = '{E436EB7B-524F-11CE-9F53-0020AF0BA770}';
const RGB555 = '{E436EB7C-524F-11CE-9F53-0020AF0BA770}';
const RGB24 = '{E436EB7D-524F-11CE-9F53-0020AF0BA770}';
const ARGB32 = '{773C9AC0-3274-11D0-B724-00AA006C1A01}';

/**
 * A VIDEOINFOHEADER type over a BITMAPINFOHEADER and what follows it.
 *
 * @param {string} sub @param {number} width @param {number} height @param {number} bits
 * @param {{ compression?: number, extra?: number[] }} [more]
 */
const video = (sub, width, height, bits, more = {})=>{
    const extra = more.extra ?? [];
    const format = new Uint8Array(0x30 + 40 + extra.length * 4);
    const view = new DataView(format.buffer);
    view.setUint32(0x30, 40, true);
    view.setInt32(0x34, width, true);
    view.setInt32(0x38, height, true);
    view.setUint16(0x3c, 1, true);
    view.setUint16(0x3e, bits, true);
    view.setUint32(0x40, more.compression ?? 0, true);
    extra.forEach((word, index)=>view.setUint32(0x58 + index * 4, word, true));
    return { major: MEDIATYPE_VIDEO, sub, fixed: true, temporal: false, sampleSize: 0,
        formatType: FORMAT_VIDEO_INFO, format };
};

test('the subtype names the kind, and the header must agree with it', ()=>{
    assert.equal(layoutOf(video(RGB565, 4, 2, 16))?.kind, '565', 'RGB565 over BI_RGB');
    assert.equal(layoutOf(video(RGB565, 4, 2, 16, { compression: 3,
        extra: [0xf800, 0x7e0, 0x1f] }))?.kind, '565', 'and over BI_BITFIELDS');
    assert.equal(layoutOf(video(RGB555, 4, 2, 16))?.kind, '555');
    assert.equal(layoutOf(video(ARGB32, 4, 2, 32))?.kind, '32', 'ARGB32 is drawn as 32-bit');
    assert.equal(layoutOf(video(RGB24, 4, 2, 32)), null, 'a depth the subtype does not have');
    assert.equal(layoutOf(video(RGB24, 4, 2, 24, { compression: 3 })), null,
        'and 24-bit has no masks');
    const layout = layoutOf(video(RGB24, 3, -2, 24));
    assert.deepEqual([layout?.topDown, layout?.height, layout?.stride], [true, 2, 12],
        'a negative height is top-down; a row is padded to four bytes');
});

test('a frame converts between the kinds, through the palette for 8-bit', ()=>{
    const from = /** @type {any} */ (layoutOf(video(RGB8, 2, 1, 8, { extra: [0x00ff0000, 0x000000ff] })));
    const to = /** @type {any} */ (layoutOf(video(RGB24, 2, 1, 24)));
    assert.deepEqual([...convertFrame(new Uint8Array([1, 0, 0, 0]), from, to).subarray(0, 6)],
        [0xff, 0, 0, 0, 0, 0xff], 'index 1 blue, index 0 red, as B, G, R');
    const wide = /** @type {any} */ (layoutOf(video(RGB565, 1, 1, 16)));
    const white = convertFrame(new Uint8Array([0xff, 0xff, 0, 0]), wide,
        /** @type {any} */ (layoutOf(video(ARGB32, 1, 1, 32))));
    assert.deepEqual([...white], [0xff, 0xff, 0xff, 0], 'five and six bits widen to eight');
    const back = convertFrame(new Uint8Array([0x10, 0x20, 0x30, 0]), to,
        /** @type {any} */ (layoutOf(video(RGB555, 1, 1, 16))));
    assert.equal(back[0] | back[1] << 8, (0x30 >>> 3) << 10 | (0x20 >>> 3) << 5 | 0x10 >>> 3);
});

test('a bottom-up frame into a top-down one is turned over', ()=>{
    const from = /** @type {any} */ (layoutOf(video(RGB24, 1, 2, 24)));
    const to = /** @type {any} */ (layoutOf(video(RGB24, 1, -2, 24)));
    const out = convertFrame(new Uint8Array([1, 2, 3, 0, 4, 5, 6, 0]), from, to);
    assert.deepEqual([...out], [4, 5, 6, 0, 1, 2, 3, 0]);
});

test('an output type keeps the input\'s size and order, and RGB565 carries its masks', ()=>{
    const input = video(RGB24, 5, -3, 24);
    const type = rgbType(/** @type {any} */ (layoutOf(input)), '565', input.format);
    const layout = layoutOf(type);
    assert.deepEqual([type.sub, layout?.kind, layout?.width, layout?.height, layout?.topDown],
        [RGB565, '565', 5, 3, true]);
    assert.equal(type.format.length, 0x30 + 40 + 12);
    assert.equal(type.sampleSize, 12 * 3, 'rows of ten bytes padded to twelve');
});
