/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ALTERNATE,
    PS_NULL,
    PS_SOLID,
    WINDING,
    createPainter,
    ellipse,
    fillRect,
    frameRect,
    line,
    polygon,
    rectangle,
} from './shapes.js';
import { R2_NOT, R2_XORPEN } from './rop.js';
import { TRANSPARENT_PIXEL } from './brush.js';
import { clearSurface, colorToPixel, createSurface } from './surface.js';

const BACKGROUND = 0x00202020;
const PEN_COLOR = 0x000000ff;
const PEN_PIXEL = colorToPixel(PEN_COLOR);
const BRUSH_PIXEL = 0x0000ff00;

const PEN = { style: PS_SOLID, width: 1, color: PEN_COLOR };
const NULL_PEN = { style: PS_NULL, width: 1, color: PEN_COLOR };
const BRUSH = ()=>BRUSH_PIXEL;

/** @param {number} width @param {number} height */
function canvas(width, height){
    const surface = createSurface({ width, height });
    clearSurface(surface, BACKGROUND);
    return surface;
}

test('a filled rectangle includes its leading edge and excludes its trailing one', ()=>{
    // The seam rule: [left, right) by [top, bottom). Two tiles that share an
    // edge paint it once, and a fill never reaches the pixel the next one owns.
    const surface = canvas(8, 8);
    fillRect(createPainter(surface), { left: 2, top: 3, right: 5, bottom: 6 }, BRUSH);
    assert.equal(surface.read(2, 3), BRUSH_PIXEL, 'the leading corner is inside');
    assert.equal(surface.read(4, 5), BRUSH_PIXEL, 'the last pixel inside');
    assert.equal(surface.read(5, 5), BACKGROUND, 'the right edge is outside');
    assert.equal(surface.read(4, 6), BACKGROUND, 'the bottom edge is outside');
    assert.equal(surface.read(1, 3), BACKGROUND);
});

test('two rectangles sharing an edge paint every pixel exactly once', ()=>{
    // Counting writes rather than reading colours: a convention that included
    // the trailing edge would paint the shared column twice and would still
    // look right.
    const surface = canvas(8, 2);
    /** @type {Map<string, number>} */
    const writes = new Map();
    const counting = {
        ...surface,
        /** @param {number} x @param {number} y @param {number} pixel */
        write(x, y, pixel){
            writes.set(`${x},${y}`, (writes.get(`${x},${y}`) ?? 0) + 1);
            surface.write(x, y, pixel);
        },
    };
    const painter = createPainter(counting);
    fillRect(painter, { left: 0, top: 0, right: 4, bottom: 2 }, BRUSH);
    fillRect(painter, { left: 4, top: 0, right: 8, bottom: 2 }, BRUSH);
    for (let x = 0; x < 8; x++)
    {
        assert.equal(writes.get(`${x},0`), 1, `column ${x} painted once`);
    }
});

test('FrameRect draws inside the rectangle, one pixel wide', ()=>{
    const surface = canvas(8, 8);
    frameRect(createPainter(surface), { left: 1, top: 1, right: 6, bottom: 5 }, BRUSH);
    assert.equal(surface.read(1, 1), BRUSH_PIXEL);
    assert.equal(surface.read(5, 4), BRUSH_PIXEL, 'the far corner is at right-1, bottom-1');
    assert.equal(surface.read(6, 4), BACKGROUND, 'nothing is painted on the trailing column');
    assert.equal(surface.read(5, 5), BACKGROUND);
    assert.equal(surface.read(3, 2), BACKGROUND, 'the middle stays empty');
    assert.equal(surface.read(3, 1), BRUSH_PIXEL);
});

test('Rectangle outlines the half-open box and fills what is left', ()=>{
    const surface = canvas(10, 10);
    rectangle(createPainter(surface), { left: 2, top: 2, right: 7, bottom: 6 }, PEN, BRUSH);
    assert.equal(surface.read(2, 2), PEN_PIXEL, 'the pen owns the boundary');
    assert.equal(surface.read(6, 5), PEN_PIXEL, 'and reaches right-1, bottom-1');
    assert.equal(surface.read(7, 5), BACKGROUND, 'never right itself');
    assert.equal(surface.read(6, 6), BACKGROUND);
    assert.equal(surface.read(3, 3), BRUSH_PIXEL, 'the brush owns the interior');
    assert.equal(surface.read(5, 4), BRUSH_PIXEL);
});

