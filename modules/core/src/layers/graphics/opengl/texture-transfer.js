/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Pixel transfer for the sized formats (`formats.js`), both ways, as OpenGL
 * 4.6 sections 8.4.4 (unpacking), 8.5 (into the internal format) and 18.2.8
 * (packing) describe it.
 *
 * A program's pixels become four values a texel -- red, green, blue and alpha,
 * or depth and stencil -- in the specification's own terms: a normalised type
 * read as its fraction (an unsigned one c / (2^b - 1), a signed one
 * max(c / (2^(b-1) - 1), -1)), a float as it is, the components of an
 * integer format as the integers they are; the components the format lacks are
 * zero, and alpha one. Those values are then written in the internal format's
 * bytes: a normalised format clamps and rounds, a float format keeps the value
 * (a half float rounds to the nearest), an integer format clamps to its range.
 * Reading back is the same two steps the other way round.
 *
 * A layout that is the internal format's own -- RED/UNSIGNED_BYTE into R8,
 * RGBA/FLOAT into RGBA32F -- is copied row by row; nothing about the values
 * changes on the way.
 */

import { GL } from './constants.js';
import { INTEGER_CLIENT_FORMATS, TEX, isIntegerFormat, modelTexelBytes } from './formats.js';

/**
 * The pixel store state of one direction (OpenGL 4.6 table 8.1), 3D included.
 *
 * @typedef {Object} TransferState
 * @property {number} alignment
 * @property {number} rowLength
 * @property {number} skipRows
 * @property {number} skipPixels
 * @property {number} [imageHeight]
 * @property {number} [skipImages]
 * @property {boolean} swapBytes
 */

/**
 * Which of the four values each client component is, by format: red, green,
 * blue and alpha 0 to 3; for depth and stencil, depth 0 and stencil 1. `L` is
 * luminance, which becomes red (8.4.4.4), `I` intensity, the same.
 *
 * @type {ReadonlyMap<number, readonly number[]>}
 */
const SLOTS = new Map([
    [GL.RED, [0]], [GL.GREEN, [1]], [GL.BLUE, [2]], [GL.ALPHA, [3]], [TEX.RG, [0, 1]],
    [GL.RGB, [0, 1, 2]], [GL.BGR, [2, 1, 0]], [GL.RGBA, [0, 1, 2, 3]], [GL.BGRA, [2, 1, 0, 3]],
    [GL.LUMINANCE, [0]], [GL.LUMINANCE_ALPHA, [0, 3]],
    [GL.DEPTH_COMPONENT, [0]], [GL.STENCIL_INDEX, [1]], [GL.DEPTH_STENCIL, [0, 1]],
]);

/**
 * The unpacked types: bytes a component, and how one is read.
 *
 * @type {ReadonlyMap<number, { bytes: number, signed: boolean, float: boolean }>}
 */
const COMPONENT_TYPES = new Map([
    [GL.UNSIGNED_BYTE, { bytes: 1, signed: false, float: false }],
    [GL.BYTE, { bytes: 1, signed: true, float: false }],
    [GL.UNSIGNED_SHORT, { bytes: 2, signed: false, float: false }],
    [GL.SHORT, { bytes: 2, signed: true, float: false }],
    [GL.UNSIGNED_INT, { bytes: 4, signed: false, float: false }],
    [GL.INT, { bytes: 4, signed: true, float: false }],
    [TEX.HALF_FLOAT, { bytes: 2, signed: true, float: true }],
    [GL.FLOAT, { bytes: 4, signed: true, float: true }],
]);

/**
 * @typedef {{ bytes: number, formats: readonly number[],
 *     fields: readonly (readonly [number, number])[], encoding?: string }} PackedType
 */

/**
 * The packed types (table 8.5): a pixel's bytes, the formats it can carry,
 * and each component's field as [lowest bit, bits] in the order the format
 * lists its components. A field of special encoding says so.
 *
 * @type {ReadonlyMap<number, PackedType>}
 */
