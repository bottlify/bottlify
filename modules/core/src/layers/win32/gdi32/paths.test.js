/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Paths, and the line and polygon calls that draw or record them: what a
 * path holds after each call, what the path calls answer in each state Wine's
 * path tests put a DC in, and the pixels the drawing calls leave.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PT_BEZIERTO, PT_CLOSEFIGURE, PT_LINETO, PT_MOVETO, createPath, ellipseCurves, figuresOf,
    pathClose, pathFigure, pathLineTo, pathMoved, widened,
} from './paths.js';
import { painted, pens } from './fixtures.test.js';

const ERROR_CAN_NOT_COMPLETE = 1003;
const ERROR_INVALID_PARAMETER = 87;
const GDI_ERROR = 0xffffffff;
const RGN_COPY = 5;
const RGN_OR = 2;
const AD_CLOCKWISE = 2;

const POINTS = 0x1000;
const TYPES = 0x1800;
const COUNTS = 0x1c00;
const OUT = 0x2000;

const RED_COLOR = 0x0000ff;
const BLUE_COLOR = 0xff0000;
const RED_PIXEL = 0xff0000;
const BLUE_PIXEL = 0x0000ff;
const WHITE_PIXEL = 0xffffff;

/** @param {number} x @param {number} y */
const p = (x, y)=>({ x, y });

/**
 * The path a DC holds, as GetPath answers it: [x, y, type] for each point.
 *
 * @param {ReturnType<typeof painted>} machine
 */
function pathOf(machine){
    const { fns, dc, view, bytes } = machine;
    const count = fns.GetPath.handler([dc, 0, 0, 0]);
    assert.notEqual(count, GDI_ERROR, 'there is a closed path');
    assert.equal(fns.GetPath.handler([dc, POINTS, TYPES, count]), count);
    return Array.from({ length: count }, (_, index)=>[view.getInt32(POINTS + index * 8, true),
        view.getInt32(POINTS + index * 8 + 4, true), bytes[TYPES + index]]);
}

/** @param {ReturnType<typeof painted>} machine @param {{ x: number, y: number }[]} points */
function putPoints(machine, points){
    points.forEach((point, index)=>{
        machine.view.setInt32(POINTS + index * 8, point.x, true);
        machine.view.setInt32(POINTS + index * 8 + 4, point.y, true);
    });
}

/**
 * The machine's pixels as rows of characters.
 *
 * @param {ReturnType<typeof machineOf>} machine @param {(value: number) => string} [key]
 */
function rows(machine, key){
    const { pixel } = machine;
    const name = key ?? (value=>({ [WHITE_PIXEL]: '.', [RED_PIXEL]: 'r', [BLUE_PIXEL]: 'b' })[value]
        ?? '?');
    const width = machine.width;
    const height = machine.height;
    return Array.from({ length: height }, (_, y)=>Array.from({ length: width }, (__, x)=>
        name(pixel(x, y) & 0xffffff)).join(''));
}

/** @param {number} width @param {number} height */
function machineOf(width, height){
    return Object.assign(painted(width, height), { width, height });
}

test('a figure starts where the next line is drawn from, and after a close where it began', ()=>{
    const path = createPath();
    pathLineTo(path, p(-20, -20), p(10, 10));
    pathLineTo(path, p(10, 10), p(10, 15));
    pathClose(path);
    pathLineTo(path, p(10, 15), p(-10, -10));
    pathMoved(path);
    pathLineTo(path, p(100, 100), p(95, 95));
    assert.deepEqual(path.points, [p(-20, -20), p(10, 10), p(10, 15), p(-20, -20), p(-10, -10),
        p(100, 100), p(95, 95)]);
    assert.deepEqual(path.types, [PT_MOVETO, PT_LINETO, PT_LINETO | PT_CLOSEFIGURE, PT_MOVETO,
        PT_LINETO, PT_MOVETO, PT_LINETO]);
    const empty = createPath();
    pathClose(empty);
    assert.deepEqual(empty.points, [], 'closing nothing adds nothing');
});

