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
 * (one and two channels of the same interpolated block) here -- and an
 * alpha-only texture is widened to four channels with its colour zero, which
 * is what sampling one answers.
 */

import { decodeS3tc } from '../webgpu/internal/s3tc.js';
import { decodeBc67 } from './bc67.js';

/** @typedef {'bc1' | 'bc2' | 'bc3' | 'bc4u' | 'bc4s' | 'bc5u' | 'bc5s' | 'bc6hu' | 'bc6hs'
 *     | 'bc7' | 'a8' | SixteenBit} Conversion */

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
    return conversion === 'a8' ? 1 : 0;
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
    const values = new Float32Array(floats.buffer.slice(floats.byteOffset,
        floats.byteOffset + (floats.byteLength & ~3)));
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
 * The eight values a BC4 block's endpoints stand for: eight interpolated when
 * the first endpoint is the larger, otherwise six and the two extremes.
 *
 * @param {number} e0
 * @param {number} e1
 * @param {number} low   The extreme of the signed or unsigned range.
 * @param {number} high
 * @returns {number[]}
 */
function endpointTable(e0, e1, low, high){
    if (e0 > e1)
    {
        return [e0, e1, ...[6, 5, 4, 3, 2, 1].map(k=>Math.round((k * e0 + (7 - k) * e1) / 7))];
    }
    return [e0, e1, ...[4, 3, 2, 1].map(k=>Math.round((k * e0 + (5 - k) * e1) / 5)), low, high];
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
    for (let by = 0; by < down; by++)
    {
        for (let bx = 0; bx < across; bx++)
        {
            const at = (by * across + bx) * blockStride + blockOffset;
            const table = signed
                ? endpointTable(endpoint(bytes[at]), endpoint(bytes[at + 1]), -127, 127)
                : endpointTable(bytes[at], bytes[at + 1], 0, 255);
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
