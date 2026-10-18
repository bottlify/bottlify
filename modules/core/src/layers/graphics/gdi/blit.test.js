/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BLACKONWHITE,
    COLORONCOLOR,
    HALFTONE,
    WHITEONBLACK,
    alphaBlend,
    bitBlt,
    blendPixel,
    patBlt,
    sourceConversion,
    stretchBlt,
    transparentBlt,
} from './blit.js';
import { BLACKNESS, DSTINVERT, PATCOPY, SRCCOPY, SRCINVERT, WHITENESS } from './rop.js';
import { MONOCHROME, clearSurface, createSurface, viewOf } from './surface.js';

const BACKGROUND = 0x00202020;
const RED = 0x00ff0000;
const GREEN = 0x0000ff00;
const BLUE = 0x000000ff;

/** @param {number} width @param {number} height @param {number} fill */
function surfaceFilled(width, height, fill){
    const surface = createSurface({ width, height });
    clearSurface(surface, fill);
    return surface;
}

/** @param {number} pixel */
const solid = pixel=>()=>pixel;

test('SRCCOPY moves the source rectangle to the named destination corner', ()=>{
    const dest = surfaceFilled(8, 8, BACKGROUND);
    const src = surfaceFilled(8, 8, 0);
    src.write(1, 1, RED);
    src.write(2, 1, GREEN);

    assert.equal(bitBlt({ dest, x: 4, y: 5, width: 3, height: 2, src, srcX: 1, srcY: 1,
        rop: SRCCOPY }), true);
    assert.equal(dest.read(4, 5), RED);
    assert.equal(dest.read(5, 5), GREEN);
    assert.equal(dest.read(6, 5), 0, 'the third column came from the zeroed source');
    assert.equal(dest.read(3, 5), BACKGROUND, 'one pixel left of the rectangle is untouched');
    assert.equal(dest.read(4, 4), BACKGROUND, 'one row above the rectangle is untouched');
    assert.equal(dest.read(4, 7), BACKGROUND, 'the trailing row is outside the rectangle');
});

test('clipping moves the source with the destination', ()=>{
    // The defect this catches slides the image by the width of the clipped
    // strip: the destination is cut back to x = 2 but the source keeps reading
    // from its original column.
    const dest = surfaceFilled(8, 8, BACKGROUND);
    const src = surfaceFilled(8, 8, 0);
    for (let x = 0; x < 8; x++)
    {
        src.write(x, 0, 0x00000010 + x);
    }

    bitBlt({
        dest,
        clip: { left: 2, top: 0, right: 6, bottom: 8 },
        x: 0, y: 0, width: 8, height: 1,
        src, srcX: 0, srcY: 0,
        rop: SRCCOPY,
    });
    assert.equal(dest.read(1, 0), BACKGROUND, 'outside the clip on the left');
    assert.equal(dest.read(2, 0), 0x00000012, 'the pixel that belongs at x = 2, not at x = 0');
    assert.equal(dest.read(5, 0), 0x00000015);
    assert.equal(dest.read(6, 0), BACKGROUND, 'outside the clip on the right');
});

test('a source read outside the source surface writes nothing', ()=>{
    const dest = surfaceFilled(8, 8, BACKGROUND);
    const src = surfaceFilled(4, 4, RED);
    bitBlt({ dest, x: 0, y: 0, width: 8, height: 8, src, srcX: 0, srcY: 0, rop: SRCCOPY });
    assert.equal(dest.read(3, 3), RED);
    assert.equal(dest.read(4, 3), BACKGROUND);
    assert.equal(dest.read(3, 4), BACKGROUND);
});

test('a negative extent fails and a zero extent succeeds without drawing', ()=>{
    const dest = surfaceFilled(4, 4, BACKGROUND);
    const src = surfaceFilled(4, 4, RED);
    assert.equal(bitBlt({ dest, x: 0, y: 0, width: -2, height: 2, src, srcX: 0, srcY: 0,
        rop: SRCCOPY }), false);
    assert.equal(bitBlt({ dest, x: 0, y: 0, width: 2, height: -2, src, srcX: 0, srcY: 0,
        rop: SRCCOPY }), false);
    assert.equal(bitBlt({ dest, x: 0, y: 0, width: 0, height: 2, src, srcX: 0, srcY: 0,
        rop: SRCCOPY }), true);
    assert.equal(dest.read(0, 0), BACKGROUND);
});

