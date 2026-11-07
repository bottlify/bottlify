/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex attribute bindings (OpenGL 4.3 section 10.3.1,
 * GL_ARB_vertex_attrib_binding): an attribute's format apart from where its
 * elements come from. Each attribute reads through one of sixteen binding
 * points, which holds a buffer, an offset, a stride and a divisor; the
 * attribute adds its own relative offset.
 *
 * - **The pointer calls are this model's shorthand** (section 10.3.2):
 *   glVertexAttribPointer(i) is the format of attribute i at relative offset
 *   zero, attribute i on binding point i, and binding point i given the
 *   buffer, the pointer and the effective stride; glVertexAttribDivisor(i) is
 *   attribute i on binding point i and that point's divisor. An attribute
 *   another one shares a point with follows what the shorthand sets there.
 * - **Every draw path reads an attribute's own record** (`arrays.js`
 *   ArrayPointer): an attribute set through a binding point has the point's
 *   buffer, offset plus its relative offset, divisor and stride written into
 *   the record, the stride as `literalStride`, which is read as it is: a
 *   point's stride of zero reads one element for every vertex, where the
 *   pointer calls' zero means tightly packed. Until a binding call touches an
 *   attribute, its record is the pointer calls' alone and the point a copy.
 * - Every piece of it is vertex array object state, saved and restored with
 *   the arrays (`saveClientPrograms`), and a client attribute push saves it
 *   with GL_CLIENT_VERTEX_ARRAY_BIT.
 * - **A 64-bit attribute (glVertexAttribLFormat) is read at single
 *   precision**, as a double array of glVertexAttribPointer is: no shader
 *   here takes a double input. It says so.
 */

import { effectiveStride } from './arrays.js';
import { GL } from './constants.js';
import { createBufferObject } from './objects.js';
import { GENERIC_ATTRIBS } from './context-programs.js';

/** The binding points (GL_MAX_VERTEX_ATTRIB_BINDINGS, the specification's least). */
export const VERTEX_BINDINGS = 16;
/** GL_MAX_VERTEX_ATTRIB_RELATIVE_OFFSET, the least. */
export const MOST_RELATIVE_OFFSET = 2047;
/** GL_MAX_VERTEX_ATTRIB_STRIDE (4.4), the least, and WebGPU's most. */
export const MOST_STRIDE = 2048;

/**
 * The types each format call takes (section 10.3.1, table 10.3).
 *
 * @type {Readonly<Record<'float' | 'int' | 'long', ReadonlySet<number>>>}
 */
const FORMAT_TYPES = Object.freeze({
    float: new Set([GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT,
        GL.UNSIGNED_INT, GL.FLOAT, GL.DOUBLE, GL.INT_2_10_10_10_REV,
        GL.UNSIGNED_INT_2_10_10_10_REV, GL.FIXED, GL.HALF_FLOAT]),
    int: new Set([GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT,
        GL.UNSIGNED_INT]),
    long: new Set([GL.DOUBLE]),
});

/**
 * One attribute's place in the model: the point it reads through, its
 * offset there, whether it was given a 64-bit format, and whether a binding
 * call has made the point the source of its record; until one does, a
 * pointer call's record is the source, and its point a copy of it.
 *
 * @typedef {{ binding: number, relative: number, long: number, viaBinding: boolean }}
 *     AttribPlace
 */

/** @typedef {{ buffer: number, offset: number, stride: number, divisor: number }} BindingPoint */

/** @returns {AttribPlace[]} */
const initialPlaces = ()=>Array.from({ length: GENERIC_ATTRIBS },
    (_, index)=>({ binding: index, relative: 0, long: 0, viaBinding: false }));

/** @returns {BindingPoint[]} what table 23.5 gives a new vertex array object */
const initialPoints = ()=>Array.from({ length: VERTEX_BINDINGS },
    ()=>({ buffer: 0, offset: 0, stride: 16, divisor: 0 }));

