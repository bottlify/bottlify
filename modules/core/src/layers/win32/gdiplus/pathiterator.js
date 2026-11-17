/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s path iterators: a copy of a path's points and types taken when the
 * iterator is made, walked a figure (subpath) at a time, a run of one
 * segment type at a time within the figure reached, or a marked section at
 * a time. Each walk answers how many points it covered, and 0 once there
 * is nothing left - a run of no segment type is 255, as GDI+ reports it.
 */

import { Status, fn } from './kit.js';
import {
    PathPointTypeBezier, PathPointTypeCloseSubpath, PathPointTypePathMarker,
    PathPointTypePathTypeMask, PathPointTypeStart, clonePath, emptyPath,
} from './path.js';

/** The type a run of no segment reports. */
const NO_TYPE = 255;

/**
 * @typedef {Object} Iterator
 * @property {import('./path.js').Path} path
 * @property {number} subpath  where the next figure starts
 * @property {number} figureStart @property {number} figureEnd  the figure reached, -1 for none
 * @property {number} type  where the next run within it starts
 * @property {number} marker  where the next marked section starts
 */

/**
 * @param {import('./kit.js').Kit} kit
 * @param {{ get: (at: number) => (import('./path.js').Path | undefined) }} paths
 */
export function createPathIteratorFunctions(kit, paths){
    const { InvalidParameter, Ok } = Status;
    /** @param {number} at @returns {Iterator | undefined} */
    const get = at=>kit.get(at, 'iterator');
    /**
     * @param {(iterator: Iterator, args: number[]) => number} body
     * @returns {(args: number[]) => number}
     */
    const onIterator = body=>([at, ...rest])=>{
        const iterator = get(at);
        return iterator ? body(iterator, rest) : InvalidParameter;
    };
    /** @param {Iterator} it @param {number} at */
    const isStart = (it, at)=>
        (it.path.types[at] & PathPointTypePathTypeMask) === PathPointTypeStart;

    /**
     * The next figure: its first and last point and whether it is closed;
     * null once there is none. It becomes the figure runs are walked in.
     *
     * @param {Iterator} it
     */
    const nextFigure = it=>{
        const count = it.path.points.length;
        if (it.subpath >= count)
        {
            it.figureStart = -1;
            return null;
        }
        const start = it.subpath;
        let end = start + 1;
        while (end < count && !isStart(it, end))
        {
            end++;
        }
        it.subpath = end;
        it.figureStart = start;
        it.figureEnd = end - 1;
        it.type = start;
        const closed = (it.path.types[end - 1] & PathPointTypeCloseSubpath) !== 0;
        return { start, end: end - 1, closed };
    };

    /**
     * The figure's points, from `start` to `end`, as a path of their own.
     *
     * @param {Iterator} it @param {number} start @param {number} end
     * @returns {import('./path.js').Path}
     */
    const slice = (it, start, end)=>{
        const part = clonePath(it.path);
        part.points = part.points.slice(start, end + 1);
        part.types = part.types.slice(start, end + 1);
        if (part.types.length > 0)
        {
            part.types[0] = part.types[0] & ~PathPointTypePathTypeMask | PathPointTypeStart;
        }
        part.open = part.types.length > 0
            && (part.types[part.types.length - 1] & PathPointTypeCloseSubpath) === 0;
        return part;
    };

    /** The next marked section: [start, end], null once there is none. @param {Iterator} it */
    const nextMarker = it=>{
        const count = it.path.points.length;
        if (it.marker >= count)
        {
            return null;
        }
        const start = it.marker;
        let end = start;
        while (end < count - 1 && (it.path.types[end] & PathPointTypePathMarker) === 0)
        {
            end++;
        }
        it.marker = end + 1;
        return { start, end };
    };

    const functions = {
        /** Status GdipCreatePathIter(GpPathIterator **iterator, GpPath *path): a copy of the path. */
        GdipCreatePathIter: fn(8, ([out, at])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const path = (at >>> 0) === 0 ? emptyPath() : paths.get(at);
            if (!path)
            {
                return InvalidParameter;
            }
            kit.add('iterator', /** @type {Iterator} */ ({ path: clonePath(path), subpath: 0,
                figureStart: -1, figureEnd: -1, type: 0, marker: 0 }), out);
            return Ok;
        }),
        /** Status GdipDeletePathIter(GpPathIterator *iterator) */
        GdipDeletePathIter: fn(4, ([at])=>(kit.remove(at, 'iterator') ? Ok : InvalidParameter)),
        /** Status GdipPathIterGetCount(GpPathIterator *iterator, INT *count) */
        GdipPathIterGetCount: fn(8, onIterator((it, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, it.path.points.length);
            return Ok;
        })),
        /** Status GdipPathIterGetSubpathCount(GpPathIterator *iterator, INT *count) */
        GdipPathIterGetSubpathCount: fn(8, onIterator((it, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(out, it.path.types.filter((_, at)=>isStart(it, at)).length);
            return Ok;
        })),
        /** Status GdipPathIterHasCurve(GpPathIterator *iterator, BOOL *hasCurve) */
        GdipPathIterHasCurve: fn(8, onIterator((it, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, it.path.types.some(type=>
                (type & PathPointTypePathTypeMask) === PathPointTypeBezier));
            return Ok;
        })),
        /** Status GdipPathIterIsValid(GpPathIterator *iterator, BOOL *valid) */
        GdipPathIterIsValid: fn(8, onIterator((_it, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, true);
            return Ok;
        })),
        /** Status GdipPathIterRewind(GpPathIterator *iterator) */
        GdipPathIterRewind: fn(4, onIterator(it=>{
            Object.assign(it, { subpath: 0, figureStart: -1, figureEnd: -1, type: 0, marker: 0 });
            return Ok;
        })),
        /**
         * Status GdipPathIterNextSubpath(GpPathIterator *iterator, INT *count, INT *start,
         *   INT *end, BOOL *closed)
         */
        GdipPathIterNextSubpath: fn(20, onIterator((it, [count, start, end, closed])=>{
            if ([count, start, end, closed].some(at=>(at >>> 0) === 0))
            {
                return InvalidParameter;
            }
            if (it.path.points.length === 0)
            {
                kit.putI32(count, 0);
                return Ok;
            }
            const figure = nextFigure(it);
            kit.putI32(count, figure ? figure.end - figure.start + 1 : 0);
            kit.putI32(start, figure?.start ?? 0);
            kit.putI32(end, figure?.end ?? 0);
            kit.putBool(closed, figure ? figure.closed : true);
            return Ok;
        })),
        /**
         * Status GdipPathIterNextSubpathPath(GpPathIterator *iterator, INT *count,
         *   GpPath *path, BOOL *closed)
         */
        GdipPathIterNextSubpathPath: fn(16, onIterator((it, [count, at, closed])=>{
            if ((count >>> 0) === 0 || (closed >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const target = (at >>> 0) === 0 ? null : paths.get(at);
            if ((at >>> 0) !== 0 && !target)
            {
                return InvalidParameter;
            }
            const figure = nextFigure(it);
            kit.putI32(count, figure ? figure.end - figure.start + 1 : 0);
            kit.putBool(closed, figure ? figure.closed : true);
            if (figure && target)
            {
                Object.assign(target, slice(it, figure.start, figure.end));
            }
            return Ok;
        })),
        /**
         * Status GdipPathIterNextPathType(GpPathIterator *iterator, INT *count, BYTE *type,
         *   INT *start, INT *end)
         *
         * The next run of one segment type in the figure reached, from the
         * point it starts at; 0 and 255 with no figure or nothing left in it.
         */
        GdipPathIterNextPathType: fn(20, onIterator((it, [count, type, start, end])=>{
            if ([count, type, start, end].some(at=>(at >>> 0) === 0))
            {
                return InvalidParameter;
            }
            const none = ()=>{
                kit.putI32(count, 0);
                kit.write(type, Uint8Array.of(NO_TYPE));
                return Ok;
            };
            if (it.figureStart < 0 || it.type > it.figureEnd
                || (it.type === it.figureEnd && it.type !== it.figureStart))
            {
                return none();
            }
            const from = it.type;
            if (from === it.figureEnd)
            {
                // A figure of one point: no segment, its point alone.
                it.type = from + 1;
                kit.putI32(count, 1);
                kit.write(type, Uint8Array.of(NO_TYPE));
                kit.putI32(start, from);
                kit.putI32(end, from);
                return Ok;
            }
            const kind = it.path.types[from + 1] & PathPointTypePathTypeMask;
            let to = from + 1;
            while (to < it.figureEnd
                && (it.path.types[to + 1] & PathPointTypePathTypeMask) === kind)
            {
                to++;
            }
            it.type = to;
            kit.putI32(count, to - from + 1);
            kit.write(type, Uint8Array.of(kind));
            kit.putI32(start, from);
            kit.putI32(end, to);
            return Ok;
        })),
        /** Status GdipPathIterNextMarker(GpPathIterator *iterator, INT *count, INT *start, INT *end) */
        GdipPathIterNextMarker: fn(16, onIterator((it, [count, start, end])=>{
            if ([count, start, end].some(at=>(at >>> 0) === 0))
            {
                return InvalidParameter;
            }
            const section = nextMarker(it);
            kit.putI32(count, section ? section.end - section.start + 1 : 0);
            if (section)
            {
                kit.putI32(start, section.start);
                kit.putI32(end, section.end);
            }
            return Ok;
        })),
        /** Status GdipPathIterNextMarkerPath(GpPathIterator *iterator, INT *count, GpPath *path) */
        GdipPathIterNextMarkerPath: fn(12, onIterator((it, [count, at])=>{
            const target = (at >>> 0) === 0 ? null : paths.get(at);
            if ((count >>> 0) === 0 || ((at >>> 0) !== 0 && !target))
            {
                return InvalidParameter;
            }
            const section = nextMarker(it);
            kit.putI32(count, section ? section.end - section.start + 1 : 0);
            if (section && target)
            {
                Object.assign(target, slice(it, section.start, section.end));
            }
            return Ok;
        })),
        /**
         * Status GdipPathIterEnumerate(GpPathIterator *iterator, INT *count, GpPointF *points,
         *   BYTE *types, INT room)
         */
        GdipPathIterEnumerate: fn(20, onIterator((it, [count, points, types, room])=>{
            if ((count >>> 0) === 0 || (points >>> 0) === 0 || (types >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const n = Math.max(0, Math.min(room | 0, it.path.points.length));
            kit.putPoints(points, it.path.points.slice(0, n));
            kit.write(types, Uint8Array.from(it.path.types.slice(0, n)));
            kit.putI32(count, n);
            return Ok;
        })),
        /**
         * Status GdipPathIterCopyData(GpPathIterator *iterator, INT *count, GpPointF *points,
         *   BYTE *types, INT start, INT end)
         */
        GdipPathIterCopyData: fn(24, onIterator((it, [count, points, types, start, end])=>{
            if ((count >>> 0) === 0 || (points >>> 0) === 0 || (types >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const first = start | 0;
            const last = end | 0;
            if (first < 0 || last >= it.path.points.length || first > last)
            {
                kit.putI32(count, 0);
                return Ok;
            }
            kit.putPoints(points, it.path.points.slice(first, last + 1));
            kit.write(types, Uint8Array.from(it.path.types.slice(first, last + 1)));
            kit.putI32(count, last - first + 1);
            return Ok;
        })),
    };
    return { functions };
}
