/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s matrices, paths and path iterators, by the answers Wine's
 * conformance tests (matrix.c, graphicspath.c, pathiterator.c) record from
 * Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gdiplusMachine } from './machine.fixture.js';

const Ok = 0;
const InvalidParameter = 2;
const OutOfMemory = 3;
const Start = 0;
const Line = 1;
const Bezier = 3;
const Close = 0x80;

/** @param {number[]} got @param {number[]} want @param {number} [within] */
const near = (got, want, within = 0.05)=>{
    assert.equal(got.length, want.length, `${got} against ${want}`);
    got.forEach((value, i)=>assert.ok(Math.abs(value - want[i]) <= within,
        `${i}: ${value} against ${want[i]}`));
};

test('a matrix inverts, refuses to invert one with no inverse, and multiplies in order', ()=>{
    const m = gdiplusMachine();
    const matrix = m.make('GdipCreateMatrix2', [3, -2, 5, 2, 6, 3].map(m.real));
    assert.equal(m.call('GdipInvertMatrix', [matrix]), Ok);
    const out = m.slot(24);
    m.call('GdipGetMatrixElements', [matrix, out]);
    near(m.f32s(out, 6), [2 / 16, 2 / 16, -5 / 16, 3 / 16, 3 / 16, -21 / 16], 1e-6);
    const flat = m.make('GdipCreateMatrix2', [2, -1, 6, -3, 2.2, 3].map(m.real));
    assert.equal(m.call('GdipInvertMatrix', [flat]), InvalidParameter);
    const answer = m.slot(4);
    assert.equal(m.call('GdipIsMatrixInvertible', [0xdeadbeef, 0]), InvalidParameter);
    m.call('GdipIsMatrixInvertible', [flat, answer]);
    assert.equal(m.u32(answer), 0);

    // Translating, appended, moves the result; prepended, the input.
    const moved = m.make('GdipCreateMatrix2', [3, -2, 5, 2, 6, 3].map(m.real));
    m.call('GdipTranslateMatrix', [moved, m.real(1), m.real(-2), 1]);
    m.call('GdipGetMatrixElements', [moved, out]);
    near(m.f32s(out, 6), [3, -2, 5, 2, 7, 1]);
    m.call('GdipTranslateMatrix', [moved, m.real(-3), m.real(5), 0]);
    m.call('GdipGetMatrixElements', [moved, out]);
    near(m.f32s(out, 6), [3, -2, 5, 2, 23, 17]);
});

test('a parallelogram matrix takes the rectangle onto three points', ()=>{
    const m = gdiplusMachine();
    const rect = m.reals([0, 0, 10, 20]);
    const points = m.points([[1, 2], [11, 2], [1, 42]]);
    const matrix = m.make('GdipCreateMatrix3', [rect, points]);
    const out = m.slot(24);
    m.call('GdipGetMatrixElements', [matrix, out]);
    near(m.f32s(out, 6), [1, 0, 0, 2, 1, 2]);
});

test('an arc is quarters cut on the circle the ellipse stretches, joined by a line', ()=>{
    // graphicspath.c's arc_path: 0 to 90, 0 to 100, -80 to 20.
    const m = gdiplusMachine();
    const path = m.make('GdipCreatePath', [0]);
    const box = [100, 100, 500, 700].map(m.real);
    assert.equal(m.call('GdipAddPathArc', [path, ...box, m.real(0), m.real(90)]), Ok);
    assert.equal(m.call('GdipAddPathArc', [path, ...box, m.real(0), m.real(100)]), Ok);
    assert.equal(m.call('GdipAddPathArc', [path, ...box, m.real(-80), m.real(100)]), Ok);
    const { points, types } = m.pathData(path);
    near(points.slice(0, 4).flat(), [600, 450, 600, 643.3, 488.1, 800, 350, 800], 0.4);
    assert.deepEqual(types.slice(0, 5), [Start, Bezier, Bezier, Bezier, Line]);
    near(points[10], [290.1, 789.8], 0.4);
    near(points.slice(11, 18).flat(), [409.9, 110.2, 544, 156.5, 625.8, 346.2, 592.7, 533.9,
        592.5, 535.3, 592.2, 536.7, 592, 538.1], 0.4);
    assert.equal(m.call('GdipAddPathArc', [path, ...[100, 100, 1, 0].map(m.real), 0, 0]),
        InvalidParameter);
});

