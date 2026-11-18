/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s rasteriser: polygons into pixel coverage, a pen's outline as
 * polygons, and the colour each kind of brush lays at a point. Every fill,
 * stroke, image and region of GDI+ goes through here, so a shape is one
 * shape however it is drawn or clipped.
 *
 * A pixel is sampled at its centre: at integer coordinates under
 * PixelOffsetModeNone and Default, half a pixel on under Half and
 * HighQuality, as GDI+ places them. Aliased, a pixel is in when its centre
 * is (left and top edges in, right and bottom out); antialiased, its
 * coverage is the share of four rows of it the shape spans, each exactly
 * across.
 */

import { apply, invert } from './matrix.js';
import { FillModeWinding } from './path.js';

/** The rows an antialiased pixel is sampled at. */
const AA_ROWS = 4;

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Box
 * @typedef {[number, number][]} Polygon
 */

/**
 * The edges of polygons, each from lower y to higher, its direction kept.
 *
 * @param {Polygon[]} polygons
 */
const edgesOf = polygons=>{
    /** @type {{ y0: number, y1: number, x0: number, slope: number, dir: number }[]} */
    const edges = [];
    for (const polygon of polygons)
    {
        for (let i = 0; i < polygon.length; i++)
        {
            const [ax, ay] = polygon[i];
            const [bx, by] = polygon[(i + 1) % polygon.length];
            if (ay === by || !Number.isFinite(ay) || !Number.isFinite(by))
            {
                continue;
            }
            const down = ay < by;
            const [x0, y0, x1, y1] = down ? [ax, ay, bx, by] : [bx, by, ax, ay];
            edges.push({ y0, y1, x0, slope: (x1 - x0) / (y1 - y0), dir: down ? 1 : -1 });
        }
    }
    return edges;
};

/**
 * The spans of a row the shape is inside, at height `y`: [from, to) pairs.
 *
 * @param {ReturnType<typeof edgesOf>} edges @param {number} y @param {number} fill
 */
const spansAt = (edges, y, fill)=>{
    /** @type {[number, number][]} */
    const crossings = [];
    for (const e of edges)
    {
        if (y >= e.y0 && y < e.y1)
        {
            crossings.push([e.x0 + (y - e.y0) * e.slope, e.dir]);
        }
    }
    crossings.sort((a, b)=>a[0] - b[0]);
    /** @type {number[]} */
    const out = [];
    let winding = 0;
    for (const [x, dir] of crossings)
    {
        const was = fill === FillModeWinding ? winding !== 0 : (winding & 1) !== 0;
        winding += fill === FillModeWinding ? dir : 1;
        const now = fill === FillModeWinding ? winding !== 0 : (winding & 1) !== 0;
        if (!was && now)
        {
            out.push(x);
        }
        else if (was && !now)
        {
            out.push(x);
        }
    }
    return out;
};

/**
 * The integer box polygons fall in, within `limit`.
 *
 * @param {Polygon[]} polygons @param {Box} limit
 * @returns {Box | null}
 */
export const boxOf = (polygons, limit)=>{
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of polygons)
    {
        for (const [x, y] of polygon)
        {
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
        }
    }
    const box = { left: Math.max(limit.left, Math.floor(left) - 1),
        top: Math.max(limit.top, Math.floor(top) - 1),
        right: Math.min(limit.right, Math.ceil(right) + 2),
        bottom: Math.min(limit.bottom, Math.ceil(bottom) + 2) };
    return box.left < box.right && box.top < box.bottom ? box : null;
};

/**
 * Each row's pixels the shape covers, aliased: rows of [from, to) runs of
 * pixel columns whose centres it holds.
 *
 * @param {Polygon[]} polygons @param {number} fill @param {Box} box @param {number} offset
 * @returns {number[][]}  per row of the box, flat from, to pairs
 */
