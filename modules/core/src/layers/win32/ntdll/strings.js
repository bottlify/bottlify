/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Counted strings: UNICODE_STRING and ANSI_STRING, and the conversions between.
 *
 * Both are the same eight bytes -- a length, the room the buffer has, and the
 * buffer itself -- and both lengths are counted in *bytes*, the wide one
 * included. That is the single most common way to be wrong here by a factor of
 * two. The length excludes the terminator and the maximum includes it, which is
 * how a caller tells a full buffer from one with room left; the process
 * parameter block is written to the same rules, and a program reads both with
 * the same code.
 *
 * Both lengths are unsigned shorts, so a string these can describe stops well
 * short of what the buffer behind it could hold. The limits below are that
 * ceiling with the terminator's room already taken out of it.
 */

import { STATUS } from './status.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

/** UNICODE_STRING and ANSI_STRING, which differ only in what they point at. */
export const COUNTED_STRING = Object.freeze({
    LENGTH: 0x00,
    MAXIMUM_LENGTH: 0x02,
    BUFFER: 0x04,
    SIZE: 0x08,
});

/**
 * The largest a MaximumLength can be, and what that leaves for the characters
 * once the terminator has its room -- one byte of it narrow, two wide, and the
 * wide figure rounded down to a whole character.
 */
const MAX_MAXIMUM = 0xffff;
const MAX_ANSI_BYTES = 0xfffe;
const MAX_WIDE_BYTES = 0xfffc;

/**
 * @typedef {Object} CountedStringHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate  The process heap, so that what
 *           this hands out is what RtlFreeHeap takes back.
 * @property {(address: number) => boolean} free
 */

/**
 * Builds the string half of the table: name -> { argBytes, handler }.
 *
 * All of these are stdcall, which is the bridge's default, so none of them says
 * so. `argBytes` is the size of the argument list the guest compiled against.
 *
 * @param {CountedStringHost} host
 */