test('a cardinal spline puts its controls tension / 3 of the chord about each point', ()=>{
    // graphicspath.c's addcurve_path and addcurve_path3.
    const m = gdiplusMachine();
    const points = m.points([[0, 0], [10, 10], [10, 20], [30, 10]]);
    const path = m.make('GdipCreatePath', [0]);
    assert.equal(m.call('GdipAddPathCurve2', [path, points, 4, m.real(1)]), Ok);
    near(m.pathData(path).points.flat(), [0, 0, 3.3, 3.3, 6.7, 3.3, 10, 10, 13.3, 16.7, 3.3, 20,
        10, 20, 16.7, 20, 23.3, 13.3, 30, 10], 0.1);
    m.call('GdipResetPath', [path]);
    assert.equal(m.call('GdipAddPathCurve3', [path, points, 4, 1, 3, m.real(0)]), InvalidParameter);
    assert.equal(m.call('GdipAddPathCurve3', [path, points, 4, 1, 2, m.real(1)]), Ok);
    near(m.pathData(path).points.flat(), [10, 10, 13.3, 16.7, 3.3, 20, 10, 20, 16.7, 20, 23.3,
        13.3, 30, 10], 0.1);
});

test('a path from points and types keeps only a well-formed one', ()=>{
    // graphicspath.c's test_createpath2.
    const m = gdiplusMachine();
    const points = m.points([[1, 1], [2, 1], [2, 2]]);
    const types = m.slot(4);
    m.memory.set([Start, Line, Start], types);
    const two = m.make('GdipCreatePath2', [points, types, 2, 0]);
    assert.equal(m.pathData(two).points.length, 2);
    const ending = m.make('GdipCreatePath2', [points, types, 3, 0]);
    assert.equal(m.pathData(ending).points.length, 0, 'a path ending on a start');
    const out = m.slot(4);
    assert.equal(m.call('GdipCreatePath2', [points, types, 0, 0, out]), OutOfMemory);
});

test('a reversed path runs every figure backwards, each keeping whether it is closed', ()=>{
    // graphicspath.c's test_reverse.
    const m = gdiplusMachine();
    const pts = Array.from({ length: 7 }, (_, i)=>[i * 5 * (i % 2), 50 - i * 5]);
    const path = m.make('GdipCreatePath', [0]);
    m.call('GdipAddPathLine2', [path, m.points(pts.slice(0, 4)), 4]);
    m.call('GdipClosePathFigure', [path]);
    m.call('GdipAddPathLine2', [path, m.points(pts.slice(4)), 3]);
    m.call('GdipReversePath', [path]);
    const { points, types } = m.pathData(path);
    near(points.flat(), [0, 20, 25, 25, 0, 30, 15, 35, 0, 40, 5, 45, 0, 50]);
    assert.deepEqual(types, [Start, Line, Line, Start, Line, Line, Line | Close]);
});

test('a pie of no width lays down its centre and is refused', ()=>{
    const m = gdiplusMachine();
    const path = m.make('GdipCreatePath', [0]);
    assert.equal(m.call('GdipAddPathPie', [path, ...[0, 0, 0, 60, -90, 24].map(m.real)]),
        InvalidParameter);
    const { points, types } = m.pathData(path);
    near(points.flat(), [0, 30]);
    assert.deepEqual(types, [Start | Close]);
});

