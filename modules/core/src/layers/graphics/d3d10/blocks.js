/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texels a GPU without a format of its own reads in one it has.
 *
 * A resource keeps the bytes the program wrote, in the layout the program
 * expects to map back; only what goes to the GPU is converted, one
 * subresource at a time, when the device cannot sample the format as it is.
 * The block-compressed formats are decoded where the adapter has no BC
 * sampling -- BC1 to BC3 through the decoder the other APIs share, BC4 and BC5
 * (one and two channels of DXT5's interpolated block, signed or not) here -- and an
 * alpha-only texture is widened to four channels with its colour zero, which
 * is what sampling one answers.
 */

import { alphaLevels, decodeS3tc } from '../../media/internal/s3tc.js';
import { decodeBc67 } from './bc67.js';

/** @typedef {'bc1' | 'bc2' | 'bc3' | 'bc4u' | 'bc4s' | 'bc5u' | 'bc5s' | 'bc6hu' | 'bc6hs'
 *     | 'bc7' | 'a8' | ThreeWords | SixteenBit} Conversion */

/**
 * A format of three 32-bit channels, which WebGPU has no texture of: kept in
 * four, the fourth what sampling one answers (one, or 1.0), named by the
 * format that stands in.
 *
 * @typedef {'rgba32float' | 'rgba32uint' | 'rgba32sint'} ThreeWords
 */

/** Each three-word conversion's fourth word: 1.0's bits for floats, 1 for integers. */
const THREE_WORDS = Object.freeze({ rgba32float: 0x3f800000, rgba32uint: 1, rgba32sint: 1 });

/**
 * Whether a conversion keeps a format of three 32-bit channels in four.
 *
 * @param {Conversion | null | undefined} conversion
 * @returns {conversion is ThreeWords}
 */
export const isThreeWords = conversion=>!!conversion && conversion in THREE_WORDS;

/**
 * A 16-bit normalised format kept in 32-bit floats of its channels, on a GPU
 * without texture-formats-tier1 (`gpuformats.js`): the conversion is named
 * by the format the program's bytes are in.
 *
 * @typedef {'r16unorm' | 'rg16unorm' | 'rgba16unorm' | 'r16snorm' | 'rg16snorm' | 'rgba16snorm'}
 *     SixteenBit
 */

/** Each 16-bit normalised conversion's channels, and whether it is signed. */
const SIXTEEN_BIT = Object.freeze({
    r16unorm: { channels: 1, signed: false }, rg16unorm: { channels: 2, signed: false },
    rgba16unorm: { channels: 4, signed: false }, r16snorm: { channels: 1, signed: true },
    rg16snorm: { channels: 2, signed: true }, rgba16snorm: { channels: 4, signed: true },
});

/**
 * Whether a conversion keeps a 16-bit normalised format in floats.
 *
 * @param {Conversion | null | undefined} conversion
 * @returns {conversion is SixteenBit}
 */
export const isSixteenBit = conversion=>!!conversion && conversion in SIXTEEN_BIT;

/**
 * The bytes a texel of a converted format is in the program's own layout.
 *
 * @param {Conversion} conversion
 */
export function programTexelBytes(conversion){
    if (isSixteenBit(conversion))
    {
        return SIXTEEN_BIT[conversion].channels * 2;
    }
    if (isThreeWords(conversion))
    {
        return 12;
    }
    return conversion === 'a8' ? 1 : 0;
}

/**
 * The words of `byteLength` bytes, for a conversion that reads them once:
 * over the bytes themselves where they are aligned for it, copied only where
 * not.
 *
 * @param {Uint8Array} bytes @param {number} byteLength
 */
const wordsOver = (bytes, byteLength)=>((bytes.byteOffset & 3) === 0
    ? new Uint32Array(bytes.buffer, bytes.byteOffset, byteLength >>> 2)
    : new Uint32Array(bytes.slice(0, byteLength).buffer));

/**
 * Texels kept in four 32-bit channels as the program's three: the fourth dropped.
 *
 * @param {Uint8Array} four
 * @returns {Uint8Array}
 */
export function threeWordsFromFour(four){
    const words = wordsOver(four, four.byteLength & ~15);
    const out = new Uint32Array((words.length >>> 2) * 3);
    for (let index = 0; index < out.length / 3; index++)
    {
        out[index * 3] = words[index * 4];
        out[index * 3 + 1] = words[index * 4 + 1];
        out[index * 3 + 2] = words[index * 4 + 2];
    }
    return new Uint8Array(out.buffer);
}

/**
 * Texels kept in floats as the program's 16-bit normalised ones: each value
 * held to its range and rounded to the nearest code, as the GPU stores a
 * value written to such a format.
 *
 * @param {SixteenBit} conversion @param {Uint8Array} floats  little-endian float32s
 * @returns {Uint8Array}
 */
export function sixteenBitFromFloats(conversion, floats){
    const { signed } = SIXTEEN_BIT[conversion];
    const words = wordsOver(floats, floats.byteLength & ~3);
    const values = new Float32Array(words.buffer, words.byteOffset, words.length);
    const out = new Uint8Array(values.length * 2);
    const view = new DataView(out.buffer);
    for (let at = 0; at < values.length; at++)
    {
        const value = Number.isNaN(values[at]) ? 0 : values[at];
        if (signed)
        {
            view.setInt16(at * 2, Math.round(Math.min(1, Math.max(-1, value)) * 32767), true);
        }
        else
        {
            view.setUint16(at * 2, Math.round(Math.min(1, Math.max(0, value)) * 65535), true);
        }
    }
    return out;
}

/**
 * One channel of BC4 blocks into every `stride`-th byte of `out`, starting at
 * `channel`.
 *
 * @param {Uint8Array} bytes
 * @param {number} blockStride  Bytes from one block of this channel to the next.
 * @param {number} blockOffset  Where this channel's half of a block starts.
 * @param {boolean} signed
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} out
 * @param {number} stride
 * @param {number} channel
 */
function decodeChannel(bytes, blockStride, blockOffset, signed, width, height, out, stride,
    channel)
{
    const across = Math.ceil(width / 4);
    const down = Math.ceil(height / 4);
    /** @param {number} byte */
    const endpoint = byte=>(signed ? Math.max(-127, (byte << 24) >> 24) : byte);
    const table = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let by = 0; by < down; by++)
    {
        for (let bx = 0; bx < across; bx++)
        {
            const at = (by * across + bx) * blockStride + blockOffset;
            alphaLevels(endpoint(bytes[at]), endpoint(bytes[at + 1]), signed ? -127 : 0,
                signed ? 127 : 255, table);
            for (let i = 0; i < 16; i++)
            {
                const x = bx * 4 + (i & 3);
                const y = by * 4 + (i >> 2);
                if (x >= width || y >= height)
                {
                    continue;
                }
                // Forty-eight bits of three-bit indices, low bits first.
                const bit = i * 3;
                const pair = bytes[at + 2 + (bit >> 3)] | (bytes[at + 3 + (bit >> 3)] << 8);
                out[(y * width + x) * stride + channel] = table[(pair >> (bit & 7)) & 7] & 0xff;
            }
        }
    }
}

