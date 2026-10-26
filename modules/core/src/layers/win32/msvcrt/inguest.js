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
 * Each answers under the C locale as msvcrt.dll does, where its comment says
 * no otherwise: ASCII case, bytes compared as unsigned chars. A comparison
 * answers -1, 0 or 1, as the handlers it replaced did -- C promises only the
 * sign -- but strncmp, which in 32-bit msvcrt.dll answers the difference of
 * the first two bytes that differ.
 */

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').i32} i32 */
/** @typedef {import('./guest-code.js').u32} u32 */
/** @typedef {import('./guest-code.js').f64} f64 */
/** @typedef {import('./guest-code.js').x87} x87 */
/** @typedef {import('./guest-code.js').i64} i64 */

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
 * Print and graph are the narrow table's; the wide one has the blank class
 * instead, which msvcrt's iswprint asks for.
 */
export const W_ALPHA = 0x001;
export const W_DIGIT = 0x002;
export const W_UPPER = 0x004;
export const W_LOWER = 0x008;
export const W_SPACE = 0x010;
export const W_PUNCT = 0x020;
export const W_CNTRL = 0x040;
export const W_PRINT = 0x080;
export const W_XDIGIT = 0x200;
export const W_BLANK = 0x400;

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
 * The wide classes of the units below 0x100, as msvcrt.dll answers them: from
 * a table of its own, the same in every locale, where only a unit past 0xff
 * is asked of the system (`GetStringTypeW`).
 *
 * - The C0 and C1 controls and DEL are control characters; tab to carriage
 *   return are spaces as well, and tab is blank.
 * - The space and the no-break space are space and blank.
 * - The rest of ASCII is classed as the narrow family classes it.
 * - The signs of 0xa1..0xbf are punctuation, whatever their Unicode
 *   category -- the ordinal indicators and the micro sign among them, which
 *   are letters there -- and the superscript one, two and three, the three
 *   whose compatibility form is a decimal digit, are digits as well.
 * - 0xc0..0xff are letters, upper or lower by their Unicode category, but for
 *   the multiplication and division signs (Sm) that sit among them.
 *
 * Case is classed but not mapped: the C locale's towupper and towlower map
 * ASCII alone. A unit past 0xff -- a CJK unit, WEOF -- is nothing at all
 * here.
 */
export const WIDE_CLASSES = Uint16Array.from({ length: 256 }, (_, code)=>{
    const char = String.fromCharCode(code);
    if (code < 0x80)
    {
        const classes = CLASSES[code] & ~W_PRINT;
        return code === 0x09 || code === 0x20 ? classes | W_BLANK : classes;
    }
    if (code < 0xa0)
    {
        return W_CNTRL;
    }
    if (code === 0xa0)
    {
        return W_SPACE | W_BLANK;
    }
    if (code < 0xc0)
    {
        return W_PUNCT | (/^[0-9]$/.test(char.normalize('NFKC')) ? W_DIGIT : 0);
    }
    return /\p{Lu}/u.test(char) ? W_ALPHA | W_UPPER
        : /\p{Ll}/u.test(char) ? W_ALPHA | W_LOWER : W_PUNCT;
});

/**
 * msvcrt's own class bits, the ones `iswctype` takes and the wide classifiers
 * answer with: GetStringTypeW's C1 bits, and `_ALPHA` the letter bit 0x100
 * with the two cases.
 */
export const CT_UPPER = 0x0001;
export const CT_LOWER = 0x0002;
export const CT_DIGIT = 0x0004;
export const CT_SPACE = 0x0008;
export const CT_PUNCT = 0x0010;
export const CT_CONTROL = 0x0020;
export const CT_BLANK = 0x0040;
export const CT_HEX = 0x0080;
export const CT_LETTER = 0x0100;
export const CT_ALPHA = CT_LETTER | CT_UPPER | CT_LOWER;

/**
 * `WIDE_CLASSES` in msvcrt's bits: what `_pwctype` holds for each unit below
 * 0x100, a letter's bit with its case's.
 */
export const WIDE_CTYPE = Uint16Array.from(WIDE_CLASSES, classes=>
    (classes & W_UPPER ? CT_UPPER : 0) | (classes & W_LOWER ? CT_LOWER : 0)
    | (classes & W_DIGIT ? CT_DIGIT : 0) | (classes & W_SPACE ? CT_SPACE : 0)
    | (classes & W_PUNCT ? CT_PUNCT : 0) | (classes & W_CNTRL ? CT_CONTROL : 0)
    | (classes & W_BLANK ? CT_BLANK : 0) | (classes & W_XDIGIT ? CT_HEX : 0)
    | (classes & W_ALPHA ? CT_LETTER : 0));

