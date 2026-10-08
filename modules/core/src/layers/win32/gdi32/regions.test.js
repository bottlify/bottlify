/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Regions as areas of rectangles in bands: the algebra on its own, and the
 * entry points that make, read, combine and paint them, over the real drawing
 * engine where a pixel is the answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    RGN_AND, RGN_COPY, RGN_DIFF, RGN_OR, RGN_XOR, WINDING, areaBox, areaContains, areaOf,
    areasEqual, combineAreas, polygonArea, roundedArea,
} from './regions.js';
import { painted } from './fixtures.test.js';

const NULLREGION = 1;
const SIMPLEREGION = 2;
const COMPLEXREGION = 3;
const ERROR_INVALID_PARAMETER = 87;

const POINTS = 0x1000;
const COUNTS = 0x1400;
const DATA = 0x1800;
const OUT = 0x2000;

/** @param {number} left @param {number} top @param {number} right @param {number} bottom */
const rect = (left, top, right, bottom)=>({ left, top, right, bottom });

/**
 * An area as rows of characters: '#' for a pixel in it.
 *
 * @param {import('./rects.js').Rect[]} area @param {number} width @param {number} height
 */
const picture = (area, width, height)=>Array.from({ length: height }, (_, y)=>
    Array.from({ length: width }, (__, x)=>(areaContains(area, x, y) ? '#' : '.')).join(''));

/**
 * A few rectangles, overlapping as they fall, from a seed.
 *
 * @param {number} seed
 */
function randomRects(seed){
    let state = seed;
    const next = ()=>{
        state = (state * 1103515245 + 12345) >>> 0;
        return state >>> 16;
    };
    return Array.from({ length: 1 + next() % 5 }, ()=>{
        const left = next() % 20;
        const top = next() % 20;
        return rect(left, top, left + 1 + next() % 10, top + 1 + next() % 10);
    });
}

test('rectangles are kept in bands: top to bottom, left to right, joined where they can be', ()=>{
    assert.deepEqual(areaOf([rect(0, 0, 10, 10), rect(5, 5, 15, 15)]), [
        rect(0, 0, 10, 5), rect(0, 5, 15, 10), rect(5, 10, 15, 15),
    ], 'overlapping rectangles are their union, in rows of the same spans');
    assert.deepEqual(areaOf([rect(0, 5, 10, 10), rect(0, 0, 10, 5)]), [rect(0, 0, 10, 10)],
        'two that make one rectangle are one');
    assert.deepEqual(areaOf([rect(10, 0, 20, 5), rect(0, 0, 10, 5)]), [rect(0, 0, 20, 5)],
        'side by side too');
    assert.deepEqual(areaOf([rect(5, 5, 5, 9), rect(3, 3, 1, 9)]), [], 'empty pieces are nothing');
    assert.deepEqual(areaBox([]), rect(0, 0, 0, 0), 'and nothing has no position');
});

test('every combination is exact, pixel by pixel', ()=>{
    /** @type {Record<number, (a: boolean, b: boolean) => boolean>} */
    const rules = {
        [RGN_AND]: (a, b)=>a && b, [RGN_OR]: (a, b)=>a || b,
        [RGN_XOR]: (a, b)=>a !== b, [RGN_DIFF]: (a, b)=>a && !b,
    };
    for (let seed = 1; seed <= 40; seed++)
    {
        const a = areaOf(randomRects(seed));
        const b = areaOf(randomRects(seed * 7919));
        for (const mode of [RGN_AND, RGN_OR, RGN_XOR, RGN_DIFF])
        {
            const result = /** @type {import('./rects.js').Rect[]} */ (combineAreas(a, b, mode));
            assert.ok(areasEqual(result, areaOf(result)), 'the answer is in bands already');
            for (let y = -1; y < 31; y++)
            {
                for (let x = -1; x < 31; x++)
                {
                    assert.equal(areaContains(result, x, y),
                        rules[mode](areaContains(a, x, y), areaContains(b, x, y)),
                        `seed ${seed}, mode ${mode}, (${x}, ${y})`);
                }
            }
        }
        assert.deepEqual(combineAreas(a, b, RGN_COPY), a);
    }
    assert.equal(combineAreas([], [], 0), null, 'no such mode');
});

