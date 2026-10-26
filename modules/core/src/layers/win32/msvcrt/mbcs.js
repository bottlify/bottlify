/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The multibyte code page `_setmbcp` selects, and the `_mbs*` family's answers
 * under it.
 *
 * The runtime keeps a code page of its own for the `_mbs*` functions, apart
 * from the locale: a program built for double-byte text calls `_setmbcp(932)`
 * and from then on `_mbslen` counts characters, `_mbsinc` steps over a lead
 * byte and its trail together, and `_mbctype` marks which bytes lead and
 * which may trail. What a double-byte page says of its bytes -- the ranges
 * that begin a two-byte character, the ranges that may end one -- is a fact
 * of the page, written here as ranges; which characters the pairs stand for
 * is not needed to answer any of these, and this build carries none.
 *
 * Under a single-byte page nothing leads, and every function is its byte
 * twin. The functions a program calls in its loops are code in the guest
 * (`inguest.js`) that answers a string of ASCII itself -- no byte below 0x80
 * leads in any page -- and hands a string with a byte past it to the
 * handlers here, which read it by the page.
 */

import { EILSEQ, EINVAL, ERANGE } from './globals.js';

/** The `_mbctype` bits, at the values msvcrt's `<mbctype.h>` gives them. */
export const MB_SYMBOL = 0x01;
export const MB_PUNCT = 0x02;
export const MB_LEAD = 0x04;
export const MB_TRAIL = 0x08;
export const SB_UPPER = 0x10;
export const SB_LOWER = 0x20;

/** What a comparison answers for no string: _NLSCMPERROR, INT_MAX. */
const NLS_COMPARE_ERROR = 0x7fffffff;

/** `_mbbtype` and `_mbsbtype`'s answers. */
export const MBC_SINGLE = 0;
export const MBC_LEAD = 1;
export const MBC_TRAIL = 2;
export const MBC_ILLEGAL = -1;

/** The selectors `_setmbcp` takes besides a page number. */
const MB_CP_SBCS = 0;
const MB_CP_OEM = -2;
const MB_CP_ANSI = -3;
const MB_CP_LOCALE = -4;

/** The system's pages, as GetACP and GetOEMCP answer. */
const ANSI_PAGE = 1252;
const OEM_PAGE = 437;

/**
 * @typedef {Object} DoubleBytePage
 * @property {[number, number][]} lead     Bytes that begin a two-byte character.
 * @property {[number, number][]} trail    Bytes that may end one.
 * @property {[number, number][]} [punctuation]  Single bytes past 0x7f that
 *     stand alone as punctuation.
 * @property {[number, number][]} [symbols]  Single bytes past 0x7f that stand
 *     alone as letters.
 */

/**
 * The double-byte pages Windows has: Shift-JIS (932), GBK (936), Unified
 * Hangul (949), Big5 (950) and Johab (1361). A lead byte's range is what
 * GetCPInfo reports for the page; the trail ranges are the bytes msvcrt's
 * `_mbctype` marks for it, which for 936 and 949 run across the gaps the
 * encodings leave. Shift-JIS alone has single bytes past 0x7f: the half-width
 * katakana, punctuation at 0xa1-0xa5 and letters at 0xa6-0xdf.
 *
 * @type {ReadonlyMap<number, DoubleBytePage>}
 */
const DOUBLE_BYTE_PAGES = new Map([
    [932, {
        lead: [[0x81, 0x9f], [0xe0, 0xfc]],
        trail: [[0x40, 0x7e], [0x80, 0xfc]],
        punctuation: [[0xa1, 0xa5]],
        symbols: [[0xa6, 0xdf]],
    }],
    [936, { lead: [[0x81, 0xfe]], trail: [[0x40, 0xfe]] }],
    [949, { lead: [[0x81, 0xfe]], trail: [[0x41, 0xfe]] }],
    [950, { lead: [[0x81, 0xfe]], trail: [[0x40, 0x7e], [0xa1, 0xfe]] }],
    [1361, {
        lead: [[0x81, 0xd3], [0xd8, 0xde], [0xe0, 0xf9]],
        trail: [[0x31, 0x7e], [0x81, 0xfe]],
    }],
]);

/**
 * The single-byte pages Windows has, OEM and ANSI: `_setmbcp` takes any of
 * them, and under each no byte leads.
 */
