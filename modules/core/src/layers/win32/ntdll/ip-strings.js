/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * The IP address strings ntdll writes and reads (ip2string.h): IPv4 in dotted
 * decimal, IPv6 in RFC 4291's text with its longest run of zero groups as
 * `::`, each with an optional port (`a.b.c.d:port`, `[addr%scope]:port`).
 *
 * The A and W forms are one function each, over characters: an address and a
 * port in network byte order, as IN_ADDR, IN6_ADDR and the port arguments are.
 *
 * Reading IPv4 has a strict form - four decimal parts - and a loose one, the
 * inet_addr grammar: one to four parts, each decimal, octal (a leading 0) or
 * hexadecimal (0x), the last filling the bytes the earlier ones left.
 */

const STATUS_SUCCESS = 0;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_ACCESS_VIOLATION = 0xc0000005;

/**
 * IPv4 as text.
 *
 * @param {Uint8Array} bytes  four, network order
 */
export function ipv4ToString(bytes){
    return [...bytes.subarray(0, 4)].join('.');
}

/**
 * IPv6 as text: lower-case groups without leading zeros, the longest run of
 * two or more zero groups (the first of equal ones) as `::`, and the last four
 * bytes in dotted decimal where the address is an IPv4 one mapped (`::ffff:`),
 * compatible (`::`, past the first 96 zero bits, not `::` or `::1`) or
 * translated (`::ffff:0:`).
 *
 * @param {Uint8Array} bytes  sixteen, network order
 */
export function ipv6ToString(bytes){
    /** @type {number[]} */
    const groups = [];
    for (let at = 0; at < 16; at += 2)
    {
        groups.push(bytes[at] << 8 | bytes[at + 1]);
    }
    const zeros = (/** @type {number} */ from, /** @type {number} */ to)=>
        groups.slice(from, to).every(group=>group === 0);
    const tail = ipv4ToString(bytes.subarray(12, 16));
    // A mapped address whose IPv4 part starts with a zero group is written
    // as groups.
    if (zeros(0, 5) && groups[5] === 0xffff && groups[6] !== 0)
    {
        return `::ffff:${tail}`;
    }
    if (zeros(0, 4) && groups[4] === 0xffff && groups[5] === 0)
    {
        return `::ffff:0:${tail}`;
    }
    if (zeros(0, 6) && groups[6] !== 0)
    {
        return `::${tail}`;
    }
    // An ISATAP address keeps its IPv4 part dotted too.
    const isatap = (groups[4] === 0 || groups[4] === 0x200) && groups[5] === 0x5efe;
    let best = -1;
    let length = 1;
    for (let at = 0; at < 8; at++)
    {
        let end = at;
        while (end < 8 && groups[end] === 0)
        {
            end++;
        }
        if (end - at > length)
        {
            best = at;
            length = end - at;
        }
        at = Math.max(at, end);
    }
    const text = (/** @type {number[]} */ part)=>part.map(group=>group.toString(16)).join(':');
    if (isatap)
    {
        const head = groups.slice(0, 6);
        return `${best >= 0 && best + length <= 6
            ? `${text(head.slice(0, best))}::${text(head.slice(best + length))}`
            : text(head)}:${tail}`;
    }
    return best < 0 ? text(groups)
        : `${text(groups.slice(0, best))}::${text(groups.slice(best + length))}`;
}

/**
 * One number as ntdll reads it: `0x` before hexadecimal digits, `0` before a
 * decimal digit an octal number, else decimal. The digits accumulate in 32
 * bits, and one that would wrap the value is a fault where it stands. A
 * decimal digit the radix has no room for is a fault if it is the first after
 * the prefix, and otherwise ends the number. Strict reading refuses a prefix,
 * the fault just past it.
 *
 * @param {string} text @param {number} from @param {boolean} strict
 * @returns {{ value: number, end: number } | { error: true, end: number } | null}
 *          null for no number there
 */
function readNumber(text, from, strict){
    let at = from;
    let radix = 10;
    if (text[at] === '0' && (text[at + 1] === 'x' || text[at + 1] === 'X'))
    {
        radix = 16;
        at += 2;
    }
    else if (text[at] === '0' && /[0-9]/.test(text[at + 1] ?? ''))
    {
        radix = 8;
        at += 1;
    }
    if (strict && radix !== 10)
    {
        return { error: true, end: at };
    }
    let value = 0;
    let digits = 0;
    for (; at < text.length; at++)
    {
        const character = text[at];
        const digit = radix === 16 ? parseInt(character, 16)
            : (/[0-9]/.test(character) ? Number(character) : NaN);
        if (Number.isNaN(digit))
        {
            break;
        }
        if (digit >= radix)
        {
            if (digits === 0)
            {
                return { error: true, end: at };
            }
            break;
        }
        const next = (value * radix + digit) >>> 0;
        if (next < value)
        {
            return { error: true, end: at };
        }
        value = next;
        digits++;
    }
    if (digits === 0)
    {
        // A prefix with nothing after it is a fault past the prefix.
        return radix === 10 ? null : { error: true, end: at };
    }
    return { value, end: at };
}