export function pixelRuns(polygons, fill, box, offset){
    const edges = edgesOf(polygons);
    /** @type {number[][]} */
    const rows = [];
    for (let y = box.top; y < box.bottom; y++)
    {
        const spans = spansAt(edges, y + offset, fill);
        /** @type {number[]} */
        const runs = [];
        for (let i = 0; i + 1 < spans.length; i += 2)
        {
            const from = Math.max(box.left, Math.ceil(spans[i] - offset));
            const to = Math.min(box.right, Math.ceil(spans[i + 1] - offset));
            if (to > from)
            {
                runs.push(from, to);
            }
        }
        rows.push(runs);
    }
    return rows;
}

/**
 * Coverage of each pixel of the box, 0 to 1.
 *
 * @param {Polygon[]} polygons @param {number} fill @param {Box} box
 * @param {boolean} antialias @param {number} offset
 */
export function coverage(polygons, fill, box, antialias, offset){
    const width = box.right - box.left;
    const out = new Float32Array(width * (box.bottom - box.top));
    if (!antialias)
    {
        pixelRuns(polygons, fill, box, offset).forEach((runs, row)=>{
            for (let i = 0; i < runs.length; i += 2)
            {
                out.fill(1, row * width + runs[i] - box.left, row * width + runs[i + 1] - box.left);
            }
        });
        return out;
    }
    const edges = edgesOf(polygons);
    // Pixel x spans [x + offset - 0.5, x + offset + 0.5).
    const shift = offset - 0.5;
    for (let y = box.top; y < box.bottom; y++)
    {
        const row = (y - box.top) * width;
        for (let k = 0; k < AA_ROWS; k++)
        {
            const spans = spansAt(edges, y + shift + (k + 0.5) / AA_ROWS, fill);
            for (let i = 0; i + 1 < spans.length; i += 2)
            {
                const a = Math.max(box.left + shift, spans[i]);
                const b = Math.min(box.right + shift, spans[i + 1]);
                if (b <= a)
                {
                    continue;
                }
                const first = Math.floor(a - shift);
                const last = Math.min(box.right - 1, Math.floor(b - shift));
                for (let x = first; x <= last; x++)
                {
                    const lo = Math.max(a, x + shift);
                    const hi = Math.min(b, x + shift + 1);
                    if (hi > lo)
                    {
                        out[row + x - box.left] += (hi - lo) / AA_ROWS;
                    }
                }
            }
        }
    }
    return out;
}

/** LineCap, LineJoin. */
export const LineCap = Object.freeze({ Flat: 0, Square: 1, Round: 2, Triangle: 3,
    NoAnchor: 0x10, SquareAnchor: 0x11, RoundAnchor: 0x12, DiamondAnchor: 0x13,
    ArrowAnchor: 0x14, Custom: 0xff });
export const LineJoin = Object.freeze({ Miter: 0, Bevel: 1, Round: 2, MiterClipped: 3 });

/** The sides a circle is drawn with. @param {number} radius */
const circleSides = radius=>Math.max(8, Math.min(64, Math.ceil(radius * 2)));

/**
 * A circle about a point, as a polygon.
 *
 * @param {number} cx @param {number} cy @param {number} radius
 * @returns {Polygon}
 */
const circle = (cx, cy, radius)=>{
    const n = circleSides(radius);
    return Array.from({ length: n }, (_, i)=>[cx + radius * Math.cos(2 * Math.PI * i / n),
        cy + radius * Math.sin(2 * Math.PI * i / n)]);
};

/** A polygon wound positively, for a winding fill of their union. @param {Polygon} polygon */
const positive = polygon=>{
    let area = 0;
    for (let i = 0; i < polygon.length; i++)
    {
        const [ax, ay] = polygon[i];
        const [bx, by] = polygon[(i + 1) % polygon.length];
        area += ax * by - bx * ay;
    }
    return area < 0 ? [...polygon].reverse() : polygon;
};

/**
 * @typedef {Object} Stroke
 * @property {number} width
 * @property {number} startCap @property {number} endCap
 * @property {number} join @property {number} miterLimit
 */

/**
 * A cap at an end of a line: at `p`, the line arriving along unit `d`.
 *
 * @param {number} cap @param {[number, number]} p @param {[number, number]} d
 * @param {number} half
 * @returns {Polygon | null}
 */
