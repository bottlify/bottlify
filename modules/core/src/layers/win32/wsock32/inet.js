/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Addresses as inet_pton reads them and inet_ntop writes them: IPv4 as four
 * decimal parts and nothing else (inet_addr's octal, hex and short forms are
 * not presentation format), IPv6 in RFC 4291's text forms -- a `::` once, a
 * dotted IPv4 tail -- written back in RFC 5952's canonical one.
 */

/**
 * The four bytes of a dotted-decimal address, or null.
 *
 * @param {string} text
 * @returns {Uint8Array | null}
 */
export function parseIpv4Text(text){
    const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
    if (!parts)
    {
        return null;
    }
    const bytes = parts.slice(1).map(Number);
    return bytes.every(byte=>byte <= 255) ? Uint8Array.from(bytes) : null;
}

/**
 * The sixteen bytes of an IPv6 address, or null.
 *
 * @param {string} text
 * @returns {Uint8Array | null}
 */
export function parseIpv6Text(text){
    if (text.split('::').length > 2)
    {
        return null;
    }
    /** @param {string} part @returns {number[] | null} the 16-bit groups */
    const groups = part=>{
        if (part === '')
        {
            return [];
        }
        const pieces = part.split(':');
        /** @type {number[]} */
        const out = [];
        for (const [index, piece] of pieces.entries())
        {
            if (index === pieces.length - 1 && piece.includes('.'))
            {
                const four = parseIpv4Text(piece);
                if (!four)
                {
                    return null;
                }
                out.push(four[0] << 8 | four[1], four[2] << 8 | four[3]);
            }
            else if (/^[0-9a-fA-F]{1,4}$/.test(piece))
            {
                out.push(parseInt(piece, 16));
            }
            else
            {
                return null;
            }
        }
        return out;
    };
    const [head, tail] = text.split('::');
    const front = groups(head);
    const back = tail === undefined ? [] : groups(tail);
    if (!front || !back)
    {
        return null;
    }
    // A dotted tail is only the address's last 32 bits, never in its front half.
    if (tail !== undefined && head.includes('.'))
    {
        return null;
    }
    const total = front.length + back.length;
    if (tail === undefined ? total !== 8 : total > 7)
    {
        return null;
    }
    const all = [...front, ...new Array(8 - total).fill(0), ...back];
    const bytes = new Uint8Array(16);
    all.forEach((group, index)=>{
        bytes[index * 2] = group >> 8;
        bytes[index * 2 + 1] = group & 0xff;
    });
    return bytes;
}

/**
 * An IPv6 address in RFC 5952's form: lower-case hex without leading zeros,
 * the longest run of two or more zero groups (the first of equal ones) as
 * `::`, and an IPv4-mapped address's last 32 bits dotted.
 *
 * @param {Uint8Array} bytes
 */
export function formatIpv6Text(bytes){
    const groups = Array.from({ length: 8 },
        (_, index)=>bytes[index * 2] << 8 | bytes[index * 2 + 1]);
    const mapped = groups.slice(0, 5).every(group=>group === 0) && groups[5] === 0xffff;
    const shown = mapped ? groups.slice(0, 6) : groups;
    let best = -1;
    let bestLength = 1;
    for (let at = 0; at < shown.length;)
    {
        let end = at;
        while (end < shown.length && shown[end] === 0)
        {
            end++;
        }
        if (end - at > bestLength)
        {
            best = at;
            bestLength = end - at;
        }
        at = end === at ? at + 1 : end;
    }
    const hex = (/** @type {number[]} */ list)=>list.map(group=>group.toString(16)).join(':');
    let text = best < 0 ? hex(shown)
        : `${hex(shown.slice(0, best))}::${hex(shown.slice(best + bestLength))}`;
    if (mapped)
    {
        text += `${text.endsWith(':') ? '' : ':'}${[...bytes.subarray(12)].join('.')}`;
    }
    return text;
}
