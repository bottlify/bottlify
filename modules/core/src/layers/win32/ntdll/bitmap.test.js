/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The RTL_BITMAP routines, as Wine's rtlbitmap test says Windows answers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBitmapFunctions } from './bitmap.js';

const HEADER = 0x10;
const RUNS = 0x40;
const OUT = 0x30;
const BUFFER = 0x100;
const BITS = 2048;

function machine(){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    const fns = createBitmapFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
    });
    /** @param {string} name @param {...number} args */
    const call = (name, ...args)=>/** @type {any} */ (fns)[name].handler([HEADER, ...args]);
    call('RtlInitializeBitMap', BUFFER, BITS);
    const buff = memory.subarray(BUFFER, BUFFER + BITS / 8);
    return { memory, view, call, buff, fns };
}

test('initialising writes the header only; all bits go to whole ULONGs', ()=>{
    const { view, call, buff } = machine();
    assert.deepEqual([view.getUint32(HEADER, true), view.getUint32(HEADER + 4, true)],
        [BITS, BUFFER]);
    call('RtlInitializeBitMap', BUFFER, 1);
    call('RtlSetAllBits');
    assert.deepEqual([...buff.subarray(0, 5)], [0xff, 0xff, 0xff, 0xff, 0]);
    buff.fill(0xff);
    call('RtlClearAllBits');
    assert.deepEqual([...buff.subarray(0, 5)], [0, 0, 0, 0, 0xff]);
});

test('setting, clearing and testing runs across bytes', ()=>{
    const { call, buff } = machine();
    call('RtlSetBits', 7, 10);
    assert.deepEqual([...buff.subarray(0, 3)], [0x80, 0xff, 1]);
    assert.equal(call('RtlAreBitsSet', 7, 10), 1);
    assert.equal(call('RtlAreBitsSet', 6, 11), 0);
    assert.equal(call('RtlAreBitsSet', 7, 11), 0);
    assert.equal(call('RtlCheckBit', 8), 1);
    call('RtlSetBits', BITS - 1, 1);
    assert.equal(buff[BITS / 8 - 1], 0x80);
    assert.equal(call('RtlNumberOfSetBits'), 11);
    assert.equal(call('RtlNumberOfClearBits'), BITS - 11);
    call('RtlClearBits', 7, 2);
    assert.deepEqual([...buff.subarray(0, 2)], [0, 0xfe]);
    assert.equal(call('RtlAreBitsClear', 7, 2), 1);
});

test('a search goes from the hint round to the start, and can flip what it found', ()=>{
    const { call, buff } = machine();
    buff.fill(0xff);
    call('RtlClearBits', 40, 77);
    assert.equal(call('RtlFindClearBitsAndSet', 77, 50), 40);
    assert.equal(call('RtlAreBitsSet', 40, 77), 1);
    assert.equal(call('RtlFindClearBits', 1, 0) >>> 0, 0xffffffff);
    buff.fill(0);
    call('RtlSetBits', 40, 77);
    assert.equal(call('RtlFindSetBitsAndClear', 77, 0), 40);
    assert.equal(call('RtlAreBitsClear', 40, 77), 1);
});

test('runs: the first ones, or the longest; the next one forward; the longest', ()=>{
    const { call, view, buff } = machine();
    call('RtlSetBits', 7, 19);
    call('RtlSetBits', 101, 3);
    call('RtlSetBits', 1877, 33);
    const runs = (/** @type {number} */ n)=>Array.from({ length: n * 2 },
        (_, i)=>view.getUint32(RUNS + i * 4, true));
    assert.equal(call('RtlFindSetRuns', RUNS, 2, 0), 2);
    assert.deepEqual(runs(2), [7, 19, 101, 3]);
    assert.equal(call('RtlFindSetRuns', RUNS, 2, 1), 2);
    assert.deepEqual(runs(2), [1877, 33, 7, 19]);
    assert.equal(call('RtlFindLongestRunSet', OUT), 33);
    assert.equal(view.getUint32(OUT, true), 1877);
    buff.fill(0);
    assert.equal(call('RtlFindLongestRunSet', OUT), 0);
    // 62 bits, the last byte set: its run stops at the size.
    buff.fill(0, 0, 8);
    buff[7] = 0xff;
    call('RtlInitializeBitMap', BUFFER, 62);
    assert.equal(call('RtlFindNextForwardRunSet', 0, OUT), 6);
    assert.equal(view.getUint32(OUT, true), 56);
});

test('the most and least significant bits of a 64-bit value, -1 for none', ()=>{
    const { fns } = machine();
    assert.equal(fns.RtlFindMostSignificantBit.handler([0, 0x80000000]), 63);
    assert.equal(fns.RtlFindMostSignificantBit.handler([0xffff, 0]), 15);
    assert.equal(fns.RtlFindLeastSignificantBit.handler([0, 0x10]), 36);
    assert.equal(fns.RtlFindLeastSignificantBit.handler([0, 0]), 0xff);
});