/** 1 for a byte of one of the classes, 0 for anything else, EOF and values past a byte included. */
const inClass = (/** @type {u32} */ c, /** @type {number} */ classes)=>
    (c < 256 && (CLASSES[c] & classes) !== 0 ? 1 : 0);


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
 * No further than either terminator, and no further than `count`; the
 * difference of the first two bytes that differ.
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
            return (a - b) | 0;
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
            return a < b ? -1 : 1;
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
            return a < b ? -1 : 1;
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
 * int isgraph(int c) -- printable but not the space: a letter, a digit or
 * punctuation.
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function isgraph(c){
    return inClass(c, W_ALPHA | W_DIGIT | W_PUNCT);
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
 * The wide classifiers answer msvcrt's bits of the class they ask for, as
 * `iswctype` does -- `iswdigit('0')` is `_DIGIT`, 4, and `iswalpha('a')`
 * `_LOWER | 0x100` -- from the table for a unit below 0x100; the host
 * classifies one past it (`wideClassOf`).
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswalpha({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_ALPHA);
}

/**
 * int iswdigit(wint_t c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswdigit({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_DIGIT);
}

/**
 * int iswalnum(wint_t c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswalnum({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_ALPHA | CT_DIGIT);
}

/**
 * int iswspace(wint_t c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswspace({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_SPACE);
}

/**
 * int iswupper(wint_t c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswupper({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_UPPER);
}

/**
 * int iswlower(wint_t c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswlower({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_LOWER);
}

/**
 * int iswpunct(wint_t c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswpunct({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_PUNCT);
}

/**
 * int iswxdigit(wint_t c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswxdigit({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_HEX);
}

/**
 * int iswcntrl(wint_t c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswcntrl({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_CONTROL);
}

/**
 * int iswprint(wint_t c)
 *
 * The blank, punctuation, letters and digits, as msvcrt's own asks
 * `iswctype`: a tab is printable here, where `isprint`'s is not.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswprint({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_BLANK | CT_PUNCT | CT_ALPHA | CT_DIGIT);
}

/**
 * int iswgraph(wint_t c)
 *
 * iswprint without the blanks.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function iswgraph({ host }, c){
    if ((c & 0xffff) >= 256)
    {
        return host();
    }
    return WIDE_CTYPE[c & 0xffff] & (CT_PUNCT | CT_ALPHA | CT_DIGIT);
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
 * ASCII's letters, and every other unit as it came -- WEOF included.
 *
 * @guestCode cdecl
 * @param {u32} c
 * @returns {i32}
 */
export function towupper(c){
    const unit = c & 0xffff;
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
    return unit < 256 ? LOWER[unit] : unit;
}

/**
 * int atoi(const char *text), and atol, the same function on a 32-bit target
 *
 * White space, a sign, and as many decimal digits as there are; nothing
 * converted is zero. C leaves overflow undefined, and msvcrt.dll's wraps:
 * each digit is ten times the total so far plus the digit, in 32 bits, and a
 * minus sign negates the total at the end -- "4294967296" is 0. (The later
 * runtimes clamp, and set errno; this one does neither.)
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
    /** @type {i32} */
    let total = 0;
    while (c >= 0x30 && c <= 0x39)
    {
        total = (Math.imul(total, 10) + c - 0x30) | 0;
        at++;
        c = u8(at);
    }
    return negative !== 0 ? (0 - total) | 0 : total;
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

/**
 * void *memmove(void *destination, const void *source, size_t count), and
 * memcpy, which is the same function here
 *
 * As if the source were read whole before a byte of it was written: a
 * destination above the source and inside it is copied from the last byte
 * down, anything else from the first up -- a dword at a time where that
 * leaves the same bytes.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} destination @param {u32} source @param {u32} count
 * @returns {u32}
 */
export function memmove({ copyUp, copyDown }, destination, source, count){
    if ((destination - source) >>> 0 < count)
    {
        copyDown(destination, source, count);
    }
    else
    {
        copyUp(destination, source, count);
    }
    return destination;
}

/**
 * void *memset(void *destination, int value, size_t count)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} destination @param {u32} value @param {u32} count
 * @returns {u32}
 */
export function memset({ fill }, destination, value, count){
    fill(destination, value, count);
    return destination;
}

/**
 * int memcmp(const void *left, const void *right, size_t count)
 *
 * The bytes as unsigned values, the answer -1, 0 or 1. Four at a time while
 * they match, and never past the count: the first difference is in the
 * first four that differ.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 * @returns {i32}
 */
export function memcmp({ u8, u32 }, left, right, count){
    /** @type {u32} */
    let i = 0;
    while ((count - i) >>> 0 >= 4 && u32(left + i) === u32(right + i))
    {
        i += 4;
    }
    for (; i < count; i++)
    {
        const a = u8(left + i);
        const b = u8(right + i);
        if (a !== b)
        {
            return a < b ? -1 : 1;
        }
    }
    return 0;
}

/**
 * size_t strlen(const char *text)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {u32}
 */
export function strlen({ u8 }, text){
    /** @type {u32} */
    let length = 0;
    while (u8(text + length) !== 0)
    {
        length++;
    }
    return length;
}

/**
 * char *strcpy(char *destination, const char *source)
 *
 * The source and its terminator, as if read whole first, the way memmove
 * copies: C leaves an overlap undefined, and the handler this replaced read
 * the string before it wrote.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} destination @param {u32} source
 * @returns {u32}
 */
export function strcpy({ u8, copyUp, copyDown }, destination, source){
    /** @type {u32} */
    let length = 1;
    while (u8(source + length - 1) !== 0)
    {
        length++;
    }
    if ((destination - source) >>> 0 < length)
    {
        copyDown(destination, source, length);
    }
    else
    {
        copyUp(destination, source, length);
    }
    return destination;
}

/**
 * int strcmp(const char *left, const char *right)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right
 * @returns {i32}
 */
export function strcmp({ u8 }, left, right){
    for (/** @type {u32} */ let i = 0; ; i++)
    {
        const a = u8(left + i);
        const b = u8(right + i);
        if (a !== b)
        {
            return a < b ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
}

/** Each byte's value as a digit: 0-9, then a letter of either case from ten; 255 for any other. */
export const DIGITS = Uint8Array.from({ length: 256 }, (_, code)=>{
    if (code >= 0x30 && code <= 0x39)
    {
        return code - 0x30;
    }
    if (code >= 0x61 && code <= 0x7a)
    {
        return code - 0x61 + 10;
    }
    return code >= 0x41 && code <= 0x5a ? code - 0x41 + 10 : 255;
});

/**
 * The largest magnitude that takes another digit in each base from 2 to 36
 * with no fear of passing 32 bits: 2^32 - 1 over the base. Past it, or when
 * the digit carries out, the magnitude is more than 32 bits hold.
 */
export const BELOW_CARRY = Uint32Array.from({ length: 37 },
    (_, base)=>(base < 2 ? 0 : Math.floor(0xffffffff / base)));

/**
 * long strtol(const char *text, char **end, int base)
 *
 * White space, a sign, `0x` or `0X` in base 16 or 0 (a leading 0 is octal in
 * base 0), and the digits of the base, each letter of either case from ten;
 * `*end` set to where the digits stopped, or to the text itself when none
 * converted. A value out of range is the host's: it clamps and sets errno,
 * which is the calling thread's own; so is a base outside 2..36 other than 0,
 * which the handler reads as it reads any other. Neither case writes before
 * it goes, so the host answers the call as it came.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} end @param {i32} base
 * @returns {i32}
 */
export function strtol({ u8, setU32, host }, text, end, base){
    if (base !== 0 && (base < 2 || base > 36))
    {
        return host();
    }
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
    let radix = base;
    if ((radix === 0 || radix === 16) && c === 0x30 && (u8(at + 1) | 0x20) === 0x78)
    {
        radix = 16;
        at += 2;
        c = u8(at);
    }
    else if (radix === 0)
    {
        radix = c === 0x30 ? 8 : 10;
    }
    const start = at;
    const most = BELOW_CARRY[radix];
    /** @type {u32} */
    let magnitude = 0;
    let digit = DIGITS[c];
    while (digit < radix)
    {
        if (magnitude > most)
        {
            return host();
        }
        const product = Math.imul(magnitude, radix) >>> 0;
        magnitude = (product + digit) >>> 0;
        if (magnitude < product)
        {
            return host();
        }
        at++;
        digit = DIGITS[u8(at)];
    }
    if (at === start)
    {
        if (end !== 0)
        {
            setU32(end, text);
        }
        return 0;
    }
    if (magnitude > (negative !== 0 ? 0x80000000 : 0x7fffffff))
    {
        return host();
    }
    if (end !== 0)
    {
        setU32(end, at);
    }
    return negative !== 0 ? (0 - magnitude) | 0 : magnitude | 0;
}

/**
 * unsigned long strtoul(const char *text, char **end, int base)
 *
 * As strtol reads, and a minus sign negates the magnitude within 32 bits:
 * strtoul("-1") is ULONG_MAX. A magnitude past 32 bits is the host's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} end @param {i32} base
 * @returns {u32}
 */
export function strtoul({ u8, setU32, host }, text, end, base){
    if (base !== 0 && (base < 2 || base > 36))
    {
        return host();
    }
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
    let radix = base;
    if ((radix === 0 || radix === 16) && c === 0x30 && (u8(at + 1) | 0x20) === 0x78)
    {
        radix = 16;
        at += 2;
        c = u8(at);
    }
    else if (radix === 0)
    {
        radix = c === 0x30 ? 8 : 10;
    }
    const start = at;
    const most = BELOW_CARRY[radix];
    /** @type {u32} */
    let magnitude = 0;
    let digit = DIGITS[c];
    while (digit < radix)
    {
        if (magnitude > most)
        {
            return host();
        }
        const product = Math.imul(magnitude, radix) >>> 0;
        magnitude = (product + digit) >>> 0;
        if (magnitude < product)
        {
            return host();
        }
        at++;
        digit = DIGITS[u8(at)];
    }
    if (at === start)
    {
        if (end !== 0)
        {
            setU32(end, text);
        }
        return 0;
    }
    if (end !== 0)
    {
        setU32(end, at);
    }
    return negative !== 0 ? (0 - magnitude) >>> 0 : magnitude;
}

/**
 * int abs(int value), and labs, the same function on a 32-bit target
 *
 * INT_MIN, which has no positive counterpart, comes back as itself.
 *
 * @guestCode cdecl
 * @param {i32} value
 * @returns {i32}
 */
export function abs(value){
    return value < 0 ? (0 - value) | 0 : value;
}

/**
 * double ceil(double x)
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function ceil(x){
    return Math.ceil(x);
}

/**
 * double fabs(double x)
 *
 * @guestCode cdecl
 * @param {f64} x
 * @returns {f64}
 */
export function fabs(x){
    return Math.abs(x);
}

/**
 * char *strchr(const char *text, int c)
 *
 * The first byte that is `c`'s low byte, the terminator among them: a search
 * for 0 finds the string's end.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} c
 * @returns {u32}
 */
export function strchr({ u8 }, text, c){
    const wanted = c & 0xff;
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const byte = u8(at);
        if (byte === wanted)
        {
            return at;
        }
        if (byte === 0)
        {
            return 0;
        }
    }
}

/**
 * char *strrchr(const char *text, int c)
 *
 * The last byte that is `c`'s low byte, the terminator among them.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} c
 * @returns {u32}
 */
export function strrchr({ u8 }, text, c){
    const wanted = c & 0xff;
    /** @type {u32} */
    let found = 0;
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const byte = u8(at);
        if (byte === wanted)
        {
            found = at;
        }
        if (byte === 0)
        {
            return found;
        }
    }
}

/**
 * char *strstr(const char *haystack, const char *needle)
 *
 * The first place the needle's bytes stand in the haystack, the haystack
 * itself for an empty needle, and null for none.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} haystack @param {u32} needle
 * @returns {u32}
 */
export function strstr({ u8 }, haystack, needle){
    for (/** @type {u32} */ let at = haystack; ; at++)
    {
        /** @type {u32} */
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
}

/**
 * char *strcat(char *destination, const char *source)
 *
 * The source and its terminator after the destination's text, as strcpy
 * copies: as if read whole first.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} destination @param {u32} source
 * @returns {u32}
 */
export function strcat({ u8, copyUp, copyDown }, destination, source){
    /** @type {u32} */
    let end = destination;
    while (u8(end) !== 0)
    {
        end++;
    }
    /** @type {u32} */
    let length = 1;
    while (u8(source + length - 1) !== 0)
    {
        length++;
    }
    if ((end - source) >>> 0 < length)
    {
        copyDown(end, source, length);
    }
    else
    {
        copyUp(end, source, length);
    }
    return destination;
}

/**
 * char *strncpy(char *destination, const char *source, size_t count)
 *
 * No more than `count` bytes of the source, as if read whole first, and the
 * rest of the `count` zeros: a source as long as the count or longer leaves
 * no terminator.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} destination @param {u32} source @param {u32} count
 * @returns {u32}
 */
export function strncpy({ u8, copyUp, copyDown, fill }, destination, source, count){
    /** @type {u32} */
    let length = 0;
    while (length < count && u8(source + length) !== 0)
    {
        length++;
    }
    if ((destination - source) >>> 0 < length)
    {
        copyDown(destination, source, length);
    }
    else
    {
        copyUp(destination, source, length);
    }
    fill(destination + length, 0, count - length);
    return destination;
}

/**
 * char *_strlwr(char *text)
 *
 * In place, the ASCII capitals only, as the C locale has it.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {u32}
 */
export function _strlwr({ u8, setU8 }, text){
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const c = u8(at);
        if (c === 0)
        {
            return text;
        }
        if (c >= 0x41 && c <= 0x5a)
        {
            setU8(at, c + 0x20);
        }
    }
}

/**
 * char *_strupr(char *text)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {u32}
 */
export function _strupr({ u8, setU8 }, text){
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const c = u8(at);
        if (c === 0)
        {
            return text;
        }
        if (c >= 0x61 && c <= 0x7a)
        {
            setU8(at, c - 0x20);
        }
    }
}

