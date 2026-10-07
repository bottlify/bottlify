/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A region as Windows keeps one: rectangles in bands. A band is a run of rows
 * that all hold the same spans; the bands are in order down the page and never
 * share a row, the spans of a band are in order across it and never touch, and
 * two bands one on top of the other with the same spans are one band. That
 * form is unique -- two regions holding the same pixels are the same list --
 * so EqualRgn is a comparison of lists, GetRegionData answers in the order a
 * program walking the buffer expects (top to bottom, left to right), and a
 * region that is a rectangle is one rectangle, which is what makes it simple.
 *
 * Every shape a region can be made from -- a rectangle, an ellipse, a polygon,
 * a rounded rectangle, the rectangles of an RGNDATA -- is reduced to that form
 * here, and the four ways of combining two regions work on it exactly: a union
 * of two far-apart rectangles is the two rectangles, not the span between.
 *
 * The figures are filled by the rule the drawing layer fills them by: a pixel
 * is inside when its centre is, the leading edges in and the trailing ones out.
 */

import { boundsOf, isEmptyRect } from './rects.js';

/** @typedef {import('./rects.js').Rect} Rect */

/**
 * Rows `top` to `bottom`, each the same spans: x where one starts, x where it
 * stops, and again.
 *
 * @typedef {{ top: number, bottom: number, spans: number[] }} Band
 */

/** CombineRgn's modes. */
export const RGN_AND = 1;
export const RGN_OR = 2;
export const RGN_XOR = 3;
export const RGN_DIFF = 4;
export const RGN_COPY = 5;

/** Polygon fill modes. */
export const ALTERNATE = 1;
export const WINDING = 2;

/**
 * How far a coordinate a figure is made from may reach. NT's device space is
 * 27 bits a side, and a polygon that reaches past it answers an empty region
 * rather than one that wraps (Wine's test_CreatePolyPolygonRgn) -- and rather
 * than a raster of two thousand million rows.
 */
const COORDINATE_LIMIT = 1 << 27;

/** @type {Record<number, (inA: boolean, inB: boolean) => boolean>} */
const OPERATIONS = {
    [RGN_AND]: (a, b)=>a && b,
    [RGN_OR]: (a, b)=>a || b,
    [RGN_XOR]: (a, b)=>a !== b,
    [RGN_DIFF]: (a, b)=>a && !b,
};

/** @param {number[]} a @param {number[]} b */
const sameSpans = (a, b)=>a.length === b.length && a.every((value, index)=>value === b[index]);

/**
 * Adds rows to the bands, joining them onto the last band when they continue
 * it with the same spans. Rows with nothing in them add nothing.
 *
 * @param {Band[]} bands @param {number} top @param {number} bottom @param {number[]} spans
 */
function pushBand(bands, top, bottom, spans){
    if (spans.length === 0 || bottom <= top)
    {
        return;
    }
    const last = bands.at(-1);
    if (last && last.bottom === top && sameSpans(last.spans, spans))
    {
        last.bottom = bottom;
        return;
    }
    bands.push({ top, bottom, spans });
}

/**
 * Intervals, in any order and overlapping as they like, as the spans they
 * cover: sorted, and joined where they meet or overlap.
 *
 * @param {[number, number][]} intervals
 * @returns {number[]}
 */
function mergeIntervals(intervals){
    const sorted = intervals.filter(([from, to])=>to > from).sort((a, b)=>a[0] - b[0]);
    /** @type {number[]} */
    const spans = [];
    for (const [from, to] of sorted)
    {
        if (spans.length > 0 && from <= spans[spans.length - 1])
        {
            spans[spans.length - 1] = Math.max(spans[spans.length - 1], to);
        }
        else
        {
            spans.push(from, to);
        }
    }
    return spans;
}

/**
 * Rectangles, overlapping or not, as the bands of what they cover together.
 *
 * @param {Rect[]} rects
 * @returns {Band[]}
 */
export function bandsOf(rects){
    const pieces = rects.filter(rect=>!isEmptyRect(rect));
    const edges = [...new Set(pieces.flatMap(rect=>[rect.top, rect.bottom]))].sort((a, b)=>a - b);
    /** @type {Band[]} */
    const bands = [];
    for (let index = 0; index + 1 < edges.length; index++)
    {
        const top = edges[index];
        const bottom = edges[index + 1];
        pushBand(bands, top, bottom, mergeIntervals(pieces
            .filter(rect=>rect.top <= top && rect.bottom >= bottom)
            .map(rect=>/** @type {[number, number]} */ ([rect.left, rect.right]))));
    }
    return bands;
}

/**
 * The bands as rectangles, top to bottom and left to right.
 *
 * @param {Band[]} bands
 * @returns {Rect[]}
 */
