/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BI_RGB,
    decodeDib,
    encodeDib,
    isConvertibleDib,
    setDIBitsToDevice,
    stretchDIBits,
} from './dib.js';
import { COLORONCOLOR } from './blit.js';
import { clearSurface, createSurface, dibPitch } from './surface.js';

const BACKGROUND = 0x00202020;

/**
 * @param {number} width
 * @param {number} height   Negative for a top-down DIB, exactly as biHeight is.
 * @param {number} bitCount
 */
function header(width, height, bitCount){
    return {
        size: 40,
        width,
        height,
        planes: 1,
        bitCount,
        compression: BI_RGB,
        sizeImage: 0,
        clrUsed: 0,
    };
}

/**
 * Two rows of two 24-bit pixels, in the order they sit in memory. Row zero of
 * the bytes is the *bottom* row of a bottom-up DIB, so the same bytes decode to
 * two different pictures depending only on the sign of the height.
 */
function twoByTwo24(){
    const pitch = dibPitch(2, 24);
    const bits = new Uint8Array(pitch * 2);
    // Stored blue, green, red.
    bits.set([0x00, 0x00, 0xff, 0x00, 0xff, 0x00], 0);
    bits.set([0xff, 0x00, 0x00, 0xff, 0xff, 0xff], pitch);
    return bits;
}

test('the sign of biHeight is the difference between two pictures', ()=>{
    const bits = twoByTwo24();
    const bottomUp = decodeDib({ header: header(2, 2, 24), bits });
    assert.ok(bottomUp);
    assert.equal(bottomUp.read(0, 1), 0x00ff0000, 'row zero of the bytes is the last row');
    assert.equal(bottomUp.read(0, 0), 0x000000ff);

    const topDown = decodeDib({ header: header(2, -2, 24), bits });
    assert.ok(topDown);
    assert.equal(topDown.read(0, 0), 0x00ff0000, 'and here it is the first row');
    assert.equal(topDown.read(0, 1), 0x000000ff);
});

test('a 24-bit row is padded to four bytes and the pad is not a pixel', ()=>{
    // Two 24-bit pixels are six bytes and the row is eight: a decoder that
    // multiplied width by three would read the second row three bytes early and
    // shear the picture.
    const bits = twoByTwo24();
    assert.equal(dibPitch(2, 24), 8);
    const image = decodeDib({ header: header(2, -2, 24), bits });
    assert.ok(image);
    assert.equal(image.read(1, 0), 0x0000ff00);
    assert.equal(image.read(1, 1), 0x00ffffff);
});

test('an eight-bit DIB reads its colours out of the table', ()=>{
    const pitch = dibPitch(3, 8);
    const bits = new Uint8Array(pitch);
    bits.set([2, 0, 1], 0);
    const image = decodeDib({
        header: header(3, -1, 8),
        bits,
        colors: [0x00111111, 0x00222222, 0x00333333],
    });
    assert.ok(image);
    assert.equal(image.read(0, 0), 0x00333333);
    assert.equal(image.read(1, 0), 0x00111111);
    assert.equal(image.read(2, 0), 0x00222222);
});

test('a sixteen-bit DIB widens five-bit channels to full scale', ()=>{
    const bits = new Uint8Array(dibPitch(2, 16));
    // 0x7c00 is red at full five-bit scale; 0x7fff is white.
    bits.set([0x00, 0x7c, 0xff, 0x7f], 0);
    const image = decodeDib({ header: header(2, -1, 16), bits });
    assert.ok(image);
    assert.equal(image.read(0, 0), 0x00ff0000, 'full red must widen to 0xff, not to 0xf8');
    assert.equal(image.read(1, 0), 0x00ffffff);
});

test('a format this layer cannot convert is refused rather than guessed', ()=>{
    assert.equal(isConvertibleDib({ header: header(2, 2, 4), bits: new Uint8Array(16) }), false);
    assert.equal(isConvertibleDib({ header: header(2, 2, 1), bits: new Uint8Array(16) }), false);
    assert.equal(decodeDib({ header: header(2, 2, 4), bits: new Uint8Array(16) }), null);
    assert.equal(isConvertibleDib({ header: header(2, 2, 32), bits: new Uint8Array(32) }), true);
});

test('only the supplied scan lines land, and at the rows they belong to', ()=>{
    const pitch = dibPitch(2, 24);
    const bits = new Uint8Array(pitch);
    bits.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);
    // One row of a four-row bottom-up DIB, starting at DIB row one: that is the
    // second row from the bottom, which is y = 2 of the picture.
    const image = decodeDib({ header: header(2, 4, 24), bits, startScan: 1, scanLines: 1 });
    assert.ok(image);
    assert.equal(image.read(0, 2), 0x00ffffff);
    assert.equal(image.read(0, 3), 0, 'a row nobody supplied stays at zero');
    assert.equal(image.read(0, 0), 0);
});

