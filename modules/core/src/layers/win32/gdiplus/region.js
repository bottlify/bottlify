/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s regions: a tree of the rectangles, paths, empty and infinite areas
 * a program combined, kept as it combined them - GetRegionData hands that
 * tree back, prefix order, in GDI+'s own format - and taken to pixels only
 * where pixels are asked for: scans, an HRGN, emptiness, equality, a clip.
 *
 * A pixel is in a region when its centre (x + 0.5, y + 0.5) is, as GDI+
 * rasterises one; the pixels of a combination are its parts' combined
 * band by band (`gdi32/regions.js`). A point is tested against the tree
 * exactly. Infinite is the square of 2^23 about the origin, as GDI+ bounds it.
 */

import {
    RGN_AND, RGN_DIFF, RGN_OR, RGN_XOR, areasEqual, bandsOf, combineAreas, rectsOf,
} from '../gdi32/regions.js';
import { Status, fn } from './kit.js';
import { apply } from './matrix.js';
import {
    FillModeAlternate, PathPointTypeCloseSubpath, PathPointTypeLine, PathPointTypeStart,
    clonePath, emptyPath, figures, insidePolygons,
} from './path.js';
import { pixelRuns } from './raster.js';

/** CombineMode. */
export const CombineMode = Object.freeze({ Replace: 0, Intersect: 1, Union: 2, Xor: 3,
    Exclude: 4, Complement: 5 });

/** RegionData's node types and magic numbers. */
const NODE_RECT = 0x10000000;
const NODE_PATH = 0x10000001;
const NODE_EMPTY = 0x10000002;
const NODE_INFINITE = 0x10000003;
const MAGIC_REGION = 0xdbc01002;
const MAGIC_PATH = 0xdbc01001;
/** A path's points stored as shorts. */
const PATH_SHORTS = 0x4000;

/** Infinite's bounds: 2^22 each way from the origin. */
const FAR = 4194304;

/**
 * @typedef {{ type: 'rect', rect: number[] } | { type: 'path', path: import('./path.js').Path }
 *     | { type: 'empty' } | { type: 'infinite' }
 *     | { type: 'combine', mode: number, left: Node, right: Node }} Node
 */

/** @returns {Node} */
export const infinite = ()=>({ type: 'infinite' });
/** @param {number[]} rect @returns {Node} */
export const rectNode = rect=>({ type: 'rect', rect: [...rect] });
/** @param {import('./path.js').Path} path @returns {Node} */
export const pathNode = path=>({ type: 'path', path: clonePath(path) });

/** @param {Node} node @returns {Node} */
export const cloneNode = node=>{
    switch (node.type)
    {
        case 'rect': return rectNode(node.rect);
        case 'path': return pathNode(node.path);
        case 'combine': return { type: 'combine', mode: node.mode, left: cloneNode(node.left),
            right: cloneNode(node.right) };
        default: return { type: node.type };
    }
};

/**
 * The region `node` combined with `other` by `mode`: Replace is the other;
 * an infinite region intersected, or an empty one united or xored, is the
 * other; an empty one intersected, excluded from or complemented by
 * nothing stays as it is; anything else is the combination.
 *
 * @param {Node} node @param {Node} other @param {number} mode
 * @returns {Node}
 */
export const combine = (node, other, mode)=>{
    if (mode === CombineMode.Replace
        || (node.type === 'infinite' && mode === CombineMode.Intersect)
        || (node.type === 'empty' && (mode === CombineMode.Union || mode === CombineMode.Xor
            || mode === CombineMode.Complement)))
    {
        return cloneNode(other);
    }
    if (node.type === 'empty' && (mode === CombineMode.Intersect || mode === CombineMode.Exclude))
    {
        return node;
    }
    return { type: 'combine', mode, left: node, right: cloneNode(other) };
};

/**
 * The region taken through a matrix: a rectangle stays one under a matrix
 * that neither turns nor shears, else becomes the path of its corners.
 *
 * @param {Node} node @param {import('./matrix.js').Elements} m
 * @returns {Node}
 */