test('an ellipse is four curves round its box, and figures take them to lines', ()=>{
    const curves = ellipseCurves({ left: 20, top: 20, right: 40, bottom: 40 }, false);
    assert.equal(curves.length, 13);
    assert.deepEqual([curves[0], curves[3], curves[6], curves[9], curves[12]],
        [p(40, 30), p(30, 20), p(20, 30), p(30, 40), p(40, 30)], 'up, round to the left');
    assert.deepEqual(ellipseCurves({ left: 20, top: 20, right: 40, bottom: 40 }, true)[3],
        p(30, 40), 'clockwise, down first');
    const path = createPath();
    pathFigure(path, curves, { closed: true, curves: true });
    const [figure] = figuresOf(path);
    assert.equal(figure.closed, true);
    assert.ok(figure.points.length > 13, 'more points than the curves were given by');
    assert.ok(figure.points.every(point=>Math.abs(Math.hypot(point.x - 30, point.y - 30) - 10)
        < 1.5), 'every one on the circle');
});

test('a widened line covers the pen\'s width either side of it, and round its ends', ()=>{
    const path = createPath();
    pathFigure(path, [p(10, 10), p(30, 10)]);
    const wide = widened(path, 4);
    assert.ok(wide.points.length > 2);
    const figures = figuresOf(wide);
    assert.ok(figures.every(figure=>figure.closed && figure.points.length === 4),
        'rectangles, each closed');
    const xs = figures.flatMap(figure=>figure.points.map(point=>point.x));
    const ys = figures.flatMap(figure=>figure.points.map(point=>point.y));
    assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)],
        [8, 32, 8, 12]);
});

test('the path calls answer as Windows does with no path, an open one and a closed one', ()=>{
    // Wine's test_path_state.
    const machine = machineOf(16, 16);
    const { fns, dc, errors } = machine;
    const calls = ['WidenPath', 'FlattenPath', 'StrokePath', 'FillPath', 'StrokeAndFillPath'];
    /** @param {string} name */
    const fails = name=>{
        const before = errors.length;
        const answer = name === 'SelectClipPath' ? fns[name].handler([dc, RGN_OR])
            : fns[name].handler([dc]);
        assert.equal(answer, 0, name);
        assert.deepEqual(errors.slice(before), [ERROR_CAN_NOT_COMPLETE], name);
    };

    for (const name of [...calls, 'SelectClipPath', 'PathToRegion', 'EndPath', 'CloseFigure'])
    {
        fails(name);
    }
    for (const name of [...calls, 'SelectClipPath', 'PathToRegion'])
    {
        fns.BeginPath.handler([dc]);
        fns.Rectangle.handler([dc, 1, 1, 10, 10]);
        fails(name);
        fns.AbortPath.handler([dc]);
    }
    fns.BeginPath.handler([dc]);
    assert.equal(fns.CloseFigure.handler([dc]), 1, 'an open path takes a close');

    for (const name of ['WidenPath', 'FlattenPath'])
    {
        fns.BeginPath.handler([dc]);
        fns.EndPath.handler([dc]);
        assert.equal(fns[name].handler([dc]), 1, name);
        assert.notEqual(fns.GetPath.handler([dc, 0, 0, 0]), GDI_ERROR, `${name} keeps the path`);
    }
    for (const name of ['StrokePath', 'FillPath', 'StrokeAndFillPath'])
    {
        fns.BeginPath.handler([dc]);
        fns.EndPath.handler([dc]);
        assert.equal(fns[name].handler([dc]), 1, name);
        assert.equal(fns.GetPath.handler([dc, 0, 0, 0]), GDI_ERROR, `${name} uses the path up`);
    }
    for (const name of ['SelectClipPath', 'PathToRegion'])
    {
        fns.BeginPath.handler([dc]);
        fns.EndPath.handler([dc]);
        const before = errors.length;
        assert.equal(name === 'SelectClipPath' ? fns[name].handler([dc, RGN_OR])
            : fns[name].handler([dc]), 0, `${name} of an empty path`);
        assert.equal(errors.length, before, 'and says nothing about it');
        assert.equal(fns.GetPath.handler([dc, 0, 0, 0]), GDI_ERROR, 'the path is gone');
        fns.BeginPath.handler([dc]);
        fns.Rectangle.handler([dc, 1, 1, 10, 10]);
        fns.EndPath.handler([dc]);
        assert.notEqual(name === 'SelectClipPath' ? fns[name].handler([dc, RGN_OR])
            : fns[name].handler([dc]), 0, `${name} of a rectangle`);
        assert.equal(fns.GetPath.handler([dc, 0, 0, 0]), GDI_ERROR, `${name} uses it up`);
    }
    fns.BeginPath.handler([dc]);
    fns.EndPath.handler([dc]);
    fails('CloseFigure');
    fails('EndPath');

    // SaveDC keeps the path as it is, open or closed.
    fns.BeginPath.handler([dc]);
    fns.LineTo.handler([dc, 10, 10]);
    const level = fns.SaveDC.handler([dc]);
    assert.equal(fns.EndPath.handler([dc]), 1);
    assert.equal(fns.WidenPath.handler([dc]), 1);
    fns.RestoreDC.handler([dc, level]);
    fails('WidenPath');
    assert.equal(fns.EndPath.handler([dc]), 1, 'open again after RestoreDC');
    fns.SaveDC.handler([dc]);
    fns.BeginPath.handler([dc]);
    fns.RestoreDC.handler([dc, -1]);
    assert.equal(fns.WidenPath.handler([dc]), 1, 'and closed again');

    for (const name of ['BeginPath', 'EndPath', 'AbortPath', 'CloseFigure', ...calls,
        'PathToRegion'])
    {
        assert.equal(fns[name].argBytes, 4, name);
        assert.equal(fns[name].handler([0x7777]), 0, `${name}: not a DC`);
    }
    assert.equal(fns.SelectClipPath.argBytes, 8);
    assert.equal(fns.GetPath.argBytes, 16);
});