/**
 * Reads an IPv4 address at the start of `text`. Where the reading stopped is
 * part of the answer: a part missing at a dot is a fault past that dot, a dot
 * after the fourth part a fault at it, and the parts' sizes are judged once
 * all of them are read.
 *
 * @param {string} text @param {boolean} strict  four decimal parts and nothing else
 * @returns {{ bytes: Uint8Array, end: number } | { error: true, end: number }}
 */
export function parseIpv4(text, strict){
    /** @type {number[]} */
    const parts = [];
    let at = 0;
    for (;;)
    {
        const part = readNumber(text, at, strict);
        if (part === null)
        {
            return { error: true, end: text[at] === '.' ? at + 1 : at };
        }
        if ('error' in part)
        {
            return part;
        }
        parts.push(part.value);
        at = part.end;
        if (text[at] !== '.')
        {
            break;
        }
        if (parts.length === 4)
        {
            return { error: true, end: at };
        }
        at++;
    }
    if (strict && parts.length !== 4)
    {
        return { error: true, end: at };
    }
    // The last part fills what the earlier ones did not: a.b.c, a.b, a.
    const leading = parts.slice(0, -1);
    const last = /** @type {number} */ (parts.at(-1));
    const room = 4 - leading.length;
    if (leading.some(value=>value > 255) || last >= 2 ** (8 * room))
    {
        return { error: true, end: at };
    }
    const bytes = new Uint8Array(4);
    leading.forEach((value, index)=>{
        bytes[index] = value;
    });
    for (let index = 0; index < room; index++)
    {
        bytes[3 - index] = Math.floor(last / 2 ** (8 * index)) & 0xff;
    }
    return { bytes, end: at };
}

/**
 * The digits of one radix at `from`: how many, their value and where they end.
 *
 * @param {string} text @param {number} from @param {10 | 16} radix
 */
function digitsAt(text, from, radix){
    let at = from;
    let value = 0;
    for (; at < text.length; at++)
    {
        const digit = radix === 16 ? parseInt(text[at], 16)
            : (/[0-9]/.test(text[at]) ? Number(text[at]) : NaN);
        if (Number.isNaN(digit))
        {
            break;
        }
        value = value * radix + digit;
    }
    return { count: at - from, value, end: at };
}

/**
 * Reads an IPv6 address at the start of `text` as ntdll does, into `bytes`.
 *
 * What it reads is stored as it is read: each group a following `:` closes,
 * each dotted byte a following `.` closes, so a reading that fails leaves the
 * groups before the fault in the caller's address. A `::` marks where the
 * groups after it go; only an address read whole moves them to its end and
 * zeroes the gap. A leading `::` stores a zero group of its own first.
 *
 * Where the reading stopped is the rest of the answer. A group of more than
 * four digits, or a dotted byte of more than three or past 255, is noticed
 * when the part that holds it ends: there, with the address ended, the
 * reading stops at it; with more to read it stops with no place at all
 * (`end` null). A last group written `0x...` ends at its `x`, its value the
 * hexadecimal after the prefix, held to a positive 32-bit number and cut to
 * 16 bits; an address that has one is refused by the Ex readers.
 *
 * @param {string} text
 * @param {Uint8Array} [bytes]  the caller's address as it was
 * @returns {{ bytes: Uint8Array, end: number | null, error?: true, prefixed?: true }}
 */
