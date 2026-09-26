/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Unicode translations a descriptor can be in: `_O_WTEXT`, `_O_U16TEXT`
 * and `_O_U8TEXT`. In each, the program reads and writes UTF-16 and the file
 * keeps it as UTF-16 or as UTF-8, LF as CR LF as in text mode. A file begins
 * with a byte-order mark saying which, and the mark, when there is one,
 * decides how the file is read whichever translation it was opened in.
 */

export const O_WTEXT = 0x10000;
export const O_U16TEXT = 0x20000;
export const O_U8TEXT = 0x40000;
export const O_UNICODE = [O_WTEXT, O_U16TEXT, O_U8TEXT];

const CR = 0x0d;
const LF = 0x0a;
const REPLACEMENT = 0xfffd;

/**
 * How a file keeps the program's UTF-16: as UTF-16LE, as UTF-8, or a byte
 * to a character, which is what `_O_WTEXT` reads a file with no mark as.
 *
 * @typedef {'utf16' | 'utf8' | 'ansi'} Encoding
 */

/** @type {Record<Encoding, number[]>} */
const MARKS = { utf16: [0xff, 0xfe], utf8: [0xef, 0xbb, 0xbf], ansi: [] };

/**
 * How a translation keeps text it writes.
 *
 * @param {number} unicode One of O_UNICODE.
 * @returns {Encoding}
 */
export const encodingOf = unicode=>(unicode === O_U8TEXT ? 'utf8' : 'utf16');

/**
 * How a translation reads a file whose first bytes carry no mark.
 *
 * @param {number} unicode One of O_UNICODE.
 * @returns {Encoding}
 */
export const unmarkedEncodingOf = unicode=>(unicode === O_WTEXT ? 'ansi' : encodingOf(unicode));

/** @param {Encoding} encoding */
export const markOf = encoding=>Uint8Array.from(MARKS[encoding]);

/**
 * The encoding a file's first bytes announce, and the length of the mark.
 *
 * @param {Uint8Array} head
 * @returns {{ encoding: Encoding, length: number } | null}
 */
export function markIn(head){
    for (const encoding of /** @type {Encoding[]} */ (['utf8', 'utf16']))
    {
        const mark = MARKS[encoding];
        if (head.length >= mark.length && mark.every((byte, at)=>head[at] === byte))
        {
            return { encoding, length: mark.length };
        }
    }
    return null;
}

/** @param {number} unit */
const isHigh = unit=>unit >= 0xd800 && unit <= 0xdbff;

/** @param {number} unit */
const isLow = unit=>unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The program's UTF-16 as the file keeps it, each LF preceded by CR, and for
 * each unit the length of the bytes up to and including it -- what a short
 * write is counted back in. A pair of surrogates is one character and ends
 * where its second unit does; a surrogate alone is U+FFFD in UTF-8, and a
 * character past Latin-1 is '?' a byte to a character.
 *
 * @param {number[]} units @param {Encoding} encoding
 */
export function encodeUnits(units, encoding){
    /** @type {number[]} */
    const bytes = [];
    /** @type {number[]} */
    const ends = [];
    /** @param {number} code */
    const put = code=>{
        if (encoding === 'utf16')
        {
            bytes.push(code & 0xff, code >>> 8 & 0xff);
        }
        else if (encoding === 'ansi')
        {
            bytes.push(code > 0xff ? 0x3f : code);
        }
        else if (code < 0x80)
        {
            bytes.push(code);
        }
        else if (code < 0x800)
        {
            bytes.push(0xc0 | code >>> 6, 0x80 | code & 0x3f);
        }
        else if (code < 0x10000)
        {
            bytes.push(0xe0 | code >>> 12, 0x80 | code >>> 6 & 0x3f, 0x80 | code & 0x3f);
        }
        else
        {
            bytes.push(0xf0 | code >>> 18, 0x80 | code >>> 12 & 0x3f,
                0x80 | code >>> 6 & 0x3f, 0x80 | code & 0x3f);
        }
    };
    for (let at = 0; at < units.length; at++)
    {
        const unit = units[at];
        if (unit === LF)
        {
            put(CR);
        }
        if (encoding === 'utf8' && isHigh(unit) && isLow(units[at + 1]))
        {
            put(0x10000 + (unit - 0xd800 << 10) + (units[at + 1] - 0xdc00));
            ends.push(bytes.length, bytes.length);
            at++;
            continue;
        }
        put(encoding === 'utf8' && (isHigh(unit) || isLow(unit)) ? REPLACEMENT : unit);
        ends.push(bytes.length);
    }
    return { bytes: Uint8Array.from(bytes), ends };
}

