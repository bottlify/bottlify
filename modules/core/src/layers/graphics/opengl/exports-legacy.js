/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The marshalling of `context-legacy.js`'s entry points: the polygon
 * stipple, pixel transfer and the pixel maps, the evaluators, their 4.5
 * getters bounded by the caller's size, and the imaging subset's getters.
 *
 * The same rules as `exports.js`. A pixel call's pointer goes to the context
 * as it is, since with a pixel buffer bound it is an offset the context
 * resolves; an evaluator's control points are read here, point by point at
 * the caller's stride, so a stride far larger than a point reads only the
 * points.
 */

import { mapComponents } from './legacy-state.js';

/**
 * What `exports.js` lends.
 *
 * @typedef {Object} LegacyHelpers
 * @property {() => any} current
 * @property {(result: any) => number} answer
 * @property {(type: string, address: number, count: number) => number[]} readTyped
 */

/** The most of one order whose control points are read: a larger one is refused anyway. */
const ORDER_READ_LIMIT = 64;

const bits = new DataView(new ArrayBuffer(8));
/** @param {number} word */
const asFloat = word=>{
    bits.setUint32(0, word >>> 0, true);
    return bits.getFloat32(0, true);
};
/** @param {number} low @param {number} high */
const asDouble = (low, high)=>{
    bits.setUint32(0, low >>> 0, true);
    bits.setUint32(4, high >>> 0, true);
    return bits.getFloat64(0, true);
};

/**
 * @param {LegacyHelpers} h
 * @returns {Record<string, (args: number[]) => number>}
 */