test('an overlapping copy inside one surface behaves as a move, not a smear', ()=>{
    // Copying a run two pixels to the right in the same memory: a forward loop
    // would read a pixel it had already overwritten and stripe the whole row
    // with the first value.
    const surface = surfaceFilled(8, 1, 0);
    surface.write(0, 0, 0x00000001);
    surface.write(1, 0, 0x00000002);
    surface.write(2, 0, 0x00000003);
    surface.write(3, 0, 0x00000004);

    bitBlt({ dest: surface, x: 2, y: 0, width: 4, height: 1, src: surface, srcX: 0, srcY: 0,
        rop: SRCCOPY });
    assert.equal(surface.read(2, 0), 0x00000001);
    assert.equal(surface.read(3, 0), 0x00000002);
    assert.equal(surface.read(4, 0), 0x00000003);
    assert.equal(surface.read(5, 0), 0x00000004);
});

test('an overlapping copy the other way round is also a move', ()=>{
    const surface = surfaceFilled(8, 1, 0);
    surface.write(4, 0, 0x00000001);
    surface.write(5, 0, 0x00000002);
    surface.write(6, 0, 0x00000003);

    bitBlt({ dest: surface, x: 2, y: 0, width: 4, height: 1, src: surface, srcX: 4, srcY: 0,
        rop: SRCCOPY });
    assert.equal(surface.read(2, 0), 0x00000001);
    assert.equal(surface.read(3, 0), 0x00000002);
    assert.equal(surface.read(4, 0), 0x00000003);
});

test('an overlapping copy that moves rows down does not repeat one row', ()=>{
    const surface = surfaceFilled(2, 6, 0);
    surface.write(0, 0, 0x00000001);
    surface.write(0, 1, 0x00000002);
    surface.write(0, 2, 0x00000003);

    bitBlt({ dest: surface, x: 0, y: 2, width: 2, height: 3, src: surface, srcX: 0, srcY: 0,
        rop: SRCCOPY });
    assert.equal(surface.read(0, 2), 0x00000001);
    assert.equal(surface.read(0, 3), 0x00000002);
    assert.equal(surface.read(0, 4), 0x00000003);
});

test('BLACKNESS and WHITENESS ignore both operands', ()=>{
    const dest = surfaceFilled(2, 2, RED);
    assert.equal(bitBlt({ dest, x: 0, y: 0, width: 2, height: 1, rop: BLACKNESS }), true);
    assert.equal(dest.read(0, 0), 0);
    bitBlt({ dest, x: 0, y: 1, width: 2, height: 1, rop: WHITENESS });
    assert.equal(dest.read(0, 1), 0xffffffff);
});

test('PatBlt refuses an operation that needs a source', ()=>{
    const dest = surfaceFilled(2, 2, RED);
    assert.equal(patBlt({ dest, x: 0, y: 0, width: 2, height: 2, rop: SRCCOPY }), false);
    assert.equal(dest.read(0, 0), RED, 'a refused operation draws nothing');
    assert.equal(patBlt({ dest, x: 0, y: 0, width: 1, height: 1, rop: PATCOPY,
        pattern: solid(BLUE) }), true);
    assert.equal(dest.read(0, 0), BLUE);
});

test('DSTINVERT inverts the whole pixel, unused byte included', ()=>{
    const dest = surfaceFilled(1, 1, 0x00000000);
    patBlt({ dest, x: 0, y: 0, width: 1, height: 1, rop: DSTINVERT });
    assert.equal(dest.read(0, 0), 0xffffffff);
});

test('SRCINVERT combines the two operands rather than replacing one', ()=>{
    const dest = surfaceFilled(1, 1, 0x00ff00ff);
    const src = surfaceFilled(1, 1, 0x0000ffff);
    bitBlt({ dest, x: 0, y: 0, width: 1, height: 1, src, srcX: 0, srcY: 0, rop: SRCINVERT });
    assert.equal(dest.read(0, 0), 0x00ffff00);
});