/**
 * One well-formed UTF-8 sequence at `at`: its code point and length, or null
 * for a byte that begins none -- which is U+FFFD and takes that byte alone.
 *
 * @param {Uint8Array} bytes @param {number} at
 */
function utf8At(bytes, at){
    const lead = bytes[at];
    if (lead < 0x80)
    {
        return { code: lead, length: 1 };
    }
    const length = lead >= 0xc2 && lead <= 0xdf ? 2
        : lead >= 0xe0 && lead <= 0xef ? 3
            : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (length === 0 || at + length > bytes.length)
    {
        return null;
    }
    // The second byte's range is narrower after the leads that would
    // otherwise spell an overlong form, a surrogate or a code point past
    // U+10FFFF.
    const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
    const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
    let code = lead & (0x7f >> length);
    for (let next = 1; next < length; next++)
    {
        const byte = bytes[at + next];
        if (byte < (next === 1 ? low : 0x80) || byte > (next === 1 ? high : 0xbf))
        {
            return null;
        }
        code = code << 6 | byte & 0x3f;
    }
    return { code, length };
}

/**
 * File bytes as the UTF-16 units they keep, each with the offset just past
 * the bytes it came from; the two units of one character end at the same
 * offset. An odd byte at the end of UTF-16 is not a unit yet.
 *
 * @param {Uint8Array} bytes @param {Encoding} encoding
 */
export function decodeUnits(bytes, encoding){
    /** @type {number[]} */
    const units = [];
    /** @type {number[]} */
    const ends = [];
    if (encoding === 'utf16')
    {
        for (let at = 0; at + 1 < bytes.length; at += 2)
        {
            units.push(bytes[at] | bytes[at + 1] << 8);
            ends.push(at + 2);
        }
        return { units, ends };
    }
    for (let at = 0; at < bytes.length;)
    {
        const found = encoding === 'ansi'
            ? { code: bytes[at], length: 1 }
            : utf8At(bytes, at) ?? { code: REPLACEMENT, length: 1 };
        at += found.length;
        if (found.code > 0xffff)
        {
            const above = found.code - 0x10000;
            units.push(0xd800 + (above >>> 10), 0xdc00 + (above & 0x3ff));
            ends.push(at, at);
        }
        else
        {
            units.push(found.code);
            ends.push(at);
        }
    }
    return { units, ends };
}

/**
 * The program's UTF-16 in guest bytes, as units.
 *
 * @param {Uint8Array} bytes
 */
export function unitsOf(bytes){
    /** @type {number[]} */
    const units = [];
    for (let at = 0; at + 1 < bytes.length; at += 2)
    {
        units.push(bytes[at] | bytes[at + 1] << 8);
    }
    return units;
}

/**
 * Units as the string they spell, for the console.
 *
 * @param {number[]} units
 */
export function textOfUnits(units){
    let text = '';
    for (let at = 0; at < units.length; at += 0x2000)
    {
        text += String.fromCharCode(...units.slice(at, at + 0x2000));
    }
    return text;
}

/**
 * Units as the guest bytes of UTF-16LE.
 *
 * @param {number[]} units
 */
export function bytesOfUnits(units){
    const bytes = new Uint8Array(units.length * 2);
    units.forEach((unit, at)=>{
        bytes[at * 2] = unit & 0xff;
        bytes[at * 2 + 1] = unit >>> 8;
    });
    return bytes;
}

/**
 * Up to `limit` units of what `decodeUnits` found, CR LF folded to LF, and
 * the offset just past what they took. A character's two units go together
 * or not at all.
 *
 * @param {{ units: number[], ends: number[] }} decoded @param {number} limit
 */
export function foldUnits({ units, ends }, limit){
    /** @type {number[]} */
    const out = [];
    let consumed = 0;
    for (let at = 0; at < units.length && out.length < limit;)
    {
        if (units[at] === CR && units[at + 1] === LF)
        {
            out.push(LF);
            consumed = ends[at + 1];
            at += 2;
            continue;
        }
        const whole = at + 1 < units.length && ends[at] === ends[at + 1] ? 2 : 1;
        if (out.length + whole > limit)
        {
            break;
        }
        out.push(...units.slice(at, at + whole));
        consumed = ends[at + whole - 1];
        at += whole;
    }
    return { units: out, consumed };
}
