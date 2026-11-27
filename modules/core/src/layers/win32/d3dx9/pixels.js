/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texels between the Direct3D 9 formats D3DX loads into and one working form:
 * eight bits each of blue, green, red and alpha, in that byte order (what
 * D3DFMT_A8R8G8B8 is in memory). A loader decodes a file into it, scales and
 * filters it, and encodes it into the format the texture was made in.
 *
 * The block-compressed formats go through the S3TC codec every drawing API
 * shares (media/internal/s3tc.js): decoded as the specification states them,
 * encoded with a range fit, which is what a loader without a quality setting
 * owes.
 */

import { compressedBytes, decodeS3tc, encodeS3tc } from '../../media/internal/s3tc.js';

/** @typedef {import('../../media/internal/s3tc.js').S3tcKind} S3tcKind */

/** D3DFORMAT values. */
export const FMT = Object.freeze({
    UNKNOWN: 0, R8G8B8: 20, A8R8G8B8: 21, X8R8G8B8: 22, R5G6B5: 23, X1R5G5B5: 24,
    A1R5G5B5: 25, A4R4G4B4: 26, A8: 28, X4R4G4B4: 30, A8B8G8R8: 32, X8B8G8R8: 33,
    G16R16: 34, A16B16G16R16: 36, P8: 41, L8: 50, A8L8: 51, V8U8: 60, Q8W8V8U8: 63,
    V16U16: 64, L16: 81,
    DXT1: 0x31545844, DXT2: 0x32545844, DXT3: 0x33545844, DXT4: 0x34545844,
    DXT5: 0x35545844,
});

/** @param {number} format */
export const isCompressed = format=>format === FMT.DXT1 || format === FMT.DXT2
    || format === FMT.DXT3 || format === FMT.DXT4 || format === FMT.DXT5;

/**
 * Whether a file's level is held in its own format rather than the working
 * form: a compressed one, and one with more than eight bits a channel, which
 * the working form would cut, or signed ones, which it holds offset by half
 * the range. A texture of that same format takes it as it is.
 *
 * @param {number} format
 */
export const keptAsIs = format=>isCompressed(format) || DEEP_OR_SIGNED.has(format);

/** Bytes a texel takes, for the formats this module reads and writes uncompressed. */
/** @type {Map<number, number>} */
const TEXEL_BYTES = new Map([[FMT.R8G8B8, 3], [FMT.A8R8G8B8, 4], [FMT.X8R8G8B8, 4],
    [FMT.R5G6B5, 2], [FMT.X1R5G5B5, 2], [FMT.A1R5G5B5, 2], [FMT.A4R4G4B4, 2],
    [FMT.X4R4G4B4, 2], [FMT.A8, 1], [FMT.L8, 1], [FMT.A8L8, 2], [FMT.A8B8G8R8, 4],
    [FMT.X8B8G8R8, 4], [FMT.L16, 2], [FMT.G16R16, 4], [FMT.A16B16G16R16, 8], [FMT.V8U8, 2],
    [FMT.Q8W8V8U8, 4], [FMT.V16U16, 4]]);

/**
 * The formats a file's level is held in as it is (`keptAsIs`), beside the compressed ones.
 *
 * @type {Set<number>}
 */
const DEEP_OR_SIGNED = new Set([FMT.L16, FMT.G16R16, FMT.A16B16G16R16, FMT.V8U8, FMT.Q8W8V8U8,
    FMT.V16U16]);

/** @param {number} format */
export const isSupported = format=>TEXEL_BYTES.has(format) || isCompressed(format);

/**
 * Formats this module has no codec for, by the bytes a texel takes: a level
 * of one is copied row by row into a surface of the same format and size, as
 * D3DX copies it, and goes no other way. A2B10G10R10, A2R10G10B10, R16F,
 * G16R16F, A16B16G16R16F, R32F, G32R32F, A32B32G32R32F.
 *
 * @type {Map<number, number>}
 */
const COPIED_BYTES = new Map([[31, 4], [35, 4], [111, 2], [112, 4], [113, 8], [114, 4], [115, 8],
    [116, 16]]);

/**
 * Whether a level of this format can be copied into a surface of the same
 * format and size.
 *
 * @param {number} format
 */
