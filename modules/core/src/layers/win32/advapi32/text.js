/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IsTextUnicode's tests: whether a buffer reads as UTF-16 rather than as
 * text in a code page, judged by what the documentation lists -- each test
 * one bit, passed or not, and a verdict drawn from which groups of them
 * passed.
 *
 * The tests are heuristics and documented as such: a short ANSI string can
 * look like UTF-16 and the other way round, and a caller that cares asks
 * for the individual results through lpiResult. What matters is that the
 * clear cases -- UTF-16 of ASCII text, a byte-order mark, an odd length --
 * come out the way Windows answers them.
 */

export const IS_TEXT_UNICODE_ASCII16 = 0x0001;
export const IS_TEXT_UNICODE_STATISTICS = 0x0002;
export const IS_TEXT_UNICODE_CONTROLS = 0x0004;
export const IS_TEXT_UNICODE_SIGNATURE = 0x0008;
export const IS_TEXT_UNICODE_REVERSE_ASCII16 = 0x0010;
export const IS_TEXT_UNICODE_REVERSE_STATISTICS = 0x0020;
export const IS_TEXT_UNICODE_REVERSE_CONTROLS = 0x0040;
export const IS_TEXT_UNICODE_REVERSE_SIGNATURE = 0x0080;
export const IS_TEXT_UNICODE_ILLEGAL_CHARS = 0x0100;
export const IS_TEXT_UNICODE_ODD_LENGTH = 0x0200;
export const IS_TEXT_UNICODE_DBCS_LEADBYTE = 0x0400;
export const IS_TEXT_UNICODE_NULL_BYTES = 0x1000;

const UNICODE_MASK = 0x000f;
const REVERSE_MASK = 0x00f0;
const NOT_UNICODE_MASK = 0x0f00;
const NOT_ASCII_MASK = 0xf000;

/** Every test there is: what a caller that passes no lpiResult asks for. */
const ALL_TESTS = UNICODE_MASK | REVERSE_MASK | NOT_UNICODE_MASK | NOT_ASCII_MASK;

/** Only the start of a buffer is looked at, as Windows looks at it: 256 characters. */
const EXAMINED_UNITS = 256;

/** The whitespace and line breaks of UTF-16 text, and the ideographic space. */
const CONTROLS = new Set([0x000d, 0x000a, 0x0009, 0x0020, 0x3000]);

/** @param {number} unit */
const swapped = unit=>((unit & 0xff) << 8 | unit >>> 8) & 0xffff;

/**
 * Runs the tests asked for over a buffer.
 *
 * @param {Uint8Array} bytes  The whole buffer the caller passed.
 * @param {number} [asked]  The tests to run: lpiResult's value, or all.
 * @returns {{ unicode: boolean, passed: number }}
 *     The verdict, and the tests that passed among those asked.
 */
export function isTextUnicode(bytes, asked = ALL_TESTS){
    if (bytes.length < 2)
    {
        return { unicode: false, passed: 0 };
    }
    let passed = 0;
    if (bytes.length % 2 !== 0)
    {
        passed |= IS_TEXT_UNICODE_ODD_LENGTH;
    }
    // A terminator at the end is the end of the text, not a NUL inside it.
    let length = bytes.length;
    while (length > 0 && bytes[length - 1] === 0)
    {
        length--;
    }
    const count = Math.min(Math.floor(length / 2) + (length % 2), EXAMINED_UNITS);
    /** @type {number[]} */
    const units = [];
    for (let at = 0; at < count; at++)
    {
        units.push(bytes[at * 2] | (bytes[at * 2 + 1] ?? 0) << 8);
    }
    if (units.length === 0)
    {
        return { unicode: false, passed: passed & asked };
    }

    if (units[0] === 0xfeff)
    {
        passed |= IS_TEXT_UNICODE_SIGNATURE;
    }
    if (units[0] === 0xfffe)
    {
        passed |= IS_TEXT_UNICODE_REVERSE_SIGNATURE;
    }
    const body = (passed & (IS_TEXT_UNICODE_SIGNATURE | IS_TEXT_UNICODE_REVERSE_SIGNATURE)) !== 0
        ? units.slice(1) : units;
    if (body.length > 0)
    {
        if (body.every(unit=>unit < 0x80))
        {
            passed |= IS_TEXT_UNICODE_ASCII16;
        }
        if (body.every(unit=>swapped(unit) < 0x80))
        {
            passed |= IS_TEXT_UNICODE_REVERSE_ASCII16;
        }
        // Text of the Latin pages in UTF-16 is mostly units with a zero high
        // byte; the same text read the wrong way round has a zero low byte.
        const narrow = body.filter(unit=>unit < 0x100).length;
        const reversed = body.filter(unit=>swapped(unit) < 0x100).length;
        if (narrow * 2 > body.length && narrow > reversed)
        {
            passed |= IS_TEXT_UNICODE_STATISTICS;
        }
        if (reversed * 2 > body.length && reversed > narrow)
        {
            passed |= IS_TEXT_UNICODE_REVERSE_STATISTICS;
        }
    }
    if (units.some(unit=>CONTROLS.has(unit)))
    {
        passed |= IS_TEXT_UNICODE_CONTROLS;
    }
    if (units.some(unit=>CONTROLS.has(swapped(unit))))
    {
        passed |= IS_TEXT_UNICODE_REVERSE_CONTROLS;
    }
    // What no UTF-16 text holds: a byte-order mark backwards past the start,
    // a NUL inside it, CR LF packed into one unit, and the noncharacter.
    if (units.some((unit, at)=>(unit === 0xfffe && at > 0) || unit === 0 || unit === 0x0a0d
        || unit === 0xffff))
    {
        passed |= IS_TEXT_UNICODE_ILLEGAL_CHARS;
    }
    if (bytes.subarray(0, Math.min(length, EXAMINED_UNITS * 2)).includes(0))
    {
        passed |= IS_TEXT_UNICODE_NULL_BYTES;
    }

    const result = passed & asked;
    const unicode = (result & (REVERSE_MASK | NOT_UNICODE_MASK)) === 0
        && (result & (NOT_ASCII_MASK | UNICODE_MASK)) !== 0;
    return { unicode, passed: result };
}
