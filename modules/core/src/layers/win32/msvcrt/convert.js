/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Text to numbers and back.
 *
 * The parsing half of this file follows one rule that `atoi` is allowed to
 * ignore and these are not: a conversion reports where it stopped. A caller
 * that passes an end pointer is going to carry on reading from there, so the
 * position matters as much as the value -- and the position after a failed
 * conversion is the *start*, not the end, which is how a tokeniser built on
 * `strtol` terminates instead of looping.
 *
 * The printing half writes into storage the caller did not allocate and does
 * not free, so that storage is kept here and reused, exactly as the C library
 * documents. Handing back a fresh allocation each time would leak.
 */

import { readDouble, returningDouble } from './float.js';
import { EINVAL, ERANGE } from './globals.js';
import { guestEntry } from './guest-code.js';
import * as inGuest from './inguest.js';
import { COMPILED } from './inguest.x86.js';
import { wideStringAt } from './widetext.js';
import { cvtDigits } from './format.js';
import { decimalToExtended, extendedDigits } from './ldouble.js';
import * as inGuestFloat from './inguest-float.js';
import { COMPILED as FLOAT_CODE } from './inguest-float.x86.js';

const MAX_STRING = 1 << 20;

const LONG_MAX = 0x7fffffffn;
const LONG_MIN = -0x80000000n;
const ULONG_MAX = 0xffffffffn;
const INT64_MAX = 0x7fffffffffffffffn;
const INT64_MIN = -0x8000000000000000n;
const UINT64_MAX = 0xffffffffffffffffn;

/** `_atodbl`'s answers for a value out of range, and the least normal double. */
const OVERFLOW = 3;
const UNDERFLOW = 4;
const MIN_NORMAL = 2.2250738585072014e-308;

/** What `isspace` accepts, which is what every conversion skips first. */
const WHITESPACE = ' \t\n\v\f\r';

/** msvcrt sizes its conversion buffer for the longest double it can print. */
const CVT_BUFFER = 349;

/** JavaScript's own formatters refuse more digits than this. */
const MAX_DIGITS = 100;

/** @param {string} character */
function digitValue(character){
    if (character === undefined)
    {
        return -1;
    }
    const code = character.charCodeAt(0);
    if (code >= 0x30 && code <= 0x39)
    {
        return code - 0x30;
    }
    if (code >= 0x61 && code <= 0x7a)
    {
        return code - 0x61 + 10;
    }
    if (code >= 0x41 && code <= 0x5a)
    {
        return code - 0x41 + 10;
    }
    return -1;
}

/** Above the largest magnitude any integer conversion clamps at (2^64). */
const PAST_EVERY_LIMIT = 1n << 72n;

/**
 * The integer scanner behind strtol and strtoul, and scanf's integers.
 *
 * @param {string} text
 * @param {number} requestedBase  Zero means "let the prefix decide".
 * @param {boolean} [zeroBeforeX]  Read "0x" with no hex digit after it as a
 *        zero the x ends, as scanf here does. Without it the "0x" is a prefix
 *        with nothing after it and nothing converts, which is strtol's
 *        reading: Wine's msvcrt test_strtol has "-0x" leave the end pointer
 *        at the start.
 * @returns {{ magnitude: bigint, negative: boolean, end: number } | null}
 *          Null when nothing converted, which is not the same as a zero.
 */
export function scanInteger(text, requestedBase, zeroBeforeX = false, prefix = true){
    let at = 0;
    while (at < text.length && WHITESPACE.includes(text[at]))
    {
        at++;
    }

    let negative = false;
    if (text[at] === '+' || text[at] === '-')
    {
        negative = text[at] === '-';
        at++;
    }

    let base = requestedBase;
    const hexPrefix = text[at] === '0' && (text[at + 1] === 'x' || text[at + 1] === 'X');
    const hexDigitAfter = digitValue(text[at + 2]) >= 0 && digitValue(text[at + 2]) < 16;
    if ((base === 0 || base === 16) && prefix && hexPrefix && (hexDigitAfter || !zeroBeforeX))
    {
        base = 16;
        at += 2;
    }
    else if (base === 0)
    {
        base = text[at] === '0' ? 8 : 10;
    }

    const start = at;
    let magnitude = 0n;
    while (at < text.length)
    {
        const digit = digitValue(text[at]);
        if (digit < 0 || digit >= base)
        {
            break;
        }
        // Past every limit a caller compares with, more digits change
        // nothing it can see: the magnitude stops growing, so a long run of
        // them costs a step each rather than a multiplication of its length.
        if (magnitude < PAST_EVERY_LIMIT)
        {
            magnitude = magnitude * BigInt(base) + BigInt(digit);
        }
        at++;
    }

    return at === start ? null : { magnitude, negative, end: at };
}

