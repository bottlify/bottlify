/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTextureObject, markDirty, unionRect } from './objects.js';
import { GL } from './constants.js';

test('unionRect covers both rectangles exactly', ()=>{
    assert.deepEqual(
        unionRect({ x: 1, y: 1, width: 3, height: 3 }, { x: 2, y: 2, width: 3, height: 3 }),
        { x: 1, y: 1, width: 4, height: 4 });
    assert.deepEqual(
        unionRect({ x: 5, y: 5, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }),
        { x: 0, y: 0, width: 6, height: 6 });
});

test('markDirty records a first rectangle as it is', ()=>{
    const texture = createTextureObject(1, GL.TEXTURE_2D);
    markDirty(texture, 0, { x: 2, y: 3, width: 4, height: 5 });
    assert.deepEqual(texture.dirty.get(0), { x: 2, y: 3, width: 4, height: 5 });
});

test('markDirty unions a second rectangle into the first', ()=>{
    const texture = createTextureObject(1, GL.TEXTURE_2D);
    markDirty(texture, 0, { x: 0, y: 0, width: 2, height: 2 });
    markDirty(texture, 0, { x: 1, y: 1, width: 2, height: 2 });
    assert.deepEqual(texture.dirty.get(0), { x: 0, y: 0, width: 3, height: 3 });
});

test('markDirty with null always wins: the whole level, however small a rect follows', ()=>{
    const texture = createTextureObject(1, GL.TEXTURE_2D);
    markDirty(texture, 0, null);
    markDirty(texture, 0, { x: 0, y: 0, width: 1, height: 1 });
    assert.equal(texture.dirty.get(0), null,
        'a rect written after a full upload does not shrink it');
});

test('markDirty with null overrides any rect already recorded', ()=>{
    const texture = createTextureObject(1, GL.TEXTURE_2D);
    markDirty(texture, 0, { x: 0, y: 0, width: 1, height: 1 });
    markDirty(texture, 0, null);
    assert.equal(texture.dirty.get(0), null);
});

test('markDirty keeps each level key separate', ()=>{
    const texture = createTextureObject(1, GL.TEXTURE_2D);
    markDirty(texture, 0, { x: 0, y: 0, width: 1, height: 1 });
    markDirty(texture, 1, null);
    assert.deepEqual(texture.dirty.get(0), { x: 0, y: 0, width: 1, height: 1 });
    assert.equal(texture.dirty.get(1), null);
});
