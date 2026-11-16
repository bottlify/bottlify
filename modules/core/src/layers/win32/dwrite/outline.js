/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A TrueType glyph's outline, read from 'glyf' as the OpenType specification
 * lays it out, and drawn into coverage: what DirectWrite draws a face loaded
 * from a file with. The faces of the system collection are the browser's to
 * draw (`system.js`); a program's own font - a managed program's, WPF reading
 * its fonts as files - has nothing else to draw it.
 *
 * Contours are quadratic B-splines: two off-curve points in a row have an
 * implied on-curve point between them. A composite glyph is its components,
 * each moved (and scaled) as its record says. Coverage is the share of 4x4
 * samples of a pixel inside the outline under the non-zero winding rule,
 * which is TrueType's fill.
 */

/** Simple glyph flags. */
const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;
/** Composite glyph flags. */
const ARGS_ARE_WORDS = 0x0001;
const ARGS_ARE_XY = 0x0002;
const HAVE_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAVE_XY_SCALE = 0x0040;
const HAVE_2X2 = 0x0080;
/** How deep components may nest before a font is taken as broken. */
const MAX_DEPTH = 8;
/** Line segments a quadratic curve is drawn as. */
const CURVE_STEPS = 8;
/** Samples a pixel side. */
const SAMPLES = 4;

/**
 * @typedef {{ x: number, y: number, on: boolean }} Point
 * @typedef {Point[]} Contour
 */

/**
 * The outline reader of a face's tables: a glyph's contours in design units,
 * y up; none for a glyph with no outline or a face with no 'glyf'.
 *
 * @param {Map<string, Uint8Array>} tables
 * @returns {(glyph: number) => Contour[]}
 */