const PACKED = new Map([
    [GL.UNSIGNED_BYTE_3_3_2, { bytes: 1, formats: [GL.RGB], fields: [[5, 3], [2, 3], [0, 2]] }],
    [TEX.UNSIGNED_BYTE_2_3_3_REV, { bytes: 1, formats: [GL.RGB],
        fields: [[0, 3], [3, 3], [6, 2]] }],
    [GL.UNSIGNED_SHORT_5_6_5, { bytes: 2, formats: [GL.RGB],
        fields: [[11, 5], [5, 6], [0, 5]] }],
    [GL.UNSIGNED_SHORT_5_6_5_REV, { bytes: 2, formats: [GL.RGB],
        fields: [[0, 5], [5, 6], [11, 5]] }],
    [GL.UNSIGNED_SHORT_4_4_4_4, { bytes: 2, formats: [GL.RGBA, GL.BGRA],
        fields: [[12, 4], [8, 4], [4, 4], [0, 4]] }],
    [GL.UNSIGNED_SHORT_4_4_4_4_REV, { bytes: 2, formats: [GL.RGBA, GL.BGRA],
        fields: [[0, 4], [4, 4], [8, 4], [12, 4]] }],
    [GL.UNSIGNED_SHORT_5_5_5_1, { bytes: 2, formats: [GL.RGBA, GL.BGRA],
        fields: [[11, 5], [6, 5], [1, 5], [0, 1]] }],
    [GL.UNSIGNED_SHORT_1_5_5_5_REV, { bytes: 2, formats: [GL.RGBA, GL.BGRA],
        fields: [[0, 5], [5, 5], [10, 5], [15, 1]] }],
    [GL.UNSIGNED_INT_8_8_8_8, { bytes: 4, formats: [GL.RGBA, GL.BGRA],
        fields: [[24, 8], [16, 8], [8, 8], [0, 8]] }],
    [GL.UNSIGNED_INT_8_8_8_8_REV, { bytes: 4, formats: [GL.RGBA, GL.BGRA],
        fields: [[0, 8], [8, 8], [16, 8], [24, 8]] }],
    [GL.UNSIGNED_INT_10_10_10_2, { bytes: 4, formats: [GL.RGBA, GL.BGRA],
        fields: [[22, 10], [12, 10], [2, 10], [0, 2]] }],
    [GL.UNSIGNED_INT_2_10_10_10_REV, { bytes: 4, formats: [GL.RGBA, GL.BGRA],
        fields: [[0, 10], [10, 10], [20, 10], [30, 2]] }],
    [TEX.UNSIGNED_INT_10F_11F_11F_REV, { bytes: 4, formats: [GL.RGB],
        fields: [[0, 11], [11, 11], [22, 10]], encoding: 'float' }],
    [TEX.UNSIGNED_INT_5_9_9_9_REV, { bytes: 4, formats: [GL.RGB],
        fields: [[0, 9], [9, 9], [18, 9]], encoding: 'shared' }],
    [GL.UNSIGNED_INT_24_8, { bytes: 4, formats: [GL.DEPTH_STENCIL],
        fields: [[8, 24], [0, 8]] }],
    [TEX.FLOAT_32_UNSIGNED_INT_24_8_REV, { bytes: 8, formats: [GL.DEPTH_STENCIL],
        fields: [[0, 32], [32, 8]], encoding: 'float-depth' }],
]);

/** The client types of float values, which an integer format refuses. */
/** @type {ReadonlySet<number>} */
const FLOAT_TYPES = new Set([GL.FLOAT, TEX.HALF_FLOAT, TEX.UNSIGNED_INT_10F_11F_11F_REV,
    TEX.UNSIGNED_INT_5_9_9_9_REV]);

/** @type {ReadonlySet<number>} */
const DEPTH_FORMATS = new Set([GL.DEPTH_COMPONENT, GL.DEPTH_STENCIL]);

/**
 * The colour format an integer client format is the twin of, or the format
 * itself.
 *
 * @param {number} format
 */
const colourOf = format=>INTEGER_CLIENT_FORMATS.get(format) ?? format;

/**
 * The error a transfer between a sized format and a client layout raises
 * (8.4.4 and 8.5, for TexImage and GetTexImage alike), or zero.
 *
 * @param {import('./formats.js').SizedFormat} sized
 * @param {number} format @param {number} type
 * @returns {number}
 */
export function transferError(sized, format, type){
    const slots = SLOTS.get(colourOf(format));
    const packed = PACKED.get(type);
    if (!slots || (!packed && !COMPONENT_TYPES.has(type)))
    {
        return GL.INVALID_ENUM;
    }
    const integer = INTEGER_CLIENT_FORMATS.has(format);
    if (packed && !packed.formats.includes(colourOf(format)))
    {
        return GL.INVALID_OPERATION;
    }
    if (format === GL.DEPTH_STENCIL && !packed)
    {
        return GL.INVALID_OPERATION;
    }
    if (integer && FLOAT_TYPES.has(type))
    {
        return GL.INVALID_OPERATION;
    }
    if (integer !== isIntegerFormat(sized))
    {
        return GL.INVALID_OPERATION;
    }
    const depthInternal = sized.base === GL.DEPTH_COMPONENT || sized.base === GL.DEPTH_STENCIL;
    if (depthInternal !== DEPTH_FORMATS.has(format))
    {
        return GL.INVALID_OPERATION;
    }
    if ((sized.base === GL.STENCIL_INDEX) !== (format === GL.STENCIL_INDEX))
    {
        return GL.INVALID_OPERATION;
    }
    return 0;
}

