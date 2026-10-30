/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Characters that are not one byte wide.
 *
 * Two families live here for one reason: both exist because `char` is not the
 * unit a program means. The wide family is UTF-16, two bytes per unit, and is
 * what Win32 itself speaks. The multi-byte family is the other answer to the
 * same problem -- a variable-width encoding, chosen by the multibyte code page
 * `_setmbcp` selects (`mbcs.js`): under a single-byte page every character is
 * one byte and every `_mbs*` function is its `str*` equivalent exactly; under
 * a double-byte one a lead byte and its trail are one character.
 */

import { EILSEQ, EINVAL } from './globals.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { guestEntry } from './guest-code.js';
import * as inGuest from './inguest.js';
import {
    LOWER, UPPER, WEOF, WIDE_CTYPE, CT_UPPER, CT_LOWER, CT_DIGIT, CT_SPACE, CT_PUNCT, CT_CONTROL,
    CT_BLANK, CT_HEX, CT_LETTER, CT_ALPHA,
} from './inguest.js';
import { COMPILED } from './inguest.x86.js';
import { compareUnitsAt, wideStringAt } from './widetext.js';
import { createMultiByteHandlers, createMultiBytePage } from './mbcs.js';
import { pointerWidth } from '../common/pointers.js';
import {
    SHIFT_JIS, jisToShiftJis, shiftJisToJis, toHiragana, toKatakana, isKatakana, toFullWidth,
    toHalfWidth, jisLevel,
} from './kana.js';

const MAX_STRING = 1 << 20;

/**
 * @typedef {Object} WideHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} [errno]  Where a failure says why.
 * @property {(bytes: number) => number} [allocate]  The heap a duplicate is
 *           made on; without it `_wcsdup` stays unexported.
 * @property {number} [pointerSize]  8 in a 64-bit process, where the string
 *           pointer `mbsrtowcs` and `wcsrtombs` advance is a quadword; absent, 4.
 */

/** WEOF, and what no class is answered for. */
const NO_CLASS = 0;

/**
 * msvcrt's class bits of a wide code unit: the table's below 0x100, and past
 * it the unit's Unicode category, as the system's GetStringTypeW answers --
 * a letter's case, a decimal digit of any script, a space separator as blank
 * too, punctuation and symbols as punctuation, the full-width hex digits.
 *
 * @param {number} unit
 */
export function wideClassOf(unit){
    if (unit < WIDE_CTYPE.length)
    {
        return WIDE_CTYPE[unit];
    }
    if (unit === WEOF)
    {
        return NO_CLASS;
    }
    const character = String.fromCharCode(unit);
    /** @param {RegExp} pattern @param {number} bits */
    const when = (pattern, bits)=>(pattern.test(character) ? bits : 0);
    return when(/[\p{Lu}\p{Lt}]/u, CT_UPPER) | when(/\p{Ll}/u, CT_LOWER)
        | when(/\p{L}/u, CT_LETTER) | when(/\p{Nd}/u, CT_DIGIT)
        | when(/\p{Zs}/u, CT_SPACE | CT_BLANK) | when(/[\p{Zl}\p{Zp}]/u, CT_SPACE)
        | when(/[\p{P}\p{S}]/u, CT_PUNCT) | when(/\p{Cc}/u, CT_CONTROL)
        | when(/[\uff10-\uff19\uff21-\uff26\uff41-\uff46]/, CT_HEX);
}

/** The classes each wide classifier asks for, in msvcrt's bits. */
const WIDE_MASKS = Object.freeze({
    iswalpha: CT_ALPHA, iswdigit: CT_DIGIT, iswalnum: CT_ALPHA | CT_DIGIT, iswspace: CT_SPACE,
    iswupper: CT_UPPER, iswlower: CT_LOWER, iswpunct: CT_PUNCT, iswxdigit: CT_HEX,
    iswcntrl: CT_CONTROL, iswprint: CT_BLANK | CT_PUNCT | CT_ALPHA | CT_DIGIT,
    iswgraph: CT_PUNCT | CT_ALPHA | CT_DIGIT,
});

/**
 * @param {WideHost} host
 */