test('a magnified stretch replicates and a shrunk one reaches the far corner', ()=>{
    const src = surfaceFilled(2, 2, 0);
    src.write(0, 0, RED);
    src.write(1, 0, GREEN);
    src.write(0, 1, BLUE);
    src.write(1, 1, 0x00ffffff);
    const dest = surfaceFilled(4, 4, BACKGROUND);

    stretchBlt({ dest, x: 0, y: 0, width: 4, height: 4, src,
        srcX: 0, srcY: 0, srcWidth: 2, srcHeight: 2, rop: SRCCOPY, mode: COLORONCOLOR });
    assert.equal(dest.read(0, 0), RED);
    assert.equal(dest.read(1, 0), RED);
    assert.equal(dest.read(2, 0), GREEN);
    assert.equal(dest.read(3, 3), 0x00ffffff);
    assert.equal(dest.read(0, 2), BLUE);
});

test('a negative destination width mirrors horizontally', ()=>{
    const src = surfaceFilled(2, 1, 0);
    src.write(0, 0, RED);
    src.write(1, 0, GREEN);
    const dest = surfaceFilled(4, 1, BACKGROUND);

    // The rectangle runs from x = 2 leftwards, so it covers columns 0 and 1 and
    // the source is reversed across them.
    stretchBlt({ dest, x: 2, y: 0, width: -2, height: 1, src,
        srcX: 0, srcY: 0, srcWidth: 2, srcHeight: 1, rop: SRCCOPY, mode: COLORONCOLOR });
    assert.equal(dest.read(0, 0), GREEN);
    assert.equal(dest.read(1, 0), RED);
    assert.equal(dest.read(2, 0), BACKGROUND);
});

test('two negative extents cancel and leave the picture the right way round', ()=>{
    const src = surfaceFilled(2, 1, 0);
    src.write(0, 0, RED);
    src.write(1, 0, GREEN);
    const dest = surfaceFilled(4, 1, BACKGROUND);

    stretchBlt({ dest, x: 2, y: 0, width: -2, height: 1, src,
        srcX: 2, srcY: 0, srcWidth: -2, srcHeight: 1, rop: SRCCOPY, mode: COLORONCOLOR });
    assert.equal(dest.read(0, 0), RED);
    assert.equal(dest.read(1, 0), GREEN);
});

test('a negative destination height mirrors vertically', ()=>{
    const src = surfaceFilled(1, 2, 0);
    src.write(0, 0, RED);
    src.write(0, 1, GREEN);
    const dest = surfaceFilled(1, 4, BACKGROUND);

    stretchBlt({ dest, x: 0, y: 2, width: 1, height: -2, src,
        srcX: 0, srcY: 0, srcWidth: 1, srcHeight: 2, rop: SRCCOPY, mode: COLORONCOLOR });
    assert.equal(dest.read(0, 0), GREEN);
    assert.equal(dest.read(0, 1), RED);
});

test('the four stretch modes disagree about the pixels they drop', ()=>{
    // Four source pixels shrink to one. The mode is the whole difference, and a
    // program that picks the wrong one gets a visibly different picture.
    /** @param {number} mode */
    const shrink = mode=>{
        const src = surfaceFilled(2, 2, 0);
        src.write(0, 0, 0x00ff0000);
        src.write(1, 0, 0x0000ff00);
        src.write(0, 1, 0x000000ff);
        src.write(1, 1, 0x00000000);
        const dest = surfaceFilled(1, 1, BACKGROUND);
        stretchBlt({ dest, x: 0, y: 0, width: 1, height: 1, src,
            srcX: 0, srcY: 0, srcWidth: 2, srcHeight: 2, rop: SRCCOPY, mode });
        return dest.read(0, 0);
    };

    assert.equal(shrink(COLORONCOLOR), 0x00ff0000, 'the survivor is the box top-left');
    assert.equal(shrink(BLACKONWHITE), 0x00000000, 'ANDing four disjoint channels');
    assert.equal(shrink(WHITEONBLACK), 0x00ffffff, 'ORing them');
    // (255 + 0 + 0 + 0) / 4 rounds to 64 in each channel that had one full value.
    assert.equal(shrink(HALFTONE), 0x00404040);
});

test('a stretch inside one surface reads the pixels it started with', ()=>{
    const surface = surfaceFilled(4, 1, 0);
    surface.write(0, 0, RED);
    surface.write(1, 0, GREEN);

    stretchBlt({ dest: surface, x: 0, y: 0, width: 4, height: 1, src: surface,
        srcX: 0, srcY: 0, srcWidth: 2, srcHeight: 1, rop: SRCCOPY, mode: COLORONCOLOR });
    assert.equal(surface.read(0, 0), RED);
    assert.equal(surface.read(1, 0), RED);
    assert.equal(surface.read(2, 0), GREEN, 'not the RED this very blit had just written');
    assert.equal(surface.read(3, 0), GREEN);
});

