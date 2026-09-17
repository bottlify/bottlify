/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texture images: how guest pixels become texels, how a texel is looked up,
 * and how a looked-up texel combines with the fragment.
 *
 * Every image is kept as RGBA, one byte per component, whatever it arrived
 * as. The internal format a program asked for still matters -- it decides
 * which components survive the upload and which the texture environment
 * reads -- so it is remembered as a base format beside the texels rather than
 * as a storage layout.
 *
 * Three decisions here are contract rather than convenience:
 *
 * - **Unpacking honours the pixel store state.** The alignment, the row
 *   length and the skips are the difference between a texture and a sheared
 *   one, and GL_UNPACK_ALIGNMENT starts at four.
 * - **A sample is taken at the centre of the texel.** Nearest filtering
 *   picks the texel under `s * width`; linear filtering blends the two texels
 *   whose centres bracket it. A half-texel slip in either is a visible seam
 *   on every tiled surface.
 * - **The texture environment is evaluated as the specification writes it**,
 *   per base format. A program that uploads a luminance texture and modulates
 *   expects its alpha untouched, and one that uploads alpha and modulates
 *   expects its colour untouched.
 *
 * ponytail: a mipmapped minification filter samples the base level. Level
 * selection needs the texture coordinate derivatives, which this rasteriser
 * does not compute; a picture with too much detail at a distance is the
 * ceiling, and the upgrade is a per-triangle level from the coordinate span.
 */

import { GL } from './constants.js';
import {
    compressedBytes as s3tcCompressedBytes, decodeS3tc as decodeS3tcOf,
} from '../webgpu/internal/s3tc.js';

/**
 * @typedef {Object} UnpackState
 * @property {number} alignment
 * @property {number} rowLength
 * @property {number} skipRows
 * @property {number} skipPixels
 * @property {boolean} swapBytes
 */

/**
 * @typedef {Object} TexelImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} texels  RGBA, four bytes per texel, row zero first
 */

/**
 * The components a format carries, in the order they are stored.
 *
 * @type {Map<number, number>}
 */
const FORMAT_COMPONENTS = new Map([
    [GL.RGBA, 4], [GL.BGRA, 4], [GL.RGB, 3], [GL.BGR, 3], [GL.LUMINANCE_ALPHA, 2],
    [GL.LUMINANCE, 1], [GL.ALPHA, 1], [GL.RED, 1], [GL.GREEN, 1], [GL.BLUE, 1],
    [GL.DEPTH_COMPONENT, 1],
]);

/**
 * How many bytes one component takes, for the unpacked types.
 *
 * @type {Map<number, number>}
 */
const TYPE_BYTES = new Map([
    [GL.UNSIGNED_BYTE, 1], [GL.BYTE, 1], [GL.UNSIGNED_SHORT, 2], [GL.SHORT, 2],
    [GL.UNSIGNED_INT, 4], [GL.INT, 4], [GL.FLOAT, 4],
]);

/**
 * The packed types: how many bytes a whole pixel takes, and the bit widths of
 * its components from the most significant end down. A `_REV` type lists the
 * same widths from the least significant end.
 *
 * @type {Map<number, { bytes: number, widths: number[], reversed: boolean }>}
 */
const PACKED_TYPES = new Map([
    [GL.UNSIGNED_BYTE_3_3_2, { bytes: 1, widths: [3, 3, 2], reversed: false }],
    [GL.UNSIGNED_SHORT_5_6_5, { bytes: 2, widths: [5, 6, 5], reversed: false }],
    [GL.UNSIGNED_SHORT_5_6_5_REV, { bytes: 2, widths: [5, 6, 5], reversed: true }],
    [GL.UNSIGNED_SHORT_4_4_4_4, { bytes: 2, widths: [4, 4, 4, 4], reversed: false }],
    [GL.UNSIGNED_SHORT_4_4_4_4_REV, { bytes: 2, widths: [4, 4, 4, 4], reversed: true }],
    [GL.UNSIGNED_SHORT_5_5_5_1, { bytes: 2, widths: [5, 5, 5, 1], reversed: false }],
    [GL.UNSIGNED_SHORT_1_5_5_5_REV, { bytes: 2, widths: [1, 5, 5, 5], reversed: true }],
    [GL.UNSIGNED_INT_8_8_8_8, { bytes: 4, widths: [8, 8, 8, 8], reversed: false }],
    [GL.UNSIGNED_INT_8_8_8_8_REV, { bytes: 4, widths: [8, 8, 8, 8], reversed: true }],
    [GL.UNSIGNED_INT_10_10_10_2, { bytes: 4, widths: [10, 10, 10, 2], reversed: false }],
    [GL.UNSIGNED_INT_2_10_10_10_REV, { bytes: 4, widths: [2, 10, 10, 10], reversed: true }],
]);

