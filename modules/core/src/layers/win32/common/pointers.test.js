/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointerWidth } from './pointers.js';

test('a 32-bit pointer is a dword', ()=>{
    const width = pointerWidth();
    assert.equal(width.size, 4);
    assert.deepEqual([...width.bytes(0x12345678)], [0x78, 0x56, 0x34, 0x12]);
    assert.deepEqual([...width.array([1, 2])], [1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
});

test('a 64-bit pointer is a qword whose high half is zero', ()=>{
    const width = pointerWidth(8);
    const bytes = new Uint8Array(16).fill(0xee);
    const view = new DataView(bytes.buffer);
    width.set(view, 8, 0x8badf00d);
    assert.deepEqual([...bytes.subarray(8)], [0x0d, 0xf0, 0xad, 0x8b, 0, 0, 0, 0]);
    assert.equal(width.get(view, 8), 0x8badf00d);
    assert.equal(width.array([7]).length, 16);
    assert.deepEqual([...width.array([7])], [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('no other width', ()=>{
    assert.throws(()=>pointerWidth(2), RangeError);
});