export function parseIpv6(text, bytes = new Uint8Array(16)){
    let at = 0;
    let stored = 0;
    let gap = -1;
    let dotted = 0;
    let tooBig = false;
    /** @param {number | null} end */
    const fail = end=>/** @type {const} */ ({ bytes, end, error: true });
    /** @param {number} value */
    const storeGroup = value=>{
        bytes[stored] = value >> 8 & 0xff;
        bytes[stored + 1] = value & 0xff;
    };
    const closeGap = ()=>{
        if (gap >= 0)
        {
            const after = bytes.slice(gap, stored);
            bytes.fill(0, gap);
            bytes.set(after, 16 - after.length);
        }
    };
    if (text[0] === ':')
    {
        if (text[1] !== ':')
        {
            return fail(0);
        }
        storeGroup(0);
        stored = 2;
        at = 1;
    }
    for (;;)
    {
        if (dotted === 0 && text[at] === ':')
        {
            if (gap >= 0)
            {
                return fail(at);
            }
            at++;
            gap = stored;
            if (stored === 14 || digitsAt(text, at, 16).count === 0)
            {
                break;
            }
        }
        const begin = at;
        if (dotted === 0 && stored <= (gap >= 0 ? 10 : 12))
        {
            const decimal = digitsAt(text, at, 10);
            if (decimal.count > 0 && text[decimal.end] === '.')
            {
                dotted = 1;
            }
        }
        if (dotted > 0)
        {
            const part = digitsAt(text, at, 10);
            if (part.count === 0)
            {
                return fail(at);
            }
            at = part.end;
            if (part.count > 3 || part.value > 255)
            {
                tooBig = true;
            }
            else
            {
                // A byte with no dot after it ends the address: the fourth,
                // and only where it fills the last place or a gap takes up
                // the room.
                if (text[at] !== '.' && (dotted < 4 || (stored < 15 && gap < 0)))
                {
                    return fail(at);
                }
                bytes[stored++] = part.value;
            }
            if (dotted === 4 || text[at] !== '.')
            {
                break;
            }
            dotted++;
        }
        else
        {
            const group = digitsAt(text, at, 16);
            if (group.count === 0)
            {
                return fail(at);
            }
            at = group.end;
            if (text[begin] === '0' && (text[begin + 1] === 'x' || text[begin + 1] === 'X'))
            {
                const end = begin + 1;
                if (stored < 14 && gap < 0)
                {
                    return fail(end);
                }
                const after = digitsAt(text, begin + 2, 16).value;
                storeGroup(Math.min(after, 0x7fffffff) & 0xffff);
                stored += 2;
                closeGap();
                return { bytes, end, prefixed: true };
            }
            if (text[at] !== ':' && stored < 14 && gap < 0)
            {
                return fail(at);
            }
            if (group.count > 4)
            {
                tooBig = true;
            }
            else
            {
                storeGroup(group.value);
            }
            stored += 2;
            if (text[at] !== ':' || (gap >= 0 && text[at + 1] === ':'))
            {
                break;
            }
        }
        if (stored === (gap >= 0 ? 14 : 16))
        {
            break;
        }
        if (tooBig)
        {
            return fail(null);
        }
        at++;
    }
    if (tooBig || (gap < 0 && stored < 16))
    {
        return fail(at);
    }
    closeGap();
    return { bytes, end: at };
}

/**
 * A port written after an address: `:` and a number read as an address part
 * is (decimal, octal or hexadecimal), up to 65535, ending the string.
 *
 * @param {string} text @param {number} from
 * @returns {number | null}  in host order; null for none or a bad one
 */
function portAt(text, from){
    const number = text[from] === ':' ? readNumber(text, from + 1, false) : null;
    // A port written is one: zero is none, and refused as a written one.
    if (!number || 'error' in number || number.end !== text.length
        || number.value > 0xffff || number.value === 0)
    {
        return null;
    }
    return number.value;
}

/**
 * @typedef {Object} IpStringHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * The calls, both widths of each.
 *
 * @param {IpStringHost} host
 */
