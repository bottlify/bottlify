/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A package's summary information: the property set in its
 * `\u0005SummaryInformation` stream -- the title and author a shell shows,
 * and what the installer itself reads there: the platform and languages
 * (the template, "Intel;1033"), the package code (the revision number), the
 * schema (the page count) and whether the files are compressed (the word
 * count).
 *
 * A property set is a header naming its sections by format ID, then each
 * section's list of property numbers and offsets and the typed values they
 * point at. Only the types a summary stream uses are read: 16- and 32-bit
 * integers, strings in the set's code page and FILETIMEs.
 */

import { decoderFor } from './database.js';

/** The property types a summary holds. */
export const VT = Object.freeze({ EMPTY: 0, I2: 2, I4: 3, LPSTR: 30, FILETIME: 64 });

/** The properties of a summary stream, by number. */
export const PID = Object.freeze({
    CODEPAGE: 1, TITLE: 2, SUBJECT: 3, AUTHOR: 4, KEYWORDS: 5, COMMENTS: 6, TEMPLATE: 7,
    LASTAUTHOR: 8, REVNUMBER: 9, EDITTIME: 10, LASTPRINTED: 11, CREATE_DTM: 12,
    LASTSAVE_DTM: 13, PAGECOUNT: 14, WORDCOUNT: 15, CHARCOUNT: 16, APPNAME: 18, SECURITY: 19,
});

/** The type each property must have; a value of another type is refused. */
export const PID_TYPES = Object.freeze({
    1: VT.I2, 2: VT.LPSTR, 3: VT.LPSTR, 4: VT.LPSTR, 5: VT.LPSTR, 6: VT.LPSTR, 7: VT.LPSTR,
    8: VT.LPSTR, 9: VT.LPSTR, 10: VT.FILETIME, 11: VT.FILETIME, 12: VT.FILETIME,
    13: VT.FILETIME, 14: VT.I4, 15: VT.I4, 16: VT.I4, 18: VT.LPSTR, 19: VT.I4,
});

/** The most properties a summary holds: every number above, and no more. */
export const MAX_SUMMARY_PROPERTIES = Object.keys(PID_TYPES).length;

/**
 * @typedef {{ type: number, value: number | bigint | string }} SummaryValue
 * @typedef {Map<number, SummaryValue>} Summary
 */

/**
 * @param {Uint8Array | null} bytes
 * @returns {Summary} empty when there is no stream or it is not a property set
 */
export function readSummary(bytes){
    /** @type {Summary} */
    const summary = new Map();
    if (!bytes || bytes.length < 48)
    {
        return summary;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== 0xfffe || view.getUint32(24, true) < 1)
    {
        return summary;
    }
    const section = view.getUint32(44, true);
    if (section + 8 > bytes.length)
    {
        return summary;
    }
    const count = view.getUint32(section + 4, true);
    /** @type {[number, number][]} */
    const entries = [];
    for (let index = 0; index < count && section + 16 + index * 8 <= bytes.length; index++)
    {
        entries.push([view.getUint32(section + 8 + index * 8, true),
            view.getUint32(section + 12 + index * 8, true)]);
    }
    // The code page first: the strings are in it.
    let codepage = 0;
    for (const [pid, offset] of entries)
    {
        if (pid === PID.CODEPAGE && section + offset + 6 <= bytes.length
            && view.getUint16(section + offset, true) === VT.I2)
        {
            codepage = view.getUint16(section + offset + 4, true);
        }
    }
    const decode = decoderFor(codepage);
    for (const [pid, offset] of entries)
    {
        const at = section + offset;
        if (at + 8 > bytes.length)
        {
            continue;
        }
        const type = view.getUint16(at, true);
        if (type === VT.I2)
        {
            summary.set(pid, { type, value: view.getInt16(at + 4, true) });
        }
        else if (type === VT.I4)
        {
            summary.set(pid, { type, value: view.getInt32(at + 4, true) });
        }
        else if (type === VT.FILETIME && at + 12 <= bytes.length)
        {
            summary.set(pid, { type, value: view.getBigUint64(at + 4, true) });
        }
        else if (type === VT.LPSTR)
        {
            const length = view.getUint32(at + 4, true);
            const text = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
            const end = text.indexOf(0);
            summary.set(pid, { type, value: decode(end < 0 ? text : text.subarray(0, end)) });
        }
    }
    return summary;
}