/**
 * Bytes from the start of one row to the start of the next, as the pixel
 * store state defines it.
 *
 * @param {number} width
 * @param {number} format
 * @param {number} type
 * @param {UnpackState} unpack
 * @returns {{ stride: number, pixelBytes: number, componentBytes: number } | null}
 *          null when the format and type do not describe pixels this reads
 */
export function rowLayout(width, format, type, unpack){
    const components = FORMAT_COMPONENTS.get(format);
    if (components === undefined)
    {
        return null;
    }
    const packed = PACKED_TYPES.get(type);
    /** @type {number} */
    let pixelBytes;
    /** @type {number} */
    let componentBytes;
    if (packed)
    {
        if (packed.widths.length !== components)
        {
            return null;
        }
        pixelBytes = packed.bytes;
        componentBytes = packed.bytes;
    }
    else
    {
        const size = TYPE_BYTES.get(type);
        if (size === undefined)
        {
            return null;
        }
        pixelBytes = size * components;
        componentBytes = size;
    }
    const groups = unpack.rowLength > 0 ? unpack.rowLength : width;
    const unaligned = groups * pixelBytes;
    const alignment = Math.max(1, unpack.alignment);
    const stride = componentBytes >= alignment
        ? unaligned
        : Math.ceil(unaligned / alignment) * alignment;
    return { stride, pixelBytes, componentBytes };
}

/**
 * How many bytes an image of this shape occupies in the guest, skips
 * included: what has to be read to unpack it.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} format
 * @param {number} type
 * @param {UnpackState} unpack
 * @returns {number} zero for a layout this cannot read
 */
export function imageBytes(width, height, format, type, unpack){
    const layout = rowLayout(width, format, type, unpack);
    if (!layout || width === 0 || height === 0)
    {
        return 0;
    }
    return (unpack.skipRows + height - 1) * layout.stride
        + (unpack.skipPixels + width) * layout.pixelBytes;
}

/**
 * A component read as a byte: the type's range mapped onto 0..255 the way the
 * specification maps it onto 0..1, then scaled.
 *
 * @param {DataView} view
 * @param {number} at
 * @param {number} type
 * @param {boolean} swap
 * @returns {number}
 */
function readComponent(view, at, type, swap){
    switch (type)
    {
        case GL.UNSIGNED_BYTE:
            return view.getUint8(at);
        case GL.BYTE:
            return Math.max(0, 2 * view.getInt8(at) + 1);
        case GL.UNSIGNED_SHORT:
            return Math.round(view.getUint16(at, !swap) / 65535 * 255);
        case GL.SHORT:
            return Math.max(0, Math.round((2 * view.getInt16(at, !swap) + 1) / 65535 * 255));
        case GL.UNSIGNED_INT:
            return Math.round(view.getUint32(at, !swap) / 4294967295 * 255);
        case GL.INT:
            return Math.max(0, Math.round((2 * view.getInt32(at, !swap) + 1) / 4294967295 * 255));
        case GL.FLOAT:
        {
            const value = view.getFloat32(at, !swap);
            return Math.round(Math.min(1, Math.max(0, value)) * 255);
        }
        default:
            return 0;
    }
}

/**
 * The components of one packed pixel, as bytes, most significant field first.
 *
 * @param {number} word
 * @param {{ bytes: number, widths: number[], reversed: boolean }} packed
 * @returns {number[]}
 */
function unpackWord(word, packed){
    const total = packed.bytes * 8;
    const fields = [];
    let shift = total;
    for (const width of packed.widths)
    {
        shift -= width;
        const max = (1 << width) - 1;
        fields.push(Math.round(((word >>> shift) & max) / max * 255));
    }
    // A reversed type stores the first component in the low bits, so the
    // fields come out in the opposite order from the format's.
    return packed.reversed ? fields.reverse() : fields;
}