export function rectsOf(bands){
    /** @type {Rect[]} */
    const rects = [];
    for (const band of bands)
    {
        for (let at = 0; at < band.spans.length; at += 2)
        {
            rects.push({ left: band.spans[at], top: band.top, right: band.spans[at + 1],
                bottom: band.bottom });
        }
    }
    return rects;
}

/**
 * An area of rectangles in the one form: see the header.
 *
 * @param {Rect[]} rects
 * @returns {Rect[]}
 */
export const areaOf = rects=>rectsOf(bandsOf(rects));

/**
 * Two rows of spans combined by an operation on whether a point is in each.
 *
 * @param {number[]} a @param {number[]} b
 * @param {(inA: boolean, inB: boolean) => boolean} operation
 * @returns {number[]}
 */
function combineSpans(a, b, operation){
    const xs = [...new Set([...a, ...b])].sort((p, q)=>p - q);
    /** @type {number[]} */
    const spans = [];
    let ia = 0;
    let ib = 0;
    for (let index = 0; index + 1 < xs.length; index++)
    {
        const x = xs[index];
        while (ia < a.length && a[ia + 1] <= x)
        {
            ia += 2;
        }
        while (ib < b.length && b[ib + 1] <= x)
        {
            ib += 2;
        }
        const inA = ia < a.length && a[ia] <= x;
        const inB = ib < b.length && b[ib] <= x;
        if (!operation(inA, inB))
        {
            continue;
        }
        if (spans.length > 0 && spans[spans.length - 1] === x)
        {
            spans[spans.length - 1] = xs[index + 1];
        }
        else
        {
            spans.push(x, xs[index + 1]);
        }
    }
    return spans;
}

/**
 * Two areas combined as CombineRgn combines them; null for a mode that is
 * none of AND, OR, XOR, DIFF and COPY. COPY is the first area.
 *
 * @param {Rect[]} first @param {Rect[]} second @param {number} mode
 * @returns {Rect[] | null}
 */
export function combineAreas(first, second, mode){
    if ((mode | 0) === RGN_COPY)
    {
        return areaOf(first);
    }
    const operation = OPERATIONS[mode | 0];
    if (!operation)
    {
        return null;
    }
    const a = bandsOf(first);
    const b = bandsOf(second);
    const edges = [...new Set([...a, ...b].flatMap(band=>[band.top, band.bottom]))]
        .sort((p, q)=>p - q);
    /** @type {Band[]} */
    const bands = [];
    let ia = 0;
    let ib = 0;
    for (let index = 0; index + 1 < edges.length; index++)
    {
        const top = edges[index];
        while (ia < a.length && a[ia].bottom <= top)
        {
            ia++;
        }
        while (ib < b.length && b[ib].bottom <= top)
        {
            ib++;
        }
        const spansA = ia < a.length && a[ia].top <= top ? a[ia].spans : [];
        const spansB = ib < b.length && b[ib].top <= top ? b[ib].spans : [];
        pushBand(bands, top, edges[index + 1], combineSpans(spansA, spansB, operation));
    }
    return rectsOf(bands);
}

/**
 * The smallest rectangle round an area, and all zeros for an empty one:
 * an empty region has no position.
 *
 * @param {Rect[]} area
 * @returns {Rect}
 */
export const areaBox = area=>boundsOf(area.filter(rect=>!isEmptyRect(rect)));

/**
 * Whether a pixel is in an area.
 *
 * @param {Rect[]} area @param {number} x @param {number} y
 */
export const areaContains = (area, x, y)=>area.some(rect=>x >= rect.left && x < rect.right
    && y >= rect.top && y < rect.bottom);

/**
 * An area moved.
 *
 * @param {Rect[]} area @param {number} dx @param {number} dy
 * @returns {Rect[]}
 */
export const offsetArea = (area, dx, dy)=>area.map(rect=>({
    left: (rect.left + dx) | 0, top: (rect.top + dy) | 0,
    right: (rect.right + dx) | 0, bottom: (rect.bottom + dy) | 0,
}));

/**
 * Whether two areas hold the same pixels.
 *
 * @param {Rect[]} a @param {Rect[]} b
 */
export function areasEqual(a, b){
    const one = areaOf(a);
    const other = areaOf(b);
    return one.length === other.length && one.every((rect, index)=>rect.left === other[index].left
        && rect.top === other[index].top && rect.right === other[index].right
        && rect.bottom === other[index].bottom);
}

/**
 * A rectangle given by any two opposite corners.
 *
 * @param {number} left @param {number} top @param {number} right @param {number} bottom
 * @returns {Rect}
 */
