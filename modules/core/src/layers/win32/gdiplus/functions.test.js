/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiplusFunctions } from './functions.js';

const Ok = 0;
const InvalidParameter = 2;
const NotImplemented = 6;
const WrongState = 8;
const UnsupportedGdiplusVersion = 17;
const PixelFormat32bppARGB = 0x26200a;
const PixelFormat24bppRGB = 0x21808;
const PixelFormat8bppIndexed = 0x30803;

/** @param {4 | 8} [pointerSize] */
function machine(pointerSize = 4){
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let heap = 0x10000;
    /** @type {string[]} */
    const said = [];
    /** @type {number[]} */
    const freed = [];
    const fns = createGdiplusFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readMemory: (address, length)=>memory.subarray(address, address + length),
        allocate: bytes=>{
            const at = heap;
            heap += Math.ceil(bytes / 16) * 16;
            return at;
        },
        free: address=>freed.push(address),
        pointerSize,
        divergence: api=>said.push(api),
    });
    return { memory, view, fns, said, freed };
}

test('GdiplusStartup takes versions 1 to 3 and hands a token', ()=>{
    // Wine's gdiplus test_startup: version 0 (and 42) is UnsupportedGdiplusVersion.
    const { view, fns } = machine();
    view.setUint32(0x100, 1, true);
    assert.equal(fns.GdiplusStartup.handler([0x200, 0x100, 0]), Ok);
    assert.notEqual(view.getUint32(0x200, true), 0, 'a token');
    view.setUint32(0x100, 0, true);
    assert.equal(fns.GdiplusStartup.handler([0x200, 0x100, 0]), UnsupportedGdiplusVersion);
    view.setUint32(0x100, 42, true);
    assert.equal(fns.GdiplusStartup.handler([0x200, 0x100, 0]), UnsupportedGdiplusVersion);
    assert.equal(fns.GdiplusStartup.handler([0, 0x100, 0]), InvalidParameter);
});

test('a bitmap of its own pixels: its size and format, its pixels locked in place', ()=>{
    const { memory, view, fns } = machine();
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([3, 2, 0, PixelFormat24bppRGB, 0, 0x300]),
        Ok);
    const bitmap = view.getUint32(0x300, true);
    fns.GdipGetImageWidth.handler([bitmap, 0x310]);
    fns.GdipGetImageHeight.handler([bitmap, 0x314]);
    fns.GdipGetImagePixelFormat.handler([bitmap, 0x318]);
    assert.deepEqual([0x310, 0x314, 0x318].map(at=>view.getUint32(at, true)),
        [3, 2, PixelFormat24bppRGB]);

    // The whole bitmap, then locked again before the unlock.
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0, 3, PixelFormat24bppRGB, 0x400]), Ok);
    assert.deepEqual([0, 4, 8, 12].map(at=>view.getInt32(0x400 + at, true)),
        [3, 2, 12, PixelFormat24bppRGB], 'rows of nine bytes padded to twelve');
    const scan0 = view.getUint32(0x410, true);
    assert.notEqual(scan0, 0);
    assert.ok(memory.subarray(scan0, scan0 + 24).every(byte=>byte === 0), 'zeroed');
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0, 3, PixelFormat24bppRGB, 0x400]),
        WrongState, 'already locked');
    memory.set([1, 2, 3], scan0 + 12 + 3);
    assert.equal(fns.GdipBitmapUnlockBits.handler([bitmap, 0x400]), Ok);
    assert.equal(fns.GdipBitmapUnlockBits.handler([bitmap, 0x400]), WrongState, 'not locked');

    // A rectangle: the pixel at (1, 1) is where the program wrote it.
    [1, 1, 2, 1].forEach((value, i)=>view.setInt32(0x500 + i * 4, value, true));
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0x500, 1, PixelFormat24bppRGB, 0x400]),
        Ok);
    const at = view.getUint32(0x410, true);
    assert.deepEqual([...memory.subarray(at, at + 3)], [1, 2, 3]);
    fns.GdipBitmapUnlockBits.handler([bitmap, 0x400]);
    [2, 1, 2, 1].forEach((value, i)=>view.setInt32(0x500 + i * 4, value, true));
    assert.equal(fns.GdipBitmapLockBits.handler([bitmap, 0x500, 1, PixelFormat24bppRGB, 0x400]),
        InvalidParameter, 'a rectangle past the bitmap');
});

