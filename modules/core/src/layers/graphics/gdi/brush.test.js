/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BS_HATCHED,
    BS_NULL,
    BS_PATTERN,
    BS_SOLID,
    HS_CROSS,
    HS_FDIAGONAL,
    HS_HORIZONTAL,
    HS_VERTICAL,
    OPAQUE,
    TRANSPARENT,
    TRANSPARENT_PIXEL,
    createPattern,
    solidPattern,
} from './brush.js';

const ORIGIN = { x: 0, y: 0 };
const RED_COLOR = 0x000000ff;
const RED_PIXEL = 0x00ff0000;
const WHITE = 0x00ffffff;

test('a solid brush is the same pixel everywhere', ()=>{
    const pattern = createPattern({
        attributes: { style: BS_SOLID, color: RED_COLOR },
        bkMode: OPAQUE,
        bkColor: 0,
        origin: ORIGIN,
    });
    assert.equal(pattern(0, 0), RED_PIXEL);
    assert.equal(pattern(37, 91), RED_PIXEL);
    assert.equal(solidPattern(RED_COLOR)(5, 5), RED_PIXEL);
});

test('a null brush paints nothing at all', ()=>{
    const pattern = createPattern({
        attributes: { style: BS_NULL, color: RED_COLOR },
        bkMode: OPAQUE,
        bkColor: WHITE,
        origin: ORIGIN,
    });
    assert.equal(pattern(0, 0), TRANSPARENT_PIXEL);
});

test('a hatch repeats every eight pixels from the brush origin', ()=>{
    /** @param {number} hatch @param {{x: number, y: number}} origin */
    const hatched = (hatch, origin)=>createPattern({
        attributes: { style: BS_HATCHED, color: RED_COLOR, hatch },
        bkMode: TRANSPARENT,
        bkColor: WHITE,
        origin,
    });

    const horizontal = hatched(HS_HORIZONTAL, ORIGIN);
    assert.equal(horizontal(3, 0), RED_PIXEL);
    assert.equal(horizontal(3, 8), RED_PIXEL);
    assert.equal(horizontal(3, 1), TRANSPARENT_PIXEL);

    // Moving the origin moves the whole tile, which is what a brush origin is
    // for: two adjacent fills line up instead of stepping.
    const shifted = hatched(HS_HORIZONTAL, { x: 0, y: 3 });
    assert.equal(shifted(3, 3), RED_PIXEL);
    assert.equal(shifted(3, 0), TRANSPARENT_PIXEL);

    const vertical = hatched(HS_VERTICAL, ORIGIN);
    assert.equal(vertical(0, 5), RED_PIXEL);
    assert.equal(vertical(1, 5), TRANSPARENT_PIXEL);

    const diagonal = hatched(HS_FDIAGONAL, ORIGIN);
    assert.equal(diagonal(4, 4), RED_PIXEL);
    assert.equal(diagonal(4, 5), TRANSPARENT_PIXEL);

    const cross = hatched(HS_CROSS, ORIGIN);
    assert.equal(cross(0, 4), RED_PIXEL);
    assert.equal(cross(4, 0), RED_PIXEL);
    assert.equal(cross(4, 4), TRANSPARENT_PIXEL);
});

test('the background mode decides what a hatch leaves between its lines', ()=>{
    /** @param {number} bkMode */
    const gap = bkMode=>createPattern({
        attributes: { style: BS_HATCHED, color: RED_COLOR, hatch: HS_HORIZONTAL },
        bkMode,
        bkColor: WHITE,
        origin: ORIGIN,
    })(0, 1);
    assert.equal(gap(TRANSPARENT), TRANSPARENT_PIXEL);
    assert.equal(gap(OPAQUE), 0x00ffffff);
});

test('a pattern brush tiles its bitmap and wraps at negative coordinates', ()=>{
    // The copy the bookkeeping half takes: rows top-down, WORD-padded.
    const pixels = new Uint8Array(new Uint32Array([
        0x00111111, 0x00222222,
        0x00333333, 0x00444444,
    ]).buffer);
    const pattern = createPattern({
        attributes: {
            style: BS_PATTERN, color: RED_COLOR,
            pattern: { width: 2, height: 2, bitCount: 32, pixels },
        },
        bkMode: OPAQUE,
        bkColor: WHITE,
        origin: ORIGIN,
    });
    assert.equal(pattern(0, 0), 0x00111111);
    assert.equal(pattern(3, 2), 0x00222222);
    assert.equal(pattern(-1, -1), 0x00444444, 'a modulo that goes negative wraps the wrong way');
});

test('a monochrome pattern is drawn in the context\'s colours, and as bits into a mask', ()=>{
    // A 0 bit is the text colour and a 1 bit the background colour, opaque
    // whatever the background mode.
    const pixels = new Uint8Array([0b01000000, 0]);
    /** @param {boolean} mono */
    const monochrome = mono=>createPattern({
        attributes: { style: BS_PATTERN, pattern: { width: 2, height: 1, bitCount: 1, pixels } },
        bkMode: TRANSPARENT,
        bkColor: WHITE,
        textColor: RED_COLOR,
        mono,
        origin: ORIGIN,
    });
    assert.deepEqual([monochrome(false)(0, 0), monochrome(false)(1, 0)], [RED_PIXEL, WHITE]);
    assert.deepEqual([monochrome(true)(0, 0), monochrome(true)(1, 0)], [0, WHITE]);
});

test('a pattern copied from a DIB section keeps the section\'s colours', ()=>{
    // One bit a pixel here is a colour table of two, not monochrome.
    const pattern = createPattern({
        attributes: {
            style: BS_PATTERN,
            pattern: {
                width: 2, height: 1, bitCount: 1, pixels: new Uint8Array([0b01000000, 0]),
                dib: true, palette: [0x00123456, 0x00abcdef],
            },
        },
        bkMode: OPAQUE,
        bkColor: WHITE,
        textColor: RED_COLOR,
        origin: ORIGIN,
    });
    assert.deepEqual([pattern(0, 0), pattern(1, 0)], [0x00123456, 0x00abcdef]);
});

test('a pattern brush with no bitmap behind it falls back to its colour', ()=>{
    const pattern = createPattern({
        attributes: { style: BS_PATTERN, color: RED_COLOR },
        bkMode: OPAQUE,
        bkColor: WHITE,
        origin: ORIGIN,
    });
    assert.equal(pattern(0, 0), RED_PIXEL);
});