const SINGLE_BYTE_PAGES = new Set([437, 720, 737, 775, 850, 852, 855, 857, 858, 860, 861, 862,
    863, 864, 865, 866, 869, 874, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258]);

/**
 * A page's `_mbctype`, the entry for EOF first: the ASCII letters have their
 * case in every page, and a double-byte page marks its lead and trail bytes
 * and its single-byte katakana besides.
 *
 * @param {DoubleBytePage | null} layout
 * @returns {Uint8Array}
 */
export function mbctypeOf(layout){
    const table = new Uint8Array(257);
    /** @param {[number, number][] | undefined} ranges @param {number} bit */
    const mark = (ranges, bit)=>{
        for (const [first, last] of ranges ?? [])
        {
            for (let byte = first; byte <= last; byte++)
            {
                table[byte + 1] |= bit;
            }
        }
    };
    mark([[0x41, 0x5a]], SB_UPPER);
    mark([[0x61, 0x7a]], SB_LOWER);
    if (layout)
    {
        mark(layout.lead, MB_LEAD);
        mark(layout.trail, MB_TRAIL);
        mark(layout.punctuation, MB_PUNCT);
        mark(layout.symbols, MB_SYMBOL);
    }
    return table;
}

/** The WHATWG decoder each double-byte page is read with; Johab has none. */
const DECODERS = new Map([[932, 'shift_jis'], [936, 'gbk'], [949, 'euc-kr'], [950, 'big5']]);

/**
 * Each page's pairs by the character they stand for, made the first time a
 * pair of that page is cased.
 *
 * @type {Map<number, { decode: (pair: number) => string, pairOf: Map<string, number> }>}
 */
const PAGE_CHARACTERS = new Map();

/** @param {number} number */
function charactersOf(number){
    const known = PAGE_CHARACTERS.get(number);
    if (known)
    {
        return known;
    }
    const label = DECODERS.get(number);
    const layout = DOUBLE_BYTE_PAGES.get(number);
    const decoder = label ? new TextDecoder(label) : null;
    /** @param {number} pair */
    const decode = pair=>(decoder ? decoder.decode(Uint8Array.of(pair >> 8, pair & 0xff)) : '');
    /** @type {Map<string, number>} */
    const pairOf = new Map();
    for (const [firstLead, lastLead] of decoder ? layout?.lead ?? [] : [])
    {
        for (let lead = firstLead; lead <= lastLead; lead++)
        {
            for (const [firstTrail, lastTrail] of layout?.trail ?? [])
            {
                for (let trail = firstTrail; trail <= lastTrail; trail++)
                {
                    const character = decode(lead << 8 | trail);
                    if (character.length === 1 && character !== '\ufffd' && !pairOf.has(character))
                    {
                        pairOf.set(character, lead << 8 | trail);
                    }
                }
            }
        }
    }
    const made = { decode, pairOf };
    PAGE_CHARACTERS.set(number, made);
    return made;
}

/**
 * A double-byte character in the other case, as the page's characters map
 * it -- a full-width letter, a Roman numeral, a Greek or Cyrillic letter --
 * where the page has a pair for the other case; itself otherwise.
 *
 * @param {number} number  The page. @param {number} pair @param {boolean} upper
 */
export function pairCase(number, pair, upper){
    const { decode, pairOf } = charactersOf(number);
    const character = decode(pair);
    if (character.length !== 1)
    {
        return pair;
    }
    const other = upper ? character.toUpperCase() : character.toLowerCase();
    return other === character ? pair : pairOf.get(other) ?? pair;
}

/**
 * The runtime's multibyte code page.
 *
 * @typedef {Object} MultiBytePage
 * @property {() => number} page      What `_getmbcp` answers: 0 for the C
 *     locale's single-byte page, the page's number otherwise.
 * @property {(asked: number) => boolean} select  False for a page Windows
 *     does not have, which leaves the one before in place.
 * @property {() => boolean} doubleByte
 * @property {(byte: number) => boolean} isLead
 * @property {(byte: number) => boolean} isTrail
 * @property {() => Uint8Array} table  The `_mbctype` of the page.
 */

