/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floodFill } from './flood.js';
import { createPainter } from './shapes.js';
import { R2_XORPEN } from './rop.js';
import { RGB_565, clearSurface, createSurface, surfaceBounds } from './surface.js';

const WHITE = 0x00ffffff;
const BLUE = 0x000000ff;
const GREEN = 0x0000ff00;
const RED = 0x00ff0000;

/** @param {number} pixel */
const solid = pixel=>Object.assign(()=>pixel, { solid: pixel });

/**
 * A picture drawn from rows of characters: `.` white, `b` blue, `g` green.
 *
 * @param {string[]} rows
 * @param {import("./surface.js").SurfaceOptions} [options]
 */
function picture(rows, options){
    const surface = createSurface({ width: rows[0].length, height: rows.length, ...options });
    /** @type {Record<string, number>} */
    const colors = { '.': WHITE, b: BLUE, g: GREEN };
    rows.forEach((row, y)=>[...row].forEach((cell, x)=>surface.write(x, y, colors[cell])));
    return surface;
}

/**
 * The picture back as rows, `r` for red.
 *
 * @param {import("./contract.js").Surface} surface
 */
function rowsOf(surface){
    /** @type {Record<number, string>} */
    const names = { [WHITE]: '.', [BLUE]: 'b', [GREEN]: 'g', [RED]: 'r' };
    return Array.from({ length: surface.height }, (_, y)=>Array.from({ length: surface.width },
        (__, x)=>names[surface.read(x, y) & 0xffffff] ?? '?').join(''));
}

test('a border fill spreads up to the colour and stops there, never across a corner', ()=>{
    const surface = picture([
        'bbbbbbb',
        'b..b..b',
        'b..b..b',
        'bbb.bbb',
        'bbbbbbb',
    ]);
    assert.equal(floodFill(createPainter(surface), [surfaceBounds(surface)], 1, 1, BLUE, false,
        solid(RED)), true);
    assert.deepEqual(rowsOf(surface), [
        'bbbbbbb',
        'brrb..b',
        'brrb..b',
        'bbb.bbb',
        'bbbbbbb',
    ], 'the pixel below the corner touches it only diagonally');
});

test('a surface fill covers the colour it starts on and nothing else', ()=>{
    const surface = picture([
        'gggg.',
        'g..g.',
        'gggg.',
        '...gg',
    ]);
    assert.equal(floodFill(createPainter(surface), [surfaceBounds(surface)], 0, 0, GREEN, true,
        solid(RED)), true);
    assert.deepEqual(rowsOf(surface), [
        'rrrr.',
        'r..r.',
        'rrrr.',
        '...rr',
    ]);
});

test('a fill that cannot start paints nothing and says so', ()=>{
    const surface = picture(['.b.', '.b.']);
    const whole = [surfaceBounds(surface)];
    const painter = createPainter(surface);
    assert.equal(floodFill(painter, whole, 1, 0, BLUE, false, solid(RED)), false,
        'the start is the border');
    assert.equal(floodFill(painter, whole, 0, 0, BLUE, true, solid(RED)), false,
        'the start is not the surface');
    assert.equal(floodFill(painter, whole, -1, -1, WHITE, true, solid(RED)), false,
        'the start is off the picture');
    assert.deepEqual(rowsOf(surface), ['.b.', '.b.']);
});

test('the clip stops a fill as a border would, and a start outside it does not fill', ()=>{
    const surface = picture(['......', '......']);
    // A hole in the middle column, as ExcludeClipRect leaves one.
    const area = [{ left: 0, top: 0, right: 3, bottom: 2 }, { left: 4, top: 0, right: 6,
        bottom: 2 }];
    const painter = createPainter(surface, { left: 0, top: 0, right: 6, bottom: 2 });
    assert.equal(floodFill(painter, area, 3, 0, WHITE, true, solid(RED)), false);
    assert.equal(floodFill(painter, area, 0, 0, WHITE, true, solid(RED)), true);
    assert.deepEqual(rowsOf(surface), ['rrr...', 'rrr...']);
});

test('the area is found before it is painted, and painted under the raster operation', ()=>{
    // A brush of the border's own colour would wall a fill that painted as it
    // went into its first run; XOR shows each pixel is painted once.
    const surface = picture(['....', '.bb.', '....']);
    assert.equal(floodFill(createPainter(surface), [surfaceBounds(surface)], 0, 0, BLUE, false,
        solid(BLUE)), true);
    assert.deepEqual(rowsOf(surface), ['bbbb', 'bbbb', 'bbbb']);

    const twice = picture(['....', '.bb.']);
    floodFill(createPainter(twice, undefined, R2_XORPEN), [surfaceBounds(twice)], 0, 0, BLUE,
        false, solid(BLUE ^ GREEN));
    assert.deepEqual(rowsOf(twice), ['rrrr', 'rbbr'], 'white, once XORed with cyan');
});

test('the colour is the one the surface would store, so a fill finds it at any depth', ()=>{
    const surface = createSurface({ width: 3, height: 1, bitCount: 16, format: RGB_565 });
    clearSurface(surface, 0x00123456);
    surface.write(1, 0, BLUE);
    assert.equal(floodFill(createPainter(surface), [surfaceBounds(surface)], 0, 0, 0x00123456,
        true, solid(RED)), true, 'a colour sixteen bits cannot hold exactly');
    assert.equal(surface.read(0, 0), RED);
    assert.equal(surface.read(2, 0), surface.nearest(0x00123456), 'the far side is not connected');
});