/**
 * @param {Conversion} conversion
 * @returns {number} bytes per texel of what the conversion produces
 */
export function convertedTexelBytes(conversion){
    switch (conversion)
    {
        case 'bc4u':
        case 'bc4s':
            return 1;
        case 'bc5u':
        case 'bc5s':
            return 2;
        case 'bc6hu':
        case 'bc6hs':
            return 8;
        case 'rgba32float':
        case 'rgba32uint':
        case 'rgba32sint':
            return 16;
        default:
            return isSixteenBit(conversion) ? SIXTEEN_BIT[conversion].channels * 4 : 4;
    }
}

/**
 * One subresource's texels as the GPU format that stands in for its own.
 *
 * @param {Conversion} conversion
 * @param {Uint8Array} bytes  The subresource, tightly packed in its own format.
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array | null} null when the bytes are too few for the shape
 */
export function convertTexels(conversion, bytes, width, height){
    switch (conversion)
    {
        case 'bc1':
            return decodeS3tc(bytes, 'dxt1', width, height);
        case 'bc2':
            return decodeS3tc(bytes, 'dxt3', width, height);
        case 'bc3':
            return decodeS3tc(bytes, 'dxt5', width, height);
        case 'bc6hu':
        case 'bc6hs':
        case 'bc7':
            return decodeBc67(bytes, conversion, width, height);
        case 'r16unorm':
        case 'rg16unorm':
        case 'rgba16unorm':
        case 'r16snorm':
        case 'rg16snorm':
        case 'rgba16snorm': {
            // Exact in a float: sixteen bits fit its twenty-four of mantissa.
            const { channels, signed } = SIXTEEN_BIT[conversion];
            const count = width * height * channels;
            if (bytes.length < count * 2)
            {
                return null;
            }
            const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
            const values = new Float32Array(count);
            for (let at = 0; at < count; at++)
            {
                values[at] = signed ? Math.max(-1, view.getInt16(at * 2, true) / 32767)
                    : view.getUint16(at * 2, true) / 65535;
            }
            return new Uint8Array(values.buffer);
        }
        case 'rgba32float':
        case 'rgba32uint':
        case 'rgba32sint': {
            const count = width * height;
            if (bytes.length < count * 12)
            {
                return null;
            }
            const words = wordsOver(bytes, count * 12);
            const out = new Uint32Array(count * 4);
            for (let index = 0; index < count; index++)
            {
                out[index * 4] = words[index * 3];
                out[index * 4 + 1] = words[index * 3 + 1];
                out[index * 4 + 2] = words[index * 3 + 2];
                out[index * 4 + 3] = THREE_WORDS[conversion];
            }
            return new Uint8Array(out.buffer);
        }
        case 'a8': {
            if (bytes.length < width * height)
            {
                return null;
            }
            const out = new Uint8Array(width * height * 4);
            for (let index = 0; index < width * height; index++)
            {
                out[index * 4 + 3] = bytes[index];
            }
            return out;
        }
        default: {
            const two = conversion === 'bc5u' || conversion === 'bc5s';
            const signed = conversion === 'bc4s' || conversion === 'bc5s';
            const blockStride = two ? 16 : 8;
            if (bytes.length < Math.ceil(width / 4) * Math.ceil(height / 4) * blockStride)
            {
                return null;
            }
            const stride = two ? 2 : 1;
            const out = new Uint8Array(width * height * stride);
            decodeChannel(bytes, blockStride, 0, signed, width, height, out, stride, 0);
            if (two)
            {
                decodeChannel(bytes, blockStride, 8, signed, width, height, out, stride, 1);
            }
            return out;
        }
    }
}
