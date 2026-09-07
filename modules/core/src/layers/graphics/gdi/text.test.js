/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ETO_CLIPPED,
    ETO_OPAQUE,
    TA_BASELINE,
    TA_BOTTOM,
    TA_CENTER,
    TA_LEFT,
    TA_RIGHT,
    TA_TOP,
    extTextOut,
    textExtent,
} from './text.js';
import { OPAQUE, TRANSPARENT } from './brush.js';
import { createPainter } from './shapes.js';
import { clearSurface, colorToPixel, createSurface } from './surface.js';

const BACKGROUND = 0x00303030;
const INK_COLOR = 0x000000ff;
const INK = colorToPixel(INK_COLOR);
const PAPER_COLOR = 0x0000ff00;
const PAPER = colorToPixel(PAPER_COLOR);

/** Deliberately not square, so a transposed coordinate cannot pass by accident. */
const METRICS = Object.freeze({ cellWidth: 6, cellHeight: 10, ascent: 8 });

/** @param {number} width @param {number} height */
function canvas(width, height){
    const surface = createSurface({ width, height });
    clearSurface(surface, BACKGROUND);
    return surface;
}

/**
 * @param {import("./contract.js").Surface} surface
 * @param {Partial<import("./text.js").TextOptions>} options
 */
function draw(surface, options){
    return extTextOut(createPainter(surface), {
        x: 0,
        y: 0,
        text: 'AB',
        metrics: METRICS,
        textColor: INK_COLOR,
        bkColor: PAPER_COLOR,
        bkMode: TRANSPARENT,
        ...options,
    });
}

test('an extent is the advance sum, not the glyph shapes', ()=>{
    assert.equal(textExtent('ABC', METRICS), 18);
    assert.equal(textExtent('ABC', METRICS, [4, 5, 6]), 15);
    assert.equal(textExtent('', METRICS), 0);
});

test('a left-aligned string starts at the coordinate it was given', ()=>{
    const surface = canvas(32, 16);
    const result = draw(surface, { x: 4, y: 2, align: TA_LEFT | TA_TOP });
    assert.equal(result.width, 12);
    assert.equal(surface.read(4, 3), INK, 'the first cell begins at x = 4');
    assert.equal(surface.read(3, 3), BACKGROUND, 'and not one pixel earlier');
    // One column of each cell is left bare so that adjacent characters stay
    // countable: the sixth column of the first cell is not ink.
    assert.equal(surface.read(9, 3), BACKGROUND);
    assert.equal(surface.read(10, 3), INK, 'the second cell begins one advance along');
});

test('the ascent, not the cell height, is what a glyph body fills', ()=>{
    const surface = canvas(32, 16);
    draw(surface, { x: 0, y: 0, align: TA_LEFT | TA_TOP });
    assert.equal(surface.read(0, 0), BACKGROUND, 'the top row of the cell is above the body');
    assert.equal(surface.read(0, 1), INK);
    assert.equal(surface.read(0, 7), INK, 'down to the baseline');
    assert.equal(surface.read(0, 8), BACKGROUND, 'and no further');
});

test('the three horizontal alignments put the same string in three places', ()=>{
    /** @param {number} align */
    const leftEdge = align=>{
        const surface = canvas(40, 16);
        draw(surface, { x: 20, y: 0, align });
        for (let x = 0; x < 40; x++)
        {
            if (surface.read(x, 3) === INK)
            {
                return x;
            }
        }
        return -1;
    };
    assert.equal(leftEdge(TA_LEFT), 20);
    assert.equal(leftEdge(TA_RIGHT), 8, 'the string ends at the reference point');
    assert.equal(leftEdge(TA_CENTER), 14, 'half the extent to either side');
});