test('a widened line is the rectangle the pen covers, a dashed one a rectangle a dash', ()=>{
    // graphicspath.c's widenline_path and widenline_dash_path.
    const m = gdiplusMachine();
    const pen = m.make('GdipCreatePen1', [0xffffffff, m.real(10), 2]);
    const path = m.make('GdipCreatePath', [0]);
    m.call('GdipAddPathLine', [path, ...[5, 10, 50, 10].map(m.real)]);
    assert.equal(m.call('GdipWidenPath', [path, pen, 0, m.real(1)]), Ok);
    near(m.pathData(path).points.flat(), [5, 5, 50, 5, 50, 15, 5, 15]);
    m.call('GdipResetPath', [path]);
    m.call('GdipAddPathLine', [path, ...[5, 5, 50, 5].map(m.real)]);
    m.call('GdipSetPenDashStyle', [pen, 1]);
    m.call('GdipWidenPath', [path, pen, 0, m.real(1)]);
    const { points, types } = m.pathData(path);
    near(points.flat(), [5, 0, 35, 0, 35, 10, 5, 10, 45, 0, 50, 0, 50, 10, 45, 10]);
    assert.deepEqual(types, [Start, Line, Line, Line | Close, Start, Line, Line, Line | Close]);
});

test('a warp takes the source rectangle onto a parallelogram, then the matrix', ()=>{
    // graphicspath.c's warp_path and transformed_warp_path.
    const m = gdiplusMachine();
    const dest = m.points([[8, 0], [64, 0], [0, 64]]);
    const path = m.make('GdipCreatePath', [0]);
    m.call('GdipAddPathRectangle', [path, ...[-1, 0.5, 32, 16].map(m.real)]);
    const matrix = m.make('GdipCreateMatrix2', [2, 0, 0, 1, 1.5, 4].map(m.real));
    assert.equal(m.call('GdipWarpPath', [path, matrix, dest, 3, ...[0, 0, 128, 128].map(m.real),
        0, m.real(0.25)]), Ok);
    near(m.pathData(path).points.flat(), [16.56, 4.25, 44.56, 4.25, 42.56, 12.25, 14.56, 12.25]);
});

test('an iterator walks figures, then runs of one type within the figure reached', ()=>{
    // pathiterator.c's test_nextpathtype.
    const m = gdiplusMachine();
    const path = m.make('GdipCreatePath', [0]);
    m.call('GdipAddPathLine', [path, ...[0, 0, 10, 30].map(m.real)]);
    m.call('GdipAddPathRectangle', [path, ...[1, 2, 3, 4].map(m.real)]);
    m.call('GdipAddPathEllipse', [path, ...[0, 0, 35, 70].map(m.real)]);
    const it = m.slot(8);
    m.call('GdipCreatePathIter', [it, path]);
    const handle = m.u32(it);
    const [count, type, start, end, closed] = [m.slot(4), m.slot(4), m.slot(4), m.slot(4),
        m.slot(4)];
    m.call('GdipPathIterNextPathType', [handle, count, type, start, end]);
    assert.deepEqual([m.i32(count), m.memory[type]], [0, 255], 'no figure reached yet');
    m.call('GdipPathIterNextSubpath', [handle, count, start, end, closed]);
    assert.deepEqual([m.i32(count), m.i32(start), m.i32(end), m.u32(closed)], [2, 0, 1, 0]);
    m.call('GdipPathIterNextSubpath', [handle, count, start, end, closed]);
    m.call('GdipPathIterNextSubpath', [handle, count, start, end, closed]);
    assert.deepEqual([m.i32(count), m.i32(start), m.i32(end), m.u32(closed)], [13, 6, 18, 1]);
    m.call('GdipPathIterNextPathType', [handle, count, type, start, end]);
    assert.deepEqual([m.i32(count), m.memory[type], m.i32(start), m.i32(end)], [13, Bezier, 6, 18]);
    m.call('GdipPathIterNextSubpath', [handle, count, start, end, closed]);
    assert.deepEqual([m.i32(count), m.i32(start), m.i32(end), m.u32(closed)], [0, 0, 0, 1]);
});
