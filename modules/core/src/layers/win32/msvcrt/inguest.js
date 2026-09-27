/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime functions that run in the guest, written once: each `@guestCode`
 * function here is compiled by the build (`scripts/guest-code/compile.mjs`)
 * into the i386 of `inguest.x86.js`, which the export's slot carries, and is
 * itself the export's handler and the reference the x86 is tested against.
 * What the subset allows, and why, is written at the compiler.
 *
 * Each keeps the answers of the handler it replaced, under the C locale:
 * ASCII case, comparisons normalised to -1, 0 and 1, bytes ordered as the
 * handlers ordered the strings they decoded (`ORDER`).
 */

import { decodeAnsi } from '../kernel32/locale.js';

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').i32} i32 */
/** @typedef {import('./guest-code.js').u32} u32 */
/** @typedef {import('./guest-code.js').f64} f64 */
/** @typedef {import('./guest-code.js').x87} x87 */
/** @typedef {import('./guest-code.js').i64} i64 */

/**
 * The order the comparisons put bytes in: each byte's character in the ANSI
 * page, as the handlers that compared decoded strings had it -- a byte's own
 * value, but for the sixteen of 0x80..0x9f that Windows-1252 gives characters
 * above 0xff (0x80 the euro sign sorts after every other byte).
 */
export const ORDER = Uint16Array.from({ length: 256 },
    (_, byte)=>decodeAnsi(Uint8Array.of(byte)).charCodeAt(0));

/** Each byte uppercased in the C locale: ASCII letters, and nothing else. */
export const UPPER = Uint8Array.from({ length: 256 },
    (_, code)=>(code >= 0x61 && code <= 0x7a ? code - 0x20 : code));

/** Each byte lowercased in the C locale. */
export const LOWER = Uint8Array.from({ length: 256 },
    (_, code)=>(code >= 0x41 && code <= 0x5a ? code + 0x20 : code));

/**
 * The classes of the classifiers, one bit each: the narrow family's bytes
 * (`CLASSES`) and the wide family's units below 0x100 (`WIDE_CLASSES`). They
 * mark membership and nothing else -- the bits a program passes to
 * `_isctype` or `iswctype` are msvcrt's own, and those functions translate.
 */
export const W_ALPHA = 0x001;
export const W_DIGIT = 0x002;
export const W_UPPER = 0x004;
export const W_LOWER = 0x008;
export const W_SPACE = 0x010;
export const W_PUNCT = 0x020;
export const W_CNTRL = 0x040;
export const W_PRINT = 0x080;
export const W_GRAPH = 0x100;
export const W_XDIGIT = 0x200;

/** WEOF: the value no code unit is, and the one every wide classifier answers nothing for. */
export const WEOF = 0xffff;

/**
 * The C locale's classes of each byte: ASCII's, and nothing above 0x7f.
 * Written as the patterns a byte's own character is tested against, where
 * one reads more clearly than a range.
 */
