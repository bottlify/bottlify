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
 *     readCString: (address: number, limit?: number) => string,
 *     readWideString: (address: number, limit?: number) => string }} GuestMemory
 */

/**
 * @typedef {Object} GuestText
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

/**
 * Bytes as text of a width: the ANSI page's, or UTF-16 unit for unit, as the
 * memory layer reads a terminated one (half a surrogate pair is a unit).
 *
 * @param {Uint8Array} bytes @param {boolean} wide
 */
function decode(bytes, wide){
    if (!wide)
    {
        return decodeAnsi(bytes);
    }
    let text = '';
    for (let at = 0; at + 1 < bytes.length; at += 2)
    {
        text += String.fromCharCode(bytes[at] | bytes[at + 1] << 8);
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
    /** @type {GuestText['text']} */
    const text = (address, wide, limit, counted = false)=>{
        // A whole number of units: a wide string's odd last byte is no unit.
        const span = wide ? /** @type {number} */ (limit) & ~1 : /** @type {number} */ (limit);
        if (counted)
        {
            return span > 0 ? decode(memory.window(address, span), wide) : '';
        }
        try
        {
            return wide ? memory.readWideString(address, limit)
                : memory.readCString(address, limit);
        }
        catch (e){
            if (!unterminated(e))
            {
                throw e;
            }
            return decode(memory.window(address, span), wide);
        }
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
