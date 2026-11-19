/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C runtime's 64-bit integer conversions as code in the guest: `_atoi64`,
 * `_strtoi64` and `_strtoui64` (ucrtbase's `strtoll` and `strtoull` are the
 * same), and `_i64toa`, `_ui64toa` and their wide forms. A program that
 * reads a file of numbers or prints its counters calls them in a loop.
 *
 * The value is an `i64`: two stack slots in the i386 and one register at 64
 * bits as a parameter, EDX:EAX or RAX as a result (scripts/guest-code). The
 * arithmetic is on its two 32-bit halves: a digit taken in multiplies the low
 * half in 16-bit parts, whose carries reach the high half; a power of ten is
 * subtracted with a borrow. Whatever sets errno or clamps - a value past the
 * type, a base the code does not take - is the host's handler's, before
 * anything is written.
 *
 * @module
 */

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').i32} i32 */
/** @typedef {import('./guest-code.js').u32} u32 */
/** @typedef {import('./guest-code.js').ptr} ptr */
/** @typedef {import('./guest-code.js').i64} i64 */

/** Each byte's value as a digit: 0-9, then a letter of either case from ten; 255 for any other. */
export const DIGITS_64 = Uint8Array.from({ length: 256 }, (_, code)=>{
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
    return 255;
});

/**
 * The largest high half that takes another digit in each base from 2 to 36
 * without the product passing 32 bits: 2^32 - 1 over the base.
 */
export const HIGH_BELOW_CARRY = Uint32Array.from({ length: 37 },
    (_, base)=>(base < 2 ? 0 : Math.floor(0xffffffff / base)));

/** The powers of ten a 64-bit unsigned value reaches, 10^0 to 10^19: their low halves. */
export const TENS_LOW = Uint32Array.from({ length: 20 },
    (_, p)=>Number(BigInt.asUintN(32, 10n ** BigInt(p))));
/** Their high halves. */
export const TENS_HIGH = Uint32Array.from({ length: 20 },
    (_, p)=>Number((10n ** BigInt(p)) >> 32n));

/**
 * __int64 _strtoi64(const char *text, char **end, int base), and strtoll
 *
 * strtol's reading (white space, a sign, `0x` or `0X` in base 16 or 0, a
 * leading 0 octal in base 0, the digits of the base) of a 64-bit value. A
 * value out of range, or one past 64 bits on the way, is the host's: it
 * clamps and sets errno; so is a base outside 2..36 other than 0.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {ptr} end @param {i32} base
 * @returns {i64}
 */
export function _strtoi64({ u8, setU32, host, pointerBytes, int64 }, text, end, base){
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
    const most = HIGH_BELOW_CARRY[radix];
    /** @type {u32} */
    let low = 0;
    /** @type {u32} */
    let high = 0;
    let digit = DIGITS_64[c];
    while (digit < radix)
    {
        if (high > most)
        {
            return host();
        }
        // The low half times the radix in 16-bit parts, and the digit added.
        const lower = (Math.imul(low & 0xffff, radix) + digit) >>> 0;
        const upper = (Math.imul(low >>> 16, radix) + (lower >>> 16)) >>> 0;
        low = ((upper << 16) | (lower & 0xffff)) >>> 0;
        const product = Math.imul(high, radix) >>> 0;
        high = (product + (upper >>> 16)) >>> 0;
        if (high < product)
        {
            return host();
        }
        at++;
        digit = DIGITS_64[u8(at)];
    }
    if (at === start)
    {
        if (end !== 0)
        {
            setU32(end, text);
            if (pointerBytes === 8)
            {
                setU32(end + 4, 0);
            }
        }
        return int64(0, 0);
    }
    if (negative !== 0 && (high > 0x80000000 || high === 0x80000000 && low !== 0)
        || negative === 0 && high > 0x7fffffff)
    {
        return host();
    }
    if (end !== 0)
    {
        setU32(end, at);
        if (pointerBytes === 8)
        {
            setU32(end + 4, 0);
        }
    }
    if (negative !== 0)
    {
        return int64((0 - low) >>> 0, (~high + (low === 0 ? 1 : 0)) >>> 0);
    }
    return int64(low, high);
}