test('a stretch whose source is entirely outside the surface fails', ()=>{
    // Unlike BitBlt, where an out-of-range source is a rectangle that partly
    // misses, a stretch has to know its source extent before it can scale: a
    // rectangle with nothing in it is a parameter error, not an empty copy.
    const dest = surfaceFilled(4, 4, BACKGROUND);
    const src = surfaceFilled(4, 4, RED);
    assert.equal(stretchBlt({ dest, x: 0, y: 0, width: 4, height: 4, src,
        srcX: 8, srcY: 0, srcWidth: 4, srcHeight: 4, rop: SRCCOPY }), false);
    assert.equal(dest.read(0, 0), BACKGROUND);
    assert.equal(stretchBlt({ dest, x: 0, y: 0, width: 4, height: 4, src,
        srcX: 0, srcY: 0, srcWidth: 0, srcHeight: 4, rop: SRCCOPY }), true,
    'a zero-sized source draws nothing and reports no failure');
});

test('a stretch clipped on the destination keeps its scale', ()=>{
    const src = surfaceFilled(2, 1, 0);
    src.write(0, 0, RED);
    src.write(1, 0, GREEN);
    const dest = surfaceFilled(8, 1, BACKGROUND);

    stretchBlt({
        dest,
        clip: { left: 4, top: 0, right: 8, bottom: 1 },
        x: 0, y: 0, width: 8, height: 1,
        src, srcX: 0, srcY: 0, srcWidth: 2, srcHeight: 1,
        rop: SRCCOPY, mode: COLORONCOLOR,
    });
    assert.equal(dest.read(3, 0), BACKGROUND);
    assert.equal(dest.read(4, 0), GREEN, 'the second half of a doubled two-pixel source');
    assert.equal(dest.read(7, 0), GREEN);
});

/** A monochrome device bitmap: one bit a pixel, black and white. */
function monochrome(/** @type {number} */ width, /** @type {number} */ height){
    return createSurface({ width, height, bitCount: 1, palette: [...MONOCHROME], mono: true });
}

test('a monochrome source takes the destination\'s text and background colours', ()=>{
    // Wine's bitmap.c: a 0 bit becomes the destination DC's text colour and a
    // 1 bit its background colour, whatever black and white would have been.
    const src = monochrome(4, 1);
    src.write(1, 0, 0x00ffffff);
    src.write(2, 0, 0x00ffffff);
    const dest = surfaceFilled(4, 1, BACKGROUND);
    const convert = sourceConversion({ src, dest, textColor: 0x00664422, bkColor: 0x00214365,
        srcBkColor: 0 });
    assert.ok(convert);
    bitBlt({ dest, x: 0, y: 0, width: 4, height: 1, src, rop: SRCCOPY, convert });
    assert.deepEqual([0, 1, 2, 3].map(x=>dest.read(x, 0)),
        [0x00224466, 0x00654321, 0x00654321, 0x00224466]);

    const stretched = surfaceFilled(8, 1, BACKGROUND);
    stretchBlt({ dest: stretched, x: 0, y: 0, width: 8, height: 1, src, srcX: 0, srcY: 0,
        srcWidth: 4, srcHeight: 1, rop: SRCCOPY, convert });
    assert.equal(stretched.read(2, 0), 0x00654321, 'a stretch converts the same way');
});

test('a colour source is 1 in a monochrome destination exactly where it is its background', ()=>{
    const dest = monochrome(3, 1);
    const src = surfaceFilled(3, 1, 0x00ffffff);
    // The raw pixel is compared, unused byte included, as Wine's test of a
    // 0x0fffffff pixel against a white background shows.
    src.write(1, 0, 0x0fffffff);
    src.write(2, 0, 0x00fefefe);
    const convert = sourceConversion({ src, dest, textColor: 0, bkColor: 0,
        srcBkColor: 0x00ffffff });
    bitBlt({ dest, x: 0, y: 0, width: 3, height: 1, src, rop: SRCCOPY, convert });
    assert.deepEqual([0, 1, 2].map(x=>dest.read(x, 0)), [0x00ffffff, 0, 0]);
    assert.equal(dest.bytes[0], 0x80);
});

