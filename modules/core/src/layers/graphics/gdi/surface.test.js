/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    RGB_555,
    RGB_565,
    clearSurface,
    colorToPixel,
    createSurface,
    ddbPitch,
    dibPitch,
    expand16,
    intersectRect,
    isEmptyRect,
    narrow16,
    pixelToColor,
    surfaceBounds,
    surfaceForDibSection,
    viewOf,
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

test('byte-exact: an eight-bit surface stores the nearest palette index', ()=>{
    // Entries chosen so that a metric on the wrong channels, or one that
    // compares the packed number rather than the colours, picks differently:
    // 0x00ff0000 is numerically nearer 0x00fe0000 than 0x00000010 is, but
    // 0x00200000 is nearer black than red by any colour distance.
    const palette = [0x00000000, 0x00ff0000, 0x0000ff00, 0x000000ff, 0x00fe0000];
    const surface = createSurface({ width: 4, height: 4, bitCount: 8, palette });
    assert.equal(surface.pitch, 4);
    assert.equal(surface.bitCount, 8);

    surface.write(0, 0, 0x00ff0000);
    assert.equal(surface.bytes[0], 1, 'an exact match wins over a nearer neighbour');
    surface.write(1, 0, 0x00200000);
    assert.equal(surface.bytes[1], 0, 'dark red is nearest black');
    surface.write(2, 0, 0x0010ff10);
    assert.equal(surface.bytes[2], 2, 'a green with a little red and blue is still green');
    surface.write(3, 3, 0x000000f0);
    assert.equal(surface.bytes[15], 3);
    // Red with a trace of blue: as far from black as from red on the other
    // two channels, so only a distance that counts red picks the red entry.
    surface.write(0, 1, 0x00ff0010);
    assert.equal(surface.bytes[4], 1);

    assert.equal(surface.read(0, 0), 0x00ff0000);
    assert.equal(surface.read(1, 0), 0, 'and reads back the entry, not what was asked for');
    assert.equal(surface.read(3, 3), 0x000000ff);
    assert.equal(Buffer.from(surface.bytes).toString('base64'), 'AQACAAEAAAAAAAAAAAAAAw==',
        'the whole buffer: row zero, the red at row one, the last corner, zeros elsewhere');

    assert.throws(()=>createSurface({ width: 1, height: 1, bitCount: 8 }), RangeError,
        'eight bits without a palette');
    assert.throws(()=>createSurface({ width: 1, height: 1, bitCount: 24 }), RangeError);
});

test('byte-exact: a sixteen-bit surface narrows and widens with the top bits replicated', ()=>{
    for (const [pixel, packed] of [[0x00ff0000, 0xf800], [0x0000ff00, 0x07e0],
        [0x000000ff, 0x001f], [0x00ffffff, 0xffff]])
    {
        assert.equal(narrow16(pixel, RGB_565), packed);
        assert.equal(expand16(packed, RGB_565), pixel, 'full scale survives the round trip');
    }
    // 0x8410 is 10000 100000 10000: the midpoint of every channel widens to
    // 132, 130, 132, not to 128 -- the top bits are repeated into the low ones.
    assert.equal(expand16(0x8410, RGB_565), 0x00848284);
    assert.equal(narrow16(0x00848284, RGB_565), 0x8410);

    assert.equal(narrow16(0x00ff0000, RGB_555), 0x7c00);
    assert.equal(expand16(0x7c00, RGB_555), 0x00ff0000);
    assert.equal(expand16(0x4210, RGB_555), 0x00848484, 'five bits everywhere at 555');

    const surface = createSurface({ width: 3, height: 1, bitCount: 16, format: RGB_565 });
    assert.equal(surface.pitch, 8, 'six bytes of pixels, padded to a DWORD');
    surface.write(0, 0, 0x00ff0000);
    surface.write(1, 0, 0x00848284);
    surface.write(2, 0, 0x000000ff);
    assert.deepEqual([...surface.bytes], [0x00, 0xf8, 0x10, 0x84, 0x1f, 0x00, 0, 0],
        'little-endian words, the padding untouched');
    assert.equal(surface.read(1, 0), 0x00848284);

    const fifteen = createSurface({ width: 1, height: 1, bitCount: 16 });
    fifteen.write(0, 0, 0x00ff0000);
    assert.deepEqual([...fifteen.bytes], [0x00, 0x7c, 0, 0], '555 unless told otherwise');
});

test('a DIB section at any drawable depth is a surface, and the rest are not', ()=>{
    const memory = new Uint8Array(64);
    const bits = 0x1000;
    assert.equal(dibPitch(10, 8), 12);
    assert.equal(dibPitch(10, 16), 20);

    const eight = surfaceForDibSection(
        { width: 4, height: 2, bitCount: 8, bits, palette: [0, 0x00abcdef], topDown: true },
        memory, bits);
    assert.ok(eight);
    eight.write(1, 1, 0x00abcdef);
    assert.equal(memory[4 + 1], 1, 'row one at the pitch, index one for the second entry');
    assert.equal(surfaceForDibSection({ width: 4, height: 2, bitCount: 8, bits }, memory, bits),
        null, 'eight bits with no palette is not drawable');

    const sixteen = /** @type {any} */ (surfaceForDibSection(
        { width: 2, height: 2, bitCount: 16, bits, format: RGB_565 }, memory, bits));
    assert.ok(sixteen);
    assert.equal(sixteen.format, RGB_565);
    assert.equal(surfaceForDibSection({ width: 2, height: 2, bitCount: 24, bits }, memory, bits),
        null);
    assert.equal(surfaceForDibSection({ width: 2, height: 2, bitCount: 32, bits: 0 }, memory),
        null);
});

test('clearing a surface reaches every pixel including the last', ()=>{
    const surface = createSurface({ width: 5, height: 3 });
    clearSurface(surface, 0x00202020);
    assert.deepEqual(surfaceBounds(surface), { left: 0, top: 0, right: 5, bottom: 3 });
    assert.equal(surface.read(0, 0), 0x00202020);
    assert.equal(surface.read(4, 2), 0x00202020);
});

test('a view draws onto its parent at its own origin and drops what falls outside', ()=>{
    // A window's context is a view over the display: a pixel at the view's
    // origin lands at the client origin on the screen, and a window hanging
    // off the edge draws nothing where there is no screen.
    const screen = createSurface({ width: 6, height: 4 });
    clearSurface(screen, 0);
    const view = viewOf(screen, { left: 4, top: 2, right: 9, bottom: 5 });
    assert.equal(view.width, 5);
    assert.equal(view.height, 3);
    view.write(0, 0, 0x00ff0000);
    view.write(1, 1, 0x0000ff00);
    view.write(4, 2, 0x000000ff);
    assert.equal(screen.read(4, 2), 0x00ff0000);
    assert.equal(screen.read(5, 3), 0x0000ff00);
    assert.equal(view.read(0, 0), 0x00ff0000);
    assert.equal(view.read(4, 2), 0, 'off the screen reads as black');
    assert.equal(view.bytes, screen.bytes, 'the bytes are the parent\'s own');
});
