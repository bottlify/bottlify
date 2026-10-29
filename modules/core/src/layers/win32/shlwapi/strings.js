/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi's string functions: searches, comparisons, copies and the STRRET a
 * shell folder answers a name in, each written once over a spelling.
 *
 * A comparison is kernel32's CompareString, called with the caller's own
 * pointers, so a list sorted here sorts as every other comparison in the
 * process does; a build without kernel32 behind it compares code units.
 * The answers to a comparison are CompareString's less one, -1, 0 or 1.
 */

import { u32 } from './text.js';
import { formatToString } from '../msvcrt/format.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_FAIL = 0x80004005;

/** CompareString's flag, and the locale shlwapi compares in. */
const NORM_IGNORECASE = 0x1;
const LOCALE_USER_DEFAULT = 0x400;
const CSTR_EQUAL = 2;

/** STRRET's kinds, its union after the type word, and its in-place text. */
const STRRET_WSTR = 0;
const STRRET_OFFSET = 1;
const STRRET_CSTR = 2;
const STRRET_UNION = 4;
const STRRET_CSTR_LENGTH = 260;

/**
 * @typedef {Object} StringHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(bytes: number) => number} [allocate]
 *           The process heap, which LocalFree releases a StrDup copy to.
 * @property {(address: number) => void} [free]
 *           And CoTaskMemFree a STRRET's string, the task allocator being the
 *           same heap.
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     [library]  kernel32, whose CompareString the comparisons are.
 */

/**
 * The character a WORD argument names in this spelling, or null for one that
 * can be no single character of it: a double-byte character in a page that
 * has none, or the terminator, which a search never finds.
 *
 * @param {import('./text.js').Width} width @param {number} code
 * @returns {string | null}
 */
const searched = (width, code)=>{
    const value = code & 0xffff;
    if (value === 0 || (!width.wide && value > 0xff))
    {
        return null;
    }
    return width.char(value);
};

/**
 * Text with case ignored, folded a character at a time so that a place in the
 * folded text is the same place in the caller's: a character whose capital is
 * two (the German sharp s) stays as it is.
 *
 * @param {string} value
 */
const foldCase = value=>
    Array.from(value, c=>(c.toUpperCase().length === 1 ? c.toUpperCase() : c)).join('');

/**
 * StrFromTimeInterval's text: the interval rounded to the second, then hours,
 * minutes and seconds, each cut to the significant digits still left -- the
 * leading unit is never zero, the ones after it appear while digits remain,
 * and a unit's digits beyond the budget read as zeros (Wine's
 * test_StrFromTimeIntervalA: 1 000 000 ms is " 10 min" to one digit,
 * " 16 min 40 sec" to three).
 *
 * @param {number} milliseconds @param {number} digits
 */
export function timeInterval(milliseconds, digits){
    const seconds = Math.floor(((milliseconds >>> 0) + 500) / 1000);
    const units = /** @type {const} */ ([
        [Math.floor(seconds / 3600), 'hr'], [Math.floor(seconds / 60) % 60, 'min'],
        [seconds % 60, 'sec'],
    ]);
    let left = Math.max(1, digits | 0);
    let text = '';
    for (const [value, unit] of units)
    {
        if (left <= 0 || (text === '' && value === 0 && unit !== 'sec'))
        {
            continue;
        }
        const length = String(value).length;
        const scale = length > left ? 10 ** (length - left) : 1;
        left -= length;
        text += ` ${Math.floor(value / scale) * scale} ${unit}`;
    }
    return text;
}

/** The units a size is shown in past its bytes, each 1024 of the one before. */
const SIZE_UNITS = Object.freeze(['KB', 'MB', 'GB', 'TB', 'PB', 'EB']);

/**
 * A number with its thousands grouped, as the user's locale -- en-US's
 * comma -- groups them.
 *
 * @param {bigint} value
 */
const grouped = value=>value.toString().replace(/\B(?=(\d{3})+$)/g, ',');

/**
 * StrFormatByteSize's text: bytes below 1024, else the first unit the size
 * is under 1000 of, with three significant digits -- truncated, or rounded
 * to the nearest when asked (Wine's test_StrFormatByteSize64A and
 * test_StrFormatByteSizeEx).
 *
 * @param {bigint} size @param {boolean} [nearest]
 */