test('an ellipse is the pixels whose centres it holds, inside its rectangle', ()=>{
    const circle = roundedArea(rect(0, 0, 8, 8), 8, 8);
    assert.deepEqual(picture(circle, 8, 8), [
        '..####..',
        '.######.',
        '########',
        '########',
        '########',
        '########',
        '.######.',
        '..####..',
    ]);
    assert.deepEqual(areaBox(circle), rect(0, 0, 8, 8));
    assert.deepEqual(roundedArea(rect(2, 2, 9, 6), 0, 3), [rect(2, 2, 9, 6)],
        'corners too small to round are a rectangle');
    assert.deepEqual(roundedArea(rect(2, 2, 2, 6), 4, 4), [], 'and an empty box is nothing');
});

test('a polygon fills by the rule, and one inside another is a hole only by ALTERNATE', ()=>{
    const outer = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }];
    const inner = [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 }];
    assert.deepEqual(picture(polygonArea([outer, inner]), 8, 8), [
        '########',
        '########',
        '##....##',
        '##....##',
        '##....##',
        '##....##',
        '########',
        '########',
    ]);
    assert.deepEqual(polygonArea([outer, inner], WINDING), [rect(0, 0, 8, 8)],
        'wound the same way twice is still inside');
    assert.deepEqual(polygonArea([[{ x: 1, y: 0 }, { x: 11, y: 0 }, { x: 21, y: 0 }]]), [],
        'a line has no inside');
    assert.deepEqual(polygonArea([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -0x80000000 }]]),
        [], 'nor has a polygon past the device space');
});

/**
 * The pieces GetRegionData answers for a region.
 *
 * @param {ReturnType<typeof painted>} machine @param {number} region
 */
function piecesOf(machine, region){
    const { fns, view } = machine;
    const size = fns.GetRegionData.handler([region, 0, 0]);
    assert.equal(fns.GetRegionData.handler([region, size, OUT]), size);
    const count = view.getUint32(OUT + 8, true);
    assert.equal(size, 32 + 16 * count);
    return Array.from({ length: count }, (_, index)=>[0, 4, 8, 12]
        .map(at=>view.getInt32(OUT + 32 + index * 16 + at, true)));
}

/** @param {ReturnType<typeof painted>} machine @param {{ x: number, y: number }[]} points */
function putPoints(machine, points){
    points.forEach((point, index)=>{
        machine.view.setInt32(POINTS + index * 8, point.x, true);
        machine.view.setInt32(POINTS + index * 8 + 4, point.y, true);
    });
}

