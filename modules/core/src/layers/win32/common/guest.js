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
 * A string read stops at its terminator or at `limit` bytes, whichever comes
 * first: a handler's limit is the most of a string it reads (a fixed char[32]
 * field holds exactly that, terminated or not), so a longer string is cut
 * there rather than refused out of the host. Only memory that is not there is
 * a fault, as the processor's would be.
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
 * @property {(address: number, limit?: number) => string} cstr
 *     An ANSI string, at most `limit` bytes of it.
 * @property {(address: number, limit?: number) => string} wstr
 *     A UTF-16 string, at most `limit` bytes (not units) of it.
 * @property {(address: number, text: string, room?: number) => number} writeAnsi
 *     The text in the ANSI page and a NUL, cut to `room` bytes with the NUL;
 *     answers the bytes written before the NUL. Nothing is written for no room.
 * @property {(address: number, text: string, room?: number) => number} writeWide
 *     The same in UTF-16, `room` in units, as a W function's cch counts them.
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

/** @param {unknown} e */
const unterminated = e=>/** @type {{ code?: unknown }} */ (e)?.code === 'UNTERMINATED';

/**
 * @param {GuestMemory} memory
 * @param {4 | 8} [pointerSize]
 * @returns {Guest}
 */
export function createGuest(memory, pointerSize = 4){
    const { writeU8, writeBytes } = memory;
    /** @type {Guest} */
    const guest = {
        ...createPort(memory, pointerSize),
        cstr: (address, limit)=>{
            try
            {
                return memory.readCString(address, limit);
            }
            catch (e){
                if (!unterminated(e))
                {
                    throw e;
                }
                return decodeAnsi(memory.window(address, /** @type {number} */ (limit)));
            }
        },
        wstr: (address, limit)=>{
            try
            {
                return memory.readWideString(address, limit);
            }
            catch (e){
                if (!unterminated(e))
                {
                    throw e;
                }
                // Unit for unit, as the memory layer reads a terminated one.
                const bytes = memory.window(address, /** @type {number} */ (limit) & ~1);
                let text = '';
                for (let at = 0; at + 1 < bytes.length; at += 2)
                {
                    text += String.fromCharCode(bytes[at] | bytes[at + 1] << 8);
                }
                return text;
            }
        },
        writeAnsi: (address, text, room = Infinity)=>{
            if (room <= 0)
            {
                return 0;
            }
            const encoded = encodeAnsi(text);
            const length = Math.min(encoded.length, room - 1);
            writeBytes(address, encoded.subarray(0, length));
            writeU8(address + length, 0);
            return length;
        },
        writeWide: (address, text, room = Infinity)=>{
            if (room <= 0)
            {
                return 0;
            }
            const length = Math.min(text.length, room - 1);
            if (units.length < (length + 1) * 2)
            {
                units = new Uint8Array((length + 1) * 4);
            }
            for (let at = 0; at < length; at++)
            {
                const unit = text.charCodeAt(at);
                units[at * 2] = unit & 0xff;
                units[at * 2 + 1] = unit >>> 8;
            }
            units[length * 2] = 0;
            units[length * 2 + 1] = 0;
            writeBytes(address, units.subarray(0, (length + 1) * 2));
            return length;
        },
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