test('a rectangle in a path runs from its top right corner, its far edges left out', ()=>{
    // Wine's test_rectangle, its first figures.
    const machine = machineOf(4, 4);
    const { fns, dc } = machine;
    fns.BeginPath.handler([dc]);
    fns.Rectangle.handler([dc, 20, 20, 40, 40]);
    fns.Rectangle.handler([dc, 30, 50, 55, 35]);
    fns.Rectangle.handler([dc, 70, 70, 50, 70]);
    fns.Rectangle.handler([dc, 80, 80, 81, 81]);
    fns.SetArcDirection.handler([dc, AD_CLOCKWISE]);
    fns.Rectangle.handler([dc, 20, 20, 40, 40]);
    fns.EndPath.handler([dc]);
    const L = PT_LINETO;
    const C = PT_LINETO | PT_CLOSEFIGURE;
    assert.deepEqual(pathOf(machine), [
        [39, 20, PT_MOVETO], [20, 20, L], [20, 39, L], [39, 39, C],
        [54, 35, PT_MOVETO], [30, 35, L], [30, 49, L], [54, 49, C],
        [70, 70, PT_MOVETO], [50, 70, L], [50, 70, L], [70, 70, C],
        [80, 80, PT_MOVETO], [80, 80, L], [80, 80, L], [80, 80, C],
        [39, 39, PT_MOVETO], [20, 39, L], [20, 20, L], [39, 20, C],
    ]);

    // Kept on the device: under a viewport that mirrors and doubles, the box
    // is ordered and shrunk there, and read back after the mapping is gone
    // it is the device's.
    fns.SetArcDirection.handler([dc, 1]);
    fns.BeginPath.handler([dc]);
    fns.SetMapMode.handler([dc, 8]);
    fns.SetViewportExtEx.handler([dc, -2, 2, 0]);
    fns.Rectangle.handler([dc, 20, 20, 40, 40]);
    fns.Rectangle.handler([dc, 30, 50, 55, 35]);
    fns.EndPath.handler([dc]);
    fns.SetMapMode.handler([dc, 1]);
    assert.deepEqual(pathOf(machine), [
        [-41, 40, PT_MOVETO], [-80, 40, L], [-80, 79, L], [-41, 79, C],
        [-61, 70, PT_MOVETO], [-110, 70, L], [-110, 99, L], [-61, 99, C],
    ]);
});

