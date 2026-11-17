/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s brushes, pens and custom caps, by the answers Wine's conformance
 * tests (brush.c, pen.c, customlinecap.c) record from Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gdiplusMachine } from './machine.fixture.js';

const Ok = 0;
const InvalidParameter = 2;
const OutOfMemory = 3;
const InsufficientBuffer = 5;
const GenericError = 1;
const NotImplemented = 6;

/** @param {number[]} got @param {number[]} want @param {number} [within] */
const near = (got, want, within = 0.001)=>{
    assert.equal(got.length, want.length);
    got.forEach((value, i)=>assert.ok(Math.abs(value - want[i]) <= within,
        `${i}: ${value} against ${want[i]}`));
};

/** @param {ReturnType<typeof gdiplusMachine>} m @param {number} brush @param {string} getter */
const transformOf = (m, brush, getter)=>{
    const matrix = m.make('GdipCreateMatrix', []);
    assert.equal(m.call(getter, [brush, matrix]), Ok);
    const out = m.slot(24);
    m.call('GdipGetMatrixElements', [matrix, out]);
    return m.f32s(out, 6);
};

test('a line brush from two points bounds them, squared about the line, and turns to it', ()=>{
    // brush.c's create_from_pt.
    const m = gdiplusMachine();
    for (const [p1, p2, rect, transform] of [
        [[1, 1], [100, 100], [1, 1, 99, 99], [1, 1, -1, 1, 50.5, -50.5]],
        [[0, 0], [0, 10], [-5, 0, 10, 10], [0, 1, -1, 0, 5, 5]],
        [[0, 0], [100, 1], [0, 0, 100, 1], [1, 0.01, -0.02, 2, 0.01, -1]],
        [[10, 10], [-90, 10], [-90, -40, 100, 100], [-1, 0, 0, -1, -80, 20]],
    ])
    {
        const brush = m.make('GdipCreateLineBrush', [m.points([p1]), m.points([p2]), 1, 2, 0]);
        const out = m.slot(16);
        m.call('GdipGetLineRect', [brush, out]);
        near(m.f32s(out, 4), rect);
        near(transformOf(m, brush, 'GdipGetLineTransform'), transform);
    }
    const out = m.slot(8);
    assert.equal(m.call('GdipCreateLineBrush', [m.points([[1, 1]]), m.points([[1, 1]]), 0, 0, 0,
        out]), OutOfMemory, 'two points the same');
});

test('a vertical or angled line brush scales its rectangle about the centre and turns it', ()=>{
    // brush.c's create_from_rect and create_with_angle.
    const m = gdiplusMachine();
    const vertical = m.make('GdipCreateLineBrushFromRect', [m.reals([10, -12, 100, 105]), 1, 2,
        1, 0]);
    near(transformOf(m, vertical, 'GdipGetLineTransform'), [0, 1.05, -0.952, 0, 98.571, -22.5]);
    const angled = m.make('GdipCreateLineBrushFromRectWithAngle', [m.reals([0, 0, 100, 10]), 1, 2,
        m.real(-90), 1, 0]);
    near(transformOf(m, angled, 'GdipGetLineTransform'), [0, -0.1, 10, 0, 0, 10]);
    const out = m.slot(8);
    assert.equal(m.call('GdipCreateLineBrushFromRectWithAngle', [m.reals([1, 3, 1, 2]), 1, 2,
        m.real(90), 1, 4, out]), InvalidParameter, 'a line brush never clamps');
    assert.equal(m.call('GdipCreateLineBrushFromRectWithAngle', [m.reals([1, 3, 0, 1]), 1, 2,
        m.real(90), 1, 3, out]), OutOfMemory, 'a rectangle of no width');
});

test('a gradient\'s blend runs from 0 to 1; its preset blend is none until set', ()=>{
    // brush.c's test_lineblend and test_linelinearblend.
    const m = gdiplusMachine();
    const brush = m.make('GdipCreateLineBrush', [m.points([[1, 1]]), m.points([[100, 100]]), 0, 0,
        0]);
    const factors = m.reals([0, 0.1, 0.5, 0.9, 1]);
    const positions = m.reals([0, 0.2, 0.5, 0.8, 1]);
    assert.equal(m.call('GdipSetLineBlend', [brush, factors + 4, positions + 4, 4]),
        InvalidParameter, 'not from 0');
    assert.equal(m.call('GdipSetLineBlend', [brush, factors, positions, 5]), Ok);
    const [f, p] = [m.slot(24), m.slot(24)];
    assert.equal(m.call('GdipGetLineBlend', [brush, f, p, 4]), InsufficientBuffer);
    assert.equal(m.call('GdipGetLineBlend', [brush, f, p, 5]), Ok);
    near(m.f32s(f, 5), [0, 0.1, 0.5, 0.9, 1]);
    const colors = m.slot(24);
    assert.equal(m.call('GdipGetLinePresetBlend', [brush, colors, p, 2]), GenericError);
    m.call('GdipSetLineLinearBlend', [brush, m.real(0.6), m.real(0.8)]);
    m.call('GdipGetLineBlend', [brush, f, p, 3]);
    near(m.f32s(f, 3), [0, 0.8, 0]);
    near(m.f32s(p, 3), [0, 0.6, 1]);
});

