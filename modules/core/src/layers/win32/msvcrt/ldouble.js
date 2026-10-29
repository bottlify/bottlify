/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87's 80-bit extended format as msvcrt's `_LDOUBLE` holds it: ten bytes,
 * little-endian, a 64-bit significand with its integer bit explicit, then
 * fifteen bits of exponent biased by 16383 and the sign. A double cannot
 * carry one, so text is converted to it exactly, with integers as large as
 * the text needs, and rounded once, to the nearest and a tie to the even.
 */

/** The size of an `_LDOUBLE`. */
export const LDOUBLE_SIZE = 10;

const BIAS = 16383;
const MAX_EXPONENT = 0x7fff;
/** The exponent of the smallest normal, unbiased. */
const MIN_NORMAL = 1 - BIAS;
const INTEGER_BIT = 1n << 63n;

/** What `__STRINGTOLD` answers besides the value. */
export const STRINGTOLD = Object.freeze({ OK: 0, UNDERFLOW: 1, OVERFLOW: 2, NONE: 4 });

/**
 * What the conversion reads, as msvcrt's strtod reads it: white space, a
 * sign, digits with a point among them, and an exponent after `e`, `E`, `d`
 * or `D` where a digit follows. No infinity or NaN is spelt.
 */
const DECIMAL = /^[ \t\n\v\f\r]*([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eEdD]([+-]?[0-9]+))?/;

/**
 * A decimal so far past either end of the format that its digits need not be
 * weighed: 10^5000 is past the largest extended (about 1.19e4932), and
 * 10^-5000 short of half the smallest denormal (about 3.65e-4951).
 */
const DECIMAL_REACH = 5000;

/**
 * Text up to 64 bits of significand, rounded to the nearest and a tie to the
 * even: the quotient of `numerator` by `denominator`, each a BigInt.
 *
 * @param {bigint} numerator @param {bigint} denominator
 */
function roundedQuotient(numerator, denominator){
    const quotient = numerator / denominator;
    const twice = (numerator % denominator) * 2n;
    return twice > denominator || twice === denominator && (quotient & 1n) === 1n
        ? quotient + 1n : quotient;
}

/** @param {bigint} value  Positive. */
const bitLength = value=>value.toString(2).length;

/**
 * An `_LDOUBLE`'s ten bytes.
 *
 * @param {boolean} negative @param {number} exponent  The biased field.
 * @param {bigint} significand
 */
export function extendedBytes(negative, exponent, significand){
    const bytes = new Uint8Array(LDOUBLE_SIZE);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, significand, true);
    view.setUint16(8, exponent | (negative ? 0x8000 : 0), true);
    return bytes;
}

/**
 * The extended value nearest a positive rational: its biased exponent and
 * significand, or null when it is past the largest finite one.
 *
 * @param {bigint} numerator @param {bigint} denominator
 * @returns {{ exponent: number, significand: bigint } | null}
 */
function nearestExtended(numerator, denominator){
    // floor(log2) of the quotient, from the two lengths: one of two values.
    let power = bitLength(numerator) - bitLength(denominator);
    if (power >= 0 ? numerator < denominator << BigInt(power)
        : numerator << BigInt(-power) < denominator)
    {
        power--;
    }
    // Sixty-four bits for a normal; for a denormal the bits it has room for.
    const scale = 63 - Math.max(power, MIN_NORMAL);
    let significand = scale >= 0
        ? roundedQuotient(numerator << BigInt(scale), denominator)
        : roundedQuotient(numerator, denominator << BigInt(-scale));
    let top = Math.max(power, MIN_NORMAL);
    if (significand === 1n << 64n)
    {
        significand >>= 1n;
        top++;
    }
    if (significand < INTEGER_BIT)
    {
        // A denormal, or zero: rounding up to the integer bit is the smallest normal.
        return { exponent: 0, significand };
    }
    const exponent = top + BIAS;
    return exponent >= MAX_EXPONENT ? null : { exponent, significand };
}

/**
 * A decimal's text as an extended: the bytes, where the reading stopped, and
 * whether it was out of range -- `UNDERFLOW` for digits not all zeros that
 * come out zero, `OVERFLOW` (the bytes an infinity) past the largest; `NONE`
 * when there is no number to read, with zero bytes and nothing read.
 *
 * @param {string} text
 * @returns {{ bytes: Uint8Array, end: number, status: number }}
 */