/** The calls of this file a display list does not record: all are vertex array state. */
export const ATTRIB_BINDING_CALLS_NOT_COMPILED = Object.freeze([
    'vertexAttribFormat', 'glVertexAttribBinding', 'glBindVertexBuffer', 'glBindVertexBuffers',
    'glVertexBindingDivisor',
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installAttribBindingCalls(context, kernel){
    const { enter, setError, diverge } = kernel;

    let places = initialPlaces();
    let points = initialPoints();

    /**
     * The record an attribute's draws read: the conventional array an index
     * aliases, or the generic one.
     *
     * @param {number} index @returns {any}
     */
    const recordOf = index=>kernel.side.arrayAlias?.record(index)
        ?? kernel.side.programs.attribArrays[index];

    /**
     * An attribute's record from its point, or left to the pointer calls.
     *
     * @param {number} index
     */
    const resync = index=>{
        const place = places[index];
        const record = recordOf(index);
        if (!place.viaBinding)
        {
            record.literalStride = undefined;
            return;
        }
        const point = points[place.binding];
        record.pointer = point.offset + place.relative;
        record.buffer = point.buffer;
        record.literalStride = point.stride;
        record.divisor = point.divisor;
    };

    /** Every attribute reading through a point, after the point changed. @param {number} point */
    const resyncPoint = point=>{
        places.forEach((place, index)=>{
            if (place.binding === point)
            {
                resync(index);
            }
        });
    };

    const indexed = kernel.side.indexed ??= new Map();
    /** @param {(point: BindingPoint) => number} field */
    const pointQuery = field=>(/** @type {number} */ point)=>(point < VERTEX_BINDINGS
        ? { kind: 'int', values: [field(points[point])] } : null);
    indexed.set(GL.VERTEX_BINDING_BUFFER, pointQuery(point=>point.buffer));
    indexed.set(GL.VERTEX_BINDING_OFFSET, pointQuery(point=>point.offset));
    indexed.set(GL.VERTEX_BINDING_STRIDE, pointQuery(point=>point.stride));
    indexed.set(GL.VERTEX_BINDING_DIVISOR, pointQuery(point=>point.divisor));

    kernel.side.attribBinding = {
        /**
         * The pointer calls' shorthand: attribute `index` on its own point at
         * relative offset zero, the point the record's; the attributes that
         * share the point follow it.
         *
         * @param {number} index
         */
        fromPointer(index){
            places[index] = { binding: index, relative: 0, long: 0, viaBinding: false };
            const record = recordOf(index);
            record.literalStride = undefined;
            record.divisor = points[index].divisor;
            points[index] = { buffer: record.buffer, offset: record.pointer,
                stride: effectiveStride(record), divisor: points[index].divisor };
            resyncPoint(index);
        },

        /**
         * glVertexAttribDivisor's: attribute `index` on its own point, and the
         * point's divisor.
         *
         * @param {number} index @param {number} divisor
         */
        divisor(index, divisor){
            places[index].binding = index;
            points[index] = { ...points[index], divisor };
            recordOf(index).divisor = divisor;
            resyncPoint(index);
        },

        /** @param {number} index @returns {AttribPlace} */
        placeOf: index=>places[index],

        /** @returns {any} what a vertex array object keeps of the model */
        save: ()=>({ places: structuredClone(places), points: structuredClone(points) }),

        /** @param {any} saved */
        restore(saved){
            places = structuredClone(saved.places);
            points = structuredClone(saved.points);
            places.forEach((_, index)=>resync(index));
        },
    };

    /** @param {number} point @returns {boolean} a point there is, or GL_INVALID_VALUE */
    const knownPoint = point=>{
        if (!(point >= 0) || point >= VERTEX_BINDINGS)
        {
            setError(GL.INVALID_VALUE);
            return false;
        }
        return true;
    };

    /**
     * A buffer a point may hold: zero, an object, or a name glGenBuffers
     * gave, which becomes one as glBindBuffer would make it.
     *
     * @param {number} name @returns {boolean}
     */
    const bufferName = name=>{
        const buffers = kernel.shareGroup().buffers;
        if (name === 0 || buffers.objects.has(name))
        {
            return true;
        }
        if (buffers.reserved.has(name))
        {
            buffers.define(name, createBufferObject(name));
            kernel.shareGroup().used = true;
            return true;
        }
        return false;
    };

    /**
     * One point's buffer, offset and stride: the error, or zero once taken.
     *
     * @param {number} point @param {number} buffer @param {number} offset @param {number} stride
     * @returns {number}
     */
    const bindPoint = (point, buffer, offset, stride)=>{
        if (offset < 0 || stride < 0 || stride > MOST_STRIDE)
        {
            return GL.INVALID_VALUE;
        }
        if (!bufferName(buffer))
        {
            return GL.INVALID_OPERATION;
        }
        points[point] = { buffer, offset, stride, divisor: points[point].divisor };
        if (point < GENERIC_ATTRIBS && places[point].binding === point)
        {
            places[point].viaBinding = true;
        }
        resyncPoint(point);
        return 0;
    };

    Object.assign(context, {
        /**
         * glVertexAttribFormat, glVertexAttribIFormat and
         * glVertexAttribLFormat.
         *
         * @param {number} index @param {number} size @param {number} type
         * @param {number} normalised @param {number} relative
         * @param {'float' | 'int' | 'long'} kind
         */
        vertexAttribFormat(index, size, type, normalised, relative, kind){
            if (!enter('vertexAttribFormat', [index, size, type, normalised, relative, kind]))
            {
                return;
            }
            if (!(index >= 0) || index >= GENERIC_ATTRIBS || size < 1 || size > 4
                || relative < 0 || relative > MOST_RELATIVE_OFFSET)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!FORMAT_TYPES[kind].has(type))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if ((type === GL.INT_2_10_10_10_REV || type === GL.UNSIGNED_INT_2_10_10_10_REV)
                && size !== 4)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (kind === 'long')
            {
                diverge('a 64-bit vertex attribute (glVertexAttribLFormat) is read at single'
                    + ' precision');
            }
            const record = recordOf(index);
            record.size = size;
            record.type = type;
            record.normalised = kind === 'float' && normalised ? 1 : 0;
            record.integer = kind === 'int' ? 1 : 0;
            places[index] = { ...places[index], relative, long: kind === 'long' ? 1 : 0,
                viaBinding: true };
            resync(index);
        },

        /** @param {number} index @param {number} point */
        glVertexAttribBinding(index, point){
            if (!enter('glVertexAttribBinding', [index, point]))
            {
                return;
            }
            if (!(index >= 0) || index >= GENERIC_ATTRIBS)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!knownPoint(point))
            {
                return;
            }
            places[index] = { ...places[index], binding: point, viaBinding: true };
            resync(index);
        },

        /**
         * @param {number} point @param {number} buffer @param {number} offset
         * @param {number} stride
         */
        glBindVertexBuffer(point, buffer, offset, stride){
            if (!enter('glBindVertexBuffer', [point, buffer, offset, stride]) || !knownPoint(point))
            {
                return;
            }
            const error = bindPoint(point, buffer, offset, stride);
            if (error)
            {
                setError(error);
            }
        },

        /**
         * glBindVertexBuffers (4.4): `count` points from `first`; with no
         * buffers, every one to nothing. An entry refused raises its error
         * and the rest are still bound.
         *
         * @param {number} first @param {number} count
         * @param {readonly number[] | null} buffers @param {readonly number[]} offsets
         * @param {readonly number[]} strides
         */
        glBindVertexBuffers(first, count, buffers, offsets, strides){
            if (!enter('glBindVertexBuffers', [first, count, buffers, offsets, strides]))
            {
                return;
            }
            if (first < 0 || count < 0 || first + count > VERTEX_BINDINGS)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            for (let k = 0; k < count; k++)
            {
                const error = buffers
                    ? bindPoint(first + k, buffers[k], offsets[k], strides[k])
                    : bindPoint(first + k, 0, 0, 16);
                if (error)
                {
                    setError(error);
                }
            }
        },

        /** @param {number} point @param {number} divisor */
        glVertexBindingDivisor(point, divisor){
            if (!enter('glVertexBindingDivisor', [point, divisor]) || !knownPoint(point))
            {
                return;
            }
            points[point] = { ...points[point], divisor: divisor >>> 0 };
            if (point < GENERIC_ATTRIBS && places[point].binding === point)
            {
                places[point].viaBinding = true;
            }
            resyncPoint(point);
        },
    });
}