export function createWideFunctions(host){
    const width = pointerWidth(host.pointerSize);
    /**
     * A narrow string as the C locale widens it, each byte to the unit of its
     * own value as mbtowc widens one: the memory layer reads the string in the
     * ANSI page, whose characters above 0x7f are not those units.
     *
     * @param {number} pointer
     */
    const readNarrowUnits = pointer=>Array.from(encodeAnsi(host.readCString(pointer, MAX_STRING)),
        byte=>String.fromCharCode(byte)).join('');

    /**
     * A wide string up to its terminator, sixty-four thousand units at most:
     * read a line at a time, never past the terminator's line, so a string
     * near the end of its region is not read beyond it.
     *
     * @param {number} pointer
     */
    const readWide = pointer=>wideStringAt(host.readMemory, pointer);

    /**
     * A wide string's first `count` units at most, read no further: an
     * n-bounded call stops at its count whether or not a terminator came.
     *
     * @param {number} pointer @param {number} count
     */
    const readWideUpTo = (pointer, count)=>wideStringAt(host.readMemory, pointer, count);

    /** @param {number} pointer @param {string} text @param {boolean} terminate */
    const writeWide = (pointer, text, terminate = true)=>{
        const bytes = new Uint8Array((text.length + (terminate ? 1 : 0)) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        host.writeMemory(pointer, bytes);
    };

    /** @param {number} pointer @param {string} text @param {boolean} terminate */
    const writeNarrow = (pointer, text, terminate)=>{
        const bytes = new Uint8Array(text.length + (terminate ? 1 : 0));
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(pointer, bytes);
    };

    /** @param {string} a @param {string} b */
    const compare = (a, b)=>(a === b ? 0 : (a < b ? -1 : 1));

    /** @param {string} text */
    const foldCase = text=>text.replace(/[A-Z]/g, letter=>letter.toLowerCase());

    /**
     * wcstok's saved position: one stream for the runtime, apart from
     * strtok's, kept as strtok keeps its own (`strings.js`).
     */
    let wideTokenAt = 0;

    /**
     * A unit through a byte table of the C locale's, which folds ASCII alone:
     * the table `_strlwr` and `_wcslwr_s` fold by.
     *
     * @param {Uint8Array} table @param {number} unit
     */
    const folded = (table, unit)=>(unit < 0x80 ? table[unit] : unit);

    /**
     * `_wcslwr` and `_wcsupr`: the string folded in place and handed back.
     *
     * @param {Uint8Array} table
     */
    const foldInPlace = table=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([string])=>{
            if ((string >>> 0) === 0)
            {
                host.errno?.(EINVAL);
                return 0;
            }
            const text = readWide(string);
            writeWide(string, String.fromCharCode(
                ...Array.from(text, unit=>folded(table, unit.charCodeAt(0)))), false);
            return string;
        },
    });

    /**
     * Where the first unit a set covers -- or, `inSet` false, the first it
     * does not -- stands in a string: its length when there is none.
     *
     * @param {number} string @param {number} set @param {boolean} inSet
     */
    const spanOf = (string, set, inSet)=>{
        const text = readWide(string);
        const members = new Set(readWide(set));
        let at = 0;
        while (at < text.length && members.has(text[at]) !== inSet)
        {
            at++;
        }
        return { at, found: at < text.length };
    };

    const wide = {
        /** size_t wcslen(const wchar_t *) -- in the guest */
        wcslen: guestEntry(inGuest.wcslen, COMPILED.wcslen, host),

        /** wchar_t *wcscpy(wchar_t *dest, const wchar_t *src) -- in the guest */
        wcscpy: guestEntry(inGuest.wcscpy, COMPILED.wcscpy, host),

        /** wchar_t *wcsncpy(wchar_t *dest, const wchar_t *src, size_t count) */
        wcsncpy: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const length = count >>> 0;
                const text = readWideUpTo(source, length);
                // Padded to the full count and unterminated when it truncates,
                // exactly as the narrow strncpy does.
                writeWide(destination, text.padEnd(length, '\0'), false);
                return destination;
            },
        },

        /**
         * size_t wcsxfrm(wchar_t *destination, const wchar_t *source, size_t count)
         *
         * strxfrm over wide strings: under the C locale a string is its own
         * key, as much of it and its terminator as `count` characters hold,
         * its length whatever fits. No source, or no destination for a count,
         * is INT_MAX and EINVAL.
         */
        wcsxfrm: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const room = count >>> 0;
                if ((source >>> 0) === 0 || ((destination >>> 0) === 0 && room !== 0))
                {
                    host.errno?.(EINVAL);
                    return 0x7fffffff;
                }
                const text = readWideUpTo(source, MAX_STRING);
                if (room !== 0)
                {
                    writeWide(destination, `${text}\0`.slice(0, room), false);
                }
                return text.length;
            },
        },

        ...host.allocate ? {
            /**
             * wchar_t *_wcsdup(const wchar_t *text)
             *
             * On the heap the caller frees it from; no string duplicates to
             * null, errno untouched.
             */
            _wcsdup: {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([text])=>{
                    if ((text >>> 0) === 0)
                    {
                        return 0;
                    }
                    const units = readWide(text);
                    const copy = /** @type {(bytes: number) => number} */ (host.allocate)(
                        (units.length + 1) * 2);
                    if (copy !== 0)
                    {
                        writeWide(copy, units);
                    }
                    return copy;
                },
            },
        } : {},

        /** wchar_t *wcscat(wchar_t *dest, const wchar_t *src) */
        wcscat: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                const existing = readWide(destination);
                writeWide(destination + existing.length * 2, readWide(source));
                return destination;
            },
        },

        /**
         * wchar_t *wcsncat(wchar_t *dest, const wchar_t *src, size_t count)
         *
         * At most `count` characters of the source after the destination's
         * end, and always a terminator -- unlike wcsncpy, no padding.
         */
        wcsncat: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const existing = readWide(destination);
                writeWide(destination + existing.length * 2,
                    readWideUpTo(source, count >>> 0));
                return destination;
            },
        },

        /** int wcscmp(const wchar_t *, const wchar_t *) -- in the guest */
        wcscmp: guestEntry(inGuest.wcscmp, COMPILED.wcscmp, host),

        /** int wcsncmp(const wchar_t *, const wchar_t *, size_t) */
        wcsncmp: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, count])=>Math.sign(
                compareUnitsAt(host.readMemory, left, right, 2, count >>> 0)),
        },

        /** int _wcsicmp(const wchar_t *, const wchar_t *) */
        _wcsicmp: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([left, right])=>compare(
                foldCase(readWide(left)), foldCase(readWide(right))),
        },

        /** wchar_t *wcschr(const wchar_t *, wchar_t) */
        wcschr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, unit])=>{
                const text = readWide(string);
                const wanted = unit & 0xffff;
                if (wanted === 0)
                {
                    return string + text.length * 2;
                }
                const index = text.indexOf(String.fromCharCode(wanted));
                return index === -1 ? 0 : string + index * 2;
            },
        },

        /** wchar_t *wcsrchr(const wchar_t *, wchar_t) */
        wcsrchr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, unit])=>{
                const text = readWide(string);
                const index = text.lastIndexOf(String.fromCharCode(unit & 0xffff));
                return index === -1 ? 0 : string + index * 2;
            },
        },

        /**
         * int _wcsnicmp(const wchar_t *left, const wchar_t *right, size_t count)
         *
         * At most `count` units compared with ASCII folded to lower case, as
         * `_wcsicmp` folds; the answer is the difference of the first two
         * that differ, the terminator ending both.
         */
        _wcsnicmp: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([left, right, count])=>{
                const limit = count >>> 0;
                if (limit === 0)
                {
                    return 0;
                }
                return compareUnitsAt(host.readMemory, left, right, 2, limit,
                    unit=>folded(LOWER, unit));
            },
        },

        /** wchar_t *_wcslwr(wchar_t *text) -- ASCII lowered in place, as the C locale has it */
        _wcslwr: foldInPlace(LOWER),

        /** wchar_t *_wcsupr(wchar_t *text) -- ASCII raised in place */
        _wcsupr: foldInPlace(UPPER),

        /** wchar_t *_wcsrev(wchar_t *text) -- the units reversed in place, as `_strrev` reverses bytes */
        _wcsrev: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>{
                writeWide(string, readWide(string).split('').reverse().join(''), false);
                return string;
            },
        },

        /**
         * wchar_t *wcstok(wchar_t *text, const wchar_t *delimiters)
         *
         * strtok over units: a terminator written over the delimiter that
         * ends each token, and null for the text carries on from there.
         */
        wcstok: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, delimiters])=>{
                if ((string >>> 0) !== 0)
                {
                    wideTokenAt = string >>> 0;
                }
                if (wideTokenAt === 0)
                {
                    return 0;
                }
                const separators = new Set(readWide(delimiters));
                const rest = readWide(wideTokenAt);
                let start = 0;
                while (start < rest.length && separators.has(rest[start]))
                {
                    start++;
                }
                if (start === rest.length)
                {
                    wideTokenAt = 0;
                    return 0;
                }
                let end = start;
                while (end < rest.length && !separators.has(rest[end]))
                {
                    end++;
                }
                const token = wideTokenAt + start * 2;
                if (end < rest.length)
                {
                    host.writeMemory(wideTokenAt + end * 2, new Uint8Array(2));
                    wideTokenAt += (end + 1) * 2;
                }
                else
                {
                    wideTokenAt = 0;
                }
                return token;
            },
        },

        /** size_t wcsspn(const wchar_t *text, const wchar_t *accept) */
        wcsspn: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, accept])=>spanOf(string, accept, false).at,
        },

        /** size_t wcscspn(const wchar_t *text, const wchar_t *reject) */
        wcscspn: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, reject])=>spanOf(string, reject, true).at,
        },

        /**
         * wchar_t *wcspbrk(const wchar_t *text, const wchar_t *accept)
         *
         * A pointer into the caller's string at the first unit the set has,
         * or null; the terminator is never one of the set.
         */
        wcspbrk: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, accept])=>{
                const { at, found } = spanOf(string, accept, true);
                return found ? string + at * 2 : 0;
            },
        },

        /** wchar_t *wcsstr(const wchar_t *, const wchar_t *) */
        wcsstr: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([haystack, needle])=>{
                const index = readWide(haystack).indexOf(readWide(needle));
                return index === -1 ? 0 : haystack + index * 2;
            },
        },

        /**
         * size_t mbstowcs(wchar_t *dest, const char *src, size_t count)
         *
         * A null destination means "how many units would this need", which is
         * how a caller sizes the buffer before the call that fills it; no
         * source is -1 and EINVAL.
         */
        mbstowcs: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                if ((source >>> 0) === 0)
                {
                    host.errno?.(EINVAL);
                    return -1;
                }
                const text = readNarrowUnits(source);
                if ((destination >>> 0) === 0)
                {
                    return text.length;
                }
                const written = text.slice(0, count >>> 0);
                // The terminator is written only when it fits within the count,
                // which is the trap in this function: a full buffer comes back
                // unterminated and the caller must terminate it itself.
                writeWide(destination, written, written.length < (count >>> 0));
                return written.length;
            },
        },

        /**
         * size_t wcstombs(char *dest, const wchar_t *src, size_t count)
         *
         * A byte for each character it converts -- all of them with no
         * destination, which asks how many bytes that is -- and -1 with
         * EILSEQ, nothing written, when one of those has no byte in the C
         * locale, as wctomb refuses it.
         */
        wcstombs: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                const text = readWide(source);
                const converted = (destination >>> 0) === 0 ? text : text.slice(0, count >>> 0);
                if (/[^\0-\xff]/.test(converted))
                {
                    host.errno?.(EILSEQ);
                    return -1;
                }
                if ((destination >>> 0) === 0)
                {
                    return text.length;
                }
                // Terminated, as mbstowcs is, only when the text ends within
                // the count: a buffer the text fills is left unterminated.
                writeNarrow(destination, converted, converted.length < (count >>> 0));
                return converted.length;
            },
        },

        /**
         * int wctomb(char *dest, wchar_t unit)
         *
         * One byte for a character to U+00FF; the C locale has none for a
         * character past it, which is -1 and EILSEQ with nothing written.
         */
        wctomb: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, unit])=>{
                if ((destination >>> 0) === 0)
                {
                    // Asking whether the encoding is stateful. It is not.
                    return 0;
                }
                if ((unit & 0xffff) > 0xff)
                {
                    host.errno?.(EILSEQ);
                    return -1;
                }
                host.writeMemory(destination, new Uint8Array([unit & 0xff]));
                return 1;
            },
        },

        /**
         * size_t mbrtowc(wchar_t *dest, const char *src, size_t count, mbstate_t *state)
         *
         * mbtowc with a state, which the C locale never needs, a byte being a
         * character: 1 for a character, 0 for the terminator, (size_t)-2 when
         * the count holds no byte at all. No string is the call that resets
         * the state, and answers 0.
         */
        mbrtowc: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                if ((source >>> 0) === 0)
                {
                    return 0;
                }
                if ((count >>> 0) === 0)
                {
                    return -2;
                }
                const byte = host.readMemory(source, 1)[0];
                if ((destination >>> 0) !== 0)
                {
                    writeWide(destination, String.fromCharCode(byte), false);
                }
                return byte === 0 ? 0 : 1;
            },
        },

        /** size_t mbrlen(const char *src, size_t count, mbstate_t *state) */
        mbrlen: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, count])=>{
                if ((source >>> 0) === 0)
                {
                    return 0;
                }
                if ((count >>> 0) === 0)
                {
                    return -2;
                }
                return host.readMemory(source, 1)[0] === 0 ? 0 : 1;
            },
        },

        /**
         * size_t wcrtomb(char *dest, wchar_t unit, mbstate_t *state)
         *
         * wctomb with a state: one byte for a character to U+00FF, (size_t)-1
         * and EILSEQ for one past it. No destination is the reset, which is
         * the terminator's one byte.
         */
        wcrtomb: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, unit])=>{
                if ((destination >>> 0) === 0)
                {
                    return 1;
                }
                if ((unit & 0xffff) > 0xff)
                {
                    host.errno?.(EILSEQ);
                    return -1;
                }
                host.writeMemory(destination, new Uint8Array([unit & 0xff]));
                return 1;
            },
        },

        /**
         * size_t mbsrtowcs(wchar_t *dest, const char **src, size_t count, mbstate_t *state)
         *
         * mbstowcs through the caller's pointer, which it moves: past the last
         * character converted when the count ran out, to null when the
         * terminator was reached -- and converted, into a destination there.
         * No destination counts the whole string and moves nothing.
         */
        mbsrtowcs: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, from, count])=>{
                const source = width.get(new DataView(host.readMemory(from >>> 0, width.size)
                    .slice().buffer), 0);
                const text = readNarrowUnits(source);
                if ((destination >>> 0) === 0)
                {
                    return text.length;
                }
                const room = count >>> 0;
                const converted = text.slice(0, room);
                const ended = converted.length < room;
                writeWide(destination, converted, ended);
                host.writeMemory(from >>> 0, width.bytes(ended ? 0 : source + converted.length));
                return converted.length;
            },
        },

        /**
         * size_t wcsrtombs(char *dest, const wchar_t **src, size_t count, mbstate_t *state)
         *
         * wcstombs through the caller's pointer, moved as mbsrtowcs moves it;
         * a character with no byte is (size_t)-1 and EILSEQ, the pointer left
         * at it.
         */
        wcsrtombs: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([destination, from, count])=>{
                const source = width.get(new DataView(host.readMemory(from >>> 0, width.size)
                    .slice().buffer), 0);
                const text = readWide(source);
                const room = (destination >>> 0) === 0 ? text.length + 1 : count >>> 0;
                const converted = text.slice(0, room);
                const refused = converted.search(/[^\0-\xff]/);
                if (refused >= 0)
                {
                    if ((destination >>> 0) !== 0)
                    {
                        writeNarrow(destination, converted.slice(0, refused), false);
                        host.writeMemory(from >>> 0, width.bytes(source + refused * 2));
                    }
                    host.errno?.(EILSEQ);
                    return -1;
                }
                if ((destination >>> 0) === 0)
                {
                    return text.length;
                }
                const ended = converted.length < room;
                writeNarrow(destination, converted, ended);
                host.writeMemory(from >>> 0,
                    width.bytes(ended ? 0 : source + converted.length * 2));
                return converted.length;
            },
        },

        /** int mbtowc(wchar_t *dest, const char *src, size_t count) */
        mbtowc: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                if ((source >>> 0) === 0 || (count >>> 0) === 0)
                {
                    return 0;
                }
                const byte = host.readMemory(source, 1)[0];
                if ((destination >>> 0) !== 0)
                {
                    writeWide(destination, String.fromCharCode(byte), false);
                }
                return byte === 0 ? 0 : 1;
            },
        },
    };

    return {
        ...wide,
        // The collating forms: under the C locale the order is the units'
        // own, and each is its comparison.
        wcscoll: wide.wcscmp,
        _wcsicoll: wide._wcsicmp,
        _wcsncoll: wide.wcsncmp,
        _wcsnicoll: wide._wcsnicmp,
    };
}

