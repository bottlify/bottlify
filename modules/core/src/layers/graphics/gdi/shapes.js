/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Lines, rectangles, ellipses and polygons.
 *
 * The filling convention is the whole subject of this file, and it is Windows':
 * a filled figure covers `[left, right)` by `[top, bottom)`. The leading edge is
 * in and the trailing edge is out, so two rectangles that share an edge paint
 * that edge exactly once, and a tiled surface has no seam and no doubled column.
 * `LineTo` is the same rule read along one dimension: it draws from the current
 * position up to but not including its endpoint, which is what makes a polyline
 * of joined segments paint each junction once.
 *
 * The figures a pen outlines -- Rectangle, Ellipse, Polygon -- are drawn on the
 * boundary of that same half-open rectangle, so their border occupies
 * `right - 1` and `bottom - 1` and the whole figure still fits inside the
 * rectangle the program named.
 *
 * Lines are Bresenham: integer arithmetic, one pixel per step along the major
 * axis, and no floating point anywhere on the path.
 */

import { applyRop2, rop2Table, R2_COPYPEN } from './rop.js';
import { TRANSPARENT_PIXEL } from './brush.js';
import { colorToPixel, intersectRect, isEmptyRect, surfaceBounds } from './surface.js';

/** Pen styles. Only the two that change whether a pixel is painted matter here. */
export const PS_SOLID = 0;
export const PS_NULL = 5;

/** Polygon fill modes. */
export const ALTERNATE = 1;
export const WINDING = 2;

/**
 * @typedef {Object} Painter
 * @property {import("./contract.js").Surface} surface
 * @property {import("./contract.js").Rect} clip
 * @property {(x: number, y: number, pixel: number) => void} plot
 * @property {(rect: import("./contract.js").Rect) => Painter} narrow
 */

/**
 * Everything that draws goes through one pixel writer, so the clip test and the
 * binary raster operation are applied in one place rather than at each caller.
 *
 * `narrow` exists because a clip that tightens for one call -- ETO_CLIPPED is
 * the only one so far -- must intersect with the context's clip rather than
 * replace it, and a painter whose bounds live in a closure cannot be narrowed
 * by copying the object.
 *
 * @param {import("./contract.js").Surface} surface
 * @param {import("./contract.js").Rect} [clip]
 * @param {number} [rop2]
 * @returns {Painter}
 */
export function createPainter(surface, clip, rop2){
    const bounds = intersectRect(clip ?? surfaceBounds(surface), surfaceBounds(surface));
    const mode = rop2 ?? R2_COPYPEN;
    const table = rop2Table(mode);
    return {
        surface,
        clip: bounds,
        plot(x, y, pixel){
            if (pixel === TRANSPARENT_PIXEL)
            {
                return;
            }
            if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom)
            {
                return;
            }
            surface.write(x, y, applyRop2(table, pixel, surface.read(x, y)));
        },
        narrow(rect){
            return createPainter(surface, intersectRect(bounds, rect), mode);
        },
    };
}

/**
 * @typedef {Object} Pen
 * @property {number} style
 * @property {number} width
 * @property {number} color
 */

/**
 * Stamps one point of a line. A pen wider than a pixel is drawn as a square
 * centred on the path -- an approximation of a geometric pen's round join, and
 * the placeholder stays until there is a reason to model joins properly.
 *
 * @param {Painter} painter
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} pixel
 */
function stamp(painter, x, y, width, pixel){
    if (width <= 1)
    {
        painter.plot(x, y, pixel);
        return;
    }
    const before = (width - 1) >> 1;
    for (let dy = -before; dy < width - before; dy++)
    {
        for (let dx = -before; dx < width - before; dx++)
        {
            painter.plot(x + dx, y + dy, pixel);
        }
    }
}

/**
 * @param {Pen} pen
 * @returns {boolean} whether the pen paints at all
 */
function penPaints(pen){
    return pen.style !== PS_NULL;
}

/**
 * Bresenham from one point to another, excluding the endpoint.
 *
 * @param {Painter} painter
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {Pen} pen
 */
export function line(painter, x0, y0, x1, y1, pen){
    if (!penPaints(pen))
    {
        return;
    }
    const pixel = colorToPixel(pen.color);
    const width = Math.max(1, pen.width | 0);
    const stepX = x0 < x1 ? 1 : -1;
    const stepY = y0 < y1 ? 1 : -1;
    const spanX = Math.abs(x1 - x0);
    const spanY = -Math.abs(y1 - y0);
    let error = spanX + spanY;
    let x = x0;
    let y = y0;
    for (;;)
    {
        if (x === x1 && y === y1)
        {
            return;
        }
        stamp(painter, x, y, width, pixel);
        const doubled = 2 * error;
        if (doubled >= spanY)
        {
            error += spanY;
            x += stepX;
        }
        if (doubled <= spanX)
        {
            error += spanX;
            y += stepY;
        }
    }
}

/**
 * @param {Painter} painter
 * @param {import("./contract.js").Rect} rect
 * @param {import("./contract.js").PatternSource} pattern
 */
export function fillRect(painter, rect, pattern){
    const area = intersectRect(rect, painter.clip);
    if (isEmptyRect(area))
    {
        return;
    }
    for (let y = area.top; y < area.bottom; y++)
    {
        for (let x = area.left; x < area.right; x++)
        {
            painter.plot(x, y, pattern(x, y));
        }
    }
}

/**
 * A one-pixel border drawn inside the rectangle, not around it: the frame's
 * outer edge is the rectangle's own half-open boundary.
 *
 * @param {Painter} painter
 * @param {import("./contract.js").Rect} rect
 * @param {import("./contract.js").PatternSource} pattern
 */
