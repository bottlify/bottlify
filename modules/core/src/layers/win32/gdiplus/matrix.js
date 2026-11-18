/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s matrices: the affine transform [m11 m12 m21 m22 dx dy] a point
 * (x, y) goes through as (x m11 + y m21 + dx, x m12 + y m22 + dy). Each
 * operation is prepended - done to a point before what the matrix already
 * does - or appended, after it (MatrixOrder). Its elements are REALs, as
 * GDI+ keeps them: each result is rounded to single precision.
 *
 * The arithmetic is exported for the other families (a graphics' world
 * transform, a path's Transform, a brush's) - one transform everywhere.
 */

import { Status, fn } from './kit.js';

/** @typedef {[number, number, number, number, number, number]} Elements */

export const IDENTITY = /** @type {Elements} */ (Object.freeze([1, 0, 0, 1, 0, 0]));

/** MatrixOrder. */
export const MatrixOrderPrepend = 0;
export const MatrixOrderAppend = 1;

/** @param {number[]} values @returns {Elements} */
const single = values=>/** @type {Elements} */ (values.map(value=>Math.fround(value)));

/**
 * `first` then `second`: the matrix of a point taken through `first` and
 * then `second`.
 *
 * @param {Elements} first @param {Elements} second
 * @returns {Elements}
 */
export const multiply = (first, second)=>{
    const [a, b, c, d, e, f] = first;
    const [g, h, i, j, k, l] = second;
    return single([a * g + b * i, a * h + b * j, c * g + d * i, c * h + d * j,
        e * g + f * i + k, e * h + f * j + l]);
};

/**
 * `matrix` with `other` done before it (Prepend) or after it (Append).
 *
 * @param {Elements} matrix @param {Elements} other @param {number} order
 */
export const combine = (matrix, other, order)=>(order === MatrixOrderAppend
    ? multiply(matrix, other) : multiply(other, matrix));

/**
 * A point through the matrix.
 *
 * @param {Elements} m @param {[number, number]} point @returns {[number, number]}
 */
export const apply = (m, [x, y])=>[Math.fround(x * m[0] + y * m[2] + m[4]),
    Math.fround(x * m[1] + y * m[3] + m[5])];

/**
 * The matrix's inverse, or null when its determinant is zero.
 *
 * @param {Elements} m @returns {Elements | null}
 */
export const invert = m=>{
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (det === 0 || !Number.isFinite(det))
    {
        return null;
    }
    return single([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det,
        (b * e - a * f) / det]);
};

/** @param {Elements} m */
export const isIdentity = m=>m.every((value, at)=>value === IDENTITY[at]);

/** A rotation by `degrees`, counter-clockwise in a y-up sense (GDI+'s). @param {number} degrees */
export const rotation = degrees=>{
    const radians = degrees * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return single([cos, sin, -sin, cos, 0, 0]);
};

/**
 * The matrices the other families keep, made and read through these
 * exports; `matrices.elements(handle)` hands one's elements to them.
 *
 * @param {import('./kit.js').Kit} kit
 */