export const transformNode = (node, m)=>{
    switch (node.type)
    {
        case 'rect': {
            const [x, y, w, h] = node.rect;
            if (m[1] === 0 && m[2] === 0)
            {
                return rectNode([x * m[0] + m[4], y * m[3] + m[5], w * m[0], h * m[3]]);
            }
            const path = emptyPath();
            path.points = /** @type {[number, number][]} */ ([[x, y], [x + w, y], [x + w, y + h],
                [x, y + h]]).map(p=>apply(m, p));
            path.types = [PathPointTypeStart, PathPointTypeLine, PathPointTypeLine,
                PathPointTypeLine | PathPointTypeCloseSubpath];
            return { type: 'path', path };
        }
        case 'path': {
            const path = clonePath(node.path);
            path.points = path.points.map(p=>apply(m, p));
            return { type: 'path', path };
        }
        case 'combine':
            return { type: 'combine', mode: node.mode, left: transformNode(node.left, m),
                right: transformNode(node.right, m) };
        default:
            return node;
    }
};

/**
 * The pixels of a region, as banded rectangles.
 *
 * @param {Node} node
 * @returns {import('../gdi32/regions.js').Rect[]}
 */
export const areaOf = node=>{
    switch (node.type)
    {
        case 'empty': return [];
        case 'infinite': return [{ left: -FAR, top: -FAR, right: FAR, bottom: FAR }];
        case 'rect': {
            const [x, y, w, h] = node.rect;
            const [l, r] = w < 0 ? [x + w, x] : [x, x + w];
            const [t, b] = h < 0 ? [y + h, y] : [y, y + h];
            const rect = { left: Math.ceil(l - 0.5), top: Math.ceil(t - 0.5),
                right: Math.ceil(r - 0.5), bottom: Math.ceil(b - 0.5) };
            return rect.right > rect.left && rect.bottom > rect.top ? [rect] : [];
        }
        case 'path': {
            const polygons = figures(node.path);
            const all = polygons.flat();
            if (all.length === 0)
            {
                return [];
            }
            const xs = all.map(([x])=>x);
            const ys = all.map(([, y])=>y);
            const box = { left: Math.max(-FAR, Math.floor(Math.min(...xs)) - 1),
                top: Math.max(-FAR, Math.floor(Math.min(...ys)) - 1),
                right: Math.min(FAR, Math.ceil(Math.max(...xs)) + 1),
                bottom: Math.min(FAR, Math.ceil(Math.max(...ys)) + 1) };
            /** @type {import('../gdi32/regions.js').Rect[]} */
            const rects = [];
            pixelRuns(polygons, node.path.fill, box, 0.5).forEach((runs, row)=>{
                for (let i = 0; i < runs.length; i += 2)
                {
                    rects.push({ left: runs[i], top: box.top + row, right: runs[i + 1],
                        bottom: box.top + row + 1 });
                }
            });
            return rectsOf(bandsOf(rects));
        }
        default: {
            const left = areaOf(node.left);
            const right = areaOf(node.right);
            const mode = node.mode;
            const result = mode === CombineMode.Complement ? combineAreas(right, left, RGN_DIFF)
                : combineAreas(left, right, mode === CombineMode.Intersect ? RGN_AND
                    : mode === CombineMode.Union ? RGN_OR : mode === CombineMode.Xor ? RGN_XOR
                        : RGN_DIFF);
            return result ?? [];
        }
    }
};

/**
 * Whether a point is in the region, the tree tested exactly.
 *
 * @param {Node} node @param {number} x @param {number} y
 * @returns {boolean}
 */
export const contains = (node, x, y)=>{
    switch (node.type)
    {
        case 'empty': return false;
        case 'infinite': return true;
        case 'rect': {
            const [rx, ry, w, h] = node.rect;
            return x >= Math.min(rx, rx + w) && x < Math.max(rx, rx + w)
                && y >= Math.min(ry, ry + h) && y < Math.max(ry, ry + h);
        }
        case 'path': return insidePolygons(figures(node.path), x, y, node.path.fill);
        default: {
            const a = contains(node.left, x, y);
            const b = contains(node.right, x, y);
            switch (node.mode)
            {
                case CombineMode.Intersect: return a && b;
                case CombineMode.Union: return a || b;
                case CombineMode.Xor: return a !== b;
                case CombineMode.Exclude: return a && !b;
                default: return b && !a;
            }
        }
    }
};

