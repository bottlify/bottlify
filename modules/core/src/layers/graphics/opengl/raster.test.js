/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The byte-exact suite for what OpenGL actually puts in the colour buffer.
 *
 * Every assertion is against pixels this engine computed itself, in integer
 * arithmetic, so every assertion is exact: the same calls give the same bytes
 * on every run and every machine. Nothing here touches a device -- a real
 * driver cannot be held to a stored image, which is the same reason
 * `webgpu/internal/reference.js` exists.
 *
 * The frames are 8x8. A larger one hides nothing and makes a failing diff
 * unreadable.
 *
 * Both tests drive the context through the entry points a program uses, not
 * through the rasteriser directly: what is being pinned is the whole path --
 * the clear value, the matrices, the viewport mapping and the fill rule --
 * because each of those is a place where a plausible picture can be wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** A context attached to an 8x8 single-buffered drawable. */
function drawing(){
    const context = createGlContext();
    context.attach({ width: 8, height: 8, doubleBuffered: false });
    return context;
}

/**
 * A pixel as the four bytes at its offset, lowest address first. The buffer is
 * BGRX, so blue comes first and a channel swap cannot hide behind grey.
 *
 * @param {any} frame @param {number} x @param {number} y @returns {number[]}
 */
const pixelAt = (frame, x, y)=>
    [...frame.bytes.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4)];

/** @param {any} frame @returns {string} */
const toBase64 = frame=>Buffer.from(frame.bytes).toString('base64');

/**
 * Sets up a projection in which one unit is one pixel, so the vertices a test
 * names are the window positions it can reason about.
 *
 * @param {any} context
 */
function pixelProjection(context){
    context.glMatrixMode(GL.PROJECTION);
    context.glLoadIdentity();
    context.glOrtho(0, 8, 0, 8, -1, 1);
    context.glMatrixMode(GL.MODELVIEW);
    context.glLoadIdentity();
}

test('a clear puts the clear colour in every pixel, blue byte first', ()=>{
    const context = drawing();

    // Three different channels and a fractional value in each: a swap is
    // invisible in grey, and the 0..1 to 0..255 mapping is a rounding, not a
    // truncation -- 0.75 is 191, and an implementation that truncates says 191
    // here too but says 127 for 0.5.
    context.glClearColor(0.25, 0.5, 0.75, 1);
    context.glClear(GL.COLOR_BUFFER_BIT);

    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(pixelAt(context.framebuffer, 0, 0), [191, 128, 64, 255]);
    assert.deepEqual(pixelAt(context.framebuffer, 7, 7), [191, 128, 64, 255],
        'the last pixel too: a clear that stops a row short passes a corner check');

    // Evidence that every pixel was written and none was skipped.
    assert.equal(toBase64(context.framebuffer),
        'v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/'
        + 'v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/'
        + 'v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/'
        + 'v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/v4BA/7+AQP+/gED/'
        + 'v4BA/7+AQP+/gED/v4BA/w==');

    // The mask is a mask: a bit outside the four buffers is a value error, and
    // it leaves the frame alone rather than half-clearing it.
    context.glClear(GL.COLOR_BUFFER_BIT | 0x10);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
});

test('a triangle fills the pixels whose centres it covers, and owns one edge', ()=>{
    const context = drawing();
    pixelProjection(context);
    context.glClearColor(0, 0, 0, 1);
    context.glClear(GL.COLOR_BUFFER_BIT);

    // In window coordinates -- GL counts y from the bottom -- this is the half
    // of the frame below the leading diagonal, with its right angle at the
    // top-left corner of the picture.
    context.glColor3f(1, 0.5, 0.25);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(0, 8);
    context.glEnd();

    assert.equal(context.glGetError(), GL.NO_ERROR);

    const frame = context.framebuffer;
    const filled = [64, 128, 255, 255];
    const empty = [0, 0, 0, 255];

    // Inside: the centre of (0, 1) is below the diagonal.
    assert.deepEqual(pixelAt(frame, 0, 1), filled);
    assert.deepEqual(pixelAt(frame, 0, 7), filled, 'and the bottom-left corner');
    assert.deepEqual(pixelAt(frame, 6, 7), filled, 'and the last pixel before the diagonal');

    // Outside: the mirror image across the diagonal is the other triangle's.
    assert.deepEqual(pixelAt(frame, 1, 0), empty);
    assert.deepEqual(pixelAt(frame, 7, 6), empty);

    // On the diagonal, which is this triangle's hypotenuse. The top-left rule
    // gives a shared edge to exactly one of the two triangles that meet along
    // it, and this is not the one -- without the rule both would draw here and
    // a blended seam would appear where the geometry says there is none.
    assert.deepEqual(pixelAt(frame, 0, 0), empty);
    assert.deepEqual(pixelAt(frame, 7, 7), empty);

    // 28 pixels: one on the second row, two on the third, and so on. A fill
    // rule that is off by one edge changes this count, and a viewport mapping
    // that is off by half a pixel changes it too.
    let covered = 0;
    for (let y = 0; y < 8; y++)
    {
        for (let x = 0; x < 8; x++)
        {
            covered += pixelAt(frame, x, y)[2] === 255 ? 1 : 0;
        }
    }
    assert.equal(covered, 28);
});

test('a triangle wound the other way fills the same pixels', ()=>{
    // The fill rule is written for one winding and the other is reordered
    // rather than special-cased. Two rules would disagree along exactly the
    // edges the rule exists to settle, and the disagreement is one pixel wide.
    const context = drawing();
    pixelProjection(context);
    context.glColor3f(1, 0.5, 0.25);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 8);
    context.glVertex2f(8, 0);
    context.glVertex2f(0, 0);
    context.glEnd();

    assert.deepEqual(pixelAt(context.framebuffer, 0, 1), [64, 128, 255, 255]);
    assert.deepEqual(pixelAt(context.framebuffer, 1, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(context.framebuffer, 7, 7), [0, 0, 0, 0],
        'the hypotenuse is still the other triangle\'s');
});
