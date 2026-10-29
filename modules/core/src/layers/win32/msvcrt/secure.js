/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The secure string and memory functions: the copies, appends and
 * conversions that are told the size of the buffer they write.
 *
 * What they have in common is what they do with a bad argument, which is the
 * contract a caller tests: a missing buffer or a size of zero is EINVAL and
 * nothing written; anything else wrong clears the first character, so the
 * buffer holds an empty string whatever it held; and a result that does not
 * fit is ERANGE. Each sets errno to what it answers. msvcrt writes a string a
 * character at a time and learns it has run out of room only when it has, so
 * the characters that fitted are still in the buffer behind the cleared first
 * one -- which is observable, and kept.
 */

import { EINVAL, ERANGE } from './globals.js';
import { LOWER, UPPER } from './inguest.js';
import { unitsAt } from './widetext.js';

/**
 * @typedef {Object} SecureHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} [errno]
 */

/** `_TRUNCATE`: a count that asks for as much as fits. */
const TRUNCATE = 0xffffffff;

/** What an append or copy that was cut short under `_TRUNCATE` answers. */
export const STRUNCATE = 80;

/** A string is read no further than this, since nothing in C bounds one. */
const MAX_STRING = 1 << 20;

/**
 * @param {SecureHost} host
 */
export function createSecureFunctions(host){
    /** @param {number} code */
    const fail = code=>{
        host.errno?.(code);
        return code;
    };

    /**
     * A string's units up to its terminator or `limit` units, whichever comes
     * first, read no further than either: a count may end inside a string
     * that is not terminated before its region does.
     *
     * @param {number} pointer @param {number} unit  Bytes a character.
     * @param {number} limit
     * @returns {{ units: number[], terminated: boolean }}
     */
    const readUnits = (pointer, unit, limit)=>{
        const most = Math.min(limit, MAX_STRING);
        const units = [...unitsAt(host.readMemory, pointer, /** @type {1 | 2} */ (unit), most)];
        return { units, terminated: units.length < most };
    };

    /** @param {number} pointer @param {number} unit @param {number[]} units */
    const writeUnits = (pointer, unit, units)=>{
        if (units.length === 0)
        {
            return;
        }
        const bytes = new Uint8Array(units.length * unit);
        units.forEach((value, index)=>{
            bytes[index * unit] = value & 0xff;
            if (unit === 2)
            {
                bytes[index * 2 + 1] = value >>> 8 & 0xff;
            }
        });
        host.writeMemory(pointer, bytes);
    };

    /** The first character cleared. @param {number} pointer @param {number} unit */
    const clear = (pointer, unit)=>writeUnits(pointer, unit, [0]);

    /**
     * Copies a string a character at a time, at most `limit` characters and
     * the terminator among them if it comes. Each character is read after
     * the ones before it were written, as msvcrt's loop reads them, so a
     * destination that overlaps the source ahead of it reads back what it
     * wrote -- the source repeats until the room runs out.
     *
     * @param {number} destination @param {number} source @param {number} unit
     * @param {number} limit
     * @returns {boolean}  Whether the terminator was copied.
     */
    const copyUnits = (destination, source, unit, limit)=>{
        const most = Math.min(limit, MAX_STRING);
        const gap = (destination >>> 0) - (source >>> 0);
        if (gap <= 0 || gap >= most * unit)
        {
            const { units, terminated } = readUnits(source, unit, most);
            writeUnits(destination, unit, terminated ? [...units, 0] : units);
            return terminated;
        }
        const window = host.readMemory(source, gap + most * unit).slice();
        for (let index = 0; index < most; index++)
        {
            const from = index * unit;
            let zero = true;
            for (let byte = 0; byte < unit; byte++)
            {
                window[gap + from + byte] = window[from + byte];
                zero = zero && window[from + byte] === 0;
            }
            if (zero)
            {
                host.writeMemory(destination, window.subarray(gap, gap + from + unit));
                return true;
            }
        }
        host.writeMemory(destination, window.subarray(gap, gap + most * unit));
        return false;
    };

    /**
     * errno_t strcpy_s(char *dst, size_t size, const char *src), and wcscpy_s.
     *
     * @param {number} unit
     */
    const copy = unit=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [destination, size, source])=>{
            const room = size >>> 0;
            if ((destination >>> 0) === 0 || room === 0)
            {
                return fail(EINVAL);
            }
            if ((source >>> 0) === 0)
            {
                clear(destination, unit);
                return fail(EINVAL);
            }
            if (copyUnits(destination, source, unit, room))
            {
                return 0;
            }
            clear(destination, unit);
            return fail(ERANGE);
        },
    });

    /**
     * The end of a string within its size, or null -- and the string cleared
     * -- when it has no terminator there.
     *
     * @param {number} pointer @param {number} unit @param {number} room
     */
    const endWithin = (pointer, unit, room)=>{
        const { units, terminated } = readUnits(pointer, unit, room);
        if (!terminated)
        {
            clear(pointer, unit);
            return null;
        }
        return units.length;
    };

    /**
     * errno_t strcat_s(char *dst, size_t size, const char *src), and
     * wcscat_s: a destination with no terminator within its size is EINVAL.
     *
     * @param {number} unit
     */
    const append = unit=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [destination, size, source])=>{
            const room = size >>> 0;
            if ((destination >>> 0) === 0 || room === 0)
            {
                return fail(EINVAL);
            }
            if ((source >>> 0) === 0)
            {
                clear(destination, unit);
                return fail(EINVAL);
            }
            const end = endWithin(destination, unit, room);
            if (end === null)
            {
                return fail(EINVAL);
            }
            if (copyUnits(destination + end * unit, source, unit, room - end))
            {
                return 0;
            }
            clear(destination, unit);
            return fail(ERANGE);
        },
    });

    /**
     * What the counted copy and append do once `count` characters are copied
     * or the room is full: a terminator after `count` characters that left
     * room for one; under `_TRUNCATE` the last character of the room given
     * over to it, STRUNCATE; otherwise the string cleared, ERANGE.
     *
     * @param {number} start  Where the copy began.
     * @param {number} unit @param {number} room  Units from `start` to the end.
     * @param {number} wanted  The count asked for.
     * @param {number} whole  The destination, cleared on ERANGE.
     */
    const finishCounted = (start, unit, room, wanted, whole)=>{
        if (wanted < room)
        {
            writeUnits(start + wanted * unit, unit, [0]);
            return 0;
        }
        if (wanted === TRUNCATE)
        {
            writeUnits(start + (room - 1) * unit, unit, [0]);
            return STRUNCATE;
        }
        clear(whole, unit);
        return fail(ERANGE);
    };

    /**
     * errno_t strncpy_s(char *dst, size_t size, const char *src, size_t count),
     * and wcsncpy_s: at most `count` characters and a terminator; a count
     * of zero writes the terminator alone, with or without a source, and
     * `_TRUNCATE` copies what fits, answering STRUNCATE when that is not all.
     *
     * @param {number} unit
     */
    const copyCounted = unit=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [destination, size, source, count])=>{
            const room = size >>> 0;
            const wanted = count >>> 0;
            if (wanted === 0 && (destination >>> 0) === 0 && room === 0)
            {
                return 0;
            }
            if ((destination >>> 0) === 0 || room === 0)
            {
                return fail(EINVAL);
            }
            if ((source >>> 0) === 0)
            {
                clear(destination, unit);
                return wanted === 0 ? 0 : fail(EINVAL);
            }
            if (copyUnits(destination, source, unit, Math.min(wanted, room)))
            {
                return 0;
            }
            return finishCounted(destination, unit, room, wanted, destination);
        },
    });

    /**
     * errno_t strncat_s(char *dst, size_t size, const char *src, size_t count),
     * and wcsncat_s: at most `count` characters appended; no source is
     * refused only when there is something to append.
     *
     * @param {number} unit
     */
    const appendCounted = unit=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [destination, size, source, count])=>{
            const room = size >>> 0;
            const wanted = count >>> 0;
            if ((destination >>> 0) === 0 || room === 0)
            {
                return fail(EINVAL);
            }
            if ((source >>> 0) === 0)
            {
                if (wanted === 0)
                {
                    return 0;
                }
                clear(destination, unit);
                return fail(EINVAL);
            }
            const end = endWithin(destination, unit, room);
            if (end === null)
            {
                return fail(EINVAL);
            }
            const start = destination + end * unit;
            if (copyUnits(start, source, unit, Math.min(wanted, room - end)))
            {
                return 0;
            }
            return finishCounted(start, unit, room - end, wanted, destination);
        },
    });

    /**
     * size_t strnlen(const char *str, size_t max), and wcsnlen.
     *
     * @param {number} unit
     */
    const lengthBounded = unit=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [string, max])=>readUnits(string, unit, max >>> 0)
            .units.length,
    });

    /**
     * _strlwr_s, _strupr_s, _wcslwr_s and _wcsupr_s: the C locale's ASCII
     * folded in place. The string is measured before it is changed, so one
     * with no terminator within its size is only cleared, EINVAL -- and so
     * is one given a size of zero.
     *
     * @param {number} unit @param {Uint8Array} table
     */
    const fold = (unit, table)=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [string, size])=>{
            if ((string >>> 0) === 0)
            {
                return fail(EINVAL);
            }
            const { units, terminated } = readUnits(string, unit, size >>> 0);
            if (!terminated)
            {
                clear(string, unit);
                return fail(EINVAL);
            }
            writeUnits(string, unit, units.map(value=>(value < 0x80 ? table[value] : value)));
            return 0;
        },
    });

    /**
     * _strnset_s, _wcsnset_s, _strset_s and _wcsset_s: characters set to one
     * as the walk to the terminator passes them, short of the last place the
     * size leaves, so a string with no terminator within its size has all
     * but that set before it is cleared, EINVAL. A size of zero is EINVAL
     * with nothing written -- and nothing at all asked of no string is none.
     *
     * @param {number} unit @param {boolean} counted
     */
    const set = (unit, counted)=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: counted ? 16 : 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [string, size, character, count])=>{
            const room = size >>> 0;
            const most = counted ? count >>> 0 : TRUNCATE;
            if ((string >>> 0) === 0 && room === 0 && counted && most === 0)
            {
                return 0;
            }
            if ((string >>> 0) === 0 || room === 0)
            {
                return fail(EINVAL);
            }
            const { units, terminated } = readUnits(string, unit, room);
            const length = Math.min(units.length, room - 1, most);
            writeUnits(string, unit, new Array(length).fill(character & (unit === 1 ? 0xff
                : 0xffff)));
            if (!terminated)
            {
                clear(string, unit);
                return fail(EINVAL);
            }
            return 0;
        },
    });

    /**
     * The `_*toa_s` family: `_itoa`'s text -- signed in base ten alone -- in
     * a buffer of a size. msvcrt writes a sign and then the digits from the
     * last, so a text that does not fit leaves the buffer holding them in
     * that order behind the cleared first character.
     *
     * @param {number} valueSlots @param {boolean} signed
     */
    const toText = (valueSlots, signed)=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: (valueSlots + 3) * 4,
        // An __int64 value is one argument to an x86-64 caller.
        ...valueSlots === 2 ? { quadwords: [0] } : {},
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            const buffer = args[valueSlots];
            const room = args[valueSlots + 1] >>> 0;
            const radix = args[valueSlots + 2] | 0;
            if ((buffer >>> 0) === 0 || room === 0)
            {
                return fail(EINVAL);
            }
            if (radix < 2 || radix > 36)
            {
                clear(buffer, 1);
                return fail(EINVAL);
            }
            let pattern = 0n;
            for (let slot = valueSlots - 1; slot >= 0; slot--)
            {
                pattern = (pattern << 32n) | BigInt(args[slot] >>> 0);
            }
            const value = signed && radix === 10 ? BigInt.asIntN(valueSlots * 32, pattern)
                : pattern;
            const digits = Array.from((value < 0n ? -value : value).toString(radix),
                character=>character.charCodeAt(0));
            const sign = value < 0n ? [0x2d] : [];
            if (sign.length + digits.length < room)
            {
                writeUnits(buffer, 1, [...sign, ...digits, 0]);
                return 0;
            }
            writeUnits(buffer, 1, [...sign, ...digits.reverse()].slice(0, room));
            clear(buffer, 1);
            return fail(ERANGE);
        },
    });

    return {
        strcpy_s: copy(1),
        wcscpy_s: copy(2),
        strcat_s: append(1),
        wcscat_s: append(2),
        strncpy_s: copyCounted(1),
        wcsncpy_s: copyCounted(2),
        strncat_s: appendCounted(1),
        wcsncat_s: appendCounted(2),
        strnlen: lengthBounded(1),
        wcsnlen: lengthBounded(2),

        /**
         * errno_t memcpy_s(void *dst, size_t size, const void *src, size_t count)
         *
         * Nothing to copy is no error, whatever the pointers; no source, or
         * more than the destination holds, zeroes the whole destination.
         */
        memcpy_s: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, size, source, count])=>{
                const room = size >>> 0;
                const length = count >>> 0;
                if (length === 0)
                {
                    return 0;
                }
                if ((destination >>> 0) === 0)
                {
                    return fail(EINVAL);
                }
                if ((source >>> 0) === 0 || length > room)
                {
                    if (room !== 0)
                    {
                        host.writeMemory(destination, new Uint8Array(room));
                    }
                    return fail((source >>> 0) === 0 ? EINVAL : ERANGE);
                }
                host.writeMemory(destination, host.readMemory(source, length).slice());
                return 0;
            },
        },

        /**
         * errno_t memmove_s(void *dst, size_t size, const void *src, size_t count)
         *
         * memcpy_s's refusals, the destination left as it was.
         */
        memmove_s: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, size, source, count])=>{
                const length = count >>> 0;
                if (length === 0)
                {
                    return 0;
                }
                if ((destination >>> 0) === 0 || (source >>> 0) === 0)
                {
                    return fail(EINVAL);
                }
                if (length > (size >>> 0))
                {
                    return fail(ERANGE);
                }
                host.writeMemory(destination, host.readMemory(source, length).slice());
                return 0;
            },
        },

        /** errno_t _strlwr_s(char *str, size_t size) */
        _strlwr_s: fold(1, LOWER),
        /** errno_t _strupr_s(char *str, size_t size) */
        _strupr_s: fold(1, UPPER),
        /** errno_t _wcslwr_s(wchar_t *str, size_t size) */
        _wcslwr_s: fold(2, LOWER),
        /** errno_t _wcsupr_s(wchar_t *str, size_t size) */
        _wcsupr_s: fold(2, UPPER),

        /** errno_t _strnset_s(char *str, size_t size, int c, size_t count) */
        _strnset_s: set(1, true),
        /** errno_t _wcsnset_s(wchar_t *str, size_t size, wchar_t c, size_t count) */
        _wcsnset_s: set(2, true),
        /** errno_t _strset_s(char *str, size_t size, int c) */
        _strset_s: set(1, false),
        /** errno_t _wcsset_s(wchar_t *str, size_t size, wchar_t c) */
        _wcsset_s: set(2, false),

        /** errno_t _itoa_s(int value, char *buffer, size_t size, int radix) */
        _itoa_s: toText(1, true),
        /** errno_t _ltoa_s(long value, char *buffer, size_t size, int radix) */
        _ltoa_s: toText(1, true),
        /** errno_t _ultoa_s(unsigned long value, char *buffer, size_t size, int radix) */
        _ultoa_s: toText(1, false),
        /** errno_t _i64toa_s(__int64 value, char *buffer, size_t size, int radix) */
        _i64toa_s: toText(2, true),
        /** errno_t _ui64toa_s(unsigned __int64 value, char *buffer, size_t size, int radix) */
        _ui64toa_s: toText(2, false),
    };
}
