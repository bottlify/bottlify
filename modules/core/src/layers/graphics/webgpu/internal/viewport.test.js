/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullTarget, viewportState } from './viewport.js';

test('a viewport produces both halves at once, or neither', ()=>{
    const state = viewportState({ x: 10, y: 20, width: 100, height: 50 });

    assert.deepEqual(state.rect,
        { x: 10, y: 20, width: 100, height: 50, minDepth: 0, maxDepth: 1 });
    assert.deepEqual(state.offset, [-10, -20], 'the vertex stage subtracts the origin');
    assert.deepEqual(state.scale, [2 / 100, -2 / 50], 'and divides by the extent, Y inverted');
});

test('the two halves cancel, so a vertex lands on the pixel it names', ()=>{
    const state = viewportState({ x: 10, y: 20, width: 100, height: 50 });
    /** Exactly what a fixed-function vertex stage would do with these constants. */
    const project = (/** @type {number} */ px, /** @type {number} */ py)=>[
        (px + state.offset[0]) * state.scale[0] - 1,
        (py + state.offset[1]) * state.scale[1] + 1,
    ];

    /** @param {number[]} got @param {number[]} want @param {string} what */
    const lands = (got, want, what)=>assert.ok(
        Math.abs(got[0] - want[0]) < 1e-9 && Math.abs(got[1] - want[1]) < 1e-9,
        `${what}: expected ${want} but the pair produced ${got}`);

    lands(project(10, 20), [-1, 1], 'the top-left corner of the rect');
    lands(project(110, 70), [1, -1], 'the bottom-right corner');
    lands(project(60, 45), [0, 0], 'the centre');
});

test('an origin away from zero is subtracted, not ignored', ()=>{
    const atOrigin = viewportState({ x: 0, y: 0, width: 100, height: 50 });
    const moved = viewportState({ x: 40, y: 0, width: 100, height: 50 });

    assert.deepEqual(atOrigin.scale, moved.scale, 'same extent, same scale');
    assert.notDeepEqual(atOrigin.offset, moved.offset,
        'dividing by the extent without subtracting the origin is the latent half-implementation');
});

test('a target viewport covers the whole target', ()=>{
    assert.deepEqual(fullTarget({ width: 256, height: 256 }).rect,
        { x: 0, y: 0, width: 256, height: 256, minDepth: 0, maxDepth: 1 });
});

test('a degenerate extent is refused rather than dividing by zero', ()=>{
    assert.throws(()=>viewportState({ x: 0, y: 0, width: 0, height: 8 }), /extent/);
    assert.throws(()=>viewportState({ x: 0, y: 0, width: 8, height: 0 }), /extent/);
});
