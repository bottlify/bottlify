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
import { clearSurface, createSurface } from './surface.js';

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
    const tile = createSurface({ width: 2, height: 2 });
    clearSurface(tile, 0);
    tile.write(0, 0, 0x00111111);
    tile.write(1, 0, 0x00222222);
    tile.write(0, 1, 0x00333333);
    tile.write(1, 1, 0x00444444);

    const pattern = createPattern({
        attributes: { style: BS_PATTERN, color: RED_COLOR, surface: tile },
        bkMode: OPAQUE,
        bkColor: WHITE,
        origin: ORIGIN,
    });
    assert.equal(pattern(0, 0), 0x00111111);
    assert.equal(pattern(3, 2), 0x00222222);
    assert.equal(pattern(-1, -1), 0x00444444, 'a modulo that goes negative wraps the wrong way');
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
