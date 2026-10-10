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

/** A device that counts what was drawn into each surface, as the Direct3D 8 one does. */
const counting = ()=>{
    const drawn = new Map();
    return {
        drawnInto: (/** @type {object} */ one)=>drawn.get(one) ?? 0,
        draw: (/** @type {object} */ one)=>drawn.set(one, (drawn.get(one) ?? 0) + 1),
    };
};

test('a copy out of a target nothing has drawn into since its last read-back is made here', ()=>{
    const reads = createTargetReads();
    const fence = target();
    const image = surface(0);
    const device = counting();
    const copy = ()=>reads.answered(device, 'CopyRects', [fence, null, 0, image, null]);

    assert.equal(copy(), true, 'the first is the renderer');
    assert.equal(copy(), false, 'the second has its answer in the target already');
    device.draw(image);
    assert.equal(copy(), false, 'drawing into another surface leaves it');
    device.draw(fence);
    assert.equal(copy(), true, 'drawn into: asked again');
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

test('a device that counts nothing has every copy answered by the renderer', ()=>{
    const reads = createTargetReads();
    const fence = target();
    const copy = ()=>reads.answered({}, 'CopyRects', [fence, null, 0, surface(0), null]);
    assert.equal(copy(), true);
    assert.equal(copy(), true);
});

test('a copy out of what is not a render target is never the renderer\'s', ()=>{
    const reads = createTargetReads();
    assert.equal(reads.answered({}, 'CopyRects', [surface(0), null, 0, surface(0), null]),
        false);
});