export function byteSize(size, nearest = false){
    if (size < 1024n)
    {
        return `${size} bytes`;
    }
    let unit = 0;
    let scale = 1024n;
    while (unit < SIZE_UNITS.length - 1 && size >= 1000n * scale)
    {
        unit++;
        scale *= 1024n;
    }
    const decimals = size * 10n < 100n * scale ? 2 : size < 100n * scale ? 1 : 0;
    const factor = 10n ** BigInt(decimals);
    const shown = nearest ? (size * factor * 2n + scale) / (scale * 2n) : size * factor / scale;
    const whole = shown / factor;
    const part = (shown % factor).toString().padStart(decimals, '0');
    return `${whole}${decimals > 0 ? `.${part}` : ''} ${SIZE_UNITS[unit]}`;
}

/**
 * StrFormatKBSize's text: the kilobytes the size takes, a part one counting
 * whole, grouped; none for a size that is not above zero.
 *
 * @param {bigint} size
 */
export const kbSize = size=>`${grouped(size <= 0n ? 0n : (size + 1023n) / 1024n)} KB`;

/** @param {number} low @param {number} high  A 64-bit argument's two words, signed. */
const int64 = (low, high)=>BigInt.asIntN(64, BigInt(high >>> 0) << 32n | BigInt(low >>> 0));

/**
 * @param {StringHost} host
 * @param {{ A: import('./text.js').Width, W: import('./text.js').Width }} widths
 */