test('lines in a path draw nothing, and the figures start where Windows starts them', ()=>{
    // Wine's test_closefigure and the start of test_all_functions.
    const machine = machineOf(8, 8);
    const { fns, dc, view, fill } = machine;
    fill(WHITE_PIXEL);
    putPoints(machine, [p(1, 1), p(2, 2), p(3, 1)]);
    fns.BeginPath.handler([dc]);
    fns.LineTo.handler([dc, 50, 150]);
    fns.MoveToEx.handler([dc, 95, 95, 0]);
    fns.LineTo.handler([dc, 95, 0]);
    fns.LineTo.handler([dc, 0, 95]);
    assert.equal(fns.CloseFigure.handler([dc]), 1);
    fns.GetCurrentPositionEx.handler([dc, OUT]);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [0, 95],
        'a close moves nothing');
    fns.LineTo.handler([dc, 10, 10]);
    fns.Polyline.handler([dc, POINTS, 3]);
    fns.EndPath.handler([dc]);
    assert.deepEqual(rows(machine), new Array(8).fill('........'), 'not a pixel');
    assert.deepEqual(pathOf(machine), [
        [0, 0, PT_MOVETO], [50, 150, PT_LINETO],
        [95, 95, PT_MOVETO], [95, 0, PT_LINETO], [0, 95, PT_LINETO | PT_CLOSEFIGURE],
        [95, 95, PT_MOVETO], [10, 10, PT_LINETO],
        [1, 1, PT_MOVETO], [2, 2, PT_LINETO], [3, 1, PT_LINETO],
    ]);
    fns.GetCurrentPositionEx.handler([dc, OUT]);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [10, 10],
        'Polyline leaves the position where it was');
});

test('GetPath sizes its buffers, and refuses ones too small', ()=>{
    const machine = machineOf(4, 4);
    const { fns, dc, errors } = machine;
    fns.BeginPath.handler([dc]);
    fns.LineTo.handler([dc, 5, 5]);
    assert.equal(fns.GetPath.handler([dc, 0, 0, 0]), GDI_ERROR, 'not while it is open');
    assert.equal(errors.at(-1), ERROR_CAN_NOT_COMPLETE);
    fns.EndPath.handler([dc]);
    assert.equal(fns.GetPath.handler([dc, 0, 0, 0]), 2);
    assert.equal(fns.GetPath.handler([dc, POINTS, TYPES, 1]), GDI_ERROR);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(fns.GetPath.handler([dc, POINTS, TYPES, 5]), 2, 'room to spare is fine');
});

test('curves stay curves in a path, and FlattenPath makes them lines', ()=>{
    const machine = machineOf(4, 4);
    const { fns, dc } = machine;
    fns.BeginPath.handler([dc]);
    fns.Ellipse.handler([dc, 0, 0, 21, 21]);
    putPoints(machine, [p(0, 0), p(10, 0), p(10, 10), p(20, 10)]);
    fns.PolyBezier.handler([dc, POINTS, 4]);
    fns.MoveToEx.handler([dc, 5, 5, 0]);
    fns.PolyBezierTo.handler([dc, POINTS + 8, 3]);
    fns.EndPath.handler([dc]);
    const path = pathOf(machine);
    assert.deepEqual(path.slice(0, 13).map(([, , type])=>type), [PT_MOVETO,
        ...new Array(11).fill(PT_BEZIERTO), PT_BEZIERTO | PT_CLOSEFIGURE], 'the ellipse');
    assert.deepEqual(path[0], [20, 10, PT_MOVETO], 'its box without the far edges');
    assert.deepEqual(path.slice(13), [[0, 0, PT_MOVETO], [10, 0, PT_BEZIERTO],
        [10, 10, PT_BEZIERTO], [20, 10, PT_BEZIERTO], [5, 5, PT_MOVETO], [10, 0, PT_BEZIERTO],
        [10, 10, PT_BEZIERTO], [20, 10, PT_BEZIERTO]],
    'PolyBezier, and PolyBezierTo from the move');
    assert.equal(fns.FlattenPath.handler([dc]), 1);
    const flat = pathOf(machine);
    assert.ok(flat.length > path.length);
    assert.ok(flat.every(([, , type])=>(type & ~PT_CLOSEFIGURE) !== PT_BEZIERTO), 'no curve left');
    assert.equal(flat.filter(([, , type])=>type === PT_MOVETO).length, 3, 'the same figures');
});