/**
 * Where the rows and images of a client image lie.
 *
 * @param {number} width @param {number} height @param {number} format
 * @param {number} type @param {TransferState} state
 * @returns {{ pixelBytes: number, rowStride: number, imageStride: number,
 *     first: number } | null}
 */
export function clientLayout(width, height, format, type, state){
    const slots = SLOTS.get(colourOf(format));
    if (!slots)
    {
        return null;
    }
    const packed = PACKED.get(type);
    const component = COMPONENT_TYPES.get(type);
    if (!packed && !component)
    {
        return null;
    }
    const pixelBytes = packed ? packed.bytes
        : /** @type {{ bytes: number }} */ (component).bytes * slots.length;
    const groups = state.rowLength > 0 ? state.rowLength : width;
    const alignment = Math.max(1, state.alignment);
    const unaligned = groups * pixelBytes;
    // Section 8.4.4.1 pads a row only for an element narrower than the
    // alignment; both are powers of two, so the padding below is that rule.
    const rowStride = Math.ceil(unaligned / alignment) * alignment;
    const rows = (state.imageHeight ?? 0) > 0 ? /** @type {number} */ (state.imageHeight) : height;
    const imageStride = rowStride * rows;
    const first = (state.skipImages ?? 0) * imageStride + state.skipRows * rowStride
        + state.skipPixels * pixelBytes;
    return { pixelBytes, rowStride, imageStride, first };
}

/**
 * The bytes a client image spans from its pointer, skips included.
 *
 * @param {number} width @param {number} height @param {number} depth
 * @param {number} format @param {number} type @param {TransferState} state
 * @returns {number} zero for a layout that is none
 */
export function clientBytes(width, height, depth, format, type, state){
    const layout = clientLayout(width, height, format, type, state);
    if (!layout || width === 0 || height === 0 || depth === 0)
    {
        return 0;
    }
    return layout.first + (depth - 1) * layout.imageStride + (height - 1) * layout.rowStride
        + width * layout.pixelBytes;
}

// --- half floats and the small floats of the packed formats ---

const scratch = new DataView(new ArrayBuffer(4));

/** @param {number} value @returns {number} the nearest half float's bits */
export function toHalf(value){
    scratch.setFloat32(0, value);
    const bits = scratch.getUint32(0);
    const sign = (bits >>> 16) & 0x8000;
    const exponent = (bits >>> 23) & 0xff;
    let mantissa = bits & 0x7fffff;
    if (exponent === 0xff)
    {
        return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
    }
    let e = exponent - 127 + 15;
    if (e >= 0x1f)
    {
        return sign | 0x7c00;
    }
    if (e <= 0)
    {
        if (e < -10)
        {
            return sign;
        }
        mantissa |= 0x800000;
        const shift = 14 - e;
        let half = mantissa >>> shift;
        const rest = mantissa & ((1 << shift) - 1);
        const midway = 1 << (shift - 1);
        if (rest > midway || (rest === midway && (half & 1) !== 0))
        {
            half++;
        }
        return sign | half;
    }
    let half = (e << 10) | (mantissa >>> 13);
    const rest = mantissa & 0x1fff;
    if (rest > 0x1000 || (rest === 0x1000 && (half & 1) !== 0))
    {
        half++;
    }
    e = half;
    return sign | e;
}

/**
 * An unsigned float of `mantissa` bits and five of exponent, as R11F_G11F_B10F
 * keeps one (no sign; a negative is zero).
 *
 * @param {number} value @param {number} mantissaBits
 * @returns {number}
 */