test('an indexed source matches its background by the table entry nearest it', ()=>{
    // Wine's test_bitmap_colors: a one-bit DIB section onto a monochrome
    // bitmap keeps its bits where the background is nearest entry 1 and
    // inverts them where it is nearest entry 0.
    const src = createSurface({ width: 8, height: 1, bitCount: 1,
        palette: [0x00ffffff, 0x00200000] });
    src.bytes[0] = 0x55;
    for (const [background, expected] of [[0, 0x55], [0x00f0f0f0, 0xaa]])
    {
        const dest = monochrome(8, 1);
        bitBlt({ dest, x: 0, y: 0, width: 8, height: 1, src, rop: SRCCOPY,
            convert: sourceConversion({ src, dest, textColor: 0, bkColor: 0,
                srcBkColor: background }) });
        assert.equal(dest.bytes[0], expected);
    }
});

test('between two monochrome bitmaps, and between two colour ones, the bits are the bits', ()=>{
    const a = monochrome(8, 1);
    const b = monochrome(8, 1);
    assert.equal(sourceConversion({ src: a, dest: b, textColor: 0x00ff, bkColor: 0xff00,
        srcBkColor: 0 }), null);
    const indexed = createSurface({ width: 8, height: 1, bitCount: 1, palette: [0, 0xffffff] });
    assert.equal(sourceConversion({ src: indexed, dest: surfaceFilled(1, 1, 0), textColor: 0x00ff,
        bkColor: 0xff00, srcBkColor: 0 }), null, 'a one-bit DIB reads through its own table');
});

// --- MaskBlt: two operations, chosen by a mask ---

/**
 * MAKEROP4: the background operation's table in the high byte.
 *
 * @param {number} fore @param {number} back
 */
const makeRop4 = (fore, back)=>(((back << 8) & 0xff000000) | fore) >>> 0;

/** The destination left as it is, as a ROP3. */
const DSTCOPY = 0x00aa0029;

test('a mask picks the foreground operation where it is set and the background one elsewhere',
    ()=>{
        const dest = surfaceFilled(4, 1, BACKGROUND);
        const src = surfaceFilled(4, 1, RED);
        /** @param {number} x */
        const mask = x=>x === 1 || x === 2;
        assert.equal(bitBlt({ dest, x: 0, y: 0, width: 4, height: 1, src, rop: makeRop4(SRCCOPY,
            DSTCOPY), mask }), true);
        assert.deepEqual([0, 1, 2, 3].map(x=>dest.read(x, 0)), [BACKGROUND, RED, RED, BACKGROUND]);

        // SRCCOPY alone in a MaskBlt has BLACKNESS, table zero, in its high byte.
        const plain = surfaceFilled(4, 1, BACKGROUND);
        bitBlt({ dest: plain, x: 0, y: 0, width: 4, height: 1, src, rop: SRCCOPY, mask });
        assert.deepEqual([0, 1, 2, 3].map(x=>plain.read(x, 0)), [0, RED, RED, 0]);

        // The background operation is the one that reads the source here,
        // and a blit without one cannot do it.
        assert.equal(bitBlt({ dest, x: 0, y: 0, width: 4, height: 1,
            rop: makeRop4(PATCOPY, SRCCOPY), pattern: solid(GREEN), mask }), false);
        assert.equal(bitBlt({ dest, x: 0, y: 0, width: 4, height: 1,
            rop: makeRop4(PATCOPY, DSTCOPY), pattern: solid(GREEN), mask }), true,
        'neither reads a source, so none is needed');
        assert.deepEqual([0, 1, 2, 3].map(x=>dest.read(x, 0)), [BACKGROUND, GREEN, GREEN,
            BACKGROUND]);
    });

// --- AlphaBlend ---