/**
 * Turns the components a format carries into r, g, b, a.
 *
 * @param {number} format
 * @param {readonly number[]} c
 * @returns {number[]}
 */
function expand(format, c){
    switch (format)
    {
        case GL.RGBA:
            return [c[0], c[1], c[2], c[3]];
        case GL.BGRA:
            return [c[2], c[1], c[0], c[3]];
        case GL.RGB:
            return [c[0], c[1], c[2], 255];
        case GL.BGR:
            return [c[2], c[1], c[0], 255];
        case GL.LUMINANCE:
            return [c[0], c[0], c[0], 255];
        case GL.LUMINANCE_ALPHA:
            return [c[0], c[0], c[0], c[1]];
        case GL.ALPHA:
            return [0, 0, 0, c[0]];
        case GL.RED:
            return [c[0], 0, 0, 255];
        case GL.GREEN:
            return [0, c[0], 0, 255];
        case GL.BLUE:
            return [0, 0, c[0], 255];
        default:
            return [c[0], c[0], c[0], 255];
    }
}

/**
 * Reads a guest image into RGBA texels.
 *
 * @param {Uint8Array} bytes  the guest bytes, starting where the pointer pointed
 * @param {number} width
 * @param {number} height
 * @param {number} format
 * @param {number} type
 * @param {UnpackState} unpack
 * @returns {Uint8Array | null} width * height RGBA texels, or null when the
 *          layout is not one this reads
 */
export function unpackImage(bytes, width, height, format, type, unpack){
    const layout = rowLayout(width, format, type, unpack);
    if (!layout)
    {
        return null;
    }
    const packed = PACKED_TYPES.get(type);
    const components = /** @type {number} */ (FORMAT_COMPONENTS.get(format));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const texels = new Uint8Array(width * height * 4);
    const needed = imageBytes(width, height, format, type, unpack);
    if (bytes.byteLength < needed)
    {
        return null;
    }
    if (type === GL.UNSIGNED_BYTE && (format === GL.RGBA || format === GL.BGRA
        || format === GL.RGB || format === GL.BGR))
    {
        // The common case, byte for byte: a texture a program streams every
        // frame goes through here, and a general path that builds an array
        // per texel costs it milliseconds.
        const reversed = format === GL.BGRA || format === GL.BGR;
        const opaque = format === GL.RGB || format === GL.BGR;
        for (let y = 0; y < height; y++)
        {
            let at = (unpack.skipRows + y) * layout.stride + unpack.skipPixels * layout.pixelBytes;
            let out = y * width * 4;
            for (let x = 0; x < width; x++)
            {
                texels[out] = bytes[reversed ? at + 2 : at];
                texels[out + 1] = bytes[at + 1];
                texels[out + 2] = bytes[reversed ? at : at + 2];
                texels[out + 3] = opaque ? 255 : bytes[at + 3];
                at += layout.pixelBytes;
                out += 4;
            }
        }
        return texels;
    }
    for (let y = 0; y < height; y++)
    {
        let at = (unpack.skipRows + y) * layout.stride + unpack.skipPixels * layout.pixelBytes;
        for (let x = 0; x < width; x++)
        {
            /** @type {number[]} */
            let fields;
            if (packed)
            {
                const word = packed.bytes === 1
                    ? view.getUint8(at)
                    : packed.bytes === 2
                        ? view.getUint16(at, !unpack.swapBytes)
                        : view.getUint32(at, !unpack.swapBytes);
                fields = unpackWord(word, packed);
            }
            else
            {
                fields = [];
                for (let k = 0; k < components; k++)
                {
                    fields.push(readComponent(
                        view, at + k * layout.componentBytes, type, unpack.swapBytes));
                }
            }
            texels.set(expand(format, fields), (y * width + x) * 4);
            at += layout.pixelBytes;
        }
    }
    return texels;
}

/**
 * The base format an internal format reduces to: which components a texture
 * of that format keeps and which the environment reads.
 *
 * @param {number} internalFormat
 * @returns {number | null} null for one this does not know
 */
