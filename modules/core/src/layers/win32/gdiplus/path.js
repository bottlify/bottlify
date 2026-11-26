/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s paths: points and a type byte each (PathPointType) - a figure's
 * start, a line to, a third of a cubic Bezier - with the flags that close a
 * figure and mark it, and the fill mode a fill takes the path by.
 *
 * Every shape is laid down as GDI+ lays it: an arc as Bezier quarters at
 * most 90 degrees of the angle asked each, the angle taken on the circle the
 * ellipse is stretched from; a cardinal spline as Beziers whose control
 * points lie tension / 3 of the chord between a point's neighbours away; a
 * rectangle, ellipse, polygon or pie as a closed figure of its own. A shape
 * added to an open figure joins it with a line.
 *
 * What the other families take a path through - its points flattened to
 * polygons, a point inside it - is exported: a region of a path, a fill.
 */

import { Status, fn } from './kit.js';
import { apply } from './matrix.js';

/** PathPointType. */
export const PathPointTypeStart = 0;
export const PathPointTypeLine = 1;
export const PathPointTypeBezier = 3;
export const PathPointTypePathTypeMask = 7;
export const PathPointTypeDashMode = 0x10;
export const PathPointTypePathMarker = 0x20;
export const PathPointTypeCloseSubpath = 0x80;

/** FillMode. */
export const FillModeAlternate = 0;
export const FillModeWinding = 1;

/** The flatness GDI+ flattens by when none is given (FlatnessDefault). */
export const FLATNESS_DEFAULT = 0.25;

/**
 * @typedef {Object} Path
 * @property {[number, number][]} points
 * @property {number[]} types
 * @property {number} fill  FillMode
 * @property {boolean} open  whether a figure is open for the next shape to join
 */

/** @param {number} fill @returns {Path} */
export const emptyPath = (fill = FillModeAlternate)=>({ points: [], types: [], fill, open: false });

/** @param {Path} path @returns {Path} */
export const clonePath = path=>({ points: path.points.map(([x, y])=>[x, y]),
    types: [...path.types], fill: path.fill, open: path.open });

/** @param {number} value */
const f = value=>Math.fround(value);

/**
 * Adds a point that begins a shape: a new figure's start, or a line on
 * from the open figure.
 *
 * @param {Path} path @param {[number, number]} point
 */
const begin = (path, [x, y])=>{
    const last = path.points[path.points.length - 1];
    // A shape that starts where the open figure ends goes on from that point.
    if (path.open && last && last[0] === f(x) && last[1] === f(y))
    {
        return;
    }
    path.points.push([f(x), f(y)]);
    path.types.push(path.open ? PathPointTypeLine : PathPointTypeStart);
    path.open = true;
};

/** @param {Path} path @param {[number, number]} point @param {number} type */
const push = (path, [x, y], type)=>{
    path.points.push([f(x), f(y)]);
    path.types.push(type);
};

/** Closes the figure being drawn. @param {Path} path */
const closeFigure = path=>{
    if (path.types.length > 0)
    {
        path.types[path.types.length - 1] |= PathPointTypeCloseSubpath;
    }
    path.open = false;
};

/** @param {Path} path @param {[number, number][]} points */
const addLines = (path, points)=>{
    begin(path, points[0]);
    for (const point of points.slice(1))
    {
        push(path, point, PathPointTypeLine);
    }
};

/**
 * A start and Bezier thirds after it, three a curve.
 *
 * @param {Path} path @param {[number, number][]} points
 */
const addBeziers = (path, points)=>{
    begin(path, points[0]);
    for (const point of points.slice(1))
    {
        push(path, point, PathPointTypeBezier);
    }
};

/**
 * The angle on the circle an ellipse is stretched from that lands on the
 * ellipse at `degrees` round its centre - GDI+'s arcs are cut by the angle
 * a person sees, and drawn by the circle's.
 *
 * @param {number} degrees @param {number} rx @param {number} ry
 * @returns {number} radians
 */
const unstretch = (degrees, rx, ry)=>{
    const radians = degrees * Math.PI / 180;
    let stretched = Math.atan2(Math.sin(radians) / Math.abs(ry), Math.cos(radians) / Math.abs(rx));
    // Kept in the turn the angle asked is in.
    while (stretched - radians > Math.PI)
    {
        stretched -= 2 * Math.PI;
    }
    while (radians - stretched > Math.PI)
    {
        stretched += 2 * Math.PI;
    }
    return stretched;
};

/**
 * An arc of the ellipse in the rectangle as Bezier points, its start first:
 * its ends found on the circle the ellipse is stretched from, and the turn
 * between them cut there into quarters of at most 90 degrees.
 *
 * @param {number} x @param {number} y @param {number} width @param {number} height
 * @param {number} start @param {number} sweep  degrees, sweep clamped to a turn
 * @returns {[number, number][]}
 */