/**
 * A region's bounds as GDI+ reports them, not rounded: each rectangle's
 * and path's own, combined as their parts are.
 *
 * @param {Node} node
 * @returns {number[] | null}  x y width height, null for none
 */
export const boundsOfNode = node=>{
    switch (node.type)
    {
        case 'empty': return null;
        case 'infinite': return [-FAR, -FAR, 2 * FAR, 2 * FAR];
        case 'rect': {
            const [x, y, w, h] = node.rect;
            return w === 0 || h === 0 ? null : [Math.min(x, x + w), Math.min(y, y + h),
                Math.abs(w), Math.abs(h)];
        }
        case 'path': {
            const points = node.path.points;
            if (points.length === 0)
            {
                return null;
            }
            const xs = points.map(([x])=>x);
            const ys = points.map(([, y])=>y);
            const left = Math.min(...xs);
            const top = Math.min(...ys);
            return [left, top, Math.max(...xs) - left, Math.max(...ys) - top];
        }
        default: {
            const a = boundsOfNode(node.left);
            const b = boundsOfNode(node.right);
            /** @param {number[] | null} p @param {number[] | null} q */
            const union = (p, q)=>{
                if (!p || !q)
                {
                    return p ?? q;
                }
                const left = Math.min(p[0], q[0]);
                const top = Math.min(p[1], q[1]);
                return [left, top, Math.max(p[0] + p[2], q[0] + q[2]) - left,
                    Math.max(p[1] + p[3], q[1] + q[3]) - top];
            };
            switch (node.mode)
            {
                case CombineMode.Intersect: {
                    if (!a || !b)
                    {
                        return null;
                    }
                    const left = Math.max(a[0], b[0]);
                    const top = Math.max(a[1], b[1]);
                    const right = Math.min(a[0] + a[2], b[0] + b[2]);
                    const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
                    return right > left && bottom > top ? [left, top, right - left, bottom - top]
                        : null;
                }
                case CombineMode.Exclude: return a;
                case CombineMode.Complement: return b;
                default: return union(a, b);
            }
        }
    }
};

/** @param {Node} node @returns {number} */
const combinations = node=>(node.type === 'combine'
    ? 1 + combinations(node.left) + combinations(node.right) : 0);

/**
 * A path as RegionData stores one: its magic, count and flags, points as
 * shorts where every one is a whole number a short holds, its types padded
 * to four bytes.
 *
 * @param {import('./path.js').Path} path
 * @returns {number[]}  the bytes
 */
const pathBytes = path=>{
    const count = path.points.length;
    const shorts = count > 0 && path.points.every(([x, y])=>Number.isInteger(Math.fround(x))
        && Number.isInteger(Math.fround(y)) && Math.abs(x) < 0x8000 && Math.abs(y) < 0x8000);
    const pointBytes = count * (shorts ? 4 : 8);
    const typeBytes = Math.ceil(count / 4) * 4;
    const out = new Uint8Array(12 + pointBytes + typeBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC_PATH, true);
    view.setUint32(4, count, true);
    view.setUint32(8, shorts ? PATH_SHORTS : 0, true);
    path.points.forEach(([x, y], i)=>{
        if (shorts)
        {
            view.setInt16(12 + i * 4, x, true);
            view.setInt16(14 + i * 4, y, true);
        }
        else
        {
            view.setFloat32(12 + i * 8, x, true);
            view.setFloat32(16 + i * 8, y, true);
        }
    });
    out.set(path.types, 12 + pointBytes);
    return [...out];
};

/**
 * The region as GetRegionData writes it: the header (its size after the
 * first two fields, a checksum, magic, how many children combinations
 * have), then its nodes in prefix order.
 *
 * @param {Node} node
 * @returns {Uint8Array}
 */