test('SetDIBitsToDevice takes its source origin from the bottom of a bottom-up DIB', ()=>{
    const bits = twoByTwo24();
    const dest = createSurface({ width: 4, height: 4 });
    clearSurface(dest, BACKGROUND);

    // ySrc = 0 with a height of one names the DIB's own row zero, which for a
    // bottom-up DIB is the picture's *last* row -- here the red and green pair.
    const copied = setDIBitsToDevice({
        dest,
        xDest: 1, yDest: 1, width: 2, height: 1,
        xSrc: 0, ySrc: 0,
        image: { header: header(2, 2, 24), bits },
    });
    assert.equal(copied, 1);
    assert.equal(dest.read(1, 1), 0x00ff0000);
    assert.equal(dest.read(2, 1), 0x0000ff00);
    assert.equal(dest.read(1, 0), BACKGROUND);
});

test('StretchDIBits scales and honours the stretch mode', ()=>{
    const bits = twoByTwo24();
    const dest = createSurface({ width: 4, height: 4 });
    clearSurface(dest, BACKGROUND);

    const copied = stretchDIBits({
        dest,
        xDest: 0, yDest: 0, destWidth: 4, destHeight: 4,
        xSrc: 0, ySrc: 0, srcWidth: 2, srcHeight: 2,
        image: { header: header(2, 2, 24), bits },
        mode: COLORONCOLOR,
    });
    assert.equal(copied, 2);
    // The picture's top row is the DIB's last row of bytes: blue and white.
    assert.equal(dest.read(0, 0), 0x000000ff);
    assert.equal(dest.read(1, 1), 0x000000ff);
    assert.equal(dest.read(2, 0), 0x00ffffff);
    assert.equal(dest.read(0, 2), 0x00ff0000);
    assert.equal(dest.read(3, 3), 0x0000ff00);
});

test('a negative source height in StretchDIBits mirrors what a positive one draws', ()=>{
    const bits = twoByTwo24();
    /** @param {number} srcHeight */
    const draw = srcHeight=>{
        const dest = createSurface({ width: 2, height: 2 });
        clearSurface(dest, BACKGROUND);
        stretchDIBits({
            dest,
            xDest: 0, yDest: 0, destWidth: 2, destHeight: 2,
            xSrc: 0, ySrc: 0, srcWidth: 2, srcHeight,
            image: { header: header(2, 2, 24), bits },
            mode: COLORONCOLOR,
        });
        return [dest.read(0, 0), dest.read(0, 1)];
    };
    assert.deepEqual(draw(2), [0x000000ff, 0x00ff0000]);
    assert.deepEqual(draw(-2), [0x00ff0000, 0x000000ff]);
});

test('GetDIBits writes the surface back out in the caller format', ()=>{
    const surface = createSurface({ width: 2, height: 2 });
    surface.write(0, 0, 0x00ff0000);
    surface.write(1, 0, 0x0000ff00);
    surface.write(0, 1, 0x000000ff);
    surface.write(1, 1, 0x00ffffff);

    const pitch = dibPitch(2, 24);
    const bits = new Uint8Array(pitch * 2);
    assert.equal(encodeDib(surface, { header: header(2, 2, 24), bits }), 2);
    // Bottom-up again: the bytes' first row is the picture's second.
    assert.deepEqual([...bits.subarray(0, 6)], [0xff, 0x00, 0x00, 0xff, 0xff, 0xff]);
    assert.deepEqual([...bits.subarray(pitch, pitch + 6)], [0x00, 0x00, 0xff, 0x00, 0xff, 0x00]);
});

test('a round trip through a DIB changes no pixel', ()=>{
    const surface = createSurface({ width: 3, height: 2 });
    const colours = [0x00010203, 0x00fefdfc, 0x00808080, 0x00000000, 0x00ffffff, 0x00123456];
    for (let index = 0; index < colours.length; index++)
    {
        surface.write(index % 3, Math.floor(index / 3), colours[index]);
    }
    const bits = new Uint8Array(dibPitch(3, 32) * 2);
    encodeDib(surface, { header: header(3, 2, 32), bits });
    const back = decodeDib({ header: header(3, 2, 32), bits });
    assert.ok(back);
    for (let index = 0; index < colours.length; index++)
    {
        assert.equal(back.read(index % 3, Math.floor(index / 3)), colours[index]);
    }
});

test('encoding refuses eight bits rather than inventing a palette', ()=>{
    const surface = createSurface({ width: 2, height: 1 });
    assert.equal(encodeDib(surface, {
        header: header(2, 1, 8),
        bits: new Uint8Array(dibPitch(2, 8)),
    }), 0);
});