export const CLASSES = Uint16Array.from({ length: 256 }, (_, code)=>{
    const char = String.fromCharCode(code);
    return (/[A-Za-z]/.test(char) ? W_ALPHA : 0)
        | (/[0-9]/.test(char) ? W_DIGIT : 0)
        | (/[A-Z]/.test(char) ? W_UPPER : 0)
        | (/[a-z]/.test(char) ? W_LOWER : 0)
        | (/[ \t\n\v\f\r]/.test(char) ? W_SPACE : 0)
        | (/[!-/:-@[-`{-~]/.test(char) ? W_PUNCT : 0)
        // A range rather than a pattern: a control character in a regular
        // expression is the kind of thing that survives a copy-paste and then
        // does not.
        | (code < 0x20 || code === 0x7f ? W_CNTRL : 0)
        | (/[ -~]/.test(char) ? W_PRINT : 0)
        | (/[0-9A-Fa-f]/.test(char) ? W_XDIGIT : 0);
});

/**
 * The wide classes of the units below 0x100, which above 0x7f are not empty
 * in the C locale, as a real Windows answers through iswctype: the Latin-1
 * letters are alpha -- both signs except the multiplication and division
 * signs that sit among them and are not letters -- and there are two spaces
 * the ASCII list does not carry, NEL at 0x85 and the no-break space at 0xa0.
 * Case stays ASCII's, so those letters are alpha with no upper or lower of
 * their own, and a unit past 0xff -- a CJK unit, WEOF -- is nothing at all.
 */
export const WIDE_CLASSES = Uint16Array.from(CLASSES, (narrow, code)=>{
    let classes = narrow;
    if ((classes & W_PRINT) !== 0 && (classes & W_SPACE) === 0)
    {
        classes |= W_GRAPH;
    }
    if (code >= 0xc0 && code <= 0xff && code !== 0xd7 && code !== 0xf7)
    {
        classes |= W_ALPHA;
    }
    if (code === 0x85 || code === 0xa0)
    {
        classes |= W_SPACE;
    }
    return classes;
});

/** 1 for a byte of one of the classes, 0 for anything else, EOF and values past a byte included. */
const inClass = (/** @type {u32} */ c, /** @type {number} */ classes)=>
    (c < 256 && (CLASSES[c] & classes) !== 0 ? 1 : 0);

/** The same for a wide character: its low sixteen bits, a unit past 0xff in none. */
const inWideClass = (/** @type {u32} */ c, /** @type {number} */ classes)=>
    ((c & 0xffff) < 256 && (WIDE_CLASSES[c & 0xffff] & classes) !== 0 ? 1 : 0);

/**
 * double floor(double x)
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function floor(x){
    return Math.floor(x);
}

/**
 * int toupper(int c)
 *
 * A value outside a byte comes back as it went in, EOF included.
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {u32}
 */
export function toupper(c){
    return c < 256 ? UPPER[c] : c;
}

/**
 * int strncmp(const char *left, const char *right, size_t count)
 *
 * No further than either terminator, and no further than `count`.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 * @returns {i32}
 */
export function strncmp({ u8 }, left, right, count){
    for (/** @type {u32} */ let i = 0; i < count; i++)
    {
        const a = u8(left + i);
        const b = u8(right + i);
        if (a !== b)
        {
            return ORDER[a] < ORDER[b] ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
    return 0;
}

/**
 * __int64 _ftol(double value), and `_ftol2` and `_ftol2_sse` with it
 *
 * The cast every `(int)` in compiled C goes through: the value the caller
 * left in ST0, popped, truncated toward zero into EDX:EAX -- the integer
 * indefinite for NaN and out of range, as `fisttp` stores it.
 *
 * @guestCode cdecl
 * @param {x87} value
 * @returns {i64}
 */
export function _ftol(value){
    return value;
}

/**
 * void qsort(void *base, size_t num, size_t width,
 *            int (*compare)(const void *, const void *))
 *
 * Shell's sort with the gaps halved, in place: the elements are swapped in
 * the program's memory as they move, so the comparator is always handed the
 * real addresses of the array as it stands. The order of equal elements is
 * not kept -- the standard promises none, and msvcrt's own sort keeps none.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} base @param {u32} num @param {u32} width
 * @param {u32} compare
 */
export function qsort({ u8, setU8, call }, base, num, width, compare){
    if (width === 0)
    {
        return;
    }
    for (let gap = num >>> 1; gap !== 0; gap = gap >>> 1)
    {
        for (let i = gap; i < num; i++)
        {
            for (let j = i; j >= gap; j -= gap)
            {
                const a = (base + Math.imul(j - gap, width)) >>> 0;
                const b = (base + Math.imul(j, width)) >>> 0;
                if (call(compare, a, b) <= 0)
                {
                    break;
                }
                for (/** @type {u32} */ let k = 0; k < width; k++)
                {
                    const kept = u8(a + k);
                    setU8(a + k, u8(b + k));
                    setU8(b + k, kept);
                }
            }
        }
    }
}

/**
 * int tolower(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {u32}
 */
export function tolower(c){
    return c < 256 ? LOWER[c] : c;
}

/**
 * int _strnicmp(const char *left, const char *right, size_t count)
 *
 * strncmp with the ASCII letters folded to lower case first.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 * @returns {i32}
 */
export function _strnicmp({ u8 }, left, right, count){
    for (/** @type {u32} */ let i = 0; i < count; i++)
    {
        const a = LOWER[u8(left + i)];
        const b = LOWER[u8(right + i)];
        if (a !== b)
        {
            return ORDER[a] < ORDER[b] ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
    return 0;
}

/**
 * int _stricmp(const char *left, const char *right)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right
 * @returns {i32}
 */
export function _stricmp({ u8 }, left, right){
    for (/** @type {u32} */ let i = 0; ; i++)
    {
        const a = LOWER[u8(left + i)];
        const b = LOWER[u8(right + i)];
        if (a !== b)
        {
            return ORDER[a] < ORDER[b] ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
}

/**
 * int isalpha(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function isalpha(c){
    return inClass(c, W_ALPHA);
}

/**
 * int isdigit(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function isdigit(c){
    return inClass(c, W_DIGIT);
}

/**
 * int isalnum(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function isalnum(c){
    return inClass(c, W_ALPHA | W_DIGIT);
}

/**
 * int isspace(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function isspace(c){
    return inClass(c, W_SPACE);
}

/**
 * int isupper(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function isupper(c){
    return inClass(c, W_UPPER);
}

/**
 * int islower(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function islower(c){
    return inClass(c, W_LOWER);
}

/**
 * int ispunct(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function ispunct(c){
    return inClass(c, W_PUNCT);
}

/**
 * int isxdigit(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function isxdigit(c){
    return inClass(c, W_XDIGIT);
}

/**
 * int isprint(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function isprint(c){
    return inClass(c, W_PRINT);
}

/**
 * int iscntrl(int c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iscntrl(c){
    return inClass(c, W_CNTRL);
}

/**
 * int iswalpha(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswalpha(c){
    return inWideClass(c, W_ALPHA);
}

/**
 * int iswdigit(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswdigit(c){
    return inWideClass(c, W_DIGIT);
}

/**
 * int iswalnum(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswalnum(c){
    return inWideClass(c, W_ALPHA | W_DIGIT);
}

/**
 * int iswspace(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswspace(c){
    return inWideClass(c, W_SPACE);
}

/**
 * int iswupper(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswupper(c){
    return inWideClass(c, W_UPPER);
}

/**
 * int iswlower(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswlower(c){
    return inWideClass(c, W_LOWER);
}

/**
 * int iswpunct(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswpunct(c){
    return inWideClass(c, W_PUNCT);
}

/**
 * int iswxdigit(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswxdigit(c){
    return inWideClass(c, W_XDIGIT);
}

/**
 * int iswcntrl(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswcntrl(c){
    return inWideClass(c, W_CNTRL);
}

/**
 * int iswprint(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswprint(c){
    return inWideClass(c, W_PRINT);
}

/**
 * int iswgraph(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswgraph(c){
    return inWideClass(c, W_GRAPH);
}

/**
 * int iswascii(wint_t c) -- the range, not a class the table carries
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function iswascii(c){
    return (c & 0xffff) < 0x80 ? 1 : 0;
}

/**
 * wint_t towupper(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function towupper(c){
    const unit = c & 0xffff;
    if (unit === WEOF)
    {
        return 0;
    }
    return unit < 256 ? UPPER[unit] : unit;
}

/**
 * wint_t towlower(wint_t c)
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function towlower(c){
    const unit = c & 0xffff;
    if (unit === WEOF)
    {
        return 0;
    }
    return unit < 256 ? LOWER[unit] : unit;
}

/**
 * int atoi(const char *text), and atol, the same function on a 32-bit target
 *
 * White space, a sign, and as many decimal digits as there are; nothing
 * converted is zero. C leaves overflow undefined; this runtime clamps, and a
 * clamped value is at least ordered the way the digits were.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {i32}
 */
export function atoi({ u8 }, text){
    let at = text;
    let c = u8(at);
    while (c === 0x20 || c >= 0x09 && c <= 0x0d)
    {
        at++;
        c = u8(at);
    }
    let negative = 0;
    if (c === 0x2d || c === 0x2b)
    {
        negative = c === 0x2d ? 1 : 0;
        at++;
        c = u8(at);
    }
    // The magnitude, held at 2^31 once past it: a longer run of digits clamps alike.
    /** @type {u32} */
    let magnitude = 0;
    while (c >= 0x30 && c <= 0x39)
    {
        magnitude = magnitude > 214748364 ? 0x80000000 : (magnitude * 10 + c - 0x30) >>> 0;
        if (magnitude > 0x80000000)
        {
            magnitude = 0x80000000;
        }
        at++;
        c = u8(at);
    }
    if (negative !== 0)
    {
        return magnitude >= 0x80000000 ? -0x80000000 : (0 - magnitude) | 0;
    }
    return magnitude >= 0x7fffffff ? 0x7fffffff : magnitude | 0;
}

/**
 * void *bsearch(const void *key, const void *base, size_t num, size_t width,
 *               int (*compare)(const void *, const void *))
 *
 * The key is the comparator's first argument, which is the order a caller's
 * comparator was written for and the reason one shared with qsort is often
 * subtly wrong here.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} key @param {u32} base @param {u32} num @param {u32} width
 * @param {u32} compare
 * @returns {u32}
 */
export function bsearch({ call }, key, base, num, width, compare){
    let low = 0;
    let high = (num - 1) | 0;
    while (low <= high)
    {
        const middle = (low + high) >> 1;
        const element = (base + Math.imul(middle, width)) >>> 0;
        const order = call(compare, key, element);
        if (order === 0)
        {
            return element;
        }
        if (order < 0)
        {
            high = (middle - 1) | 0;
        }
        else
        {
            low = (middle + 1) | 0;
        }
    }
    return 0;
}