function toSmallFloat(value, mantissaBits){
    if (!(value > 0))
    {
        return Number.isNaN(value) ? (0x1f << mantissaBits) | 1 : 0;
    }
    if (value === Infinity)
    {
        return 0x1f << mantissaBits;
    }
    // Rounded once, from the value itself: through a half float first a tie
    // could round twice. Too large a finite value is the largest finite one
    // (OpenGL 4.6 section 2.3.4.3).
    const max = (0x1e << mantissaBits) | ((1 << mantissaBits) - 1);
    const steps = 2 ** mantissaBits;
    if (value < 2 ** -14)
    {
        return Math.min(max, roundEven(value * 2 ** 14 * steps));
    }
    let exponent = Math.floor(Math.log2(value));
    // log2 can land a hair off for a value just under a power of two.
    if (2 ** exponent > value)
    {
        exponent--;
    }
    else if (2 ** (exponent + 1) <= value)
    {
        exponent++;
    }
    let mantissa = roundEven((value / 2 ** exponent - 1) * steps);
    if (mantissa === steps)
    {
        mantissa = 0;
        exponent++;
    }
    if (exponent > 15)
    {
        return max;
    }
    return ((exponent + 15) << mantissaBits) | mantissa;
}

/** @param {number} value @returns {number} the nearest integer, a tie to the even one */
function roundEven(value){
    const floor = Math.floor(value);
    const rest = value - floor;
    return rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

/** @param {number} bits @param {number} mantissaBits @returns {number} */
function fromSmallFloat(bits, mantissaBits){
    const exponent = bits >>> mantissaBits;
    const mantissa = bits & ((1 << mantissaBits) - 1);
    if (exponent === 0x1f)
    {
        return mantissa === 0 ? Infinity : NaN;
    }
    if (exponent === 0)
    {
        return mantissa / (1 << mantissaBits) * 2 ** -14;
    }
    return (1 + mantissa / (1 << mantissaBits)) * 2 ** (exponent - 15);
}

/** @param {number} bits @returns {number} a half float's value */
export const fromHalf = bits=>{
    const value = fromSmallFloat(bits & 0x7fff, 10);
    return (bits & 0x8000) !== 0 ? -value : value;
};

/**
 * RGB9_E5's encoding of three values (section 8.5.2).
 *
 * @param {number} r @param {number} g @param {number} b
 * @returns {number}
 */
function toSharedExponent(r, g, b){
    const max = (511 / 512) * 2 ** 16;
    const clamp = (/** @type {number} */ c)=>(c > 0 ? Math.min(c, max) : 0);
    const [cr, cg, cb] = [clamp(r), clamp(g), clamp(b)];
    const largest = Math.max(cr, cg, cb);
    const floor = largest === 0 ? -16 : Math.floor(Math.log2(largest));
    let exponent = Math.max(-16, floor) + 1 + 15;
    let scale = 2 ** (exponent - 15 - 9);
    if (Math.floor(largest / scale + 0.5) === 512)
    {
        exponent++;
        scale *= 2;
    }
    const [mr, mg, mb] = [cr, cg, cb].map(c=>Math.floor(c / scale + 0.5));
    return (mr | (mg << 9) | (mb << 18) | (exponent << 27)) >>> 0;
}

/** @param {number} word @returns {number[]} RGB9_E5's three values */
function fromSharedExponent(word){
    const scale = 2 ** ((word >>> 27) - 15 - 9);
    return [word & 0x1ff, (word >>> 9) & 0x1ff, (word >>> 18) & 0x1ff].map(m=>m * scale);
}

// --- client pixels in and out ---

/**
 * A component of an unpacked type as the value the specification converts
 * it to: a normalised fraction, or the integer as it is.
 *
 * @param {DataView} view @param {number} at @param {number} type
 * @param {boolean} little @param {boolean} integer
 * @returns {number}
 */
function readValue(view, at, type, little, integer){
    switch (type)
    {
        case GL.UNSIGNED_BYTE: {
            const c = view.getUint8(at);
            return integer ? c : c / 255;
        }
        case GL.BYTE: {
            const c = view.getInt8(at);
            return integer ? c : Math.max(c / 127, -1);
        }
        case GL.UNSIGNED_SHORT: {
            const c = view.getUint16(at, little);
            return integer ? c : c / 65535;
        }
        case GL.SHORT: {
            const c = view.getInt16(at, little);
            return integer ? c : Math.max(c / 32767, -1);
        }
        case GL.UNSIGNED_INT: {
            const c = view.getUint32(at, little);
            return integer ? c : c / 4294967295;
        }
        case GL.INT: {
            const c = view.getInt32(at, little);
            return integer ? c : Math.max(c / 2147483647, -1);
        }
        case TEX.HALF_FLOAT:
            return fromHalf(view.getUint16(at, little));
        default:
            return view.getFloat32(at, little);
    }
}

/**
 * A value written as a component of an unpacked type: a normalised one
 * clamped and rounded (18.2.8), an integer one clamped to the type.
 *
 * @param {DataView} view @param {number} at @param {number} type @param {number} value
 * @param {boolean} little @param {boolean} integer
 */
function writeValue(view, at, type, value, little, integer){
    const v = Number.isNaN(value) ? 0 : value;
    /** @param {number} max */
    const unsigned = max=>(integer ? Math.min(max, Math.max(0, Math.trunc(v)))
        : Math.round(Math.min(1, Math.max(0, v)) * max));
    /** @param {number} max */
    const signed = max=>(integer ? Math.min(max, Math.max(-max - 1, Math.trunc(v)))
        : Math.round(Math.min(1, Math.max(-1, v)) * max));
    switch (type)
    {
        case GL.UNSIGNED_BYTE:
            view.setUint8(at, unsigned(255));
            return;
        case GL.BYTE:
            view.setInt8(at, signed(127));
            return;
        case GL.UNSIGNED_SHORT:
            view.setUint16(at, unsigned(65535), little);
            return;
        case GL.SHORT:
            view.setInt16(at, signed(32767), little);
            return;
        case GL.UNSIGNED_INT:
            view.setUint32(at, unsigned(4294967295), little);
            return;
        case GL.INT:
            view.setInt32(at, signed(2147483647), little);
            return;
        case TEX.HALF_FLOAT:
            view.setUint16(at, toHalf(value), little);
            return;
        default:
            view.setFloat32(at, value, little);
    }
}

/**
 * The four values of every texel of a client image (8.4.4): red, green,
 * blue and alpha, or depth and stencil. What the format leaves out is zero,
 * alpha one.
 *
 * @param {Uint8Array} bytes  from the pointer on
 * @param {number} width @param {number} height @param {number} depth
 * @param {number} format @param {number} type @param {TransferState} state
 * @returns {Float64Array | null} null for bytes too few
 */
export function decodeClient(bytes, width, height, depth, format, type, state){
    const layout = clientLayout(width, height, format, type, state);
    const slots = SLOTS.get(colourOf(format));
    if (!layout || !slots
        || bytes.byteLength < clientBytes(width, height, depth, format, type, state))
    {
        return null;
    }
    const integer = INTEGER_CLIENT_FORMATS.has(format) || format === GL.STENCIL_INDEX;
    const little = !state.swapBytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float64Array(width * height * depth * 4);
    const depthFormat = DEPTH_FORMATS.has(format) || format === GL.STENCIL_INDEX;
    if (!depthFormat)
    {
        for (let at = 3; at < out.length; at += 4)
        {
            out[at] = 1;
        }
    }
    const packed = PACKED.get(type);
    const component = COMPONENT_TYPES.get(type);
    let texel = 0;
    for (let z = 0; z < depth; z++)
    {
        for (let y = 0; y < height; y++)
        {
            let at = layout.first + z * layout.imageStride + y * layout.rowStride;
            for (let x = 0; x < width; x++, texel += 4, at += layout.pixelBytes)
            {
                if (packed)
                {
                    readPacked(view, at, packed, little, integer, slots, out, texel);
                    continue;
                }
                const size = /** @type {{ bytes: number }} */ (component).bytes;
                for (let k = 0; k < slots.length; k++)
                {
                    out[texel + slots[k]] = readValue(view, at + k * size, type, little,
                        integer || slots[k] === 1 && depthFormat);
                }
            }
        }
    }
    if (format === GL.LUMINANCE || format === GL.LUMINANCE_ALPHA)
    {
        // A luminance is copied into red, green and blue (OpenGL 2.1
        // section 3.6.5, "Conversion to RGB").
        for (let at = 0; at < out.length; at += 4)
        {
            out[at + 1] = out[at];
            out[at + 2] = out[at];
        }
    }
    return out;
}

/**
 * @param {DataView} view @param {number} at
 * @param {PackedType} packed
 * @param {boolean} little @param {boolean} integer @param {readonly number[]} slots
 * @param {Float64Array} out @param {number} texel
 */
function readPacked(view, at, packed, little, integer, slots, out, texel){
    if (packed.encoding === 'float-depth')
    {
        out[texel] = view.getFloat32(at, little);
        out[texel + 1] = view.getUint32(at + 4, little) & 0xff;
        return;
    }
    const word = packed.bytes === 1 ? view.getUint8(at)
        : packed.bytes === 2 ? view.getUint16(at, little) : view.getUint32(at, little);
    if (packed.encoding === 'shared')
    {
        const rgb = fromSharedExponent(word);
        slots.forEach((slot, k)=>{
            out[texel + slot] = rgb[k];
        });
        return;
    }
    packed.fields.forEach(([low, bits], k)=>{
        const field = Math.floor(word / 2 ** low) % 2 ** bits;
        out[texel + slots[k]] = packed.encoding === 'float'
            ? fromSmallFloat(field, bits - 5)
            : integer || (slots[k] === 1 && packed.formats[0] === GL.DEPTH_STENCIL)
                ? field : field / (2 ** bits - 1);
    });
}

/**
 * A client image of four values a texel (18.2.8), the other way round from
 * `decodeClient`: luminance is red, a component the format has no place for
 * is dropped.
 *
 * @param {Float64Array} values @param {number} width @param {number} height
 * @param {number} depth @param {number} format @param {number} type
 * @param {TransferState} state
 * @returns {Uint8Array | null}
 */
export function encodeClient(values, width, height, depth, format, type, state){
    const layout = clientLayout(width, height, format, type, state);
    const slots = SLOTS.get(colourOf(format));
    if (!layout || !slots)
    {
        return null;
    }
    const out = new Uint8Array(clientBytes(width, height, depth, format, type, state));
    const view = new DataView(out.buffer);
    const integer = INTEGER_CLIENT_FORMATS.has(format) || format === GL.STENCIL_INDEX;
    const little = !state.swapBytes;
    const packed = PACKED.get(type);
    const size = COMPONENT_TYPES.get(type)?.bytes ?? 0;
    const depthFormat = DEPTH_FORMATS.has(format);
    let texel = 0;
    for (let z = 0; z < depth; z++)
    {
        for (let y = 0; y < height; y++)
        {
            let at = layout.first + z * layout.imageStride + y * layout.rowStride;
            for (let x = 0; x < width; x++, texel += 4, at += layout.pixelBytes)
            {
                if (packed)
                {
                    writePacked(view, at, packed, little, integer, slots, values, texel);
                    continue;
                }
                for (let k = 0; k < slots.length; k++)
                {
                    writeValue(view, at + k * size, type, values[texel + slots[k]], little,
                        integer || (slots[k] === 1 && depthFormat));
                }
            }
        }
    }
    return out;
}

/**
 * @param {DataView} view @param {number} at
 * @param {PackedType} packed
 * @param {boolean} little @param {boolean} integer @param {readonly number[]} slots
 * @param {Float64Array} values @param {number} texel
 */
function writePacked(view, at, packed, little, integer, slots, values, texel){
    if (packed.encoding === 'float-depth')
    {
        view.setFloat32(at, values[texel], little);
        view.setUint32(at + 4, Math.min(255, Math.max(0, values[texel + 1])), little);
        return;
    }
    let word = 0;
    if (packed.encoding === 'shared')
    {
        word = toSharedExponent(values[texel + slots[0]], values[texel + slots[1]],
            values[texel + slots[2]]);
    }
    else
    {
        packed.fields.forEach(([low, bits], k)=>{
            const max = 2 ** bits - 1;
            const value = values[texel + slots[k]];
            const field = packed.encoding === 'float' ? toSmallFloat(value, bits - 5)
                : integer || (slots[k] === 1 && packed.formats[0] === GL.DEPTH_STENCIL)
                    ? Math.min(max, Math.max(0, Math.trunc(value)))
                    : Math.round(Math.min(1, Math.max(0, value)) * max);
            word += field * 2 ** low;
        });
    }
    if (packed.bytes === 1)
    {
        view.setUint8(at, word);
    }
    else if (packed.bytes === 2)
    {
        view.setUint16(at, word, little);
    }
    else
    {
        view.setUint32(at, word >>> 0, little);
    }
}

// --- the internal format's bytes ---

/** @param {import('./formats.js').SizedFormat} sized */
const componentsOf = sized=>(sized.base === GL.RED ? 1 : sized.base === TEX.RG ? 2 : 4);

/**
 * The internal format's bytes for four values a texel (8.5): a normalised
 * format clamps and rounds, an integer one clamps to its range, a float one
 * keeps the value; a depth of fixed point clamps to [0, 1].
 *
 * @param {Float64Array} values
 * @param {import('./formats.js').SizedFormat} sized
 * @returns {Uint8Array}
 */
export function encodeStorage(values, sized){
    const count = values.length / 4;
    const bytes = modelTexelBytes(sized);
    const out = new Uint8Array(count * bytes);
    const view = new DataView(out.buffer);
    const unit = (/** @type {number} */ v)=>(Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)));
    const width = sized.bits[0];
    const components = componentsOf(sized);
    for (let i = 0; i < count; i++)
    {
        const at = i * bytes;
        const t = i * 4;
        switch (sized.packing ?? sized.kind)
        {
            case 'rgb10a2': {
                const field = (/** @type {number} */ k, /** @type {number} */ max)=>(
                    sized.kind === 'uint'
                        ? Math.min(max, Math.max(0, Math.trunc(values[t + k])))
                        : Math.round(unit(values[t + k]) * max));
                view.setUint32(at, (field(0, 1023) | (field(1, 1023) << 10)
                    | (field(2, 1023) << 20) | (field(3, 3) << 30)) >>> 0, true);
                break;
            }
            case 'r11g11b10':
                view.setUint32(at, (toSmallFloat(values[t], 6)
                    | (toSmallFloat(values[t + 1], 6) << 11)
                    | (toSmallFloat(values[t + 2], 5) << 22)) >>> 0, true);
                break;
            case 'rgb9e5':
                view.setUint32(at, toSharedExponent(values[t], values[t + 1], values[t + 2]),
                    true);
                break;
            case 'd24s8':
                view.setUint32(at, (Math.round(unit(values[t]) * 0xffffff)
                    | (Math.min(255, Math.max(0, values[t + 1])) << 24)) >>> 0, true);
                break;
            case 'd32fs8':
                view.setFloat32(at, sized.internal === TEX.DEPTH32F_STENCIL8 ? values[t]
                    : unit(values[t]), true);
                view.setUint32(at + 4, Math.min(255, Math.max(0, values[t + 1])), true);
                break;
            case 'depth':
                if (sized.depth === 16)
                {
                    view.setUint16(at, Math.round(unit(values[t]) * 65535), true);
                }
                else if (sized.depth === 24)
                {
                    view.setUint32(at, Math.round(unit(values[t]) * 0xffffff), true);
                }
                else
                {
                    // A float depth keeps what it is given; DEPTH_COMPONENT32
                    // is fixed point, its values clamped, kept as a float.
                    view.setFloat32(at, sized.internal === TEX.DEPTH_COMPONENT32F
                        ? values[t] : unit(values[t]), true);
                }
                break;
            case 'stencil':
                out[at] = Math.min(255, Math.max(0, values[t + 1]));
                break;
            default:
                for (let k = 0; k < components; k++)
                {
                    writeValue(view, at + k * width / 8, storageType(sized),
                        sized.base === GL.RGB && k === 3 ? 1 : values[t + k], true,
                        isIntegerFormat(sized));
                }
        }
    }
    return out;
}