export const isCopyable = format=>isSupported(format) || COPIED_BYTES.has(format);

/** @param {number} format */
const blockBytes = format=>(format === FMT.DXT1 ? 8 : 16);

/**
 * A row's bytes as the format packs it -- a row of 4x4 blocks for a compressed
 * one -- and how many such rows a level of that height has.
 *
 * @param {number} format @param {number} width @param {number} height
 */
export function layoutOf(format, width, height){
    if (isCompressed(format))
    {
        return { rowBytes: Math.max(1, Math.ceil(width / 4)) * blockBytes(format),
            rows: Math.max(1, Math.ceil(height / 4)) };
    }
    return { rowBytes: width * /** @type {number} */ (TEXEL_BYTES.get(format)
        ?? COPIED_BYTES.get(format)), rows: height };
}

/** @param {number} value @param {number} bits */
const expand = (value, bits)=>Math.round(value * 255 / ((1 << bits) - 1));
/** A sixteen-bit channel in eight. @param {number} value */
const narrow = value=>Math.round(value * 255 / 65535);
/** @param {number} value @param {number} bits */
const reduce = (value, bits)=>Math.round(value * ((1 << bits) - 1) / 255);

/**
 * A level in the working form.
 *
 * @param {number} format @param {Uint8Array} data @param {number} width @param {number} height
 * @param {Uint8Array} [palette]  P8's 256 entries, PALETTEENTRY order (r, g, b, flags).
 * @returns {Uint8Array}
 */
export function decodeTexels(format, data, width, height, palette){
    const out = new Uint8Array(width * height * 4);
    if (isCompressed(format))
    {
        decodeBlocks(format, data, width, height, out);
        return out;
    }
    const bytes = format === FMT.P8 ? 1 : /** @type {number} */ (TEXEL_BYTES.get(format));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < width * height; i++)
    {
        const at = i * bytes;
        let b = 0;
        let g = 0;
        let r = 0;
        let a = 255;
        switch (format)
        {
            case FMT.A8R8G8B8: case FMT.X8R8G8B8: case FMT.R8G8B8:
                b = data[at];
                g = data[at + 1];
                r = data[at + 2];
                a = format === FMT.A8R8G8B8 ? data[at + 3] : 255;
                break;
            case FMT.A8B8G8R8: case FMT.X8B8G8R8:
                r = data[at];
                g = data[at + 1];
                b = data[at + 2];
                a = format === FMT.A8B8G8R8 ? data[at + 3] : 255;
                break;
            case FMT.R5G6B5: {
                const v = view.getUint16(at, true);
                r = expand(v >> 11, 5);
                g = expand(v >> 5 & 63, 6);
                b = expand(v & 31, 5);
                break;
            }
            case FMT.X1R5G5B5: case FMT.A1R5G5B5: {
                const v = view.getUint16(at, true);
                r = expand(v >> 10 & 31, 5);
                g = expand(v >> 5 & 31, 5);
                b = expand(v & 31, 5);
                a = format === FMT.A1R5G5B5 ? (v >> 15) * 255 : 255;
                break;
            }
            case FMT.A4R4G4B4: case FMT.X4R4G4B4: {
                const v = view.getUint16(at, true);
                r = expand(v >> 8 & 15, 4);
                g = expand(v >> 4 & 15, 4);
                b = expand(v & 15, 4);
                a = format === FMT.A4R4G4B4 ? expand(v >> 12, 4) : 255;
                break;
            }
            case FMT.A8:
                a = data[at];
                break;
            case FMT.L8:
                r = g = b = data[at];
                break;
            case FMT.A8L8:
                r = g = b = data[at];
                a = data[at + 1];
                break;
            case FMT.L16:
                r = g = b = narrow(view.getUint16(at, true));
                break;
            // Red in the low word, then green (and blue and alpha), each sixteen bits.
            case FMT.G16R16:
                r = narrow(view.getUint16(at, true));
                g = narrow(view.getUint16(at + 2, true));
                break;
            case FMT.A16B16G16R16:
                r = narrow(view.getUint16(at, true));
                g = narrow(view.getUint16(at + 2, true));
                b = narrow(view.getUint16(at + 4, true));
                a = narrow(view.getUint16(at + 6, true));
                break;
            // Signed: U in the low byte (red), then V, W, Q; zero held as 128.
            case FMT.V8U8:
                r = view.getInt8(at) + 128;
                g = view.getInt8(at + 1) + 128;
                break;
            case FMT.Q8W8V8U8:
                r = view.getInt8(at) + 128;
                g = view.getInt8(at + 1) + 128;
                b = view.getInt8(at + 2) + 128;
                a = view.getInt8(at + 3) + 128;
                break;
            case FMT.V16U16:
                r = (view.getInt16(at, true) >> 8) + 128;
                g = (view.getInt16(at + 2, true) >> 8) + 128;
                break;
            case FMT.P8: {
                const entry = /** @type {Uint8Array} */ (palette).subarray(data[at] * 4);
                r = entry[0];
                g = entry[1];
                b = entry[2];
                break;
            }
            default:
                throw new Error(`no decoder for format ${format}`);
        }
        out[i * 4] = b;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = r;
        out[i * 4 + 3] = a;
    }
    return out;
}

