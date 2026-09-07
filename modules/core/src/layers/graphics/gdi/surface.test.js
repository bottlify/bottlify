/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    clearSurface,
    colorToPixel,
    createSurface,
    ddbPitch,
    dibPitch,
    intersectRect,
    isEmptyRect,
    pixelToColor,
    surfaceBounds,
} from './surface.js';

test('a DIB row is padded to four bytes and a bitmap row to two', ()=>{
    // Three pixels of eight bits is three bytes of content: a DIB rounds that
    // to four and a device-dependent bitmap to four as well, but at 24 bits per
    // pixel the two part company.
    assert.equal(dibPitch(3, 8), 4);
    assert.equal(ddbPitch(3, 8), 4);
    assert.equal(dibPitch(3, 24), 12);
    assert.equal(ddbPitch(3, 24), 10);
    assert.equal(dibPitch(1, 1), 4);
    assert.equal(ddbPitch(1, 1), 2);
    assert.equal(dibPitch(17, 32), 68);
});

test('a red pixel and a red COLORREF are not the same number', ()=>{
    const red = 0x000000ff;
    assert.equal(colorToPixel(red), 0x00ff0000);
    assert.equal(pixelToColor(colorToPixel(red)), red);
    assert.equal(colorToPixel(0x00123456), 0x00563412);
});

test('a row lands where the pitch says, not where the width does', ()=>{
    // A pitch wider than the pixels is the case that catches a loop indexing by
    // width: the second row starts at byte 24, not at byte 12.
    const surface = createSurface({ width: 3, height: 2, pitch: 24 });
    surface.write(0, 1, 0x00abcdef);
    const bytes = surface.bytes;
    assert.equal(bytes[24], 0xef);
    assert.equal(bytes[25], 0xcd);
    assert.equal(bytes[26], 0xab);
    assert.equal(bytes[12], 0, 'nothing may be written in the padding of row zero');
    assert.equal(surface.read(0, 1), 0x00abcdef);
});

test('a bottom-up surface reverses rows and nothing else', ()=>{
    const bytes = new Uint8Array(dibPitch(2, 32) * 2);
    const up = createSurface({ width: 2, height: 2, bytes, topDown: false });
    up.write(1, 0, 0x00112233);
    // Drawing coordinates always have their origin top-left, so y = 0 is the
    // top row of the picture and the last row of the memory.
    assert.equal(bytes[dibPitch(2, 32) + 4], 0x33);
    assert.equal(up.read(1, 0), 0x00112233);
    assert.equal(up.read(1, 1), 0);

    const down = createSurface({ width: 2, height: 2, bytes: new Uint8Array(bytes.length) });
    down.write(1, 0, 0x00112233);
    assert.equal(down.bytes[4], 0x33);
});

test('an unaligned surface reads back exactly what it wrote', ()=>{
    // A byte offset of one makes the 32-bit fast path illegal; the fallback has
    // to agree with it pixel for pixel or the seam only appears on odd strides.
    const bytes = new Uint8Array(1 + (12 * 2));
    const surface = createSurface({ width: 3, height: 2, pitch: 12, bytes, offset: 1 });
    surface.write(2, 1, 0x00fedcba);
    assert.equal(surface.read(2, 1), 0x00fedcba);
    assert.equal(bytes[0], 0, 'the byte before the surface stays untouched');
    assert.equal(bytes[1 + 12 + 8], 0xba);
});

test('a surface refuses memory too small for its rows', ()=>{
    assert.throws(()=>createSurface({
        width: 4, height: 4, bytes: new Uint8Array(16),
    }), RangeError);
    assert.throws(()=>createSurface({ width: 0, height: 4 }), RangeError);
});

test('rectangles intersect and report emptiness the half-open way', ()=>{
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    const b = { left: 5, top: 5, right: 20, bottom: 6 };
    assert.deepEqual(intersectRect(a, b), { left: 5, top: 5, right: 10, bottom: 6 });
    assert.equal(isEmptyRect(intersectRect(a, { left: 10, top: 0, right: 20, bottom: 10 })), true);
    assert.equal(isEmptyRect({ left: 0, top: 0, right: 1, bottom: 1 }), false);
});

test('clearing a surface reaches every pixel including the last', ()=>{
    const surface = createSurface({ width: 5, height: 3 });
    clearSurface(surface, 0x00202020);
    assert.deepEqual(surfaceBounds(surface), { left: 0, top: 0, right: 5, bottom: 3 });
    assert.equal(surface.read(0, 0), 0x00202020);
    assert.equal(surface.read(4, 2), 0x00202020);
});
