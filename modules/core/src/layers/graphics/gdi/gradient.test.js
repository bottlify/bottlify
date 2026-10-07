/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GRADIENT_FILL_RECT_H, GRADIENT_FILL_RECT_V, GRADIENT_FILL_TRIANGLE, gradientFill,
    gradientRect, gradientTriangle,
} from './gradient.js';
import { createPainter } from './shapes.js';
import { clearSurface, createSurface } from './surface.js';

const BACKGROUND = 0x00202020;

/** @param {number} width @param {number} height */
function canvas(width, height){
    const surface = createSurface({ width, height });
    clearSurface(surface, BACKGROUND);
    return surface;
}

/**
 * @param {number} x @param {number} y @param {number} red @param {number} green
 * @param {number} blue @param {number} [alpha]
 */
const vertex = (x, y, red, green, blue, alpha = 0)=>({ x, y, red, green, blue, alpha });

test('a rectangle shades from the near edge\'s vertex to the far one\'s, half-open', ()=>{
    const surface = canvas(8, 3);
    gradientRect(createPainter(surface), vertex(0, 0, 0xff00, 0, 0, 0x8000),
        vertex(4, 2, 0, 0, 0xff00, 0xff00), false);
    assert.equal(surface.read(0, 0), 0x80ff0000, 'the left edge is the left vertex, alpha too');
    assert.equal(surface.read(2, 1), 0xbf7f007f, 'half way, each channel at sixteen bits');
    assert.equal(surface.read(3, 1), 0xdf3f00bf);
    assert.equal(surface.read(4, 0), BACKGROUND, 'the right edge is outside');
    assert.equal(surface.read(0, 2), BACKGROUND, 'and so is the bottom');

    const reversed = canvas(8, 3);
    gradientRect(createPainter(reversed), vertex(4, 2, 0, 0, 0xff00), vertex(0, 0, 0xff00, 0, 0),
        false);
    assert.equal(reversed.read(0, 0), 0x00ff0000, 'whichever vertex is named first');
});

test('a vertical rectangle shades down, and an empty one draws nothing', ()=>{
    const surface = canvas(3, 8);
    gradientFill(createPainter(surface), [vertex(0, 0, 0, 0, 0), vertex(2, 4, 0xff00, 0xff00,
        0xff00), vertex(2, 4, 0, 0, 0)], [[0, 1], [1, 2]], GRADIENT_FILL_RECT_V);
    assert.equal(surface.read(1, 0), 0, 'the top edge is the top vertex');
    assert.equal(surface.read(1, 3), 0x00bfbfbf);
    assert.equal(surface.read(1, 4), BACKGROUND);
    assert.equal(surface.read(2, 0), BACKGROUND);
});

test('the clip cuts a rectangle and the colours stay where they were', ()=>{
    const surface = canvas(8, 1);
    const painter = createPainter(surface, { left: 2, top: 0, right: 3, bottom: 1 });
    gradientFill(painter, [vertex(0, 0, 0, 0, 0), vertex(4, 1, 0, 0xff00, 0)], [[0, 1]],
        GRADIENT_FILL_RECT_H);
    assert.deepEqual([1, 2, 3].map(x=>surface.read(x, 0)), [BACKGROUND, 0x00007f00, BACKGROUND]);
});

test('a triangle covers the pixels whose centres it holds, each corner its own colour', ()=>{
    const surface = canvas(12, 12);
    gradientTriangle(createPainter(surface), vertex(0, 0, 0xff00, 0, 0),
        vertex(10, 0, 0, 0xff00, 0), vertex(0, 10, 0, 0, 0xff00));
    assert.equal(surface.read(0, 0), 0x00ff0000, 'the corner on a pixel is that corner');
    assert.equal(surface.read(5, 0), 0x007f7f00, 'half way along the top edge');
    assert.equal(surface.read(0, 5), 0x007f007f, 'and down the left one');
    assert.equal(surface.read(9, 9), BACKGROUND, 'past the long edge');
    assert.equal(surface.read(10, 0), BACKGROUND, 'a corner past the last centre is outside');

    const flat = canvas(4, 4);
    gradientTriangle(createPainter(flat), vertex(0, 0, 0xff00, 0, 0), vertex(3, 3, 0, 0, 0),
        vertex(1, 1, 0, 0, 0));
    assert.ok([0, 1, 2, 3].every(y=>[0, 1, 2, 3].every(x=>flat.read(x, y) === BACKGROUND)),
        'a triangle with no area covers nothing');
});

test('two triangles sharing an edge cover each pixel once', ()=>{
    // Drawn over a picture of zeros: every pixel of the square is written by
    // exactly one of the two, which a count of writes shows.
    const surface = canvas(6, 6);
    /** @type {Map<string, number>} */
    const writes = new Map();
    const counting = {
        ...surface,
        /** @param {number} x @param {number} y @param {number} pixel */
        write: (x, y, pixel)=>{
            writes.set(`${x},${y}`, (writes.get(`${x},${y}`) ?? 0) + 1);
            surface.write(x, y, pixel);
        },
    };
    const corners = [vertex(0, 0, 0, 0, 0), vertex(6, 0, 0, 0, 0), vertex(6, 6, 0, 0, 0),
        vertex(0, 6, 0, 0, 0)];
    gradientFill(createPainter(counting), corners, [[0, 1, 2], [0, 2, 3]],
        GRADIENT_FILL_TRIANGLE);
    assert.equal(writes.size, 36, 'the whole square');
    assert.ok([...writes.values()].every(count=>count === 1), 'and nothing twice');
});