/**
 * The zero of each run of ten decimal digits past ASCII that msvcrt's wide
 * conversions read as digits: the Arabic-Indic and extended Arabic-Indic,
 * Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Telugu, Kannada, Malayalam,
 * Thai, Lao, Tibetan, Myanmar, Khmer and Mongolian digits and the fullwidth
 * forms -- not Tamil's, whose zero came into Unicode after them.
 */
const WIDE_ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xc66, 0xce6, 0xd66,
    0xe50, 0xed0, 0xf20, 0x1040, 0x17e0, 0x1810, 0xff10];

/**
 * A wide character's value as a digit: a decimal digit of any of the scripts
 * above, or an ASCII letter from ten; -1 for anything else.
 *
 * @param {string | undefined} character
 */
function wideDigitValue(character){
    const ascii = digitValue(character ?? '');
    if (ascii >= 0 || character === undefined)
    {
        return ascii;
    }
    const code = character.charCodeAt(0);
    const zero = WIDE_ZEROS.find(first=>code >= first && code <= first + 9);
    return zero === undefined ? -1 : code - zero;
}

/**
 * The white space the wide conversions skip: the C locale's below U+0100,
 * where the no-break space is one, and Unicode's separators past it.
 *
 * @param {string | undefined} character
 */
const isWideSpace = character=>character !== undefined && (WHITESPACE.includes(character)
    || character === '\xa0' || /[\p{Zs}\p{Zl}\p{Zp}]/u.test(character) && character > '\xff');

/**
 * scanInteger over a wide string: its digits any script's above, a zero of
 * any of them the one a `0x` prefix or an octal number begins with.
 *
 * @param {string} text @param {number} requestedBase
 * @returns {{ magnitude: bigint, negative: boolean, end: number } | null}
 */
export function scanWideInteger(text, requestedBase){
    let at = 0;
    while (isWideSpace(text[at]))
    {
        at++;
    }
    let negative = false;
    if (text[at] === '+' || text[at] === '-')
    {
        negative = text[at] === '-';
        at++;
    }
    let base = requestedBase;
    const zero = wideDigitValue(text[at]) === 0;
    const hexPrefix = zero && (text[at + 1] === 'x' || text[at + 1] === 'X');
    if ((base === 0 || base === 16) && hexPrefix)
    {
        base = 16;
        at += 2;
    }
    else if (base === 0)
    {
        base = zero ? 8 : 10;
    }
    const start = at;
    let magnitude = 0n;
    for (let digit = wideDigitValue(text[at]); digit >= 0 && digit < base;
        digit = wideDigitValue(text[at]))
    {
        // Past every limit a caller compares with, more digits change
        // nothing it can see: the magnitude stops growing, so a long run of
        // them costs a step each rather than a multiplication of its length.
        if (magnitude < PAST_EVERY_LIMIT)
        {
            magnitude = magnitude * BigInt(base) + BigInt(digit);
        }
        at++;
    }
    return at === start ? null : { magnitude, negative, end: at };
}

/** As much of a floating-point literal as C recognises, and where it ends. */
const LEADING_FLOAT
    = /^[ \t\n\v\f\r]*[+-]?(?:[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)/;

/**
 * @param {string} text
 * @returns {{ value: number, end: number } | null}
 */
export function scanFloat(text){
    const match = LEADING_FLOAT.exec(text);
    if (!match)
    {
        return null;
    }
    // The exponent is optional in the grammar but not in the match: "1e" leaves
    // the 'e' behind rather than converting it, so trim what Number rejects.
    let literal = match[0];
    while (literal.length > 0 && !Number.isFinite(Number(literal.trim())))
    {
        literal = literal.slice(0, -1);
    }
    return literal.trim().length === 0
        ? null
        : { value: Number(literal.trim()), end: literal.length };
}

/**
 * What strtod and atof read, as msvcrt reads it: white space, a sign, digits
 * with a point among them, and an exponent after `e`, `E`, `d` or `D` where a
 * digit follows (Wine's test_strtod reads "12.1d2" as 1210 and "0.1D-4736" as
 * an underflow). No infinity or NaN is spelt: "INF" converts nothing.
 */
const DECIMAL
    = /^[ \t\n\v\f\r]*[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eEdD][+-]?[0-9]+)?/;