export function createMatrixFunctions(kit){
    const { InvalidParameter, Ok, OutOfMemory } = Status;
    /** @param {number} at @returns {{ m: Elements } | undefined} */
    const get = at=>kit.get(at, 'matrix');
    /** @param {Elements} m @param {number} out */
    const make = (m, out)=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        kit.add('matrix', { m: single(m) }, out);
        return Ok;
    };
    /**
     * The matrix taking `rect` onto the parallelogram whose top-left,
     * top-right and bottom-left corners are `points`.
     *
     * @param {number[]} rect @param {[number, number][]} points @returns {Elements | null}
     */
    const toParallelogram = ([x, y, width, height], [p0, p1, p2])=>{
        if (width === 0 || height === 0)
        {
            return null;
        }
        const m11 = (p1[0] - p0[0]) / width;
        const m12 = (p1[1] - p0[1]) / width;
        const m21 = (p2[0] - p0[0]) / height;
        const m22 = (p2[1] - p0[1]) / height;
        return [m11, m12, m21, m22, p0[0] - m11 * x - m21 * y, p0[1] - m12 * x - m22 * y];
    };
    /**
     * Points transformed in place, REALs or INTs; `vector` leaves out the translation.
     *
     * @param {number} matrix @param {number} points @param {number} count
     * @param {boolean} integers @param {boolean} vector
     */
    const transformPoints = (matrix, points, count, integers, vector)=>{
        const held = get(matrix);
        if (!held || (points >>> 0) === 0 || (count | 0) <= 0)
        {
            return InvalidParameter;
        }
        const m = vector ? single([...held.m.slice(0, 4), 0, 0]) : held.m;
        kit.putPoints(points, kit.points(points, count | 0, integers).map(point=>apply(m, point)),
            integers);
        return Ok;
    };

    const functions = {
        /** Status GdipCreateMatrix(GpMatrix **matrix) */
        GdipCreateMatrix: fn(4, ([out])=>make([...IDENTITY], out)),
        /**
         * Status GdipCreateMatrix2(REAL m11, REAL m12, REAL m21, REAL m22, REAL dx, REAL dy,
         *     GpMatrix **matrix)
         */
        GdipCreateMatrix2: { floats: { 0: 'f32', 1: 'f32', 2: 'f32', 3: 'f32' },
            ...fn(28, ([a, b, c, d, e, f, out])=>
                make(/** @type {Elements} */ ([a, b, c, d, e, f].map(kit.real)), out)) },
        /** Status GdipCreateMatrix3(const GpRectF *rect, const GpPointF *pt, GpMatrix **matrix) */
        GdipCreateMatrix3: fn(12, ([rect, points, out])=>{
            if ((rect >>> 0) === 0 || (points >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const m = toParallelogram(kit.f32s(rect, 4), kit.points(points, 3));
            return m ? make(/** @type {Elements} */ (m), out) : OutOfMemory;
        }),
        /** Status GdipCreateMatrix3I(const GpRect *rect, const GpPoint *pt, GpMatrix **matrix) */
        GdipCreateMatrix3I: fn(12, ([rect, points, out])=>{
            if ((rect >>> 0) === 0 || (points >>> 0) === 0 || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const m = toParallelogram(kit.i32s(rect, 4), kit.points(points, 3, true));
            return m ? make(/** @type {Elements} */ (m), out) : OutOfMemory;
        }),
        /** Status GdipCloneMatrix(GpMatrix *matrix, GpMatrix **clone) */
        GdipCloneMatrix: fn(8, ([matrix, out])=>{
            const held = get(matrix);
            return held ? make([...held.m], out) : InvalidParameter;
        }),
        /** Status GdipDeleteMatrix(GpMatrix *matrix) */
        GdipDeleteMatrix: fn(4, ([matrix])=>(kit.remove(matrix, 'matrix') ? Ok : InvalidParameter)),
        /** Status GdipSetMatrixElements(GpMatrix *matrix, REAL m11 ... dy) */
        GdipSetMatrixElements: fn(28, ([matrix, ...values])=>{
            const held = get(matrix);
            if (!held)
            {
                return InvalidParameter;
            }
            held.m = single(values.slice(0, 6).map(kit.real));
            return Ok;
        }, { floats: { 1: 'f32' } }),
        /** Status GdipGetMatrixElements(const GpMatrix *matrix, REAL *out) */
        GdipGetMatrixElements: fn(8, ([matrix, out])=>{
            const held = get(matrix);
            if (!held || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32s(out, held.m);
            return Ok;
        }),
        /**
         * Status GdipMultiplyMatrix(GpMatrix *matrix, const GpMatrix *matrix2, GpMatrixOrder order)
         */
        GdipMultiplyMatrix: fn(12, ([matrix, other, order])=>{
            const held = get(matrix);
            const by = get(other);
            if (!held || !by || (order >>> 0) > MatrixOrderAppend)
            {
                return InvalidParameter;
            }
            held.m = combine(held.m, by.m, order >>> 0);
            return Ok;
        }),
        /** Status GdipTranslateMatrix(GpMatrix *matrix, REAL dx, REAL dy, GpMatrixOrder order) */
        GdipTranslateMatrix: fn(16, ([matrix, dx, dy, order])=>{
            const held = get(matrix);
            if (!held || (order >>> 0) > MatrixOrderAppend)
            {
                return InvalidParameter;
            }
            held.m = combine(held.m, [1, 0, 0, 1, kit.real(dx), kit.real(dy)], order >>> 0);
            return Ok;
        }, { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipScaleMatrix(GpMatrix *matrix, REAL sx, REAL sy, GpMatrixOrder order) */
        GdipScaleMatrix: fn(16, ([matrix, sx, sy, order])=>{
            const held = get(matrix);
            if (!held || (order >>> 0) > MatrixOrderAppend)
            {
                return InvalidParameter;
            }
            held.m = combine(held.m, [kit.real(sx), 0, 0, kit.real(sy), 0, 0], order >>> 0);
            return Ok;
        }, { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipRotateMatrix(GpMatrix *matrix, REAL angle, GpMatrixOrder order) */
        GdipRotateMatrix: fn(12, ([matrix, angle, order])=>{
            const held = get(matrix);
            if (!held || (order >>> 0) > MatrixOrderAppend)
            {
                return InvalidParameter;
            }
            held.m = combine(held.m, rotation(kit.real(angle)), order >>> 0);
            return Ok;
        }, { floats: { 1: 'f32' } }),
        /**
         * Status GdipShearMatrix(GpMatrix *matrix, REAL shearX, REAL shearY, GpMatrixOrder order)
         */
        GdipShearMatrix: fn(16, ([matrix, sx, sy, order])=>{
            const held = get(matrix);
            if (!held || (order >>> 0) > MatrixOrderAppend)
            {
                return InvalidParameter;
            }
            held.m = combine(held.m, [1, kit.real(sy), kit.real(sx), 1, 0, 0], order >>> 0);
            return Ok;
        }, { floats: { 1: 'f32', 2: 'f32' } }),
        /** Status GdipInvertMatrix(GpMatrix *matrix): InvalidParameter for one with no inverse. */
        GdipInvertMatrix: fn(4, ([matrix])=>{
            const held = get(matrix);
            const inverse = held ? invert(held.m) : null;
            if (!held || !inverse)
            {
                return InvalidParameter;
            }
            held.m = inverse;
            return Ok;
        }),
        /** Status GdipTransformMatrixPoints(GpMatrix *matrix, GpPointF *pts, INT count) */
        GdipTransformMatrixPoints: fn(12, ([matrix, points, count])=>
            transformPoints(matrix, points, count, false, false)),
        /** Status GdipTransformMatrixPointsI(GpMatrix *matrix, GpPoint *pts, INT count) */
        GdipTransformMatrixPointsI: fn(12, ([matrix, points, count])=>
            transformPoints(matrix, points, count, true, false)),
        /** Status GdipVectorTransformMatrixPoints(GpMatrix *matrix, GpPointF *pts, INT count) */
        GdipVectorTransformMatrixPoints: fn(12, ([matrix, points, count])=>
            transformPoints(matrix, points, count, false, true)),
        /** Status GdipVectorTransformMatrixPointsI(GpMatrix *matrix, GpPoint *pts, INT count) */
        GdipVectorTransformMatrixPointsI: fn(12, ([matrix, points, count])=>
            transformPoints(matrix, points, count, true, true)),
        /** Status GdipIsMatrixInvertible(const GpMatrix *matrix, BOOL *result) */
        GdipIsMatrixInvertible: fn(8, ([matrix, out])=>{
            const held = (out >>> 0) === 0 ? undefined : get(matrix);
            if (!held)
            {
                return InvalidParameter;
            }
            kit.putBool(out, invert(held.m) !== null);
            return Ok;
        }),
        /** Status GdipIsMatrixIdentity(const GpMatrix *matrix, BOOL *result) */
        GdipIsMatrixIdentity: fn(8, ([matrix, out])=>{
            const held = (out >>> 0) === 0 ? undefined : get(matrix);
            if (!held)
            {
                return InvalidParameter;
            }
            kit.putBool(out, isIdentity(held.m));
            return Ok;
        }),
        /** Status GdipIsMatrixEqual(const GpMatrix *a, const GpMatrix *b, BOOL *result) */
        GdipIsMatrixEqual: fn(12, ([first, second, out])=>{
            const a = get(first);
            const b = get(second);
            if (!a || !b || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, a.m.every((value, at)=>value === b.m[at]));
            return Ok;
        }),
    };
    return {
        functions,
        /**
         * A matrix handle's elements, for a family that takes a matrix; undefined
         * for a handle that is none.
         *
         * @param {number} at @returns {Elements | undefined}
         */
        elements: at=>get(at)?.m,
        /**
         * Sets a matrix handle's elements, for a family that hands one back.
         *
         * @param {number} at @param {Elements} m
         */
        set(at, m){
            const held = get(at);
            if (held)
            {
                held.m = single(m);
            }
            return held !== undefined;
        },
    };
}
