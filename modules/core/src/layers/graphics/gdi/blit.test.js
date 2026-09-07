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
    bitBlt,
    patBlt,
    stretchBlt,
} from './blit.js';
import { BLACKNESS, DSTINVERT, PATCOPY, SRCCOPY, SRCINVERT, WHITENESS } from './rop.js';
import { clearSurface, createSurface } from './surface.js';

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