const capAt = (cap, [px, py], [dx, dy], half)=>{
    const [nx, ny] = [-dy * half, dx * half];
    switch (cap)
    {
        case LineCap.Square:
            return [[px + nx, py + ny], [px + nx + dx * half, py + ny + dy * half],
                [px - nx + dx * half, py - ny + dy * half], [px - nx, py - ny]];
        case LineCap.Round:
            return circle(px, py, half);
        case LineCap.Triangle:
            return [[px + nx, py + ny], [px + dx * half, py + dy * half], [px - nx, py - ny]];
        // An anchor is a shape about the end twice the pen's width across.
        case LineCap.SquareAnchor:
            return [[px - 2 * half, py - 2 * half], [px + 2 * half, py - 2 * half],
                [px + 2 * half, py + 2 * half], [px - 2 * half, py + 2 * half]];
        case LineCap.RoundAnchor:
            return circle(px, py, 2 * half);
        case LineCap.DiamondAnchor:
            return [[px + dx * 2 * half, py + dy * 2 * half], [px + nx * 2, py + ny * 2],
                [px - dx * 2 * half, py - dy * 2 * half], [px - nx * 2, py - ny * 2]];
        case LineCap.ArrowAnchor:
            return [[px + dx * 2 * half, py + dy * 2 * half],
                [px - dx * 2 * half + nx * 2, py - dy * 2 * half + ny * 2],
                [px - dx * 2 * half - nx * 2, py - dy * 2 * half - ny * 2]];
        default:
            return null;
    }
};

/**
 * The polygons a pen covers along polylines, for a winding fill: each
 * segment a quadrilateral, each corner its join, each open end its cap.
 *
 * @param {{ line: Polygon, closed: boolean }[]} lines @param {Stroke} pen
 * @returns {Polygon[]}
 */
export function strokePolygons(lines, pen){
    const half = pen.width / 2;
    /** @type {Polygon[]} */
    const out = [];
    for (const { line: raw, closed } of lines)
    {
        const line = raw.filter((p, i)=>i === 0 || p[0] !== raw[i - 1][0]
            || p[1] !== raw[i - 1][1]);
        if (closed && line.length > 1 && line[0][0] === line[line.length - 1][0]
            && line[0][1] === line[line.length - 1][1])
        {
            line.pop();
        }
        if (line.length < 2)
        {
            if (line.length === 1 && (pen.startCap === LineCap.Round
                || pen.endCap === LineCap.Round))
            {
                out.push(circle(line[0][0], line[0][1], half));
            }
            continue;
        }
        const n = line.length;
        const segments = closed ? n : n - 1;
        /** @type {[number, number][]} */
        const dirs = [];
        for (let i = 0; i < segments; i++)
        {
            const [ax, ay] = line[i];
            const [bx, by] = line[(i + 1) % n];
            const length = Math.hypot(bx - ax, by - ay);
            const d = /** @type {[number, number]} */ ([(bx - ax) / length, (by - ay) / length]);
            dirs.push(d);
            const [nx, ny] = [-d[1] * half, d[0] * half];
            out.push(positive([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny],
                [ax - nx, ay - ny]]));
        }
        const corners = closed ? n : n - 2;
        for (let c = 0; c < corners; c++)
        {
            const at = closed ? c : c + 1;
            const before = dirs[(at - 1 + segments) % segments];
            const after = dirs[at % segments];
            const [px, py] = line[at];
            if (pen.join === LineJoin.Round)
            {
                out.push(circle(px, py, half));
                continue;
            }
            const cross = before[0] * after[1] - before[1] * after[0];
            if (Math.abs(cross) < 1e-9)
            {
                continue;
            }
            // The outer side of the turn.
            const side = cross > 0 ? -1 : 1;
            /** @type {[number, number]} */
            const a = [px - before[1] * half * side, py + before[0] * half * side];
            /** @type {[number, number]} */
            const b = [px - after[1] * half * side, py + after[0] * half * side];
            const bevel = /** @type {Polygon} */ ([[px, py], a, b]);
            if (pen.join === LineJoin.Bevel)
            {
                out.push(positive(bevel));
                continue;
            }
            const cosHalf = Math.sqrt(Math.max(0, (1 + before[0] * after[0]
                + before[1] * after[1]) / 2));
            const miter = cosHalf > 1e-9 ? 1 / cosHalf : Infinity;
            if (miter <= Math.max(1, pen.miterLimit))
            {
                // The tip lies along the bisector of the two outer corners.
                const outward = [(a[0] + b[0]) / 2 - px, (a[1] + b[1]) / 2 - py];
                const length = Math.hypot(outward[0], outward[1]) || 1;
                const reach = half * miter;
                out.push(positive([[px, py], a, [px + outward[0] / length * reach,
                    py + outward[1] / length * reach], b]));
            }
            else
            {
                out.push(positive(bevel));
            }
        }
        if (!closed)
        {
            const start = capAt(pen.startCap, line[0], [-dirs[0][0], -dirs[0][1]], half);
            const end = capAt(pen.endCap, line[n - 1], dirs[segments - 1], half);
            for (const cap of [start, end])
            {
                if (cap)
                {
                    out.push(positive(cap));
                }
            }
        }
    }
    return out;
}