/**
 * The bytes `DECIMAL` is spelt with. No match reaches past a byte outside
 * them, so the text up to the first such byte matches as the whole text does.
 */
const SPELLS_DECIMAL = new Uint8Array(256);
for (const c of ' \t\n\v\f\r+-.0123456789eEdD')
{
    SPELLS_DECIMAL[c.charCodeAt(0)] = 1;
}

/** How many bytes of a number's text strtod and atof read before reading it whole. */
const DECIMAL_WINDOW = 64;

/**
 * The double strtod reads, where it stops, and whether it is out of range:
 * an infinity from finite digits, or a zero from digits that were not all
 * zeros -- which msvcrt answers with ERANGE.
 *
 * @param {string} text
 * @returns {{ value: number, end: number, range: boolean } | null}
 */
export function scanDecimal(text){
    const match = DECIMAL.exec(text);
    if (!match)
    {
        return null;
    }
    const literal = match[0].trim().replace(/[dD]/, 'e');
    const value = Number(literal);
    return {
        value,
        end: match[0].length,
        range: !Number.isFinite(value) || value === 0 && /^[^eE]*[1-9]/.test(literal),
    };
}

/**
 * @typedef {Object} ConversionHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           With it, strtol and strtoul are code in the guest, handing the
 *           host only what they leave to it; without it, handlers.
 * @property {(bytes: number) => number} allocate
 * @property {import('./float.js').FloatHost} [fpu]  Absent means the functions
 *           that return a double are not exported at all.
 * @property {(code: number) => void} [errno]  Where an out-of-range value says so.
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *           EDX, for a 64-bit answer.
 */

/**
 * @param {ConversionHost} host
 */