test('WidenPath gives an outline of more points than the line, with a narrow pen too', ()=>{
    // Wine's test_widenpath.
    const machine = machineOf(4, 4);
    const { fns, dc } = machine;
    putPoints(machine, [p(100, 0), p(200, 0), p(300, 100), p(300, 200), p(200, 300), p(100, 300)]);
    for (const width of [10, 1])
    {
        fns.SelectObject.handler([dc, fns.CreatePen.handler([0, width, 0])]);
        fns.BeginPath.handler([dc]);
        fns.Polyline.handler([dc, POINTS, 6]);
        fns.EndPath.handler([dc]);
        assert.equal(fns.WidenPath.handler([dc]), 1);
        assert.ok(fns.GetPath.handler([dc, 0, 0, 0]) > 6, `a pen ${width} wide`);
    }
});

test('FillPath, StrokePath and StrokeAndFillPath draw the path once it is closed', ()=>{
    const machine = machineOf(12, 12);
    const { fns, dc, fill } = machine;
    pens(machine, BLUE_COLOR, RED_COLOR);
    const square = ()=>{
        fill(WHITE_PIXEL);
        fns.BeginPath.handler([dc]);
        fns.MoveToEx.handler([dc, 2, 2, 0]);
        fns.LineTo.handler([dc, 9, 2]);
        fns.LineTo.handler([dc, 9, 9]);
        fns.LineTo.handler([dc, 2, 9]);
        fns.CloseFigure.handler([dc]);
        fns.EndPath.handler([dc]);
    };
    square();
    assert.equal(fns.FillPath.handler([dc]), 1);
    assert.deepEqual(rows(machine).slice(1, 4), ['............', '..rrrrrrr...', '..rrrrrrr...']);
    square();
    assert.equal(fns.StrokePath.handler([dc]), 1);
    assert.deepEqual(rows(machine).slice(1, 4), ['............', '..bbbbbbbb..', '..b......b..']);
    square();
    assert.equal(fns.StrokeAndFillPath.handler([dc]), 1);
    assert.deepEqual(rows(machine).slice(1, 4), ['............', '..bbbbbbbb..', '..brrrrrrb..']);
});

test('PathToRegion and SelectClipPath take the inside of the path to the device', ()=>{
    const machine = machineOf(12, 12);
    const { fns, dc, view, fill, errors } = machine;
    fns.BeginPath.handler([dc]);
    fns.Rectangle.handler([dc, 1, 1, 10, 10]);
    fns.EndPath.handler([dc]);
    const region = fns.PathToRegion.handler([dc]);
    assert.equal(fns.GetRgnBox.handler([region, OUT]), 2);
    assert.deepEqual([0, 4, 8, 12].map(at=>view.getInt32(OUT + at, true)), [1, 1, 9, 9]);

    fns.SetViewportOrgEx.handler([dc, 2, 0, 0]);
    fns.BeginPath.handler([dc]);
    fns.Rectangle.handler([dc, 1, 1, 10, 10]);
    fns.EndPath.handler([dc]);
    fns.SetViewportOrgEx.handler([dc, 0, 0, 0]);
    const before = errors.length;
    assert.equal(fns.SelectClipPath.handler([dc, 9]), 0, 'no such mode');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(errors.length, before + 1);
    assert.equal(fns.SelectClipPath.handler([dc, RGN_COPY]), 1);
    fill(0);
    fns.PatBlt.handler([dc, 0, 0, 12, 12, 0x00ff0062]);
    assert.deepEqual(rows(machine, value=>(value === 0 ? '.' : '#')).slice(0, 3),
        ['............', '...########.', '...########.'], 'the rectangle where it was drawn');
});

