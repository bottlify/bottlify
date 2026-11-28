/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The guest's memory as every win32 handler reads and writes it: the memory
 * layer's port at the process's width (`system/port.js`), and the process's
 * text beside it, which the port does not know (the ANSI page is kernel32's).
 * Built once per process and handed to each library (`host.guest`), and to
 * the layers beside it through its api.
 *
 * Text is one reader and one writer with the width a modifier (`text`,
 * `setText`: ANSI or UTF-16), and every A/W pair's guest text goes through
 * them; `cstr`, `wstr`, `writeAnsi` and `writeWide` are the two widths named.
 * A string read stops at its terminator or at `limit` bytes, whichever comes
 * first: a handler's limit is the most of a string it reads (a fixed char[32]
 * field holds exactly that, terminated or not), so a longer string is cut
 * there rather than refused out of the host. A counted string (a
 * UNICODE_STRING's buffer) is its length whole. Only memory that is not
 * there is a fault, as the processor's would be.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { GUID_SIZE, formatGuid, parseGuid } from '../../../system/guid.js';
import { createPort } from '../../../system/port.js';

/**
 * What the view is made over: the memory layer's api, or its accessors.
 *
 * @typedef {import('../../../system/port.js').PortMemory & {
 *     scanCString: (address: number, limit?: number) => { index: number },
 *     scanWideString: (address: number, limit?: number) => number }} GuestMemory
 */

/**
 * @typedef {Object} GuestText
 * @property {(address: number, wide: boolean, limit?: number) => Uint8Array} stringBytes
 *     A string's bytes before its terminator, or its first `limit` bytes (a
 *     whole number of units) where none comes first, in place: read before
 *     anything else runs, as `view` is. What `text` decodes, for a caller
 *     that decodes in a page of its own.
 * @property {(address: number, wide: boolean, limit?: number, counted?: boolean) => string} text
 *     A string in the ANSI page or, `wide`, in UTF-16: up to its terminator
 *     or `limit` bytes (not units), whichever comes first; `counted`, the
 *     `limit` bytes whole, as a counted string's length says, a terminator
 *     in them included, none read for a length of 0.
 * @property {(address: number, text: string, wide: boolean, room?: number) => number} setText
 *     The text in the ANSI page or, `wide`, in UTF-16, and a terminator of
 *     its width, cut to `room` with the terminator (bytes, or units `wide`,
 *     as an A or W function's count is); answers the bytes or units written
 *     before the terminator. Nothing is written for no room.
 * @property {(address: number, limit?: number) => string} cstr  `text` in ANSI
 * @property {(address: number, limit?: number) => string} wstr  `text` in UTF-16
 * @property {(address: number, text: string, room?: number) => number} writeAnsi
 *     `setText` in ANSI
 * @property {(address: number, text: string, room?: number) => number} writeWide
 *     `setText` in UTF-16
 * @property {(address: number) => string} guid  the GUID there, in its canonical form
 * @property {(address: number, guid: string) => boolean} setGuid
 *     The GUID's sixteen bytes; nothing is written for a string that is no GUID.
 */

/** @typedef {import('../../../system/port.js').Port & GuestText} Guest */

/**
 * A string's limit that reads it to its terminator however long it is: the
 * scan stops at its region's end, and a string running past it is a fault.
 */
export const WHOLE = 0x7ffffffe;

/** Units of a wide string put together before they are written: grown when one is longer. */
let units = new Uint8Array(512);

/**
 * The first `count` units of `text` and a terminator, little-endian, in
 * the one scratch buffer: written in one write, as the string was made.
 *
 * @param {string} text @param {number} count
 */
function unitBytes(text, count){
    if (units.length < (count + 1) * 2)
    {
        units = new Uint8Array((count + 1) * 4);
    }
    for (let at = 0; at < count; at++)
    {
        const unit = text.charCodeAt(at);
        units[at * 2] = unit & 0xff;
        units[at * 2 + 1] = unit >>> 8;
    }
    units[count * 2] = 0;
    units[count * 2 + 1] = 0;
    return units.subarray(0, (count + 1) * 2);
}

/** Units decoded at once: few enough for `String.fromCharCode`'s arguments. */
const TEXT_CHUNK = 4096;
/** Units put together where the bytes are not on a unit's boundary. */
const unitScratch = new Uint16Array(TEXT_CHUNK);

/**
 * Bytes as text of a width: the ANSI page's, or UTF-16 unit for unit (half a
 * surrogate pair is a unit of a Windows string, which a decoder would replace).
 *
 * @param {Uint8Array} bytes @param {boolean} wide
 */
function decode(bytes, wide){
    if (!wide)
    {
        return decodeAnsi(bytes);
    }
    const count = bytes.length >> 1;
    const aligned = (bytes.byteOffset & 1) === 0
        ? new Uint16Array(bytes.buffer, bytes.byteOffset, count) : null;
    let text = '';
    for (let at = 0; at < count; at += TEXT_CHUNK)
    {
        const end = Math.min(count, at + TEXT_CHUNK);
        if (!aligned)
        {
            for (let i = at; i < end; i++)
            {
                unitScratch[i - at] = bytes[i * 2] | bytes[i * 2 + 1] << 8;
            }
        }
        text += String.fromCharCode.apply(null, /** @type {any} */ (aligned
            ? aligned.subarray(at, end) : unitScratch.subarray(0, end - at)));
    }
    return text;
}

/** @param {unknown} e */
const unterminated = e=>/** @type {{ code?: unknown }} */ (e)?.code === 'UNTERMINATED';

/**
 * @param {GuestMemory} memory
 * @param {4 | 8} [pointerSize]
 * @returns {Guest}
 */
export function createGuest(memory, pointerSize = 4){
    const { writeU8, writeBytes } = memory;
    /** @type {GuestText['stringBytes']} */
    const stringBytes = (address, wide, limit = wide ? 8192 : 4096)=>{
        // A whole number of units: a wide string's odd last byte is no unit.
        const most = wide ? /** @type {number} */ (limit) & ~1 : /** @type {number} */ (limit);
        let length = most;
        try
        {
            length = wide ? memory.scanWideString(address, limit) * 2
                : memory.scanCString(address, limit).index;
        }
        catch (e){
            if (!unterminated(e))
            {
                throw e;
            }
        }
        return memory.window(address, length);
    };
    /** @type {GuestText['text']} */
    const text = (address, wide, limit, counted = false)=>{
        if (!counted)
        {
            return decode(stringBytes(address, wide, limit), wide);
        }
        const span = wide ? /** @type {number} */ (limit) & ~1 : /** @type {number} */ (limit);
        return span > 0 ? decode(memory.window(address, span), wide) : '';
    };
    /** @type {GuestText['setText']} */
    const setText = (address, value, wide, room = Infinity)=>{
        if (room <= 0)
        {
            return 0;
        }
        if (wide)
        {
            const count = Math.min(value.length, room - 1);
            writeBytes(address, unitBytes(value, count));
            return count;
        }
        const encoded = encodeAnsi(value);
        const count = Math.min(encoded.length, room - 1);
        writeBytes(address, encoded.subarray(0, count));
        writeU8(address + count, 0);
        return count;
    };
    /** @type {Guest} */
    const guest = {
        ...createPort(memory, pointerSize),
        stringBytes,
        text,
        setText,
        cstr: (address, limit)=>text(address, false, limit),
        wstr: (address, limit)=>text(address, true, limit),
        writeAnsi: (address, value, room)=>setText(address, value, false, room),
        writeWide: (address, value, room)=>setText(address, value, true, room),
        // Formatted where it lies: nothing runs between the read and the text.
        guid: address=>formatGuid(memory.window(address, GUID_SIZE)),
        setGuid: (address, guid)=>{
            const bytes = parseGuid(guid);
            if (bytes !== null)
            {
                writeBytes(address, bytes);
            }
            return bytes !== null;
        },
    };
    return guest;
}
