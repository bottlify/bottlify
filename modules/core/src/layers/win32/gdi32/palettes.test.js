/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The palette calls a 32-bit display still answers, and the small entry
 * points beside them: a bitmap's size in millimetres, the font mapper's
 * aspect filter, the device's pens and brushes, comments, escapes, the
 * Windows 95 owner call, and PlgBlt's parallelogram.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { painted } from './fixtures.test.js';

const LOGPALETTE = 0x1000;
const ENTRIES = 0x1400;
const OUT = 0x2000;
const CLR_INVALID = 0xffffffff;
const PC_RESERVED = 0x01;

/**
 * A palette of the entries given, each [red, green, blue, flags].
 *
 * @param {ReturnType<typeof painted>} machine @param {number[][]} entries
 */
function palette(machine, entries){
    const { view, fns } = machine;
    view.setUint16(LOGPALETTE, 0x300, true);
    view.setUint16(LOGPALETTE + 2, entries.length, true);
    entries.forEach((entry, index)=>entry.forEach((value, at)=>
        view.setUint8(LOGPALETTE + 4 + index * 4 + at, value)));
    return fns.CreatePalette.handler([LOGPALETTE]);
}

/** @param {ReturnType<typeof painted>} machine @param {number} handle */
function entriesOf(machine, handle){
    const count = machine.fns.GetPaletteEntries.handler([handle, 0, 256, OUT]);
    return Array.from({ length: count }, (_, index)=>[0, 1, 2, 3].map(at=>
        machine.view.getUint8(OUT + index * 4 + at)));
}

test('GetNearestPaletteIndex answers the entry nearest a colour, the first of any tie', ()=>{
    const machine = painted(1, 1);
    const { fns } = machine;
    const handle = palette(machine, [[0, 0, 0, 0], [0xff, 0, 0, 0], [0, 0xff, 0, 0],
        [0xff, 0, 0, 0]]);
    assert.equal(fns.GetNearestPaletteIndex.handler([handle, 0x0000f0]), 1, 'red, nearly');
    assert.equal(fns.GetNearestPaletteIndex.handler([handle, 0x00ff00]), 2);
    assert.equal(fns.GetNearestPaletteIndex.handler([handle, 0x101010]), 0);
    assert.equal(fns.GetNearestPaletteIndex.handler([0x9999, 0]), CLR_INVALID, 'no palette');
    assert.equal(fns.GetNearestPaletteIndex.argBytes, 8);
});

test('ResizePalette cuts and grows, with black, and never to nothing', ()=>{
    // Wine's test_resize_palette.
    const machine = painted(1, 1);
    const { fns } = machine;
    const handle = palette(machine, Array.from({ length: 8 }, (_, index)=>
        [index * 0x10, 0x20, 0x30, 0]));
    assert.equal(fns.ResizePalette.handler([handle, 10]), 1);
    assert.equal(entriesOf(machine, handle).length, 10);
    assert.deepEqual(entriesOf(machine, handle)[9], [0, 0, 0, 0]);
    assert.equal(fns.ResizePalette.handler([handle, 0]), 0);
    assert.equal(entriesOf(machine, handle).length, 10, 'unchanged by the refusal');
    assert.equal(fns.ResizePalette.handler([handle, 2]), 1);
    assert.deepEqual(entriesOf(machine, handle), [[0, 0x20, 0x30, 0], [0x10, 0x20, 0x30, 0]]);
    assert.equal(fns.ResizePalette.handler([fns.GetStockObject.handler([15]), 4]), 0,
        'the stock palette is the system\'s');
    assert.equal(fns.ResizePalette.argBytes, 8);
});