test('a blended pixel is MSDN\'s sum with the rounding Windows answers with', ()=>{
    // Wine's test_32bit_ddb: 0x40201008 over 0x80808080 at a constant 128.
    assert.equal(blendPixel(0x40201008, 0x80808080, 128, false), 0x60504844);
    assert.equal(blendPixel(0x40201008, 0x80808080, 128, true), 0x90807874,
        'premultiplied, every byte of the source scaled first, its alpha too');
    assert.equal(blendPixel(0x12345678, 0x9abcdef0, 255, false), 0x12345678, 'opaque is a copy');
    assert.equal(blendPixel(0x12345678, 0x9abcdef0, 0, false), 0x9abcdef0, 'clear leaves it');
    assert.equal(blendPixel(0xff102030, 0x00ffffff, 255, true), 0xff102030,
        'a source pixel of full alpha covers what is under it');
    assert.equal(blendPixel(0x00000000, 0x00405060, 255, true), 0x00405060,
        'one of none leaves it');
    assert.equal(blendPixel(0x80ffffff, 0x00ffffff, 255, true), 0x80ffffff,
        'a source that was not premultiplied saturates rather than wrapping');
});

test('AlphaBlend stretches as StretchBlt does, one source pixel to each it covers', ()=>{
    const src = surfaceFilled(2, 1, 0);
    src.write(0, 0, RED);
    src.write(1, 0, BLUE);
    const dest = surfaceFilled(4, 2, 0x00ffffff);
    assert.equal(alphaBlend({ dest, x: 0, y: 0, width: 4, height: 2, src, srcX: 0, srcY: 0,
        srcWidth: 2, srcHeight: 1, constantAlpha: 255 }), true);
    assert.deepEqual([0, 1, 2, 3].map(x=>dest.read(x, 1)), [RED, RED, BLUE, BLUE]);

    const mirrored = surfaceFilled(2, 1, 0);
    alphaBlend({ dest: mirrored, x: 2, y: 0, width: -2, height: 1, src, srcX: 0, srcY: 0,
        srcWidth: 2, srcHeight: 1, constantAlpha: 255 });
    assert.deepEqual([0, 1].map(x=>mirrored.read(x, 0)), [BLUE, RED], 'a flipped extent mirrors');

    const half = surfaceFilled(2, 1, 0);
    alphaBlend({ dest: half, clip: { left: 1, top: 0, right: 2, bottom: 1 }, x: 0, y: 0,
        width: 2, height: 1, src, srcX: 0, srcY: 0, srcWidth: 2, srcHeight: 1,
        constantAlpha: 128 });
    assert.deepEqual([0, 1].map(x=>half.read(x, 0)), [0, 0x00000080],
        'clipped, and blended where it lands');
});

// --- TransparentBlt ---

test('TransparentBlt leaves the key out by its colour alone, one source pixel per pixel', ()=>{
    const src = surfaceFilled(2, 1, 0);
    src.write(0, 0, 0xff00ff00);
    src.write(1, 0, RED);
    const dest = surfaceFilled(4, 1, BACKGROUND);
    assert.equal(transparentBlt({ dest, x: 0, y: 0, width: 4, height: 1, src, srcX: 0, srcY: 0,
        srcWidth: 2, srcHeight: 1, key: GREEN }), true);
    assert.deepEqual([0, 1, 2, 3].map(x=>dest.read(x, 0)), [BACKGROUND, BACKGROUND, RED, RED],
        'the green left out whatever its unused byte holds');

    const shrunk = surfaceFilled(1, 1, BACKGROUND);
    transparentBlt({ dest: shrunk, x: 0, y: 0, width: 1, height: 1, src, srcX: 0, srcY: 0,
        srcWidth: 2, srcHeight: 1, key: GREEN });
    assert.equal(shrunk.read(0, 0), BACKGROUND, 'shrunk, the first pixel of the box decides');
});

/**
 * The operations a source is combined by that take no pattern: copy, the
 * AND and OR a transparent picture is drawn with, XOR, and the rest.
 */
const SOURCE_OPERATIONS = [SRCCOPY, 0x00ee0086, 0x008800c6, 0x00660046, 0x00440328, 0x00330008,
    0x001100a6, 0x00bb0226];

/** A seeded generator, so a gate's failure names a round that comes again. @param {number} seed */
function seeded(seed){
    let state = seed;
    return (/** @type {number} */ below)=>{
        state = (state * 1103515245 + 12345) >>> 0;
        return (state >>> 8) % below;
    };
}

/**
 * A surface of any depth GDI keeps, filled at random, in either row order.
 *
 * @param {(below: number) => number} random
 * @param {number} width @param {number} height
 */