export function frameRect(painter, rect, pattern){
    if (isEmptyRect(rect))
    {
        return;
    }
    fillRect(painter, { ...rect, bottom: rect.top + 1 }, pattern);
    fillRect(painter, { ...rect, top: rect.bottom - 1 }, pattern);
    fillRect(painter, { ...rect, right: rect.left + 1 }, pattern);
    fillRect(painter, { ...rect, left: rect.right - 1 }, pattern);
}

/**
 * Rectangle: the brush fills the interior, the pen outlines the boundary, and
 * together they cover `[left, right - 1]` by `[top, bottom - 1]`.
 *
 * @param {Painter} painter
 * @param {import("./contract.js").Rect} rect
 * @param {Pen} pen
 * @param {import("./contract.js").PatternSource} pattern
 */
export function rectangle(painter, rect, pen, pattern){
    if (rect.right - 1 < rect.left || rect.bottom - 1 < rect.top)
    {
        return;
    }
    fillRect(painter, {
        left: rect.left + 1,
        top: rect.top + 1,
        right: rect.right - 1,
        bottom: rect.bottom - 1,
    }, pattern);
    if (!penPaints(pen))
    {
        return;
    }
    const pixel = colorToPixel(pen.color);
    frameRect(painter, rect, ()=>pixel);
}

/**
 * Ellipse: the same half-open bounding box, with the curve on its boundary.
 *
 * The outline is taken as the border of the filled set rather than walked with
 * a curve rasteriser, which is shorter and, more usefully, cannot disagree with
 * the fill about where the edge is -- a one-pixel gap between an outline and its
 * own interior is the classic way this goes wrong.
 *
 * @param {Painter} painter
 * @param {import("./contract.js").Rect} rect
 * @param {Pen} pen
 * @param {import("./contract.js").PatternSource} pattern
 */
export function ellipse(painter, rect, pen, pattern){
    const right = rect.right - 1;
    const bottom = rect.bottom - 1;
    if (right < rect.left || bottom < rect.top)
    {
        return;
    }
    const centreX = (rect.left + right) / 2;
    const centreY = (rect.top + bottom) / 2;
    // A degenerate axis is half a pixel wide, not zero: that keeps the single
    // row or column of a flat ellipse inside the figure instead of dividing by
    // nothing.
    const radiusX = Math.max((right - rect.left) / 2, 0.5);
    const radiusY = Math.max((bottom - rect.top) / 2, 0.5);
    /** @param {number} x @param {number} y */
    const inside = (x, y)=>{
        const dx = (x - centreX) / radiusX;
        const dy = (y - centreY) / radiusY;
        return (dx * dx) + (dy * dy) <= 1;
    };
    for (let y = rect.top; y <= bottom; y++)
    {
        for (let x = rect.left; x <= right; x++)
        {
            if (inside(x, y))
            {
                painter.plot(x, y, pattern(x, y));
            }
        }
    }
    if (!penPaints(pen))
    {
        return;
    }
    const pixel = colorToPixel(pen.color);
    const width = Math.max(1, pen.width | 0);
    for (let y = rect.top; y <= bottom; y++)
    {
        for (let x = rect.left; x <= right; x++)
        {
            const edge = inside(x, y)
                && (!inside(x - 1, y) || !inside(x + 1, y)
                    || !inside(x, y - 1) || !inside(x, y + 1));
            if (edge)
            {
                stamp(painter, x, y, width, pixel);
            }
        }
    }
}

/**
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * Polygon: scanline fill, then the edges stroked with the pen.
 *
 * Each scanline is sampled at its centre and a span runs from the first pixel
 * centre at or after the left crossing to the last one strictly before the
 * right crossing -- half-open, the same rule as every other filled figure here,
 * so two polygons sharing an edge do not paint it twice.
 *
 * @param {Painter} painter
 * @param {Point[]} points
 * @param {Pen} pen
 * @param {import("./contract.js").PatternSource} pattern
 * @param {number} [fillMode]
 */
export function polygon(painter, points, pen, pattern, fillMode){
    if (points.length < 2)
    {
        return;
    }
    const winding = (fillMode ?? ALTERNATE) === WINDING;
    const top = Math.max(painter.clip.top, Math.min(...points.map(point=>point.y)));
    const bottom = Math.min(painter.clip.bottom, Math.max(...points.map(point=>point.y)) + 1);
    for (let y = top; y < bottom; y++)
    {
        const sample = y + 0.5;
        /** @type {{ x: number, direction: number }[]} */
        const crossings = [];
        for (let index = 0; index < points.length; index++)
        {
            const from = points[index];
            const to = points[(index + 1) % points.length];
            if ((from.y <= sample) === (to.y <= sample))
            {
                continue;
            }
            const ratio = (sample - from.y) / (to.y - from.y);
            crossings.push({
                x: from.x + (ratio * (to.x - from.x)),
                direction: to.y > from.y ? 1 : -1,
            });
        }
        crossings.sort((a, b)=>a.x - b.x);
        let count = 0;
        for (let index = 0; index < crossings.length - 1; index++)
        {
            count += winding ? crossings[index].direction : 1;
            const covered = winding ? count !== 0 : (count % 2) !== 0;
            if (!covered)
            {
                continue;
            }
            const left = Math.max(painter.clip.left, Math.ceil(crossings[index].x - 0.5));
            const right = Math.min(painter.clip.right,
                Math.ceil(crossings[index + 1].x - 0.5));
            for (let x = left; x < right; x++)
            {
                painter.plot(x, y, pattern(x, y));
            }
        }
    }
    for (let index = 0; index < points.length; index++)
    {
        const from = points[index];
        const to = points[(index + 1) % points.length];
        line(painter, from.x, from.y, to.x, to.y, pen);
    }
}
