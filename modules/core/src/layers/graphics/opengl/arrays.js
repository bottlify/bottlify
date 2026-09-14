/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex arrays: how an element is read out of the bytes a program pointed
 * at.
 *
 * A pointer is remembered exactly as it was given -- size, type, stride and
 * address -- and dereferenced only when a draw call reaches it. That order
 * is the contract: a program fills its arrays after setting the pointers, and
 * a copy taken at glVertexPointer would draw stale data.
 *
 * Two conversions are the specification's and not obvious:
 *
 * - **A colour or normal in an integer type is normalised**, so an unsigned
 *   byte 255 is 1.0 and a signed byte -128 is -1.0 by the `(2c + 1) / 255`
 *   rule. A vertex or texture coordinate in the same type is not: an integer
 *   position of 3 is 3.0.
 * - **A stride of zero means tightly packed**, which is the element's own
 *   size. It is not literally zero, and reading it as zero draws the first
 *   vertex over and over.
 */

import { GL } from './constants.js';

/**
 * @typedef {Object} ArrayPointer
 * @property {number} size      components per element
 * @property {number} type      GL type of a component
 * @property {number} stride    bytes between elements as given; zero for tight
 * @property {number} pointer   guest address, or the offset into `buffer`
 * @property {number} buffer    the buffer object bound when the pointer was
 *                              set; zero means client memory
 * @property {number} [normalised]  whether what it reads is normalised on
 *                                  read; absent reads as no
 */

/** @type {Map<number, number>} */
const TYPE_BYTES = new Map([
    [GL.BYTE, 1], [GL.UNSIGNED_BYTE, 1], [GL.SHORT, 2], [GL.UNSIGNED_SHORT, 2],
    [GL.INT, 4], [GL.UNSIGNED_INT, 4], [GL.FLOAT, 4], [GL.DOUBLE, 8],
]);

/**
 * @param {number} type
 * @returns {number} bytes per component, or zero for a type that is not one
 */
export function componentBytes(type){
    return TYPE_BYTES.get(type) ?? 0;
}

/**
 * @param {ArrayPointer} pointer
 * @returns {number} the bytes between one element and the next
 */
export function effectiveStride(pointer){
    return pointer.stride > 0 ? pointer.stride : pointer.size * componentBytes(pointer.type);
}

/**
 * @param {DataView} view
 * @param {number} at
 * @param {number} type
 * @param {boolean} normalised
 * @returns {number}
 */
function readComponent(view, at, type, normalised){
    switch (type)
    {
        case GL.BYTE:
        {
            const value = view.getInt8(at);
            return normalised ? (2 * value + 1) / 255 : value;
        }
        case GL.UNSIGNED_BYTE:
        {
            const value = view.getUint8(at);
            return normalised ? value / 255 : value;
        }
        case GL.SHORT:
        {
            const value = view.getInt16(at, true);
            return normalised ? (2 * value + 1) / 65535 : value;
        }
        case GL.UNSIGNED_SHORT:
        {
            const value = view.getUint16(at, true);
            return normalised ? value / 65535 : value;
        }
        case GL.INT:
        {
            const value = view.getInt32(at, true);
            return normalised ? (2 * value + 1) / 4294967295 : value;
        }
        case GL.UNSIGNED_INT:
        {
            const value = view.getUint32(at, true);
            return normalised ? value / 4294967295 : value;
        }
        case GL.FLOAT:
            return view.getFloat32(at, true);
        case GL.DOUBLE:
            return view.getFloat64(at, true);
        default:
            return 0;
    }
}

/**
 * One element of an array.
 *
 * @param {(address: number, length: number) => Uint8Array} read
 *        where the bytes come from: guest memory, or a buffer object's store
 * @param {ArrayPointer} pointer
 * @param {number} index
 * @param {boolean} normalised
 * @returns {number[]} `pointer.size` components
 */
export function readElement(read, pointer, index, normalised){
    const width = componentBytes(pointer.type);
    const bytes = read(pointer.pointer + index * effectiveStride(pointer), pointer.size * width);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    for (let k = 0; k < pointer.size; k++)
    {
        out.push(readComponent(view, k * width, pointer.type, normalised));
    }
    return out;
}