export function legacyEntryPoints(h){
    const { current, answer, readTyped } = h;

    /**
     * A map's control points packed, `orders` of them (u outer), each the
     * target's components read at `strides` apart; null for a null pointer,
     * empty for a target or an order a map cannot have.
     *
     * @param {number} target @param {number} address @param {'f' | 'd'} type
     * @param {number[]} orders @param {number[]} strides
     * @returns {number[] | null}
     */
    const controlPoints = (target, address, type, orders, strides)=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        const k = mapComponents(target >>> 0);
        if (k === 0 || orders.some(order=>order < 1 || order > ORDER_READ_LIMIT)
            || strides.some(stride=>stride < k))
        {
            return [];
        }
        const size = type === 'd' ? 8 : 4;
        const [uOrder, vOrder = 1] = orders;
        const [uStride, vStride = 0] = strides;
        /** @type {number[]} */
        const points = [];
        for (let i = 0; i < uOrder; i++)
        {
            for (let j = 0; j < vOrder; j++)
            {
                points.push(...readTyped(type,
                    (address >>> 0) + (i * uStride + j * vStride) * size, k));
            }
        }
        return points;
    };

    /** @param {'f' | 'ui' | 'us'} type */
    const pixelMap = type=>(/** @type {number[]} */ [map, size, values])=>answer(
        current()?.glPixelMapfv(map >>> 0, size | 0, values >>> 0, type));
    /** @param {'f' | 'ui' | 'us'} type */
    const getPixelMap = type=>(/** @type {number[]} */ [map, values])=>answer(
        current()?.glGetPixelMapfv(map >>> 0, values >>> 0, type, null));
    /** @param {'f' | 'ui' | 'us'} type */
    const getnPixelMap = type=>(/** @type {number[]} */ [map, size, values])=>answer(
        current()?.glGetPixelMapfv(map >>> 0, values >>> 0, type, size | 0));
    /** @param {'f' | 'd' | 'i'} type */
    const getMap = type=>(/** @type {number[]} */ [target, query, values])=>answer(
        current()?.glGetMapfv(target >>> 0, query >>> 0, type, values >>> 0, null));
    /** @param {'f' | 'd' | 'i'} type */
    const getnMap = type=>(/** @type {number[]} */ [target, query, size, values])=>answer(
        current()?.glGetMapfv(target >>> 0, query >>> 0, type, values >>> 0, size | 0));
    const imaging = ()=>answer(current()?.glGetImagingTable());

    return {
        // --- the polygon stipple ---

        glPolygonStipple: ([mask])=>answer(current()?.glPolygonStipple(mask >>> 0)),
        glGetPolygonStipple: ([mask])=>answer(current()?.glGetPolygonStipple(mask >>> 0, null)),
        glGetnPolygonStipple: ([size, mask])=>answer(
            current()?.glGetPolygonStipple(mask >>> 0, size | 0)),

        // --- pixel transfer and the pixel maps ---

        glPixelTransferf: ([pname, value])=>answer(
            current()?.glPixelTransferf(pname >>> 0, asFloat(value))),
        glPixelTransferi: ([pname, value])=>answer(
            current()?.glPixelTransferf(pname >>> 0, value | 0)),
        glPixelMapfv: pixelMap('f'),
        glPixelMapuiv: pixelMap('ui'),
        glPixelMapusv: pixelMap('us'),
        glGetPixelMapfv: getPixelMap('f'),
        glGetPixelMapuiv: getPixelMap('ui'),
        glGetPixelMapusv: getPixelMap('us'),
        glGetnPixelMapfv: getnPixelMap('f'),
        glGetnPixelMapuiv: getnPixelMap('ui'),
        glGetnPixelMapusv: getnPixelMap('us'),

        // --- the evaluators ---

        glMap1f: ([target, u1, u2, stride, order, points])=>answer(current()?.glMap1f(
            target >>> 0, asFloat(u1), asFloat(u2), stride | 0, order | 0,
            controlPoints(target, points, 'f', [order | 0], [stride | 0]))),
        glMap1d: a=>answer(current()?.glMap1f(a[0] >>> 0, asDouble(a[1], a[2]),
            asDouble(a[3], a[4]), a[5] | 0, a[6] | 0,
            controlPoints(a[0], a[7], 'd', [a[6] | 0], [a[5] | 0]))),
        glMap2f: a=>answer(current()?.glMap2f(a[0] >>> 0, asFloat(a[1]), asFloat(a[2]),
            a[3] | 0, a[4] | 0, asFloat(a[5]), asFloat(a[6]), a[7] | 0, a[8] | 0,
            controlPoints(a[0], a[9], 'f', [a[4] | 0, a[8] | 0], [a[3] | 0, a[7] | 0]))),
        glMap2d: a=>answer(current()?.glMap2f(a[0] >>> 0, asDouble(a[1], a[2]),
            asDouble(a[3], a[4]), a[5] | 0, a[6] | 0, asDouble(a[7], a[8]),
            asDouble(a[9], a[10]), a[11] | 0, a[12] | 0,
            controlPoints(a[0], a[13], 'd', [a[6] | 0, a[12] | 0], [a[5] | 0, a[11] | 0]))),
        glGetMapfv: getMap('f'),
        glGetMapdv: getMap('d'),
        glGetMapiv: getMap('i'),
        glGetnMapfv: getnMap('f'),
        glGetnMapdv: getnMap('d'),
        glGetnMapiv: getnMap('i'),
        glMapGrid1f: ([n, u1, u2])=>answer(current()?.glMapGrid1f(n | 0, asFloat(u1),
            asFloat(u2))),
        glMapGrid1d: a=>answer(current()?.glMapGrid1f(a[0] | 0, asDouble(a[1], a[2]),
            asDouble(a[3], a[4]))),
        glMapGrid2f: a=>answer(current()?.glMapGrid2f(a[0] | 0, asFloat(a[1]), asFloat(a[2]),
            a[3] | 0, asFloat(a[4]), asFloat(a[5]))),
        glMapGrid2d: a=>answer(current()?.glMapGrid2f(a[0] | 0, asDouble(a[1], a[2]),
            asDouble(a[3], a[4]), a[5] | 0, asDouble(a[6], a[7]), asDouble(a[8], a[9]))),
        glEvalCoord1f: ([u])=>answer(current()?.glEvalCoord1f(asFloat(u))),
        glEvalCoord1d: ([low, high])=>answer(current()?.glEvalCoord1f(asDouble(low, high))),
        glEvalCoord1fv: ([u])=>answer(current()?.glEvalCoord1f(readTyped('f', u, 1)[0])),
        glEvalCoord1dv: ([u])=>answer(current()?.glEvalCoord1f(readTyped('d', u, 1)[0])),
        glEvalCoord2f: ([u, v])=>answer(current()?.glEvalCoord2f(asFloat(u), asFloat(v))),
        glEvalCoord2d: a=>answer(current()?.glEvalCoord2f(asDouble(a[0], a[1]),
            asDouble(a[2], a[3]))),
        glEvalCoord2fv: ([uv])=>answer(current()?.glEvalCoord2f(...readTyped('f', uv, 2))),
        glEvalCoord2dv: ([uv])=>answer(current()?.glEvalCoord2f(...readTyped('d', uv, 2))),
        glEvalPoint1: ([i])=>answer(current()?.glEvalPoint1(i | 0)),
        glEvalPoint2: ([i, j])=>answer(current()?.glEvalPoint2(i | 0, j | 0)),
        glEvalMesh1: ([mode, i1, i2])=>answer(current()?.glEvalMesh1(mode >>> 0, i1 | 0,
            i2 | 0)),
        glEvalMesh2: ([mode, i1, i2, j1, j2])=>answer(current()?.glEvalMesh2(mode >>> 0,
            i1 | 0, i2 | 0, j1 | 0, j2 | 0)),

        // --- the imaging subset's getters ---

        // Its 1.2 forms are obtainable only with GL_ARB_imaging, which is
        // not reported; 4.5's are, and refuse every target.
        glGetnColorTable: imaging,
        glGetnConvolutionFilter: imaging,
        glGetnSeparableFilter: imaging,
        glGetnHistogram: imaging,
        glGetnMinmax: imaging,
    };
}
