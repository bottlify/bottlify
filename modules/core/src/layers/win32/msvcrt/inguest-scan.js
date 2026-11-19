/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * sscanf as code in the guest: a program reads its numbers out of text - a
 * configuration's values, a level's attributes - a call a value, and each was
 * a crossing into the host that read the input and the format whole and wrote
 * the values back. Compiled by the build (`scripts/guest-code/`) into
 * `inguest-scan.x86.js` and, for a 64-bit process, `inguest-scan.x64.js`.
 *
 * The call is run twice by one function, `scanInto`. The first run stores
 * nothing and says whether the call is one this code answers as the host's
 * scanner (`runScan` in `scan.js`) does; the second stores. What the first
 * run leaves to the host, whole and before a byte is written:
 *
 * - a format or an input with a byte past ASCII (the host reads both in the
 *   ANSI page), or longer than the host reads;
 * - `%[`, `%n`, and a wide `%s` or `%c`;
 * - a number in the text with a sixteenth significant digit or a scale past
 *   10^22, where the value is no longer one exact step from two integers
 *   (Clinger's fast path, as `strtod` here), and an integer of more digits
 *   than the host's scanner counts exactly;
 * - no place to store through, one past 4 GiB, and one that lies over the
 *   input, the format or the arguments: the host has read all three before
 *   it stores, this code reads them as it goes.
 *
 * The rest is msvcrt's reading as `runScan` has it: digits and length
 * modifiers of a specification in any order, every digit adding to the one
 * width; `ll`, `I64` and `j` an integer of eight bytes, `I` one of a
 * pointer's, a single `h` a short; `%f` a float and `%lf` a double; `0x`
 * read as a prefix only before a hexadecimal digit; a letter that names no
 * conversion matched as itself; and -1 when nothing was assigned and the
 * input ended.
 */

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').u32} u32 */
/** @typedef {import('./guest-code.js').i32} i32 */
/** @typedef {import('./guest-code.js').f64} f64 */

/** The places the host's handler reads for the conversions to store through (`scan.js`). */
const VARIADIC_SLOTS = 32;

/** As much of a string as the host reads (`MAX_STRING` in `scan.js`). */
const LONGEST = 0x100000;

/** `scanInto`'s answer for a call that is the host's. */
const HANDED = -2;

/**
 * The digits of an integer the host's scanner still counts exactly: its
 * magnitude stops growing past 2^72, which eighteen digits of base sixteen
 * do not reach.
 */
const COUNTED_DIGITS = 18;

/** A width no field reaches: no width given. */
const NO_LIMIT = 0x7fffffff;

/** Whether a byte is white space, as the scanner skips it. */
const isSpace = (/** @type {number} */ c)=>(c === 32 || c >= 9 && c <= 13 ? 1 : 0);

/** A byte's value as a digit of any base to thirty-six, 99 for none. */
const digitOf = (/** @type {number} */ c)=>(c >= 48 && c <= 57 ? (c - 48) | 0
    : (c | 32) >= 97 && (c | 32) <= 122 ? ((c | 32) - 87) | 0 : 99);

/** What a scan that stops answers: -1 for nothing assigned and no input left. */
const stopped = (/** @type {number} */ assigned, /** @type {number} */ next)=>
    (assigned === 0 && next === 0 ? -1 : assigned);

/** Whether `bytes` at `place` lie clear of `span` bytes at `start`. */
const clearOf = (/** @type {number} */ place, /** @type {number} */ bytes,
    /** @type {number} */ start, /** @type {number} */ span)=>
    (((place - start) >>> 0) >= span && ((start - place) >>> 0) >= bytes ? 1 : 0);

/** The control word Clinger's step runs under: double precision, to nearest. */
const exactly = (/** @type {number} */ word)=>word & 0xf0ff | 0x0200;

/**
 * One run of a scan: the input read against the format, the values stored
 * through the pointers in the list's slots when `write` is not 0. Answers
 * what sscanf answers; with `write` 0 nothing is stored and the answer is
 * `HANDED` (-2) for a call that is the host's, anything else for one a second
 * run with `write` set answers.
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'u8' | 'u32' | 'setU8' | 'setU16' | 'setU32' | 'setF32' | 'setF64'
 *     | 'controlWord' | 'setControlWord' | 'pointerBytes'>} guest
 * @param {u32} input @param {u32} format @param {u32} list @param {u32} write
 * @returns {i32}
 */
export function scanInto({ u8, u32, setU8, setU16, setU32, setF32, setF64, controlWord,
    setControlWord, pointerBytes }, input, format, list, write)
{
    /** @type {u32} */
    let inputSpan = 0;
    /** @type {u32} */
    let formatSpan = 0;
    /** @type {u32} */
    let listSpan = 0;
    if (write === 0)
    {
        let b = u8(format);
        while (b !== 0)
        {
            if (b >= 0x80 || formatSpan >= LONGEST)
            {
                return HANDED;
            }
            // No conversion without its '%': as many slots as there are of
            // them is every slot the format can read.
            if (b === 37)
            {
                listSpan++;
            }
            formatSpan++;
            b = u8(format + formatSpan);
        }
        if (listSpan > VARIADIC_SLOTS)
        {
            return HANDED;
        }
        listSpan = Math.imul(listSpan, pointerBytes) >>> 0;
        b = u8(input);
        while (b !== 0)
        {
            if (b >= 0x80 || inputSpan >= LONGEST)
            {
                return HANDED;
            }
            inputSpan++;
            b = u8(input + inputSpan);
        }
        // Their terminators are read too.
        formatSpan++;
        inputSpan++;
    }

    /** @type {u32} */
    let at = input;
    /** @type {u32} */
    let f = format;
    let assigned = 0;
    /** @type {u32} */
    let taken = 0;
    for (;;)
    {
        let d = u8(f);
        if (d === 0)
        {
            return assigned;
        }
        f++;
        if (isSpace(d) !== 0)
        {
            while (isSpace(u8(at)) !== 0)
            {
                at++;
            }
            continue;
        }
        if (d !== 37)
        {
            if (u8(at) !== d)
            {
                return stopped(assigned, u8(at));
            }
            at++;
            continue;
        }

        d = u8(f);
        let suppress = 0;
        if (d === 42)
        {
            suppress = 1;
            f++;
            d = u8(f);
        }
        /** @type {u32} */
        let width = 0;
        // The modifiers as the host's scanner tells them apart in the order
        // they came: two l's with no other modifier between, a lone I.
        let afterL = 0;
        let eight = 0;
        let pointerWide = 0;
        let shorts = 0;
        let double = 0;
        let wide = 0;
        for (;;)
        {
            if (d >= 48 && d <= 57)
            {
                width = width < 0x0ccccccc ? (Math.imul(width, 10) + (d - 48)) >>> 0 : NO_LIMIT;
            }
            else if (d === 73)
            {
                if (u8(f + 1) === 54 && u8(f + 2) === 52)
                {
                    eight = 1;
                    afterL = 0;
                    f += 2;
                }
                else if (u8(f + 1) === 51 && u8(f + 2) === 50)
                {
                    // I32 says what an integer is already.
                    f += 2;
                }
                else
                {
                    pointerWide = 1;
                    afterL = 0;
                }
            }
            else if (d === 108)
            {
                eight = afterL !== 0 ? 1 : eight;
                afterL = 1;
                double = 1;
                wide = 1;
            }
            else if (d === 76)
            {
                double = 1;
                afterL = 0;
            }
            else if (d === 104)
            {
                shorts++;
                afterL = 0;
            }
            else if (d === 106)
            {
                eight = 1;
                afterL = 0;
            }
            else if (d === 119)
            {
                wide = 1;
                afterL = 0;
            }
            else if (d === 122 || d === 116 || d === 70 || d === 78)
            {
                afterL = 0;
            }
            else
            {
                break;
            }
            f++;
            d = u8(f);
        }
        if (d === 0)
        {
            return stopped(assigned, u8(at));
        }
        f++;
        /** @type {u32} */
        const limit = width === 0 ? NO_LIMIT : width;

        const text = d === 99 || d === 67 || d === 115 || d === 83 ? 1 : 0;
        const real = (d | 32) === 101 || d === 102 || (d | 32) === 103 || (d | 32) === 97 ? 1 : 0;
        const integer = d === 100 || d === 105 || d === 111 || d === 117 || (d | 32) === 120
            || (d | 32) === 112 ? 1 : 0;
        if (d === 91 || d === 110)
        {
            return HANDED;
        }
        if (text === 0 && real === 0 && integer === 0)
        {
            // A letter msvcrt knows no conversion by is matched as itself.
            if (u8(at) !== d)
            {
                return stopped(assigned, u8(at));
            }
            at++;
            continue;
        }
        if ((d | 32) !== 99)
        {
            while (isSpace(u8(at)) !== 0)
            {
                at++;
            }
        }
        if (u8(at) === 0)
        {
            return stopped(assigned, 0);
        }

        if (text !== 0)
        {
            // Upper case is wide unless an h says narrow; lower, narrow
            // unless an l or a w says wide.
            if (wide !== 0 || (d < 97 && shorts === 0))
            {
                return HANDED;
            }
            /** @type {u32} */
            let count = 0;
            if ((d | 32) === 99)
            {
                count = width === 0 ? 1 : width;
                /** @type {u32} */
                let have = 0;
                while (have < count && u8(at + have) !== 0)
                {
                    have++;
                }
                if (have < count)
                {
                    return stopped(assigned, u8(at));
                }
            }
            else
            {
                let s = u8(at);
                while (count < limit && s !== 0 && isSpace(s) === 0)
                {
                    count++;
                    s = u8(at + count);
                }
            }
            if (suppress === 0)
            {
                // The bytes to keep clear: a string's terminator with them.
                /** @type {u32} */
                const textBytes = (d | 32) === 99 ? count : (count + 1) >>> 0;
                /** @type {u32} */
                const textPlace = u32(list + Math.imul(taken, pointerBytes));
                if (write === 0 && (textPlace === 0
                    || (pointerBytes === 8 && u32(list + Math.imul(taken, pointerBytes) + 4) !== 0)
                    || clearOf(textPlace, textBytes, input, inputSpan) === 0
                    || clearOf(textPlace, textBytes, format, formatSpan) === 0
                    || clearOf(textPlace, textBytes, list, listSpan) === 0))
                {
                    return HANDED;
                }
                taken++;
                if (write !== 0)
                {
                    /** @type {u32} */
                    let i = 0;
                    for (; i < count; i++)
                    {
                        setU8(textPlace + i, u8(at + i));
                    }
                    if ((d | 32) === 115)
                    {
                        setU8(textPlace + count, 0);
                    }
                }
                assigned++;
            }
            at += count;
            continue;
        }

        // A number: its field is what the width leaves of the input, the
        // bytes past it as good as the input's end.
        /** @type {u32} */
        let n = 0;
        let c = u8(at);
        let negative = 0;
        if (c === 45 || c === 43)
        {
            negative = c === 45 ? 1 : 0;
            n = 1;
            c = n < limit ? u8(at + n) : 0;
        }

        if (real !== 0)
        {
            let seen = 0;
            let point = 0;
            let digits = 0;
            let high = 0;
            let low = 0;
            let scale = 0;
            for (;;)
            {
                if (c >= 48 && c <= 57)
                {
                    seen = 1;
                    // A leading zero is no significant digit; after the point
                    // it moves the scale as any digit there does.
                    if (digits !== 0 || c !== 48)
                    {
                        if (digits < 9)
                        {
                            high = (Math.imul(high, 10) + (c - 48)) | 0;
                        }
                        else if (digits < 15)
                        {
                            low = (Math.imul(low, 10) + (c - 48)) | 0;
                        }
                        else
                        {
                            return HANDED;
                        }
                        digits++;
                    }
                    scale = (scale - point) | 0;
                }
                else if (c === 46 && point === 0 && (seen !== 0
                    || ((n + 1) >>> 0 < limit && u8(at + n + 1) >= 48 && u8(at + n + 1) <= 57)))
                {
                    // A point with no digit before it wants one after.
                    point = 1;
                }
                else
                {
                    break;
                }
                n++;
                c = n < limit ? u8(at + n) : 0;
            }
            if (seen === 0)
            {
                return stopped(assigned, u8(at));
            }
            if ((c | 32) === 101)
            {
                /** @type {u32} */
                let after = (n + 1) >>> 0;
                let e = after < limit ? u8(at + after) : 0;
                let minus = 0;
                if (e === 45 || e === 43)
                {
                    minus = e === 45 ? 1 : 0;
                    after++;
                    e = after < limit ? u8(at + after) : 0;
                }
                if (e >= 48 && e <= 57)
                {
                    let exponent = 0;
                    while (e >= 48 && e <= 57)
                    {
                        exponent = exponent < 100000 ? (Math.imul(exponent, 10) + (e - 48)) | 0
                            : exponent;
                        after++;
                        e = after < limit ? u8(at + after) : 0;
                    }
                    scale = minus !== 0 ? (scale - exponent) | 0 : (scale + exponent) | 0;
                    n = after;
                }
            }
            if (digits !== 0 && (scale > 22 || scale < -22))
            {
                return HANDED;
            }
            if (suppress === 0)
            {
                /** @type {u32} */
                const realBytes = double !== 0 ? 8 : 4;
                /** @type {u32} */
                const realPlace = u32(list + Math.imul(taken, pointerBytes));
                if (write === 0 && (realPlace === 0
                    || (pointerBytes === 8 && u32(list + Math.imul(taken, pointerBytes) + 4) !== 0)
                    || clearOf(realPlace, realBytes, input, inputSpan) === 0
                    || clearOf(realPlace, realBytes, format, formatSpan) === 0
                    || clearOf(realPlace, realBytes, list, listSpan) === 0))
                {
                    return HANDED;
                }
                taken++;
                if (write !== 0)
                {
                    // The i386's x87 rounds to doubles for the computation
                    // and to nearest for the store; x86-64's SSE2 computes in
                    // doubles already.
                    const word = pointerBytes === 4 ? controlWord() : 0;
                    if (pointerBytes === 4)
                    {
                        setControlWord(exactly(word));
                    }
                    /** @type {f64} */
                    let whole = +high;
                    let k = (digits - 9) | 0;
                    while (k > 0)
                    {
                        whole = whole * 10;
                        k--;
                    }
                    whole = whole + low;
                    /** @type {f64} */
                    let power = 1;
                    // No digit but zeros: zero, whatever its exponent.
                    k = digits === 0 ? 0 : scale < 0 ? (0 - scale) | 0 : scale;
                    while (k > 0)
                    {
                        power = power * 10;
                        k--;
                    }
                    /** @type {f64} */
                    let value = scale < 0 ? whole / power : whole * power;
                    value = negative !== 0 ? -value : value;
                    if (double !== 0)
                    {
                        setF64(realPlace, value);
                    }
                    else
                    {
                        setF32(realPlace, value);
                    }
                    if (pointerBytes === 4)
                    {
                        setControlWord(word);
                    }
                }
                assigned++;
            }
            at += n;
            continue;
        }

        // An integer. A pointer is hexadecimal digits alone: "0x" is no
        // prefix of it, and reads as the zero before the x.
        const pointer = (d | 32) === 112 ? 1 : 0;
        let base = d === 105 ? 0 : d === 111 ? 8 : d === 100 || d === 117 ? 10 : 16;
        if ((base === 0 || base === 16) && pointer === 0 && c === 48
            && (n + 2) >>> 0 < limit && (u8(at + n + 1) | 32) === 120
            && digitOf(u8(at + n + 2)) < 16)
        {
            base = 16;
            n += 2;
            c = u8(at + n);
        }
        else if (base === 0)
        {
            base = c === 48 ? 8 : 10;
        }
        /** @type {u32} */
        let lowHalf = 0;
        /** @type {u32} */
        let highHalf = 0;
        let read = 0;
        while (digitOf(c) < base)
        {
            if (read >= COUNTED_DIGITS)
            {
                return HANDED;
            }
            // The quadword times the base plus the digit, a half of a half at a time.
            const p0 = (Math.imul(lowHalf & 0xffff, base) + digitOf(c)) >>> 0;
            const p1 = (Math.imul(lowHalf >>> 16, base) + (p0 >>> 16)) >>> 0;
            lowHalf = ((p1 & 0xffff) << 16 | p0 & 0xffff) >>> 0;
            highHalf = (Math.imul(highHalf, base) + (p1 >>> 16)) >>> 0;
            read++;
            n++;
            c = n < limit ? u8(at + n) : 0;
        }
        if (read === 0)
        {
            return stopped(assigned, u8(at));
        }
        if (negative !== 0)
        {
            lowHalf = (0 - lowHalf) >>> 0;
            highHalf = (~highHalf + (lowHalf === 0 ? 1 : 0)) >>> 0;
        }
        /** @type {u32} */
        const bytes = pointer !== 0 ? pointerBytes : eight !== 0 ? 8
            : pointerWide !== 0 ? pointerBytes : shorts === 1 ? 2 : 4;
        if (suppress === 0)
        {
            /** @type {u32} */
            const place = u32(list + Math.imul(taken, pointerBytes));
            if (write === 0 && (place === 0
                || (pointerBytes === 8 && u32(list + Math.imul(taken, pointerBytes) + 4) !== 0)
                || clearOf(place, bytes, input, inputSpan) === 0
                || clearOf(place, bytes, format, formatSpan) === 0
                || clearOf(place, bytes, list, listSpan) === 0))
            {
                return HANDED;
            }
            taken++;
            if (write !== 0)
            {
                if (bytes === 2)
                {
                    setU16(place, lowHalf & 0xffff);
                }
                else
                {
                    setU32(place, lowHalf);
                    if (bytes === 8)
                    {
                        setU32(place + 4, highHalf);
                    }
                }
            }
            assigned++;
        }
        at += n;
    }
}

/**
 * sscanf over a `va_list` - `int (const char *input, const char *format,
 * va_list places)`, no export of msvcrt's by a name of its own: sscanf is
 * this code after the instructions that make its arguments a list
 * (`variadicEntry`). A call `scanInto` does not take is the host's whole.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} input @param {u32} format @param {u32} list
 * @returns {i32}
 */
export function scanList({ u8, u32, setU8, setU16, setU32, setF32, setF64, controlWord,
    setControlWord, host, pointerBytes }, input, format, list)
{
    if (input === 0 || format === 0
        || scanInto({ u8, u32, setU8, setU16, setU32, setF32, setF64, controlWord,
            setControlWord, pointerBytes }, input, format, list, 0) === HANDED)
    {
        return host();
    }
    return scanInto({ u8, u32, setU8, setU16, setU32, setF32, setF64, controlWord,
        setControlWord, pointerBytes }, input, format, list, 1);
}
