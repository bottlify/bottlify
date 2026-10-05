/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * wsprintf's formatter: user32's own, not the C runtime's printf.
 *
 * The two read alike and differ where a program relies on it. A
 * specification is `[-][#][0][width][.precision][size]type`, its flags only
 * in that order and only once each, with no `+`, no blank and no `*`; the
 * types are c, C, d, i, s, S, u, x, X and p, and anything else is printed
 * as itself. A zero-padded number takes the width as its count of digits,
 * and what goes in front of the digits -- `0x` for `#` on a hexadecimal
 * number, a minus sign -- comes on top of it: "%#04x" of 0x409 is "0x0409",
 * where the C runtime's is "0x409" (a setup that names its language file by
 * it looks for 0x0409.ini). The output is at most 1024 characters with its
 * terminator. Wine's user32 behaves so, and its tests pin the parts it
 * tests.
 */

/** What wsprintf stores at most, the terminator included. */
export const WSPRINTF_LIMIT = 1024;

/** @typedef {'char' | 'wchar' | 'string' | 'wstring' | 'signed' | 'unsigned' | 'hex'
 *     | 'unknown'} Kind */

/**
 * @typedef {Object} WsprintfOptions
 * @property {(address: number) => string} readString      A byte string, as text.
 * @property {(address: number) => string} readWideString  A UTF-16 string.
 * @property {(byte: number) => string} byteChar            A byte as the character it is.
 * @property {boolean} [wide]  The W form: %s and %c are wide, %S and %C narrow.
 */

/**
 * The text a wsprintf call stores, before the terminator: at most
 * WSPRINTF_LIMIT - 1 characters of it.
 *
 * @param {string} format
 * @param {number[]} slots  The arguments, as stack slots.
 * @param {WsprintfOptions} options
 * @returns {string}
 */
export function formatWsprintf(format, slots, options){
    const wide = options.wide === true;
    let taken = 0;
    // A format is data, and it may ask for more arguments than were pushed:
    // those read as zero, a wrong string rather than a fault.
    const take = ()=>(taken < slots.length ? slots[taken++] | 0 : 0);
    let out = '';
    let at = 0;
    while (at < format.length)
    {
        const character = format[at];
        if (character !== '%')
        {
            out += character;
            at++;
            continue;
        }
        at++;
        if (format[at] === '%')
        {
            out += '%';
            at++;
            continue;
        }
        let left = false;
        let prefix = false;
        let zeroPad = false;
        if (format[at] === '-')
        {
            left = true;
            at++;
        }
        if (format[at] === '#')
        {
            prefix = true;
            at++;
        }
        if (format[at] === '0')
        {
            zeroPad = true;
            at++;
        }
        let width = 0;
        while (isDigit(format[at]))
        {
            width = width * 10 + Number(format[at++]);
        }
        let precision = 0;
        if (format[at] === '.')
        {
            at++;
            while (isDigit(format[at]))
            {
                precision = precision * 10 + Number(format[at++]);
            }
        }
        let long = false;
        let short = false;
        let wideSize = false;
        let sixtyFour = false;
        if (format[at] === 'l')
        {
            long = true;
            at++;
        }
        else if (format[at] === 'h')
        {
            short = true;
            at++;
        }
        else if (format[at] === 'w')
        {
            wideSize = true;
            at++;
        }
        else if (format[at] === 'I')
        {
            if (format.startsWith('64', at + 1))
            {
                sixtyFour = true;
                at += 3;
            }
            else if (format.startsWith('32', at + 1))
            {
                at += 3;
            }
            else
            {
                // A pointer's width, which is 32 bits here.
                at++;
            }
        }
        /** @type {Kind} */
        let kind = 'unknown';
        let upper = false;
        switch (format[at])
        {
            case 'c':
                kind = wide ? (short ? 'char' : 'wchar') : (long ? 'wchar' : 'char');
                break;
            case 'C':
                kind = wide ? (long ? 'wchar' : 'char') : (short ? 'char' : 'wchar');
                break;
            case 'd':
            case 'i':
                kind = 'signed';
                break;
            case 's':
                kind = wide ? (short && !wideSize ? 'string' : 'wstring')
                    : (long || wideSize ? 'wstring' : 'string');
                break;
            case 'S':
                kind = wide ? (long || wideSize ? 'wstring' : 'string')
                    : (short || wideSize ? 'string' : 'wstring');
                break;
            case 'u':
                kind = 'unsigned';
                break;
            case 'p':
                width = 8;
                zeroPad = true;
                upper = true;
                kind = 'hex';
                break;
            case 'X':
                upper = true;
                kind = 'hex';
                break;
            case 'x':
                kind = 'hex';
                break;
            default:
                break;
        }
        if (left)
        {
            zeroPad = false;
        }
        if (kind === 'unknown')
        {
            // The specification is used up, its padding put down, and the
            // character it stopped at is printed as an ordinary one -- or,
            // at the end of the format, nothing is.
            if (!left)
            {
                out += ' '.repeat(Math.max(0, width - precision));
            }
            continue;
        }
        at++;

        let body;
        if (kind === 'char' || kind === 'wchar')
        {
            const value = take();
            body = kind === 'char' ? options.byteChar(value & 0xff)
                : String.fromCharCode(value & 0xffff);
        }
        else if (kind === 'string' || kind === 'wstring')
        {
            const address = take() >>> 0;
            const text = kind === 'string' ? options.readString(address)
                : options.readWideString(address);
            body = precision > 0 ? text.slice(0, precision) : text;
        }
        else
        {
            const digits = numberOf(kind, sixtyFour, take, upper);
            const negative = digits.startsWith('-');
            const magnitude = negative ? digits.slice(1) : digits;
            // The sign is one of the characters the count of digits is
            // measured against; a radix mark is not.
            let count = Math.max(precision, digits.length);
            if (zeroPad && width > count)
            {
                count = width;
            }
            const lead = (kind === 'hex' && prefix ? (upper ? '0X' : '0x') : '')
                + (negative ? '-' : '');
            body = '0'.repeat(Math.max(0, count - digits.length)) + magnitude;
            const fill = ' '.repeat(Math.max(0, width - count));
            out += left ? lead + body + fill : fill + lead + body;
            continue;
        }
        const fill = ' '.repeat(Math.max(0, width - body.length));
        out += left ? body + fill : fill + body;
    }
    return out.slice(0, WSPRINTF_LIMIT - 1);
}

/** @param {string | undefined} character */
const isDigit = character=>character !== undefined && character >= '0' && character <= '9';

/**
 * A number's digits, a minus sign in front of a negative signed one.
 *
 * @param {'signed' | 'unsigned' | 'hex'} kind @param {boolean} sixtyFour
 * @param {() => number} take @param {boolean} upper
 */
function numberOf(kind, sixtyFour, take, upper){
    let value;
    if (sixtyFour)
    {
        const low = BigInt(take() >>> 0);
        const high = BigInt(take() >>> 0);
        value = (high << 32n) | low;
        if (kind === 'signed')
        {
            value = BigInt.asIntN(64, value);
        }
    }
    else
    {
        const slot = take();
        value = BigInt(kind === 'signed' ? slot | 0 : slot >>> 0);
    }
    const negative = value < 0n;
    const magnitude = negative ? -value : value;
    const text = kind === 'hex' ? magnitude.toString(16) : magnitude.toString(10);
    return (negative ? '-' : '') + (upper ? text.toUpperCase() : text);
}
