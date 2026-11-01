/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What ClearUnorderedAccessViewUint and ClearUnorderedAccessViewFloat write,
 * worked out from the view's format by its channels as DXGI names them.
 *
 * A Uint clear copies the low bits of each value into its channel, whatever
 * the format, with no conversion. A Float clear converts each value to its
 * channel's format, and on an integer format does nothing. A raw or
 * structured buffer has no format: a Uint clear writes the first value into
 * every dword, and a Float clear does nothing.
 */

import { DXGI_FORMAT } from './constants.js';

/** Each channel's value, by the channel's letter in the format's name. */
const VALUE_OF = Object.freeze({ R: 0, G: 1, B: 2, A: 3 });

/**
 * A format's channels in memory order, from the lowest bit up, and the type
 * they hold; null for one with shared exponents, blocks, or no channels.
 *
 * @param {number} format
 * @returns {{ channels: { value: number, bits: number }[], type: string } | null}
 */
export function channelsOf(format){
    const name = Object.keys(DXGI_FORMAT).find(key=>/** @type {Record<string, number>} */
        (DXGI_FORMAT)[key] === format);
    const match = name ? /^((?:[RGBA]\d+)+)_(FLOAT|UNORM|SNORM|UINT|SINT)$/.exec(name) : null;
    if (!match)
    {
        return null;
    }
    const channels = [...match[1].matchAll(/([RGBA])(\d+)/g)].map(([, letter, bits])=>({
        value: VALUE_OF[/** @type {'R' | 'G' | 'B' | 'A'} */ (letter)], bits: Number(bits),
    }));
    // A float of other than 16 or 32 bits shares or drops its sign: R11G11B10.
    if (match[2] === 'FLOAT' && channels.some(channel=>channel.bits !== 16
        && channel.bits !== 32))
    {
        return null;
    }
    return { channels, type: match[2] };
}

const word = new DataView(new ArrayBuffer(4));

/** @param {number} value @returns {number} the bits of the nearest single */
const singleBits = value=>{
    word.setFloat32(0, value, true);
    return word.getUint32(0, true);
};

/**
 * A single's bits as a half's, rounded to nearest even; past the range an
 * infinity, below it a denormal or zero.
 *
 * @param {number} value
 */
export function halfBits(value){
    const bits = singleBits(value);
    const sign = (bits >>> 16) & 0x8000;
    const exponent = (bits >>> 23) & 0xff;
    const mantissa = bits & 0x7fffff;
    if (exponent === 0xff)
    {
        return sign | 0x7c00 | (mantissa ? 0x200 : 0);
    }
    const unbiased = exponent - 127 + 15;
    if (unbiased >= 0x1f)
    {
        return sign | 0x7c00;
    }
    if (unbiased <= 0)
    {
        if (unbiased < -10)
        {
            return sign;
        }
        const full = mantissa | 0x800000;
        const shift = 14 - unbiased;
        const half = full >>> shift;
        const rest = full & ((1 << shift) - 1);
        const midpoint = 1 << (shift - 1);
        return sign | (half + (rest > midpoint || (rest === midpoint && (half & 1)) ? 1 : 0));
    }
    const half = (unbiased << 10) | (mantissa >>> 13);
    const rest = mantissa & 0x1fff;
    return sign | (half + (rest > 0x1000 || (rest === 0x1000 && (half & 1)) ? 1 : 0));
}

/** @param {number} bits @returns {number} */
export function halfOf(bits){
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0)
    {
        return sign * mantissa * 2 ** -24;
    }
    if (exponent === 0x1f)
    {
        return mantissa ? NaN : sign * Infinity;
    }
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * A channel's bits for a Float clear's value.
 *
 * @param {number} value @param {number} bits @param {string} type
 */
function convert(value, bits, type){
    const top = 2 ** bits - 1;
    switch (type)
    {
        case 'FLOAT':
            return bits === 32 ? singleBits(value) : halfBits(value);
        case 'UNORM':
            return Math.round(Math.min(1, Math.max(0, value || 0)) * top);
        default: {
            const most = 2 ** (bits - 1) - 1;
            return Math.round(Math.min(1, Math.max(-1, value || 0)) * most) & top;
        }
    }
}

/**
 * The bits each channel takes, in the format's channel order; null where
 * the clear does nothing on this format.
 *
 * @param {number} format @param {readonly number[]} values @param {boolean} float
 * @returns {{ channels: { value: number, bits: number }[], type: string,
 *     bits: number[] } | null}
 */
function channelBits(format, values, float){
    const shape = channelsOf(format);
    if (!shape || (float && (shape.type === 'UINT' || shape.type === 'SINT')))
    {
        return null;
    }
    const bits = shape.channels.map(channel=>{
        const value = values[channel.value] ?? 0;
        const mask = channel.bits === 32 ? 0xffffffff : 2 ** channel.bits - 1;
        return float ? convert(value, channel.bits, shape.type) >>> 0
            : (value >>> 0) % (mask + 1);
    });
    return { ...shape, bits };
}

/**
 * One element of a typed buffer as the clear writes it, or null where it
 * writes nothing.
 *
 * @param {number} format @param {readonly number[]} values @param {boolean} float
 * @returns {Uint8Array | null}
 */
export function clearElement(format, values, float){
    const made = channelBits(format, values, float);
    if (!made)
    {
        return null;
    }
    const total = made.channels.reduce((sum, channel)=>sum + channel.bits, 0);
    const bytes = new Uint8Array(Math.ceil(total / 8));
    let at = 0;
    made.channels.forEach((channel, index)=>{
        for (let bit = 0; bit < channel.bits; bit++, at++)
        {
            if (Math.floor(made.bits[index] / 2 ** bit) % 2 === 1)
            {
                bytes[at >> 3] |= 1 << (at & 7);
            }
        }
    });
    return bytes;
}

/**
 * The texel a storage texture of this format is written with, as the bits
 * of the four values WGSL stores: floats for a float or normalised format,
 * integers for an integer one. Null where the clear writes nothing.
 *
 * @param {number} format @param {readonly number[]} values @param {boolean} float
 * @returns {Uint32Array | null}
 */
export function clearTexel(format, values, float){
    const made = channelBits(format, values, float);
    if (!made)
    {
        return null;
    }
    const texel = new Uint32Array(4);
    made.channels.forEach((channel, index)=>{
        const bits = made.bits[index];
        const top = 2 ** channel.bits - 1;
        switch (made.type)
        {
            case 'FLOAT':
                texel[channel.value] = channel.bits === 32 ? bits : singleBits(halfOf(bits));
                break;
            case 'UNORM':
                texel[channel.value] = singleBits(bits / top);
                break;
            case 'SNORM': {
                const signed = bits > top / 2 ? bits - top - 1 : bits;
                texel[channel.value] = singleBits(Math.max(-1, signed / (2 ** (channel.bits - 1)
                    - 1)));
                break;
            }
            case 'SINT':
                texel[channel.value] = (bits > top / 2 ? bits - top - 1 : bits) >>> 0;
                break;
            default:
                texel[channel.value] = bits;
        }
    });
    return texel;
}