/** @returns {MultiBytePage} */
export function createMultiBytePage(){
    let current = 0;
    let table = mbctypeOf(null);
    let doubleByte = false;

    return {
        page: ()=>current,
        select: asked=>{
            let page = asked | 0;
            if (page === MB_CP_ANSI || page === MB_CP_LOCALE)
            {
                page = ANSI_PAGE;
            }
            else if (page === MB_CP_OEM)
            {
                page = OEM_PAGE;
            }
            const layout = DOUBLE_BYTE_PAGES.get(page) ?? null;
            if (page !== MB_CP_SBCS && !layout && !SINGLE_BYTE_PAGES.has(page))
            {
                return false;
            }
            current = page;
            table = mbctypeOf(layout);
            doubleByte = layout !== null;
            return true;
        },
        doubleByte: ()=>doubleByte,
        isLead: byte=>(table[(byte & 0xff) + 1] & MB_LEAD) !== 0,
        isTrail: byte=>(table[(byte & 0xff) + 1] & MB_TRAIL) !== 0,
        table: ()=>table,
    };
}

/**
 * @typedef {Object} MultiByteHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} [errno]
 */

/**
 * The handlers of the `_mbs*` family that read a string by the page: the
 * whole answer of the ones the guest hands every call to, and of the guest
 * code's the calls it leaves -- a string with a byte past 0x7f, or a
 * character past it.
 *
 * Each walks the string as msvcrt does: a lead byte and the byte after it are
 * one character, but for a lead byte the terminator follows, which is the
 * string's end. Under a single-byte page every walk is a byte at a time, and
 * each answer is its byte twin's.
 *
 * @param {MultiByteHost} host @param {MultiBytePage} page
 */
