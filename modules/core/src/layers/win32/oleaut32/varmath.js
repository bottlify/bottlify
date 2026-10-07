/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The exact numbers of automation: CY, a 64-bit count of ten-thousandths,
 * and DECIMAL, a 96-bit integer with a sign and a power of ten below it.
 * Both are carried as a BigInt and a scale, so no step goes through a double.
 */

/** @typedef {{ value: bigint, scale: number }} Exact  value / 10^scale */

const LIMIT = (1n << 96n) - 1n;
export const DECIMAL_NEG = 0x80;
export const MAX_SCALE = 28;

/**
 * A DECIMAL's sixteen bytes; the first two are the variant's type or reserved.
 *
 * @param {Uint8Array} bytes
 * @returns {Exact}
 */
export function readDecimal(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
    const magnitude = BigInt(view.getUint32(4, true)) << 64n
        | BigInt(view.getUint32(12, true)) << 32n | BigInt(view.getUint32(8, true));
    return { value: (bytes[3] & DECIMAL_NEG) !== 0 ? -magnitude : magnitude, scale: bytes[2] };
}

/**
 * The fourteen bytes past a DECIMAL's first two, or null when it does not fit.
 *
 * @param {Exact} exact
 * @returns {Uint8Array | null}
 */
export function decimalBytes({ value, scale }){
    const magnitude = value < 0n ? -value : value;
    if (magnitude > LIMIT || scale < 0 || scale > MAX_SCALE)
    {
        return null;
    }
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    bytes[2] = scale;
    bytes[3] = value < 0n ? DECIMAL_NEG : 0;
    view.setUint32(4, Number(magnitude >> 64n), true);
    view.setUint32(8, Number(magnitude & 0xffffffffn), true);
    view.setUint32(12, Number(magnitude >> 32n & 0xffffffffn), true);
    return bytes.subarray(2);
}

/**
 * A double as the decimal its fifteen significant digits spell, as the
 * conversion to DECIMAL reads one; null for what is not finite.
 *
 * @param {number} number
 * @returns {Exact | null}
 */
export function exactOf(number){
    if (!Number.isFinite(number))
    {
        return null;
    }
    if (number === 0)
    {
        return { value: 0n, scale: 0 };
    }
    const [mantissa, exponent] = Math.abs(number).toExponential(14).split('e');
    let digits = mantissa.replace('.', '').replace(/0+$/, '');
    let scale = digits.length - 1 - Number(exponent);
    if (scale < 0)
    {
        digits += '0'.repeat(-scale);
        scale = 0;
    }
    let exact = { value: BigInt(digits) * (number < 0 ? -1n : 1n), scale };
    if (scale > MAX_SCALE)
    {
        exact = round(exact, MAX_SCALE);
    }
    return exact;
}

/** @param {Exact} exact */
export const toNumber = ({ value, scale })=>Number(value) / 10 ** scale;

/**
 * Rounded to `places` decimal places, a half to the even neighbour.
 *
 * @param {Exact} exact @param {number} places
 * @returns {Exact}
 */
export function round({ value, scale }, places){
    if (places >= scale)
    {
        return { value, scale };
    }
    const divisor = 10n ** BigInt(scale - places);
    const negative = value < 0n;
    const magnitude = negative ? -value : value;
    let quotient = magnitude / divisor;
    const twice = (magnitude % divisor) * 2n;
    if (twice > divisor || (twice === divisor && (quotient & 1n) === 1n))
    {
        quotient++;
    }
    return { value: negative ? -quotient : quotient, scale: places };
}

/**
 * A double rounded to `places` decimal places, a half to the even neighbour,
 * judged on the decimal the double spells rather than its binary value.
 *
 * @param {number} number @param {number} places
 */
export function roundNumber(number, places){
    const exact = exactOf(number);
    return exact === null ? number : toNumber(round(exact, places));
}

/**
 * An exact number as a DECIMAL holds it: no more than 28 places, and fewer --
 * rounded from the number itself each time, never from an earlier rounding --
 * until the digits fit 96 bits. null when even the whole number does not.
 *
 * @param {Exact} exact
 * @returns {Exact | null}
 */
export function fitDecimal(exact){
    for (let places = Math.min(exact.scale, MAX_SCALE); places >= 0; places--)
    {
        const fitted = round(exact, places);
        if ((fitted.value < 0n ? -fitted.value : fitted.value) <= LIMIT)
        {
            return fitted;
        }
    }
    return null;
}

/**
 * The order of two exact numbers: -1, 0 or 1.
 *
 * @param {Exact} left @param {Exact} right
 */
export function compareExact(left, right){
    const scale = Math.max(left.scale, right.scale);
    const a = left.value * 10n ** BigInt(scale - left.scale);
    const b = right.value * 10n ** BigInt(scale - right.scale);
    return a < b ? -1 : a > b ? 1 : 0;
}
