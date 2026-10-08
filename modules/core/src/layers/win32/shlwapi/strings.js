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

const S_OK = 0;
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
         * HRESULT StrRetToBufA(STRRET *pstr, PCUITEMID_CHILD pidl, LPSTR pszBuf, UINT cchBuf)
         * HRESULT StrRetToBufW(STRRET *pstr, PCUITEMID_CHILD pidl, LPWSTR pszBuf, UINT cchBuf)
         */
        ...both('StrRetToBuf', 16, strRetToBuf),
    };
}