test('a null pen fills from the corner, one pixel short of the right and bottom', ()=>{
    // The documented rule: with PS_NULL the rectangle is one pixel less wide
    // and high, the brush taking the place the outline's top and left had.
    const surface = canvas(8, 8);
    rectangle(createPainter(surface), { left: 1, top: 1, right: 5, bottom: 5 },
        NULL_PEN, BRUSH);
    assert.equal(surface.read(1, 1), BRUSH_PIXEL);
    assert.equal(surface.read(3, 3), BRUSH_PIXEL);
    assert.equal(surface.read(4, 3), BACKGROUND);
    assert.equal(surface.read(3, 4), BACKGROUND);
});

test('LineTo paints its start and not its endpoint', ()=>{
    // A polyline joins segments at shared points; painting the endpoint too
    // would paint every junction twice, which an inverting raster operation
    // makes visible immediately.
    const surface = canvas(8, 2);
    line(createPainter(surface), 1, 0, 5, 0, PEN);
    assert.equal(surface.read(1, 0), PEN_PIXEL);
    assert.equal(surface.read(4, 0), PEN_PIXEL);
    assert.equal(surface.read(5, 0), BACKGROUND, 'the endpoint belongs to the next segment');
    assert.equal(surface.read(0, 0), BACKGROUND);
});

test('a diagonal line steps one pixel per column', ()=>{
    const surface = canvas(8, 8);
    line(createPainter(surface), 0, 0, 5, 5, PEN);
    for (let step = 0; step < 5; step++)
    {
        assert.equal(surface.read(step, step), PEN_PIXEL, `on the diagonal at ${step}`);
    }
    assert.equal(surface.read(5, 5), BACKGROUND);
    assert.equal(surface.read(1, 0), BACKGROUND, 'no pixel off the path');
});

test('a shallow line advances along the major axis every step', ()=>{
    const surface = canvas(9, 4);
    line(createPainter(surface), 0, 0, 8, 2, PEN);
    // Bresenham with a two-in-eight slope: the rounding is deterministic, so
    // these are the columns the step happens at, not an approximation.
    assert.equal(surface.read(0, 0), PEN_PIXEL);
    assert.equal(surface.read(1, 0), PEN_PIXEL);
    assert.equal(surface.read(2, 1), PEN_PIXEL);
    assert.equal(surface.read(6, 2), PEN_PIXEL);
    assert.equal(surface.read(2, 0), BACKGROUND);
});

test('a wide pen stamps a square centred on the path', ()=>{
    const surface = canvas(8, 8);
    line(createPainter(surface), 3, 3, 4, 3, { style: PS_SOLID, width: 3, color: PEN_COLOR });
    assert.equal(surface.read(3, 3), PEN_PIXEL);
    assert.equal(surface.read(2, 2), PEN_PIXEL);
    assert.equal(surface.read(4, 4), PEN_PIXEL);
    assert.equal(surface.read(1, 3), BACKGROUND);
});

test('the binary raster operation reaches every pen pixel', ()=>{
    const surface = canvas(4, 1);
    line(createPainter(surface, undefined, R2_NOT), 0, 0, 3, 0, PEN);
    assert.equal(surface.read(0, 0), (~BACKGROUND) >>> 0, 'R2_NOT ignores the pen colour');
    assert.equal(surface.read(2, 0), (~BACKGROUND) >>> 0);

    const xored = canvas(4, 1);
    line(createPainter(xored, undefined, R2_XORPEN), 0, 0, 1, 0, PEN);
    assert.equal(xored.read(0, 0), (PEN_PIXEL ^ BACKGROUND) >>> 0);
});

test('the clip stops a shape at its own boundary', ()=>{
    const surface = canvas(8, 8);
    const painter = createPainter(surface, { left: 2, top: 2, right: 5, bottom: 5 });
    fillRect(painter, { left: 0, top: 0, right: 8, bottom: 8 }, BRUSH);
    assert.equal(surface.read(1, 2), BACKGROUND);
    assert.equal(surface.read(2, 2), BRUSH_PIXEL);
    assert.equal(surface.read(4, 4), BRUSH_PIXEL);
    assert.equal(surface.read(5, 4), BACKGROUND);
});

