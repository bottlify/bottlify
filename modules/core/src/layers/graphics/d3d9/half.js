/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Half-precision floats (IEEE 754 binary16), which a 16-bit floating-point
 * surface holds: to and from a number.
 */

const halfView = new DataView(new ArrayBuffer(4));

/**
 * A float's half-precision bits, rounded to nearest: what a 16-bit float
 * target keeps of it.
 *
 * @param {number} value
 * @returns {number}
 */
export function toHalf(value){
    halfView.setFloat32(0, value, true);
    const bits = halfView.getUint32(0, true);
    const sign = (bits >>> 16) & 0x8000;
    const exponent = (bits >>> 23) & 0xff;
    const mantissa = bits & 0x7fffff;
    if (exponent === 0xff)
    {
        return sign | 0x7c00 | (mantissa ? 0x200 : 0);
    }
    const half = exponent - 127 + 15;
    if (half >= 0x1f)
    {
        return sign | 0x7c00;
    }
    if (half <= 0)
    {
        if (half < -10)
        {
            return sign;
        }
        const full = mantissa | 0x800000;
        const shift = 14 - half;
        const rounded = (full >>> shift) + ((full >>> (shift - 1)) & 1);
        return sign | rounded;
    }
    const rounded = (half << 10 | mantissa >>> 13) + ((mantissa >>> 12) & 1);
    return sign | rounded;
}

/**
 * A half-precision float's value.
 *
 * @param {number} bits
 * @returns {number}
 */
export function fromHalf(bits){
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
 * Channels as a wide surface format keeps them in memory, as the half floats
 * the GPU holds them in: a half as it lies, a 32-bit float rounded to the
 * nearest half, a 16-bit fraction as the half nearest its value.
 *
 * A 16-bit fraction loses bits on the way: a half has eleven significant
 * bits, so between one half and one a step is 1/2048 where the fraction's is
 * 1/65535. A half's steps shrink with its value, and below 1/64 -- near black,
 * where banding shows -- the half is the finer of the two.
 *
 * @param {'half' | 'float' | 'unorm16'} stored
 * @param {Uint8Array} bytes  as they lie in memory, at any alignment
 * @param {number} count  channels
 * @returns {Uint8Array} `count` halves, little-endian
 */
export function storedToHalves(stored, bytes, count){
    if (stored === 'half')
    {
        return bytes.slice(0, count * 2);
    }
    const from = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Uint16Array(count);
    for (let index = 0; index < count; index++)
    {
        out[index] = toHalf(stored === 'float'
            ? from.getFloat32(index * 4, true)
            : from.getUint16(index * 2, true) / 0xffff);
    }
    return new Uint8Array(out.buffer);
}

/**
 * Half floats as the GPU holds them, back into the channels of the format a
 * program asked for. A fraction takes the nearest of its 65536 steps, and a
 * value a draw left outside 0..1 -- a half target does not clamp what it is
 * given, where a fixed-point one would -- is clamped here, as reading it from
 * that target would have.
 *
 * @param {'half' | 'float' | 'unorm16'} stored
 * @param {Uint8Array} halves  little-endian, at any alignment
 * @param {number} count  channels
 * @returns {Uint8Array} the bytes `count` channels occupy in memory
 */
export function halvesToStored(stored, halves, count){
    if (stored === 'half')
    {
        return halves.slice(0, count * 2);
    }
    const from = new DataView(halves.buffer, halves.byteOffset, halves.byteLength);
    const out = new DataView(new ArrayBuffer(count * (stored === 'float' ? 4 : 2)));
    for (let index = 0; index < count; index++)
    {
        const value = fromHalf(from.getUint16(index * 2, true));
        if (stored === 'float')
        {
            out.setFloat32(index * 4, value, true);
        }
        else
        {
            // NaN fails both comparisons and is zero, as a fixed-point target stores it.
            const clamped = value > 0 ? Math.min(value, 1) : 0;
            out.setUint16(index * 2, Math.round(clamped * 0xffff), true);
        }
    }
    return new Uint8Array(out.buffer);
}
