/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s graphics, regions, image attributes and string formats, drawing
 * into a bitmap's pixels and read back, by the answers Wine's conformance
 * tests (graphics.c, region.c, image.c, stringformat.c) record from Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gdiplusMachine } from './machine.fixture.js';

const Ok = 0;
const InvalidParameter = 2;
const ObjectBusy = 4;
const ARGB32 = 0x26200a;

/** A 32bpp ARGB bitmap of its own, its graphics. @param {ReturnType<typeof gdiplusMachine>} m */
const canvas = (m, width = 8, height = 8)=>{
    const bitmap = m.make('GdipCreateBitmapFromScan0', [width, height, 0, ARGB32, 0]);
    const graphics = m.make('GdipGetImageGraphicsContext', [bitmap]);
    return { bitmap, graphics };
};
/** @param {ReturnType<typeof gdiplusMachine>} m @param {number} bitmap */
const pixel = (m, bitmap, x = 0, y = 0)=>{
    const out = m.slot(4);
    assert.equal(m.call('GdipBitmapGetPixel', [bitmap, x, y, out]), Ok);
    return m.u32(out);
};

test('a rectangle filled aliased covers the pixels whose centres it holds', ()=>{
    const m = gdiplusMachine();
    const { bitmap, graphics } = canvas(m);
    const brush = m.make('GdipCreateSolidFill', [0xff0000ff]);
    assert.equal(m.call('GdipFillRectangleI', [graphics, brush, 2, 2, 3, 3]), Ok);
    assert.equal(pixel(m, bitmap, 2, 2), 0xff0000ff);
    assert.equal(pixel(m, bitmap, 4, 4), 0xff0000ff);
    assert.equal(pixel(m, bitmap, 5, 5), 0, 'right and bottom edges out');
    assert.equal(pixel(m, bitmap, 1, 2), 0);
});

test('the world transform and the clip both apply to a fill', ()=>{
    const m = gdiplusMachine();
    const { bitmap, graphics } = canvas(m);
    const brush = m.make('GdipCreateSolidFill', [0xff00ff00]);
    m.call('GdipTranslateWorldTransform', [graphics, m.real(4), m.real(0), 0]);
    m.call('GdipSetClipRectI', [graphics, 0, 0, 2, 8, 0]);
    m.call('GdipFillRectangleI', [graphics, brush, 0, 0, 4, 4]);
    assert.equal(pixel(m, bitmap, 4, 0), 0xff00ff00, 'moved by the world transform');
    assert.equal(pixel(m, bitmap, 6, 0), 0, 'outside the clip, which moved with it');
    const bounds = m.slot(16);
    m.call('GdipGetClipBounds', [graphics, bounds]);
    assert.deepEqual(m.f32s(bounds, 4), [0, 0, 2, 8], 'the clip in world space');
});

test('a saved state comes back; a container\'s token is not a saved state\'s', ()=>{
    const m = gdiplusMachine();
    const { graphics } = canvas(m);
    const token = m.slot(4);
    const mode = m.slot(4);
    m.call('GdipSetInterpolationMode', [graphics, 3]);
    m.call('GdipSaveGraphics', [graphics, token]);
    m.call('GdipSetInterpolationMode', [graphics, 2]);
    m.call('GdipGetInterpolationMode', [graphics, mode]);
    assert.equal(m.u32(mode), 7, 'HighQuality is HighQualityBicubic');
    assert.equal(m.call('GdipEndContainer', [graphics, m.u32(token)]), Ok);
    m.call('GdipGetInterpolationMode', [graphics, mode]);
    assert.equal(m.u32(mode), 7, 'unchanged by the wrong kind');
    m.call('GdipRestoreGraphics', [graphics, m.u32(token)]);
    m.call('GdipGetInterpolationMode', [graphics, mode]);
    assert.equal(m.u32(mode), 3);
});

test('a bitmap\'s graphics is busy while its DC is held', ()=>{
    /** @param {string} name @param {number[]} args */
    const gdi32 = (name, args)=>{
        if (name === 'CreateDIBSection')
        {
            m.view.setUint32(args[3], 0x30000, true);
        }
        return 0x77;
    };
    const m = gdiplusMachine({ gdi32 });
    const { graphics } = canvas(m, 2, 2);
    const hdc = m.slot(4);
    assert.equal(m.call('GdipGetDC', [graphics, hdc]), Ok);
    assert.equal(m.call('GdipResetClip', [graphics]), ObjectBusy);
    assert.equal(m.call('GdipReleaseDC', [graphics, m.u32(hdc)]), Ok);
    assert.equal(m.call('GdipResetClip', [graphics]), Ok);
});