function anyDepth(random, width, height){
    const bitCount = [1, 4, 8, 16, 16, 24, 32, 32][random(8)];
    const palette = bitCount <= 8
        ? Array.from({ length: 1 << bitCount }, ()=>random(0x1000000) >>> 0) : undefined;
    const masked = bitCount === 32 && random(2) === 0;
    const surface = createSurface({ width, height, bitCount, palette, topDown: random(2) === 0,
        format: bitCount === 16 && random(2) === 0 ? '565' : undefined,
        masks: masked ? [0xff, 0xff00, 0xff0000] : undefined });
    for (let i = 0; i < surface.bytes.length; i++)
    {
        surface.bytes[i] = random(256);
    }
    return surface;
}

test('a row read out of a surface of any depth is its pixels as each is read', ()=>{
    const random = seeded(5);
    for (let round = 0; round < 200; round++)
    {
        const surface = anyDepth(random, 1 + random(40), 1 + random(6));
        const y = random(surface.height);
        const x = random(surface.width);
        const count = random(surface.width - x + 1);
        const row = new Uint32Array(count + 2);
        surface.readRow?.(y, x, count, row, 1);
        const read = Array.from({ length: count }, (_, i)=>surface.read(x + i, y));
        assert.deepEqual([...row.subarray(1, 1 + count)], read,
            `round ${round}: ${surface.bitCount} bits, row ${y} from ${x}`);
    }
});

test('a copy or a stretch from any depth by rows draws what a pixel at a time draws', ()=>{
    // The gate of the row paths of a source of any depth: the pixel path, which
    // a conversion that changes nothing forces, against them -- copies, and
    // stretches that keep the size or enlarge, mirrored and clipped, in every
    // stretch mode.
    const random = seeded(23);
    const modes = [BLACKONWHITE, WHITEONBLACK, COLORONCOLOR, HALFTONE];
    for (let round = 0; round < 400; round++)
    {
        const src = anyDepth(random, 1 + random(20), 1 + random(16));
        const dest = createSurface({ width: 1 + random(32), height: 1 + random(24),
            topDown: random(2) === 0 });
        for (let i = 0; i < dest.bytes.length; i++)
        {
            dest.bytes[i] = random(256);
        }
        const expected = createSurface({ width: dest.width, height: dest.height,
            topDown: dest.topDown });
        expected.bytes.set(dest.bytes);
        const clip = random(2) === 0 ? undefined
            : { left: random(8), top: random(8), right: 8 + random(24), bottom: 8 + random(16) };
        const stretching = random(2) === 0;
        const srcWidth = (1 + random(16)) * (random(4) === 0 ? -1 : 1);
        const srcHeight = (1 + random(12)) * (random(4) === 0 ? -1 : 1);
        const call = stretching
            ? { x: random(20) - 4, y: random(16) - 4,
                width: (1 + random(24)) * (random(4) === 0 ? -1 : 1),
                height: (1 + random(18)) * (random(4) === 0 ? -1 : 1),
                srcX: random(src.width + 4) - 2, srcY: random(src.height + 4) - 2,
                srcWidth, srcHeight, rop: SOURCE_OPERATIONS[random(8)], mode: modes[random(4)] }
            : { x: random(24) - 4, y: random(20) - 4, width: random(24), height: random(20),
                srcX: random(24) - 4, srcY: random(20) - 4, rop: SOURCE_OPERATIONS[random(8)] };
        const blit = stretching ? stretchBlt : bitBlt;
        const answer = blit(/** @type {any} */ ({ ...call, clip, dest: expected, src,
            convert: (/** @type {number} */ pixel)=>pixel }));
        assert.equal(blit(/** @type {any} */ ({ ...call, clip, dest, src })), answer);
        assert.deepEqual([...dest.bytes], [...expected.bytes],
            `round ${round}: ${src.bitCount} bits `
                + JSON.stringify({ stretching, ...call, clip }));
    }
});