/** WrapMode. */
const WrapModeTile = 0;
const WrapModeTileFlipX = 1;
const WrapModeTileFlipY = 2;
const WrapModeTileFlipXY = 3;
const WrapModeClamp = 4;

/**
 * A coordinate wrapped into [0, size) as WrapMode lays copies, or NaN
 * where a clamped one falls outside.
 *
 * @param {number} value @param {number} size @param {boolean} flip @param {boolean} clamp
 */
const wrapped = (value, size, flip, clamp)=>{
    if (clamp)
    {
        return value >= 0 && value < size ? value : NaN;
    }
    const tile = Math.floor(value / size);
    const within = value - tile * size;
    return flip && (tile & 1) !== 0 ? size - within : within;
};

/** An ARGB colour as [b, g, r, a] numbers. @param {number} argb */
export const bgraOf = argb=>[argb & 0xff, argb >>> 8 & 0xff, argb >>> 16 & 0xff, argb >>> 24];

/**
 * The blend's factor at `t` (0 to 1): GDI+'s blend positions and factors,
 * interpolated between neighbours.
 *
 * @param {number[]} positions @param {number[]} factors @param {number} t
 */
const blendAt = (positions, factors, t)=>{
    if (factors.length <= 1)
    {
        return t;
    }
    for (let i = 1; i < positions.length; i++)
    {
        if (t <= positions[i])
        {
            const span = positions[i] - positions[i - 1] || 1;
            const f = (t - positions[i - 1]) / span;
            return factors[i - 1] + (factors[i] - factors[i - 1]) * f;
        }
    }
    return factors[factors.length - 1];
};

/** @param {number} v */
const toLinear = v=>(v / 255) ** 2.2;
/** @param {number} v */
const fromLinear = v=>Math.round(255 * Math.max(0, Math.min(1, v)) ** (1 / 2.2));

/**
 * Two colours mixed: `f` of the second, straight alpha, in gamma 2.2 where
 * the brush asks for gamma correction.
 *
 * @param {number[]} a @param {number[]} b @param {number} f @param {boolean} gamma
 */
const mix = (a, b, f, gamma)=>a.map((v, i)=>(gamma && i < 3
    ? fromLinear(toLinear(v) + (toLinear(b[i]) - toLinear(v)) * f)
    : Math.round(v + (b[i] - v) * f)));

/**
 * A gradient's colour at `t`: a preset blend's colours where it has one,
 * else its two colours mixed by its blend.
 *
 * @param {import('./brush.js').Brush} brush @param {number[][]} ends @param {number} t
 */