test('AnimatePalette changes only the entries reserved for it', ()=>{
    const machine = painted(1, 1);
    const { fns, view } = machine;
    const handle = palette(machine, [[1, 1, 1, 0], [2, 2, 2, PC_RESERVED], [3, 3, 3, PC_RESERVED]]);
    [[9, 9, 9, PC_RESERVED], [8, 8, 8, PC_RESERVED]].forEach((entry, index)=>entry.forEach(
        (value, at)=>view.setUint8(ENTRIES + index * 4 + at, value)));
    assert.equal(fns.AnimatePalette.handler([handle, 0, 2, ENTRIES]), 1);
    assert.deepEqual(entriesOf(machine, handle), [[1, 1, 1, 0], [8, 8, 8, PC_RESERVED],
        [3, 3, 3, PC_RESERVED]], 'the first is not reserved and keeps its colour');
    assert.equal(fns.AnimatePalette.handler([handle, 3, 1, ENTRIES]), 0, 'past the end');
    assert.equal(fns.AnimatePalette.handler([fns.GetStockObject.handler([15]), 0, 1, ENTRIES]),
        0, 'the stock palette');
    assert.equal(fns.AnimatePalette.argBytes, 16);
});

test('a display of 32 bits has no system palette to give up or to update from', ()=>{
    const { fns, dc } = painted(1, 1);
    assert.equal(fns.SetSystemPaletteUse.handler([dc, 2]), 0, 'SYSPAL_ERROR');
    assert.equal(fns.GetSystemPaletteUse.handler([dc]), 1, 'still SYSPAL_STATIC');
    assert.equal(fns.UpdateColors.handler([dc]), 1);
    assert.equal(fns.UpdateColors.handler([0x7777]), 0);
    assert.equal(fns.SetSystemPaletteUse.argBytes, 8);
    assert.equal(fns.UpdateColors.argBytes, 4);
});

test('the aspect filter is the device\'s once the mapper is asked to filter', ()=>{
    const { fns, dc, view } = painted(1, 1);
    view.setInt32(OUT, -1, true);
    assert.equal(fns.GetAspectRatioFilterEx.handler([dc, OUT]), 1);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [0, 0]);
    fns.SetMapperFlags.handler([dc, 1]);
    fns.GetAspectRatioFilterEx.handler([dc, OUT]);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [96, 96]);
    assert.equal(fns.GetAspectRatioFilterEx.handler([dc, 0]), 0);
    assert.equal(fns.GetAspectRatioFilterEx.argBytes, 8);
});

test('a bitmap keeps the size in millimetres a program gives it', ()=>{
    const { fns, view, bitmap } = painted(1, 1);
    assert.equal(fns.GetBitmapDimensionEx.handler([bitmap, OUT]), 1);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [0, 0]);
    assert.equal(fns.SetBitmapDimensionEx.handler([bitmap, 250, -40, OUT]), 1);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [0, 0],
        'the old size written out');
    assert.equal(fns.SetBitmapDimensionEx.handler([bitmap, 1, 2, 0]), 1);
    fns.GetBitmapDimensionEx.handler([bitmap, OUT]);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [1, 2]);
    assert.equal(fns.SetBitmapDimensionEx.handler([fns.CreateSolidBrush.handler([0]), 1, 1, 0]),
        0, 'not a bitmap');
    assert.equal(fns.SetBitmapDimensionEx.argBytes, 16);
    assert.equal(fns.GetBitmapDimensionEx.argBytes, 8);
});

test('EnumObjects hands each pen and brush to the callback until it answers zero', async()=>{
    /** @type {number[][]} */
    const seen = [];
    let budget = 3;
    const machine = painted(1, 1, {
        answer: (entry, args)=>{
            seen.push([...machine.bytes.slice(args[0], args[0] + 16)]);
            return --budget > 0 ? 7 : 0;
        },
    });
    const { fns, dc, called } = machine;
    const answer = await fns.EnumObjects.handler([dc, 1, 0x401000, 0x55]);
    assert.equal(answer, 0, 'the callback\'s last answer');
    assert.equal(called.length, 3, 'stopped by the zero');
    assert.equal(called[0][2], 0x55, 'lParam passed through');
    assert.deepEqual(seen[1].slice(0, 16),
        [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0],
        'a solid white pen one pixel wide');

    budget = 100;
    called.length = 0;
    assert.equal(await fns.EnumObjects.handler([dc, 2, 0x401000, 0]), 7);
    assert.equal(called.length, 22, 'sixteen solid brushes, six hatched');
    assert.deepEqual(seen.at(-1)?.slice(0, 12), [2, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0],
        'the last a black cross-hatch');
    assert.equal(fns.EnumObjects.handler([dc, 3, 0x401000, 0]), 0, 'no such kind');
    assert.equal(fns.EnumObjects.handler([dc, 1, 0, 0]), 0, 'no callback');
    assert.equal(fns.EnumObjects.argBytes, 16);
});