test('a path gradient\'s colours: white everywhere, counted once while they are all one', ()=>{
    // brush.c's test_gradientsurroundcolorcount and test_pathgradientcenterpoint.
    const m = gdiplusMachine();
    const grad = m.make('GdipCreatePathGradient', [m.points([[3, 0], [0, 4]]), 2, 4]);
    const colors = m.dwords([0xdeadbeef, 0xdeadbeef, 0xdeadbeef]);
    const count = m.dwords([3]);
    assert.equal(m.call('GdipGetPathGradientSurroundColorsWithCount', [grad, colors, count]), Ok);
    assert.deepEqual([m.i32(count), m.u32(colors), m.u32(colors + 4), m.u32(colors + 8)],
        [1, 0xffffffff, 0xffffffff, 0xdeadbeef]);
    const center = m.slot(8);
    m.call('GdipGetPathGradientCenterPoint', [grad, center]);
    near(m.f32s(center, 2), [1.5, 2]);
    assert.equal(m.call('GdipGetPathGradientPath', [grad, 0]), NotImplemented);
});

test('a pen keeps a copy of its brush and hands back a copy', ()=>{
    // pen.c's test_brushfill.
    const m = gdiplusMachine();
    const pen = m.make('GdipCreatePen1', [0xdeadbeef, m.real(4.5), 0]);
    const solid = m.make('GdipCreateSolidFill', [0xabaddeed]);
    m.call('GdipSetPenBrushFill', [pen, solid]);
    const color = m.slot(4);
    m.call('GdipGetPenColor', [pen, color]);
    assert.equal(m.u32(color), 0xabaddeed);
    const first = m.make('GdipGetPenBrushFill', [pen]);
    m.call('GdipSetSolidFillColor', [first, 0xbeadfeed]);
    const second = m.make('GdipGetPenBrushFill', [pen]);
    assert.notEqual(first, second);
    m.call('GdipGetSolidFillColor', [second, color]);
    assert.equal(m.u32(color), 0xabaddeed);
});

test('a pen\'s dashes: a custom array of positive lengths, read back no more than it has', ()=>{
    // pen.c's test_dasharray and test_compoundarray.
    const m = gdiplusMachine();
    const pen = m.make('GdipCreatePen1', [0xdeadbeef, m.real(10), 0]);
    const dashes = m.reals([10, 11, 12, 13, 14]);
    assert.equal(m.call('GdipSetPenDashArray', [pen, dashes, 5]), Ok);
    const out = m.slot(24);
    assert.equal(m.call('GdipGetPenDashArray', [pen, out, 6]), InvalidParameter);
    assert.equal(m.call('GdipGetPenDashArray', [pen, out, 1]), Ok);
    assert.equal(m.call('GdipSetPenDashArray', [pen, m.reals([1, 1, 0, 1, 1]), 5]),
        InvalidParameter);
    assert.equal(m.call('GdipSetPenCompoundArray', [pen, m.reals([0.2, 0.6, 0.4, 0.8]), 4]),
        InvalidParameter, 'not in order');
    assert.equal(m.call('GdipSetPenCompoundArray', [pen, m.reals([0.2, 0.4, 0.6]), 3]),
        InvalidParameter, 'not in pairs');
    assert.equal(m.call('GdipSetPenCompoundArray', [pen, m.reals([0.2, 0.4, 0.6, 0.8]), 4]), Ok);
});

test('an adjustable arrow cap stands on a triangle, inset by its height over its width', ()=>{
    // customlinecap.c's test_create_adjustable_cap.
    const m = gdiplusMachine();
    const cap = m.make('GdipCreateAdjustableArrowCap', [m.real(17), m.real(15), 1]);
    const out = m.slot(4);
    m.call('GdipGetCustomLineCapBaseCap', [cap, out]);
    assert.equal(m.u32(out), 3);
    m.call('GdipGetCustomLineCapBaseInset', [cap, out]);
    near(m.f32s(out, 1), [17 / 15], 1e-5);
    assert.equal(m.call('GdipSetCustomLineCapBaseCap', [cap, 0x11]), InvalidParameter);
    const path = m.make('GdipCreatePath', [0]);
    m.call('GdipAddPathRectangle', [path, ...[5, 5, 10, 10].map(m.real)]);
    const custom = m.make('GdipCreateCustomLineCap', [0, path, 0, m.real(0)]);
    m.call('GdipGetCustomLineCapType', [custom, out]);
    assert.equal(m.u32(out), 0);
    assert.equal(m.call('GdipGetAdjustableArrowCapHeight', [custom, out]), InvalidParameter);
});