export function createMultiByteHandlers(host, page){
    /** @param {number} address */
    const u8 = address=>host.readMemory(address >>> 0, 1)[0];

    /** @param {number} address @param {number} value */
    const setU8 = (address, value)=>host.writeMemory(address >>> 0, Uint8Array.of(value));

    /** How many bytes the character at `at` takes. @param {number} at */
    const width = at=>(page.isLead(u8(at)) && u8(at + 1) !== 0 ? 2 : 1);

    /** The character at `at` as a number: a pair as lead * 256 + trail. @param {number} at */
    const charAt = at=>(width(at) === 2 ? u8(at) << 8 | u8(at + 1) : u8(at));

    /** @param {number} c */
    const lowerOf = c=>(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);

    /** @param {number} c */
    const upperOf = c=>(c >= 0x61 && c <= 0x7a ? c - 0x20 : c);

    /**
     * The character a search is for: its low byte under a single-byte page,
     * as strchr takes it, and the pair under a double-byte one.
     *
     * @param {number} c
     */
    const wantedOf = c=>(page.doubleByte() ? c & 0xffff : c & 0xff);

    /** -1, 0 or 1. @param {number} a @param {number} b */
    const order = (a, b)=>(a === b ? 0 : a < b ? -1 : 1);

    /**
     * Characters compared until one differs, a string ends, or `count` of
     * them (or of their bytes) are done; folded to lower case when asked,
     * a character of one byte alone having a case.
     *
     * @param {number} left @param {number} right @param {number} count
     * @param {{ fold?: boolean, bytes?: boolean }} how
     */
    const compare = (left, right, count, how)=>{
        let l = left;
        let r = right;
        let left_ = count >>> 0;
        while (left_ > 0)
        {
            let wl = width(l);
            let wr = width(r);
            let a = charAt(l);
            let b = charAt(r);
            if (how.bytes && left_ === 1)
            {
                // The count ends inside a pair: its lead byte is what is compared.
                a = u8(l);
                b = u8(r);
                wl = 1;
                wr = 1;
            }
            if (how.fold)
            {
                a = wl === 1 ? lowerOf(a) : a;
                b = wr === 1 ? lowerOf(b) : b;
            }
            if (a !== b)
            {
                return order(a, b);
            }
            if (a === 0)
            {
                return 0;
            }
            l += wl;
            r += wr;
            left_ -= how.bytes ? wl : 1;
        }
        return 0;
    };

    /**
     * Whether the character at `at` is in the set: a pair matched as a pair,
     * a single byte as itself -- and a lead byte that ends the set matches
     * anything, as msvcrt's walk of it answers.
     *
     * @param {number} at @param {number} set
     */
    const inSet = (at, set)=>{
        const w = width(at);
        for (let q = set; u8(q) !== 0; q++)
        {
            const c = u8(q);
            if (page.isLead(c))
            {
                if (u8(q + 1) === 0)
                {
                    return true;
                }
                if (w === 2 && u8(at) === c && u8(at + 1) === u8(q + 1))
                {
                    return true;
                }
                q++;
            }
            else if (w === 1 && u8(at) === c)
            {
                return true;
            }
        }
        return false;
    };

    /**
     * Where a walk over the set's characters stops: at the first character
     * whose membership is not `inside`.
     *
     * @param {number} string @param {number} set @param {boolean} inside
     */
    const span = (string, set, inside)=>{
        let at = string;
        while (u8(at) !== 0 && inSet(at, set) === inside)
        {
            at += width(at);
        }
        return at;
    };

    /**
     * A parameter msvcrt checks: -1 and EINVAL, or null, as the caller's
     * shape says.
     *
     * @param {number} answer
     */
    const invalid = (answer = 0)=>{
        host.errno?.(EINVAL);
        return answer;
    };

    /**
     * `_mbstok`'s saved position: its own, apart from strtok's, as the
     * runtime keeps them.
     */
    let tokenAt = 0;

    /**
     * _mbscpy_s's and _mbscat_s's body.
     *
     * @param {number} destination @param {number} size @param {number} source
     * @param {boolean} append
     */
    const secureAppend = (destination, size, source, append)=>{
        const room = size >>> 0;
        if ((destination >>> 0) === 0 || room === 0)
        {
            return invalid(EINVAL);
        }
        if ((source >>> 0) === 0)
        {
            setU8(destination, 0);
            return invalid(EINVAL);
        }
        let end = 0;
        let ended = false;
        if (append)
        {
            while (end < room && u8(destination + end) !== 0)
            {
                end++;
            }
            if (end === room)
            {
                setU8(destination, 0);
                return invalid(EINVAL);
            }
            // A lead byte that ends the destination is no character.
            for (let at = 0; at < end; at += width(destination + at))
            {
                if (page.isLead(u8(destination + at)) && at + 1 === end)
                {
                    end--;
                    ended = true;
                }
            }
        }
        /** @type {number[]} */
        const bytes = [];
        for (let at = source; u8(at) !== 0; at++)
        {
            if (page.isLead(u8(at)))
            {
                if (u8(at + 1) === 0)
                {
                    ended = true;
                    break;
                }
                bytes.push(u8(at));
                at++;
            }
            bytes.push(u8(at));
        }
        if (end + bytes.length + 1 > room)
        {
            host.writeMemory(destination + end, Uint8Array.from(bytes.slice(0, room - end)));
            setU8(destination, 0);
            host.errno?.(ERANGE);
            return ERANGE;
        }
        host.writeMemory(destination + end, Uint8Array.from([...bytes, 0]));
        if (ended)
        {
            host.errno?.(EILSEQ);
            return EILSEQ;
        }
        return 0;
    };

    /**
     * _mbsupr_s's and _mbslwr_s's body.
     *
     * @param {number} string @param {number} size @param {number} fold
     */
    const secureCase = (string, size, fold)=>{
        const room = size >>> 0;
        if ((string >>> 0) === 0 && room === 0)
        {
            return 0;
        }
        if ((string >>> 0) === 0 || room === 0)
        {
            return invalid(EINVAL);
        }
        let length = 0;
        while (length < room && u8(string + length) !== 0)
        {
            length++;
        }
        if (length === room)
        {
            setU8(string, 0);
            return invalid(EINVAL);
        }
        caseMap(fold)([string]);
        return 0;
    };

    /** @param {number} fold @returns {(args: number[]) => number} */
    const caseMap = fold=>([string])=>{
        for (let at = string; u8(at) !== 0;)
        {
            const w = width(at);
            if (w === 1)
            {
                const c = u8(at);
                const mapped = fold === 0 ? lowerOf(c) : upperOf(c);
                if (mapped !== c)
                {
                    setU8(at, mapped);
                }
            }
            else
            {
                const pair = u8(at) << 8 | u8(at + 1);
                const mapped = pairCase(page.page(), pair, fold !== 0);
                if (mapped !== pair)
                {
                    setU8(at, mapped >> 8);
                    setU8(at + 1, mapped & 0xff);
                }
            }
            at += w;
        }
        return string;
    };

    return {
        /** @param {number[]} args */
        _mbslen: ([string])=>{
            let count = 0;
            for (let at = string; u8(at) !== 0; count++)
            {
                if (page.isLead(u8(at)) && u8(at + 1) === 0)
                {
                    // A lead byte the terminator follows is not a character.
                    break;
                }
                at += width(at);
            }
            return count;
        },

        /** @param {number[]} args */
        _mbclen: ([at])=>width(at),

        /** @param {number[]} args */
        _mbsinc: ([at])=>at + width(at),

        /** @param {number[]} args */
        _mbsdec: ([start, at])=>{
            if (at >>> 0 <= start >>> 0)
            {
                return 0;
            }
            let previous = start;
            for (let walk = start; walk < at; walk += width(walk))
            {
                previous = walk;
            }
            return previous;
        },

        /** @param {number[]} args */
        _mbsninc: ([string, count])=>{
            if ((string >>> 0) === 0)
            {
                return 0;
            }
            let at = string;
            for (let i = 0; i < count >>> 0 && u8(at) !== 0; i++)
            {
                if (page.isLead(u8(at)) && u8(at + 1) === 0)
                {
                    break;
                }
                at += width(at);
            }
            return at;
        },

        /** @param {number[]} args */
        _mbsnextc: ([at])=>charAt(at),

        /** @param {number[]} args */
        _ismbblead: ([c])=>(page.isLead(c) ? 1 : 0),

        /** @param {number[]} args */
        _ismbbtrail: ([c])=>(page.isTrail(c) ? 1 : 0),

        /** @param {number[]} args */
        _ismbslead: ([start, at])=>{
            for (let walk = start; walk <= at;)
            {
                const c = u8(walk);
                if (c === 0)
                {
                    return 0;
                }
                if (!page.isLead(c))
                {
                    if (walk === at)
                    {
                        return 0;
                    }
                    walk++;
                    continue;
                }
                if (walk === at)
                {
                    return -1;
                }
                if (u8(walk + 1) === 0)
                {
                    return 0;
                }
                walk += 2;
            }
            return 0;
        },

        /** @param {number[]} args */
        _ismbstrail: ([start, at])=>{
            for (let walk = start; walk < at;)
            {
                const c = u8(walk);
                if (c === 0)
                {
                    return 0;
                }
                if (!page.isLead(c))
                {
                    walk++;
                    continue;
                }
                if (walk + 1 === at)
                {
                    return -1;
                }
                if (u8(walk + 1) === 0)
                {
                    return 0;
                }
                walk += 2;
            }
            return 0;
        },

        /** @param {number[]} args */
        _mbbtype: ([c, type])=>{
            const byte = c & 0xff;
            if ((type | 0) === MBC_LEAD)
            {
                return page.isTrail(byte) ? MBC_TRAIL : MBC_ILLEGAL;
            }
            if (page.isLead(byte))
            {
                return MBC_LEAD;
            }
            return byte >= 0x20 && byte <= 0x7e ? MBC_SINGLE : MBC_ILLEGAL;
        },

        /** @param {number[]} args */
        _mbsbtype: ([string, index])=>{
            if ((string >>> 0) === 0)
            {
                return MBC_ILLEGAL;
            }
            let afterLead = false;
            for (let i = 0; ; i++)
            {
                const c = u8(string + i);
                if (c === 0)
                {
                    return MBC_ILLEGAL;
                }
                let type;
                if (afterLead)
                {
                    type = page.isTrail(c) ? MBC_TRAIL : MBC_ILLEGAL;
                    afterLead = false;
                }
                else if (page.isLead(c))
                {
                    type = MBC_LEAD;
                    afterLead = true;
                }
                else
                {
                    type = c >= 0x20 && c <= 0x7e ? MBC_SINGLE : MBC_ILLEGAL;
                }
                if (i === index >>> 0)
                {
                    return type;
                }
            }
        },

        /** @param {number[]} args */
        _mbccpy: ([destination, source])=>{
            const c = u8(source);
            setU8(destination, c);
            if (page.isLead(c))
            {
                setU8(destination + 1, u8(source + 1));
            }
            return 0;
        },

        /**
         * `count` characters and the terminator's zeros after them; a lead
         * byte the terminator follows is written as two zeros. No count is
         * the destination, whatever it is; with one, no destination or no
         * source is null and EINVAL.
         *
         * @param {number[]} args
         */
        _mbsncpy: ([destination, source, count])=>{
            let left = count >>> 0;
            if (left === 0)
            {
                return destination;
            }
            if ((destination >>> 0) === 0 || (source >>> 0) === 0)
            {
                return invalid();
            }
            let out = destination;
            let at = source;
            while (left > 0)
            {
                left--;
                const c = u8(at);
                if (page.isLead(c))
                {
                    if (u8(at + 1) === 0)
                    {
                        setU8(out, 0);
                        setU8(out + 1, 0);
                        out += 2;
                        break;
                    }
                    setU8(out++, c);
                    at++;
                }
                const next = u8(at++);
                setU8(out++, next);
                if (next === 0)
                {
                    break;
                }
            }
            host.writeMemory(out, new Uint8Array(left));
            return destination;
        },

        /**
         * `count` bytes, as strncpy copies them, but for a pair the count
         * would cut in two or the terminator ends: its lead byte is written
         * as a zero.
         *
         * @param {number[]} args
         */
        _mbsnbcpy: ([destination, source, count])=>{
            const limit = count >>> 0;
            if (limit === 0)
            {
                return destination;
            }
            if ((destination >>> 0) === 0 || (source >>> 0) === 0)
            {
                return invalid();
            }
            let at = 0;
            while (at < limit)
            {
                const c = u8(source + at);
                if (c === 0)
                {
                    break;
                }
                if (page.isLead(c))
                {
                    if (at + 1 >= limit || u8(source + at + 1) === 0)
                    {
                        setU8(destination + at, 0);
                        at++;
                        break;
                    }
                    setU8(destination + at, c);
                    setU8(destination + at + 1, u8(source + at + 1));
                    at += 2;
                    continue;
                }
                setU8(destination + at, c);
                at++;
            }
            host.writeMemory(destination + at, new Uint8Array(limit - at));
            return destination;
        },

        /** @param {number[]} args */
        _mbschr: ([string, c])=>{
            const wanted = wantedOf(c);
            let at = string;
            for (; u8(at) !== 0; at += width(at))
            {
                if (charAt(at) === wanted)
                {
                    return at;
                }
            }
            return wanted === 0 ? at : 0;
        },

        /** @param {number[]} args */
        _mbsrchr: ([string, c])=>{
            const wanted = wantedOf(c);
            let found = 0;
            let at = string;
            for (; u8(at) !== 0; at += width(at))
            {
                if (charAt(at) === wanted)
                {
                    found = at;
                }
            }
            return wanted === 0 ? at : found;
        },

        /** @param {number[]} args */
        _mbsstr: ([haystack, needle])=>{
            for (let at = haystack; ; at += width(at))
            {
                let i = 0;
                while (u8(needle + i) !== 0 && u8(at + i) === u8(needle + i))
                {
                    i++;
                }
                if (u8(needle + i) === 0)
                {
                    return at;
                }
                if (u8(at) === 0)
                {
                    return 0;
                }
            }
        },

        /** @param {number[]} args */
        _mbscmp: ([left, right])=>((left >>> 0) === 0 || (right >>> 0) === 0
            ? invalid(NLS_COMPARE_ERROR) : compare(left, right, 0xffffffff, {})),
        /** @param {number[]} args */
        _mbsicmp: ([left, right])=>((left >>> 0) === 0 || (right >>> 0) === 0
            ? invalid(NLS_COMPARE_ERROR) : compare(left, right, 0xffffffff, { fold: true })),
        /** @param {number[]} args */
        _mbsncmp: ([left, right, count])=>compare(left, right, count, {}),
        /** @param {number[]} args */
        _mbsnicmp: ([left, right, count])=>compare(left, right, count, { fold: true }),
        /** @param {number[]} args */
        _mbsnbcmp: ([left, right, count])=>compare(left, right, count, { bytes: true }),
        /** @param {number[]} args */
        _mbsnbicmp: ([left, right, count])=>
            compare(left, right, count, { bytes: true, fold: true }),

        _mbslwr: caseMap(0),
        _mbsupr: caseMap(1),

        /** @param {number[]} args */
        _mbsspn: ([string, set])=>span(string, set, true) - string,
        /** @param {number[]} args */
        _mbscspn: ([string, set])=>span(string, set, false) - string,
        /** @param {number[]} args */
        _mbsspnp: ([string, set])=>{
            const at = span(string, set, true);
            return u8(at) === 0 ? 0 : at;
        },
        /** @param {number[]} args */
        _mbspbrk: ([string, set])=>{
            const at = span(string, set, false);
            return u8(at) === 0 ? 0 : at;
        },

        /**
         * In place, character by character: a pair keeps its order, and a
         * lead byte the terminator follows is dropped.
         *
         * @param {number[]} args
         */
        _mbsrev: ([string])=>{
            /** @type {number[][]} */
            const characters = [];
            let at = string;
            while (u8(at) !== 0)
            {
                const c = u8(at);
                if (page.isLead(c))
                {
                    if (u8(at + 1) === 0)
                    {
                        break;
                    }
                    characters.push([c, u8(at + 1)]);
                    at += 2;
                    continue;
                }
                characters.push([c]);
                at++;
            }
            const bytes = characters.reverse().flat();
            host.writeMemory(string, Uint8Array.from([...bytes, ...new Array(at - string
                - bytes.length + 1).fill(0)]));
            return string;
        },

        /** @param {number[]} args */
        _mbsncat: ([destination, source, count])=>{
            let end = destination;
            while (u8(end) !== 0)
            {
                end++;
            }
            let at = source;
            for (let i = 0; i < count >>> 0 && u8(at) !== 0; i++)
            {
                const w = width(at);
                host.writeMemory(end, host.readMemory(at, w).slice());
                end += w;
                at += w;
            }
            setU8(end, 0);
            return destination;
        },

        /** @param {number[]} args */
        _mbsnbcat: ([destination, source, count])=>{
            let end = destination;
            while (u8(end) !== 0)
            {
                end++;
            }
            let at = source;
            let left = count >>> 0;
            while (left > 0 && u8(at) !== 0)
            {
                const w = width(at);
                if (w > left)
                {
                    break;
                }
                host.writeMemory(end, host.readMemory(at, w).slice());
                end += w;
                at += w;
                left -= w;
            }
            setU8(end, 0);
            return destination;
        },

        /**
         * As strtok, by characters: the delimiters skipped, the token ended
         * with a terminator written over the delimiter after it.
         *
         * @param {number[]} args
         */
        _mbstok: ([string, delimiters])=>{
            if ((string >>> 0) !== 0)
            {
                tokenAt = string >>> 0;
            }
            if (tokenAt === 0)
            {
                return 0;
            }
            const start = span(tokenAt, delimiters, true);
            if (u8(start) === 0)
            {
                tokenAt = 0;
                return 0;
            }
            const end = span(start, delimiters, false);
            if (u8(end) === 0)
            {
                tokenAt = 0;
                return start;
            }
            const w = width(end);
            host.writeMemory(end, new Uint8Array(w));
            tokenAt = end + w;
            return start;
        },

        /** @param {number[]} args */
        _ismbclegal: ([c])=>((c >>> 0) < 0x10000 && page.isLead(c >>> 8 & 0xff)
            && page.isTrail(c & 0xff) ? 1 : 0),

        /**
         * size_t _mbsnlen(const unsigned char *string, size_t max): `max`
         * when no terminator comes within `max` bytes, else the characters
         * before it, as _mbslen counts them.
         *
         * @param {number[]} args
         */
        _mbsnlen: ([string, max])=>{
            const limit = max >>> 0;
            let bytes = 0;
            while (bytes < limit && u8(string + bytes) !== 0)
            {
                bytes++;
            }
            if (bytes === limit)
            {
                return limit;
            }
            let count = 0;
            for (let at = string; u8(at) !== 0; count++)
            {
                if (page.isLead(u8(at)) && u8(at + 1) === 0)
                {
                    break;
                }
                at += width(at);
            }
            return count;
        },

        /**
         * errno_t _mbccpy_s(unsigned char *dest, size_t size, int *copied,
         *                   const unsigned char *src)
         *
         * One character: EINVAL for no room, ERANGE with an empty buffer for
         * a pair that does not fit, EILSEQ for a lead byte the terminator
         * follows (one byte copied, written as a terminator).
         *
         * @param {number[]} args
         */
        _mbccpy_s: ([destination, size, copied, source])=>{
            const writeCopied = (/** @type {number} */ count)=>{
                if ((copied >>> 0) !== 0)
                {
                    host.writeMemory(copied, Uint8Array.of(count, 0, 0, 0));
                }
            };
            writeCopied(0);
            if ((destination >>> 0) === 0 || (source >>> 0) === 0 || (size >>> 0) === 0)
            {
                return invalid(EINVAL);
            }
            const c = u8(source);
            if (!page.isLead(c))
            {
                setU8(destination, c);
                writeCopied(1);
                return 0;
            }
            if (u8(source + 1) === 0)
            {
                setU8(destination, 0);
                writeCopied(1);
                host.errno?.(EILSEQ);
                return EILSEQ;
            }
            if ((size >>> 0) < 2)
            {
                setU8(destination, 0);
                host.errno?.(ERANGE);
                return ERANGE;
            }
            setU8(destination, c);
            setU8(destination + 1, u8(source + 1));
            writeCopied(2);
            return 0;
        },

        /**
         * errno_t _mbscpy_s(unsigned char *dest, size_t size, const unsigned char *src)
         * and _mbscat_s: strcpy_s and strcat_s by characters. A lead byte the
         * terminator follows -- at the end of the destination or of the
         * source -- is dropped, the rest copied, and the answer EILSEQ. No
         * terminator within the destination's size is EINVAL; a text that
         * does not fit is ERANGE, the destination's first byte zeroed.
         *
         * @param {number[]} args
         */
        _mbscpy_s: ([destination, size, source])=>secureAppend(destination, size, source, false),
        /** @param {number[]} args */
        _mbscat_s: ([destination, size, source])=>secureAppend(destination, size, source, true),

        /**
         * errno_t _mbsnbcpy_s(unsigned char *dest, size_t size, const unsigned char *src,
         *                     size_t count)
         *
         * At most `count` bytes of the source and a terminator: ERANGE when
         * they do not fit, what fit left after a zeroed first byte.
         *
         * @param {number[]} args
         */
        _mbsnbcpy_s: ([destination, size, source, count])=>{
            const room = size >>> 0;
            if ((destination >>> 0) === 0 || room === 0)
            {
                return invalid(EINVAL);
            }
            if ((source >>> 0) === 0)
            {
                setU8(destination, 0);
                return invalid(EINVAL);
            }
            let length = 0;
            while (length < (count >>> 0) && u8(source + length) !== 0)
            {
                length++;
            }
            const kept = Math.min(length, room);
            host.writeMemory(destination, host.readMemory(source, kept).slice());
            if (length + 1 > room)
            {
                setU8(destination, 0);
                host.errno?.(ERANGE);
                return ERANGE;
            }
            setU8(destination + length, 0);
            return 0;
        },

        /**
         * errno_t _mbsnbcat_s(unsigned char *dest, size_t size, const unsigned char *src,
         *                     size_t count)
         *
         * strncat_s by bytes: nothing at all to do is 0; no source, or no
         * terminator within `size`, is EINVAL; what does not fit is ERANGE,
         * what fit appended after a zeroed first byte.
         *
         * @param {number[]} args
         */
        _mbsnbcat_s: ([destination, size, source, count])=>{
            const room = size >>> 0;
            if ((destination >>> 0) === 0 && room === 0 && (count >>> 0) === 0)
            {
                return 0;
            }
            if ((destination >>> 0) === 0 || room === 0)
            {
                return invalid(EINVAL);
            }
            if ((source >>> 0) === 0)
            {
                setU8(destination, 0);
                return invalid(EINVAL);
            }
            let end = 0;
            while (end < room && u8(destination + end) !== 0)
            {
                end++;
            }
            if (end === room)
            {
                setU8(destination, 0);
                return invalid(EINVAL);
            }
            let length = 0;
            while (length < (count >>> 0) && u8(source + length) !== 0)
            {
                length++;
            }
            const kept = Math.min(length, room - end);
            host.writeMemory(destination + end, host.readMemory(source, kept).slice());
            if (end + length + 1 > room)
            {
                setU8(destination, 0);
                host.errno?.(ERANGE);
                return ERANGE;
            }
            setU8(destination + end + length, 0);
            return 0;
        },

        /**
         * errno_t _mbsupr_s(unsigned char *string, size_t size) and _mbslwr_s:
         * _mbsupr and _mbslwr within `size`; nothing at all is 0, no string or
         * no terminator within the size EINVAL.
         *
         * @param {number[]} args
         */
        _mbsupr_s: ([string, size])=>secureCase(string, size, 1),
        /** @param {number[]} args */
        _mbslwr_s: ([string, size])=>secureCase(string, size, 0),
    };
}
