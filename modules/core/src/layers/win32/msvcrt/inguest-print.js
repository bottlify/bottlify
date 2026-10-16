/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The narrow printf family over a `va_list` as code in the guest: a program
 * formats its log lines, names and paths thousands of times a second, and
 * each was a crossing into the host that read the format and the arguments
 * and wrote the text back. Compiled by the build (`scripts/guest-code/`) into
 * `inguest-print.x86.js`.
 *
 * The format is read twice. `formatInGuest` first says whether every
 * conversion in it is one this code renders -- the integers of 32 bits and
 * fewer, a byte, a narrow string, a pointer, %n, %% and the letters msvcrt
 * writes as themselves -- and a format with anything else, a double, a
 * 64-bit integer, a wide string or a counted one, goes to the host's printer
 * whole, before a byte is written. `printInto` then renders it as
 * `format.js` does, conversion for conversion: the same flags, the width and
 * precision read from the arguments ("%*1d" with 1 a width of eleven), the
 * same padding, a '0' flag padding a string with zeros, and a format that
 * ends inside a specification ending the text there. The arguments are the
 * slots of the `va_list` in order, those past the host's window of
 * VA_LIST_SLOTS read as zeros as the host reads them.
 *
 * The text is bytes as the format's and its strings' bytes are -- the
 * host's printer reads and writes them in the ANSI page, which is the same
 * bytes a byte at a time -- and its length is counted in bytes.
 */

/** @typedef {import('./guest-code.js').Guest} Guest */
/** @typedef {import('./guest-code.js').u32} u32 */
/** @typedef {import('./guest-code.js').i32} i32 */

/** The host's window of argument slots a `va_list` is read as (`functions.js`). */
const VA_LIST_SLOTS = 64;

/** Each power of ten a 32-bit unsigned value reaches. */
export const POWERS = Uint32Array.of(1, 10, 100, 1000, 10000, 100000, 1000000, 10000000,
    100000000, 1000000000);

/** What msvcrt prints for a null string. */
export const NULL_TEXT = Uint8Array.from('(null)', c=>c.charCodeAt(0));

/** The byte of a digit's value, lower case. */
const digitByte = (/** @type {number} */ d)=>(d < 10 ? (48 + d) | 0 : (87 + d) | 0);

/** Whether a byte is a digit. */
const isDigit = (/** @type {number} */ c)=>(c >= 48 && c <= 57 ? 1 : 0);

/** Whether a byte is one of the integer conversions, "diouxX", which alone take `I`, `z`, `t`. */
const isInteger = (/** @type {number} */ c)=>(c === 100 || c === 105 || c === 111
    || c === 117 || c === 120 || c === 88 ? 1 : 0);

/**
 * 1 when every conversion of a format is one `printInto` renders, else 0.
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'u8'>} guest @param {u32} format
 * @returns {u32}
 */