export function baseFormatOf(internalFormat){
    switch (internalFormat)
    {
        case 1:
        case GL.LUMINANCE:
        case GL.LUMINANCE8:
        case GL.COMPRESSED_LUMINANCE:
            return GL.LUMINANCE;
        case 2:
        case GL.LUMINANCE_ALPHA:
        case GL.LUMINANCE8_ALPHA8:
        case GL.COMPRESSED_LUMINANCE_ALPHA:
            return GL.LUMINANCE_ALPHA;
        case 3:
        case GL.RGB:
        case GL.R3_G3_B2:
        case GL.RGB4:
        case GL.RGB5:
        case GL.RGB8:
        case GL.RGB10:
        case GL.RGB16:
        case GL.COMPRESSED_RGB:
        case GL.COMPRESSED_RGB_S3TC_DXT1_EXT:
            return GL.RGB;
        case 4:
        case GL.RGBA:
        case GL.RGBA2:
        case GL.RGBA4:
        case GL.RGB5_A1:
        case GL.RGBA8:
        case GL.RGB10_A2:
        case GL.RGBA16:
        case GL.COMPRESSED_RGBA:
        case GL.COMPRESSED_RGBA_S3TC_DXT1_EXT:
        case GL.COMPRESSED_RGBA_S3TC_DXT3_EXT:
        case GL.COMPRESSED_RGBA_S3TC_DXT5_EXT:
            return GL.RGBA;
        case GL.ALPHA:
        case GL.ALPHA8:
        case GL.COMPRESSED_ALPHA:
            return GL.ALPHA;
        case GL.INTENSITY:
        case GL.INTENSITY8:
        case GL.COMPRESSED_INTENSITY:
            return GL.INTENSITY;
        case GL.DEPTH_COMPONENT:
            return GL.DEPTH_COMPONENT;
        default:
            return null;
    }
}

/**
 * Keeps only the components the base format has. An RGB texture uploaded
 * from RGBA pixels has an alpha of one, whatever the pixels said, and a
 * luminance texture uploaded from RGB pixels takes its red channel.
 *
 * @param {Uint8Array} texels
 * @param {number} baseFormat
 */
export function conformTexels(texels, baseFormat){
    for (let at = 0; at < texels.length; at += 4)
    {
        switch (baseFormat)
        {
            case GL.RGB:
                texels[at + 3] = 255;
                break;
            case GL.LUMINANCE:
                texels[at + 1] = texels[at];
                texels[at + 2] = texels[at];
                texels[at + 3] = 255;
                break;
            case GL.LUMINANCE_ALPHA:
                texels[at + 1] = texels[at];
                texels[at + 2] = texels[at];
                break;
            case GL.ALPHA:
                texels[at] = 0;
                texels[at + 1] = 0;
                texels[at + 2] = 0;
                break;
            case GL.INTENSITY:
                texels[at + 1] = texels[at];
                texels[at + 2] = texels[at];
                texels[at + 3] = texels[at];
                break;
            default:
                break;
        }
    }
}

/**
 * The GL S3TC enum, mapped to the format-neutral kind the decoder in
 * `webgpu/internal/s3tc.js` takes: the block layout is the API-neutral part,
 * and this table is the whole of what is GL-specific about reading it.
 *
 * @type {Readonly<Record<number, import('../webgpu/internal/s3tc.js').S3tcKind>>}
 */
const S3TC_KIND = Object.freeze({
    [GL.COMPRESSED_RGB_S3TC_DXT1_EXT]: 'dxt1',
    [GL.COMPRESSED_RGBA_S3TC_DXT1_EXT]: 'dxt1',
    [GL.COMPRESSED_RGBA_S3TC_DXT3_EXT]: 'dxt3',
    [GL.COMPRESSED_RGBA_S3TC_DXT5_EXT]: 'dxt5',
});

/**
 * How many bytes an S3TC image of this shape takes: one block per 4x4, with
 * a partial block still a whole block.
 *
 * @param {number} format
 * @param {number} width
 * @param {number} height
 * @returns {number} zero for a format that is not S3TC
 */
export function compressedBytes(format, width, height){
    const kind = S3TC_KIND[format];
    return kind === undefined ? 0 : s3tcCompressedBytes(kind, width, height);
}