test('a copy or a stretch into or out of a window view draws what a pixel at a time draws', ()=>{
    // A child window's DC draws on a view of its top-level window's surface;
    // wholly inside it, the view takes the row paths, past its edge it keeps
    // the pixel path. Both against the pixel path, which an identity conversion
    // forces, by the parent's bytes.
    const random = seeded(31);
    const modes = [BLACKONWHITE, WHITEONBLACK, COLORONCOLOR, HALFTONE];
    /** @param {number} width @param {number} height */
    const parentOf = (width, height)=>{
        const parent = createSurface({ width, height });
        for (let i = 0; i < parent.bytes.length; i++)
        {
            parent.bytes[i] = random(256);
        }
        return parent;
    };
    /** @param {any} parent */
    const placed = parent=>{
        const left = random(parent.width + 4) - 2;
        const top = random(parent.height + 4) - 2;
        return { left, top, right: left + 1 + random(parent.width),
            bottom: top + 1 + random(parent.height) };
    };
    for (let round = 0; round < 400; round++)
    {
        const parent = parentOf(8 + random(24), 8 + random(16));
        const copy = createSurface({ width: parent.width, height: parent.height });
        copy.bytes.set(parent.bytes);
        const rect = placed(parent);
        const viewSource = random(2) === 0;
        const srcParent = viewSource ? parentOf(8 + random(16), 8 + random(12)) : null;
        const srcRect = srcParent ? placed(srcParent) : null;
        const src = srcParent ? viewOf(srcParent, /** @type {any} */ (srcRect))
            : anyDepth(random, 1 + random(16), 1 + random(12));
        const stretching = random(2) === 0;
        const srcWidth = 1 + random(14);
        const srcHeight = 1 + random(10);
        const call = stretching
            ? { x: random(16) - 4, y: random(12) - 4, width: 1 + random(16),
                height: 1 + random(14), srcX: random(src.width + 2) - 1,
                srcY: random(src.height + 2) - 1, srcWidth, srcHeight,
                rop: SOURCE_OPERATIONS[random(8)],
                mode: modes[random(4)] }
            : { x: random(16) - 4, y: random(12) - 4, width: random(20), height: random(16),
                srcX: random(16) - 4, srcY: random(12) - 4, rop: SOURCE_OPERATIONS[random(8)] };
        const blit = stretching ? stretchBlt : bitBlt;
        const answer = blit(/** @type {any} */ ({ ...call, dest: viewOf(copy, rect), src,
            convert: (/** @type {number} */ pixel)=>pixel }));
        assert.equal(blit(/** @type {any} */ ({ ...call, dest: viewOf(parent, rect), src })),
            answer);
        assert.deepEqual([...parent.bytes], [...copy.bytes],
            `round ${round}: ${JSON.stringify({ stretching, rect, srcRect, ...call })}`);
    }
});

test('a plain copy moved a row at a time draws what the copy a pixel at a time draws', ()=>{
    // The gate of the row path: every surface pair it takes -- separate or
    // one surface onto itself, overlapping either way, top-down or not --
    // against the pixel path, which a conversion that changes nothing forces.
    let seed = 11;
    const random = (/** @type {number} */ below)=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return (seed >>> 8) % below;
    };
    /** @param {number} width @param {number} height @param {boolean} topDown */
    const filled = (width, height, topDown)=>{
        const surface = createSurface({ width, height, topDown });
        for (let y = 0; y < height; y++)
        {
            for (let x = 0; x < width; x++)
            {
                surface.write(x, y, (random(0x1000000) | (random(256) << 24)) >>> 0);
            }
        }
        return surface;
    };
    /** @param {any} surface */
    const copyOf = surface=>{
        const copy = createSurface({ width: surface.width, height: surface.height,
            topDown: surface.topDown });
        copy.bytes.set(surface.bytes);
        return copy;
    };
    for (let round = 0; round < 400; round++)
    {
        const self = random(3) === 0;
        const dest = filled(1 + random(20), 1 + random(16), random(2) === 0);
        const src = self ? dest : filled(1 + random(20), 1 + random(16), random(2) === 0);
        const call = { x: random(24) - 4, y: random(20) - 4, width: random(24), height: random(20),
            srcX: random(24) - 4, srcY: random(20) - 4, rop: 0x00cc0020 };
        const clip = random(2) === 0 ? undefined
            : { left: random(8), top: random(8), right: 8 + random(16), bottom: 8 + random(12) };
        const expected = copyOf(dest);
        const expectedSrc = self ? expected : src;
        bitBlt({ ...call, clip, dest: expected, src: expectedSrc, convert: pixel=>pixel });
        bitBlt({ ...call, clip, dest, src });
        assert.deepEqual([...dest.bytes], [...expected.bytes],
            `round ${round}: ${JSON.stringify({ self, ...call, clip })}`);
    }
});