export const orderedRect = (left, top, right, bottom)=>({
    left: Math.min(left | 0, right | 0), top: Math.min(top | 0, bottom | 0),
    right: Math.max(left | 0, right | 0), bottom: Math.max(top | 0, bottom | 0),
});

/**
 * The pixels of a row whose centres lie between two crossings of it: from
 * the first centre at or after `from` to the last one before `to`.
 *
 * @param {number} from @param {number} to
 * @returns {[number, number]}
 */
const centresBetween = (from, to)=>[Math.ceil(from - 0.5) | 0, Math.ceil(to - 0.5) | 0];

/**
 * The area inside polygons, by the fill mode: ALTERNATE is inside an odd
 * number of edges, WINDING is wound round a number of times other than
 * none. Every polygon is closed, its last point joined to its first, and
 * they are filled together -- one inside another under ALTERNATE is a hole.
 * Polygons with no inside (a point, a line) add nothing.
 *
 * @param {{ x: number, y: number }[][]} polygons @param {number} [fillMode]
 * @returns {Rect[]}
 */
export function polygonArea(polygons, fillMode = ALTERNATE){
    const winding = fillMode === WINDING;
    /** @type {{ x0: number, y0: number, x1: number, y1: number }[]} */
    const edges = [];
    for (const points of polygons)
    {
        for (let index = 0; index < points.length; index++)
        {
            const from = points[index];
            const to = points[(index + 1) % points.length];
            if (from.y !== to.y)
            {
                edges.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y });
            }
        }
    }
    if (edges.length === 0 || edges.some(edge=>[edge.x0, edge.y0, edge.x1, edge.y1]
        .some(value=>Math.abs(value) >= COORDINATE_LIMIT)))
    {
        return [];
    }
    // A figure worked out in fractions -- a widened line -- covers the rows
    // its edges reach into, which are whole either way.
    const top = Math.floor(edges.reduce((least, edge)=>Math.min(least, edge.y0, edge.y1),
        Infinity));
    const bottom = Math.ceil(edges.reduce((most, edge)=>Math.max(most, edge.y0, edge.y1),
        -Infinity));
    /** @type {Band[]} */
    const bands = [];
    for (let y = top; y < bottom; y++)
    {
        const sample = y + 0.5;
        /** @type {{ x: number, direction: number }[]} */
        const crossings = [];
        for (const edge of edges)
        {
            if ((edge.y0 <= sample) === (edge.y1 <= sample))
            {
                continue;
            }
            crossings.push({
                x: edge.x0 + (sample - edge.y0) * (edge.x1 - edge.x0) / (edge.y1 - edge.y0),
                direction: edge.y1 > edge.y0 ? 1 : -1,
            });
        }
        crossings.sort((a, b)=>a.x - b.x);
        /** @type {[number, number][]} */
        const intervals = [];
        let count = 0;
        for (let index = 0; index + 1 < crossings.length; index++)
        {
            count += winding ? crossings[index].direction : 1;
            if (winding ? count !== 0 : (count & 1) !== 0)
            {
                intervals.push(centresBetween(crossings[index].x, crossings[index + 1].x));
            }
        }
        pushBand(bands, y, y + 1, mergeIntervals(intervals));
    }
    return rectsOf(bands);
}

/**
 * The area of a rectangle with its corners rounded by quarters of an ellipse
 * `width` by `height`, which is no larger than the rectangle; an ellipse is
 * the rectangle rounded by one as large as itself. A corner too small to
 * round anything leaves the plain rectangle.
 *
 * @param {Rect} box  Ordered.
 * @param {number} width @param {number} height
 * @returns {Rect[]}
 */
export function roundedArea(box, width, height){
    if (isEmptyRect(box) || [box.left, box.top, box.right, box.bottom]
        .some(value=>Math.abs(value) >= COORDINATE_LIMIT))
    {
        return [];
    }
    const rx = Math.min(Math.abs(width), box.right - box.left) / 2;
    const ry = Math.min(Math.abs(height), box.bottom - box.top) / 2;
    if (rx < 1 || ry < 1)
    {
        return [{ ...box }];
    }
    /** @type {Band[]} */
    const bands = [];
    for (let y = box.top; y < box.bottom; y++)
    {
        const sample = y + 0.5;
        // How far into a corner's ellipse the row is, from its centre line.
        const into = sample < box.top + ry ? box.top + ry - sample
            : sample > box.bottom - ry ? sample - (box.bottom - ry) : 0;
        const ratio = into / ry;
        if (ratio >= 1)
        {
            continue;
        }
        const inset = rx - rx * Math.sqrt(1 - ratio * ratio);
        const [from, to] = centresBetween(box.left + inset, box.right - inset);
        pushBand(bands, y, y + 1, to > from ? [from, to] : []);
    }
    return rectsOf(bands);
}