/**
 * size_t wcslen(const wchar_t *text)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {u32}
 */
export function wcslen({ u16 }, text){
    /** @type {u32} */
    let length = 0;
    while (u16(text + length * 2) !== 0)
    {
        length++;
    }
    return length;
}

/**
 * int wcscmp(const wchar_t *left, const wchar_t *right)
 *
 * By unit, as unsigned sixteen-bit values, the answer -1, 0 or 1.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right
 * @returns {i32}
 */
export function wcscmp({ u16 }, left, right){
    for (/** @type {u32} */ let i = 0; ; i += 2)
    {
        const a = u16(left + i);
        const b = u16(right + i);
        if (a !== b)
        {
            return a < b ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
}

/**
 * wchar_t *wcscpy(wchar_t *destination, const wchar_t *source)
 *
 * The source and its terminator, as if read whole first.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} destination @param {u32} source
 * @returns {u32}
 */
export function wcscpy({ u16, copyUp, copyDown }, destination, source){
    /** @type {u32} */
    let length = 2;
    while (u16(source + length - 2) !== 0)
    {
        length += 2;
    }
    if ((destination - source) >>> 0 < length)
    {
        copyDown(destination, source, length);
    }
    else
    {
        copyUp(destination, source, length);
    }
    return destination;
}

/*
 * The multibyte family, under the code page `_setmbcp` selects. No byte below
 * 0x80 leads in any page, so a string that is ASCII as far as the answer is a
 * byte a character whatever the page, and each of these answers it here; at
 * the first byte past 0x7f -- or for a character past it -- the call is the
 * host's (`mbcs.js`), which reads the string by the page. Under a single-byte
 * page each answers as its byte twin does.
 */

/**
 * size_t _mbslen(const unsigned char *text)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {u32}
 */
export function _mbslen({ u8, host }, text){
    for (/** @type {u32} */ let length = 0; ; length++)
    {
        const c = u8(text + length);
        if (c === 0)
        {
            return length;
        }
        if (c >= 0x80)
        {
            return host();
        }
    }
}

/**
 * size_t _mbclen(const unsigned char *at)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} at
 * @returns {u32}
 */
export function _mbclen({ u8, host }, at){
    if (u8(at) >= 0x80)
    {
        return host();
    }
    return 1;
}

/**
 * unsigned char *_mbsinc(const unsigned char *at)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} at
 * @returns {u32}
 */
export function _mbsinc({ u8, host }, at){
    if (u8(at) >= 0x80)
    {
        return host();
    }
    return (at + 1) >>> 0;
}

/**
 * unsigned char *_mbsdec(const unsigned char *start, const unsigned char *at)
 *
 * The character before `at`: the byte before it when the byte before that
 * cannot lead, or is not in the string; null at the start.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} start @param {u32} at
 * @returns {u32}
 */
export function _mbsdec({ u8, host }, start, at){
    if (at <= start)
    {
        return 0;
    }
    const before = (at - 1) >>> 0;
    if (before > start && u8(before - 1) >= 0x80)
    {
        return host();
    }
    return before;
}

/**
 * int _ismbblead(unsigned int c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} c
 * @returns {i32}
 */
export function _ismbblead({ host }, c){
    if ((c & 0xff) >= 0x80)
    {
        return host();
    }
    return 0;
}

/**
 * unsigned char *_mbschr(const unsigned char *text, unsigned int c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} c
 * @returns {u32}
 */
export function _mbschr({ u8, host }, text, c){
    if (c > 0x7f)
    {
        return host();
    }
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const byte = u8(at);
        if (byte >= 0x80)
        {
            return host();
        }
        if (byte === c)
        {
            return at;
        }
        if (byte === 0)
        {
            return 0;
        }
    }
}

/**
 * unsigned char *_mbsrchr(const unsigned char *text, unsigned int c)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} c
 * @returns {u32}
 */
export function _mbsrchr({ u8, host }, text, c){
    if (c > 0x7f)
    {
        return host();
    }
    /** @type {u32} */
    let found = 0;
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const byte = u8(at);
        if (byte >= 0x80)
        {
            return host();
        }
        if (byte === c)
        {
            found = at;
        }
        if (byte === 0)
        {
            return found;
        }
    }
}