/**
 * A level in the working form, encoded into `format`, rows packed.
 *
 * @param {number} format @param {Uint8Array} bgra @param {number} width @param {number} height
 * @returns {Uint8Array}
 */
export function encodeTexels(format, bgra, width, height){
    if (isCompressed(format))
    {
        return encodeBlocks(format, bgra, width, height);
    }
    const bytes = /** @type {number} */ (TEXEL_BYTES.get(format));
    const out = new Uint8Array(width * height * bytes);
    const view = new DataView(out.buffer);
    for (let i = 0; i < width * height; i++)
    {
        const b = bgra[i * 4];
        const g = bgra[i * 4 + 1];
        const r = bgra[i * 4 + 2];
        const a = bgra[i * 4 + 3];
        const at = i * bytes;
        switch (format)
        {
            case FMT.A8R8G8B8: case FMT.X8R8G8B8: case FMT.R8G8B8:
                out[at] = b;
                out[at + 1] = g;
                out[at + 2] = r;
                if (bytes === 4)
                {
                    out[at + 3] = format === FMT.A8R8G8B8 ? a : 255;
                }
                break;
            case FMT.A8B8G8R8: case FMT.X8B8G8R8:
                out[at] = r;
                out[at + 1] = g;
                out[at + 2] = b;
                out[at + 3] = format === FMT.A8B8G8R8 ? a : 255;
                break;
            case FMT.R5G6B5:
                view.setUint16(at, reduce(r, 5) << 11 | reduce(g, 6) << 5 | reduce(b, 5), true);
                break;
            case FMT.X1R5G5B5: case FMT.A1R5G5B5:
                view.setUint16(at, (format === FMT.A1R5G5B5 ? (a >= 128 ? 1 : 0) : 1) << 15
                    | reduce(r, 5) << 10 | reduce(g, 5) << 5 | reduce(b, 5), true);
                break;
            case FMT.A4R4G4B4: case FMT.X4R4G4B4:
                view.setUint16(at, (format === FMT.A4R4G4B4 ? reduce(a, 4) : 15) << 12
                    | reduce(r, 4) << 8 | reduce(g, 4) << 4 | reduce(b, 4), true);
                break;
            case FMT.A8:
                out[at] = a;
                break;
            case FMT.L8:
                out[at] = luminance(r, g, b);
                break;
            case FMT.A8L8:
                out[at] = luminance(r, g, b);
                out[at + 1] = a;
                break;
            case FMT.L16:
                view.setUint16(at, luminance(r, g, b) * 257, true);
                break;
            case FMT.G16R16:
                view.setUint16(at, r * 257, true);
                view.setUint16(at + 2, g * 257, true);
                break;
            case FMT.A16B16G16R16:
                view.setUint16(at, r * 257, true);
                view.setUint16(at + 2, g * 257, true);
                view.setUint16(at + 4, b * 257, true);
                view.setUint16(at + 6, a * 257, true);
                break;
            case FMT.V8U8:
                view.setInt8(at, r - 128);
                view.setInt8(at + 1, g - 128);
                break;
            case FMT.Q8W8V8U8:
                view.setInt8(at, r - 128);
                view.setInt8(at + 1, g - 128);
                view.setInt8(at + 2, b - 128);
                view.setInt8(at + 3, a - 128);
                break;
            case FMT.V16U16:
                view.setInt16(at, (r - 128) * 256, true);
                view.setInt16(at + 2, (g - 128) * 256, true);
                break;
            default:
                throw new Error(`no encoder for format ${format}`);
        }
    }
    return out;
}

