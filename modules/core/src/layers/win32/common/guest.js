/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The guest's memory as every win32 handler reads and writes it: one view the
 * layer builds once per process over the memory layer's accessors and hands to
 * each library (`host.guest`), and to the layers beside it through its api.
 *
 * Each value is read and written where it lies: a dword is the memory layer's
 * own read, with no buffer, no DataView and no closure made for it, and a
 * float is a dword reinterpreted through one scratch word. Only `bytes` makes
 * a copy, and only when no buffer is handed to fill. The pointer width is the
 * process's: 8 bytes in a 64-bit one, an address read and written whole up to
 * 2^53 as the memory layer's `readPointer` does, 4 in a 32-bit one.
 *
 * A string read stops at its terminator or at `limit` bytes, whichever comes
 * first: a handler's limit is the most of a string it reads (a fixed char[32]
 * field holds exactly that, terminated or not), so a longer string is cut
 * there rather than refused out of the host. Only memory that is not there is
 * a fault, as the processor's would be.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { GUID_SIZE, formatGuid, parseGuid } from '../../../system/guid.js';

/**
 * What the view is made over: the memory layer's api, or its accessors.
 *
 * @typedef {Object} GuestMemory
 * @property {(address: number) => number} readU8
 * @property {(address: number) => number} readU16
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU8
 * @property {(address: number, value: number) => void} writeU16
 * @property {(address: number, value: number) => void} writeU32
 * @property {(address: number, length: number) => Uint8Array} readBytes  a copy
 * @property {(address: number, length: number) => Uint8Array} window
 *     The bytes where they lie, until anything else runs.
 * @property {(address: number, bytes: Uint8Array) => void} writeBytes
 * @property {(address: number, value: number, length: number) => void} fillBytes
 * @property {(address: number, limit?: number) => string} readCString
 * @property {(address: number, limit?: number) => string} readWideString
 */

/**
 * @typedef {Object} Guest
 * @property {4 | 8} pointerSize
 * @property {(address: number) => number} u8
 * @property {(address: number) => number} i8
 * @property {(address: number) => number} u16
 * @property {(address: number) => number} i16
 * @property {(address: number) => number} u32
 * @property {(address: number) => number} i32
 * @property {(address: number) => bigint} u64
 * @property {(address: number) => bigint} i64
 * @property {(address: number) => number} f32
 * @property {(address: number) => number} f64
 * @property {(address: number) => number} ptr  a pointer of the process's width, whole
 * @property {(address: number, value: number) => void} set8
 * @property {(address: number, value: number) => void} set16
 * @property {(address: number, value: number) => void} set32
 * @property {(address: number, value: bigint | number) => void} set64
 * @property {(address: number, value: number) => void} setF32
 * @property {(address: number, value: number) => void} setF64
 * @property {(address: number, value: number) => void} setPtr
 * @property {(address: number, values: ArrayLike<number>) => number} set32s
 *     Consecutive dwords; answers the address after the last, where a
 *     marshaler writes on.
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
 * @property {(address: number, length: number, into?: Uint8Array) => Uint8Array} bytes
 *     The bytes copied: into `into` from its start where it is given, which is
 *     answered, or into one new buffer.
 * @property {(address: number, bytes: Uint8Array) => void} setBytes
 * @property {(address: number, value: number, length: number) => void} fill
 * @property {(address: number, length: number,
 *     make: (chunk: Uint8Array, offset: number) => void) => void} setMade
 *     `length` bytes made a chunk at a time and each written as it is made:
 *     `make` fills the chunk with the bytes from `offset` on, a multiple of
 *     eight. Bytes a handler makes to a guest's length (a pattern, random
 *     bytes) are never all on the host at once, and a destination that is not
 *     there faults at its first chunk, before the rest is made.
 * @property {(to: number, from: number, length: number) => void} copy
 *     Guest bytes moved within the guest, ranges overlapping or not.
 */

/**
 * A string's limit that reads it to its terminator however long it is: the
 * scan stops at its region's end, and a string running past it is a fault.
 */
export const WHOLE = 0x7ffffffe;

/** One word a float is reinterpreted through: nothing runs between its write and its read. */
const word = new DataView(new ArrayBuffer(8));

/** Units of a wide string put together before they are written: grown when one is longer. */
let units = new Uint8Array(512);

/** The chunk `writeMade` makes its bytes in, a multiple of eight. */
const made = new Uint8Array(0x10000);

