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