/**
 * Decodes an S3TC image into RGBA texels.
 *
 * `GL_RGB_S3TC_DXT1` has no alpha channel at all, unlike its RGBA sibling: the
 * decoder always answers DXT1's punch-through index as transparent black, so
 * every texel's alpha is forced back to opaque here for the format that never
 * had one -- the only palette entry that can differ from opaque already.
 *
 * @param {Uint8Array} bytes
 * @param {number} format
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array | null} null when the bytes are too few, or not S3TC at all
 */
export function decodeS3tc(bytes, format, width, height){
    const kind = S3TC_KIND[format];
    if (kind === undefined)
    {
        return null;
    }
    const texels = decodeS3tcOf(bytes, kind, width, height);
    if (texels && format === GL.COMPRESSED_RGB_S3TC_DXT1_EXT)
    {
        for (let at = 3; at < texels.length; at += 4)
        {
            texels[at] = 255;
        }
    }
    return texels;
}

/**
 * A texel coordinate brought into range by the wrap mode.
 *
 * @param {number} i
 * @param {number} size
 * @param {number} wrap
 * @returns {number}
 */
function wrapTexel(i, size, wrap){
    switch (wrap)
    {
        case GL.REPEAT:
            return ((i % size) + size) % size;
        case GL.MIRRORED_REPEAT:
        {
            const period = size * 2;
            const m = ((i % period) + period) % period;
            return m < size ? m : period - 1 - m;
        }
        default:
            // GL_CLAMP would read the border colour half a texel out; the
            // edge is what a program that asked for it actually sees on the
            // hardware of the era, and it is what GL_CLAMP_TO_EDGE says.
            return i < 0 ? 0 : i >= size ? size - 1 : i;
    }
}

/**
 * @typedef {Object} SamplerParameters
 * @property {number} magFilter
 * @property {number} minFilter
 * @property {number} wrapS
 * @property {number} wrapT
 */

/**
 * Looks a texture up at (s, t).
 *
 * @param {TexelImage} image
 * @param {SamplerParameters} parameters
 * @param {number} s
 * @param {number} t
 * @returns {number[]} r, g, b, a, 0..255, fractional after filtering
 */
export function sample2D(image, parameters, s, t){
    const { width, height, texels } = image;
    const linear = parameters.magFilter === GL.LINEAR;
    const u = s * width;
    const v = t * height;
    if (!linear)
    {
        const x = wrapTexel(Math.floor(u), width, parameters.wrapS);
        const y = wrapTexel(Math.floor(v), height, parameters.wrapT);
        const at = (y * width + x) * 4;
        return [texels[at], texels[at + 1], texels[at + 2], texels[at + 3]];
    }
    const x0 = Math.floor(u - 0.5);
    const y0 = Math.floor(v - 0.5);
    const fx = u - 0.5 - x0;
    const fy = v - 0.5 - y0;
    const xa = wrapTexel(x0, width, parameters.wrapS);
    const xb = wrapTexel(x0 + 1, width, parameters.wrapS);
    const ya = wrapTexel(y0, height, parameters.wrapT);
    const yb = wrapTexel(y0 + 1, height, parameters.wrapT);
    const out = [0, 0, 0, 0];
    const corners = [
        [(ya * width + xa) * 4, (1 - fx) * (1 - fy)],
        [(ya * width + xb) * 4, fx * (1 - fy)],
        [(yb * width + xa) * 4, (1 - fx) * fy],
        [(yb * width + xb) * 4, fx * fy],
    ];
    for (const [at, weight] of corners)
    {
        for (let k = 0; k < 4; k++)
        {
            out[k] += texels[at + k] * weight;
        }
    }
    return out;
}

/**
 * Which cube face a direction lands on, and where.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{ face: number, s: number, t: number }} face is 0..5 in the
 *          order of the GL_TEXTURE_CUBE_MAP_* targets
 */