/**
 * unsigned __int64 _strtoui64(const char *text, char **end, int base), and
 * strtoull: as `_strtoi64` reads, a minus sign negating the magnitude within
 * 64 bits. A magnitude past 64 bits is the host's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text @param {ptr} end @param {i32} base
 * @returns {i64}
 */
export function _strtoui64({ u8, setU32, host, pointerBytes, int64 }, text, end, base){
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
    const most = HIGH_BELOW_CARRY[radix];
    /** @type {u32} */
    let low = 0;
    /** @type {u32} */
    let high = 0;
    let digit = DIGITS_64[c];
    while (digit < radix)
    {
        if (high > most)
        {
            return host();
        }
        const lower = (Math.imul(low & 0xffff, radix) + digit) >>> 0;
        const upper = (Math.imul(low >>> 16, radix) + (lower >>> 16)) >>> 0;
        low = ((upper << 16) | (lower & 0xffff)) >>> 0;
        const product = Math.imul(high, radix) >>> 0;
        high = (product + (upper >>> 16)) >>> 0;
        if (high < product)
        {
            return host();
        }
        at++;
        digit = DIGITS_64[u8(at)];
    }
    if (at === start)
    {
        if (end !== 0)
        {
            setU32(end, text);
            if (pointerBytes === 8)
            {
                setU32(end + 4, 0);
            }
        }
        return int64(0, 0);
    }
    if (end !== 0)
    {
        setU32(end, at);
        if (pointerBytes === 8)
        {
            setU32(end + 4, 0);
        }
    }
    if (negative !== 0)
    {
        return int64((0 - low) >>> 0, (~high + (low === 0 ? 1 : 0)) >>> 0);
    }
    return int64(low, high);
}

/**
 * __int64 _atoi64(const char *text): white space, a sign and decimal digits.
 * A value past 64 bits is the host's, which clamps it as `_strtoi64` does.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} text
 * @returns {i64}
 */
export function _atoi64({ u8, host, int64 }, text){
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
    /** @type {u32} */
    let low = 0;
    /** @type {u32} */
    let high = 0;
    let digit = (c - 0x30) >>> 0;
    while (digit < 10)
    {
        if (high > 0x19999999)
        {
            return host();
        }
        const lower = (Math.imul(low & 0xffff, 10) + digit) >>> 0;
        const upper = (Math.imul(low >>> 16, 10) + (lower >>> 16)) >>> 0;
        low = ((upper << 16) | (lower & 0xffff)) >>> 0;
        const product = Math.imul(high, 10) >>> 0;
        high = (product + (upper >>> 16)) >>> 0;
        if (high < product)
        {
            return host();
        }
        at++;
        digit = (u8(at) - 0x30) >>> 0;
    }
    if (negative !== 0 && (high > 0x80000000 || high === 0x80000000 && low !== 0)
        || negative === 0 && high > 0x7fffffff)
    {
        return host();
    }
    if (negative !== 0)
    {
        return int64((0 - low) >>> 0, (~high + (low === 0 ? 1 : 0)) >>> 0);
    }
    return int64(low, high);
}

/**
 * Whether the `_*64toa` code renders a radix itself: ten, by subtracting
 * powers of ten, and the powers of two, by shifts; any other is the handler's.
 */
const renders64 = (/** @type {number} */ radix)=>(radix === 10 || radix === 2 || radix === 4
    || radix === 8 || radix === 16 || radix === 32 ? 1 : 0);

/**
 * The `_*64toa` family's text, bytes or units (`wide`), and a terminator, at
 * `buffer`, of the value whose halves are `low` and `high`: signed where
 * `signed` is 1 and the radix ten, every other the bit pattern; digits past
 * nine from 'a'. The radix is one `renders64` takes. Answers the buffer.
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'setU8' | 'setU16'>} guest @param {u32} low @param {u32} high
 * @param {u32} buffer @param {i32} radix @param {i32} signed @param {i32} wide
 * @returns {ptr}
 */
