/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameRotation } from './frame-rotation.js';

test('a buffer handed back carries the next frame of its size; none back, one is made', ()=>{
    const rotation = createFrameRotation();
    const first = rotation.bytes(16);
    const second = rotation.bytes(16);
    assert.notEqual(first.buffer, second.buffer, 'nothing back yet: a buffer of its own');
    rotation.give(first.buffer);
    assert.equal(rotation.bytes(16).buffer, first.buffer, 'the buffer that came back');
    assert.deepEqual(rotation.figures(), { made: 2, reused: 1, returned: 1, dropped: 0,
        spare: 0 });
});

test('a buffer of a size no longer sent is let go of, and the spares never pass the bound', ()=>{
    const rotation = createFrameRotation(2);
    rotation.give(new ArrayBuffer(8));
    assert.equal(rotation.bytes(16).length, 16, 'a frame of the new size');
    assert.equal(rotation.figures().dropped, 1, 'the old size let go of');
    for (let given = 0; given < 5; given++)
    {
        rotation.give(new ArrayBuffer(16));
    }
    assert.equal(rotation.figures().spare, 2);
    assert.equal(rotation.figures().dropped, 4);
});

test('what is not a buffer of bytes - an answer without one, a detached one - is not kept', ()=>{
    const rotation = createFrameRotation();
    const detached = new ArrayBuffer(16);
    structuredClone(detached, { transfer: [detached] });
    for (const answer of [undefined, null, 7, new Uint8Array(4), detached])
    {
        rotation.give(answer);
    }
    assert.deepEqual(rotation.figures(), { made: 0, reused: 0, returned: 0, dropped: 0,
        spare: 0 });
});