test('an ellipse fills its box and puts the pen on the boundary of that fill', ()=>{
    const surface = canvas(12, 12);
    ellipse(createPainter(surface), { left: 1, top: 1, right: 10, bottom: 10 }, PEN, BRUSH);
    // The bounding box is [1, 9] by [1, 9]: centre at (5, 5), radius 4.
    assert.equal(surface.read(5, 5), BRUSH_PIXEL, 'the centre is interior');
    assert.equal(surface.read(1, 5), PEN_PIXEL, 'the leftmost point of the axis');
    assert.equal(surface.read(9, 5), PEN_PIXEL, 'and the rightmost, at right-1');
    assert.equal(surface.read(5, 1), PEN_PIXEL);
    assert.equal(surface.read(10, 5), BACKGROUND, 'nothing on the trailing column');
    assert.equal(surface.read(1, 1), BACKGROUND, 'a corner of the box is outside the curve');
});

test('an ellipse has no gap between its outline and its own interior', ()=>{
    // The failure this rules out is a one-pixel hole where a curve rasteriser
    // and a scanline fill disagree about the edge.
    const surface = canvas(16, 16);
    ellipse(createPainter(surface), { left: 0, top: 0, right: 15, bottom: 11 }, PEN, BRUSH);
    for (let y = 0; y < 16; y++)
    {
        let seenInk = false;
        let seenGapAfterInk = false;
        for (let x = 0; x < 16; x++)
        {
            const painted = surface.read(x, y) !== BACKGROUND;
            if (painted && seenGapAfterInk)
            {
                assert.fail(`row ${y} has a hole inside the figure`);
            }
            if (seenInk && !painted)
            {
                seenGapAfterInk = true;
            }
            seenInk = seenInk || painted;
        }
    }
});

test('a polygon fills half-open spans and strokes its edges', ()=>{
    const surface = canvas(10, 10);
    polygon(createPainter(surface), [
        { x: 1, y: 1 },
        { x: 7, y: 1 },
        { x: 7, y: 7 },
        { x: 1, y: 7 },
    ], PEN, BRUSH, ALTERNATE);
    assert.equal(surface.read(4, 4), BRUSH_PIXEL, 'well inside');
    assert.equal(surface.read(1, 1), PEN_PIXEL, 'the first vertex is on the outline');
    assert.equal(surface.read(7, 4), PEN_PIXEL, 'the right edge is stroked');
    assert.equal(surface.read(8, 4), BACKGROUND, 'and nothing past it');
    assert.equal(surface.read(0, 4), BACKGROUND);
});

test('a polygon outline paints each vertex exactly once', ()=>{
    // With a hollow brush only the stroke writes, so this counts the junctions
    // between edges. Painting a vertex twice is invisible with an opaque pen
    // and unmistakable with an inverting one.
    const surface = canvas(10, 10);
    /** @type {Map<string, number>} */
    const writes = new Map();
    const counting = {
        ...surface,
        /** @param {number} x @param {number} y @param {number} pixel */
        write(x, y, pixel){
            writes.set(`${x},${y}`, (writes.get(`${x},${y}`) ?? 0) + 1);
            surface.write(x, y, pixel);
        },
    };
    polygon(createPainter(counting), [
        { x: 2, y: 2 },
        { x: 6, y: 2 },
        { x: 6, y: 6 },
    ], PEN, ()=>TRANSPARENT_PIXEL, ALTERNATE);
    assert.equal(writes.get('6,2'), 1, 'the vertex two edges meet at');
    assert.equal(writes.get('2,2'), 1);
    assert.equal(writes.get('6,6'), 1);
});

test('the two fill modes disagree about a self-crossing figure', ()=>{
    // A five-pointed star: the middle pentagon is outside the figure under
    // ALTERNATE and inside it under WINDING. Nothing else distinguishes them.
    const star = [
        { x: 10, y: 0 },
        { x: 13, y: 18 },
        { x: 0, y: 6 },
        { x: 20, y: 6 },
        { x: 7, y: 18 },
    ];
    /** @param {number} mode */
    const centre = mode=>{
        const surface = canvas(24, 24);
        polygon(createPainter(surface), star, NULL_PEN, BRUSH, mode);
        return surface.read(10, 9);
    };
    assert.equal(centre(ALTERNATE), BACKGROUND);
    assert.equal(centre(WINDING), BRUSH_PIXEL);
});