export function createCountedStringFunctions(host){
    /** @param {number} at */
    const readDescriptor = at=>{
        const bytes = host.readMemory(at, COUNTED_STRING.SIZE);
        const view = new DataView(bytes.buffer, bytes.byteOffset, COUNTED_STRING.SIZE);
        return {
            length: view.getUint16(COUNTED_STRING.LENGTH, true),
            maximumLength: view.getUint16(COUNTED_STRING.MAXIMUM_LENGTH, true),
            buffer: view.getUint32(COUNTED_STRING.BUFFER, true),
        };
    };

    /**
     * @param {number} at
     * @param {{ length: number, maximumLength: number, buffer: number }} string
     */
    const writeDescriptor = (at, string)=>{
        const bytes = new Uint8Array(COUNTED_STRING.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint16(COUNTED_STRING.LENGTH, string.length, true);
        view.setUint16(COUNTED_STRING.MAXIMUM_LENGTH, string.maximumLength, true);
        view.setUint32(COUNTED_STRING.BUFFER, string.buffer, true);
        host.writeMemory(at, bytes);
    };

    /**
     * The bytes a counted string covers, rather than what a terminator would
     * say: a counted string is allowed to hold one, and its length is what
     * decides where it ends. They are the ANSI code page's, which is what the
     * Rtl conversions convert from.
     *
     * @param {number} buffer @param {number} length
     */
    const ansiAt = (buffer, length)=>{
        if (buffer === 0 || length === 0)
        {
            return '';
        }
        return decodeAnsi(host.readMemory(buffer, length));
    };

    /** @param {number} buffer @param {number} length  In bytes, as the field is. */
    const wideAt = (buffer, length)=>{
        const bytes = length & ~1;
        if (buffer === 0 || bytes === 0)
        {
            return '';
        }
        const raw = host.readMemory(buffer, bytes);
        const view = new DataView(raw.buffer, raw.byteOffset, bytes);
        let text = '';
        for (let at = 0; at + 1 < bytes; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };

    /**
     * In the ANSI code page, a character it lacks as the default character.
     *
     * @param {number} at @param {string} text  The terminator is written too.
     */
    const writeAnsi = (at, text)=>{
        host.writeMemory(at, encodeAnsi(`${text}\0`));
    };

    /** @param {number} at @param {string} text  The terminator is written too. */
    const writeWide = (at, text)=>{
        const bytes = new Uint8Array(text.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < text.length; index++)
        {
            view.setUint16(index * 2, text.charCodeAt(index), true);
        }
        host.writeMemory(at, bytes);
    };

    /**
     * The allocate flag is a BOOLEAN -- one byte in a four-byte slot, and the
     * three bytes above it are whatever the caller's register held.
     *
     * @param {number} flag
     */
    const asked = flag=>(flag & 0xff) !== 0;

    /**
     * Both free functions are the same function: the descriptor says where the
     * buffer is, and nothing about releasing it depends on what was in it.
     *
     * @param {number} string
     */
    const freeString = string=>{
        const at = string >>> 0;
        const { buffer } = readDescriptor(at);
        if (buffer !== 0)
        {
            host.free(buffer);
        }
        // Cleared rather than merely freed: a caller that frees twice then frees
        // nothing, which is defined, instead of the same block again.
        writeDescriptor(at, { length: 0, maximumLength: 0, buffer: 0 });
        return 0;
    };

    /** VOID RtlInitAnsiString(PANSI_STRING DestinationString, PCSZ SourceString) */
    const initAnsiString = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([destination, source])=>{
            const at = source >>> 0;
            const text = at === 0 ? '' : host.readCString(at, MAX_ANSI_BYTES);
            writeDescriptor(destination >>> 0, {
                length: text.length,
                // Zero rather than one for a NULL source: there is no buffer, so
                // there is no room for a terminator to account for.
                maximumLength: at === 0 ? 0 : text.length + 1,
                buffer: at,
            });
            return 0;
        },
    };

    return {
        RtlInitAnsiString: initAnsiString,

        /** VOID RtlInitString(PSTRING DestinationString, PCSZ SourceString) */
        RtlInitString: initAnsiString,

        /**
         * VOID RtlInitUnicodeString(PUNICODE_STRING DestinationString,
         *                           PCWSTR SourceString)
         */
        RtlInitUnicodeString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                const at = source >>> 0;
                const text = at === 0 ? '' : host.readWideString(at, MAX_WIDE_BYTES);
                writeDescriptor(destination >>> 0, {
                    length: text.length * 2,
                    maximumLength: at === 0 ? 0 : text.length * 2 + 2,
                    buffer: at,
                });
                return 0;
            },
        },

        /**
         * NTSTATUS RtlAnsiStringToUnicodeString(PUNICODE_STRING DestinationString,
         *                                       PCANSI_STRING SourceString,
         *                                       BOOLEAN AllocateDestinationString)
         *
         * Refuses rather than truncates when the caller's buffer is too small,
         * which is the opposite of the other direction and is not a choice made
         * here -- a caller that asked for the widening knows how much room the
         * result needs, and one that got it wrong wants to hear so.
         */
        RtlAnsiStringToUnicodeString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, allocateDestination])=>{
                const from = readDescriptor(source >>> 0);
                const text = ansiAt(from.buffer, from.length);
                const total = text.length * 2 + 2;
                if (total > MAX_MAXIMUM)
                {
                    // Widening doubled it past what MaximumLength can describe.
                    return STATUS.INVALID_PARAMETER_2;
                }

                const to = readDescriptor(destination >>> 0);
                let buffer = to.buffer;
                let maximumLength = to.maximumLength;
                if (asked(allocateDestination))
                {
                    buffer = host.allocate(total);
                    if (buffer === 0)
                    {
                        return STATUS.NO_MEMORY;
                    }
                    maximumLength = total;
                }
                else if (total > to.maximumLength)
                {
                    return STATUS.BUFFER_OVERFLOW;
                }

                writeWide(buffer, text);
                writeDescriptor(destination >>> 0, {
                    length: total - 2,
                    maximumLength,
                    buffer,
                });
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlUnicodeStringToAnsiString(PANSI_STRING DestinationString,
         *                                       PCUNICODE_STRING SourceString,
         *                                       BOOLEAN AllocateDestinationString)
         *
         * Truncates into a buffer that is too small, terminates what it wrote and
         * says so with a status. A caller that ignores the status still holds a
         * valid string rather than an unterminated one, which is why this half of
         * the pair behaves differently from the other.
         */
        RtlUnicodeStringToAnsiString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, allocateDestination])=>{
                const from = readDescriptor(source >>> 0);
                const text = wideAt(from.buffer, from.length);
                const total = text.length + 1;
                if (total > MAX_MAXIMUM)
                {
                    return STATUS.INVALID_PARAMETER_2;
                }

                const to = readDescriptor(destination >>> 0);
                let buffer = to.buffer;
                let maximumLength = to.maximumLength;
                let kept = text;
                /** @type {number} */
                let status = STATUS.SUCCESS;
                if (asked(allocateDestination))
                {
                    buffer = host.allocate(total);
                    if (buffer === 0)
                    {
                        return STATUS.NO_MEMORY;
                    }
                    maximumLength = total;
                }
                else if (total > to.maximumLength)
                {
                    if (to.maximumLength === 0)
                    {
                        // No room even for the terminator, so nothing is written.
                        return STATUS.BUFFER_OVERFLOW;
                    }
                    kept = text.slice(0, to.maximumLength - 1);
                    status = STATUS.BUFFER_OVERFLOW;
                }

                writeAnsi(buffer, kept);
                writeDescriptor(destination >>> 0, {
                    length: kept.length,
                    maximumLength,
                    buffer,
                });
                return status;
            },
        },

        /**
         * BOOLEAN RtlCreateUnicodeStringFromAsciiz(PUNICODE_STRING Destination, PCSZ Source)
         *
         * A wide copy of an ANSI string in a buffer of its own, terminated, for
         * RtlFreeUnicodeString to give back; FALSE when there is no room for it.
         */
        RtlCreateUnicodeStringFromAsciiz: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                const text = host.readCString(source >>> 0, MAX_ANSI_BYTES);
                const total = text.length * 2 + 2;
                if (total > MAX_MAXIMUM)
                {
                    return 0;
                }
                const buffer = host.allocate(total);
                if (buffer === 0)
                {
                    return 0;
                }
                writeWide(buffer, text);
                writeDescriptor(destination >>> 0,
                    { length: total - 2, maximumLength: total, buffer });
                return 1;
            },
        },

        /** VOID RtlFreeAnsiString(PANSI_STRING AnsiString) */
        RtlFreeAnsiString: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>freeString(string),
        },

        /** VOID RtlFreeOemString(POEM_STRING OemString): the same structure, freed the same way. */
        RtlFreeOemString: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>freeString(string),
        },

        /** VOID RtlFreeUnicodeString(PUNICODE_STRING UnicodeString) */
        RtlFreeUnicodeString: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>freeString(string),
        },
    };
}
