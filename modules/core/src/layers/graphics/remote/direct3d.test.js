/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTargetReads } from './direct3d.js';

/** A surface as `answeredByRenderer` asks it: its description says what it is. */
const surface = (/** @type {number} */ usage)=>({
    GetDesc: (/** @type {any} */ out)=>{
        out.desc = { Usage: usage };
    },
});
const target = ()=>surface(1);

test('a copy out of a target untouched since its last read-back is made here', ()=>{
    const reads = createTargetReads();
    const fence = target();
    const back = target();
    const image = surface(0);
    const device = {};
    const copy = ()=>reads.answered(device, 'CopyRects', [fence, null, 0, image, null]);
    reads.observe(device, 'SetRenderTarget', [back, null]);

    assert.equal(copy(), true, 'the first is the renderer\'s');
    assert.equal(copy(), false, 'the second has its answer in the target already');
    // Bound and unbound with nothing drawn: still the same picture.
    reads.observe(device, 'SetRenderTarget', [fence, null]);
    reads.observe(device, 'SetRenderTarget', [back, null]);
    reads.observe(device, 'commands', []);
    assert.equal(copy(), false, 'drawing into another target leaves it');

    reads.observe(device, 'SetRenderTarget', [fence, null]);
    reads.observe(device, 'Clear', [0, null, 1, 0, 1, 0]);
    reads.observe(device, 'SetRenderTarget', [back, null]);
    assert.equal(copy(), true, 'cleared while bound: asked again');
    assert.equal(copy(), false);

    reads.observe(device, 'CopyRects', [image, null, 0, fence, null]);
    assert.equal(copy(), true, 'copied into: asked again');
    reads.observe(fence, 'LockRect', [{}, null, 0]);
    assert.equal(copy(), true, 'locked to write: asked again');
    reads.observe(fence, 'LockRect', [{}, null, 0x10]);
    assert.equal(copy(), false, 'a lock to read changes nothing');
    reads.observe(device, 'Reset', [{}]);
    assert.equal(copy(), true, 'a Reset forgets every target');
});

test('drawing before any target is named may draw into any read-back target', ()=>{
    const reads = createTargetReads();
    const back = target();
    const image = surface(0);
    const device = {};
    const copy = ()=>reads.answered(device, 'CopyRects', [back, null, 0, image, null]);
    assert.equal(copy(), true);
    reads.observe(device, 'DrawPrimitive', [4, 0, 2]);
    assert.equal(copy(), true, 'the back buffer is drawn into without being named');
    reads.observe(device, 'GetBackBuffer', [0, 0, { surface: back }]);
    reads.observe(device, 'SetRenderTarget', [target(), null]);
    assert.equal(copy(), false);
    reads.observe(device, 'Present', [null, null, 0, null]);
    assert.equal(copy(), true, 'a back buffer after Present is asked again');
});

test('a copy out of what is not a render target is never the renderer\'s', ()=>{
    const reads = createTargetReads();
    assert.equal(reads.answered({}, 'CopyRects', [surface(0), null, 0, surface(0), null]),
        false);
});