export function cubeFaceOf(x, y, z){
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    /** @type {number} */
    let face;
    /** @type {number} */
    let sc;
    /** @type {number} */
    let tc;
    /** @type {number} */
    let ma;
    if (ax >= ay && ax >= az)
    {
        ma = ax;
        face = x >= 0 ? 0 : 1;
        sc = x >= 0 ? -z : z;
        tc = -y;
    }
    else if (ay >= az)
    {
        ma = ay;
        face = y >= 0 ? 2 : 3;
        sc = x;
        tc = y >= 0 ? z : -z;
    }
    else
    {
        ma = az;
        face = z >= 0 ? 4 : 5;
        sc = z >= 0 ? x : -x;
        tc = -y;
    }
    if (ma === 0)
    {
        return { face: 0, s: 0.5, t: 0.5 };
    }
    return { face, s: (sc / ma + 1) / 2, t: (tc / ma + 1) / 2 };
}

/**
 * @typedef {Object} CombineState
 * @property {number} rgb        GL_COMBINE_RGB
 * @property {number} alpha      GL_COMBINE_ALPHA
 * @property {number[]} sourceRgb
 * @property {number[]} sourceAlpha
 * @property {number[]} operandRgb
 * @property {number[]} operandAlpha
 * @property {number} rgbScale
 * @property {number} alphaScale
 */

/**
 * @typedef {Object} TextureEnvironment
 * @property {number} mode        GL_TEXTURE_ENV_MODE
 * @property {number[]} colour    GL_TEXTURE_ENV_COLOR, 0..1
 * @property {CombineState} combine
 */

/** @returns {TextureEnvironment} the environment a fresh unit has */
export function createTextureEnvironment(){
    return {
        mode: GL.MODULATE,
        colour: [0, 0, 0, 0],
        combine: {
            rgb: GL.MODULATE,
            alpha: GL.MODULATE,
            sourceRgb: [GL.TEXTURE, GL.PREVIOUS, GL.CONSTANT],
            sourceAlpha: [GL.TEXTURE, GL.PREVIOUS, GL.CONSTANT],
            operandRgb: [GL.SRC_COLOR, GL.SRC_COLOR, GL.SRC_ALPHA],
            operandAlpha: [GL.SRC_ALPHA, GL.SRC_ALPHA, GL.SRC_ALPHA],
            rgbScale: 1,
            alphaScale: 1,
        },
    };
}

