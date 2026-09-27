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
import { ERANGE } from './globals.js';
import { guestEntry } from './guest-code.js';
import * as inGuest from './inguest.js';
import { COMPILED } from './inguest.x86.js';

const MAX_STRING = 1 << 20;

const LONG_MAX = 0x7fffffffn;
const LONG_MIN = -0x80000000n;
const ULONG_MAX = 0xffffffffn;

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
export function scanInteger(text, requestedBase, zeroBeforeX = false){
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
    if ((base === 0 || base === 16) && hexPrefix && (hexDigitAfter || !zeroBeforeX))
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
        magnitude = magnitude * BigInt(base) + BigInt(digit);
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
     */
    const strtoInteger = (argBytes, convert, limit)=>({
        convention: 'cdecl',
        argBytes,
        /** @param {number[]} args */
        handler: ([string, end, base])=>{
            const text = readString(string);
            const scanned = scanInteger(text, base | 0);
            // Nothing converted: the end pointer goes back to the start, so a
            // caller comparing it against the input sees no progress.
            writeInt(end, scanned ? string + scanned.end : string);
            if (scanned === null)
            {
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
            return Number(BigInt.asIntN(32, value));
        },
    });

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
     */
    const toText = (valueSlots, signed)=>({
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
            writeString(buffer, signed && radix === 10
                ? BigInt.asIntN(width, pattern).toString(10)
                : pattern.toString(radix));
            return buffer;
        },
    });

    /** long strtol(const char *str, char **end, int base) */
    const strtol = strtoInteger(12, (magnitude, negative)=>{
        const value = negative ? -magnitude : magnitude;
        return value > LONG_MAX || value < LONG_MIN ? null : value;
    }, negative=>(negative ? LONG_MIN : LONG_MAX));

    /**
     * unsigned long strtoul(const char *str, char **end, int base)
     *
     * A minus sign is accepted and the magnitude is negated within 32 bits,
     * which C requires: strtoul("-1") is ULONG_MAX, not a failure. A
     * magnitude out of range is clamped before the sign is applied, so a
     * negative one comes back as ULONG_MAX negated, 1 (Wine's msvcrt
     * test_strtol).
     */
    const strtoul = strtoInteger(12, (magnitude, negative)=>{
        if (magnitude > ULONG_MAX)
        {
            return null;
        }
        return negative ? BigInt.asUintN(32, -magnitude) : magnitude;
    }, negative=>(negative ? BigInt.asUintN(32, -ULONG_MAX) : ULONG_MAX));

    const { readMemory, writeMemory } = host;
    const table = {
        // Code in the guest (`inguest.js`), which hands the host a value out
        // of range -- errno is the calling thread's, and only the host
        // reaches it -- and a base it does not take; the handlers above
        // answer those, through a trap the code jumps to.
        strtol: readMemory
            ? guestEntry(inGuest.strtol, COMPILED.strtol, { readMemory, writeMemory }, strtol)
            : strtol,
        strtoul: readMemory
            ? guestEntry(inGuest.strtoul, COMPILED.strtoul, { readMemory, writeMemory }, strtoul)
            : strtoul,

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
         * a power of ten.
         */
        _ecvt: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>{
                const value = readDouble(args, 0);
                const count = Math.max(0, Math.min(args[2] | 0, MAX_DIGITS));
                const buffer = cvtBuffer();
                writeInt(args[4], value < 0 ? 1 : 0);
                if (value === 0 || !Number.isFinite(value))
                {
                    writeInt(args[3], 0);
                    writeString(buffer, '0'.repeat(count));
                    return buffer;
                }
                const [mantissa, exponent] = Math.abs(value)
                    .toExponential(Math.max(0, count - 1)).split('e');
                writeInt(args[3], Number(exponent) + 1);
                writeString(buffer, mantissa.replace('.', '').padEnd(count, '0'));
                return buffer;
            },
        },

        /**
         * char *_fcvt(double value, int count, int *dec, int *sign)
         *
         * The count is digits after the point here, not significant digits, and
         * a value below one loses its leading zeros to a negative *dec.
         */
        _fcvt: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>{
                const value = readDouble(args, 0);
                const count = Math.max(0, Math.min(args[2] | 0, MAX_DIGITS));
                const buffer = cvtBuffer();
                writeInt(args[4], value < 0 ? 1 : 0);
                if (!Number.isFinite(value))
                {
                    writeInt(args[3], 0);
                    writeString(buffer, '');
                    return buffer;
                }
                const [whole, fraction = ''] = Math.abs(value).toFixed(count).split('.');
                let digits = (whole === '0' ? '' : whole) + fraction;
                let point = whole === '0' ? 0 : whole.length;
                while (digits.length > 0 && digits[0] === '0')
                {
                    digits = digits.slice(1);
                    point--;
                }
                writeInt(args[3], digits.length === 0 ? 0 : point);
                writeString(buffer, digits);
                return buffer;
            },
        },

        /**
         * char *_gcvt(double value, int digits, char *buffer)
         *
         * This one writes into the caller's buffer and prints a complete
         * number, point and sign included -- the shortest of the fixed and
         * exponential forms, which is what %g does.
         */
        _gcvt: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>{
                const value = readDouble(args, 0);
                const digits = Math.max(1, Math.min(args[2] | 0, MAX_DIGITS));
                const buffer = args[3];
                writeString(buffer, Number.isFinite(value)
                    ? value.toPrecision(digits).replace(/e([+-])(\d)$/, 'e$10$2')
                    : String(value));
                return buffer;
            },
        },
    };

    if (!host.fpu)
    {
        return table;
    }

    /** @param {number[]} args */
    const strtod = args=>{
        const text = readString(args[0]);
        const scanned = scanFloat(text);
        writeInt(args[1], scanned ? args[0] + scanned.end : args[0]);
        return scanned ? scanned.value : 0;
    };

    return {
        ...table,

        /** double atof(const char *str) */
        atof: returningDouble(host.fpu, 4, args=>{
            const scanned = scanFloat(readString(args[0]));
            return scanned ? scanned.value : 0;
        }),

        /** double strtod(const char *str, char **end) */
        strtod: returningDouble(host.fpu, 8, strtod),
    };
}