const gradientAt = (brush, ends, t)=>{
    const presets = brush.presetColors ?? [];
    const gamma = Boolean(brush.gamma);
    if (presets.length >= 2)
    {
        const at = brush.presetPositions ?? [];
        for (let i = 1; i < at.length; i++)
        {
            if (t <= at[i])
            {
                const span = at[i] - at[i - 1] || 1;
                return mix(bgraOf(presets[i - 1]), bgraOf(presets[i]), (t - at[i - 1]) / span,
                    gamma);
            }
        }
        return bgraOf(presets[presets.length - 1]);
    }
    return mix(ends[0], ends[1], blendAt(brush.positions ?? [0], brush.factors ?? [1], t), gamma);
};

/**
 * @typedef {(x: number, y: number) => number[]} Shader  a pixel centre's
 *     [b, g, r, a] in device space
 */

/**
 * The shader of a brush, its geometry in world space taken to device space
 * by `device`.
 *
 * @param {import('./brush.js').Brush} brush
 * @param {import('./matrix.js').Elements} device
 * @param {{ texture: (image: number) => ({ width: number, height: number,
 *     pixels: Uint8Array } | null), hatch: (style: number) => number[][] | null,
 *     origin: [number, number] }} sources
 * @returns {Shader | null}  null for a brush with nothing to lay
 */
export function shaderOf(brush, device, sources){
    const wrap = brush.wrap ?? WrapModeTile;
    const flipX = wrap === WrapModeTileFlipX || wrap === WrapModeTileFlipXY;
    const flipY = wrap === WrapModeTileFlipY || wrap === WrapModeTileFlipXY;
    const clamp = wrap === WrapModeClamp;
    /** The brush's space from device space. @param {import('./matrix.js').Elements} own */
    const brushSpace = own=>{
        const m = invert([own[0] * device[0] + own[1] * device[2],
            own[0] * device[1] + own[1] * device[3], own[2] * device[0] + own[3] * device[2],
            own[2] * device[1] + own[3] * device[3],
            own[4] * device[0] + own[5] * device[2] + device[4],
            own[4] * device[1] + own[5] * device[3] + device[5]]);
        return m;
    };
    switch (brush.type)
    {
        case 0: {
            const colour = bgraOf(brush.color ?? 0);
            return ()=>colour;
        }
        case 1: {
            const pattern = sources.hatch(brush.hatch ?? 0);
            const fore = bgraOf(brush.fore ?? 0);
            const back = bgraOf(brush.back ?? 0);
            if (!pattern)
            {
                return null;
            }
            const [ox, oy] = sources.origin;
            return (x, y)=>{
                const share = pattern[(((Math.floor(y) - oy) % 8) + 8) % 8][
                    (((Math.floor(x) - ox) % 8) + 8) % 8];
                return mix(back, fore, share, false);
            };
        }
        case 4: {
            const m = brushSpace(/** @type {import('./matrix.js').Elements} */ (brush.transform));
            const [rx, , rw] = /** @type {number[]} */ (brush.rect);
            const ends = (brush.colors ?? [0, 0]).map(bgraOf);
            if (!m || !(rw > 0))
            {
                return null;
            }
            return (x, y)=>{
                const [u] = apply(m, [x, y]);
                let t = (u - rx) / rw;
                if (clamp)
                {
                    t = Math.max(0, Math.min(1, t));
                }
                else
                {
                    t = wrapped(t, 1, flipX, false);
                }
                return gradientAt(brush, ends, t);
            };
        }
        case 3: {
            const m = brushSpace(/** @type {import('./matrix.js').Elements} */ (brush.transform));
            const points = brush.points ?? [];
            const [cx, cy] = brush.center ?? [0, 0];
            const centre = bgraOf(brush.centerColor ?? 0);
            const surround = (brush.surround ?? []).map(bgraOf);
            if (!m || points.length < 2)
            {
                return null;
            }
            const gamma = Boolean(brush.gamma);
            return (x, y)=>{
                const [px, py] = apply(m, [x, y]);
                const dx = px - cx;
                const dy = py - cy;
                // The edge the ray from the centre through the point leaves by.
                for (let i = 0; i < points.length; i++)
                {
                    const [ax, ay] = points[i];
                    const [bx, by] = points[(i + 1) % points.length];
                    const ex = bx - ax;
                    const ey = by - ay;
                    const denominator = dx * ey - dy * ex;
                    if (Math.abs(denominator) < 1e-12)
                    {
                        continue;
                    }
                    const s = ((ax - cx) * ey - (ay - cy) * ex) / denominator;
                    const u = ((ax - cx) * dy - (ay - cy) * dx) / denominator;
                    if (s >= 1e-9 && u >= -1e-9 && u <= 1 + 1e-9)
                    {
                        if (s < 1)
                        {
                            return [0, 0, 0, 0];
                        }
                        const edge = mix(surround[i] ?? centre,
                            surround[(i + 1) % points.length] ?? centre, u, gamma);
                        const t = 1 - 1 / s;
                        const presets = brush.presetColors ?? [];
                        if (presets.length >= 2)
                        {
                            return gradientAt(brush, [edge, centre], 1 - t);
                        }
                        return mix(edge, centre, blendAt(brush.positions ?? [0],
                            brush.factors ?? [1], 1 - t), gamma);
                    }
                }
                return centre;
            };
        }
        case 2: {
            const m = brushSpace(/** @type {import('./matrix.js').Elements} */ (brush.transform));
            const source = sources.texture(brush.image ?? 0);
            if (!m || !source)
            {
                return null;
            }
            const { width, height, pixels } = source;
            const none = [0, 0, 0, 0];
            return (x, y)=>{
                const [u, v] = apply(m, [x, y]);
                const tx = Math.floor(wrapped(u, width, flipX, clamp));
                const ty = Math.floor(wrapped(v, height, flipY, clamp));
                if (!(tx >= 0 && ty >= 0 && tx < width && ty < height))
                {
                    return none;
                }
                const at = (ty * width + tx) * 4;
                return [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]];
            };
        }
        default:
            return null;
    }
}