export function createIpStringFunctions(host){
    /** @param {number} at */
    const dword = at=>new DataView(host.readMemory(at, 4).slice().buffer).getUint32(0, true);
    /** @param {number} at @param {number} value */
    const putDword = (at, value)=>host.writeMemory(at, Uint8Array.of(value & 0xff,
        value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24));
    /** @param {number} port  network order */
    const hostPort = port=>(port & 0xff) << 8 | port >> 8 & 0xff;

    /** @param {boolean} wide */
    const width = wide=>({
        unit: wide ? 2 : 1,
        /** @param {number} at @param {string} text  written with its terminator */
        write: (at, text)=>{
            const bytes = new Uint8Array((text.length + 1) * (wide ? 2 : 1));
            [...text].forEach((character, index)=>{
                if (wide)
                {
                    bytes[index * 2] = character.charCodeAt(0);
                }
                else
                {
                    bytes[index] = character.charCodeAt(0);
                }
            });
            host.writeMemory(at, bytes);
        },
        /** @param {number} at  read to its terminator, at most 128 characters */
        read: at=>{
            const raw = host.readMemory(at, 128 * (wide ? 2 : 1));
            let text = '';
            for (let index = 0; index < 128; index++)
            {
                const code = wide ? raw[index * 2] | raw[index * 2 + 1] << 8 : raw[index];
                if (code === 0)
                {
                    break;
                }
                text += String.fromCharCode(code);
            }
            return text;
        },
    });

    /**
     * An address's text written to a buffer, the pointer to its terminator
     * returned (the AddressToString forms): the Ex form's, with no port and
     * the longest text's room (16 characters, 46 for IPv6). A NULL buffer
     * is written nothing, and the pointer one before it comes back.
     *
     * @param {boolean} wide @param {(bytes: Uint8Array) => string} format @param {number} size
     */
    const toString = (wide, format, size)=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([address, buffer])=>{
            if ((buffer >>> 0) === 0 || (address >>> 0) === 0)
            {
                return ((buffer >>> 0) - width(wide).unit) >>> 0;
            }
            const text = format(host.readMemory(wholeAddress(address), size));
            width(wide).write(buffer >>> 0, text);
            return ((buffer >>> 0) + text.length * width(wide).unit) >>> 0;
        },
    });

    /**
     * The Ex forms: the text with its port, into a buffer of a length in
     * characters (the terminator counted), which is written back; too short a
     * buffer is STATUS_INVALID_PARAMETER with the length it needs.
     *
     * @param {boolean} wide @param {number} argBytes
     * @param {(args: number[]) => string} text
     * @param {number} bufferArg @param {number} lengthArg
     */
    const toStringEx = (wide, argBytes, text, bufferArg, lengthArg)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            const buffer = args[bufferArg] >>> 0;
            const length = args[lengthArg] >>> 0;
            if (args[0] === 0 || length === 0)
            {
                return STATUS_INVALID_PARAMETER;
            }
            const written = text(args);
            const needed = written.length + 1;
            const room = dword(length);
            putDword(length, needed);
            if (buffer === 0 || room < needed)
            {
                return STATUS_INVALID_PARAMETER;
            }
            width(wide).write(buffer, written);
            return STATUS_SUCCESS;
        },
    });

    /**
     * IPv4 text read: the address and, unless the caller passes no pointer
     * for it, where the reading stopped (the StringToAddress forms).
     *
     * @param {boolean} wide
     */
    const fromString4 = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([string, strict, terminator, address])=>{
            if ((string >>> 0) === 0 || (address >>> 0) === 0 || (terminator >>> 0) === 0)
            {
                return STATUS_ACCESS_VIOLATION;
            }
            const text = width(wide).read(string >>> 0);
            const read = parseIpv4(text, (strict & 0xff) !== 0);
            putDword(terminator >>> 0, (string >>> 0) + read.end * width(wide).unit);
            if ('error' in read)
            {
                return STATUS_INVALID_PARAMETER;
            }
            host.writeMemory(wholeAddress(address), read.bytes);
            return STATUS_SUCCESS;
        },
    });

    /** @param {boolean} wide */
    const fromString6 = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([string, terminator, address])=>{
            if ((string >>> 0) === 0 || (address >>> 0) === 0 || (terminator >>> 0) === 0)
            {
                return STATUS_ACCESS_VIOLATION;
            }
            const text = width(wide).read(string >>> 0);
            const read = parseIpv6(text, host.readMemory(wholeAddress(address), 16).slice());
            if (read.end !== null)
            {
                putDword(terminator >>> 0, (string >>> 0) + read.end * width(wide).unit);
            }
            host.writeMemory(wholeAddress(address), read.bytes);
            return read.error ? STATUS_INVALID_PARAMETER : STATUS_SUCCESS;
        },
    });

    /**
     * The Ex readers: the whole string an address and an optional port,
     * nothing after it.
     *
     * @param {boolean} wide
     */
    const fromString4Ex = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([string, strict, address, port])=>{
            if ((string >>> 0) === 0 || (address >>> 0) === 0 || (port >>> 0) === 0)
            {
                return STATUS_INVALID_PARAMETER;
            }
            const text = width(wide).read(string >>> 0);
            const read = parseIpv4(text, (strict & 0xff) !== 0);
            if ('error' in read)
            {
                return STATUS_INVALID_PARAMETER;
            }
            // The address is written before the port is read: a bad port
            // leaves it there, and the port untouched.
            host.writeMemory(wholeAddress(address), read.bytes);
            const number = read.end === text.length ? 0 : portAt(text, read.end);
            if (number === null)
            {
                return STATUS_INVALID_PARAMETER;
            }
            host.writeMemory(wholeAddress(port), Uint8Array.of(number >> 8, number & 0xff));
            return STATUS_SUCCESS;
        },
    });

    /** @param {boolean} wide */
    const fromString6Ex = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([string, address, scope, port])=>{
            if ((string >>> 0) === 0 || (address >>> 0) === 0 || (scope >>> 0) === 0
                || (port >>> 0) === 0)
            {
                return STATUS_INVALID_PARAMETER;
            }
            const text = width(wide).read(string >>> 0);
            const bracketed = text.startsWith('[');
            const inner = bracketed ? text.slice(1) : text;
            // The address is stored as it is read, whatever comes after it.
            const read = parseIpv6(inner, host.readMemory(wholeAddress(address), 16).slice());
            host.writeMemory(wholeAddress(address), read.bytes);
            if (read.error || read.prefixed || read.end === null)
            {
                return STATUS_INVALID_PARAMETER;
            }
            let at = read.end;
            let scopeId = 0;
            if (inner[at] === '%')
            {
                const named = digitsAt(inner, at + 1, 10);
                if (named.count === 0 || named.value > 0xffffffff)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                scopeId = named.value;
                at = named.end;
            }
            let number = 0;
            if (bracketed)
            {
                if (inner[at] !== ']')
                {
                    return STATUS_INVALID_PARAMETER;
                }
                at++;
                const written = at === inner.length ? 0 : portAt(inner, at);
                if (written === null)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                number = written;
            }
            else if (at !== inner.length)
            {
                return STATUS_INVALID_PARAMETER;
            }
            putDword(scope >>> 0, scopeId >>> 0);
            host.writeMemory(wholeAddress(port), Uint8Array.of(number >> 8, number & 0xff));
            return STATUS_SUCCESS;
        },
    });

    /** @param {number[]} args  address, port */
    const text4 = args=>{
        const address = ipv4ToString(host.readMemory(args[0] >>> 0, 4));
        const port = hostPort(args[1]);
        return port === 0 ? address : `${address}:${port}`;
    };
    /** @param {number[]} args  address, scope, port */
    const text6 = args=>{
        const address = ipv6ToString(host.readMemory(args[0] >>> 0, 16));
        const scoped = args[1] === 0 ? address : `${address}%${args[1] >>> 0}`;
        const port = hostPort(args[2]);
        return port === 0 ? scoped : `[${scoped}]:${port}`;
    };

    return {
        /** PSTR RtlIpv4AddressToStringA(const IN_ADDR *, PSTR) */
        RtlIpv4AddressToStringA: { ...toString(false, ipv4ToString, 4), returns: 'pointer' },
        RtlIpv4AddressToStringW: toString(true, ipv4ToString, 4),
        /** NTSTATUS RtlIpv4AddressToStringExA(const IN_ADDR *, USHORT Port, PSTR, PULONG) */
        RtlIpv4AddressToStringExA: toStringEx(false, 16, text4, 2, 3),
        RtlIpv4AddressToStringExW: toStringEx(true, 16, text4, 2, 3),
        /** NTSTATUS RtlIpv4StringToAddressA(PCSTR, BOOLEAN Strict, PCSTR *Terminator, IN_ADDR *) */
        RtlIpv4StringToAddressA: fromString4(false),
        RtlIpv4StringToAddressW: fromString4(true),
        /** NTSTATUS RtlIpv4StringToAddressExA(PCSTR, BOOLEAN Strict, IN_ADDR *, PUSHORT Port) */
        RtlIpv4StringToAddressExA: fromString4Ex(false),
        RtlIpv4StringToAddressExW: fromString4Ex(true),
        /** PSTR RtlIpv6AddressToStringA(const IN6_ADDR *, PSTR) */
        RtlIpv6AddressToStringA: { ...toString(false, ipv6ToString, 16), returns: 'pointer' },
        RtlIpv6AddressToStringW: toString(true, ipv6ToString, 16),
        /** NTSTATUS RtlIpv6AddressToStringExA(const IN6_ADDR *, ULONG ScopeId, USHORT Port,
         *   PSTR, PULONG) */
        RtlIpv6AddressToStringExA: toStringEx(false, 20, text6, 3, 4),
        RtlIpv6AddressToStringExW: toStringEx(true, 20, text6, 3, 4),
        /** NTSTATUS RtlIpv6StringToAddressA(PCSTR, PCSTR *Terminator, IN6_ADDR *) */
        RtlIpv6StringToAddressA: fromString6(false),
        RtlIpv6StringToAddressW: fromString6(true),
        /** NTSTATUS RtlIpv6StringToAddressExA(PCSTR, IN6_ADDR *, PULONG ScopeId, PUSHORT Port) */
        RtlIpv6StringToAddressExA: fromString6Ex(false),
        RtlIpv6StringToAddressExW: fromString6Ex(true),
    };
}