export function outlinesOf(tables){
    const view = (/** @type {string} */ tag)=>{
        const bytes = tables.get(tag);
        return bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
    };
    const head = view('head');
    const loca = view('loca');
    const glyf = view('glyf');
    const maxp = view('maxp');
    const count = maxp && maxp.byteLength >= 6 ? maxp.getUint16(4) : 0;
    const shortLoca = head && head.byteLength >= 54 ? head.getInt16(50) === 0 : true;
    /** @param {number} glyph @returns {[number, number] | null} */
    const span = glyph=>{
        if (!loca || !glyf || glyph >= count)
        {
            return null;
        }
        const step = shortLoca ? 2 : 4;
        if ((glyph + 2) * step > loca.byteLength)
        {
            return null;
        }
        const at = (/** @type {number} */ i)=>(shortLoca ? loca.getUint16(i * 2) * 2
            : loca.getUint32(i * 4));
        const from = at(glyph);
        const to = at(glyph + 1);
        return to > from && to <= glyf.byteLength ? [from, to] : null;
    };

    /** @param {number} glyph @param {number} depth @returns {Contour[]} */
    const read = (glyph, depth)=>{
        const where = span(glyph);
        if (!where || !glyf || depth > MAX_DEPTH)
        {
            return [];
        }
        const [from] = where;
        const contours = glyf.getInt16(from);
        return contours >= 0 ? simple(from, contours) : composite(from + 10, depth);
    };

    /** @param {number} from @param {number} contours @returns {Contour[]} */
    const simple = (from, contours)=>{
        const g = /** @type {DataView} */ (glyf);
        let at = from + 10;
        const ends = [];
        for (let i = 0; i < contours; i++, at += 2)
        {
            ends.push(g.getUint16(at));
        }
        const points = contours === 0 ? 0 : ends[contours - 1] + 1;
        at += 2 + g.getUint16(at);
        const flags = new Uint8Array(points);
        for (let i = 0; i < points;)
        {
            const flag = g.getUint8(at++);
            flags[i++] = flag;
            if (flag & REPEAT)
            {
                for (let n = g.getUint8(at++); n > 0 && i < points; n--)
                {
                    flags[i++] = flag;
                }
            }
        }
        /** @param {number} short @param {number} same */
        const coordinates = (short, same)=>{
            const out = new Int32Array(points);
            let value = 0;
            for (let i = 0; i < points; i++)
            {
                const flag = flags[i];
                if (flag & short)
                {
                    const delta = g.getUint8(at++);
                    value += flag & same ? delta : -delta;
                }
                else if (!(flag & same))
                {
                    value += g.getInt16(at);
                    at += 2;
                }
                out[i] = value;
            }
            return out;
        };
        const xs = coordinates(X_SHORT, X_SAME_OR_POSITIVE);
        const ys = coordinates(Y_SHORT, Y_SAME_OR_POSITIVE);
        /** @type {Contour[]} */
        const out = [];
        let start = 0;
        for (const end of ends)
        {
            const contour = [];
            for (let i = start; i <= end; i++)
            {
                contour.push({ x: xs[i], y: ys[i], on: (flags[i] & ON_CURVE) !== 0 });
            }
            out.push(contour);
            start = end + 1;
        }
        return out;
    };

    /** @param {number} at @param {number} depth @returns {Contour[]} */
    const composite = (at, depth)=>{
        const g = /** @type {DataView} */ (glyf);
        /** @type {Contour[]} */
        const out = [];
        for (let more = true; more;)
        {
            const flags = g.getUint16(at);
            const component = g.getUint16(at + 2);
            at += 4;
            let dx = 0;
            let dy = 0;
            if (flags & ARGS_ARE_WORDS)
            {
                dx = g.getInt16(at);
                dy = g.getInt16(at + 2);
                at += 4;
            }
            else
            {
                dx = g.getInt8(at);
                dy = g.getInt8(at + 1);
                at += 2;
            }
            let [a, b, c, d] = [1, 0, 0, 1];
            const f2dot14 = (/** @type {number} */ offset)=>g.getInt16(offset) / 16384;
            if (flags & HAVE_SCALE)
            {
                a = d = f2dot14(at);
                at += 2;
            }
            else if (flags & HAVE_XY_SCALE)
            {
                a = f2dot14(at);
                d = f2dot14(at + 2);
                at += 4;
            }
            else if (flags & HAVE_2X2)
            {
                [a, b, c, d] = [f2dot14(at), f2dot14(at + 2), f2dot14(at + 4), f2dot14(at + 6)];
                at += 8;
            }
            // Point-matching offsets (ARGS_ARE_XY clear) are rare and taken as none.
            if (!(flags & ARGS_ARE_XY))
            {
                dx = 0;
                dy = 0;
            }
            for (const contour of read(component, depth + 1))
            {
                out.push(contour.map(point=>({ x: point.x * a + point.y * c + dx,
                    y: point.x * b + point.y * d + dy, on: point.on })));
            }
            more = (flags & MORE_COMPONENTS) !== 0;
        }
        return out;
    };

    return glyph=>read(glyph, 0);
}

/**
 * A contour as the closed polygon its curves are drawn as.
 *
 * @param {Contour} contour
 * @returns {{ x: number, y: number }[]}
 */
function flatten(contour){
    const n = contour.length;
    if (n === 0)
    {
        return [];
    }
    // Start on an on-curve point, an implied one between two off-curve ones if none.
    let first = contour.findIndex(point=>point.on);
    /** @type {Point} */
    let start;
    if (first < 0)
    {
        start = { x: (contour[0].x + contour[n - 1].x) / 2,
            y: (contour[0].y + contour[n - 1].y) / 2, on: true };
        first = 0;
    }
    else
    {
        start = contour[first];
        first += 1;
    }
    const out = [{ x: start.x, y: start.y }];
    let previous = start;
    /** @type {Point | null} */
    let control = null;
    for (let k = 0; k < n; k++)
    {
        const point = contour[(first + k) % n];
        if (point.on)
        {
            if (control)
            {
                curve(out, previous, control, point);
                control = null;
            }
            else
            {
                out.push({ x: point.x, y: point.y });
            }
            previous = point;
        }
        else if (control)
        {
            const middle = { x: (control.x + point.x) / 2, y: (control.y + point.y) / 2,
                on: true };
            curve(out, previous, control, middle);
            previous = middle;
            control = point;
        }
        else
        {
            control = point;
        }
    }
    if (control)
    {
        curve(out, previous, control, start);
    }
    return out;
}