test('the comment, the escape and the owner call answer as a display does', ()=>{
    const { fns, dc, bitmap } = painted(1, 1);
    assert.equal(fns.GdiComment.handler([dc, 4, OUT]), 1);
    assert.equal(fns.GdiComment.handler([dc, 4, 0]), 0, 'a comment with no bytes');
    assert.equal(fns.GdiComment.handler([0x7777, 0, 0]), 0);
    assert.equal(fns.DrawEscape.handler([dc, 0x1000, 0, 0]), 0, 'not implemented');
    assert.equal(fns.DrawEscape.handler([0x7777, 0x1000, 0, 0]), 0xffffffff);
    assert.equal(fns.SetObjectOwner.handler([bitmap, 0x1234]), 1);
    assert.equal(fns.SetObjectOwner.handler([0x9999, 0]), 0);
    assert.equal(fns.GdiComment.argBytes, 12);
    assert.equal(fns.DrawEscape.argBytes, 16);
    assert.equal(fns.SetObjectOwner.argBytes, 8);
});

test('PlgBlt carries the rectangle onto the parallelogram, under a mask', ()=>{
    const machine = painted(8, 8);
    const { fns, dc, view, pixel, fill, section } = machine;
    const source = section(2, 2);
    source.put(0, 0, 0xff0000);
    source.put(1, 0, 0x00ff00);
    source.put(0, 1, 0x0000ff);
    source.put(1, 1, 0xffffff);
    const POINTS = 0x1800;
    /** @param {number[]} values */
    const corners = values=>values.forEach((value, index)=>
        view.setInt32(POINTS + index * 4, value, true));

    // Mirrored across the diagonal: the top edge runs down the left, the
    // left edge along the top.
    fill(0);
    corners([0, 0, 0, 4, 4, 0]);
    assert.equal(fns.PlgBlt.handler([dc, POINTS, source.dc, 0, 0, 2, 2, 0, 0, 0]), 1);
    assert.deepEqual([pixel(0, 0), pixel(0, 3), pixel(3, 0), pixel(3, 3), pixel(5, 5)]
        .map(value=>value & 0xffffff), [0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0]);

    // A monochrome mask whose one set bit is the top left.
    const mask = fns.CreateBitmap.handler([2, 2, 1, 1, 0]);
    const maskDc = fns.CreateCompatibleDC.handler([0]);
    fns.SelectObject.handler([maskDc, mask]);
    fns.PatBlt.handler([maskDc, 0, 0, 2, 2, 0x00000042]);
    fns.SetPixel.handler([maskDc, 0, 0, 0xffffff]);
    fns.SelectObject.handler([maskDc, fns.CreateBitmap.handler([1, 1, 1, 1, 0])]);
    fill(0);
    corners([0, 0, 4, 0, 0, 4]);
    assert.equal(fns.PlgBlt.handler([dc, POINTS, source.dc, 0, 0, 2, 2, mask, 0, 0]), 1);
    assert.deepEqual([pixel(0, 0), pixel(3, 0), pixel(0, 3)].map(value=>value & 0xffffff),
        [0xff0000, 0, 0], 'only where the mask is set');
    assert.equal(fns.PlgBlt.handler([dc, POINTS, source.dc, 0, 0, 2, 2, source.bitmap, 0, 0]),
        0, 'a mask that is not monochrome');
    corners([0, 0, 4, 4, 8, 8]);
    assert.equal(fns.PlgBlt.handler([dc, POINTS, source.dc, 0, 0, 2, 2, 0, 0, 0]), 0,
        'three points on a line');
    assert.equal(fns.PlgBlt.handler([dc, POINTS, 0x7777, 0, 0, 2, 2, 0, 0, 0]), 0);
    assert.equal(fns.PlgBlt.argBytes, 40);
});