/**
 * The wide classifiers, from the same classes as the byte ones so the two
 * cannot drift: a program may ask either family about the same character and
 * is entitled to the same answer for every code unit below 0x80 -- but for
 * the tab, which msvcrt's wide table calls blank and so printable. Above it
 * the C locale is not empty (`WIDE_CLASSES` in `inguest.js` says how), and
 * the classifiers and the case functions run in the guest.
 */
export function createWideClassificationFunctions(){
    /** @param {string} name @param {import('./guest-code.js').HostFallback} [fallback] */
    const inGuestEntry = (name, fallback)=>guestEntry(
        /** @type {Function} */ (inGuest[/** @type {'iswalpha'} */ (name)]),
        COMPILED[/** @type {'iswalpha'} */ (name)], {}, fallback);

    return {
        /**
         * int iswalpha/iswdigit/... (wint_t) -- the classifiers, under the C
         * locale: msvcrt's bits of the class asked for, in the guest below
         * 0x100 and on the host past it.
         */
        ...Object.fromEntries(Object.entries(WIDE_MASKS).map(([name, mask])=>[name,
            inGuestEntry(name, { argBytes: 4,
                handler: ([code])=>wideClassOf(code & 0xffff) & mask })])),
        ...Object.fromEntries(['iswascii', 'towupper', 'towlower']
            .map(name=>[name, inGuestEntry(name)])),

        /**
         * int iswctype(wint_t c, wctype_t type)
         *
         * The bits of `type` that `c` has: what each classifier above asks
         * with its own mask.
         */
        iswctype: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([code, type])=>wideClassOf(code & 0xffff) & type & 0xffff,
        },
    };
}