/**
 * Paints coverage into BGRA pixels, straight alpha: each covered pixel the
 * shader's colour over what is there (SourceOver), or in its place in the
 * covered share (SourceCopy).
 *
 * @param {Uint8Array} target  the box's pixels, BGRA
 * @param {Float32Array} cover @param {Uint8Array | null} mask  1 where the clip lets through
 * @param {Box} box @param {Shader} shader @param {boolean} copy
 * @param {boolean} opaque  whether the target keeps no alpha
 * @param {number} offset  where a pixel's centre is
 */
export function paint(target, cover, mask, box, shader, copy, opaque, offset){
    const width = box.right - box.left;
    for (let i = 0; i < cover.length; i++)
    {
        const c = Math.min(1, cover[i]);
        if (c <= 0 || (mask && mask[i] === 0))
        {
            continue;
        }
        const x = box.left + i % width + offset;
        const y = box.top + Math.floor(i / width) + offset;
        const [sb, sg, sr, sa] = shader(x, y);
        const at = i * 4;
        const da = opaque ? 1 : target[at + 3] / 255;
        let a = sa / 255;
        if (copy)
        {
            // The covered share replaced: a blend of the old and the new by coverage.
            const keep = 1 - c;
            const outA = a * c + da * keep;
            for (let k = 0; k < 3; k++)
            {
                const s = [sb, sg, sr][k];
                target[at + k] = outA > 0 ? Math.round((s * a * c + target[at + k] * da * keep)
                    / outA) : 0;
            }
            target[at + 3] = opaque ? 255 : Math.round(outA * 255);
            continue;
        }
        a *= c;
        if (a <= 0)
        {
            continue;
        }
        const outA = a + da * (1 - a);
        for (let k = 0; k < 3; k++)
        {
            const s = [sb, sg, sr][k];
            target[at + k] = Math.round((s * a + target[at + k] * da * (1 - a)) / outA);
        }
        target[at + 3] = opaque ? 255 : Math.round(outA * 255);
    }
}

/**
 * Each HatchStyle's 8x8 cell as GDI+ draws it, top row first: two bits a
 * pixel, left pixel highest, a level from the background (0) to the
 * foreground (3) - GDI+ lays its diagonals with two levels between. The
 * cells are Windows' own output as Wine's brush test records it
 * (THIRD-PARTY-NOTICES.md).
 */