const regionData = node=>{
    /** @type {number[]} */
    const body = [];
    /** @param {number} value */
    const dword = value=>body.push(...new Uint8Array(Uint32Array.of(value >>> 0).buffer));
    /** @param {number} value */
    const real = value=>body.push(...new Uint8Array(Float32Array.of(value).buffer));
    /** @param {Node} n */
    const walk = n=>{
        switch (n.type)
        {
            case 'rect':
                dword(NODE_RECT);
                n.rect.forEach(real);
                break;
            case 'path': {
                const bytes = pathBytes(n.path);
                dword(NODE_PATH);
                dword(bytes.length);
                body.push(...bytes);
                break;
            }
            case 'empty': dword(NODE_EMPTY); break;
            case 'infinite': dword(NODE_INFINITE); break;
            default:
                dword(n.mode);
                walk(n.left);
                walk(n.right);
        }
    };
    walk(node);
    const out = new Uint8Array(16 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, out.length - 8, true);
    view.setUint32(8, MAGIC_REGION, true);
    view.setUint32(12, combinations(node) * 2, true);
    out.set(body, 16);
    view.setUint32(4, crc32(out.subarray(8)), true);
    return out;
};

/** CRC-32 of the data after the checksum, as GDI+ fills that field. @param {Uint8Array} bytes */
const crc32 = bytes=>{
    let c = 0xffffffff;
    for (const byte of bytes)
    {
        c ^= byte;
        for (let k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
        }
    }
    return (c ^ 0xffffffff) >>> 0;
};

/**
 * The region RegionData describes; null for data GDI+ does not take, and
 * 'empty-path' for a path of no points, which GDI+ refuses to make.
 *
 * @param {Uint8Array} bytes
 * @returns {Node | null | 'empty-path'}
 */
const parseRegionData = bytes=>{
    if (bytes.length < 20)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(8, true);
    if (magic !== MAGIC_REGION && magic !== MAGIC_PATH)
    {
        return null;
    }
    let at = 16;
    let emptyPathSeen = false;
    /** @returns {Node | null} */
    const read = ()=>{
        if (at + 4 > bytes.length)
        {
            return null;
        }
        const type = view.getUint32(at, true);
        at += 4;
        switch (type)
        {
            case NODE_RECT: {
                if (at + 16 > bytes.length)
                {
                    return null;
                }
                const rect = [0, 4, 8, 12].map(o=>view.getFloat32(at + o, true));
                at += 16;
                return rectNode(rect);
            }
            case NODE_PATH: {
                const size = view.getUint32(at, true);
                const start = at + 4;
                at = start + size;
                if (at > bytes.length || size < 12)
                {
                    return null;
                }
                const count = view.getUint32(start + 4, true);
                const shorts = (view.getUint32(start + 8, true) & PATH_SHORTS) !== 0;
                if (count === 0)
                {
                    emptyPathSeen = true;
                    return { type: 'path', path: emptyPath() };
                }
                const path = emptyPath(FillModeAlternate);
                path.points = Array.from({ length: count }, (_, i)=>(shorts
                    ? [view.getInt16(start + 12 + i * 4, true), view.getInt16(start + 14 + i * 4,
                        true)]
                    : [view.getFloat32(start + 12 + i * 8, true),
                        view.getFloat32(start + 16 + i * 8, true)]));
                const types = start + 12 + count * (shorts ? 4 : 8);
                path.types = [...bytes.subarray(types, types + count)];
                return { type: 'path', path };
            }
            case NODE_EMPTY: return { type: 'empty' };
            case NODE_INFINITE: return { type: 'infinite' };
            default: {
                if (type < CombineMode.Intersect || type > CombineMode.Complement)
                {
                    return null;
                }
                const left = read();
                const right = left && read();
                return left && right ? { type: 'combine', mode: type, left, right } : null;
            }
        }
    };
    const node = read();
    return emptyPathSeen ? 'empty-path' : node;
};

/**
 * @param {import('./kit.js').Kit} kit
 * @param {Object} deps
 * @param {{ elements: (at: number) => (import('./matrix.js').Elements | undefined) }} deps.matrices
 * @param {{ get: (at: number) => (import('./path.js').Path | undefined) }} deps.paths
 * @param {(at: number) => boolean} deps.isGraphics
 * @param {(name: string, args: number[]) => number} [deps.gdi32]
 * @param {(bytes: number) => number} deps.allocate @param {(at: number) => void} deps.free
 */