export function createStringFunctions(host, { A, W }){
    /** @param {string} name @param {number} argBytes
     *  @param {(width: import('./text.js').Width, args: number[]) => number} body */
    const both = (name, argBytes, body)=>({
        [`${name}A`]: { argBytes, handler: (/** @type {number[]} */ args)=>body(A, args) },
        [`${name}W`]: { argBytes, handler: (/** @type {number[]} */ args)=>body(W, args) },
    });
    /** @param {import('./text.js').Width} width @param {number} argBytes
     *  @param {(width: import('./text.js').Width, args: number[]) => number} body */
    const one = (width, argBytes, body)=>({
        argBytes, handler: (/** @type {number[]} */ args)=>body(width, args),
    });

    /**
     * Two strings compared, at most `limit` characters of each when a
     * limit is given.
     *
     * @param {import('./text.js').Width} width @param {number} first @param {number} second
     * @param {number} flags @param {number | null} limit
     */
    const compare = (width, first, second, flags, limit)=>{
        const a = width.read(first);
        const b = width.read(second);
        if (a === null || b === null)
        {
            return a === b ? 0 : a === null ? -1 : 1;
        }
        const left = limit === null ? a.length : Math.max(0, Math.min(a.length, limit));
        const right = limit === null ? b.length : Math.max(0, Math.min(b.length, limit));
        const kernel32 = host.library?.('KERNEL32.dll')?.[`CompareString${width.wide ? 'W' : 'A'}`];
        const answer = kernel32 ? /** @type {number} */ (kernel32.handler([LOCALE_USER_DEFAULT,
            flags, first, left, second, right])) | 0 : 0;
        if (answer !== 0)
        {
            return answer - CSTR_EQUAL;
        }
        const fold = (/** @type {string} */ text)=>((flags & NORM_IGNORECASE) !== 0
            ? text.toLowerCase() : text);
        const x = fold(a.slice(0, left));
        const y = fold(b.slice(0, right));
        return x < y ? -1 : x > y ? 1 : 0;
    };

    /**
     * Text written at an address, cut to fit a buffer of `room` characters
     * with its terminator; nothing for no room.
     *
     * @param {import('./text.js').Width} width @param {number} address
     * @param {string} text @param {number} room
     */
    const writeCut = (width, address, text, room)=>{
        if (room > 0)
        {
            host.writeMemory(address >>> 0, width.sz(text.slice(0, room - 1)));
        }
    };

    /**
     * A copy in the process heap, which the caller frees with LocalFree. No
     * string is an empty one, as the shlwapi of this era copies it.
     *
     * @param {import('./text.js').Width} width @param {number} source
     */
    const duplicate = (width, source)=>{
        const text = width.read(source) ?? '';
        const block = host.allocate?.((text.length + 1) * width.unit) ?? 0;
        if (block !== 0)
        {
            host.writeMemory(block, width.sz(text));
        }
        return block;
    };

    /**
     * StrRetToBuf for either buffer: the text a STRRET holds, in whichever of
     * its three forms, cut to the buffer. A STRRET_WSTR's string is the
     * caller's to give up, and is freed here, as the call is documented to.
     * A string cut short is still S_OK, which is what this era's shlwapi
     * answers (Wine's test_StrXXX_overflows); a STRRET with no text, or of a
     * kind there is none of, empties the buffer and is E_FAIL.
     *
     * @param {import('./text.js').Width} width @param {number[]} args
     */
    const strRetToBuf = (width, [strret, item, buffer, room])=>{
        if ((buffer >>> 0) === 0 || (room >>> 0) === 0 || (strret >>> 0) === 0
            || !host.readMemory)
        {
            return E_FAIL;
        }
        const head = host.readMemory(strret >>> 0, 8);
        const kind = u32(head, 0);
        const field = u32(head, STRRET_UNION);
        /** @type {string | null} */
        let text = null;
        if (kind === STRRET_WSTR)
        {
            text = W.read(field);
            if (text !== null)
            {
                host.free?.(field);
            }
        }
        else if (kind === STRRET_CSTR)
        {
            text = A.read((strret >>> 0) + STRRET_UNION, STRRET_CSTR_LENGTH);
        }
        else if (kind === STRRET_OFFSET && (item >>> 0) !== 0)
        {
            text = A.read((item >>> 0) + field);
        }
        writeCut(width, buffer, text ?? '', room >>> 0);
        return text === null ? E_FAIL : S_OK;
    };

    /**
     * StrCSpn's count: the leading characters none of the set.
     *
     * @param {import('./text.js').Width} width @param {number} text
     * @param {number} set @param {boolean} ignoreCase
     */
    const span = (width, text, set, ignoreCase)=>{
        const fold = (/** @type {string} */ value)=>(ignoreCase ? value.toUpperCase() : value);
        const string = width.read(text);
        const stops = width.read(set);
        if (string === null || stops === null)
        {
            return 0;
        }
        const folded = fold(stops);
        let at = 0;
        while (at < string.length && !folded.includes(fold(string[at])))
        {
            at++;
        }
        return at;
    };

    return {
        /**
         * PSTR StrChrA(PCSTR pszStart, WORD wMatch)
         * PWSTR StrChrW(PCWSTR pszStart, WCHAR wMatch)
         *
         * The first place the character is, or NULL.
         */
        ...both('StrChr', 8, (width, [start, code])=>{
            const text = width.read(start);
            const wanted = searched(width, code);
            const at = text === null || wanted === null ? -1 : text.indexOf(wanted);
            return at < 0 ? 0 : (start >>> 0) + at * width.unit;
        }),

        /**
         * PSTR StrChrIA(PCSTR pszStart, WORD wMatch)
         *
         * StrChr with case ignored.
         */
        ...both('StrChrI', 8, (width, [start, code])=>{
            const text = width.read(start);
            const wanted = searched(width, code);
            const at = text === null || wanted === null ? -1
                : foldCase(text).indexOf(foldCase(wanted));
            return at < 0 ? 0 : (start >>> 0) + at * width.unit;
        }),

        /**
         * PSTR StrRChrA(PCSTR pszStart, PCSTR pszEnd, WORD wMatch)
         *
         * The last place it is before pszEnd, or in the whole string for a
         * null end.
         */
        ...both('StrRChr', 12, (width, [start, end, code])=>{
            const text = width.read(start);
            const wanted = searched(width, code);
            if (text === null || wanted === null)
            {
                return 0;
            }
            const stop = (end >>> 0) === 0 ? text.length
                : Math.min(text.length, Math.floor(((end >>> 0) - (start >>> 0)) / width.unit));
            const at = stop <= 0 ? -1 : text.lastIndexOf(wanted, stop - 1);
            return at < 0 ? 0 : (start >>> 0) + at * width.unit;
        }),

        /**
         * int StrCSpnA(LPCSTR pszStr, LPCSTR pszSet)
         * int StrCSpnIA(LPCSTR pszStr, LPCSTR pszSet)
         *
         * How many characters lead the string before one of the set; the
         * whole length when none is there. The I spelling ignores case.
         */
        ...both('StrCSpn', 8, (width, [text, set])=>span(width, text, set, false)),
        ...both('StrCSpnI', 8, (width, [text, set])=>span(width, text, set, true)),

        /** int StrCmpW(PCWSTR psz1, PCWSTR psz2) */
        StrCmpW: one(W, 8, (width, [first, second])=>compare(width, first, second, 0, null)),

        /** int StrCmpIW(PCWSTR psz1, PCWSTR psz2) */
        StrCmpIW: one(W, 8, (width, [first, second])=>
            compare(width, first, second, NORM_IGNORECASE, null)),

        /** int StrCmpNA(PCSTR psz1, PCSTR psz2, int nChar) */
        ...both('StrCmpN', 12, (width, [first, second, count])=>
            compare(width, first, second, 0, count | 0)),

        /** int StrCmpNIA(PCSTR psz1, PCSTR psz2, int nChar) */
        ...both('StrCmpNI', 12, (width, [first, second, count])=>
            compare(width, first, second, NORM_IGNORECASE, count | 0)),

        /** PWSTR StrCpyW(PWSTR psz1, PCWSTR psz2): the copy's destination. */
        StrCpyW: one(W, 8, (width, [destination, source])=>{
            const text = width.read(source);
            if ((destination >>> 0) !== 0 && text !== null)
            {
                host.writeMemory(destination >>> 0, width.sz(text));
            }
            return destination >>> 0;
        }),

        /**
         * PWSTR StrCpyNW(PWSTR pszDst, PCWSTR pszSrc, int cchMax)
         *
         * At most cchMax characters, the terminator one of them: with room for
         * the terminator alone the source is not read, a null source is an
         * empty one, and with no room nothing is written (Wine's
         * test_StrXXX_overflows).
         */
        StrCpyNW: one(W, 12, (width, [destination, source, room])=>{
            if ((destination >>> 0) !== 0 && (room | 0) > 0)
            {
                writeCut(width, destination, (room | 0) > 1 ? width.read(source) ?? '' : '',
                    room | 0);
            }
            return destination >>> 0;
        }),

        /** PWSTR StrCatW(PWSTR psz1, PCWSTR psz2): psz2 appended to psz1. */
        StrCatW: one(W, 8, (width, [destination, source])=>{
            const head = width.read(destination);
            const tail = width.read(source);
            if (head !== null && tail !== null)
            {
                host.writeMemory((destination >>> 0) + head.length * width.unit, width.sz(tail));
            }
            return destination >>> 0;
        }),

        /**
         * PSTR StrCatBuffA(PSTR pszDest, PCSTR pszSrc, int cchDestBuffSize)
         *
         * pszSrc appended, cut to what the buffer holds with its terminator.
         */
        ...both('StrCatBuff', 12, (width, [destination, source, size])=>{
            const head = width.read(destination);
            const tail = width.read(source);
            if (head !== null && tail !== null && (size | 0) > head.length)
            {
                writeCut(width, (destination >>> 0) + head.length * width.unit, tail,
                    (size | 0) - head.length);
            }
            return destination >>> 0;
        }),

        /** PSTR StrDupA(PCSTR pszSrch): a copy the caller LocalFrees. */
        ...both('StrDup', 4, (width, [source])=>duplicate(width, source)),

        /**
         * PSTR StrStrA(PCSTR pszFirst, PCSTR pszSrch)
         *
         * Where the second string first is in the first, case and all; NULL
         * for an empty one (Wine's test_StrStrA).
         */
        ...both('StrStr', 8, (width, [first, second])=>{
            const text = width.read(first);
            const wanted = width.read(second);
            const at = text === null || !wanted ? -1 : text.indexOf(wanted);
            return at < 0 ? 0 : (first >>> 0) + at * width.unit;
        }),

        /**
         * PSTR StrStrIA(PCSTR pszFirst, PCSTR pszSrch)
         *
         * StrStr with case ignored, folded a character at a time so a match's
         * place in the folded text is its place in the caller's; NULL for an
         * empty search (Wine's test_StrStrIA).
         */
        ...both('StrStrI', 8, (width, [first, second])=>{
            const text = width.read(first);
            const wanted = width.read(second);
            const at = text === null || !wanted ? -1 : foldCase(text).indexOf(foldCase(wanted));
            return at < 0 ? 0 : (first >>> 0) + at * width.unit;
        }),

        /**
         * PSTR StrRStrIA(PCSTR pszSource, PCSTR pszLast, PCSTR pszSrch)
         *
         * The last place the search starts before pszLast, case ignored; a
         * match may run past pszLast, and a null pszLast is the whole string
         * (Wine's test_StrRStrI).
         */
        ...both('StrRStrI', 12, (width, [source, last, search])=>{
            const text = width.read(source);
            const wanted = width.read(search);
            if (text === null || !wanted)
            {
                return 0;
            }
            const stop = (last >>> 0) === 0 ? text.length
                : Math.min(text.length, Math.floor(((last >>> 0) - (source >>> 0)) / width.unit));
            const at = stop <= 0 ? -1 : foldCase(text).lastIndexOf(foldCase(wanted), stop - 1);
            return at < 0 ? 0 : (source >>> 0) + at * width.unit;
        }),

        /**
         * int StrFromTimeIntervalA(PSTR pszOut, UINT cchMax, DWORD dwTimeMS, int digits)
         *
         * `timeInterval`'s text, cut to the buffer; the characters written.
         */
        ...both('StrFromTimeInterval', 16, (width, [buffer, room, milliseconds, digits])=>{
            const text = timeInterval(milliseconds, digits);
            if ((buffer >>> 0) === 0 || (room >>> 0) === 0)
            {
                return 0;
            }
            writeCut(width, buffer, text, room >>> 0);
            return Math.min(text.length, (room >>> 0) - 1);
        }),

        /**
         * HRESULT StrRetToBufA(STRRET *pstr, PCUITEMID_CHILD pidl, LPSTR pszBuf, UINT cchBuf)
         * HRESULT StrRetToBufW(STRRET *pstr, PCUITEMID_CHILD pidl, LPWSTR pszBuf, UINT cchBuf)
         */
        ...both('StrRetToBuf', 16, strRetToBuf),

        /**
         * HRESULT StrRetToBSTR(STRRET *pstr, PCUITEMID_CHILD pidl, BSTR *pbstr)
         *
         * StrRetToBuf's text as a BSTR the caller frees with SysFreeString.
         */
        StrRetToBSTR: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([strret, item, out])=>{
                if ((out >>> 0) === 0 || !host.allocate)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, Uint8Array.of(0, 0, 0, 0));
                const scratch = host.allocate(0x2000);
                if (!scratch)
                {
                    return E_OUTOFMEMORY;
                }
                try
                {
                    const hr = strRetToBuf(W, [strret, item, scratch, 0x1000]);
                    if (hr !== S_OK)
                    {
                        return hr;
                    }
                    const alloc = host.library?.('OLEAUT32.dll')?.SysAllocString;
                    const bstr = alloc ? /** @type {number} */ (alloc.handler([scratch])) >>> 0 : 0;
                    host.writeMemory(out >>> 0, Uint8Array.of(bstr & 0xff, bstr >>> 8 & 0xff,
                        bstr >>> 16 & 0xff, bstr >>> 24 & 0xff));
                    return bstr ? S_OK : E_OUTOFMEMORY;
                }
                finally
                {
                    host.free?.(scratch);
                }
            },
        },

        /**
         * PWSTR StrChrNW(PCWSTR pszStart, WCHAR wMatch, UINT cchMax)
         *
         * StrChr within the first cchMax characters.
         */
        StrChrNW: one(W, 12, (width, [start, code, count])=>{
            const text = width.read(start)?.slice(0, count >>> 0) ?? null;
            const wanted = searched(width, code);
            const at = text === null || wanted === null ? -1 : text.indexOf(wanted);
            return at < 0 ? 0 : (start >>> 0) + at * width.unit;
        }),

        /**
         * PSTR StrPBrkA(PCSTR psz, PCSTR pszSet)
         *
         * The first character of the string that is in the set, or NULL.
         */
        ...both('StrPBrk', 8, (width, [text, set])=>{
            const string = width.read(text);
            const stops = width.read(set);
            if (string === null || !stops)
            {
                return 0;
            }
            const at = [...string].findIndex(c=>stops.includes(c));
            return at < 0 ? 0 : (text >>> 0) + at * width.unit;
        }),

        /**
         * PWSTR StrStrNW(PCWSTR pszFirst, PCWSTR pszSrch, UINT cchMax)
         *
         * StrStr where the match starts within the first cchMax characters,
         * running past them if it must (Wine's test_StrStrNW); the I form
         * ignores case.
         */
        StrStrNW: one(W, 12, (width, [first, second, count])=>{
            const text = width.read(first);
            const wanted = width.read(second);
            const at = text === null || !wanted ? -1 : text.indexOf(wanted);
            return at < 0 || at >= (count >>> 0) ? 0 : (first >>> 0) + at * width.unit;
        }),
        StrStrNIW: one(W, 12, (width, [first, second, count])=>{
            const text = width.read(first);
            const wanted = width.read(second);
            const at = text === null || !wanted ? -1 : foldCase(text).indexOf(foldCase(wanted));
            return at < 0 || at >= (count >>> 0) ? 0 : (first >>> 0) + at * width.unit;
        }),

        /**
         * DWORD StrCatChainW(PWSTR pszDst, DWORD cchDst, DWORD ichAt, PCWSTR pszSrc)
         *
         * The source copied in at a place in the buffer -- -1 is the end of
         * what is there, the buffer's own end its last character -- cut to
         * fit with its terminator; where the copy ends. A place past the
         * buffer writes nothing (Wine's test_StrCatChainW).
         */
        StrCatChainW: one(W, 16, (width, [destination, size, place, source])=>{
            const room = size >>> 0;
            let at = (place | 0) === -1 ? (width.read(destination) ?? '').length : place >>> 0;
            if ((destination >>> 0) === 0 || room === 0 || at > room)
            {
                return at;
            }
            if (at === room)
            {
                at--;
            }
            const text = (width.read(source) ?? '').slice(0, room - at - 1);
            host.writeMemory((destination >>> 0) + at * width.unit, width.sz(text));
            return at + text.length;
        }),

        /**
         * PSTR StrCpyNXA(PSTR pszDst, PCSTR pszSrc, int cchMax)
         *
         * StrCpyN that answers where the copy's terminator went.
         */
        ...both('StrCpyNX', 12, (width, [destination, source, count])=>{
            if ((destination >>> 0) === 0 || (count | 0) <= 0)
            {
                return destination >>> 0;
            }
            const text = (width.read(source) ?? '').slice(0, (count | 0) - 1);
            host.writeMemory(destination >>> 0, width.sz(text));
            return (destination >>> 0) + text.length * width.unit;
        }),

        /**
         * DWORD SHAnsiToAnsi(LPCSTR lpszSrc, LPSTR lpszDst, int iLen)
         * DWORD SHUnicodeToUnicode(LPCWSTR lpszSrc, LPWSTR lpszDst, int iLen)
         *
         * A copy cut to the buffer; the characters written, terminator and all.
         */
        SHAnsiToAnsi: one(A, 12, (width, [source, destination, count])=>{
            const text = (width.read(source) ?? '').slice(0, Math.max(0, (count | 0) - 1));
            if ((destination >>> 0) === 0 || (count | 0) <= 0)
            {
                return 0;
            }
            host.writeMemory(destination >>> 0, width.sz(text));
            return text.length + 1;
        }),
        SHUnicodeToUnicode: one(W, 12, (width, [source, destination, count])=>{
            const text = (width.read(source) ?? '').slice(0, Math.max(0, (count | 0) - 1));
            if ((destination >>> 0) === 0 || (count | 0) <= 0)
            {
                return 0;
            }
            host.writeMemory(destination >>> 0, width.sz(text));
            return text.length + 1;
        }),

        /**
         * BOOL ChrCmpIA(WORD w1, WORD w2): zero when the two are one character
         * whatever its case, as StrCmpI compares.
         */
        ...both('ChrCmpI', 8, (width, [first, second])=>{
            const a = searched(width, first) ?? '';
            const b = searched(width, second) ?? '';
            return foldCase(a) === foldCase(b) ? 0 : 1;
        }),

        /**
         * BOOL StrIsIntlEqualA(BOOL fCaseSens, LPCSTR pString1, LPCSTR pString2, int nChar)
         * BOOL IntlStrEqWorkerA(BOOL fCaseSens, LPCSTR lpszStr, LPCSTR lpszComp, int iLen)
         *
         * Whether the first nChar characters of each are equal, as
         * CompareString has them, with case or without.
         */
        ...both('StrIsIntlEqual', 16, (width, [sensitive, first, second, count])=>
            (compare(width, first, second, sensitive ? 0 : NORM_IGNORECASE, count | 0) === 0
                ? 1 : 0)),
        ...both('IntlStrEqWorker', 16, (width, [sensitive, first, second, count])=>
            (compare(width, first, second, sensitive ? 0 : NORM_IGNORECASE, count | 0) === 0
                ? 1 : 0)),

        /**
         * PSTR StrFormatByteSizeA(DWORD dw, PSTR pszBuf, UINT cchBuf)
         * PWSTR StrFormatByteSizeW(LONGLONG qdw, PWSTR pszBuf, UINT cchBuf)
         * PSTR StrFormatByteSize64A(LONGLONG qdw, PSTR pszBuf, UINT cchBuf)
         *
         * `byteSize`'s text, cut to the buffer; the buffer.
         */
        StrFormatByteSizeA: one(A, 12, (width, [size, buffer, room])=>{
            writeCut(width, buffer, byteSize(BigInt(size >>> 0)), room >>> 0);
            return buffer >>> 0;
        }),
        StrFormatByteSizeW: one(W, 16, (width, [low, high, buffer, room])=>{
            writeCut(width, buffer, byteSize(int64(low, high)), room >>> 0);
            return buffer >>> 0;
        }),
        StrFormatByteSize64A: one(A, 16, (width, [low, high, buffer, room])=>{
            writeCut(width, buffer, byteSize(int64(low, high)), room >>> 0);
            return buffer >>> 0;
        }),

        /**
         * HRESULT StrFormatByteSizeEx(ULONGLONG ull, SFBS_FLAGS flags, PWSTR pszBuf,
         *                             UINT cchBuf)
         *
         * The same text, its last digit rounded (SFBS_FLAGS_ROUND_TO_NEAREST_DISPLAYED_DIGIT)
         * or cut (SFBS_FLAGS_TRUNCATE_UNDISPLAYED_DECIMAL_DIGITS); any other
         * flag, or no buffer, is E_INVALIDARG.
         */
        StrFormatByteSizeEx: one(W, 20, (width, [low, high, flags, buffer, room])=>{
            if ((flags !== 1 && flags !== 2) || (room >>> 0) === 0 || (buffer >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const size = BigInt.asUintN(64, int64(low, high));
            writeCut(width, buffer, byteSize(size, flags === 1), room >>> 0);
            return S_OK;
        }),

        /**
         * PSTR StrFormatKBSizeA(LONGLONG qdw, PSTR pszBuf, UINT cchBuf)
         *
         * `kbSize`'s text, cut to the buffer; the buffer.
         */
        ...both('StrFormatKBSize', 16, (width, [low, high, buffer, room])=>{
            writeCut(width, buffer, kbSize(int64(low, high)), room >>> 0);
            return buffer >>> 0;
        }),

        /**
         * int wnsprintfA(PSTR pszDest, int cchDest, PCSTR pszFmt, ...)
         *
         * The C runtime's formatting, cut to the buffer with its terminator:
         * the characters written, or -1 when the text did not fit. A buffer
         * of no size takes nothing; one of a negative size only the
         * terminator (Wine's test_StrXXX_overflows).
         */
        wnsprintfA: printer(A),
        wnsprintfW: printer(W),
    };

    /** @param {import('./text.js').Width} width */
    function printer(width){
        return {
            convention: /** @type {'cdecl'} */ ('cdecl'),
            argBytes: 12 + 4 * 32,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [destination, room, format, ...slots])=>{
                const readString = (/** @type {number} */ at)=>(at >>> 0) === 0 ? '(null)'
                    : A.read(at) ?? '';
                const readWideString = (/** @type {number} */ at)=>(at >>> 0) === 0 ? '(null)'
                    : W.read(at) ?? '';
                const text = formatToString(width.read(format) ?? '', slots, readString,
                    { readWideString, wide: width.wide });
                if ((destination >>> 0) === 0 || (room | 0) === 0)
                {
                    return -1;
                }
                if ((room | 0) < 0)
                {
                    host.writeMemory(destination >>> 0, width.sz(''));
                    return -1;
                }
                writeCut(width, destination, text, room | 0);
                return text.length < (room | 0) ? text.length : -1;
            },
        };
    }
}