const arcBeziers = (x, y, width, height, start, sweep)=>{
    const rx = width / 2;
    const ry = height / 2;
    const cx = x + rx;
    const cy = y + ry;
    const turn = Math.max(-360, Math.min(360, sweep));
    /** @param {number} t @returns {[number, number]} */
    const at = t=>[cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
    const first = unstretch(start, rx, ry);
    // A whole turn stays whole: the end is the start one turn on.
    const last = Math.abs(turn) >= 360 ? first + Math.sign(turn) * 2 * Math.PI
        : unstretch(start + turn, rx, ry);
    const total = last - first;
    const quarter = Math.PI / 2;
    /** @type {[number, number][]} */
    const out = [at(first)];
    let done = 0;
    while (Math.abs(total - done) > 1e-7 || out.length === 1)
    {
        const step = total - done > 0 ? Math.min(quarter, total - done)
            : Math.max(-quarter, total - done);
        const from = first + done;
        const to = from + step;
        const k = 4 / 3 * Math.tan(step / 4);
        out.push([cx + rx * (Math.cos(from) - k * Math.sin(from)),
            cy + ry * (Math.sin(from) + k * Math.cos(from))]);
        out.push([cx + rx * (Math.cos(to) + k * Math.sin(to)),
            cy + ry * (Math.sin(to) - k * Math.cos(to))]);
        out.push(at(to));
        done += step;
        if (step === 0)
        {
            break;
        }
    }
    return out;
};

/**
 * A cardinal spline through `points` as Bezier points: each segment's
 * control points tension / 3 of the chord between its ends' neighbours
 * away; an end's missing neighbour is the end itself, or for a closed curve
 * the point at the other end.
 *
 * @param {[number, number][]} points @param {number} tension
 * @param {boolean} closed @param {number} [first] @param {number} [segments]
 * @returns {[number, number][]}
 */
const splineBeziers = (points, tension, closed, first = 0, segments = -1)=>{
    const n = points.length;
    const count = segments >= 0 ? segments : closed ? n : n - 1;
    const t = tension / 3;
    /** @param {number} i */
    const point = i=>(closed ? points[(i % n + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
    /** @param {number} i */
    const tangent = i=>{
        const [px, py] = point(i - 1);
        const [nx, ny] = point(i + 1);
        return [t * (nx - px), t * (ny - py)];
    };
    /** @type {[number, number][]} */
    const out = [point(first)];
    for (let i = first; i < first + count; i++)
    {
        const [ax, ay] = point(i);
        const [bx, by] = point(i + 1);
        const [tax, tay] = tangent(i);
        const [tbx, tby] = tangent(i + 1);
        out.push([ax + tax, ay + tay], [bx - tbx, by - tby], [bx, by]);
    }
    return out;
};

/**
 * One cubic Bezier flattened to points after its start, the chord kept
 * within `flatness` of the curve.
 *
 * @param {[number, number][]} curve  four points @param {number} flatness
 * @returns {[number, number][]}
 */
const flattenBezier = ([p0, p1, p2, p3], flatness)=>{
    /** @type {[number, number][]} */
    const out = [];
    /**
     * @param {[number, number]} a @param {[number, number]} b
     * @param {[number, number]} c @param {[number, number]} d @param {number} depth
     */
    const split = (a, b, c, d, depth)=>{
        // No flatness, or a curve of no finite size, is its chord.
        if (!(flatness > 0) || ![a, b, c, d].every(([x, y])=>Number.isFinite(x)
            && Number.isFinite(y)))
        {
            out.push(d);
            return;
        }
        const dx = d[0] - a[0];
        const dy = d[1] - a[1];
        const length = Math.hypot(dx, dy) || 1;
        const far = Math.max(Math.abs((b[0] - a[0]) * dy - (b[1] - a[1]) * dx),
            Math.abs((c[0] - a[0]) * dy - (c[1] - a[1]) * dx)) / length;
        if (far <= flatness || depth >= 16)
        {
            out.push(d);
            return;
        }
        /** @param {[number, number]} u @param {[number, number]} v @returns {[number, number]} */
        const mid = (u, v)=>[(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
        const ab = mid(a, b);
        const bc = mid(b, c);
        const cd = mid(c, d);
        const abc = mid(ab, bc);
        const bcd = mid(bc, cd);
        const abcd = mid(abc, bcd);
        split(a, ab, abc, abcd, depth + 1);
        split(abcd, bcd, cd, d, depth + 1);
    };
    split(p0, p1, p2, p3, 0);
    return out;
};

/**
 * The path with every Bezier flattened to lines, its types and flags kept
 * on the points that stay.
 *
 * @param {Path} path @param {number} [flatness]
 * @returns {Path}
 */
export const flatten = (path, flatness = FLATNESS_DEFAULT)=>{
    const flat = emptyPath(path.fill);
    for (let i = 0; i < path.points.length; i++)
    {
        const type = path.types[i] & PathPointTypePathTypeMask;
        if (type === PathPointTypeBezier && i + 2 < path.points.length && i > 0)
        {
            const flags = path.types[i + 2] & ~PathPointTypePathTypeMask;
            const lines = flattenBezier([path.points[i - 1], path.points[i], path.points[i + 1],
                path.points[i + 2]], flatness);
            lines.forEach((point, at)=>push(flat, point,
                PathPointTypeLine | (at === lines.length - 1 ? flags : 0)));
            i += 2;
            continue;
        }
        push(flat, path.points[i], path.types[i]);
    }
    flat.open = path.open;
    return flat;
};

/**
 * The path's figures as polygons, Beziers flattened: what a fill, a region
 * or a hit test takes.
 *
 * @param {Path} path @param {number} [flatness]
 * @returns {[number, number][][]}
 */
export const figures = (path, flatness = FLATNESS_DEFAULT)=>{
    const flat = flatten(path, flatness);
    /** @type {[number, number][][]} */
    const out = [];
    flat.types.forEach((type, at)=>{
        if ((type & PathPointTypePathTypeMask) === PathPointTypeStart || out.length === 0)
        {
            out.push([]);
        }
        out[out.length - 1].push(flat.points[at]);
    });
    return out;
};

/**
 * Whether a point is inside polygons under a fill mode: crossings counted
 * for alternate, their directions summed for winding.
 *
 * @param {[number, number][][]} polygons @param {number} x @param {number} y
 * @param {number} fill
 */
export const insidePolygons = (polygons, x, y, fill)=>{
    let crossings = 0;
    let winding = 0;
    for (const polygon of polygons)
    {
        for (let i = 0; i < polygon.length; i++)
        {
            const [ax, ay] = polygon[i];
            const [bx, by] = polygon[(i + 1) % polygon.length];
            if ((ay <= y) !== (by <= y))
            {
                const cross = ax + (y - ay) * (bx - ax) / (by - ay);
                if (x < cross)
                {
                    crossings++;
                    winding += by > ay ? 1 : -1;
                }
            }
        }
    }
    return fill === FillModeWinding ? winding !== 0 : crossings % 2 === 1;
};

/**
 * The bounds of points, [left, top, width, height]; all zero for none.
 *
 * @param {[number, number][]} points
 */
export const boundsOf = points=>{
    if (points.length === 0)
    {
        return [0, 0, 0, 0];
    }
    const xs = points.map(([x])=>x);
    const ys = points.map(([, y])=>y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return [left, top, Math.max(...xs) - left, Math.max(...ys) - top];
};

/**
 * Whether types make a path GDI+ keeps: Beziers in threes, nothing ending
 * on a figure's start.
 *
 * @param {number[]} types
 */
const wellFormed = types=>{
    if (types.length > 1
        && (types[types.length - 1] & PathPointTypePathTypeMask) === PathPointTypeStart)
    {
        return false;
    }
    let run = 0;
    for (let i = 1; i <= types.length; i++)
    {
        const bezier = i < types.length
            && (types[i] & PathPointTypePathTypeMask) === PathPointTypeBezier;
        if (bezier)
        {
            run++;
        }
        else
        {
            if (run % 3 !== 0)
            {
                return false;
            }
            run = 0;
        }
    }
    return true;
};

/** DashStyle's patterns, in pen widths (gdiplusenums.h's DashStyle). */
export const DASHES = [[], [3, 1], [1, 1], [3, 1, 1, 1], [3, 1, 1, 1, 1, 1]];
const DashStyleCustom = 5;

/**
 * A polyline cut into its dashes: the pattern, in pen widths, laid along it
 * from its start.
 *
 * @param {[number, number][]} line @param {number[]} pattern @param {number} width
 * @returns {[number, number][][]}
 */
export const dashed = (line, pattern, width)=>{
    const lengths = pattern.map(value=>value * width);
    if (lengths.length === 0 || lengths.every(value=>!(value > 0)))
    {
        return [line];
    }
    /** @type {[number, number][][]} */
    const out = [];
    let index = 0;
    let left = lengths[0];
    let on = true;
    /** @type {[number, number][]} */
    let current = [line[0]];
    for (let i = 1; i < line.length; i++)
    {
        let [ax, ay] = line[i - 1];
        const [bx, by] = line[i];
        let span = Math.hypot(bx - ax, by - ay);
        while (span > left)
        {
            const t = left / span;
            /** @type {[number, number]} */
            const cut = [ax + (bx - ax) * t, ay + (by - ay) * t];
            if (on)
            {
                current.push(cut);
                out.push(current);
            }
            current = [cut];
            span -= left;
            [ax, ay] = cut;
            on = !on;
            index = (index + 1) % lengths.length;
            left = lengths[index];
        }
        left -= span;
        current.push([bx, by]);
    }
    if (on && current.length > 1)
    {
        out.push(current);
    }
    return out;
};

/**
 * One side of a polyline, `half` to its left, its corners mitred.
 *
 * @param {[number, number][]} line @param {number} half @param {boolean} closed
 * @returns {[number, number][]}
 */
const offsetSide = (line, half, closed)=>{
    const n = line.length;
    /** @param {number} i @returns {[number, number]} the unit normal of segment i */
    const normal = i=>{
        const [ax, ay] = line[i];
        const [bx, by] = line[(i + 1) % n];
        const length = Math.hypot(bx - ax, by - ay) || 1;
        return [(by - ay) / length, -(bx - ax) / length];
    };
    /** @type {[number, number][]} */
    const out = [];
    for (let i = 0; i < n; i++)
    {
        const before = i > 0 ? normal(i - 1) : closed ? normal(n - 1) : null;
        const after = i < n - 1 || closed ? normal(i) : null;
        const [px, py] = line[i];
        if (before && after)
        {
            const mx = before[0] + after[0];
            const my = before[1] + after[1];
            const scale = 1 + before[0] * after[0] + before[1] * after[1];
            out.push(scale > 1e-6 ? [px + mx * half / scale, py + my * half / scale]
                : [px + after[0] * half, py + after[1] * half]);
        }
        else
        {
            const [nx, ny] = /** @type {[number, number]} */ (before ?? after);
            out.push([px + nx * half, py + ny * half]);
        }
    }
    return out;
};

/**
 * The outline a pen of `width` strokes a path with: each open figure, or
 * each of its dashes, one closed figure along its left side and back along
 * its right; each closed figure two, its outer side and its inner. Joins
 * are mitred and ends flat.
 *
 * @param {Path} path @param {number} width @param {number} dashStyle
 * @param {number[]} dashes @param {number} flatness
 * @returns {Path}
 */
const widen = (path, width, dashStyle, dashes, flatness)=>{
    const half = width / 2;
    const out = emptyPath(FillModeWinding);
    const flat = flatten(path, flatness);
    /** @type {{ line: [number, number][], closed: boolean }[]} */
    const lines = [];
    flat.types.forEach((type, at)=>{
        if ((type & PathPointTypePathTypeMask) === PathPointTypeStart || lines.length === 0)
        {
            lines.push({ line: [], closed: false });
        }
        const figure = lines[lines.length - 1];
        figure.line.push(flat.points[at]);
        figure.closed = (type & PathPointTypeCloseSubpath) !== 0;
    });
    const pattern = dashStyle === DashStyleCustom ? dashes : DASHES[dashStyle] ?? [];
    /** @param {[number, number][]} polygon */
    const addFigure = polygon=>{
        out.open = false;
        addLines(out, polygon);
        closeFigure(out);
    };
    for (const { line, closed } of lines)
    {
        if (line.length < 2)
        {
            continue;
        }
        if (closed && pattern.length === 0)
        {
            addFigure(offsetSide(line, half, true));
            addFigure(offsetSide([...line].reverse(), half, true));
            continue;
        }
        for (const piece of dashed(closed ? [...line, line[0]] : line, pattern, width))
        {
            addFigure([...offsetSide(piece, half, false),
                ...offsetSide([...piece].reverse(), half, false)]);
        }
    }
    return out;
};

/**
 * A point through a warp of the source rectangle onto three points (a
 * parallelogram) or four: perspective, or bilinear between the corners.
 *
 * @param {[number, number][]} corners @param {number[]} source @param {boolean} bilinear
 * @returns {(point: [number, number]) => [number, number]}
 */
const warp = (corners, [sx, sy, sw, sh], bilinear)=>{
    const [p0, p1, p2] = corners;
    const p3 = corners[3] ?? [p1[0] + p2[0] - p0[0], p1[1] + p2[1] - p0[1]];
    if (bilinear || corners.length < 4)
    {
        return ([x, y])=>{
            const u = (x - sx) / sw;
            const v = (y - sy) / sh;
            return [(1 - u) * (1 - v) * p0[0] + u * (1 - v) * p1[0] + (1 - u) * v * p2[0]
                + u * v * p3[0], (1 - u) * (1 - v) * p0[1] + u * (1 - v) * p1[1]
                + (1 - u) * v * p2[1] + u * v * p3[1]];
        };
    }
    // The projective map of the unit square onto the quadrilateral.
    const dx1 = p1[0] - p3[0];
    const dx2 = p2[0] - p3[0];
    const dy1 = p1[1] - p3[1];
    const dy2 = p2[1] - p3[1];
    const sumX = p0[0] - p1[0] + p3[0] - p2[0];
    const sumY = p0[1] - p1[1] + p3[1] - p2[1];
    const den = dx1 * dy2 - dx2 * dy1;
    const g = den === 0 ? 0 : (sumX * dy2 - dx2 * sumY) / den;
    const h = den === 0 ? 0 : (dx1 * sumY - sumX * dy1) / den;
    const a = p1[0] - p0[0] + g * p1[0];
    const b = p2[0] - p0[0] + h * p2[0];
    const d = p1[1] - p0[1] + g * p1[1];
    const e = p2[1] - p0[1] + h * p2[1];
    return ([x, y])=>{
        const u = (x - sx) / sw;
        const v = (y - sy) / sh;
        const w = g * u + h * v + 1;
        return [(a * u + b * v + p0[0]) / w, (d * u + e * v + p0[1]) / w];
    };
};

/**
 * @param {import('./kit.js').Kit} kit
 * @param {{ elements: (at: number) => (import('./matrix.js').Elements | undefined) }} matrices
 */
export function createPathFunctions(kit, matrices){
    const { InvalidParameter, Ok, OutOfMemory, InsufficientBuffer } = Status;
    /** @param {number} at @returns {Path | undefined} */
    const get = at=>kit.get(at, 'path');
    /**
     * A path argument and the rest of a call, InvalidParameter for none.
     *
     * @param {(path: Path, args: number[]) => number} body
     * @returns {(args: number[]) => number}
     */
    const onPath = body=>([at, ...rest])=>{
        const path = get(at);
        return path ? body(path, rest) : InvalidParameter;
    };
    /** REALs of an argument list. @param {number[]} args */
    const reals = args=>args.map(kit.real);
    /** INTs. @param {number[]} args */
    const ints = args=>args.map(value=>value | 0);

    /** @param {Path} path @param {number[]} box @param {number} start @param {number} sweep */
    const arc = (path, [x, y, width, height], start, sweep)=>{
        if (width <= 0 || height <= 0)
        {
            return InvalidParameter;
        }
        if (sweep === 0)
        {
            return Ok;
        }
        addBeziers(path, arcBeziers(x, y, width, height, start, sweep));
        if (Math.abs(sweep) >= 360)
        {
            closeFigure(path);
        }
        return Ok;
    };
    /** @param {Path} path @param {number[]} box */
    const ellipse = (path, [x, y, width, height])=>{
        path.open = false;
        addBeziers(path, arcBeziers(x, y, width, height, 0, 360));
        closeFigure(path);
        return Ok;
    };
    /** @param {Path} path @param {number[]} box */
    const rectangle = (path, [x, y, width, height])=>{
        if (width <= 0 || height <= 0)
        {
            return Ok;
        }
        path.open = false;
        addLines(path, [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]);
        closeFigure(path);
        return Ok;
    };
    /** @param {Path} path @param {[number, number][]} points */
    const polygon = (path, points)=>{
        if (points.length < 3)
        {
            return InvalidParameter;
        }
        path.open = false;
        addLines(path, points);
        closeFigure(path);
        return Ok;
    };
    /** @param {Path} path @param {number[]} box @param {number} start @param {number} sweep */
    const pie = (path, [x, y, width, height], start, sweep)=>{
        // The centre is laid down before the ellipse is looked at.
        path.open = false;
        begin(path, [x + width / 2, y + height / 2]);
        if (width <= 0 || height <= 0)
        {
            closeFigure(path);
            return InvalidParameter;
        }
        const curve = arcBeziers(x, y, width, height, start, sweep);
        push(path, curve[0], PathPointTypeLine);
        for (const point of curve.slice(1))
        {
            push(path, point, PathPointTypeBezier);
        }
        closeFigure(path);
        return Ok;
    };
    /**
     * @param {Path} path @param {[number, number][]} points @param {number} tension
     * @param {number} [first] @param {number} [segments]
     */
    const curve = (path, points, tension, first, segments)=>{
        if (points.length < 2)
        {
            return InvalidParameter;
        }
        addBeziers(path, splineBeziers(points, tension, false, first, segments));
        return Ok;
    };
    /** @param {Path} path @param {[number, number][]} points @param {number} tension */
    const closedCurve = (path, points, tension)=>{
        if (points.length < 3)
        {
            return InvalidParameter;
        }
        path.open = false;
        addBeziers(path, splineBeziers(points, tension, true));
        closeFigure(path);
        return Ok;
    };
    /**
     * Points of a call: `count` REALs or INTs at `address`, null when there
     * are none or too few.
     *
     * @param {number} address @param {number} count @param {boolean} integers @param {number} least
     */
    const pointsOf = (address, count, integers, least)=>((address >>> 0) === 0
        || (count | 0) < least ? null : kit.points(address, count | 0, integers));
    /**
     * @param {number} address @param {number} count @param {boolean} integers
     * @returns {number[][] | null}
     */
    const rectsOf = (address, count, integers)=>{
        if ((address >>> 0) === 0 || (count | 0) <= 0)
        {
            return null;
        }
        const values = integers ? kit.i32s(address, count * 4) : kit.f32s(address, count * 4);
        return Array.from({ length: count | 0 }, (_, at)=>values.slice(at * 4, at * 4 + 4));
    };

    /**
     * A path from points and types, as GdipCreatePath2 makes one: the first
     * point always a start, one malformed the empty path.
     *
     * @param {number} address @param {number} typesAt @param {number} count
     * @param {number} fill @param {number} out @param {boolean} integers
     */
    const createFrom = (address, typesAt, count, fill, out, integers)=>{
        if ((address >>> 0) === 0 || (typesAt >>> 0) === 0 || (out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        if ((count | 0) <= 0)
        {
            kit.putPointer(out, 0);
            return OutOfMemory;
        }
        const types = [...kit.read(typesAt, count | 0)];
        types[0] = types[0] & ~PathPointTypePathTypeMask | PathPointTypeStart;
        const path = emptyPath(fill);
        if (wellFormed(types))
        {
            path.points = kit.points(address, count | 0, integers);
            path.types = types;
            path.open = (types[types.length - 1] & PathPointTypeCloseSubpath) === 0;
        }
        kit.add('path', path, out);
        return Ok;
    };

    /**
     * @param {Path} path @param {number} address @param {number} count @param {boolean} integers
     */
    const getPoints = (path, address, count, integers)=>{
        if ((address >>> 0) === 0 || (count | 0) <= 0)
        {
            return InvalidParameter;
        }
        if ((count | 0) < path.points.length)
        {
            return InsufficientBuffer;
        }
        kit.putPoints(address, path.points, integers);
        return Ok;
    };

    /**
     * World bounds: through the matrix, widened by half the pen's width.
     *
     * @param {Path} path @param {number} out @param {number} matrix @param {number} pen
     * @param {boolean} integers
     */
    const worldBounds = (path, out, matrix, pen, integers)=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        const m = (matrix >>> 0) === 0 ? null : matrices.elements(matrix);
        if ((matrix >>> 0) !== 0 && !m)
        {
            return InvalidParameter;
        }
        // The points' bounds, control points among them, and through the
        // matrix the bounds of that rectangle's corners - as GDI+ answers.
        const [left, top, w, h] = boundsOf(path.points);
        /** @type {[number, number][]} */
        const corners = [[left, top], [left + w, top], [left, top + h], [left + w, top + h]];
        let [x, y, width, height] = m ? boundsOf(corners.map(point=>apply(m, point)))
            : [left, top, w, h];
        const widened = (pen >>> 0) === 0 ? null : kit.get(pen, 'pen');
        if (widened && path.points.length > 0)
        {
            const half = widened.width / 2;
            x -= half;
            y -= half;
            width += widened.width;
            height += widened.width;
        }
        if (integers)
        {
            kit.putI32s(out, [x, y, width, height].map(value=>Math.floor(value)));
        }
        else
        {
            kit.putF32s(out, [x, y, width, height]);
        }
        return Ok;
    };

    /** @param {Path} path @param {number} x @param {number} y @param {number} out */
    const visible = (path, x, y, out)=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        kit.putBool(out, insidePolygons(figures(path), x, y, path.fill));
        return Ok;
    };

    /**
     * Whether the point is within half the pen's width of the path's outline.
     *
     * @param {Path} path @param {number} x @param {number} y @param {number} pen
     * @param {number} out
     */
    const outlineVisible = (path, x, y, pen, out)=>{
        const held = kit.get(pen, 'pen');
        if (!held || (out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        const reach = Math.max(held.width, 1) / 2;
        let near = false;
        for (const figure of figures(path))
        {
            for (let i = 0; i < figure.length && !near; i++)
            {
                const [ax, ay] = figure[i];
                const [bx, by] = figure[(i + 1) % figure.length];
                const dx = bx - ax;
                const dy = by - ay;
                const length = dx * dx + dy * dy;
                const t = length === 0 ? 0
                    : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
                near = Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= reach;
            }
        }
        kit.putBool(out, near);
        return Ok;
    };

    const functions = {
        /** Status GdipCreatePath(GpFillMode fill, GpPath **path) */
        GdipCreatePath: fn(8, ([fill, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.add('path', emptyPath(fill >>> 0), out);
            return Ok;
        }),
        /** Status GdipCreatePath2(const GpPointF*, const BYTE*, INT, IN GpFillMode, GpPath**) */
        GdipCreatePath2: fn(20, ([points, types, count, fill, out])=>
            createFrom(points, types, count, fill >>> 0, out, false)),
        /** Status GdipCreatePath2I(const GpPoint*, const BYTE*, INT, IN GpFillMode, GpPath**) */
        GdipCreatePath2I: fn(20, ([points, types, count, fill, out])=>
            createFrom(points, types, count, fill >>> 0, out, true)),
        /** Status GdipClonePath(GpPath *path, GpPath **clone) */
        GdipClonePath: fn(8, ([at, out])=>{
            const path = get(at);
            if (!path || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.add('path', clonePath(path), out);
            return Ok;
        }),
        /** Status GdipDeletePath(GpPath *path) */
        GdipDeletePath: fn(4, ([at])=>(kit.remove(at, 'path') ? Ok : InvalidParameter)),
        /** Status GdipResetPath(GpPath *path): no points, alternate fill. */
        GdipResetPath: fn(4, onPath(path=>{
            Object.assign(path, emptyPath(FillModeAlternate));
            return Ok;
        })),
        /** Status GdipGetPointCount(GpPath *path, INT *count) */
        GdipGetPointCount: fn(8, onPath((path, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, path.points.length);
            return Ok;
        })),
        /** Status GdipGetPathTypes(GpPath *path, BYTE *types, INT count) */
        GdipGetPathTypes: fn(12, onPath((path, [out, count])=>{
            if ((out >>> 0) === 0 || (count | 0) <= 0)
            {
                return InvalidParameter;
            }
            if ((count | 0) < path.types.length)
            {
                return InsufficientBuffer;
            }
            kit.write(out, Uint8Array.from(path.types));
            return Ok;
        })),
        /** Status GdipGetPathPoints(GpPath *path, GpPointF *points, INT count) */
        GdipGetPathPoints: fn(12, onPath((path, [out, count])=>getPoints(path, out, count, false))),
        /** Status GdipGetPathPointsI(GpPath *path, GpPoint *points, INT count) */
        GdipGetPathPointsI: fn(12, onPath((path, [out, count])=>getPoints(path, out, count, true))),
        /**
         * Status GdipGetPathData(GpPath *path, GpPathData *data)
         *
         * PathData: Count, then the Points and Types the caller gave room in;
         * room for fewer than the path has is OutOfMemory, as GDI+ answers it.
         */
        GdipGetPathData: fn(8, onPath((path, [data])=>{
            if ((data >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const size = kit.pointer.size;
            const record = kit.view(data, size * 3);
            const room = record.getInt32(0, true);
            const points = kit.pointer.get(record, size);
            const types = kit.pointer.get(record, size * 2);
            if (points === 0 || types === 0)
            {
                return InvalidParameter;
            }
            if (room < path.points.length)
            {
                return OutOfMemory;
            }
            kit.putPoints(points, path.points);
            kit.write(types, Uint8Array.from(path.types));
            kit.putI32(data, path.points.length);
            return Ok;
        })),
        /** Status GdipGetPathFillMode(GpPath *path, GpFillMode *fill) */
        GdipGetPathFillMode: fn(8, onPath((path, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, path.fill);
            return Ok;
        })),
        /** Status GdipSetPathFillMode(GpPath *path, GpFillMode fill) */
        GdipSetPathFillMode: fn(8, onPath((path, [fill])=>{
            if ((fill >>> 0) > FillModeWinding)
            {
                return InvalidParameter;
            }
            path.fill = fill >>> 0;
            return Ok;
        })),
        /** Status GdipGetPathLastPoint(GpPath *path, GpPointF *point) */
        GdipGetPathLastPoint: fn(8, onPath((path, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const last = path.points[path.points.length - 1];
            if (last)
            {
                kit.putF32s(out, last);
            }
            return Ok;
        })),
        /** Status GdipStartPathFigure(GpPath *path) */
        GdipStartPathFigure: fn(4, onPath(path=>{
            path.open = false;
            return Ok;
        })),
        /** Status GdipClosePathFigure(GpPath *path) */
        GdipClosePathFigure: fn(4, onPath(path=>{
            closeFigure(path);
            return Ok;
        })),
        /** Status GdipClosePathFigures(GpPath *path): every figure closed. */
        GdipClosePathFigures: fn(4, onPath(path=>{
            path.types.forEach((type, at)=>{
                const next = path.types[at + 1];
                if (next === undefined
                    || (next & PathPointTypePathTypeMask) === PathPointTypeStart)
                {
                    path.types[at] = type | PathPointTypeCloseSubpath;
                }
            });
            path.open = false;
            return Ok;
        })),
        /** Status GdipSetPathMarker(GpPath *path): the last point marks a section's end. */
        GdipSetPathMarker: fn(4, onPath(path=>{
            if (path.types.length > 0)
            {
                path.types[path.types.length - 1] |= PathPointTypePathMarker;
            }
            return Ok;
        })),
        /** Status GdipClearPathMarkers(GpPath *path) */
        GdipClearPathMarkers: fn(4, onPath(path=>{
            path.types = path.types.map(type=>type & ~PathPointTypePathMarker);
            return Ok;
        })),
        /**
         * Status GdipReversePath(GpPath *path)
         *
         * Each figure's points in the other order, its start the old end,
         * each segment's type moved with it and the closing flag kept on the
         * figure's last point.
         */
        GdipReversePath: fn(4, onPath(path=>{
            const { points, types } = path;
            /** @type {[number, number][]} each figure's first and last point */
            const spans = [];
            types.forEach((type, at)=>{
                if ((type & PathPointTypePathTypeMask) === PathPointTypeStart || at === 0)
                {
                    spans.push([at, at]);
                }
                spans[spans.length - 1][1] = at;
            });
            /** @type {[number, number][]} */
            const outPoints = [];
            /** @type {number[]} */
            const outTypes = [];
            for (const [first, last] of spans.reverse())
            {
                for (let i = last; i >= first; i--)
                {
                    outPoints.push(points[i]);
                    // A point takes the type of the segment that now leads to
                    // it: the one that led away from it before.
                    outTypes.push((i === last ? PathPointTypeStart
                        : types[i + 1] & PathPointTypePathTypeMask)
                        | (types[i] & PathPointTypePathMarker));
                }
                if ((types[last] & PathPointTypeCloseSubpath) !== 0)
                {
                    outTypes[outTypes.length - 1] |= PathPointTypeCloseSubpath;
                }
            }
            path.points = outPoints;
            path.types = outTypes;
            return Ok;
        })),
        /** Status GdipTransformPath(GpPath *path, GpMatrix *matrix): none leaves it as it is. */
        GdipTransformPath: fn(8, onPath((path, [matrix])=>{
            if ((matrix >>> 0) === 0)
            {
                return Ok;
            }
            const m = matrices.elements(matrix);
            if (!m)
            {
                return InvalidParameter;
            }
            path.points = path.points.map(point=>apply(m, point));
            return Ok;
        })),
        /** Status GdipFlattenPath(GpPath *path, GpMatrix *matrix, REAL flatness) */
        GdipFlattenPath: fn(12, onPath((path, [matrix, flatness])=>{
            const m = (matrix >>> 0) === 0 ? null : matrices.elements(matrix);
            if ((matrix >>> 0) !== 0 && !m)
            {
                return InvalidParameter;
            }
            const flat = flatten(path, kit.real(flatness));
            path.points = m ? flat.points.map(point=>apply(m, point)) : flat.points;
            path.types = flat.types;
            return Ok;
        }), { floats: { 2: 'f32' } }),
        /**
         * Status GdipWarpPath(GpPath *path, GpMatrix *matrix, const GpPointF *points, INT count,
         *   REAL srcx, REAL srcy, REAL srcwidth, REAL srcheight, WarpMode mode, REAL flatness)
         *
         * The path flattened, every point carried from the source rectangle
         * onto the points, then through the matrix. Fewer than three are read
         * as three, as GDI+ reads them; four warp in perspective or bilinearly.
         */
        GdipWarpPath: fn(40, onPath((path, [matrix, points, count, ...rest])=>{
            if ((points >>> 0) === 0 || (count | 0) <= 0)
            {
                return InvalidParameter;
            }
            const m = (matrix >>> 0) === 0 ? null : matrices.elements(matrix);
            if ((matrix >>> 0) !== 0 && !m)
            {
                return InvalidParameter;
            }
            if (path.points.length === 0)
            {
                return Ok;
            }
            const corners = kit.points(points, (count | 0) >= 4 ? 4 : 3);
            const flat = flatten(path, kit.real(rest[5]));
            const to = warp(corners, rest.slice(0, 4).map(kit.real), (rest[4] >>> 0) === 1);
            path.points = flat.points.map(point=>{
                const [x, y] = to(point);
                return m ? apply(m, [x, y]) : [f(x), f(y)];
            });
            path.types = flat.types;
            return Ok;
        })),
        /**
         * Status GdipWidenPath(GpPath *path, GpPen *pen, GpMatrix *matrix, REAL flatness)
         *
         * The path through the matrix, then the outline the pen strokes it
         * with in its place.
         */
        GdipWidenPath: fn(16, onPath((path, [pen, matrix, flatness])=>{
            const held = kit.get(pen, 'pen');
            if (!held)
            {
                return InvalidParameter;
            }
            if (path.points.length === 0)
            {
                return OutOfMemory;
            }
            const m = (matrix >>> 0) === 0 ? null : matrices.elements(matrix);
            const moved = clonePath(path);
            if (m)
            {
                moved.points = moved.points.map(point=>apply(m, point));
            }
            Object.assign(path, widen(moved, Math.max(held.width, 1), held.dashStyle, held.dashes,
                Math.max(kit.real(flatness), 0.05)));
            return Ok;
        }), { floats: { 3: 'f32' } }),
        /** Status GdipGetPathWorldBounds(GpPath*, GpRectF*, const GpMatrix*, const GpPen*) */
        GdipGetPathWorldBounds: fn(16, onPath((path, [out, matrix, pen])=>
            worldBounds(path, out, matrix, pen, false))),
        /** Status GdipGetPathWorldBoundsI(GpPath*, GpRect*, const GpMatrix*, const GpPen*) */
        GdipGetPathWorldBoundsI: fn(16, onPath((path, [out, matrix, pen])=>
            worldBounds(path, out, matrix, pen, true))),
        /** Status GdipIsVisiblePathPoint(GpPath*, REAL x, REAL y, GpGraphics*, BOOL*) */
        GdipIsVisiblePathPoint: fn(20, onPath((path, [x, y, , out])=>
            visible(path, kit.real(x), kit.real(y), out)), { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipIsVisiblePathPointI(GpPath*, INT x, INT y, GpGraphics*, BOOL*) */
        GdipIsVisiblePathPointI: fn(20, onPath((path, [x, y, , out])=>
            visible(path, x | 0, y | 0, out))),
        /**
         * Status GdipIsOutlineVisiblePathPoint(GpPath*, REAL x, REAL y, GpPen*, GpGraphics*, BOOL*)
         */
        GdipIsOutlineVisiblePathPoint: fn(24, onPath((path, [x, y, pen, , out])=>
            outlineVisible(path, kit.real(x), kit.real(y), pen, out)),
        { floats: { 1: 'f32', 2: 'f32' } }),
        /**
         * Status GdipIsOutlineVisiblePathPointI(GpPath*, INT x, INT y, GpPen*, GpGraphics*, BOOL*)
         */
        GdipIsOutlineVisiblePathPointI: fn(24, onPath((path, [x, y, pen, , out])=>
            outlineVisible(path, x | 0, y | 0, pen, out))),

        /** Status GdipAddPathLine(GpPath *path, REAL x1, REAL y1, REAL x2, REAL y2) */
        GdipAddPathLine: fn(20, onPath((path, args)=>{
            const [x1, y1, x2, y2] = reals(args);
            addLines(path, [[x1, y1], [x2, y2]]);
            return Ok;
        }), { floats: { 1: 'f32', 2: 'f32', 3: 'f32' } }),
        /** Status GdipAddPathLineI(GpPath *path, INT x1, INT y1, INT x2, INT y2) */
        GdipAddPathLineI: fn(20, onPath((path, args)=>{
            const [x1, y1, x2, y2] = ints(args);
            addLines(path, [[x1, y1], [x2, y2]]);
            return Ok;
        })),
        /** Status GdipAddPathLine2(GpPath *path, const GpPointF *points, INT count) */
        GdipAddPathLine2: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, false, 1);
            if (!points)
            {
                return InvalidParameter;
            }
            addLines(path, points);
            return Ok;
        })),
        /** Status GdipAddPathLine2I(GpPath *path, const GpPoint *points, INT count) */
        GdipAddPathLine2I: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, true, 1);
            if (!points)
            {
                return InvalidParameter;
            }
            addLines(path, points);
            return Ok;
        })),
        /**
         * Status GdipAddPathBezier(GpPath *path, REAL x1, REAL y1, REAL x2, REAL y2, REAL x3,
         *     REAL y3, REAL x4, REAL y4)
         */
        GdipAddPathBezier: fn(36, onPath((path, args)=>{
            const v = reals(args);
            addBeziers(path, [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]], [v[6], v[7]]]);
            return Ok;
        }),
        { floats: { 1: 'f32', 2: 'f32', 3: 'f32', 4: 'f32', 5: 'f32', 6: 'f32', 7: 'f32',
            8: 'f32' } }),
        /** Status GdipAddPathBezierI(GpPath *path, INT x1 ... y4) */
        GdipAddPathBezierI: fn(36, onPath((path, args)=>{
            const v = ints(args);
            addBeziers(path, [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]], [v[6], v[7]]]);
            return Ok;
        })),
        /** Status GdipAddPathBeziers(GpPath *path, const GpPointF *points, INT count) */
        GdipAddPathBeziers: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, false, 4);
            if (!points || (points.length - 1) % 3 !== 0)
            {
                return InvalidParameter;
            }
            addBeziers(path, points);
            return Ok;
        })),
        /** Status GdipAddPathBeziersI(GpPath *path, const GpPoint *points, INT count) */
        GdipAddPathBeziersI: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, true, 4);
            if (!points || (points.length - 1) % 3 !== 0)
            {
                return InvalidParameter;
            }
            addBeziers(path, points);
            return Ok;
        })),
        /**
         * Status GdipAddPathArc(GpPath*, REAL x, REAL y, REAL width, REAL height, REAL startAngle,
         *     REAL sweepAngle)
         */
        GdipAddPathArc: fn(28, onPath((path, args)=>{
            const v = reals(args);
            return arc(path, v.slice(0, 4), v[4], v[5]);
        }), { floats: { 1: 'f32', 2: 'f32', 3: 'f32', 4: 'f32', 5: 'f32', 6: 'f32' } }),
        /**
         * Status GdipAddPathArcI(GpPath*, INT x, INT y, INT width, INT height, REAL start,
         *     REAL sweep)
         */
        GdipAddPathArcI: fn(28, onPath((path, args)=>
            arc(path, ints(args.slice(0, 4)), kit.real(args[4]), kit.real(args[5])))),
        /** Status GdipAddPathEllipse(GpPath*, REAL x, REAL y, REAL width, REAL height) */
        GdipAddPathEllipse: fn(20, onPath((path, args)=>ellipse(path, reals(args))),
            { floats: { 1: 'f32', 2: 'f32', 3: 'f32', 4: 'f32' } }),
        /** Status GdipAddPathEllipseI(GpPath*, INT x, INT y, INT width, INT height) */
        GdipAddPathEllipseI: fn(20, onPath((path, args)=>ellipse(path, ints(args)))),
        /** Status GdipAddPathRectangle(GpPath*, REAL x, REAL y, REAL width, REAL height) */
        GdipAddPathRectangle: fn(20, onPath((path, args)=>rectangle(path, reals(args))),
            { floats: { 1: 'f32', 2: 'f32', 3: 'f32', 4: 'f32' } }),
        /** Status GdipAddPathRectangleI(GpPath*, INT x, INT y, INT width, INT height) */
        GdipAddPathRectangleI: fn(20, onPath((path, args)=>rectangle(path, ints(args)))),
        /** Status GdipAddPathRectangles(GpPath*, const GpRectF *rects, INT count) */
        GdipAddPathRectangles: fn(12, onPath((path, [at, count])=>{
            const rects = rectsOf(at, count, false);
            if (!rects)
            {
                return InvalidParameter;
            }
            rects.forEach(rect=>rectangle(path, rect));
            return Ok;
        })),
        /** Status GdipAddPathRectanglesI(GpPath*, const GpRect *rects, INT count) */
        GdipAddPathRectanglesI: fn(12, onPath((path, [at, count])=>{
            const rects = rectsOf(at, count, true);
            if (!rects)
            {
                return InvalidParameter;
            }
            rects.forEach(rect=>rectangle(path, rect));
            return Ok;
        })),
        /** Status GdipAddPathPolygon(GpPath*, const GpPointF *points, INT count) */
        GdipAddPathPolygon: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, false, 3);
            return points ? polygon(path, points) : InvalidParameter;
        })),
        /** Status GdipAddPathPolygonI(GpPath*, const GpPoint *points, INT count) */
        GdipAddPathPolygonI: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, true, 3);
            return points ? polygon(path, points) : InvalidParameter;
        })),
        /**
         * Status GdipAddPathPie(GpPath*, REAL x, REAL y, REAL width, REAL height, REAL startAngle,
         *     REAL sweepAngle)
         */
        GdipAddPathPie: fn(28, onPath((path, args)=>{
            const v = reals(args);
            return pie(path, v.slice(0, 4), v[4], v[5]);
        }), { floats: { 1: 'f32', 2: 'f32', 3: 'f32', 4: 'f32', 5: 'f32', 6: 'f32' } }),
        /**
         * Status GdipAddPathPieI(GpPath*, INT x, INT y, INT width, INT height, REAL start,
         *     REAL sweep)
         */
        GdipAddPathPieI: fn(28, onPath((path, args)=>
            pie(path, ints(args.slice(0, 4)), kit.real(args[4]), kit.real(args[5])))),
        /** Status GdipAddPathCurve(GpPath*, const GpPointF *points, INT count): tension 0.5. */
        GdipAddPathCurve: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, false, 2);
            return points ? curve(path, points, 0.5) : InvalidParameter;
        })),
        /** Status GdipAddPathCurveI(GpPath*, const GpPoint *points, INT count) */
        GdipAddPathCurveI: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, true, 2);
            return points ? curve(path, points, 0.5) : InvalidParameter;
        })),
        /** Status GdipAddPathCurve2(GpPath*, const GpPointF *points, INT count, REAL tension) */
        GdipAddPathCurve2: fn(16, onPath((path, [at, count, tension])=>{
            const points = pointsOf(at, count, false, 2);
            return points ? curve(path, points, kit.real(tension)) : InvalidParameter;
        }), { floats: { 3: 'f32' } }),
        /** Status GdipAddPathCurve2I(GpPath*, const GpPoint *points, INT count, REAL tension) */
        GdipAddPathCurve2I: fn(16, onPath((path, [at, count, tension])=>{
            const points = pointsOf(at, count, true, 2);
            return points ? curve(path, points, kit.real(tension)) : InvalidParameter;
        }), { floats: { 3: 'f32' } }),
        /**
         * Status GdipAddPathCurve3(GpPath*, const GpPointF *points, INT count, INT offset,
         *   INT numberOfSegments, REAL tension)
         *
         * Segments from `offset` on, each point's tangent from all the points.
         */
        GdipAddPathCurve3: fn(24, onPath((path, [at, count, offset, segments, tension])=>{
            const points = pointsOf(at, count, false, 2);
            if (!points || (segments | 0) <= 0 || (offset | 0) < 0
                || (offset | 0) + (segments | 0) > points.length - 1)
            {
                return InvalidParameter;
            }
            return curve(path, points, kit.real(tension), offset | 0, segments | 0);
        })),
        /** Status GdipAddPathCurve3I(GpPath*, const GpPoint*, INT, IN INT, IN INT, IN REAL) */
        GdipAddPathCurve3I: fn(24, onPath((path, [at, count, offset, segments, tension])=>{
            const points = pointsOf(at, count, true, 2);
            if (!points || (segments | 0) <= 0 || (offset | 0) < 0
                || (offset | 0) + (segments | 0) > points.length - 1)
            {
                return InvalidParameter;
            }
            return curve(path, points, kit.real(tension), offset | 0, segments | 0);
        })),
        /** Status GdipAddPathClosedCurve(GpPath*, const GpPointF *points, INT count) */
        GdipAddPathClosedCurve: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, false, 3);
            return points ? closedCurve(path, points, 0.5) : InvalidParameter;
        })),
        /** Status GdipAddPathClosedCurveI(GpPath*, const GpPoint *points, INT count) */
        GdipAddPathClosedCurveI: fn(12, onPath((path, [at, count])=>{
            const points = pointsOf(at, count, true, 3);
            return points ? closedCurve(path, points, 0.5) : InvalidParameter;
        })),
        /** Status GdipAddPathClosedCurve2(GpPath*, const GpPointF*, INT count, REAL tension) */
        GdipAddPathClosedCurve2: fn(16, onPath((path, [at, count, tension])=>{
            const points = pointsOf(at, count, false, 3);
            return points ? closedCurve(path, points, kit.real(tension)) : InvalidParameter;
        }), { floats: { 3: 'f32' } }),
        /** Status GdipAddPathClosedCurve2I(GpPath*, const GpPoint*, INT count, REAL tension) */
        GdipAddPathClosedCurve2I: fn(16, onPath((path, [at, count, tension])=>{
            const points = pointsOf(at, count, true, 3);
            return points ? closedCurve(path, points, kit.real(tension)) : InvalidParameter;
        }), { floats: { 3: 'f32' } }),
        /**
         * Status GdipAddPathPath(GpPath *path, const GpPath *added, BOOL connect)
         *
         * The other path's figures after this one's; `connect` joins its first
         * figure to the open one with a line.
         */
        GdipAddPathPath: fn(12, onPath((path, [at, connect])=>{
            const added = get(at);
            if (!added)
            {
                return InvalidParameter;
            }
            const copy = clonePath(added);
            copy.types.forEach((type, index)=>{
                const joined = index === 0 && connect !== 0 && path.open
                    ? type & ~PathPointTypePathTypeMask | PathPointTypeLine : type;
                push(path, copy.points[index], joined);
            });
            path.open = copy.open;
            return Ok;
        })),
    };
    return { functions, get };
}