export function createRegionFunctions(kit, deps){
    const { matrices, paths, isGraphics, gdi32, allocate, free } = deps;
    const { Ok, InvalidParameter, InsufficientBuffer, GenericError } = Status;
    /** @param {number} at @returns {{ node: Node } | undefined} */
    const get = at=>kit.get(at, 'region');
    /** @param {Node} node @param {number} out */
    const make = (node, out)=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        kit.add('region', { node }, out);
        return Ok;
    };
    /**
     * @param {(region: { node: Node }, args: number[]) => number} body
     * @returns {(args: number[]) => number}
     */
    const onRegion = body=>([at, ...rest])=>{
        const region = get(at);
        return region ? body(region, rest) : InvalidParameter;
    };
    /** @param {number} mode */
    const validMode = mode=>(mode | 0) >= 0 && (mode | 0) <= CombineMode.Complement;
    /**
     * @param {{ node: Node }} region @param {Node} other @param {number} mode
     */
    const combineInto = (region, other, mode)=>{
        if (!validMode(mode))
        {
            return InvalidParameter;
        }
        region.node = combine(region.node, other, mode | 0);
        return Ok;
    };
    /** @param {number} at  a GpRect */
    const rectI = at=>kit.i32s(at, 4);
    /** @param {Node} node @param {number} matrix */
    const scansOf = (node, matrix)=>{
        const m = (matrix >>> 0) === 0 ? null : matrices.elements(matrix);
        return areaOf(m ? transformNode(node, m) : node);
    };
    /**
     * An HRGN of the region's pixels; 0 for an infinite region, as GDI+ hands one.
     *
     * @param {Node} node
     */
    const toHrgn = node=>{
        if (!gdi32)
        {
            return -1;
        }
        const area = areaOf(node);
        if (node.type === 'infinite')
        {
            return 0;
        }
        const out = gdi32('CreateRectRgn', [0, 0, 0, 0]) >>> 0;
        for (const r of area)
        {
            const piece = gdi32('CreateRectRgn', [r.left, r.top, r.right, r.bottom]);
            gdi32('CombineRgn', [out, out, piece, RGN_OR]);
            gdi32('DeleteObject', [piece]);
        }
        return out;
    };
    /**
     * The rectangles of an HRGN, through GetRegionData: RGNDATAHEADER
     * (32 bytes), then the rectangles.
     *
     * @param {number} hrgn
     * @returns {number[][] | null}
     */
    const hrgnRects = hrgn=>{
        if (!gdi32)
        {
            return null;
        }
        const size = gdi32('GetRegionData', [hrgn, 0, 0]);
        if (size === 0)
        {
            return null;
        }
        const at = allocate(size);
        if (at === 0)
        {
            return null;
        }
        try
        {
            gdi32('GetRegionData', [hrgn, size, at]);
            const count = kit.u32(at + 8);
            return Array.from({ length: count }, (_, i)=>kit.i32s(at + 32 + i * 16, 4));
        }
        finally
        {
            free(at);
        }
    };

    const functions = {
        /** Status GdipCreateRegion(GpRegion **region): infinite. */
        GdipCreateRegion: fn(4, ([out])=>make(infinite(), out)),
        /** Status GdipCreateRegionRect(const GpRectF *rect, GpRegion **region) */
        GdipCreateRegionRect: fn(8, ([rect, out])=>((rect >>> 0) === 0 ? InvalidParameter
            : make(rectNode(kit.f32s(rect, 4)), out))),
        /** Status GdipCreateRegionRectI(const GpRect *rect, GpRegion **region) */
        GdipCreateRegionRectI: fn(8, ([rect, out])=>((rect >>> 0) === 0 ? InvalidParameter
            : make(rectNode(rectI(rect)), out))),
        /** Status GdipCreateRegionPath(GpPath *path, GpRegion **region) */
        GdipCreateRegionPath: fn(8, ([at, out])=>{
            const path = paths.get(at);
            return path ? make(pathNode(path), out) : InvalidParameter;
        }),
        /**
         * Status GdipCreateRegionRgnData(const BYTE *data, INT size, GpRegion **region)
         *
         * A region from what GetRegionData wrote; a path of no points in it
         * is GenericError, as GDI+ refuses one.
         */
        GdipCreateRegionRgnData: fn(12, ([data, size, out])=>{
            if ((data >>> 0) === 0 || (out >>> 0) === 0 || (size | 0) <= 0)
            {
                return InvalidParameter;
            }
            const node = parseRegionData(kit.read(data, size | 0));
            if (node === 'empty-path')
            {
                return GenericError;
            }
            return node ? make(node, out) : InvalidParameter;
        }),
        /**
         * Status GdipCreateRegionHrgn(HRGN hrgn, GpRegion **region)
         *
         * One rectangle stays one; several are a path of them.
         */
        GdipCreateRegionHrgn: fn(8, ([hrgn, out])=>{
            if ((hrgn >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const rects = hrgnRects(hrgn);
            if (!rects)
            {
                return InvalidParameter;
            }
            if (rects.length === 1)
            {
                const [l, t, r, b] = rects[0];
                return make(rectNode([l, t, r - l, b - t]), out);
            }
            const path = emptyPath();
            for (const [l, t, r, b] of rects)
            {
                path.points.push([l, t], [r, t], [r, b], [l, b]);
                path.types.push(PathPointTypeStart, PathPointTypeLine, PathPointTypeLine,
                    PathPointTypeLine | PathPointTypeCloseSubpath);
            }
            return make({ type: 'path', path }, out);
        }),
        /** Status GdipCloneRegion(GpRegion *region, GpRegion **clone) */
        GdipCloneRegion: fn(8, onRegion((region, [out])=>make(cloneNode(region.node), out))),
        /** Status GdipDeleteRegion(GpRegion *region) */
        GdipDeleteRegion: fn(4, ([at])=>(kit.remove(at, 'region') ? Ok : InvalidParameter)),
        /** Status GdipSetInfinite(GpRegion *region) */
        GdipSetInfinite: fn(4, onRegion(region=>{
            region.node = infinite();
            return Ok;
        })),
        /** Status GdipSetEmpty(GpRegion *region) */
        GdipSetEmpty: fn(4, onRegion(region=>{
            region.node = { type: 'empty' };
            return Ok;
        })),
        /** Status GdipCombineRegionRect(GpRegion *region, const GpRectF *rect, CombineMode mode) */
        GdipCombineRegionRect: fn(12, onRegion((region, [rect, mode])=>((rect >>> 0) === 0
            ? InvalidParameter : combineInto(region, rectNode(kit.f32s(rect, 4)), mode)))),
        /** Status GdipCombineRegionRectI(GpRegion *region, const GpRect *rect, CombineMode mode) */
        GdipCombineRegionRectI: fn(12, onRegion((region, [rect, mode])=>((rect >>> 0) === 0
            ? InvalidParameter : combineInto(region, rectNode(rectI(rect)), mode)))),
        /** Status GdipCombineRegionPath(GpRegion *region, GpPath *path, CombineMode mode) */
        GdipCombineRegionPath: fn(12, onRegion((region, [at, mode])=>{
            const path = paths.get(at);
            return path ? combineInto(region, pathNode(path), mode) : InvalidParameter;
        })),
        /** Status GdipCombineRegionRegion(GpRegion *region, GpRegion *other, CombineMode mode) */
        GdipCombineRegionRegion: fn(12, onRegion((region, [at, mode])=>{
            const other = get(at);
            return other ? combineInto(region, other.node, mode) : InvalidParameter;
        })),
        /** Status GdipTranslateRegion(GpRegion *region, REAL dx, REAL dy) */
        GdipTranslateRegion: fn(12, onRegion((region, [dx, dy])=>{
            region.node = transformNode(region.node, [1, 0, 0, 1, kit.real(dx), kit.real(dy)]);
            return Ok;
        }), { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipTranslateRegionI(GpRegion *region, INT dx, INT dy) */
        GdipTranslateRegionI: fn(12, onRegion((region, [dx, dy])=>{
            region.node = transformNode(region.node, [1, 0, 0, 1, dx | 0, dy | 0]);
            return Ok;
        })),
        /** Status GdipTransformRegion(GpRegion *region, GpMatrix *matrix) */
        GdipTransformRegion: fn(8, onRegion((region, [matrix])=>{
            const m = matrices.elements(matrix);
            if (!m)
            {
                return InvalidParameter;
            }
            region.node = transformNode(region.node, m);
            return Ok;
        })),
        /**
         * Status GdipGetRegionBounds(GpRegion *region, GpGraphics *graphics, GpRectF *rect)
         *
         * In the region's own coordinates: the graphics' transforms do not apply.
         */
        GdipGetRegionBounds: fn(12, onRegion((region, [graphics, out])=>{
            if (!isGraphics(graphics) || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32s(out, boundsOfNode(region.node) ?? [0, 0, 0, 0]);
            return Ok;
        })),
        /** Status GdipGetRegionBoundsI(GpRegion *region, GpGraphics *graphics, GpRect *rect) */
        GdipGetRegionBoundsI: fn(12, onRegion((region, [graphics, out])=>{
            if (!isGraphics(graphics) || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const [x, y, w, h] = boundsOfNode(region.node) ?? [0, 0, 0, 0];
            const left = Math.floor(x);
            const top = Math.floor(y);
            kit.putI32s(out, [left, top, Math.ceil(x + w) - left, Math.ceil(y + h) - top]);
            return Ok;
        })),
        /** Status GdipGetRegionHRgn(GpRegion *region, GpGraphics *graphics, HRGN *hrgn) */
        GdipGetRegionHRgn: fn(12, onRegion((region, [, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const hrgn = toHrgn(region.node);
            if (hrgn < 0)
            {
                return GenericError;
            }
            kit.putU32(out, hrgn);
            return Ok;
        })),
        /** Status GdipIsEmptyRegion(GpRegion *region, GpGraphics *graphics, BOOL *result) */
        GdipIsEmptyRegion: fn(12, onRegion((region, [graphics, out])=>{
            if (!isGraphics(graphics) || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, areaOf(region.node).length === 0);
            return Ok;
        })),
        /** Status GdipIsInfiniteRegion(GpRegion *region, GpGraphics *graphics, BOOL *result) */
        GdipIsInfiniteRegion: fn(12, onRegion((region, [graphics, out])=>{
            if (!isGraphics(graphics) || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, areasEqual(areaOf(region.node), areaOf(infinite())));
            return Ok;
        })),
        /**
         * Status GdipIsEqualRegion(GpRegion *region, GpRegion *other, GpGraphics *graphics,
         *   BOOL *result): the same pixels.
         */
        GdipIsEqualRegion: fn(16, onRegion((region, [at, graphics, out])=>{
            const other = get(at);
            if (!other || !isGraphics(graphics) || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, areasEqual(areaOf(region.node), areaOf(other.node)));
            return Ok;
        })),
        /**
         * Status GdipIsVisibleRegionPoint(GpRegion *region, REAL x, REAL y,
         *   GpGraphics *graphics, BOOL *result)
         */
        GdipIsVisibleRegionPoint: fn(20, onRegion((region, [x, y, , out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, contains(region.node, kit.real(x), kit.real(y)));
            return Ok;
        }), { floats: { 1: 'f32', 2: 'f32' } }),
        /**
         * Status GdipIsVisibleRegionPointI(GpRegion *region, INT x, INT y, GpGraphics *, BOOL *)
         */
        GdipIsVisibleRegionPointI: fn(20, onRegion((region, [x, y, , out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, contains(region.node, x | 0, y | 0));
            return Ok;
        })),
        /**
         * Status GdipIsVisibleRegionRect(GpRegion *region, REAL x, REAL y, REAL width,
         *   REAL height, GpGraphics *graphics, BOOL *result): whether any pixel of
         *   the rectangle is the region's.
         */
        GdipIsVisibleRegionRect: fn(28, onRegion((region, [x, y, w, h, , out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const rect = rectNode([x, y, w, h].map(kit.real));
            kit.putBool(out, (combineAreas(areaOf(region.node), areaOf(rect), RGN_AND) ?? [])
                .length > 0);
            return Ok;
        }), { floats: { 1: 'f32', 2: 'f32', 3: 'f32' } }),
        /** Status GdipIsVisibleRegionRectI(GpRegion *region, INT x, INT y, INT w, INT h, ...) */
        GdipIsVisibleRegionRectI: fn(28, onRegion((region, [x, y, w, h, , out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const rect = rectNode([x, y, w, h].map(v=>v | 0));
            kit.putBool(out, (combineAreas(areaOf(region.node), areaOf(rect), RGN_AND) ?? [])
                .length > 0);
            return Ok;
        })),
        /** Status GdipGetRegionDataSize(GpRegion *region, UINT *size) */
        GdipGetRegionDataSize: fn(8, onRegion((region, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putU32(out, regionData(region.node).length);
            return Ok;
        })),
        /**
         * Status GdipGetRegionData(GpRegion *region, BYTE *buffer, UINT size, UINT *needed)
         *
         * A buffer short of the data is InsufficientBuffer, the size it would need left out.
         */
        GdipGetRegionData: fn(16, onRegion((region, [buffer, size, needed])=>{
            if ((buffer >>> 0) === 0 || (size >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const data = regionData(region.node);
            if ((size >>> 0) < data.length)
            {
                if ((needed >>> 0) !== 0)
                {
                    kit.putU32(needed, size >>> 0);
                }
                return InsufficientBuffer;
            }
            kit.write(buffer, data);
            if ((needed >>> 0) !== 0)
            {
                kit.putU32(needed, data.length);
            }
            return Ok;
        })),
        /** Status GdipGetRegionScansCount(GpRegion *region, UINT *count, GpMatrix *matrix) */
        GdipGetRegionScansCount: fn(12, onRegion((region, [out, matrix])=>{
            if ((out >>> 0) === 0 || ((matrix >>> 0) !== 0 && !matrices.elements(matrix)))
            {
                return InvalidParameter;
            }
            kit.putU32(out, scansOf(region.node, matrix).length);
            return Ok;
        })),
        /** Status GdipGetRegionScans(GpRegion *region, GpRectF *rects, INT *count, GpMatrix *) */
        GdipGetRegionScans: fn(16, onRegion((region, [rects, count, matrix])=>{
            if ((count >>> 0) === 0 || ((matrix >>> 0) !== 0 && !matrices.elements(matrix)))
            {
                return InvalidParameter;
            }
            const scans = scansOf(region.node, matrix);
            if ((rects >>> 0) !== 0)
            {
                kit.putF32s(rects, scans.flatMap(r=>[r.left, r.top, r.right - r.left,
                    r.bottom - r.top]));
            }
            kit.putI32(count, scans.length);
            return Ok;
        })),
        /** Status GdipGetRegionScansI(GpRegion *region, GpRect *rects, INT *count, GpMatrix *) */
        GdipGetRegionScansI: fn(16, onRegion((region, [rects, count, matrix])=>{
            if ((count >>> 0) === 0 || ((matrix >>> 0) !== 0 && !matrices.elements(matrix)))
            {
                return InvalidParameter;
            }
            const scans = scansOf(region.node, matrix);
            if ((rects >>> 0) !== 0)
            {
                kit.putI32s(rects, scans.flatMap(r=>[r.left, r.top, r.right - r.left,
                    r.bottom - r.top]));
            }
            kit.putI32(count, scans.length);
            return Ok;
        })),
    };
    return {
        functions,
        /** @param {number} at @returns {Node | undefined} */
        node: at=>get(at)?.node,
        /** @param {Node} node @returns {number} its handle */
        add: node=>kit.add('region', { node }),
        /** @param {number} at @param {Node} node */
        set: (at, node)=>{
            const region = get(at);
            if (region)
            {
                region.node = node;
            }
            return Boolean(region);
        },
        toHrgn,
        hrgnRects,
    };
}