/** @param {{ x: number, y: number }[]} out @param {Point} p0 @param {Point} p1 @param {Point} p2 */
function curve(out, p0, p1, p2){
    for (let step = 1; step <= CURVE_STEPS; step++)
    {
        const t = step / CURVE_STEPS;
        const u = 1 - t;
        out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
            y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
    }
}

/**
 * A glyph drawn at `scale` pixels a design unit: its coverage, a byte a pixel,
 * rows down, and where its top-left pixel is from the glyph's origin on the
 * baseline (`left` right of it, `top` below it - negative above the baseline).
 *
 * @param {Contour[]} contours @param {number} scale
 * @returns {{ left: number, top: number, width: number, height: number,
 *     coverage: Uint8Array }}
 */
export function rasterize(contours, scale){
    // In pixels, y down.
    const polygons = contours.map(contour=>flatten(contour)
        .map(point=>({ x: point.x * scale, y: -point.y * scale })))
        .filter(polygon=>polygon.length > 2);
    const all = polygons.flat();
    if (all.length === 0)
    {
        return { left: 0, top: 0, width: 0, height: 0, coverage: new Uint8Array(0) };
    }
    const left = Math.floor(Math.min(...all.map(p=>p.x)));
    const top = Math.floor(Math.min(...all.map(p=>p.y)));
    const width = Math.ceil(Math.max(...all.map(p=>p.x))) - left + 1;
    const height = Math.ceil(Math.max(...all.map(p=>p.y))) - top + 1;
    const counts = new Uint16Array(width * height);
    /** @type {{ x0: number, y0: number, x1: number, y1: number, dir: number }[]} */
    const edges = [];
    for (const polygon of polygons)
    {
        for (let i = 0; i < polygon.length; i++)
        {
            const a = polygon[i];
            const b = polygon[(i + 1) % polygon.length];
            if (a.y !== b.y)
            {
                edges.push(a.y < b.y ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: 1 }
                    : { x0: b.x, y0: b.y, x1: a.x, y1: a.y, dir: -1 });
            }
        }
    }
    for (let row = 0; row < height * SAMPLES; row++)
    {
        const y = top + (row + 0.5) / SAMPLES;
        /** @type {{ x: number, dir: number }[]} */
        const crossings = [];
        for (const edge of edges)
        {
            if (y >= edge.y0 && y < edge.y1)
            {
                crossings.push({ x: edge.x0 + (y - edge.y0) * (edge.x1 - edge.x0)
                    / (edge.y1 - edge.y0), dir: edge.dir });
            }
        }
        crossings.sort((p, q)=>p.x - q.x);
        const pixelRow = Math.floor(row / SAMPLES) * width;
        let winding = 0;
        for (let i = 0; i < crossings.length - 1; i++)
        {
            winding += crossings[i].dir;
            if (winding === 0)
            {
                continue;
            }
            // Every horizontal sample whose centre lies in this span.
            const from = Math.ceil((crossings[i].x - left) * SAMPLES - 0.5);
            const to = Math.floor((crossings[i + 1].x - left) * SAMPLES - 0.5);
            for (let s = Math.max(0, from); s <= Math.min(width * SAMPLES - 1, to); s++)
            {
                counts[pixelRow + Math.floor(s / SAMPLES)]++;
            }
        }
    }
    const coverage = new Uint8Array(width * height);
    const full = SAMPLES * SAMPLES;
    for (let i = 0; i < coverage.length; i++)
    {
        coverage[i] = Math.min(255, Math.round(counts[i] * 255 / full));
    }
    return { left, top, width, height, coverage };
}