export function decimalToExtended(text){
    const match = DECIMAL.exec(text);
    const whole = match?.[2] ?? '';
    const fraction = match?.[3] ?? '';
    if (!match || whole.length + fraction.length === 0)
    {
        return { bytes: new Uint8Array(LDOUBLE_SIZE), end: 0, status: STRINGTOLD.NONE };
    }
    const negative = match[1] === '-';
    const end = match[0].length;
    const digits = `${whole}${fraction}`.replace(/^0+/, '');
    const zero = { bytes: extendedBytes(negative, 0, 0n), end, status: STRINGTOLD.OK };
    if (digits.length === 0)
    {
        return zero;
    }
    const scale = Number(match[4] ?? 0) - fraction.length;
    const magnitude = digits.length + scale;
    if (magnitude > DECIMAL_REACH)
    {
        return { bytes: extendedBytes(negative, MAX_EXPONENT, INTEGER_BIT), end,
            status: STRINGTOLD.OVERFLOW };
    }
    if (magnitude < -DECIMAL_REACH)
    {
        return { ...zero, status: STRINGTOLD.UNDERFLOW };
    }
    const value = BigInt(digits);
    const nearest = scale >= 0
        ? nearestExtended(value * 10n ** BigInt(scale), 1n)
        : nearestExtended(value, 10n ** BigInt(-scale));
    if (nearest === null)
    {
        return { bytes: extendedBytes(negative, MAX_EXPONENT, INTEGER_BIT), end,
            status: STRINGTOLD.OVERFLOW };
    }
    return { bytes: extendedBytes(negative, nearest.exponent, nearest.significand), end,
        status: STRINGTOLD.OK };
}

/** The most significant digits `$I10_OUTPUT` writes. */
const MOST_DIGITS = 21;

/**
 * `$I10_OUTPUT`'s reading of an extended: its decimal digits rounded to
 * `precision` significant ones -- or with `fixed`, to `precision` after the
 * point -- as many as 21; the point's place (`pos`, the value 0.digits x
 * 10^pos), the sign, and the digits written with the trailing zeros dropped
 * (`len` of them, at least one). The buffer holds the dropped zeros past the
 * terminator, and after them the first digit past the rounding when there
 * was room for it. An infinity or a NaN is "1#INF", "1#SNAN" or "1#QNAN" at
 * pos 1, and the answer 0; a number answers 1.
 *
 * @param {Uint8Array} bytes  The ten bytes.
 * @param {number} precision @param {boolean} fixed
 * @returns {{ pos: number, negative: boolean, len: number, buffer: string, ok: number }}
 */
export function extendedDigits(bytes, precision, fixed){
    const view = new DataView(bytes.buffer, bytes.byteOffset, LDOUBLE_SIZE);
    const significand = view.getBigUint64(0, true);
    const field = view.getUint16(8, true);
    const negative = (field & 0x8000) !== 0;
    const exponent = field & 0x7fff;
    if (exponent === MAX_EXPONENT)
    {
        const fraction = significand & (INTEGER_BIT - 1n);
        const text = (significand & 1n << 62n) !== 0n ? '1#QNAN'
            : fraction !== 0n ? '1#SNAN' : '1#INF';
        return { pos: 1, negative, len: text.length, buffer: text, ok: 0 };
    }
    const zero = { pos: 0, negative, len: 1, buffer: '0', ok: 1 };
    if (significand === 0n)
    {
        return zero;
    }
    // value = significand * 2^power, written exactly as an integer over 10^k.
    const power = Math.max(exponent, 1) - BIAS - 63;
    const exact = power >= 0 ? `${significand << BigInt(power)}`
        : `${significand * 5n ** BigInt(-power)}`;
    const scale = power >= 0 ? 0 : -power;
    const digits = exact.replace(/^0+/, '');
    const pos = digits.length - scale;
    const wanted = Math.min(fixed ? pos + precision : precision, MOST_DIGITS);
    if (wanted <= 0)
    {
        return zero;
    }
    const padded = digits.padEnd(wanted + 1, '0');
    let kept = BigInt(padded.slice(0, wanted));
    if (padded[wanted] >= '5')
    {
        kept++;
    }
    let text = `${kept}`;
    let place = pos;
    if (text.length > wanted)
    {
        text = text.slice(0, wanted);
        place++;
    }
    const len = Math.max(1, text.replace(/0+$/, '').length);
    const guard = wanted < MOST_DIGITS ? padded[wanted] : '';
    return { pos: place, negative, len, buffer: `${text}${guard}`, ok: 1 };
}
