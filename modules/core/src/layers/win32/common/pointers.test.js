/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointerArg, pointerWidth } from './pointers.js';

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

test('a pointer argument whole: the low dword, and the high one a 64-bit call carries', ()=>{
    const args = /** @type {number[] & { high?: number[] }} */ ([0x40001000 | 0, -1]);
    assert.equal(pointerArg(args, 0), 0x40001000, 'no high half: the low dword unsigned');
    assert.equal(pointerArg(args, 1), 0xffffffff);
    args.high = [1, 0];
    assert.equal(pointerArg(args, 0), 0x140001000, 'an image at 0x140000000');
});