test('CreateEllipticRgn and its Indirect twin make an ellipse of either corners', ()=>{
    const machine = painted(4, 4);
    const { fns, view, errors } = machine;
    const region = fns.CreateEllipticRgn.handler([8, 8, 0, 0]);
    assert.deepEqual(piecesOf(machine, region), [
        [2, 0, 6, 1], [1, 1, 7, 2], [0, 2, 8, 6], [1, 6, 7, 7], [2, 7, 6, 8],
    ]);
    assert.equal(fns.GetRgnBox.handler([region, OUT]), COMPLEXREGION);
    [0, 0, 8, 8].forEach((value, index)=>view.setInt32(DATA + index * 4, value, true));
    const same = fns.CreateEllipticRgnIndirect.handler([DATA]);
    assert.equal(fns.EqualRgn.handler([region, same]), 1);
    assert.equal(fns.CreateEllipticRgnIndirect.handler([0]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(fns.CreateEllipticRgn.argBytes, 16);
    assert.equal(fns.CreateEllipticRgnIndirect.argBytes, 4);
});

test('CreateRoundRectRgn rounds the corners, and a corner of nothing is the rectangle', ()=>{
    const machine = painted(4, 4);
    const { fns } = machine;
    assert.deepEqual(piecesOf(machine, fns.CreateRoundRectRgn.handler([0, 0, 10, 6, 4, 4])), [
        [1, 0, 9, 1], [0, 1, 10, 5], [1, 5, 9, 6],
    ]);
    assert.deepEqual(piecesOf(machine, fns.CreateRoundRectRgn.handler([10, 6, 0, 0, 0, 4])),
        [[0, 0, 10, 6]]);
    assert.equal(fns.CreateRoundRectRgn.argBytes, 24);
});

test('CreatePolygonRgn and CreatePolyPolygonRgn fill by the mode they are given', ()=>{
    const machine = painted(4, 4);
    const { fns, view, errors } = machine;
    putPoints(machine, [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }, { x: 0, y: 6 },
        { x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }]);
    assert.deepEqual(piecesOf(machine, fns.CreatePolygonRgn.handler([POINTS, 4, 1])),
        [[0, 0, 6, 6]]);
    view.setInt32(COUNTS, 4, true);
    view.setInt32(COUNTS + 4, 4, true);
    assert.deepEqual(piecesOf(machine, fns.CreatePolyPolygonRgn.handler([POINTS, COUNTS, 2, 1])),
        [[0, 0, 6, 2], [0, 2, 2, 4], [4, 2, 6, 4], [0, 4, 6, 6]], 'a hole by ALTERNATE');
    assert.deepEqual(piecesOf(machine, fns.CreatePolyPolygonRgn.handler([POINTS, COUNTS, 2, 2])),
        [[0, 0, 6, 6]], 'none by WINDING');

    // Wine's test_CreatePolyPolygonRgn: no inside is a region, and an empty one.
    putPoints(machine, [{ x: 1, y: 0 }, { x: 11, y: 0 }, { x: 21, y: 0 }]);
    const line = fns.CreatePolygonRgn.handler([POINTS, 3, 1]);
    assert.notEqual(line, 0);
    assert.equal(fns.GetRgnBox.handler([line, OUT]), NULLREGION);

    assert.equal(fns.CreatePolygonRgn.handler([POINTS, 1, 1]), 0, 'one point');
    assert.equal(fns.CreatePolygonRgn.handler([POINTS, 3, 3]), 0, 'no such mode');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    view.setInt32(COUNTS + 4, 1, true);
    assert.equal(fns.CreatePolyPolygonRgn.handler([POINTS, COUNTS, 2, 1]), 0,
        'a polygon of one point');
    assert.equal(fns.CreatePolyPolygonRgn.handler([POINTS, COUNTS, 0, 1]), 0, 'no polygons');
    assert.equal(fns.CreatePolygonRgn.argBytes, 12);
    assert.equal(fns.CreatePolyPolygonRgn.argBytes, 16);
});

test('ExtCreateRegion reads an RGNDATA as XP does, and transforms it', ()=>{
    // Wine's test_ExtCreateRegion.
    const machine = painted(4, 4);
    const { fns, view, errors } = machine;
    /** @param {number[]} values */
    const put = values=>values.forEach((value, index)=>
        view.setInt32(DATA + index * 4, value, true));
    const before = errors.length;
    assert.equal(fns.ExtCreateRegion.handler([0, 0, 0]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    put([0, 0, 0, 0, 0, 0, 0, 0, 111, 222, 333, 444]);
    assert.equal(fns.ExtCreateRegion.handler([0, 48, DATA]), 0, 'a header of size zero');
    put([31]);
    assert.equal(fns.ExtCreateRegion.handler([0, 48, DATA]), 0, 'or one byte short');
    assert.equal(errors.length, before + 1, 'with nothing set');
    put([32, 1]);
    const empty = fns.ExtCreateRegion.handler([0, 32, DATA]);
    assert.notEqual(empty, 0, 'a header alone is enough');
    assert.equal(fns.GetRgnBox.handler([empty, OUT]), NULLREGION);
    put([32, 1, 1]);
    const one = fns.ExtCreateRegion.handler([0, 48, DATA]);
    assert.deepEqual(piecesOf(machine, one), [[111, 222, 333, 444]]);
    assert.equal(fns.ExtCreateRegion.handler([0, 47, DATA]), 0, 'a buffer short of its rectangle');

    const XFORM = 0x2800;
    [0.5, 0, 0, 0.5, 20, 40].forEach((value, index)=>
        view.setFloat32(XFORM + index * 4, value, true));
    assert.deepEqual(piecesOf(machine, fns.ExtCreateRegion.handler([XFORM, 48, DATA])),
        [[76, 151, 187, 262]], 'halved and moved, rounded to the nearest pixel');

    put([32, 1, 2, 0, 0, 0, 0, 0, 0, 0, 10, 10, 10, 10, 20, 20]);
    assert.deepEqual(piecesOf(machine, fns.ExtCreateRegion.handler([0, 64, DATA])),
        [[0, 0, 10, 10], [10, 10, 20, 20]], 'two rectangles corner to corner stay two');
    assert.equal(fns.ExtCreateRegion.argBytes, 12);
});

test('PtInRegion and RectInRegion ask about pixels, corners in either order', ()=>{
    const machine = painted(4, 4);
    const { fns, view } = machine;
    const ring = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    fns.CombineRgn.handler([ring, fns.CreateRectRgn.handler([0, 0, 30, 30]),
        fns.CreateRectRgn.handler([10, 10, 20, 20]), RGN_DIFF]);
    assert.equal(fns.PtInRegion.handler([ring, 0, 0]), 1);
    assert.equal(fns.PtInRegion.handler([ring, 15, 15]), 0, 'in the hole');
    assert.equal(fns.PtInRegion.handler([ring, 30, 5]), 0, 'the right edge is out');
    assert.equal(fns.PtInRegion.handler([0x9999, 0, 0]), 0, 'not a region');
    [19, 19, 11, 11].forEach((value, index)=>view.setInt32(DATA + index * 4, value, true));
    assert.equal(fns.RectInRegion.handler([ring, DATA]), 0, 'all in the hole');
    [25, 15, 15, 5].forEach((value, index)=>view.setInt32(DATA + index * 4, value, true));
    assert.equal(fns.RectInRegion.handler([ring, DATA]), 1, 'reaching out of it, corners swapped');
    // Wine's test_region: a region made from swapped corners is the same region.
    const swapped = fns.CreateRectRgn.handler([20, 10, 10, 20]);
    [5, 5, 15, 15].forEach((value, index)=>view.setInt32(DATA + index * 4, value, true));
    assert.equal(fns.RectInRegion.handler([swapped, DATA]), 1);
    assert.equal(fns.PtInRegion.argBytes, 12);
});

test('PaintRgn, FillRgn and InvertRgn touch every pixel of the region and no other', ()=>{
    const machine = painted(12, 12);
    const { fns, dc, pixel, fill } = machine;
    const RED = 0x0000ff;
    const ring = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    fns.CombineRgn.handler([ring, fns.CreateRectRgn.handler([2, 2, 10, 10]),
        fns.CreateRectRgn.handler([4, 4, 8, 8]), RGN_DIFF]);
    const rows = ()=>Array.from({ length: 12 }, (_, y)=>Array.from({ length: 12 }, (__, x)=>
        ({ 0x00ffffff: '.', 0x00ff0000: 'r', 0x00000000: 'k' })[pixel(x, y) & 0xffffff] ?? '?')
        .join(''));
    const square = [
        '............',
        '............',
        '..xxxxxxxx..',
        '..xxxxxxxx..',
        '..xx....xx..',
        '..xx....xx..',
        '..xx....xx..',
        '..xx....xx..',
        '..xxxxxxxx..',
        '..xxxxxxxx..',
        '............',
        '............',
    ];
    fill(0x00ffffff);
    fns.SelectObject.handler([dc, fns.CreateSolidBrush.handler([RED])]);
    assert.equal(fns.PaintRgn.handler([dc, ring]), 1);
    assert.deepEqual(rows(), square.map(row=>row.replaceAll('x', 'r')), 'the selected brush');

    fill(0x00ffffff);
    assert.equal(fns.InvertRgn.handler([dc, ring]), 1);
    assert.deepEqual(rows(), square.map(row=>row.replaceAll('x', 'k')), 'inverted once each');

    fill(0x00ffffff);
    assert.equal(fns.FillRgn.handler([dc, ring, fns.GetStockObject.handler([4])]), 1);
    assert.deepEqual(rows(), square.map(row=>row.replaceAll('x', 'k')), 'the brush named');
    assert.equal(fns.FillRgn.handler([dc, ring, ring]), 0, 'a region is no brush');

    // A region to paint is in logical units: moved with the window origin.
    fill(0x00ffffff);
    fns.SetWindowOrgEx.handler([dc, 2, 2, 0]);
    fns.PaintRgn.handler([dc, ring]);
    assert.deepEqual([pixel(0, 0), pixel(1, 1), pixel(3, 3), pixel(7, 7)],
        [0x00ff0000, 0x00ff0000, 0x00ffffff, 0x00ff0000]);
    assert.equal(fns.PaintRgn.handler([0x7777, ring]), 0, 'not a DC');
    assert.equal(fns.InvertRgn.handler([dc, 0x9999]), 0, 'not a region');
    assert.equal(fns.PaintRgn.argBytes, 8);
    assert.equal(fns.InvertRgn.argBytes, 8);
});

test('FrameRgn frames every edge of a region of several pieces', ()=>{
    const machine = painted(12, 12);
    const { fns, dc, pixel, fill } = machine;
    const ring = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    fns.CombineRgn.handler([ring, fns.CreateRectRgn.handler([1, 1, 11, 11]),
        fns.CreateRectRgn.handler([4, 4, 8, 8]), RGN_DIFF]);
    fill(0x00ffffff);
    assert.equal(fns.FrameRgn.handler([dc, ring, fns.GetStockObject.handler([4]), 1, 1]), 1);
    const rows = Array.from({ length: 12 }, (_, y)=>Array.from({ length: 12 }, (__, x)=>
        (pixel(x, y) === 0 ? '#' : '.')).join(''));
    assert.deepEqual(rows, [
        '............',
        '.##########.',
        '.#........#.',
        '.#..####..#.',
        '.#.#....#.#.',
        '.#.#....#.#.',
        '.#.#....#.#.',
        '.#.#....#.#.',
        '.#..####..#.',
        '.#........#.',
        '.##########.',
        '............',
    ], 'round the outside and round the hole, a pixel from the outside across or down');
});

test('a region of several pieces clips as those pieces, and is given back whole', ()=>{
    const machine = painted(12, 12);
    const { fns, dc, pixel, fill } = machine;
    const circle = fns.CreateEllipticRgn.handler([0, 0, 12, 12]);
    fill(0);
    assert.equal(fns.SelectClipRgn.handler([dc, circle]), COMPLEXREGION);
    fns.PatBlt.handler([dc, 0, 0, 12, 12, 0x00ff0062]);
    assert.deepEqual([pixel(0, 0), pixel(6, 6), pixel(0, 6), pixel(11, 0)]
        .map(value=>value & 0xffffff), [0, 0xffffff, 0xffffff, 0],
    'the corners are outside the circle');
    const copy = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    assert.equal(fns.GetClipRgn.handler([dc, copy]), 1);
    assert.equal(fns.EqualRgn.handler([copy, circle]), 1, 'the clip is the circle, every piece');
    assert.equal(fns.OffsetRgn.handler([copy, 1, 0]), COMPLEXREGION);
    assert.equal(fns.EqualRgn.handler([copy, circle]), 0, 'moved, it is another region');
    assert.equal(fns.OffsetRgn.handler([copy, -1, 0]), COMPLEXREGION);
    assert.equal(fns.EqualRgn.handler([copy, circle]), 1);
    assert.equal(fns.SetRectRgn.handler([copy, 9, 9, 3, 3]), 1);
    assert.equal(fns.GetRgnBox.handler([copy, OUT]), SIMPLEREGION, 'SetRectRgn makes it one');
    assert.deepEqual([0, 4, 8, 12].map(at=>machine.view.getInt32(OUT + at, true)), [3, 3, 9, 9]);
});
