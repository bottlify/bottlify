/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The conversions between bytes and wide characters that carry a state --
 * `mbrtowc`, `wcrtomb`, `mbsrtowcs`, `wcsrtombs` and their kin -- and the
 * secure `mbstowcs_s` and `wcstombs_s`, under the C locale, the one this
 * runtime carries: a byte is the character of its own value, U+0000 to
 * U+00FF, and a character past that has no byte (EILSEQ). No character takes
 * more than one byte, so a conversion state is never left part-way, and each
 * function that is handed one leaves it zero.
 */

import { EILSEQ, EINVAL, ERANGE } from './globals.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { wholeAddress } from '../common/pointers.js';
import { WHOLE } from '../common/guest.js';

const MAX_STRING = 1 << 20;

/** `_TRUNCATE`, and what a secure conversion answers when it used it. */
const TRUNCATE = 0xffffffff;
const STRUNCATE = 80;

const EOF = -1;
const WEOF = 0xffff;

/** What a conversion answers for a character it cannot make, and for one not yet whole. */
const FAILED = 0xffffffff;
const INCOMPLETE = 0xfffffffe;

/**
 * @typedef {Object} RestartableHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {(code: number) => void} [errno]
 */

/**
 * @param {RestartableHost} host
 */
export function createRestartableFunctions(host){
    /**
     * @param {number} argBytes
     * @param {(args: number[]) => number} handler
     */
    const cdecl = (argBytes, handler)=>({ convention: 'cdecl', argBytes, handler });

    const { guest } = host;

    /**
     * A count answered through a `size_t *`: a pointer wide, written whole,
     * (size_t)-1 every bit of it at either width; nothing for a null one.
     *
     * @param {number} at @param {number} value
     */
    const setCount = (at, value)=>{
        if (wholeAddress(at) === 0)
        {
            return;
        }
        if (value === FAILED)
        {
            guest.fill(at, 0xff, guest.pointerSize);
        }
        else
        {
            guest.setPtr(at, value);
        }
    };

    /** A narrow string's bytes, each a character of its own value. @param {number} at */
    const narrowUnits = at=>Array.from(encodeAnsi(guest.cstr(at, MAX_STRING)));

    /** A wide string's units. @param {number} at */
    const wideUnits = at=>Array.from(guest.wstr(at, WHOLE), unit=>unit.charCodeAt(0));

    /** @param {number} at @param {number[]} units */
    const writeUnits = (at, units)=>{
        const bytes = new Uint8Array(units.length * 2);
        const view = new DataView(bytes.buffer);
        units.forEach((unit, index)=>view.setUint16(index * 2, unit, true));
        guest.setBytes(at, bytes);
    };

    /** @param {number} code */
    const fail = code=>{
        host.errno?.(code);
        return code;
    };

    /** The state a conversion was handed, left zero: no character is ever part-way. */
    const clear = (/** @type {number} */ state)=>{
        if (wholeAddress(state) !== 0)
        {
            guest.set32(state, 0);
        }
    };

    /**
     * mbstowcs_s's and wcstombs_s's shared body: the units converted, the
     * terminator counted in `*converted`.
     *
     * @param {number} converted @param {number} destination @param {number} size
     * @param {number[]} units  The source up to its terminator.
     * @param {number} count @param {(at: number, units: number[]) => void} write
     * @param {boolean} narrowing  Whether a unit past a byte has no conversion.
     */
    const secure = (converted, destination, size, units, count, write, narrowing)=>{
        const truncate = (count >>> 0) === TRUNCATE;
        const wanted = truncate ? units : units.slice(0, count >>> 0);
        if ((destination >>> 0) === 0)
        {
            if ((size >>> 0) !== 0)
            {
                setCount(converted, 0);
                return fail(EINVAL);
            }
            setCount(converted, wanted.length + 1);
            return 0;
        }
        if ((size >>> 0) === 0)
        {
            setCount(converted, 0);
            return fail(EINVAL);
        }
        if (narrowing && wanted.some(unit=>unit > 0xff))
        {
            write(destination, [0]);
            setCount(converted, 0);
            return fail(EILSEQ);
        }
        if (wanted.length + 1 > (size >>> 0))
        {
            if (!truncate)
            {
                write(destination, [0]);
                setCount(converted, 0);
                return fail(ERANGE);
            }
            write(destination, [...wanted.slice(0, (size >>> 0) - 1), 0]);
            setCount(converted, size >>> 0);
            return STRUNCATE;
        }
        write(destination, [...wanted, 0]);
        setCount(converted, wanted.length + 1);
        return 0;
    };

    /**
     * mbsrtowcs's and wcsrtombs's shared body: up to `count` units written
     * and the terminator when it is among them, `*src` moved past them -- to
     * null once the terminator was converted -- and their count. No
     * destination counts the units and moves nothing.
     *
     * @param {number} destination @param {number} source  Where the source pointer is.
     * @param {number} count @param {number[]} units  The source up to its terminator.
     * @param {number} unitBytes  A source unit's size.
     * @param {(at: number, units: number[]) => void} write
     */
    const restartable = (destination, source, count, units, unitBytes, write)=>{
        if ((destination >>> 0) === 0)
        {
            return units.length;
        }
        const kept = units.slice(0, count >>> 0);
        const whole = units.length < (count >>> 0);
        write(destination, whole ? [...kept, 0] : kept);
        guest.setPtr(source, whole ? 0 : guest.ptr(source) + kept.length * unitBytes);
        return kept.length;
    };

    return {
        /** wint_t btowc(int c): the byte's character, its low eight bits; WEOF for EOF. */
        btowc: cdecl(4, ([c])=>((c | 0) === EOF ? WEOF : c & 0xff)),

        /** int wctob(wint_t c): the character's byte, sign-extended; EOF past U+00FF. */
        wctob: cdecl(4, ([c])=>((c & 0xffff) > 0xff ? EOF : (c << 24 >> 24))),

        /**
         * size_t mbrlen(const char *s, size_t count, mbstate_t *state): 0 for
         * the terminator or no string, -2 when the count holds nothing, else 1.
         */
        mbrlen: { ...cdecl(12, ([string, count, state])=>{
            clear(state);
            if ((string >>> 0) === 0)
            {
                return 0;
            }
            if ((count >>> 0) === 0)
            {
                return INCOMPLETE;
            }
            return guest.u8(string) === 0 ? 0 : 1;
        }) },

        /**
         * size_t mbrtowc(wchar_t *dest, const char *s, size_t count, mbstate_t *state)
         *
         * mbrlen's answers, the character written where asked.
         */
        mbrtowc: { ...cdecl(16, ([destination, string, count, state])=>{
            clear(state);
            if ((string >>> 0) === 0)
            {
                return 0;
            }
            if ((count >>> 0) === 0)
            {
                return INCOMPLETE;
            }
            const byte = guest.u8(string);
            if ((destination >>> 0) !== 0)
            {
                writeUnits(destination, [byte]);
            }
            return byte === 0 ? 0 : 1;
        }) },

        /**
         * size_t wcrtomb(char *dest, wchar_t c, mbstate_t *state): the byte
         * and 1; -1 and EILSEQ for a character past U+00FF; no destination
         * asks the length of a reset, 1.
         */
        wcrtomb: { ...cdecl(12, ([destination, c, state])=>{
            clear(state);
            if ((destination >>> 0) === 0)
            {
                return 1;
            }
            if ((c & 0xffff) > 0xff)
            {
                host.errno?.(EILSEQ);
                return FAILED;
            }
            guest.set8(destination, c & 0xff);
            return 1;
        }) },

        /**
         * errno_t wcrtomb_s(size_t *length, char *dest, size_t size, wchar_t c,
         *                   mbstate_t *state)
         */
        wcrtomb_s: cdecl(20, ([length, destination, size, c, state])=>{
            clear(state);
            if ((c & 0xffff) > 0xff)
            {
                setCount(length, FAILED);
                return fail(EILSEQ);
            }
            if ((destination >>> 0) !== 0)
            {
                if ((size >>> 0) === 0)
                {
                    setCount(length, FAILED);
                    return fail(EINVAL);
                }
                guest.set8(destination, c & 0xff);
            }
            setCount(length, 1);
            return 0;
        }),

        /**
         * size_t mbsrtowcs(wchar_t *dest, const char **src, size_t count, mbstate_t *state)
         *
         * mbstowcs from where `*src` points, moving it past what was
         * converted, or to null once the terminator was; no destination
         * counts and moves nothing. No source is -1 and EINVAL.
         */
        mbsrtowcs: { ...cdecl(16, ([destination, source, count, state])=>{
            clear(state);
            if ((source >>> 0) === 0)
            {
                host.errno?.(EINVAL);
                return FAILED;
            }
            return restartable(destination, source, count, narrowUnits(guest.ptr(source)), 1,
                writeUnits);
        }) },

        /**
         * size_t wcsrtombs(char *dest, const wchar_t **src, size_t count, mbstate_t *state)
         *
         * wcstombs from where `*src` points, as mbsrtowcs moves it; -1 and
         * EILSEQ at a character past U+00FF.
         */
        wcsrtombs: { ...cdecl(16, ([destination, source, count, state])=>{
            clear(state);
            if ((source >>> 0) === 0)
            {
                host.errno?.(EINVAL);
                return FAILED;
            }
            const units = wideUnits(guest.ptr(source));
            const limit = (destination >>> 0) === 0 ? units.length : count >>> 0;
            if (units.slice(0, limit).some(unit=>unit > 0xff))
            {
                host.errno?.(EILSEQ);
                return FAILED;
            }
            return restartable(destination, source, count, units, 2,
                (at, bytes)=>guest.setBytes(at, Uint8Array.from(bytes)));
        }) },

        /**
         * errno_t mbsrtowcs_s(size_t *converted, wchar_t *dest, size_t size,
         *                     const char **src, size_t count, mbstate_t *state)
         *
         * mbsrtowcs into a buffer of `size`, the terminator counted: what
         * does not fit is cut short, terminated, and the source moved past
         * what was taken.
         */
        mbsrtowcs_s: cdecl(24, ([converted, destination, size, source, count, state])=>{
            clear(state);
            const room = size >>> 0;
            if ((source >>> 0) === 0 || ((destination >>> 0) === 0 && room !== 0)
                || ((destination >>> 0) !== 0 && room === 0))
            {
                setCount(converted, FAILED);
                return fail(EINVAL);
            }
            const start = guest.ptr(source);
            const units = narrowUnits(start).slice(0, count >>> 0);
            if ((destination >>> 0) === 0)
            {
                setCount(converted, units.length + 1);
                return 0;
            }
            if (units.length + 1 > room)
            {
                const kept = units.slice(0, room - 1);
                writeUnits(destination, [...kept, 0]);
                guest.setPtr(source, start + kept.length);
                setCount(converted, room);
                return 0;
            }
            writeUnits(destination, [...units, 0]);
            guest.setPtr(source, 0);
            setCount(converted, units.length + 1);
            return 0;
        }),

        /**
         * errno_t mbstowcs_s(size_t *converted, wchar_t *dest, size_t size,
         *                    const char *src, size_t count)
         *
         * The units and a terminator, both counted: no destination counts;
         * what does not fit is ERANGE and an empty buffer, or under _TRUNCATE
         * as much as fits and STRUNCATE. No source is EINVAL.
         */
        mbstowcs_s: cdecl(20, ([converted, destination, size, source, count])=>{
            if ((source >>> 0) === 0)
            {
                setCount(converted, 0);
                return fail(EINVAL);
            }
            return secure(converted, destination, size, narrowUnits(source), count,
                writeUnits, false);
        }),

        /**
         * errno_t wcstombs_s(size_t *converted, char *dest, size_t size,
         *                    const wchar_t *src, size_t count), and
         * _wcstombs_s_l, whose locale is the C one: mbstowcs_s's answers, and
         * EILSEQ with an empty buffer for a character past U+00FF.
         */
        wcstombs_s: cdecl(20, ([converted, destination, size, source, count])=>
            wideSecure(converted, destination, size, source, count)),
        _wcstombs_s_l: cdecl(24, ([converted, destination, size, source, count])=>
            wideSecure(converted, destination, size, source, count)),
    };

    /**
     * @param {number} converted @param {number} destination @param {number} size
     * @param {number} source @param {number} count
     */
    function wideSecure(converted, destination, size, source, count){
        if ((source >>> 0) === 0)
        {
            setCount(converted, 0);
            return fail(EINVAL);
        }
        return secure(converted, destination, size, wideUnits(source), count,
            (at, bytes)=>guest.setBytes(at, Uint8Array.from(bytes)), true);
    }
}