export function formatInGuest({ u8 }, format){
    /** @type {u32} */
    let at = format;
    for (;;)
    {
        const c = u8(at);
        if (c === 0)
        {
            return 1;
        }
        at++;
        if (c !== 37)
        {
            continue;
        }
        // The flags, the width and the precision, '*' among them.
        while (u8(at) === 45 || u8(at) === 48 || u8(at) === 43 || u8(at) === 32
            || u8(at) === 35)
        {
            at++;
        }
        if (u8(at) === 42)
        {
            at++;
        }
        while (isDigit(u8(at)) !== 0)
        {
            at++;
        }
        if (u8(at) === 46)
        {
            at++;
            if (u8(at) === 42)
            {
                at++;
            }
            else
            {
                while (isDigit(u8(at)) !== 0)
                {
                    at++;
                }
            }
        }
        let sawH = 0;
        let sawL = 0;
        let sawW = 0;
        let wide64 = 0;
        for (;;)
        {
            const m = u8(at);
            if (m === 104)
            {
                sawH = 1;
            }
            else if (m === 108)
            {
                if (u8(at + 1) === 108)
                {
                    wide64 = 1;
                    at++;
                }
                else
                {
                    sawL = 1;
                }
            }
            else if (m === 119)
            {
                sawW = 1;
            }
            else if (m === 76 || m === 106)
            {
                wide64 = 1;
            }
            else if (m === 70 || m === 78)
            {
                // Far and near: nothing to a flat address.
            }
            else if (m === 73 && u8(at + 1) === 54 && u8(at + 2) === 52)
            {
                wide64 = 1;
                at += 2;
            }
            else if (m === 73 && u8(at + 1) === 51 && u8(at + 2) === 50)
            {
                at += 2;
            }
            else if ((m === 73 || m === 122 || m === 116) && isInteger(u8(at + 1)) !== 0)
            {
                // size_t and ptrdiff_t: four bytes here.
            }
            else
            {
                break;
            }
            at++;
        }
        const conversion = u8(at);
        if (conversion === 0)
        {
            return 1;
        }
        at++;
        if (wide64 !== 0 && isInteger(conversion) !== 0)
        {
            return 0;
        }
        // A wide string or character: `w`, or `l` without `h`, or the capital form.
        const narrow = sawH !== 0 && sawW === 0 ? 1 : 0;
        const wide = sawW !== 0 || sawL !== 0 && sawH === 0 ? 1 : 0;
        if ((conversion === 115 || conversion === 99 || conversion === 83 || conversion === 67)
            && narrow === 0 && (wide !== 0 || conversion === 83 || conversion === 67))
        {
            return 0;
        }
        if (conversion === 90 || conversion === 101 || conversion === 69 || conversion === 102
            || conversion === 103 || conversion === 71)
        {
            return 0;
        }
    }
}

/**
 * Renders a format `formatInGuest` takes into `buffer`, at most `limit` bytes
 * of it written and no terminator, and answers how many bytes the whole text
 * is: what a printer then terminates, cuts or counts. %n stores its count
 * when `counts` is not 0; a pass that only measures, before a printer decides
 * whether the call is the host's, leaves memory as it was.
 *
 * @guestCode cdecl
 * @param {Pick<Guest, 'u8' | 'u32' | 'setU8' | 'setU32'>} guest @param {u32} buffer
 * @param {u32} limit @param {u32} format @param {u32} list @param {u32} counts
 * @returns {u32}
 */