test('over the caller\'s pixels, a clone of its own, a dispose that frees only its own', ()=>{
    const { memory, view, fns, freed } = machine();
    memory.set([10, 20, 30, 40, 50, 60, 70, 80], 0x800);
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([2, 1, 8, PixelFormat32bppARGB, 0x800,
        0x300]), Ok);
    const bitmap = view.getUint32(0x300, true);
    fns.GdipBitmapLockBits.handler([bitmap, 0, 1, PixelFormat32bppARGB, 0x400]);
    assert.equal(view.getUint32(0x410, true), 0x800, 'the caller\'s own pixels');
    fns.GdipBitmapUnlockBits.handler([bitmap, 0x400]);

    assert.equal(fns.GdipCloneImage.handler([bitmap, 0x304]), Ok);
    const clone = view.getUint32(0x304, true);
    fns.GdipBitmapLockBits.handler([clone, 0, 1, PixelFormat32bppARGB, 0x400]);
    const copied = view.getUint32(0x410, true);
    assert.notEqual(copied, 0x800);
    assert.deepEqual([...memory.subarray(copied, copied + 8)], [10, 20, 30, 40, 50, 60, 70, 80]);

    assert.equal(fns.GdipDisposeImage.handler([bitmap]), Ok);
    assert.deepEqual(freed, [], 'the caller\'s pixels are the caller\'s');
    assert.equal(fns.GdipDisposeImage.handler([clone]), Ok);
    assert.deepEqual(freed, [copied]);
    assert.equal(fns.GdipDisposeImage.handler([clone]), InvalidParameter, 'disposed already');
});

test('the bitmaps refused, and the palette of one without', ()=>{
    const { view, fns } = machine();
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([0, 1, 0, PixelFormat32bppARGB, 0,
        0x300]), InvalidParameter, 'no width');
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([1, 1, 0, PixelFormat32bppARGB, 0x800,
        0x300]), InvalidParameter, 'pixels with no stride');
    assert.equal(fns.GdipCreateBitmapFromScan0.handler([1, 1, 0, PixelFormat8bppIndexed, 0,
        0x300]), InvalidParameter, 'an indexed format is not kept');
    fns.GdipCreateBitmapFromScan0.handler([1, 1, 0, PixelFormat32bppARGB, 0, 0x300]);
    const bitmap = view.getUint32(0x300, true);
    assert.equal(fns.GdipGetImagePaletteSize.handler([bitmap, 0x310]), Ok);
    assert.equal(view.getUint32(0x310, true), 8, 'the header, no entries');
    view.setUint32(0x320, 0xffffffff, true);
    assert.equal(fns.GdipGetImagePalette.handler([bitmap, 0x320, 8]), Ok);
    assert.equal(view.getUint32(0x324, true), 0, 'no colours');
});

test('a 64-bit process\'s handles and Scan0 are pointers', ()=>{
    const { view, fns } = machine(8);
    view.setUint32(0x300 + 4, 0xcccccccc, true);
    fns.GdipCreateBitmapFromScan0.handler([1, 1, 0, PixelFormat32bppARGB, 0, 0x300]);
    assert.equal(view.getUint32(0x304, true), 0, 'the handle\'s high half written');
    const bitmap = view.getUint32(0x300, true);
    fns.GdipBitmapLockBits.handler([bitmap, 0, 1, PixelFormat32bppARGB, 0x400]);
    assert.notEqual(view.getUint32(0x410, true), 0, 'Scan0 at 16');
});

test('drawing and decoding answer NotImplemented, said once each', ()=>{
    const { view, fns, said } = machine();
    assert.equal(fns.GdipCreateFromHDC.handler([0x1234, 0x300]), Ok);
    const graphics = view.getUint32(0x300, true);
    assert.equal(fns.GdipSetInterpolationMode.handler([graphics, 7]), Ok);
    assert.equal(fns.GdipSetInterpolationMode.handler([graphics, 8]), InvalidParameter);
    assert.equal(fns.GdipDrawImageI.handler(), NotImplemented);
    assert.equal(fns.GdipDrawImageI.handler(), NotImplemented);
    assert.equal(fns.GdipCreateBitmapFromStream.handler(), NotImplemented);
    assert.deepEqual(said, ['GdipDrawImageI', 'GdipCreateBitmapFromStream']);
    assert.equal(fns.GdipDeleteGraphics.handler([graphics]), Ok);
});