export function createConversionFunctions(host){
    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    /** @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(pointer, bytes);
    };

    /** @param {number} pointer @param {string} text */
    const writeWideString = (pointer, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        host.writeMemory(pointer, bytes);
    };

    /** @param {number} pointer @param {number} value */
    const writeInt = (pointer, value)=>{
        if ((pointer >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value | 0, true);
        host.writeMemory(pointer, bytes);
    };

    /**
     * The buffer _ecvt and _fcvt return, allocated once and written over.
     *
     * Both documents say the result is overwritten by the next call, and code
     * that copies it out immediately -- which is all correct code -- cannot
     * tell the difference. Code that does not was already broken on Windows.
     */
    let conversionBuffer = 0;
    const cvtBuffer = ()=>{
        if (conversionBuffer === 0)
        {
            conversionBuffer = host.allocate(CVT_BUFFER);
        }
        return conversionBuffer;
    };

    /**
     * @param {number} argBytes
     * @param {(magnitude: bigint, negative: boolean) => bigint | null} convert
     *        The value, or null when it is out of range and `limit` answers.
     * @param {(negative: boolean) => bigint} limit
     * @param {boolean} [wide]  A wide string, two bytes a character.
     */
    const strtoInteger = (argBytes, convert, limit, wide = false, sixtyFour = false)=>({
        convention: 'cdecl',
        argBytes,
        /** @param {number[]} args */
        handler: ([string, end, base])=>{
            const scanned = wide
                ? scanWideInteger(wideStringAt(/** @type {(address: number, length: number)
                    => Uint8Array} */ (host.readMemory), string), base | 0)
                : scanInteger(readString(string), base | 0);
            // Nothing converted: the end pointer goes back to the start, so a
            // caller comparing it against the input sees no progress.
            writeInt(end, scanned ? string + scanned.end * (wide ? 2 : 1) : string);
            if (scanned === null)
            {
                if (sixtyFour)
                {
                    host.setRegisters?.({ edx: 0 });
                }
                return 0;
            }
            // errno is set only when the value does not fit: a caller clears it
            // first and tests it after, to tell a clamped limit from the limit.
            let value = convert(scanned.magnitude, scanned.negative);
            if (value === null)
            {
                host.errno?.(ERANGE);
                value = limit(scanned.negative);
            }
            if (sixtyFour)
            {
                host.setRegisters?.({ edx: Number(BigInt.asUintN(64, value) >> 32n) });
            }
            return Number(BigInt.asIntN(32, value));
        },
    });

    /** @param {bigint} magnitude @param {boolean} negative */
    const toInt64 = (magnitude, negative)=>{
        const value = negative ? -magnitude : magnitude;
        return value > INT64_MAX || value < INT64_MIN ? null : value;
    };
    /** @param {boolean} negative */
    const int64Limit = negative=>(negative ? INT64_MIN : INT64_MAX);
    /**
     * The unsigned reading as strtoul's: a magnitude past the type clamped,
     * then negated within it -- "-99999999999999999999" is 1 (Wine's
     * msvcrt test__strtoi64).
     *
     * @param {bigint} magnitude @param {boolean} negative
     */
    const toUint64 = (magnitude, negative)=>{
        if (magnitude > UINT64_MAX)
        {
            return null;
        }
        return negative ? BigInt.asUintN(64, -magnitude) : magnitude;
    };
    /** @param {boolean} negative */
    const uint64Limit = negative=>(negative ? BigInt.asUintN(64, -UINT64_MAX) : UINT64_MAX);

    /**
     * The `_*toa` family: same shape, differing only in how the value is read.
     *
     * Base ten is the only radix that can carry a sign; every other prints the
     * bit pattern, so `_ltoa(-1, b, 16)` is "ffffffff" while `_ltoa(-1, b, 10)`
     * is "-1". Whether ten is signed comes from the function, not the radix,
     * which is the entire difference between `_ltoa` and `_ultoa`.
     *
     * @param {number} valueSlots
     * @param {boolean} signed
     * @param {boolean} [wide]  The text in UTF-16, for the `_*tow` family.
     */
    const toText = (valueSlots, signed, wide = false)=>({
        convention: 'cdecl',
        argBytes: (valueSlots + 2) * 4,
        /** @param {number[]} args */
        handler: args=>{
            const buffer = args[valueSlots];
            const radix = args[valueSlots + 1] | 0;
            if (radix < 2 || radix > 36)
            {
                return 0;
            }
            const width = valueSlots * 32;
            let pattern = 0n;
            for (let slot = valueSlots - 1; slot >= 0; slot--)
            {
                pattern = (pattern << 32n) | BigInt(args[slot] >>> 0);
            }
            (wide ? writeWideString : writeString)(buffer, signed && radix === 10
                ? BigInt.asIntN(width, pattern).toString(10)
                : pattern.toString(radix));
            return buffer;
        },
    });

    /**
     * int _wtoi(const wchar_t *str) and long _wtol: atoi's reading over a
     * wide string -- white space, a sign, ASCII digits -- and atoi's
     * overflow, which wraps in 32 bits rather than clamping.
     */
    const wideAtoi = {
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([string])=>{
            const text = wideStringAt(/** @type {(address: number, length: number)
                => Uint8Array} */ (host.readMemory), string);
            const match = /^[ \t\n\v\f\r]*([+-]?)([0-9]*)/.exec(text);
            let total = 0;
            for (const digit of match?.[2] ?? '')
            {
                total = (Math.imul(total, 10) + digit.charCodeAt(0) - 0x30) | 0;
            }
            return match?.[1] === '-' ? (0 - total) | 0 : total;
        },
    };

    /** long strtol(const char *str, char **end, int base) */
    /** @param {bigint} magnitude @param {boolean} negative */
    const toLong = (magnitude, negative)=>{
        const value = negative ? -magnitude : magnitude;
        return value > LONG_MAX || value < LONG_MIN ? null : value;
    };
    /** @param {boolean} negative */
    const longLimit = negative=>(negative ? LONG_MIN : LONG_MAX);
    const strtol = strtoInteger(12, toLong, longLimit);

    /**
     * unsigned long strtoul(const char *str, char **end, int base)
     *
     * A minus sign is accepted and the magnitude is negated within 32 bits,
     * which C requires: strtoul("-1") is ULONG_MAX, not a failure. A
     * magnitude out of range is clamped before the sign is applied, so a
     * negative one comes back as ULONG_MAX negated, 1 (Wine's msvcrt
     * test_strtol).
     */
    /** @param {bigint} magnitude @param {boolean} negative */
    const toUnsignedLong = (magnitude, negative)=>{
        if (magnitude > ULONG_MAX)
        {
            return null;
        }
        return negative ? BigInt.asUintN(32, -magnitude) : magnitude;
    };
    /** @param {boolean} negative */
    const unsignedLongLimit = negative=>(negative ? BigInt.asUintN(32, -ULONG_MAX) : ULONG_MAX);
    const strtoul = strtoInteger(12, toUnsignedLong, unsignedLongLimit);

    /**
     * _ecvt and _fcvt: the digits in the buffer they share, the point and the
     * sign through the pointers.
     *
     * @param {boolean} fixed
     */
    const cvt = fixed=>({
        convention: 'cdecl',
        argBytes: 20,
        /** @param {number[]} args */
        handler: args=>{
            const { digits, point, negative } = cvtDigits(
                { value: readDouble(args, 0), low: args[0] >>> 0, high: args[1] >>> 0 },
                args[2] | 0, fixed);
            const buffer = cvtBuffer();
            writeInt(args[3], point);
            writeInt(args[4], negative ? 1 : 0);
            writeString(buffer, digits.slice(0, CVT_BUFFER - 1));
            return buffer;
        },
    });

    /**
     * _atodbl's body.
     *
     * @param {number} value @param {number} text
     */
    const toDouble = (value, text)=>{
        const scanned = (text >>> 0) === 0 ? null : scanDecimal(readString(text));
        const number = scanned ? scanned.value : 0;
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, number, true);
        host.writeMemory(value >>> 0, bytes);
        if (!scanned)
        {
            return 0;
        }
        if (!Number.isFinite(number))
        {
            return OVERFLOW;
        }
        return number !== 0 && Math.abs(number) < MIN_NORMAL || scanned.range ? UNDERFLOW : 0;
    };

    /**
     * _gcvt's text of the double in the first two slots: `digits` significant
     * digits, the trailing zeros of the fraction dropped and the point kept
     * -- "-314150." -- or, for an exponent below -4 or not below `digits`,
     * one digit, the fraction, and an exponent of three digits ("1.2e+005").
     *
     * @param {number[]} slots @param {number} digits
     */
    const gcvtText = (slots, digits)=>{
        const value = readDouble(slots, 0);
        if (!Number.isFinite(value))
        {
            return String(value);
        }
        const count = Math.max(1, Math.min(digits, MAX_DIGITS));
        const { digits: text, point, negative } = cvtDigits({ value, low: slots[0] >>> 0,
            high: slots[1] >>> 0 }, count, false);
        const sign = negative && value !== 0 ? '-' : '';
        if (value === 0)
        {
            return `${sign}0.`;
        }
        const exponent = point - 1;
        if (exponent < -4 || exponent >= count)
        {
            return `${sign}${text[0]}.${text.slice(1).replace(/0+$/, '')}e${
                exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(3, '0')}`;
        }
        if (point > 0)
        {
            return `${sign}${text.slice(0, point)}.${text.slice(point).replace(/0+$/, '')}`;
        }
        return `${sign}0.${'0'.repeat(-point)}${text.replace(/0+$/, '')}`;
    };

    /** @param {boolean} fixed */
    const secureCvt = fixed=>({
        convention: 'cdecl',
        argBytes: 28,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [buffer, size, low, high, count, point, sign])=>{
            if ((buffer >>> 0) === 0 || (size >>> 0) === 0 || (point >>> 0) === 0
                || (sign >>> 0) === 0)
            {
                host.errno?.(EINVAL);
                return EINVAL;
            }
            const answer = cvtDigits({ value: readDouble([low, high], 0), low: low >>> 0,
                high: high >>> 0 }, count | 0, fixed);
            writeInt(point, answer.point);
            writeInt(sign, answer.negative ? 1 : 0);
            if (answer.digits.length + 1 > (size >>> 0))
            {
                writeString(buffer, '');
                host.errno?.(ERANGE);
                return ERANGE;
            }
            writeString(buffer, answer.digits);
            return 0;
        },
    });

    const { readMemory, writeMemory } = host;
    const table = {
        /**
         * int $I10_OUTPUT(_LDOUBLE value, int precision, int flags, I10_OUTPUT_data *out)
         *
         * The digits of an extended (ldouble.js `extendedDigits`), passed by
         * value in three stack slots, into `{ short pos; char sign; BYTE len;
         * char str[100]; }`: the sign ' ' or '-', the digits terminated after
         * `len`. Bit 0 of `flags` counts the precision after the point.
         */
        '$I10_OUTPUT': {
            convention: 'cdecl',
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([low, high, top, precision, flags, out])=>{
                const value = new Uint8Array(10);
                const view = new DataView(value.buffer);
                view.setUint32(0, low >>> 0, true);
                view.setUint32(4, high >>> 0, true);
                view.setUint16(8, top & 0xffff, true);
                const answer = extendedDigits(value, precision | 0, (flags & 1) !== 0);
                const bytes = new Uint8Array(4 + answer.buffer.length + 1);
                const record = new DataView(bytes.buffer);
                record.setInt16(0, answer.pos, true);
                bytes[2] = answer.negative ? 0x2d : 0x20;
                bytes[3] = answer.len;
                for (let at = 0; at < answer.buffer.length; at++)
                {
                    bytes[4 + at] = answer.buffer.charCodeAt(at);
                }
                bytes[4 + answer.len] = 0;
                host.writeMemory(out >>> 0, bytes.subarray(0, Math.max(4 + answer.len + 1,
                    4 + answer.buffer.length)));
                return answer.ok;
            },
        },

        /**
         * int __STRINGTOLD(_LDOUBLE *value, char **end, const char *text, int flags)
         *
         * strtod's reading of `text` into the x87's ten-byte extended, rounded
         * once (ldouble.js): 0, 1 for an underflow, 2 for an overflow (the
         * value an infinity), 4 when there is no number -- the value zero and
         * `*end` the text itself. errno is not touched; `flags` asks for
         * nothing msvcrt is known to read.
         */
        __STRINGTOLD: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([value, end, text])=>{
                const { bytes, end: read, status } = decimalToExtended(readString(text));
                host.writeMemory(value, bytes);
                if ((end >>> 0) !== 0)
                {
                    const pointer = new Uint8Array(4);
                    new DataView(pointer.buffer).setUint32(0, text + read >>> 0, true);
                    host.writeMemory(end, pointer);
                }
                return status;
            },
        },

        // Code in the guest (`inguest.js`), which hands the host a value out
        // of range -- errno is the calling thread's, and only the host
        // reaches it -- and a base it does not take; the handlers above
        // answer those, through a trap the code jumps to.
        /**
         * __int64 _strtoi64(const char *str, char **end, int base) and
         * unsigned __int64 _strtoui64: strtol and strtoul in 64 bits, the
         * high half in EDX; out of range clamped with ERANGE.
         */
        _strtoi64: strtoInteger(12, toInt64, int64Limit, false, true),
        _strtoui64: strtoInteger(12, toUint64, uint64Limit, false, true),

        strtol: readMemory
            ? guestEntry(inGuest.strtol, COMPILED.strtol, { readMemory, writeMemory }, strtol)
            : strtol,
        strtoul: readMemory
            ? guestEntry(inGuest.strtoul, COMPILED.strtoul, { readMemory, writeMemory }, strtoul)
            : strtoul,

        ...readMemory ? {
            /**
             * long wcstol(const wchar_t *str, wchar_t **end, int base) and
             * unsigned long wcstoul: strtol and strtoul over a wide string,
             * reading the decimal digits of the scripts msvcrt reads and the
             * separators Unicode has as white space.
             */
            wcstol: strtoInteger(12, toLong, longLimit, true),
            wcstoul: strtoInteger(12, toUnsignedLong, unsignedLongLimit, true),

            /**
             * __int64 _wcstoi64(const wchar_t *str, wchar_t **end, int base)
             * and unsigned __int64 _wcstoui64: the wide readings in 64 bits,
             * the high half in EDX.
             */
            _wcstoi64: strtoInteger(12, toInt64, int64Limit, true, true),
            _wcstoui64: strtoInteger(12, toUint64, uint64Limit, true, true),

            _wtoi: wideAtoi,
            _wtol: wideAtoi,
        } : {},

        /** wchar_t *_itow(int value, wchar_t *buffer, int radix) -- _ltoa's text, wide */
        _itow: toText(1, true, true),

        /** wchar_t *_ltow(long value, wchar_t *buffer, int radix) */
        _ltow: toText(1, true, true),

        /** wchar_t *_ultow(unsigned long value, wchar_t *buffer, int radix) */
        _ultow: toText(1, false, true),

        /** char *_ltoa(long value, char *buffer, int radix) */
        _ltoa: toText(1, true),

        /** char *ltoa(long, char *, int) -- the name without the underscore */
        ltoa: toText(1, true),

        /** char *_ultoa(unsigned long value, char *buffer, int radix) */
        _ultoa: toText(1, false),

        /** char *_ui64toa(unsigned __int64 value, char *buffer, int radix) */
        _ui64toa: toText(2, false),

        /** char *_i64toa(__int64 value, char *buffer, int radix) */
        _i64toa: toText(2, true),

        /** int abs(int value) -- in the guest */
        abs: guestEntry(inGuest.abs, COMPILED.abs, {}),

        /** long labs(long value) -- the same function on a 32-bit target */
        labs: guestEntry(inGuest.abs, COMPILED.abs, {}),

        /**
         * char *_ecvt(double value, int count, int *dec, int *sign)
         *
         * Digits only: no sign, no point. Where the point belongs and whether
         * the value was negative come back through the two pointers, and a
         * caller that ignores them prints the magnitude of the wrong number by
         * a power of ten. `count` significant digits, of the seventeen msvcrt
         * converts a double to (`cvtDigits`).
         */
        _ecvt: cvt(false),

        /**
         * char *_fcvt(double value, int count, int *dec, int *sign)
         *
         * The count is digits after the point here, not significant digits, and
         * a value below one loses its leading zeros to a negative *dec.
         */
        _fcvt: cvt(true),

        /**
         * int _atodbl(_CRT_DOUBLE *value, char *str)
         *
         * strtod's reading into the caller's double: 0, or _UNDERFLOW (4) or
         * _OVERFLOW (3) for a value out of range -- the value written as
         * strtod has it, a denormal kept -- and errno untouched.
         */
        _atodbl: { convention: 'cdecl', argBytes: 8, handler: (/** @type {number[]} */ args)=>
            toDouble(args[0], args[1]) },

        /**
         * int _atodbl_l(_CRT_DOUBLE *value, char *str, _locale_t locale)
         *
         * _atodbl in the locale given, which is the C locale's: the only one
         * carried.
         */
        _atodbl_l: { convention: 'cdecl', argBytes: 12, handler: (/** @type {number[]} */ args)=>
            toDouble(args[0], args[1]) },

        /**
         * errno_t _ecvt_s(char *buffer, size_t size, double value, int count,
         *                 int *dec, int *sign) and _fcvt_s
         *
         * _ecvt's and _fcvt's digits into the caller's buffer: EINVAL for no
         * buffer, no room or no pointer for the point or the sign, ERANGE
         * and an empty buffer when the digits do not fit with a terminator.
         */
        _ecvt_s: secureCvt(false),
        _fcvt_s: secureCvt(true),

        /**
         * char *_gcvt(double value, int digits, char *buffer)
         *
         * This one writes into the caller's buffer and prints a complete
         * number, point and sign included (`gcvtText`). No buffer is null
         * and EINVAL, a negative count null and ERANGE.
         */
        _gcvt: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>{
                const buffer = args[3];
                if ((args[2] | 0) < 0)
                {
                    host.errno?.(ERANGE);
                    return 0;
                }
                if ((buffer >>> 0) === 0)
                {
                    host.errno?.(EINVAL);
                    return 0;
                }
                writeString(buffer, gcvtText(args, args[2] | 0));
                return buffer;
            },
        },

        /**
         * errno_t _gcvt_s(char *buffer, size_t size, double value, int digits)
         *
         * _gcvt into a buffer of `size`: EINVAL for none, ERANGE and an empty
         * buffer when it cannot hold `digits` or the text.
         */
        _gcvt_s: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([buffer, size, low, high, digits])=>{
                if ((buffer >>> 0) === 0 || (size >>> 0) === 0 || (digits | 0) < 0)
                {
                    host.errno?.(EINVAL);
                    return EINVAL;
                }
                const text = gcvtText([low, high], digits | 0);
                if ((digits | 0) >= (size >>> 0) || text.length + 1 > (size >>> 0))
                {
                    writeString(buffer, '');
                    host.errno?.(ERANGE);
                    return ERANGE;
                }
                writeString(buffer, text);
                return 0;
            },
        },
    };

    if (!host.fpu)
    {
        return table;
    }

    /**
     * The value, and errno set where it is out of range.
     *
     * @param {ReturnType<typeof scanDecimal>} scanned
     */
    const decimal = scanned=>{
        if (scanned?.range)
        {
            host.errno?.(ERANGE);
        }
        return scanned ? scanned.value : 0;
    };

    /**
     * The text of the number at `pointer`, as far as `DECIMAL` could read it:
     * a window's bytes up to the first that spells no number, or the whole
     * string where the window holds no such byte or runs past what is mapped.
     * A call here is one the guest's code handed over -- a sixteenth digit, a
     * larger scale -- and the whole string's read and decode cost it more than
     * the rest of the call.
     *
     * @param {number} pointer
     */
    const decimalText = pointer=>{
        if (readMemory)
        {
            /** @type {Uint8Array} */
            let bytes = new Uint8Array(0);
            try
            {
                bytes = readMemory(pointer, DECIMAL_WINDOW);
            }
            catch {
                // The window runs past the string's region: the walk below
                // stops at the region's end.
            }
            for (let at = 0; at < bytes.length; at++)
            {
                if (SPELLS_DECIMAL[bytes[at]] === 0)
                {
                    let text = '';
                    for (let i = 0; i < at; i++)
                    {
                        text += String.fromCharCode(bytes[i]);
                    }
                    return text;
                }
            }
        }
        return readString(pointer);
    };

    /**
     * strtod's handler: no text is zero and EINVAL, the end null.
     *
     * @param {number[]} args
     */
    const strtod = args=>{
        if ((args[0] >>> 0) === 0)
        {
            host.errno?.(EINVAL);
            writeInt(args[1], 0);
            return 0;
        }
        const scanned = scanDecimal(decimalText(args[0]));
        writeInt(args[1], scanned ? args[0] + scanned.end : args[0]);
        return decimal(scanned);
    };

    /**
     * double wcstod(const wchar_t *str, wchar_t **end): strtod's reading of
     * a wide string, the end two bytes a character.
     *
     * @param {number[]} args
     */
    const wcstod = args=>{
        if ((args[0] >>> 0) === 0)
        {
            host.errno?.(EINVAL);
            writeInt(args[1], 0);
            return 0;
        }
        const text = wideStringAt(/** @type {(address: number, length: number)
            => Uint8Array} */ (readMemory), args[0]);
        const scanned = scanDecimal(text);
        writeInt(args[1], scanned ? args[0] + scanned.end * 2 : args[0]);
        return decimal(scanned);
    };

    const handlers = {
        /** double atof(const char *str) */
        atof: returningDouble(host.fpu, 4, args=>strtod([args[0], 0])),

        /** double strtod(const char *str, char **end) */
        strtod: returningDouble(host.fpu, 8, strtod),
    };

    // Code in the guest (`inguest-float.js`), which reads the number and
    // computes the values Clinger's fast path makes exact; the handlers above
    // answer the rest, and set errno for an overflow or an underflow.
    const guest = { readMemory, writeMemory, fpu: host.fpu };
    return {
        ...table,
        ...readMemory ? { wcstod: returningDouble(host.fpu, 8, wcstod) } : {},
        atof: readMemory
            ? guestEntry(inGuestFloat.atof, FLOAT_CODE.atof, guest, handlers.atof)
            : handlers.atof,
        strtod: readMemory
            ? guestEntry(inGuestFloat.strtod, FLOAT_CODE.strtod, guest, handlers.strtod)
            : handlers.strtod,

        // The `_l` forms' locale is the C one, the only one carried.
        /** double _atof_l(const char *str, _locale_t locale) */
        _atof_l: returningDouble(host.fpu, 8, args=>strtod([args[0], 0])),
        /** double _strtod_l(const char *str, char **end, _locale_t locale) */
        _strtod_l: returningDouble(host.fpu, 12, strtod),
    };
}