export function printInto({ u8, u32, setU8, setU32 }, buffer, limit, format, list, counts){
    /** @type {u32} */
    let out = 0;
    /** @type {u32} */
    let taken = 0;
    /** @type {u32} */
    let at = format;
    for (;;)
    {
        const c = u8(at);
        if (c === 0)
        {
            return out;
        }
        at++;
        if (c !== 37)
        {
            if (out < limit)
            {
                setU8(buffer + out, c);
            }
            out++;
            continue;
        }
        let leftAlign = 0;
        let zeroPad = 0;
        let plus = 0;
        let space = 0;
        let alt = 0;
        for (;;)
        {
            const f = u8(at);
            if (f === 45)
            {
                leftAlign = 1;
            }
            else if (f === 48)
            {
                zeroPad = 1;
            }
            else if (f === 43)
            {
                plus = 1;
            }
            else if (f === 32)
            {
                space = 1;
            }
            else if (f === 35)
            {
                alt = 1;
            }
            else
            {
                break;
            }
            at++;
        }
        let width = 0;
        if (u8(at) === 42)
        {
            let given = 0;
            if (taken < VA_LIST_SLOTS)
            {
                given = u32(list + taken * 4) | 0;
            }
            taken++;
            if (given < 0)
            {
                leftAlign = 1;
                width = (0 - given) | 0;
            }
            else
            {
                width = given;
            }
            at++;
        }
        while (isDigit(u8(at)) !== 0)
        {
            width = (Math.imul(width, 10) + u8(at) - 48) | 0;
            at++;
        }
        let precision = -1;
        if (u8(at) === 46)
        {
            at++;
            if (u8(at) === 42)
            {
                let given = 0;
                if (taken < VA_LIST_SLOTS)
                {
                    given = u32(list + taken * 4) | 0;
                }
                taken++;
                precision = given < 0 ? -1 : given;
                at++;
            }
            else
            {
                precision = 0;
                while (isDigit(u8(at)) !== 0)
                {
                    precision = (Math.imul(precision, 10) + u8(at) - 48) | 0;
                    at++;
                }
            }
        }
        let short = 0;
        for (;;)
        {
            const m = u8(at);
            if (m === 104)
            {
                short = 1;
            }
            else if (m === 108)
            {
                if (u8(at + 1) === 108)
                {
                    at++;
                }
            }
            else if (m === 119 || m === 76 || m === 106 || m === 70 || m === 78)
            {
                // What `formatInGuest` let through of them says nothing here.
            }
            else if (m === 73 && u8(at + 1) === 54 && u8(at + 2) === 52)
            {
                at += 2;
            }
            else if (m === 73 && u8(at + 1) === 51 && u8(at + 2) === 50)
            {
                at += 2;
            }
            else if ((m === 73 || m === 122 || m === 116) && isInteger(u8(at + 1)) !== 0)
            {
                // size_t and ptrdiff_t: four bytes here.
            }
            else
            {
                break;
            }
            at++;
        }
        const conversion = u8(at);
        if (conversion === 0)
        {
            // The format ended inside a specification: nothing of it is written.
            return out;
        }
        at++;
        // What the conversion renders: a prefix of up to two bytes, then a
        // body of `zeros` zeros and `count` more, from a string or a value.
        let prefix0 = 0;
        let prefix1 = 0;
        let prefixLength = 0;
        let zeros = 0;
        let count = 0;
        let zeroable = 1;
        // 0 a byte, 1 a string, 2 decimal, 3 octal, 4 hex, 5 HEX
        let kind = 0;
        /** @type {u32} */
        let value = 0;
        /** @type {u32} */
        let text = 0;
        if (conversion === 37)
        {
            value = 37;
            count = 1;
        }
        else if (conversion === 99 || conversion === 67)
        {
            if (taken < VA_LIST_SLOTS)
            {
                value = (u32(list + taken * 4) & 0xff) >>> 0;
            }
            taken++;
            count = 1;
        }
        else if (conversion === 115 || conversion === 83)
        {
            if (taken < VA_LIST_SLOTS)
            {
                text = u32(list + taken * 4);
            }
            taken++;
            kind = 1;
            const most = precision < 0 ? 0x7fffffff : precision;
            if (text === 0)
            {
                count = 6;
            }
            else
            {
                while (count < most && u8(text + count) !== 0)
                {
                    count++;
                }
            }
            if (precision >= 0 && count > precision)
            {
                count = precision;
            }
        }
        else if (conversion === 100 || conversion === 105 || conversion === 117
            || conversion === 111 || conversion === 120 || conversion === 88)
        {
            let slot = 0;
            if (taken < VA_LIST_SLOTS)
            {
                slot = u32(list + taken * 4) | 0;
            }
            taken++;
            if (short !== 0)
            {
                slot = conversion === 100 || conversion === 105 ? slot << 16 >> 16
                    : slot & 0xffff;
            }
            kind = conversion === 111 ? 3 : conversion === 120 ? 4 : conversion === 88 ? 5 : 2;
            value = slot >>> 0;
            if ((conversion === 100 || conversion === 105) && slot < 0)
            {
                value = (0 - slot) >>> 0;
                prefix0 = 45;
                prefixLength = 1;
            }
            else if (conversion === 100 || conversion === 105)
            {
                if (plus !== 0)
                {
                    prefix0 = 43;
                    prefixLength = 1;
                }
                else if (space !== 0)
                {
                    prefix0 = 32;
                    prefixLength = 1;
                }
            }
            let digits = 1;
            if (kind === 2)
            {
                while (digits < 10 && value >= POWERS[digits])
                {
                    digits++;
                }
            }
            else if (kind === 3)
            {
                while (digits < 11 && (value >>> (digits * 3)) !== 0)
                {
                    digits++;
                }
            }
            else
            {
                while (digits < 8 && (value >>> (digits * 4)) !== 0)
                {
                    digits++;
                }
            }
            if (precision === 0 && value === 0)
            {
                digits = 0;
            }
            if (precision > digits)
            {
                zeros = (precision - digits) | 0;
            }
            if (kind === 3 && alt !== 0 && zeros === 0 && (digits === 0
                || (value >>> (((digits - 1) | 0) * 3)) !== 0))
            {
                // '#' on octal makes the text start with a zero, adding none
                // to one that does.
                zeros = 1;
            }
            if ((kind === 4 || kind === 5) && alt !== 0 && value !== 0)
            {
                prefix0 = 48;
                prefix1 = kind === 4 ? 120 : 88;
                prefixLength = 2;
            }
            count = digits;
            zeroable = precision < 0 ? 1 : 0;
        }
        else if (conversion === 112)
        {
            if (taken < VA_LIST_SLOTS)
            {
                value = u32(list + taken * 4);
            }
            taken++;
            kind = 5;
            count = 8;
            zeroable = 0;
            if (alt !== 0)
            {
                prefix0 = 48;
                prefix1 = 88;
                prefixLength = 2;
            }
        }
        else if (conversion === 110)
        {
            /** @type {u32} */
            let where = 0;
            if (taken < VA_LIST_SLOTS)
            {
                where = u32(list + taken * 4);
            }
            taken++;
            if (where !== 0 && counts !== 0)
            {
                setU32(where, out);
            }
            zeroable = 0;
        }
        else
        {
            // A conversion msvcrt does not know is written as its own byte,
            // the '%' and all between dropped: "%w0s" is "0s".
            if (out < limit)
            {
                setU8(buffer + out, conversion);
            }
            out++;
            continue;
        }
        const missing = (width - prefixLength - zeros - count) | 0;
        let before = 0;
        let padZeros = 0;
        let after = 0;
        if (missing > 0 && leftAlign !== 0)
        {
            after = missing;
        }
        else if (missing > 0 && zeroPad !== 0 && zeroable !== 0)
        {
            padZeros = missing;
        }
        else if (missing > 0)
        {
            before = missing;
        }
        for (let i = 0; i < before; i++)
        {
            if (out < limit)
            {
                setU8(buffer + out, 32);
            }
            out++;
        }
        if (prefixLength > 0)
        {
            if (out < limit)
            {
                setU8(buffer + out, prefix0);
            }
            out++;
        }
        if (prefixLength > 1)
        {
            if (out < limit)
            {
                setU8(buffer + out, prefix1);
            }
            out++;
        }
        for (let i = 0; i < ((padZeros + zeros) | 0); i++)
        {
            if (out < limit)
            {
                setU8(buffer + out, 48);
            }
            out++;
        }
        for (let i = 0; i < count; i++)
        {
            let byte = value | 0;
            if (kind === 1)
            {
                byte = text === 0 ? NULL_TEXT[i] : u8(text + i);
            }
            else if (kind === 2)
            {
                // The digit at this place: the power of ten subtracted as often as it goes.
                /** @type {u32} */
                let power = POWERS[(count - 1 - i) | 0];
                let d = 0;
                while (value >= power)
                {
                    value = (value - power) >>> 0;
                    d++;
                }
                byte = (48 + d) | 0;
            }
            else if (kind === 3)
            {
                byte = (48 + ((value >>> (((count - 1 - i) | 0) * 3)) & 7)) | 0;
            }
            else if (kind === 4)
            {
                byte = digitByte((value >>> (((count - 1 - i) | 0) * 4)) & 15);
            }
            else if (kind === 5)
            {
                byte = digitByte((value >>> (((count - 1 - i) | 0) * 4)) & 15);
                if (byte >= 97)
                {
                    byte = (byte - 32) | 0;
                }
            }
            if (out < limit)
            {
                setU8(buffer + out, byte);
            }
            out++;
        }
        for (let i = 0; i < after; i++)
        {
            if (out < limit)
            {
                setU8(buffer + out, 32);
            }
            out++;
        }
    }
}