/**
 * unsigned char *_mbsstr(const unsigned char *haystack, const unsigned char *needle)
 *
 * A match is looked for at each character of the haystack, so one with a
 * byte past 0x7f before the answer is the host's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} haystack @param {u32} needle
 * @returns {u32}
 */
export function _mbsstr({ u8, host }, haystack, needle){
    for (/** @type {u32} */ let at = haystack; ; at++)
    {
        if (u8(at) >= 0x80)
        {
            return host();
        }
        /** @type {u32} */
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
}

/**
 * int _mbscmp(const unsigned char *left, const unsigned char *right)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right
 * @returns {i32}
 */
export function _mbscmp({ u8, host }, left, right){
    for (/** @type {u32} */ let i = 0; ; i++)
    {
        const a = u8(left + i);
        const b = u8(right + i);
        if (a >= 0x80 || b >= 0x80)
        {
            return host();
        }
        if (a !== b)
        {
            return a < b ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
}

/**
 * int _mbsicmp(const unsigned char *left, const unsigned char *right)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right
 * @returns {i32}
 */
export function _mbsicmp({ u8, host }, left, right){
    for (/** @type {u32} */ let i = 0; ; i++)
    {
        const a = u8(left + i);
        const b = u8(right + i);
        if (a >= 0x80 || b >= 0x80)
        {
            return host();
        }
        const la = LOWER[a];
        const lb = LOWER[b];
        if (la !== lb)
        {
            return la < lb ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
}

/**
 * int _mbsncmp(const unsigned char *left, const unsigned char *right, size_t count),
 * and _mbsnbcmp, which counts bytes: in ASCII the same count
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 * @returns {i32}
 */
export function _mbsncmp({ u8, host }, left, right, count){
    for (/** @type {u32} */ let i = 0; i < count; i++)
    {
        const a = u8(left + i);
        const b = u8(right + i);
        if (a >= 0x80 || b >= 0x80)
        {
            return host();
        }
        if (a !== b)
        {
            return a < b ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
    return 0;
}

/**
 * int _mbsnicmp(const unsigned char *left, const unsigned char *right, size_t count),
 * and _mbsnbicmp
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 * @returns {i32}
 */
export function _mbsnicmp({ u8, host }, left, right, count){
    for (/** @type {u32} */ let i = 0; i < count; i++)
    {
        const a = u8(left + i);
        const b = u8(right + i);
        if (a >= 0x80 || b >= 0x80)
        {
            return host();
        }
        const la = LOWER[a];
        const lb = LOWER[b];
        if (la !== lb)
        {
            return la < lb ? -1 : 1;
        }
        if (a === 0)
        {
            return 0;
        }
    }
    return 0;
}

/**
 * unsigned char *_mbsncpy(unsigned char *destination, const unsigned char *source,
 *                         size_t count), and _mbsnbcpy
 *
 * As strncpy copies, as if the source were read whole first: its bytes to its
 * terminator or the count, and zeros to the count. No count answers the
 * destination as it is; with one, no destination or no source is the host's
 * EINVAL.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} destination @param {u32} source @param {u32} count
 * @returns {u32}
 */
export function _mbsncpy({ u8, copyUp, copyDown, fill, host }, destination, source, count){
    if (count === 0)
    {
        return destination;
    }
    if (destination === 0 || source === 0)
    {
        return host();
    }
    /** @type {u32} */
    let length = 0;
    while (length < count)
    {
        const c = u8(source + length);
        if (c === 0)
        {
            break;
        }
        if (c >= 0x80)
        {
            return host();
        }
        length++;
    }
    if ((destination - source) >>> 0 < length)
    {
        copyDown(destination, source, length);
    }
    else
    {
        copyUp(destination, source, length);
    }
    fill(destination + length, 0, count - length);
    return destination;
}

/**
 * unsigned char *_mbslwr(unsigned char *text)
 *
 * In place, the ASCII capitals, once the whole string is known to be ASCII.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {u32}
 */
export function _mbslwr({ u8, setU8, host }, text){
    for (/** @type {u32} */ let at = text; u8(at) !== 0; at++)
    {
        if (u8(at) >= 0x80)
        {
            return host();
        }
    }
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const c = u8(at);
        if (c === 0)
        {
            return text;
        }
        if (c >= 0x41 && c <= 0x5a)
        {
            setU8(at, c + 0x20);
        }
    }
}

/**
 * unsigned char *_mbsupr(unsigned char *text)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {u32}
 */
export function _mbsupr({ u8, setU8, host }, text){
    for (/** @type {u32} */ let at = text; u8(at) !== 0; at++)
    {
        if (u8(at) >= 0x80)
        {
            return host();
        }
    }
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const c = u8(at);
        if (c === 0)
        {
            return text;
        }
        if (c >= 0x61 && c <= 0x7a)
        {
            setU8(at, c - 0x20);
        }
    }
}

/**
 * void *_encode_pointer(void *pointer), and `_decode_pointer` with it
 *
 * Visual C++ 2005's runtime scrambles the function pointers it keeps against
 * overwriting, and only it decodes what it encoded: the pair is whole with
 * the pointer as it is, and run on every registration and call of a kept
 * pointer, so it costs no crossing.
 *
 * @guestCode cdecl
 * @param {u32} pointer
 * @returns {u32}
 */
export function encodePointer(pointer){
    return pointer;
}

/**
 * void *_encoded_null(void) -- NULL as `_encode_pointer` encodes it.
 *
 * @guestCode cdecl
 * @returns {u32}
 */
export function encodedNull(){
    return 0;
}

/**
 * size_t strspn(const char *text, const char *accept)
 *
 * How many bytes from the start are each a byte of `accept`; the terminator
 * is never one.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} accept
 * @returns {u32}
 */
export function strspn({ u8 }, text, accept){
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const byte = u8(at);
        let found = 0;
        for (/** @type {u32} */ let set = accept; found === 0 && u8(set) !== 0; set++)
        {
            if (u8(set) === byte)
            {
                found = 1;
            }
        }
        if (byte === 0 || found === 0)
        {
            return (at - text) >>> 0;
        }
    }
}

/**
 * size_t strcspn(const char *text, const char *reject)
 *
 * How many bytes from the start are none of `reject`'s, up to the terminator.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} reject
 * @returns {u32}
 */
export function strcspn({ u8 }, text, reject){
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const byte = u8(at);
        let found = 0;
        for (/** @type {u32} */ let set = reject; found === 0 && u8(set) !== 0; set++)
        {
            if (u8(set) === byte)
            {
                found = 1;
            }
        }
        if (byte === 0 || found !== 0)
        {
            return (at - text) >>> 0;
        }
    }
}

/**
 * char *strpbrk(const char *text, const char *accept)
 *
 * The first byte that is one of `accept`'s, or null at the terminator.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {u32} accept
 * @returns {u32}
 */
export function strpbrk({ u8 }, text, accept){
    for (/** @type {u32} */ let at = text; ; at++)
    {
        const byte = u8(at);
        if (byte === 0)
        {
            return 0;
        }
        for (/** @type {u32} */ let set = accept; u8(set) !== 0; set++)
        {
            if (u8(set) === byte)
            {
                return at;
            }
        }
    }
}
