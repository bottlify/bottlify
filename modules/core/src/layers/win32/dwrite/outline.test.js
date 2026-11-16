/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlinesOf, rasterize } from './outline.js';

/**
 * A face of two glyphs, 1000 units to the em: a square from (0, 0) to
 * (1000, 1000), and a composite that is the square moved 2000 units right.
 */
function tables(){
    const square = new DataView(new ArrayBuffer(10 + 2 + 2 + 4 + 16));
    square.setInt16(0, 1);
    square.setInt16(2, 0);
    square.setInt16(4, 0);
    square.setInt16(6, 1000);
    square.setInt16(8, 1000);
    square.setUint16(10, 3); // the one contour ends at point 3
    square.setUint16(12, 0); // no instructions
    [0, 1, 2, 3].forEach(i=>square.setUint8(14 + i, 0x01)); // on curve, coordinates as words
    // x deltas: 0, +1000, 0, -1000; y deltas: 0, 0, +1000, 0
    [0, 1000, 0, -1000].forEach((dx, i)=>square.setInt16(18 + i * 2, dx));
    [0, 0, 1000, 0].forEach((dy, i)=>square.setInt16(26 + i * 2, dy));
    const composite = new DataView(new ArrayBuffer(10 + 8));
    composite.setInt16(0, -1);
    composite.setUint16(10, 0x0003); // ARGS_ARE_WORDS | ARGS_ARE_XY
    composite.setUint16(12, 0);
    composite.setInt16(14, 2000);
    composite.setInt16(16, 0);
    const glyf = new Uint8Array(square.byteLength + composite.byteLength);
    glyf.set(new Uint8Array(square.buffer), 0);
    glyf.set(new Uint8Array(composite.buffer), square.byteLength);
    const loca = new DataView(new ArrayBuffer(12));
    loca.setUint32(0, 0);
    loca.setUint32(4, square.byteLength);
    loca.setUint32(8, glyf.length);
    const head = new DataView(new ArrayBuffer(54));
    head.setUint16(18, 1000);
    head.setInt16(50, 1); // long offsets
    const maxp = new DataView(new ArrayBuffer(6));
    maxp.setUint16(4, 2);
    return new Map([['glyf', glyf], ['loca', new Uint8Array(loca.buffer)],
        ['head', new Uint8Array(head.buffer)], ['maxp', new Uint8Array(maxp.buffer)]]);
}

test('a glyph\'s outline is read from glyf, a composite\'s as its components moved', ()=>{
    const outline = outlinesOf(tables());
    assert.deepEqual(outline(0), [[{ x: 0, y: 0, on: true }, { x: 1000, y: 0, on: true },
        { x: 1000, y: 1000, on: true }, { x: 0, y: 1000, on: true }]]);
    assert.deepEqual(outline(1)[0].map(point=>point.x), [2000, 3000, 3000, 2000]);
    assert.deepEqual(outline(2), [], 'past the glyphs, nothing');
});

test('a glyph drawn at a size covers the pixels its outline does, above the baseline', ()=>{
    // 10 pixels to the em: the square is 10 x 10 pixels, its bottom on the baseline.
    const drawn = rasterize(outlinesOf(tables())(0), 10 / 1000);
    assert.equal(drawn.left, 0);
    assert.equal(drawn.top, -10, 'ten pixels above the baseline');
    const at = (/** @type {number} */ x, /** @type {number} */ y)=>
        drawn.coverage[(y - drawn.top) * drawn.width + (x - drawn.left)];
    assert.equal(at(5, -5), 255, 'inside');
    assert.equal(at(0, -10), 255, 'its corner pixel');
    assert.equal(at(10, -5) ?? 0, 0, 'past its right side');
    const inked = [...drawn.coverage].filter(value=>value > 0).length;
    assert.equal(inked, 100, 'ten by ten');
    assert.deepEqual(rasterize([], 1), { left: 0, top: 0, width: 0, height: 0,
        coverage: new Uint8Array(0) }, 'no outline, nothing drawn');
});
