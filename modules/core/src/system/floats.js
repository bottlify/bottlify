/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Floats as their bits: a single's 32, a half's 16 (IEEE 754 binary32 and
 * binary16), the forms a render state, a shader constant, a texel or a
 * compiled shader keeps them in.
 *
 * Every answer here is the same on every machine. ECMAScript lets a NaN
 * stored into a float32 take any NaN pattern, and x86 and ARM engines differ
 * in its sign, so a NaN is written as the one quiet NaN, positive, at either
 * width - what a compiled shader hashed by a program must be. Powers of two
 * come from a table made by doubling rather than from `**`, which ECMAScript
 * leaves implementation-approximated.
 */

const scratch = new DataView(new ArrayBuffer(4));

/** The single's quiet NaN, positive. */
const NAN32 = 0x7fc00000;

/** The half's quiet NaN, positive. */
const NAN16 = 0x7e00;

/**
 * The bits of the single nearest `value`, rounded to nearest even.
 *
 * @param {number} value
 * @returns {number} a uint32
 */
export function floatBits(value){
    if (Number.isNaN(value))
    {
        return NAN32;
    }
    scratch.setFloat32(0, value, true);
    return scratch.getUint32(0, true);
}

/**
 * The single these bits are.
 *
 * @param {number} bits
 * @returns {number}
 */
export function bitsFloat(bits){
    scratch.setUint32(0, bits >>> 0, true);
    return scratch.getFloat32(0, true);
}

/**
 * The bits of the half nearest `value`, by way of the single nearest it (as a
 * GPU and D3DX convert a float), rounded to nearest even; a magnitude past the
 * largest half is an infinity, one under the smallest subnormal's half a zero
 * of its sign.
 *
 * @param {number} value
 * @returns {number} a uint16
 */
export function toHalf(value){
    if (Number.isNaN(value))
    {
        return NAN16;
    }
    const bits = floatBits(value);
    const sign = bits >>> 16 & 0x8000;
    const exponent = (bits >>> 23 & 0xff) - 127 + 15;
    if (exponent >= 0x1f)
    {
        return sign | 0x7c00;
    }
    // The half's significand with its hidden bit, and how far it moves down:
    // thirteen bits for a normal half, more for a subnormal one.
    const shift = exponent <= 0 ? 14 - exponent : 13;
    if (shift > 24)
    {
        return sign;
    }
    const full = bits & 0x7fffff | 0x800000;
    const kept = full >>> shift;
    const rest = full & (1 << shift) - 1;
    const middle = 1 << shift - 1;
    const rounded = kept + (rest > middle || rest === middle && (kept & 1) !== 0 ? 1 : 0);
    // A normal half adds its exponent over the hidden bit; a rounding that
    // carries out of the significand moves into the exponent, the largest
    // half into an infinity.
    return sign | (exponent <= 0 ? rounded : (exponent - 1 << 10) + rounded);
}

/** 2 ** (k - 24) for k of 0 to 30, by doubling: exact everywhere. */
const SCALE = Array.from({ length: 31 }, (unused, k)=>k).map(k=>{
    let scale = 1 / 16777216;
    for (let step = 0; step < k; step++)
    {
        scale *= 2;
    }
    return scale;
});

/**
 * The value of a half's bits (the low sixteen of `bits`).
 *
 * @param {number} bits
 * @returns {number}
 */
export function fromHalf(bits){
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = bits >>> 10 & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0x1f)
    {
        return mantissa ? NaN : sign * Infinity;
    }
    return exponent === 0 ? sign * mantissa * SCALE[0]
        : sign * (1024 + mantissa) * SCALE[exponent - 1];
}