/** @param {number} value @returns {number} */
const clamp01 = value=>(value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * One texture unit's contribution: the fragment colour after this unit, as
 * the specification's tables give it per base format.
 *
 * All four colours are 0..1 here. `fragment` is the colour arriving at this
 * unit -- the primary colour for the first enabled unit, the previous unit's
 * result after that.
 *
 * @param {TextureEnvironment} env
 * @param {number} baseFormat
 * @param {readonly number[]} fragment
 * @param {readonly number[]} texel
 * @param {readonly number[]} primary  the fragment's own colour, for GL_COMBINE
 * @returns {number[]}
 */
export function applyTextureEnvironment(env, baseFormat, fragment, texel, primary){
    const cf = fragment;
    const ct = texel;
    const af = fragment[3];
    const at = texel[3];
    const hasColour = baseFormat !== GL.ALPHA;
    const hasAlpha = baseFormat === GL.RGBA || baseFormat === GL.LUMINANCE_ALPHA
        || baseFormat === GL.ALPHA || baseFormat === GL.INTENSITY;
    const intensity = baseFormat === GL.INTENSITY;
    switch (env.mode)
    {
        case GL.REPLACE:
            return [
                hasColour ? ct[0] : cf[0], hasColour ? ct[1] : cf[1], hasColour ? ct[2] : cf[2],
                hasAlpha ? at : af,
            ];
        case GL.MODULATE:
            return [
                hasColour ? cf[0] * ct[0] : cf[0],
                hasColour ? cf[1] * ct[1] : cf[1],
                hasColour ? cf[2] * ct[2] : cf[2],
                hasAlpha ? af * at : af,
            ];
        case GL.DECAL:
            if (baseFormat === GL.RGB)
            {
                return [ct[0], ct[1], ct[2], af];
            }
            return [
                cf[0] * (1 - at) + ct[0] * at,
                cf[1] * (1 - at) + ct[1] * at,
                cf[2] * (1 - at) + ct[2] * at,
                af,
            ];
        case GL.BLEND:
        {
            const cc = env.colour;
            return [
                hasColour ? cf[0] * (1 - ct[0]) + cc[0] * ct[0] : cf[0],
                hasColour ? cf[1] * (1 - ct[1]) + cc[1] * ct[1] : cf[1],
                hasColour ? cf[2] * (1 - ct[2]) + cc[2] * ct[2] : cf[2],
                intensity ? af * (1 - at) + cc[3] * at : hasAlpha ? af * at : af,
            ];
        }
        case GL.ADD:
            return [
                hasColour ? clamp01(cf[0] + ct[0]) : cf[0],
                hasColour ? clamp01(cf[1] + ct[1]) : cf[1],
                hasColour ? clamp01(cf[2] + ct[2]) : cf[2],
                intensity ? clamp01(af + at) : hasAlpha ? af * at : af,
            ];
        case GL.COMBINE:
            return combine(env, fragment, texel, primary);
        default:
            return [...fragment];
    }
}

/**
 * @param {number} source
 * @param {readonly number[]} fragment
 * @param {readonly number[]} texel
 * @param {readonly number[]} primary
 * @param {readonly number[]} constant
 * @returns {readonly number[]}
 */
function combineSource(source, fragment, texel, primary, constant){
    switch (source)
    {
        case GL.TEXTURE:
            return texel;
        case GL.CONSTANT:
            return constant;
        case GL.PRIMARY_COLOR:
            return primary;
        default:
            return fragment;
    }
}

/**
 * @param {number} operand
 * @param {readonly number[]} colour
 * @param {number} channel
 * @returns {number}
 */
function combineOperand(operand, colour, channel){
    switch (operand)
    {
        case GL.ONE_MINUS_SRC_COLOR:
            return 1 - colour[channel];
        case GL.SRC_ALPHA:
            return colour[3];
        case GL.ONE_MINUS_SRC_ALPHA:
            return 1 - colour[3];
        default:
            return colour[channel];
    }
}

/**
 * @param {number} function_
 * @param {readonly number[]} a0
 * @param {readonly number[]} a1
 * @param {readonly number[]} a2
 * @param {number} k
 * @returns {number}
 */
function combineChannel(function_, a0, a1, a2, k){
    switch (function_)
    {
        case GL.REPLACE:
            return a0[k];
        case GL.MODULATE:
            return a0[k] * a1[k];
        case GL.ADD:
            return a0[k] + a1[k];
        case GL.ADD_SIGNED:
            return a0[k] + a1[k] - 0.5;
        case GL.INTERPOLATE:
            return a0[k] * a2[k] + a1[k] * (1 - a2[k]);
        case GL.SUBTRACT:
            return a0[k] - a1[k];
        case GL.DOT3_RGB:
        case GL.DOT3_RGBA:
            return 4 * ((a0[0] - 0.5) * (a1[0] - 0.5) + (a0[1] - 0.5) * (a1[1] - 0.5)
                + (a0[2] - 0.5) * (a1[2] - 0.5));
        default:
            return a0[k];
    }
}

/**
 * GL_COMBINE, per the ARB_texture_env_combine and _dot3 tables.
 *
 * @param {TextureEnvironment} env
 * @param {readonly number[]} fragment
 * @param {readonly number[]} texel
 * @param {readonly number[]} primary
 * @returns {number[]}
 */
function combine(env, fragment, texel, primary){
    const c = env.combine;
    const args = [0, 1, 2].map(i=>{
        const rgb = combineSource(c.sourceRgb[i], fragment, texel, primary, env.colour);
        const alpha = combineSource(c.sourceAlpha[i], fragment, texel, primary, env.colour);
        return {
            rgb: [0, 1, 2].map(k=>combineOperand(c.operandRgb[i], rgb, k)),
            alpha: combineOperand(c.operandAlpha[i], alpha, 3),
        };
    });
    const rgbArgs = args.map(arg=>arg.rgb);
    const out = [0, 1, 2].map(k=>clamp01(
        combineChannel(c.rgb, rgbArgs[0], rgbArgs[1], rgbArgs[2], k) * c.rgbScale));
    const alphaArgs = args.map(arg=>[arg.alpha]);
    const alpha = c.rgb === GL.DOT3_RGBA
        ? out[0]
        : clamp01(combineChannel(c.alpha, alphaArgs[0], alphaArgs[1], alphaArgs[2], 0)
            * c.alphaScale);
    return [out[0], out[1], out[2], alpha];
}