/**
 * One index out of an element array.
 *
 * @param {(address: number, length: number) => Uint8Array} read
 * @param {number} address
 * @param {number} type  GL_UNSIGNED_BYTE, GL_UNSIGNED_SHORT or GL_UNSIGNED_INT
 * @param {number} position
 * @returns {number}
 */
export function readIndex(read, address, type, position){
    const width = componentBytes(type);
    const bytes = read(address + position * width, width);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return width === 1 ? view.getUint8(0) : width === 2 ? view.getUint16(0, true)
        : view.getUint32(0, true);
}

/**
 * @typedef {Object} InterleavedLayout
 * @property {number} stride
 * @property {{ size: number, offset: number } | null} texCoord
 * @property {{ size: number, type: number, offset: number } | null} color
 * @property {{ offset: number } | null} normal
 * @property {{ size: number, offset: number }} vertex
 */

/**
 * The layouts glInterleavedArrays names, as the specification tabulates
 * them. Every offset is a float count times four except the byte colours.
 *
 * @type {Map<number, InterleavedLayout>}
 */
export const INTERLEAVED_LAYOUTS = new Map([
    [GL.V2F, { stride: 8, texCoord: null, color: null, normal: null,
        vertex: { size: 2, offset: 0 } }],
    [GL.V3F, { stride: 12, texCoord: null, color: null, normal: null,
        vertex: { size: 3, offset: 0 } }],
    [GL.C4UB_V2F, { stride: 12, texCoord: null,
        color: { size: 4, type: GL.UNSIGNED_BYTE, offset: 0 }, normal: null,
        vertex: { size: 2, offset: 4 } }],
    [GL.C4UB_V3F, { stride: 16, texCoord: null,
        color: { size: 4, type: GL.UNSIGNED_BYTE, offset: 0 }, normal: null,
        vertex: { size: 3, offset: 4 } }],
    [GL.C3F_V3F, { stride: 24, texCoord: null,
        color: { size: 3, type: GL.FLOAT, offset: 0 }, normal: null,
        vertex: { size: 3, offset: 12 } }],
    [GL.N3F_V3F, { stride: 24, texCoord: null, color: null, normal: { offset: 0 },
        vertex: { size: 3, offset: 12 } }],
    [GL.C4F_N3F_V3F, { stride: 40, texCoord: null,
        color: { size: 4, type: GL.FLOAT, offset: 0 }, normal: { offset: 16 },
        vertex: { size: 3, offset: 28 } }],
    [GL.T2F_V3F, { stride: 20, texCoord: { size: 2, offset: 0 }, color: null, normal: null,
        vertex: { size: 3, offset: 8 } }],
    [GL.T4F_V4F, { stride: 32, texCoord: { size: 4, offset: 0 }, color: null, normal: null,
        vertex: { size: 4, offset: 16 } }],
    [GL.T2F_C4UB_V3F, { stride: 24, texCoord: { size: 2, offset: 0 },
        color: { size: 4, type: GL.UNSIGNED_BYTE, offset: 8 }, normal: null,
        vertex: { size: 3, offset: 12 } }],
    [GL.T2F_C3F_V3F, { stride: 32, texCoord: { size: 2, offset: 0 },
        color: { size: 3, type: GL.FLOAT, offset: 8 }, normal: null,
        vertex: { size: 3, offset: 20 } }],
    [GL.T2F_N3F_V3F, { stride: 32, texCoord: { size: 2, offset: 0 }, color: null,
        normal: { offset: 8 }, vertex: { size: 3, offset: 20 } }],
    [GL.T2F_C4F_N3F_V3F, { stride: 48, texCoord: { size: 2, offset: 0 },
        color: { size: 4, type: GL.FLOAT, offset: 8 }, normal: { offset: 24 },
        vertex: { size: 3, offset: 36 } }],
    [GL.T4F_C4F_N3F_V4F, { stride: 60, texCoord: { size: 4, offset: 0 },
        color: { size: 4, type: GL.FLOAT, offset: 16 }, normal: { offset: 32 },
        vertex: { size: 4, offset: 44 } }],
]);
