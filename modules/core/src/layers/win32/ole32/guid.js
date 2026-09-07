/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GUIDs, in the two forms a program hands us: sixteen bytes in guest memory and
 * the braced string it writes into a registry key or a source file.
 *
 * The layout is the part that goes wrong. A GUID is not a flat byte string: the
 * first field is a little-endian DWORD, the next two are little-endian WORDs,
 * and only the last eight bytes are in the order they are printed. So the
 * example GUID {6B29FC40-CA47-1067-B31D-00DD010662DA} begins with the byte 0x40
 * and not 0x6B. Reading it as sixteen printed bytes produces a GUID that is
 * wrong in its first eight and right in its last eight, which no comparison
 * accepts and which surfaces as "class not registered" rather than as anything
 * naming byte order.
 *
 * The canonical uppercase string is this layer's identity for a GUID: it is what
 * a class registry is keyed by and what two interfaces are compared as. Bytes
 * only exist at the guest boundary.
 */

/** sizeof(GUID). */
export const GUID_SIZE = 16;

/**
 * Characters in the canonical form, terminator excluded: 32 hex digits, four
 * hyphens, two braces. StringFromGUID2 promises exactly this many.
 */
export const GUID_STRING_LENGTH = 38;

/** GUID_NULL, in the canonical form everything here speaks. */
export const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';

/**
 * The canonical form and nothing else. The braces are required -- a bare
 * 36-character GUID is not what CLSIDFromString accepts -- and the case is not,
 * because a program is as likely to have written the string in lowercase.
 */
const GUID_PATTERN =
    /^\{([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{12})\}$/;

/**
 * @typedef {Object} GuidMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/** @param {number} value @param {number} digits */
const hex = (value, digits)=>value.toString(16).toUpperCase().padStart(digits, '0');

/**
 * @param {Uint8Array} bytes  At least GUID_SIZE bytes, starting at the GUID.
 * @returns {string} the canonical uppercase form, braces included
 */
export function formatGuid(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, GUID_SIZE);
    let tail = '';
    for (let index = 8; index < GUID_SIZE; index++)
    {
        tail += hex(bytes[index], 2);
    }
    return `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}`
        + `-${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
}

/**
 * @param {string} text
 * @returns {Uint8Array | null} the sixteen bytes, or null if the string is not a GUID
 */
export function parseGuid(text){
    const match = GUID_PATTERN.exec(text);
    if (!match)
    {
        return null;
    }
    const bytes = new Uint8Array(GUID_SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, parseInt(match[1], 16), true);
    view.setUint16(4, parseInt(match[2], 16), true);
    view.setUint16(6, parseInt(match[3], 16), true);
    const tail = match[4] + match[5];
    for (let index = 0; index < 8; index++)
    {
        bytes[8 + index] = parseInt(tail.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

/**
 * The form a GUID is stored and compared under. Going through the bytes rather
 * than upper-casing the string means a malformed one is rejected here instead of
 * becoming a registry key nothing will ever match.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function canonicalGuid(text){
    const bytes = parseGuid(text);
    return bytes === null ? null : formatGuid(bytes);
}

/**
 * @param {GuidMemory} memory
 * @param {number} address
 * @returns {string}
 */
export function readGuid(memory, address){
    return formatGuid(memory.readMemory(address, GUID_SIZE));
}

/**
 * @param {GuidMemory} memory
 * @param {number} address
 * @param {string} guid  Canonical form; anything else writes nothing.
 * @returns {boolean}
 */
export function writeGuid(memory, address, guid){
    const bytes = parseGuid(guid);
    if (bytes === null)
    {
        return false;
    }
    memory.writeMemory(address, bytes);
    return true;
}
