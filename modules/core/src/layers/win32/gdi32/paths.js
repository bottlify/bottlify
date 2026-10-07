/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A DC's path: what the line and curve calls made between BeginPath and
 * EndPath drew, kept as points instead of pixels, each with the type GetPath
 * answers -- a move that starts a figure, a line to the point, the three
 * points of a curve, and a close on the last point of a figure that ends
 * where it began.
 *
 * The points are the device's, each mapped as it was added, as Windows keeps
 * them: a path drawn under one mapping and filled under another lands where
 * it was drawn, and GetPath maps the points back to the logical units of the
 * moment it is asked.
 *
 * A figure is started lazily, as Windows starts one: MoveToEx only says where
 * the next one begins, and the move is written when a line or curve is drawn
 * from there. After a figure is closed, the next begins where the closed one
 * did, not where its last line ended (Wine's test_polydraw), unless a move
 * says otherwise.
 */

import { WINDING, areaOf, polygonArea } from './regions.js';

/** GetPath's and PolyDraw's point types. */
export const PT_CLOSEFIGURE = 0x01;
export const PT_LINETO = 0x02;
export const PT_BEZIERTO = 0x04;
export const PT_MOVETO = 0x06;

/** How far a control point stands from the end of a quarter of an ellipse, per radius. */
const QUARTER = 4 * (Math.SQRT2 - 1) / 3;

/** @typedef {{ x: number, y: number }} Point */

/**
 * @typedef {Object} Path
 * @property {boolean} open  Between BeginPath and EndPath.
 * @property {Point[]} points
 * @property {number[]} types
 * @property {boolean} pending  Whether the next line or curve starts a figure.
 * @property {Point | null} start  Where the figure being drawn began.
 * @property {Point | null} restart  Where the next figure begins after a close.
 */

/** @returns {Path} an open path with nothing in it */
export const createPath = ()=>({ open: true, points: [], types: [], pending: true, start: null,
    restart: null });

/**
 * A copy that shares nothing with the path: what SaveDC keeps.
 *
 * @param {Path} path
 * @returns {Path}
 */
export const copyPath = path=>({ ...path, points: path.points.map(point=>({ ...point })),
    types: [...path.types] });

/** @param {Path} path @param {Point} point @param {number} type */
const push = (path, point, type)=>{
    path.points.push({ x: Math.round(point.x), y: Math.round(point.y) });
    path.types.push(type);
};

/**
 * Begins a figure at `from`, unless one is under way.
 *
 * @param {Path} path @param {Point} from
 */
function begin(path, from){
    if (!path.pending)
    {
        return;
    }
    const at = path.restart ?? from;
    push(path, at, PT_MOVETO);
    path.start = { ...at };
    path.pending = false;
    path.restart = null;
}

/**
 * The current position moved: the next line starts a figure there.
 *
 * @param {Path} path
 */
export function pathMoved(path){
    path.pending = true;
    path.restart = null;
}

/**
 * A line from the current position.
 *
 * @param {Path} path @param {Point} from @param {Point} to
 */
export function pathLineTo(path, from, to){
    begin(path, from);
    push(path, to, PT_LINETO);
}

/**
 * A cubic curve from the current position.
 *
 * @param {Path} path @param {Point} from @param {Point} first @param {Point} second
 * @param {Point} end
 */
export function pathBezierTo(path, from, first, second, end){
    begin(path, from);
    push(path, first, PT_BEZIERTO);
    push(path, second, PT_BEZIERTO);
    push(path, end, PT_BEZIERTO);
}

/**
 * Closes the figure being drawn: its last point carries the close, and the
 * next figure begins where this one did. A figure with no line in it has
 * nothing to close.
 *
 * @param {Path} path
 */
export function pathClose(path){
    const last = path.types.length - 1;
    if (!path.pending && last >= 0 && path.types[last] !== PT_MOVETO)
    {
        path.types[last] |= PT_CLOSEFIGURE;
        path.restart = path.start;
    }
    path.pending = true;
}

/**
 * A figure of its own, which does not start from the current position: a
 * move to the first point, lines -- or curves, three points each -- through
 * the rest, and a close when it is a closed shape.
 *
 * @param {Path} path @param {Point[]} points
 * @param {{ closed?: boolean, curves?: boolean }} [shape]
 */
export function pathFigure(path, points, { closed = false, curves = false } = {}){
    if (points.length === 0)
    {
        return;
    }
    push(path, points[0], PT_MOVETO);
    for (const point of points.slice(1))
    {
        push(path, point, curves ? PT_BEZIERTO : PT_LINETO);
    }
    path.start = { ...points[0] };
    path.pending = false;
    path.restart = null;
    if (closed && points.length > 1)
    {
        pathClose(path);
    }
    path.pending = true;
    path.restart = null;
}

/**
 * The thirteen points of an ellipse as four curves, from the middle of its
 * right side round to it again: counterclockwise on the screen, or clockwise.
 *
 * @param {{ left: number, top: number, right: number, bottom: number }} box
 * @param {boolean} clockwise
 * @returns {Point[]}
 */
export function ellipseCurves(box, clockwise){
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    const kx = (box.right - box.left) / 2 * QUARTER;
    const ky = (box.bottom - box.top) / 2 * QUARTER;
    const points = [
        { x: box.right, y: cy },
        { x: box.right, y: cy - ky }, { x: cx + kx, y: box.top }, { x: cx, y: box.top },
        { x: cx - kx, y: box.top }, { x: box.left, y: cy - ky }, { x: box.left, y: cy },
        { x: box.left, y: cy + ky }, { x: cx - kx, y: box.bottom }, { x: cx, y: box.bottom },
        { x: cx + kx, y: box.bottom }, { x: box.right, y: cy + ky }, { x: box.right, y: cy },
    ];
    return clockwise ? points.reverse() : points;
}

/**
 * The points of a cubic Bézier curve from `start` to `end` pulled towards the
 * two control points, a segment for about every two pixels of the control
 * polygon -- which is never shorter than the curve -- and the same point never
 * twice in a row. The ends are the points given, exactly.
 *
 * @param {Point} start @param {Point} first @param {Point} second @param {Point} end
 * @returns {Point[]}
 */
export function bezierPoints(start, first, second, end){
    const reach = Math.hypot(first.x - start.x, first.y - start.y)
        + Math.hypot(second.x - first.x, second.y - first.y)
        + Math.hypot(end.x - second.x, end.y - second.y);
    const steps = Math.max(1, Math.ceil(reach / 2));
    /** @type {Point[]} */
    const points = [];
    for (let index = 0; index <= steps; index++)
    {
        const t = index / steps;
        const u = 1 - t;
        const weights = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        /** @param {'x' | 'y'} axis */
        const along = axis=>Math.round(weights[0] * start[axis] + weights[1] * first[axis]
            + weights[2] * second[axis] + weights[3] * end[axis]);
        const point = { x: along('x'), y: along('y') };
        const last = points.at(-1);
        if (!last || last.x !== point.x || last.y !== point.y)
        {
            points.push(point);
        }
    }
    return points;
}

/**
 * A path as the figures it holds, every curve taken to lines: the points of
 * each, and whether it was closed.
 *
 * @param {Path} path
 * @returns {{ points: Point[], closed: boolean }[]}
 */
export function figuresOf(path){
    /** @type {{ points: Point[], closed: boolean }[]} */
    const figures = [];
    /** @type {{ points: Point[], closed: boolean } | null} */
    let figure = null;
    for (let index = 0; index < path.points.length; index++)
    {
        const type = path.types[index];
        const point = path.points[index];
        if ((type & ~PT_CLOSEFIGURE) === PT_MOVETO || !figure)
        {
            figure = { points: [point], closed: false };
            figures.push(figure);
        }
        else if ((type & ~PT_CLOSEFIGURE) === PT_BEZIERTO && index + 2 < path.points.length)
        {
            const from = figure.points[figure.points.length - 1];
            figure.points.push(...bezierPoints(from, point, path.points[index + 1],
                path.points[index + 2]).slice(1));
            index += 2;
        }
        else
        {
            figure.points.push(point);
        }
        if ((path.types[index] & PT_CLOSEFIGURE) !== 0)
        {
            figure.closed = true;
        }
    }
    return figures;
}

/**
 * The same figures with every curve made lines: FlattenPath.
 *
 * @param {Path} path
 * @returns {Path}
 */
export function flattened(path){
    const flat = { ...createPath(), open: path.open };
    for (const figure of figuresOf(path))
    {
        pathFigure(flat, figure.points, { closed: figure.closed });
    }
    return flat;
}

/** Sides of the polygon a round join or end is drawn as. */
const ROUND_SIDES = 16;

/**
 * @param {Point[]} points
 * @returns {Point[]} the same polygon, counterclockwise in the maths sense
 */
const wound = points=>{
    let twice = 0;
    for (let index = 0; index < points.length; index++)
    {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        twice += a.x * b.y - b.x * a.y;
    }
    return twice < 0 ? [...points].reverse() : points;
};

/**
 * What the pen covers drawing the figures, as a path: WidenPath. Each line
 * is a band as wide as the pen and each point it passes a disc as wide, the
 * round joins and ends of the pen CreatePen makes; together they are one
 * area, given back as the rectangles it is made of, each a closed figure --
 * which fill, stroke and make a region the same way the outline would.
 *
 * @param {Path} path @param {number} width  The pen's, in logical units; one at least.
 * @returns {Path}
 */
export function widened(path, width){
    const half = Math.max(1, width) / 2;
    /** @type {Point[][]} */
    const pieces = [];
    for (const figure of figuresOf(path))
    {
        const points = figure.points;
        const count = figure.closed ? points.length : points.length - 1;
        for (let index = 0; index < count; index++)
        {
            const a = points[index];
            const b = points[(index + 1) % points.length];
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            if (length === 0)
            {
                continue;
            }
            const nx = -(b.y - a.y) / length * half;
            const ny = (b.x - a.x) / length * half;
            pieces.push(wound([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
                { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]));
        }
        for (const point of points)
        {
            pieces.push(wound(Array.from({ length: ROUND_SIDES }, (_, side)=>{
                const angle = 2 * Math.PI * side / ROUND_SIDES;
                return { x: point.x + half * Math.cos(angle), y: point.y + half * Math.sin(angle) };
            })));
        }
    }
    const area = areaOf(polygonArea(pieces, WINDING));
    const wide = { ...createPath(), open: path.open };
    for (const rect of area)
    {
        pathFigure(wide, [{ x: rect.right, y: rect.top }, { x: rect.left, y: rect.top },
            { x: rect.left, y: rect.bottom }, { x: rect.right, y: rect.bottom }],
        { closed: true });
    }
    return wide;
}