export function text64({ setU8, setU16 }, low, high, buffer, radix, signed, wide){
    const step = wide !== 0 ? 2 : 1;
    let at = buffer;
    let lo = low;
    let hi = high;
    if (signed !== 0 && radix === 10 && (high | 0) < 0)
    {
        if (wide !== 0)
        {
            setU16(at, 0x2d);
        }
        else
        {
            setU8(at, 0x2d);
        }
        at = (at + step) >>> 0;
        hi = (~high + (low === 0 ? 1 : 0)) >>> 0;
        lo = (0 - low) >>> 0;
    }
    if (radix === 10)
    {
        let started = 0;
        for (let p = 19; p >= 0; p--)
        {
            const pl = TENS_LOW[p];
            const ph = TENS_HIGH[p];
            let digit = 0;
            while (hi > ph || hi === ph && lo >= pl)
            {
                const borrow = lo < pl ? 1 : 0;
                lo = (lo - pl) >>> 0;
                hi = (hi - ph - borrow) >>> 0;
                digit++;
            }
            if (digit !== 0 || started !== 0 || p === 0)
            {
                started = 1;
                if (wide !== 0)
                {
                    setU16(at, (0x30 + digit) | 0);
                }
                else
                {
                    setU8(at, (0x30 + digit) | 0);
                }
                at = (at + step) >>> 0;
            }
        }
    }
    else
    {
        const shift = radix === 2 ? 1 : radix === 4 ? 2 : radix === 8 ? 3 : radix === 16 ? 4 : 5;
        // The top digit's place: the last multiple of the shift with bits at
        // or past it, below 64.
        let top = 0;
        let place = shift;
        while (place < 64)
        {
            const beyond = place >= 32 ? hi >>> ((place - 32) | 0) : ((lo >>> place) | hi) >>> 0;
            if (beyond === 0)
            {
                break;
            }
            top = place;
            place = (place + shift) | 0;
        }
        for (let p = top; p >= 0; p = (p - shift) | 0)
        {
            const bits = p >= 32 ? hi >>> ((p - 32) | 0)
                : p === 0 ? lo : ((lo >>> p) | (hi << ((32 - p) | 0))) >>> 0;
            const digit = bits & (radix - 1);
            const c = digit < 10 ? (0x30 + digit) | 0 : (0x57 + digit) | 0;
            if (wide !== 0)
            {
                setU16(at, c);
            }
            else
            {
                setU8(at, c);
            }
            at = (at + step) >>> 0;
        }
    }
    if (wide !== 0)
    {
        setU16(at, 0);
    }
    else
    {
        setU8(at, 0);
    }
    return buffer;
}

/**
 * char *_i64toa(__int64 value, char *buffer, int radix): signed in base ten
 * alone. A radix other than ten or a power of two is the handler's.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {i64} value @param {u32} buffer @param {i32} radix
 * @returns {ptr}
 */
export function _i64toa({ setU8, setU16, host, low64, high64 }, value, buffer, radix){
    if (renders64(radix) === 0)
    {
        return host();
    }
    return text64({ setU8, setU16 }, low64(value), high64(value), buffer, radix, 1, 0);
}

/**
 * char *_ui64toa(unsigned __int64 value, char *buffer, int radix): unsigned in
 * every radix.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {i64} value @param {u32} buffer @param {i32} radix
 * @returns {ptr}
 */
export function _ui64toa({ setU8, setU16, host, low64, high64 }, value, buffer, radix){
    if (renders64(radix) === 0)
    {
        return host();
    }
    return text64({ setU8, setU16 }, low64(value), high64(value), buffer, radix, 0, 0);
}

/**
 * wchar_t *_i64tow(__int64 value, wchar_t *buffer, int radix): `_i64toa`'s
 * text in units.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {i64} value @param {u32} buffer @param {i32} radix
 * @returns {ptr}
 */
export function _i64tow({ setU8, setU16, host, low64, high64 }, value, buffer, radix){
    if (renders64(radix) === 0)
    {
        return host();
    }
    return text64({ setU8, setU16 }, low64(value), high64(value), buffer, radix, 1, 1);
}

/**
 * wchar_t *_ui64tow(unsigned __int64 value, wchar_t *buffer, int radix):
 * `_ui64toa`'s text in units.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {i64} value @param {u32} buffer @param {i32} radix
 * @returns {ptr}
 */
export function _ui64tow({ setU8, setU16, host, low64, high64 }, value, buffer, radix){
    if (renders64(radix) === 0)
    {
        return host();
    }
    return text64({ setU8, setU16 }, low64(value), high64(value), buffer, radix, 0, 1);
}