/**
 * The client type whose component is a component of this format's storage.
 *
 * @param {import('./formats.js').SizedFormat} sized
 * @returns {number}
 */
function storageType(sized){
    const width = sized.bits[0];
    if (sized.kind === 'float')
    {
        return width === 16 ? TEX.HALF_FLOAT : GL.FLOAT;
    }
    const signed = sized.kind === 'snorm' || sized.kind === 'int';
    return width === 8 ? (signed ? GL.BYTE : GL.UNSIGNED_BYTE)
        : width === 16 ? (signed ? GL.SHORT : GL.UNSIGNED_SHORT)
            : signed ? GL.INT : GL.UNSIGNED_INT;
}

/**
 * The four values a texel of the internal format's bytes holds: the inverse
 * of `encodeStorage`, missing components zero and alpha one.
 *
 * @param {Uint8Array} bytes
 * @param {import('./formats.js').SizedFormat} sized
 * @returns {Float64Array}
 */
export function decodeStorage(bytes, sized){
    const texel = modelTexelBytes(sized);
    const count = Math.floor(bytes.byteLength / texel);
    const out = new Float64Array(count * 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = sized.bits[0];
    const components = componentsOf(sized);
    const depthLike = sized.kind === 'depth' || sized.kind === 'stencil';
    for (let i = 0; i < count; i++)
    {
        const at = i * texel;
        const t = i * 4;
        if (!depthLike)
        {
            out[t + 3] = 1;
        }
        switch (sized.packing ?? sized.kind)
        {
            case 'rgb10a2': {
                const word = view.getUint32(at, true);
                const fields = [word & 1023, (word >>> 10) & 1023, (word >>> 20) & 1023,
                    word >>> 30];
                fields.forEach((field, k)=>{
                    out[t + k] = sized.kind === 'uint' ? field : field / (k === 3 ? 3 : 1023);
                });
                break;
            }
            case 'r11g11b10': {
                const word = view.getUint32(at, true);
                out[t] = fromSmallFloat(word & 0x7ff, 6);
                out[t + 1] = fromSmallFloat((word >>> 11) & 0x7ff, 6);
                out[t + 2] = fromSmallFloat(word >>> 22, 5);
                break;
            }
            case 'rgb9e5':
                fromSharedExponent(view.getUint32(at, true)).forEach((value, k)=>{
                    out[t + k] = value;
                });
                break;
            case 'd24s8': {
                const word = view.getUint32(at, true);
                out[t] = (word & 0xffffff) / 0xffffff;
                out[t + 1] = word >>> 24;
                break;
            }
            case 'd32fs8':
                out[t] = view.getFloat32(at, true);
                out[t + 1] = view.getUint32(at + 4, true) & 0xff;
                break;
            case 'depth':
                out[t] = sized.depth === 16 ? view.getUint16(at, true) / 65535
                    : sized.depth === 24 ? (view.getUint32(at, true) & 0xffffff) / 0xffffff
                        : view.getFloat32(at, true);
                break;
            case 'stencil':
                out[t + 1] = bytes[at];
                break;
            default:
                for (let k = 0; k < components && k < 4; k++)
                {
                    out[t + k] = readValue(view, at + k * width / 8, storageType(sized), true,
                        isIntegerFormat(sized));
                }
                if (sized.base === GL.RGB)
                {
                    out[t + 3] = 1;
                }
        }
    }
    return out;
}

/**
 * The client layout that is the internal format's own bytes, for a copy row
 * by row: the format's components in its order, of its own type, no
 * conversion on the way. Null where the values would change.
 *
 * @param {import('./formats.js').SizedFormat} sized
 * @returns {{ format: number, type: number } | null}
 */
export function storageLayout(sized){
    if (sized.packing || sized.compressed || sized.kind === 'snorm' || sized.base === GL.RGB
        || (sized.kind === 'depth' && sized.depth !== 16
            && sized.internal !== TEX.DEPTH_COMPONENT32F)
        || sized.kind === 'stencil')
    {
        // A signed normalised byte reads -128 as -1 and writes it back as -127.
        return null;
    }
    const integer = isIntegerFormat(sized);
    const format = sized.kind === 'depth' ? GL.DEPTH_COMPONENT
        : sized.base === GL.RED ? (integer ? TEX.RED_INTEGER : GL.RED)
            : sized.base === TEX.RG ? (integer ? TEX.RG_INTEGER : TEX.RG)
                : integer ? TEX.RGBA_INTEGER : GL.RGBA;
    const type = sized.kind === 'depth' ? (sized.depth === 16 ? GL.UNSIGNED_SHORT : GL.FLOAT)
        : storageType(sized);
    return { format, type };
}

/**
 * A client image as the internal format's bytes: copied row by row where the
 * layout is the format's own and the bytes need no swap, converted otherwise.
 *
 * @param {Uint8Array} bytes @param {number} width @param {number} height
 * @param {number} depth @param {number} format @param {number} type
 * @param {TransferState} state @param {import('./formats.js').SizedFormat} sized
 * @returns {Uint8Array | null}
 */
export function unpackToStorage(bytes, width, height, depth, format, type, state, sized){
    const own = storageLayout(sized);
    if (own && own.format === format && own.type === type
        && (!state.swapBytes || modelTexelBytes(sized) / componentsOf(sized) === 1))
    {
        const layout = /** @type {NonNullable<ReturnType<typeof clientLayout>>} */ (
            clientLayout(width, height, format, type, state));
        if (bytes.byteLength < clientBytes(width, height, depth, format, type, state))
        {
            return null;
        }
        const row = width * layout.pixelBytes;
        const out = new Uint8Array(row * height * depth);
        for (let z = 0; z < depth; z++)
        {
            for (let y = 0; y < height; y++)
            {
                const from = layout.first + z * layout.imageStride + y * layout.rowStride;
                out.set(bytes.subarray(from, from + row), (z * height + y) * row);
            }
        }
        return out;
    }
    const values = decodeClient(bytes, width, height, depth, format, type, state);
    return values ? encodeStorage(values, sized) : null;
}

/**
 * The internal format's bytes as a client image (glGetTexImage).
 *
 * @param {Uint8Array} stored @param {number} width @param {number} height
 * @param {number} depth @param {number} format @param {number} type
 * @param {TransferState} state @param {import('./formats.js').SizedFormat} sized
 * @returns {Uint8Array | null}
 */
export function packFromStorage(stored, width, height, depth, format, type, state, sized){
    return encodeClient(decodeStorage(stored, sized), width, height, depth, format, type, state);
}