/**
 * `length` bytes made a chunk at a time, each written as it is made (the
 * view's `setMade`, over any write of guest memory): `make` fills the chunk
 * with the bytes from `offset` on, a multiple of eight, and makes no other
 * bytes this way, the chunk being one for every caller. A destination that is
 * not there faults at its first chunk, before the rest is made, as Windows'
 * loop faults at its first byte not there.
 *
 * @param {(address: number, bytes: Uint8Array) => void} write
 * @param {number} address @param {number} length
 * @param {(chunk: Uint8Array, offset: number) => void} make
 */
export function writeMade(write, address, length, make){
    for (let offset = 0; offset < length; offset += made.length)
    {
        const chunk = made.subarray(0, Math.min(made.length, length - offset));
        make(chunk, offset);
        write(address + offset, chunk);
    }
}

/** @param {Uint8Array} chunk */
const zeros = chunk=>void chunk.fill(0);

/**
 * `length` zero bytes, written a chunk at a time: for a library handed only
 * a write, where the view's `fill` is the memory layer's own.
 *
 * @param {(address: number, bytes: Uint8Array) => void} write
 * @param {number} address @param {number} length
 */
export const writeZeros = (write, address, length)=>writeMade(write, address, length, zeros);

/** @param {unknown} e */
const unterminated = e=>/** @type {{ code?: unknown }} */ (e)?.code === 'UNTERMINATED';

/**
 * @param {GuestMemory} memory
 * @param {4 | 8} [pointerSize]
 * @returns {Guest}
 */
export function createGuest(memory, pointerSize = 4){
    const { readU8, readU16, readU32, writeU8, writeU16, writeU32, writeBytes } = memory;
    const wide = pointerSize === 8;
    /** @param {number} address @param {number} low @param {number} high */
    const set64 = (address, low, high)=>{
        writeU32(address, low);
        writeU32(address + 4, high);
    };
    /** @type {Guest} */
    const guest = {
        pointerSize,
        u8: readU8,
        i8: address=>readU8(address) << 24 >> 24,
        u16: readU16,
        i16: address=>readU16(address) << 16 >> 16,
        u32: readU32,
        i32: address=>readU32(address) | 0,
        u64: address=>BigInt(readU32(address)) | BigInt(readU32(address + 4)) << 32n,
        i64: address=>BigInt.asIntN(64, guest.u64(address)),
        f32: address=>{
            word.setUint32(0, readU32(address), true);
            return word.getFloat32(0, true);
        },
        f64: address=>{
            word.setUint32(0, readU32(address), true);
            word.setUint32(4, readU32(address + 4), true);
            return word.getFloat64(0, true);
        },
        ptr: wide ? address=>readU32(address) + readU32(address + 4) * 2 ** 32 : readU32,
        set8: writeU8,
        set16: writeU16,
        set32: writeU32,
        set64: (address, value)=>{
            const whole = BigInt.asUintN(64, BigInt(value));
            set64(address, Number(whole & 0xffffffffn), Number(whole >> 32n));
        },
        setF32: (address, value)=>{
            word.setFloat32(0, value, true);
            writeU32(address, word.getUint32(0, true));
        },
        setF64: (address, value)=>{
            word.setFloat64(0, value, true);
            set64(address, word.getUint32(0, true), word.getUint32(4, true));
        },
        // A negative value is a dword some bitwise operator made signed and
        // names the same address; its upper dword is the value's own, never
        // left as it was.
        setPtr: wide
            ? (address, value)=>{
                const whole = value < 0 ? value >>> 0 : value;
                set64(address, whole % 2 ** 32, Math.floor(whole / 2 ** 32));
            }
            : writeU32,
        set32s: (address, values)=>{
            for (let at = 0; at < values.length; at++)
            {
                writeU32(address + at * 4, values[at]);
            }
            return address + values.length * 4;
        },
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
        bytes: (address, length, into)=>{
            if (!into)
            {
                return memory.readBytes(address, length);
            }
            into.set(memory.window(address, length));
            return into;
        },
        setBytes: writeBytes,
        fill: memory.fillBytes,
        setMade: (address, length, make)=>writeMade(writeBytes, address, length, make),
        // The memory layer's read is a copy already, so the source is read
        // whole before the destination is written: an overlap moves as memmove.
        copy: (to, from, length)=>writeBytes(to, memory.readBytes(from, length)),
    };
    return guest;
}
