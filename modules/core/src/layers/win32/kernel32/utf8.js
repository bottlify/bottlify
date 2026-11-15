/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * UTF-8, read and written as Windows does: one codec for MultiByteToWideChar,
 * WideCharToMultiByte and ntdll's RtlUTF8ToUnicodeN and RtlUnicodeToUTF8N, so
 * the two layers cannot disagree about where a malformed sequence's U+FFFD
 * goes. Each answer says whether anything was replaced: the Rtl calls report
 * it as STATUS_SOME_NOT_MAPPED, the kernel32 ones fail on it when asked to.
 */

const REPLACEMENT = 0xfffd;

/**
 * UTF-16 units as UTF-8, a unit that is half a pair alone as U+FFFD.
 *
 * @param {number[]} units
 * @returns {{ bytes: number[][], unmapped: boolean }}  one array a character
 */
export function utf8FromUnits(units){
    /** @type {number[][]} */
    const bytes = [];
    let unmapped = false;
    for (let at = 0; at < units.length; at++)
    {
        let code = units[at];
        if (code >= 0xd800 && code <= 0xdbff && units[at + 1] >= 0xdc00 && units[at + 1] <= 0xdfff)
        {
            code = 0x10000 + ((code - 0xd800) << 10) + (units[at + 1] - 0xdc00);
            at++;
        }
        else if (code >= 0xd800 && code <= 0xdfff)
        {
            code = REPLACEMENT;
            unmapped = true;
        }
        if (code < 0x80)
        {
            bytes.push([code]);
        }
        else if (code < 0x800)
        {
            bytes.push([0xc0 | code >> 6, 0x80 | code & 0x3f]);
        }
        else if (code < 0x10000)
        {
            bytes.push([0xe0 | code >> 12, 0x80 | code >> 6 & 0x3f, 0x80 | code & 0x3f]);
        }
        else
        {
            bytes.push([0xf0 | code >> 18, 0x80 | code >> 12 & 0x3f, 0x80 | code >> 6 & 0x3f,
                0x80 | code & 0x3f]);
        }
    }
    return { bytes, unmapped };
}

/**
 * UTF-8 as UTF-16 units, as Windows reads it: a lead byte announces the
 * sequence; a second byte that is a continuation but out of the lead's range
 * (an overlong form, a surrogate, past U+10FFFF) is taken with the lead as
 * one U+FFFD; a sequence cut short is one U+FFFD for what it had; any other
 * byte that cannot start a character is a U+FFFD of its own.
 *
 * @param {Uint8Array} bytes
 * @returns {{ units: number[][], unmapped: boolean }}  one array a character
 */
export function unitsFromUtf8(bytes){
    /** @type {number[][]} */
    const units = [];
    let unmapped = false;
    const bad = ()=>{
        units.push([REPLACEMENT]);
        unmapped = true;
    };
    /** @param {number} at */
    const continuation = at=>at < bytes.length && (bytes[at] & 0xc0) === 0x80;
    let at = 0;
    while (at < bytes.length)
    {
        const lead = bytes[at];
        if (lead < 0x80)
        {
            units.push([lead]);
            at++;
            continue;
        }
        const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3
            : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
        if (length === 0)
        {
            bad();
            at++;
            continue;
        }
        const [low, high] = lead === 0xe0 ? [0xa0, 0xbf] : lead === 0xed ? [0x80, 0x9f]
            : lead === 0xf0 ? [0x90, 0xbf] : lead === 0xf4 ? [0x80, 0x8f] : [0x80, 0xbf];
        if (!continuation(at + 1))
        {
            bad();
            at++;
            continue;
        }
        if (bytes[at + 1] < low || bytes[at + 1] > high)
        {
            bad();
            at += 2;
            continue;
        }
        let taken = 2;
        while (taken < length && continuation(at + taken))
        {
            taken++;
        }
        if (taken < length)
        {
            bad();
            at += taken;
            continue;
        }
        let code = lead & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
        for (let next = 1; next < length; next++)
        {
            code = code << 6 | bytes[at + next] & 0x3f;
        }
        units.push(code >= 0x10000
            ? [0xd800 + (code - 0x10000 >> 10), 0xdc00 + (code - 0x10000 & 0x3ff)] : [code]);
        at += length;
    }
    return { units, unmapped };
}