test('the three vertical alignments put the same string on three rows', ()=>{
    /** @param {number} align */
    const topEdge = align=>{
        const surface = canvas(32, 32);
        draw(surface, { x: 0, y: 16, align });
        for (let y = 0; y < 32; y++)
        {
            if (surface.read(0, y) === INK)
            {
                return y;
            }
        }
        return -1;
    };
    // TA_TOP puts the cell top at y, so the body starts one row lower.
    assert.equal(topEdge(TA_TOP), 17);
    assert.equal(topEdge(TA_BOTTOM), 7, 'the cell ends at the reference point');
    assert.equal(topEdge(TA_BASELINE), 9, 'the ascent lands on the reference point');
});

test('an opaque background paints the whole cell box and a transparent one none of it', ()=>{
    const opaque = canvas(32, 16);
    draw(opaque, { x: 2, y: 1, bkMode: OPAQUE, align: TA_LEFT | TA_TOP });
    assert.equal(opaque.read(2, 1), PAPER, 'the top-left of the box');
    assert.equal(opaque.read(13, 10), PAPER, 'and the last pixel of it');
    assert.equal(opaque.read(14, 10), BACKGROUND, 'the box is half-open like every other');
    assert.equal(opaque.read(2, 11), BACKGROUND);
    assert.equal(opaque.read(2, 2), INK, 'the glyph still sits on top');

    const transparent = canvas(32, 16);
    draw(transparent, { x: 2, y: 1, bkMode: TRANSPARENT, align: TA_LEFT | TA_TOP });
    assert.equal(transparent.read(2, 1), BACKGROUND);
    assert.equal(transparent.read(2, 2), INK);
});

test('ETO_OPAQUE fills the caller rectangle whatever the background mode says', ()=>{
    const surface = canvas(32, 16);
    // The rectangle is deliberately clear of the string, so that a pixel of
    // paper cannot be one the glyph happened to miss.
    draw(surface, {
        x: 0, y: 0,
        bkMode: TRANSPARENT,
        flags: ETO_OPAQUE,
        rect: { left: 16, top: 1, right: 20, bottom: 4 },
    });
    assert.equal(surface.read(16, 1), PAPER);
    assert.equal(surface.read(19, 3), PAPER);
    assert.equal(surface.read(20, 3), BACKGROUND);
    assert.equal(surface.read(16, 4), BACKGROUND);
    assert.equal(surface.read(0, 1), INK, 'the string is drawn where it was asked for');
});

test('ETO_CLIPPED narrows the clip and does not replace it', ()=>{
    const surface = canvas(32, 16);
    const painter = createPainter(surface, { left: 0, top: 0, right: 8, bottom: 16 });
    extTextOut(painter, {
        x: 0, y: 0,
        text: 'AB',
        metrics: METRICS,
        textColor: INK_COLOR,
        bkColor: PAPER_COLOR,
        bkMode: TRANSPARENT,
        flags: ETO_CLIPPED,
        rect: { left: 4, top: 0, right: 32, bottom: 16 },
    });
    assert.equal(surface.read(3, 3), BACKGROUND, 'outside the call rectangle');
    assert.equal(surface.read(4, 3), INK);
    assert.equal(surface.read(5, 3), BACKGROUND, 'the bare column of the first cell');
    assert.equal(surface.read(6, 3), INK, 'the second cell');
    assert.equal(surface.read(8, 3), BACKGROUND, 'outside the painter clip');
});

test('a per-character advance array moves the cells and the extent with it', ()=>{
    const surface = canvas(32, 16);
    const result = draw(surface, { x: 0, y: 0, dx: [10, 4] });
    assert.equal(result.width, 14);
    assert.equal(surface.read(0, 3), INK);
    assert.equal(surface.read(10, 3), INK, 'the second cell starts at the first advance');
    assert.equal(surface.read(9, 3), BACKGROUND);
});

test('a space advances the pen and paints nothing', ()=>{
    const surface = canvas(32, 16);
    const result = draw(surface, { x: 0, y: 0, text: 'A B' });
    assert.equal(result.width, 18);
    assert.equal(surface.read(0, 3), INK);
    assert.equal(surface.read(6, 3), BACKGROUND, 'the space cell stays empty');
    assert.equal(surface.read(12, 3), INK);
});