const HATCHES = [
    [0xffff, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000],
    [0xc000, 0xc000, 0xc000, 0xc000, 0xc000, 0xc000, 0xc000, 0xc000],
    [0x9001, 0x6400, 0x1900, 0x0640, 0x0190, 0x0064, 0x0019, 0x4006],
    [0x4006, 0x0019, 0x0064, 0x0190, 0x0640, 0x1900, 0x6400, 0x9001],
    [0xffff, 0xc000, 0xc000, 0xc000, 0xc000, 0xc000, 0xc000, 0xc000],
    [0x9006, 0x6419, 0x1964, 0x0690, 0x0690, 0x1964, 0x6419, 0x9006],
    [0xc000, 0x0000, 0x0000, 0x0000, 0x00c0, 0x0000, 0x0000, 0x0000],
    [0xc000, 0x0000, 0x00c0, 0x0000, 0xc000, 0x0000, 0x00c0, 0x0000],
    [0xc0c0, 0x0000, 0x0c0c, 0x0000, 0xc0c0, 0x0000, 0x0c0c, 0x0000],
    [0xc0c0, 0x0c0c, 0xc0c0, 0x0c0c, 0xc0c0, 0x0c0c, 0xc0c0, 0x0c0c],
    [0xcccc, 0x3030, 0xcccc, 0x0303, 0xcccc, 0x3030, 0xcccc, 0x0303],
    [0xcccc, 0x3333, 0xcccc, 0x3303, 0xcccc, 0x3333, 0xcccc, 0x0333],
    [0xcccc, 0x3333, 0xcccc, 0x3333, 0xcccc, 0x3333, 0xcccc, 0x3333],
    [0xfcfc, 0x3333, 0xcfcf, 0x3333, 0xfcfc, 0x3333, 0xcfcf, 0x3333],
    [0x3f3f, 0xf3f3, 0x3f3f, 0xf3f3, 0x3f3f, 0xf3f3, 0x3f3f, 0xf3f3],
    [0x3f3f, 0xffff, 0xf3f3, 0xffff, 0x3f3f, 0xffff, 0xf3f3, 0xffff],
    [0xfcff, 0xffff, 0xfffc, 0xffff, 0xfcff, 0xffff, 0xfffc, 0xffff],
    [0xffff, 0xffff, 0xffff, 0xff3f, 0xffff, 0xffff, 0xffff, 0x3fff],
    [0xc0c0, 0x3030, 0x0c0c, 0x0303, 0xc0c0, 0x3030, 0x0c0c, 0x0303],
    [0x0303, 0x0c0c, 0x3030, 0xc0c0, 0x0303, 0x0c0c, 0x3030, 0xc0c0],
    [0xf0f0, 0x3c3c, 0x0f0f, 0xc3c3, 0xf0f0, 0x3c3c, 0x0f0f, 0xc3c3],
    [0x0f0f, 0x3c3c, 0xf0f0, 0xc3c3, 0x0f0f, 0x3c3c, 0xf0f0, 0xc3c3],
    [0xf003, 0xfc00, 0x3f00, 0x0fc0, 0x03f0, 0x00fc, 0x003f, 0xc00f],
    [0xc00f, 0x003f, 0x00fc, 0x03f0, 0x0fc0, 0x3f00, 0xfc00, 0xf003],
    [0xc0c0, 0xc0c0, 0xc0c0, 0xc0c0, 0xc0c0, 0xc0c0, 0xc0c0, 0xc0c0],
    [0xffff, 0x0000, 0x0000, 0x0000, 0xffff, 0x0000, 0x0000, 0x0000],
    [0x3333, 0x3333, 0x3333, 0x3333, 0x3333, 0x3333, 0x3333, 0x3333],
    [0xffff, 0x0000, 0xffff, 0x0000, 0xffff, 0x0000, 0xffff, 0x0000],
    [0xf0f0, 0xf0f0, 0xf0f0, 0xf0f0, 0xf0f0, 0xf0f0, 0xf0f0, 0xf0f0],
    [0xffff, 0xffff, 0x0000, 0x0000, 0xffff, 0xffff, 0x0000, 0x0000],
    [0x0000, 0x0000, 0xc0c0, 0x3030, 0x0c0c, 0x0303, 0x0000, 0x0000],
    [0x0000, 0x0000, 0x0303, 0x0c0c, 0x3030, 0xc0c0, 0x0000, 0x0000],
    [0xff00, 0x0000, 0x0000, 0x0000, 0x00ff, 0x0000, 0x0000, 0x0000],
    [0xc000, 0xc000, 0xc000, 0xc000, 0x00c0, 0x00c0, 0x00c0, 0x00c0],
    [0xc000, 0x00c0, 0x3000, 0x000c, 0x0300, 0x0003, 0x0c00, 0x0030],
    [0xcf03, 0x0f00, 0x000f, 0x03cf, 0xf3c0, 0xf000, 0x00f0, 0xc0f3],
    [0xc003, 0x300c, 0x0c30, 0x03c0, 0xc003, 0x300c, 0x0c30, 0x03c0],
    [0x0000, 0x03c0, 0x0c33, 0xf000, 0x0000, 0x03c0, 0x0c33, 0xf000],
    [0x0003, 0x000c, 0x0030, 0x00c0, 0x03c0, 0x0c30, 0x300c, 0xc003],
    [0xffff, 0xc000, 0xc000, 0xc000, 0xffff, 0x00c0, 0x00c0, 0x00c0],
    [0xc0c0, 0x3330, 0x0c0c, 0x3033, 0xc0c0, 0x0330, 0x0c0c, 0x3303],
    [0xcccc, 0x3333, 0xcccc, 0x3333, 0xff00, 0xff00, 0xff00, 0xff00],
    [0x0000, 0x0300, 0x00c0, 0x0300, 0x0000, 0xc000, 0x0003, 0xc000],
    [0xcccc, 0x0000, 0xc000, 0x0000, 0xc000, 0x0000, 0xc000, 0x0000],
    [0xc000, 0x0000, 0x0c0c, 0x0000, 0x00c0, 0x0000, 0x0c0c, 0x0000],
    [0x000f, 0xc030, 0x30c0, 0x0f00, 0x00f0, 0x000c, 0x0003, 0x0003],
    [0xffff, 0x3c3c, 0xffff, 0xc3c3, 0xffff, 0x3c3c, 0xffff, 0xc3c3],
    [0x3f3f, 0xc0c3, 0xc0ff, 0xc0ff, 0x3f3f, 0xc3c0, 0xffc0, 0xffc0],
    [0xffff, 0xc0c0, 0xc0c0, 0xc0c0, 0xffff, 0xc0c0, 0xc0c0, 0xc0c0],
    [0xc3c3, 0x3c3c, 0x3c3c, 0xc3c3, 0xc3c3, 0x3c3c, 0x3c3c, 0xc3c3],
    [0xff00, 0xff00, 0xff00, 0xff00, 0x00ff, 0x00ff, 0x00ff, 0x00ff],
    [0xc00c, 0x3030, 0x0cc0, 0x0300, 0x0cc0, 0x3030, 0xc00c, 0x0003],
    [0x0300, 0x0fc0, 0x3ff0, 0xfffc, 0x3ff0, 0x0fc0, 0x0300, 0x0000],
];

/** The foreground's share at each level of a hatch cell. */
const HATCH_LEVELS = [0, 64 / 255, 234 / 255, 1];

/**
 * A hatch style's cell as rows of foreground shares; null for a style past
 * the last.
 *
 * @param {number} style
 * @returns {number[][] | null}
 */
export const hatchPattern = style=>{
    const rows = HATCHES[style];
    return rows ? rows.map(row=>Array.from({ length: 8 }, (_, x)=>
        HATCH_LEVELS[row >> (2 * (7 - x)) & 3])) : null;
};

export { WrapModeTile, WrapModeClamp };
