/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

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
    if (zeros(0, 5) && groups[5] === 0xffff)
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
 * One number of an IPv4 address: its value and the characters it took, or
 * null for none there.
 *
 * @param {string} text @param {number} from @param {boolean} strict  decimal only
 */
function ipv4Part(text, from, strict){
    let at = from;
    let radix = 10;
    if (!strict && text[at] === '0')
    {
        if (text[at + 1] === 'x' || text[at + 1] === 'X')
        {
            radix = 16;
            at += 2;
        }
        else
        {
            radix = 8;
        }
    }
    const start = at;
    let value = 0;
    for (; at < text.length; at++)
    {
        const digit = parseInt(text[at], radix);
        if (Number.isNaN(digit))
        {
            break;
        }
        value = value * radix + digit;
        if (value > 0xffffffff)
        {
            return null;
        }
    }
    if (at === start && radix !== 8)
    {
        return null;
    }
    return { value, end: at };
}

/**
 * Reads an IPv4 address at the start of `text`.
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
        const part = ipv4Part(text, at, strict);
        if (!part)
        {
            return { error: true, end: at };
        }
        parts.push(part.value);
        at = part.end;
        if (text[at] !== '.' || parts.length === 4)
        {
            break;
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
 * Reads an IPv6 address at the start of `text`: hexadecimal groups, one `::`
 * at most, the last 32 bits in dotted decimal if they are written so.
 *
 * @param {string} text
 * @returns {{ bytes: Uint8Array, end: number } | { error: true, end: number }}
 */
export function parseIpv6(text){
    /** @type {number[]} */
    const head = [];
    /** @type {number[]} */
    const tail = [];
    let gap = false;
    let at = 0;
    if (text.startsWith('::'))
    {
        gap = true;
        at = 2;
    }
    for (;;)
    {
        const groups = gap ? tail : head;
        if (head.length + tail.length >= 8)
        {
            break;
        }
        // Dotted decimal ends the address, as its last two groups.
        const dotted = /^[0-9]+\./.test(text.slice(at)) ? parseIpv4(text.slice(at), true) : null;
        if (dotted && !('error' in dotted) && head.length + tail.length <= 6)
        {
            const { bytes } = dotted;
            groups.push(bytes[0] << 8 | bytes[1], bytes[2] << 8 | bytes[3]);
            at += dotted.end;
            break;
        }
        const group = /^[0-9a-fA-F]{1,4}/.exec(text.slice(at));
        if (!group)
        {
            if (groups.length === 0 && gap)
            {
                break;
            }
            return { error: true, end: at };
        }
        groups.push(parseInt(group[0], 16));
        at += group[0].length;
        if (text.startsWith('::', at) && !gap)
        {
            gap = true;
            at += 2;
            continue;
        }
        if (text.startsWith('::', at))
        {
            // A second gap: no address has two.
            return { error: true, end: at };
        }
        if (text[at] !== ':')
        {
            break;
        }
        at++;
    }
    const total = head.length + tail.length;
    if (gap ? total > 7 : total !== 8)
    {
        return { error: true, end: at };
    }
    const groups = [...head, ...new Array(8 - total).fill(0), ...tail];
    const bytes = new Uint8Array(16);
    groups.forEach((group, index)=>{
        bytes[index * 2] = group >> 8;
        bytes[index * 2 + 1] = group & 0xff;
    });
    return { bytes, end: at };
}

/**
 * A port written after an address, `:port` in decimal, up to 65535.
 *
 * @param {string} text @param {number} from
 * @returns {number | null}  in host order; null for none or a bad one
 */
function portAt(text, from){
    const written = /^:([0-9]{1,5})$/.exec(text.slice(from));
    // A port written is one: zero is none, and refused as a written one.
    if (!written || Number(written[1]) > 0xffff || Number(written[1]) === 0)
    {
        return null;
    }
    return Number(written[1]);
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
            const text = format(host.readMemory(address >>> 0, size));
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
            host.writeMemory(address >>> 0, read.bytes);
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
            const read = parseIpv6(text);
            putDword(terminator >>> 0, (string >>> 0) + read.end * width(wide).unit);
            if ('error' in read)
            {
                return STATUS_INVALID_PARAMETER;
            }
            host.writeMemory(address >>> 0, read.bytes);
            return STATUS_SUCCESS;
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
            host.writeMemory(address >>> 0, read.bytes);
            const number = read.end === text.length ? 0 : portAt(text, read.end);
            if (number === null)
            {
                return STATUS_INVALID_PARAMETER;
            }
            host.writeMemory(port >>> 0, Uint8Array.of(number >> 8, number & 0xff));
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
            const read = parseIpv6(inner);
            if ('error' in read)
            {
                return STATUS_INVALID_PARAMETER;
            }
            let at = read.end;
            let scopeId = 0;
            const named = /^%([0-9]{1,10})/.exec(inner.slice(at));
            if (named)
            {
                scopeId = Number(named[1]);
                at += named[0].length;
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
            else if (at !== inner.length || scopeId > 0xffffffff)
            {
                return STATUS_INVALID_PARAMETER;
            }
            host.writeMemory(address >>> 0, read.bytes);
            putDword(scope >>> 0, scopeId >>> 0);
            host.writeMemory(port >>> 0, Uint8Array.of(number >> 8, number & 0xff));
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