/**
 * int vsprintf(char *buffer, const char *format, va_list args): the text and
 * its terminator, however long; its length.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} buffer @param {u32} format @param {u32} list
 * @returns {i32}
 */
export function vsprintf({ u8, u32, setU8, setU32, host }, buffer, format, list){
    if (buffer === 0 || format === 0 || formatInGuest({ u8 }, format) === 0)
    {
        return host();
    }
    const total = printInto({ u8, u32, setU8, setU32 }, buffer, 0xffffffff, format, list, 1);
    setU8(buffer + total, 0);
    return total | 0;
}

/**
 * int _vsnprintf(char *buffer, size_t count, const char *format, va_list args):
 * at most `count` bytes, the terminator only when the text is shorter, and -1
 * when it did not fit. No buffer is the host's (a length asked for, or EINVAL).
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} buffer @param {u32} count @param {u32} format
 * @param {u32} list
 * @returns {i32}
 */
export function _vsnprintf({ u8, u32, setU8, setU32, host }, buffer, count, format, list){
    if (buffer === 0 || format === 0 || formatInGuest({ u8 }, format) === 0)
    {
        return host();
    }
    const total = printInto({ u8, u32, setU8, setU32 }, buffer, count, format, list, 1);
    if (total < count)
    {
        setU8(buffer + total, 0);
    }
    if (total > count)
    {
        return -1;
    }
    return total | 0;
}