/**
 * @typedef {Object} MultiByteFunctionsHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, value: number, length: number) => void} [fillMemory]
 * @property {(code: number) => void} [errno]
 * @property {(name: string) => number} [addressOf]
 *     Where the runtime's own export of that name was placed, zero before it
 *     is: `_mbctype` is rewritten there when the page changes. Absent, the
 *     table a program reads stays the one it was placed with.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {import('./mbcs.js').MultiBytePage} [page]
 *     The code page, where the rest of the runtime reads by it too.
 */

/**
 * The multi-byte family, under the code page `_setmbcp` selects (`mbcs.js`).
 *
 * A name whose answer is its byte twin's under every page -- a copy, a
 * concatenation, a duplicate -- is bound to the narrow function itself, taken
 * from the table the caller already built: two implementations of `strcpy`
 * that must agree is one more than is needed. The rest read a string by the
 * page: in the guest while it is ASCII, on the host past that.
 *
 * @param {Record<string, any>} narrow  The byte-string table.
 * @param {MultiByteFunctionsHost} host
 */
export function createMultiByteFunctions(narrow, host){
    const page = host.page ?? createMultiBytePage();
    const handlers = createMultiByteHandlers(host, page);

    /** @type {Record<string, any>} */
    const table = {};
    for (const [multiByte, byte] of Object.entries({
        _mbscpy: 'strcpy',
        _mbscat: 'strcat',
        _mbsdup: '_strdup',
        // Under the C locale a collation is the bytes' order.
        _stricoll: '_stricmp',
        _strncoll: 'strncmp',
        _strnicoll: '_strnicmp',
        // A classifier, not a string function: one character code in, one
        // flag out, and a space or a digit is a byte in every page.
        _ismbcspace: 'isspace',
        _ismbcdigit: 'isdigit',
    }))
    {
        if (narrow[byte])
        {
            table[multiByte] = narrow[byte];
        }
    }

    /**
     * Code in the guest that hands a string past ASCII to the handler of the
     * export it is bound as.
     *
     * @param {string} name  The export.
     * @param {string} [source]  The guest function, when another export's.
     */
    const guestCoded = (name, source = name)=>{
        const handler = /** @type {Record<string, (args: number[]) => number>} */ (
            handlers)[name];
        const compiled = COMPILED[/** @type {'_mbslen'} */ (source)];
        return guestEntry(/** @type {Function} */ (inGuest[/** @type {'_mbslen'} */ (source)]),
            compiled, host, { argBytes: compiled.params.length * 4, handler });
    };

    /**
     * A handler that reads by the page under a double-byte one, and answers
     * as its byte twin under a single-byte one, where the twin is already
     * the faster walk.
     *
     * @param {string} name @param {string} byte
     */
    const byPage = (name, byte)=>{
        const twin = narrow[byte];
        const handler = /** @type {Record<string, (args: number[]) => number>} */ (
            handlers)[name];
        return {
            convention: 'cdecl',
            argBytes: twin?.argBytes ?? 8,
            /** @param {number[]} args */
            handler: args=>(page.doubleByte() || !twin ? handler(args) : twin.handler(args)),
        };
    };

    /** @param {string} name @param {number} argBytes */
    const onHost = (name, argBytes)=>({
        convention: 'cdecl',
        argBytes,
        handler: /** @type {Record<string, (args: number[]) => number>} */ (handlers)[name],
    });

    /**
     * A function of one character code that holds under page 932 alone:
     * elsewhere it answers `otherwise`, or the code itself.
     *
     * @param {(code: number) => number} convert @param {number} [otherwise]
     */
    const underShiftJis = (convert, otherwise)=>({
        convention: 'cdecl',
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([code])=>(page.page() === SHIFT_JIS ? convert(code >>> 0)
            : otherwise ?? code >>> 0),
    });

    /** Rewrites the table a program reads, where the runtime's export of it was placed. */
    const publishTable = ()=>{
        const at = host.addressOf?.('_mbctype') ?? 0;
        if (at !== 0)
        {
            host.writeMemory(at, page.table());
        }
    };

    return {
        ...table,
        ...Object.fromEntries(['_mbslen', '_mbclen', '_mbsinc', '_mbsdec', '_ismbblead',
            '_mbschr', '_mbsrchr', '_mbsstr', '_mbscmp', '_mbsicmp', '_mbsncmp', '_mbsnicmp',
            '_mbsncpy', '_mbslwr', '_mbsupr'].map(name=>[name, guestCoded(name)])),
        // The byte-counted forms: in ASCII a byte is a character, and the
        // guest code is the character-counted form's.
        _mbsnbcmp: guestCoded('_mbsnbcmp', '_mbsncmp'),
        _mbsnbicmp: guestCoded('_mbsnbicmp', '_mbsnicmp'),
        _mbsnbcpy: guestCoded('_mbsnbcpy', '_mbsncpy'),

        _mbspbrk: byPage('_mbspbrk', 'strpbrk'),
        _mbsspn: byPage('_mbsspn', 'strspn'),
        _mbscspn: byPage('_mbscspn', 'strcspn'),
        _mbsncat: byPage('_mbsncat', 'strncat'),
        _mbsnbcat: byPage('_mbsnbcat', 'strncat'),
        _mbsrev: byPage('_mbsrev', '_strrev'),

        _mbsspnp: onHost('_mbsspnp', 8),
        _mbstok: onHost('_mbstok', 8),
        _mbsninc: onHost('_mbsninc', 8),
        _mbsnextc: onHost('_mbsnextc', 4),
        _mbccpy: onHost('_mbccpy', 8),
        _ismbbtrail: onHost('_ismbbtrail', 4),
        _ismbslead: onHost('_ismbslead', 8),
        _ismbstrail: onHost('_ismbstrail', 8),
        _mbbtype: onHost('_mbbtype', 8),
        _mbsbtype: onHost('_mbsbtype', 8),
        _ismbclegal: onHost('_ismbclegal', 4),
        _mbsnlen: onHost('_mbsnlen', 8),
        _mbccpy_s: onHost('_mbccpy_s', 16),
        _mbscpy_s: onHost('_mbscpy_s', 12),
        _mbscat_s: onHost('_mbscat_s', 12),
        _mbsnbcpy_s: onHost('_mbsnbcpy_s', 16),
        _mbsnbcat_s: onHost('_mbsnbcat_s', 16),
        _mbsupr_s: onHost('_mbsupr_s', 8),
        _mbslwr_s: onHost('_mbslwr_s', 8),
        // The `_l` forms take a locale, and the C locale is the only one a
        // program can hold here: each is its plain form.
        _mbsnextc_l: onHost('_mbsnextc', 8),
        _mbscmp_l: { ...guestCoded('_mbscmp'), argBytes: 12 },

        // The Japanese conversions and tests (kana.js): under any page but
        // 932 a conversion is its argument and a test is false.
        _mbcjistojms: underShiftJis(jisToShiftJis),
        _mbcjmstojis: underShiftJis(shiftJisToJis),
        _mbctohira: underShiftJis(toHiragana),
        _mbctokata: underShiftJis(toKatakana),
        _mbbtombc: underShiftJis(toFullWidth),
        _mbctombb: underShiftJis(toHalfWidth),
        _ismbckata: underShiftJis(c=>(isKatakana(c) ? 1 : 0), 0),
        _ismbchira: underShiftJis(c=>(c >= 0x829f && c <= 0x82f1 ? 1 : 0), 0),
        _ismbcl0: underShiftJis(c=>(jisLevel(c) === 0 ? 1 : 0), 0),
        _ismbcl1: underShiftJis(c=>(jisLevel(c) === 1 ? 1 : 0), 0),
        _ismbcl2: underShiftJis(c=>(jisLevel(c) === 2 ? 1 : 0), 0),

        /**
         * int mblen(const char *text, size_t count) / size_t _mbstrlen(const char *text)
         *
         * By the locale rather than the multibyte code page, and the C locale
         * is a byte a character: one byte for a character, none for the
         * terminator or no string, -1 when the count holds nothing.
         */
        mblen: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, count])=>{
                if ((text >>> 0) === 0)
                {
                    return 0;
                }
                if ((count >>> 0) === 0)
                {
                    return -1;
                }
                return host.readMemory(text >>> 0, 1)[0] === 0 ? 0 : 1;
            },
        },
        ...narrow.strlen ? { _mbstrlen: narrow.strlen } : {},

        /**
         * int _setmbcp(int codepage)
         *
         * Zero once the page is selected -- by number, or as `_MB_CP_ANSI`,
         * `_MB_CP_OEM`, `_MB_CP_LOCALE` (the C locale's is the ANSI page) or
         * `_MB_CP_SBCS`; a page Windows does not have is -1 and EINVAL, and
         * the page before it stays. `__mb_cur_max` is the locale's and does
         * not move.
         */
        _setmbcp: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([codepage])=>{
                if (!page.select(codepage))
                {
                    host.errno?.(EINVAL);
                    return -1;
                }
                publishTable();
                return 0;
            },
        },

        /** int _getmbcp(void): 0 for the single-byte page a program starts in. */
        _getmbcp: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>page.page(),
        },

        /**
         * unsigned char _mbctype[257]
         *
         * The flags of each byte under the page, the first entry for EOF: the
         * ASCII letters' case in every page, and a double-byte page's lead and
         * trail bytes besides.
         */
        _mbctype: { data: ()=>page.table().slice() },
    };
}