test('a region\'s data is its tree in prefix order, a path of integers as shorts', ()=>{
    // region.c's test_getregiondata.
    const m = gdiplusMachine();
    const region = m.make('GdipCreateRegionRectI', [m.dwords([10, 20, 100, 200])]);
    m.call('GdipCombineRegionRectI', [region, m.dwords([50, 30, 10, 20]), 1]);
    const size = m.slot(4);
    m.call('GdipGetRegionDataSize', [region, size]);
    assert.equal(m.u32(size), 60);
    const data = m.slot(64);
    assert.equal(m.call('GdipGetRegionData', [region, data, 64, size]), Ok);
    assert.deepEqual([m.u32(data), m.u32(data + 8), m.u32(data + 12), m.u32(data + 16),
        m.u32(data + 20)], [52, 0xdbc01002, 2, 1, 0x10000000]);
    const path = m.make('GdipCreatePath', [0]);
    m.call('GdipAddPathLine', [path, ...[5, 6, 7, 8].map(m.real)]);
    m.call('GdipAddPathLine', [path, ...[8, 1, 5, 6].map(m.real)]);
    m.call('GdipClosePathFigure', [path]);
    const triangle = m.make('GdipCreateRegionPath', [path]);
    m.call('GdipGetRegionData', [triangle, data, 64, size]);
    assert.equal(m.u32(size), 56);
    assert.deepEqual([m.u32(data + 20), m.u32(data + 32)], [32, 0x4000]);
    assert.deepEqual([m.view.getInt16(data + 36, true), m.view.getInt16(data + 38, true)], [5, 6]);
    assert.equal(m.u32(data + 52), 0x81010100);
});

test('an infinite region less a pixel is four scans', ()=>{
    // region.c's test_excludeinfinite.
    const m = gdiplusMachine();
    const region = m.make('GdipCreateRegion', []);
    m.call('GdipCombineRegionRect', [region, m.reals([0, 0, 1, 1]), 4]);
    const count = m.slot(4);
    m.call('GdipGetRegionScansCount', [region, count, 0]);
    assert.equal(m.u32(count), 4);
    const scans = m.slot(64);
    m.call('GdipGetRegionScans', [region, scans, count, 0]);
    assert.deepEqual(m.f32s(scans + 16, 4), [-4194304, 0, 4194304, 1]);
    assert.deepEqual(m.f32s(scans + 32, 4), [1, 0, 4194303, 1]);
});

test('an image drawn through a colour matrix lays the adjusted colour', ()=>{
    const m = gdiplusMachine();
    const { bitmap, graphics } = canvas(m, 4, 4);
    const source = m.make('GdipCreateBitmapFromScan0', [1, 1, 0, ARGB32, 0]);
    m.call('GdipBitmapSetPixel', [source, 0, 0, 0xffff0000]);
    const attributes = m.make('GdipCreateImageAttributes', []);
    // Red into green.
    const matrix = Array.from({ length: 25 }, (_, i)=>(i === 1 || i === 18 || i === 24 ? 1 : 0));
    assert.equal(m.call('GdipSetImageAttributesColorMatrix', [attributes, 0, 1,
        m.reals(matrix), 0, 0]), Ok);
    m.call('GdipSetInterpolationMode', [graphics, 5]);
    assert.equal(m.call('GdipDrawImageRectRectI', [graphics, source, 0, 0, 2, 2, 0, 0, 1, 1, 2,
        attributes, 0, 0]), Ok);
    assert.equal(pixel(m, bitmap, 1, 1), 0xff00ff00);
});

test('the generic typographic format is one object, changed by whoever changes it', ()=>{
    // stringformat.c's test_getgenerictypographic.
    const m = gdiplusMachine();
    const first = m.make('GdipStringFormatGetGenericTypographic', []);
    assert.equal(m.make('GdipStringFormatGetGenericTypographic', []), first);
    const flags = m.slot(4);
    m.call('GdipGetStringFormatFlags', [first, flags]);
    assert.equal(m.u32(flags), 0x6004);
    m.call('GdipSetStringFormatFlags', [first, 0x1000]);
    assert.equal(m.call('GdipDeleteStringFormat', [first]), Ok);
    m.call('GdipGetStringFormatFlags', [first, flags]);
    assert.equal(m.u32(flags), 0x1000, 'still there, still changed');
    assert.equal(m.call('GdipSetStringFormatTabStops', [first, m.real(-10), 1, m.reals([1])]),
        6, 'a negative first offset is NotImplemented');
    assert.equal(m.call('GdipSetStringFormatAlign', [first, 3]), InvalidParameter);
});
