/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BI_BITFIELDS,
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

test('a BI_BITFIELDS DIB is read by its masks, so 5-6-5 is not 5-5-5', ()=>{
    const bits = new Uint8Array(dibPitch(3, 16));
    // Full green and full red in 5-6-5; read as 5-5-5, the first would carry
    // a sliver of red and the second would lose its top bit to nothing.
    bits.set([0xe0, 0x07, 0x00, 0xf8, 0xff, 0xff], 0);
    const image = decodeDib({
        header: { ...header(3, -1, 16), compression: BI_BITFIELDS },
        bits,
        masks: [0xf800, 0x07e0, 0x001f],
    });
    assert.ok(image);
    assert.deepEqual([image.read(0, 0), image.read(1, 0), image.read(2, 0)],
        [0x0000ff00, 0x00ff0000, 0x00ffffff]);

    // The masks say which bits are which channel, whatever they are.
    const swapped = new Uint8Array([0xff, 0x00, 0x00, 0x00]);
    const blueFirst = decodeDib({
        header: { ...header(1, -1, 32), compression: BI_BITFIELDS },
        bits: swapped,
        masks: [0x000000ff, 0x0000ff00, 0x00ff0000],
    });
    assert.equal(blueFirst?.read(0, 0), 0x00ff0000, 'the low byte is red under these masks');
    assert.equal(isConvertibleDib({
        header: { ...header(1, 1, 24), compression: BI_BITFIELDS }, bits: new Uint8Array(4),
    }), false, 'masks describe sixteen and thirty-two bits only');
});

test('one- and four-bit DIBs index their table, the leftmost pixel in the top bits', ()=>{
    const colors = [0x00111111, 0x00222222, 0x00333333];
    const one = decodeDib({ header: header(10, -1, 1), bits: new Uint8Array([0b01000000, 0x40]),
        colors });
    assert.ok(one);
    assert.deepEqual([one.read(0, 0), one.read(1, 0), one.read(9, 0)],
        [0x00111111, 0x00222222, 0x00222222]);

    const four = decodeDib({ header: header(3, -1, 4), bits: new Uint8Array([0x21, 0x00]),
        colors });
    assert.ok(four);
    assert.deepEqual([four.read(0, 0), four.read(1, 0), four.read(2, 0)],
        [0x00333333, 0x00222222, 0x00111111]);
});

test('an indexed DIB is written against the table it is given, and not without one', ()=>{
    const surface = createSurface({ width: 3, height: 1 });
    surface.write(0, 0, 0x00ffffff);
    surface.write(1, 0, 0x00101010);
    surface.write(2, 0, 0x00f0f0f0);
    const colors = [0x00000000, 0x00ffffff];

    const one = new Uint8Array(4);
    assert.equal(encodeDib(surface, { header: header(3, 1, 1), bits: one, colors }), 1);
    assert.equal(one[0], 0b10100000, 'white, nearest black, nearest white');

    const four = new Uint8Array(4);
    assert.equal(encodeDib(surface, { header: header(3, 1, 4), bits: four,
        colors: [0, 0x00101010, 0x00ffffff] }), 1);
    assert.deepEqual([...four.subarray(0, 2)], [0x21, 0x20]);

    const eight = new Uint8Array(4);
    assert.equal(encodeDib(surface, { header: header(3, 1, 8), bits: eight, colors }), 1);
    assert.deepEqual([...eight.subarray(0, 3)], [1, 0, 1]);
    assert.equal(encodeDib(surface, { header: header(3, 1, 8), bits: eight }), 0,
        'choosing a palette is the caller\'s, never the encoder\'s');
});

test('a format this layer cannot convert is refused rather than guessed', ()=>{
    assert.equal(isConvertibleDib({ header: header(2, 2, 2), bits: new Uint8Array(16) }), false);
    assert.equal(isConvertibleDib({ header: { ...header(2, 2, 4), compression: 1 },
        bits: new Uint8Array(16) }), false, 'RLE8 encodes eight bits and nothing else');
    assert.equal(isConvertibleDib({ header: { ...header(2, -2, 8), compression: 1 },
        bits: new Uint8Array(16) }), false, 'nor is it ever top-down');
    assert.equal(isConvertibleDib({ header: { ...header(2, 2, 8), compression: 1 },
        bits: new Uint8Array(16) }), true);
    assert.equal(decodeDib({ header: header(2, 2, 2), bits: new Uint8Array(16) }), null);
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

test('StretchDIBits into a clip its rectangle misses reads no bits and answers as if drawn', ()=>{
    const bits = twoByTwo24();
    let reads = 0;
    /** @param {import('./contract.js').Rect} clip @param {number} rop */
    const draw = (clip, rop)=>{
        const dest = createSurface({ width: 8, height: 8 });
        clearSurface(dest, BACKGROUND);
        const answer = stretchDIBits({
            dest,
            clip,
            xDest: 0, yDest: 0, destWidth: 4, destHeight: 4,
            xSrc: 0, ySrc: 0, srcWidth: 2, srcHeight: 2,
            image: {
                header: header(2, -2, 24),
                get bits(){
                    reads++;
                    return bits;
                },
            },
            rop,
        });
        return { answer, dest };
    };
    const missed = { left: 4, top: 4, right: 8, bottom: 8 };
    const met = { left: 0, top: 0, right: 8, bottom: 8 };
    // A stretch answers the DIB's height, signed as in the header under an
    // operation other than SRCCOPY -- the same whether or not it drew.
    for (const rop of [0x00cc0020, 0x008800c6])
    {
        reads = 0;
        const outside = draw(missed, rop);
        assert.equal(reads, 0, 'nothing of the picture is read');
        assert.equal(outside.dest.read(0, 0), BACKGROUND);
        assert.equal(outside.answer, draw(met, rop).answer);
        assert.ok(reads > 0, 'and the same call into a clip it meets reads it');
    }
});

test('a negative source height in StretchDIBits mirrors the rows below ySrc', ()=>{
    // As a negative extent runs everywhere in GDI: ySrc 2 and a height of -2
    // are the same two rows as ySrc 0 and 2, upside down; ySrc 0 and -2 lie
    // before the DIB, which draws nothing.
    const bits = twoByTwo24();
    /** @param {number} ySrc @param {number} srcHeight */
    const draw = (ySrc, srcHeight)=>{
        const dest = createSurface({ width: 2, height: 2 });
        clearSurface(dest, BACKGROUND);
        stretchDIBits({
            dest,
            xDest: 0, yDest: 0, destWidth: 2, destHeight: 2,
            xSrc: 0, ySrc, srcWidth: 2, srcHeight,
            image: { header: header(2, 2, 24), bits },
            mode: COLORONCOLOR,
        });
        return [dest.read(0, 0), dest.read(0, 1)];
    };
    assert.deepEqual(draw(0, 2), [0x000000ff, 0x00ff0000]);
    assert.deepEqual(draw(2, -2), [0x00ff0000, 0x000000ff]);
    assert.deepEqual(draw(0, -2), [BACKGROUND, BACKGROUND]);
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