/** BT.709's weights, which D3DX converts colour to luminance with. */
const luminance = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b)=>
    Math.min(255, Math.round(r * 0.2125 + g * 0.7154 + b * 0.0721));

/** The S3TC kind each DXTn format's blocks are: DXT2 and DXT4 are DXT3's and DXT5's bits. */
const KIND = new Map(/** @type {[number, S3tcKind][]} */ ([
    [FMT.DXT1, 'dxt1'], [FMT.DXT2, 'dxt3'], [FMT.DXT3, 'dxt3'], [FMT.DXT4, 'dxt5'],
    [FMT.DXT5, 'dxt5']]));

/**
 * Swaps the first and third byte of every texel: the working form's BGRA and
 * the codec's RGBA, either way.
 *
 * @param {Uint8Array} texels
 */
function swapRedBlue(texels){
    for (let at = 0; at < texels.length; at += 4)
    {
        const red = texels[at];
        texels[at] = texels[at + 2];
        texels[at + 2] = red;
    }
}

/**
 * @param {number} format @param {Uint8Array} data @param {number} width @param {number} height
 * @param {Uint8Array} out
 */
function decodeBlocks(format, data, width, height, out){
    if (decodeS3tc(data, /** @type {S3tcKind} */ (KIND.get(format)), width, height, out) === null)
    {
        throw new Error(`a ${width}x${height} level of format ${format} in ${data.length} bytes`);
    }
    swapRedBlue(out);
}

/**
 * @param {number} format @param {Uint8Array} bgra @param {number} width @param {number} height
 * @returns {Uint8Array}
 */
function encodeBlocks(format, bgra, width, height){
    const kind = /** @type {S3tcKind} */ (KIND.get(format));
    const rgba = bgra.slice();
    swapRedBlue(rgba);
    const out = new Uint8Array(compressedBytes(kind, width, height));
    encodeS3tc(rgba, kind, width, height, out);
    return out;
}

/**
 * The next smaller level: each texel the average of the two by two it covers,
 * the edge repeated where a side is odd (D3DX_FILTER_BOX).
 *
 * @param {Uint8Array} bgra @param {number} width @param {number} height
 * @returns {{ bgra: Uint8Array, width: number, height: number }}
 */
export function halve(bgra, width, height){
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
    {
        for (let x = 0; x < w; x++)
        {
            const x0 = Math.min(width - 1, x * 2);
            const x1 = Math.min(width - 1, x * 2 + 1);
            const y0 = Math.min(height - 1, y * 2);
            const y1 = Math.min(height - 1, y * 2 + 1);
            for (let c = 0; c < 4; c++)
            {
                out[(y * w + x) * 4 + c] = (bgra[(y0 * width + x0) * 4 + c]
                    + bgra[(y0 * width + x1) * 4 + c] + bgra[(y1 * width + x0) * 4 + c]
                    + bgra[(y1 * width + x1) * 4 + c] + 2) >> 2;
            }
        }
    }
    return { bgra: out, width: w, height: h };
}

/**
 * The level stretched to another size, each texel the one its centre falls on.
 *
 * @param {Uint8Array} bgra @param {number} width @param {number} height
 * @param {number} toWidth @param {number} toHeight
 * @returns {Uint8Array}
 */
export function resample(bgra, width, height, toWidth, toHeight){
    // ponytail: point sampling where D3DX filters (triangle by default); a filter
    // when a program's picture shows the difference.
    const out = new Uint8Array(toWidth * toHeight * 4);
    for (let y = 0; y < toHeight; y++)
    {
        const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / toHeight));
        for (let x = 0; x < toWidth; x++)
        {
            const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / toWidth));
            out.set(bgra.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4),
                (y * toWidth + x) * 4);
        }
    }
    return out;
}