test('Polygon and PolyPolygon fill by the DC\'s mode and outline with the pen', ()=>{
    const machine = machineOf(12, 12);
    const { fns, dc, fill, view } = machine;
    pens(machine, BLUE_COLOR, RED_COLOR);
    fill(WHITE_PIXEL);
    putPoints(machine, [p(1, 1), p(10, 1), p(10, 10), p(1, 10),
        p(4, 4), p(7, 4), p(7, 7), p(4, 7)]);
    assert.equal(fns.Polygon.handler([dc, POINTS, 4]), 1);
    assert.deepEqual(rows(machine).slice(0, 3), ['............', '.bbbbbbbbbb.', '.brrrrrrrrb.']);
    view.setInt32(COUNTS, 4, true);
    view.setInt32(COUNTS + 4, 4, true);
    fill(WHITE_PIXEL);
    assert.equal(fns.PolyPolygon.handler([dc, POINTS, COUNTS, 2]), 1);
    assert.deepEqual(rows(machine)[5], '.brrb..brrb.', 'ALTERNATE leaves a hole');
    fns.SetPolyFillMode.handler([dc, 2]);
    fill(WHITE_PIXEL);
    fns.PolyPolygon.handler([dc, POINTS, COUNTS, 2]);
    assert.deepEqual(rows(machine)[5], '.brrbrrbrrb.', 'WINDING fills it');
    assert.equal(fns.Polygon.handler([dc, POINTS, 1]), 0, 'one point');
    view.setInt32(COUNTS + 4, 1, true);
    assert.equal(fns.PolyPolygon.handler([dc, POINTS, COUNTS, 2]), 0, 'a polygon of one point');
    assert.equal(fns.Polygon.argBytes, 12);
    assert.equal(fns.PolyPolygon.argBytes, 16);
});

test('PolyPolyline, PolyBezier and AngleArc draw with the pen', ()=>{
    const machine = machineOf(12, 12);
    const { fns, dc, fill, view } = machine;
    pens(machine, BLUE_COLOR, RED_COLOR);
    fill(WHITE_PIXEL);
    putPoints(machine, [p(1, 1), p(5, 1), p(1, 3), p(1, 6), p(5, 6)]);
    view.setInt32(COUNTS, 2, true);
    view.setInt32(COUNTS + 4, 3, true);
    fns.MoveToEx.handler([dc, 9, 9, 0]);
    assert.equal(fns.PolyPolyline.handler([dc, POINTS, COUNTS, 2]), 1);
    assert.deepEqual(rows(machine).slice(0, 7), ['............', '.bbbb.......', '............',
        '.b..........', '.b..........', '.b..........', '.bbbb.......']);
    fns.GetCurrentPositionEx.handler([dc, OUT]);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [9, 9]);
    view.setInt32(COUNTS + 4, 1, true);
    assert.equal(fns.PolyPolyline.handler([dc, POINTS, COUNTS, 2]), 0, 'a run of one point');

    fill(WHITE_PIXEL);
    putPoints(machine, [p(1, 10), p(1, 1), p(10, 1), p(10, 10)]);
    assert.equal(fns.PolyBezier.handler([dc, POINTS, 4]), 1);
    assert.equal(rows(machine)[10][1], 'b', 'from the first point');
    assert.equal(rows(machine)[3].includes('b'), true, 'pulled up towards the control points');
    assert.equal(rows(machine)[1].includes('b'), false, 'never reaching them');
    assert.equal(fns.PolyBezier.handler([dc, POINTS, 3]), 0, 'not a whole curve');

    fill(WHITE_PIXEL);
    fns.MoveToEx.handler([dc, 0, 6, 0]);
    const FLOAT = new DataView(new ArrayBuffer(4));
    /** @param {number} value */
    const bits = value=>(FLOAT.setFloat32(0, value, true), FLOAT.getUint32(0, true));
    assert.equal(fns.AngleArc.handler([dc, 6, 6, 4, bits(0), bits(180)]), 1);
    fns.GetCurrentPositionEx.handler([dc, OUT]);
    assert.deepEqual([view.getInt32(OUT, true), view.getInt32(OUT + 4, true)], [2, 6],
        'the position at the arc\'s end, on the left');
    assert.deepEqual([rows(machine)[6][1], rows(machine)[2][6], rows(machine)[9][6]],
        ['b', 'b', '.'], 'the line to its start, and the top half, counterclockwise');
    assert.equal(fns.AngleArc.handler([dc, 6, 6, -1, 0, 0]), 0, 'a negative radius');
    assert.equal(fns.AngleArc.argBytes, 24);
    assert.equal(fns.PolyBezier.argBytes, 12);
    assert.equal(fns.PolyPolyline.argBytes, 16);
});

test('text drawn into a path adds nothing to it', ()=>{
    const machine = machineOf(4, 4);
    const { fns, dc } = machine;
    fns.BeginPath.handler([dc]);
    assert.equal(fns.TextOutA.handler([dc, 0, 0, POINTS, 1]), 1);
    fns.EndPath.handler([dc]);
    assert.equal(fns.GetPath.handler([dc, 0, 0, 0]), 0);
});