/**
 * int _vscprintf(const char *format, va_list args): how long the text is, its
 * terminator left out.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} format @param {u32} list
 * @returns {i32}
 */
export function _vscprintf({ u8, u32, setU8, setU32, host }, format, list){
    if (format === 0 || formatInGuest({ u8 }, format) === 0)
    {
        return host();
    }
    return printInto({ u8, u32, setU8, setU32 }, 0, 0, format, list, 1) | 0;
}

/**
 * int _vsnprintf_s(char *buffer, size_t size, size_t count, const char *format,
 * va_list args): at most `count` bytes and a terminator, in a buffer of
 * `size`; cut short, -1 with what fit kept under _TRUNCATE or a count the
 * buffer holds. A count the buffer cannot hold for a text that does not fit
 * empties the buffer with ERANGE, and an invalid parameter is EINVAL: both
 * the host's, found before a byte is written.
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} buffer @param {u32} size @param {u32} count
 * @param {u32} format @param {u32} list
 * @returns {i32}
 */
export function _vsnprintf_s({ u8, u32, setU8, setU32, host }, buffer, size, count, format,
    list)
{
    if (buffer === 0 || size === 0 || format === 0 || formatInGuest({ u8 }, format) === 0)
    {
        return host();
    }
    const room = (size - 1) >>> 0;
    /** @type {u32} */
    let limit = room;
    if (count !== 0xffffffff && count < room)
    {
        limit = count;
    }
    if (count !== 0xffffffff && count > room
        && printInto({ u8, u32, setU8, setU32 }, 0, 0, format, list, 0) > room)
    {
        return host();
    }
    const total = printInto({ u8, u32, setU8, setU32 }, buffer, limit, format, list, 1);
    if (total <= limit)
    {
        setU8(buffer + total, 0);
        return total | 0;
    }
    setU8(buffer + limit, 0);
    return -1;
}
