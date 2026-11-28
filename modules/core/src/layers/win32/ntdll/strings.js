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
import { decodeAnsi, decodeOem, encodeAnsi, encodeOem } from '../kernel32/locale.js';
import { foldName } from '../../../system/text.js';
import { wholeAddress } from '../common/pointers.js';
import { utf16z } from '../common/utf16.js';

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
 * @property {import('../common/guest.js').Guest} guest
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate  The process heap, so that what
 *           this hands out is what RtlFreeHeap takes back.
 * @property {(address: number) => boolean} free
 */

/**
 * Reading and writing counted strings in guest memory: the descriptor, and the
 * characters it covers in either width. Shared by every function over them.
 *
 * @param {Pick<CountedStringHost, 'guest'>} host
 */
export function countedStringAccess({ guest }){
    /** @param {number} at */
    const readDescriptor = at=>({
        length: guest.u16(at + COUNTED_STRING.LENGTH),
        maximumLength: guest.u16(at + COUNTED_STRING.MAXIMUM_LENGTH),
        buffer: guest.u32(at + COUNTED_STRING.BUFFER),
    });

    /**
     * @param {number} at
     * @param {{ length: number, maximumLength: number, buffer: number }} string
     */
    const writeDescriptor = (at, string)=>{
        guest.fill(at, 0, COUNTED_STRING.SIZE);
        guest.set16(at + COUNTED_STRING.LENGTH, string.length);
        guest.set16(at + COUNTED_STRING.MAXIMUM_LENGTH, string.maximumLength);
        guest.set32(at + COUNTED_STRING.BUFFER, string.buffer);
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
        return decodeAnsi(guest.view(buffer, length));
    };

    /** @param {number} buffer @param {number} length  In bytes, as the field is. */
    const wideAt = (buffer, length)=>{
        const bytes = length & ~1;
        if (buffer === 0 || bytes === 0)
        {
            return '';
        }
        const raw = guest.view(buffer, bytes);
        let text = '';
        for (let at = 0; at + 1 < bytes; at += 2)
        {
            text += String.fromCharCode(raw[at] | raw[at + 1] << 8);
        }
        return text;
    };

    return { readDescriptor, writeDescriptor, ansiAt, wideAt };
}

/**
 * Builds the string half of the table: name -> { argBytes, handler }.
 *
 * All of these are stdcall, which is the bridge's default, so none of them says
 * so. `argBytes` is the size of the argument list the guest compiled against.
 *
 * @param {CountedStringHost} host
 */
export function createCountedStringFunctions(host){
    const { readDescriptor, writeDescriptor, wideAt } = countedStringAccess(host);
    const { guest } = host;

    /** @param {number} at @param {string} text  The terminator is written too. */
    const writeWide = (at, text)=>{
        guest.setBytes(at, utf16z(text));
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
        const at = wholeAddress(string);
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
            const at = wholeAddress(source);
            const text = at === 0 ? '' : host.readCString(at, MAX_ANSI_BYTES);
            writeDescriptor(wholeAddress(destination), {
                length: text.length,
                // Zero rather than one for a NULL source: there is no buffer, so
                // there is no room for a terminator to account for.
                maximumLength: at === 0 ? 0 : text.length + 1,
                buffer: at,
            });
            return 0;
        },
    };

    /**
     * A narrow counted string widened into a wide one, the narrow bytes read
     * in a code page.
     *
     * Refuses rather than truncates when the caller's buffer is too small,
     * which is the opposite of the other direction and is not a choice made
     * here -- a caller that asked for the widening knows how much room the
     * result needs, and one that got it wrong wants to hear so.
     *
     * @param {(bytes: Uint8Array) => string} decode
     */
    const narrowToWide = decode=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([destination, source, allocateDestination])=>{
            const from = readDescriptor(wholeAddress(source));
            const text = from.buffer === 0 || from.length === 0 ? ''
                : decode(guest.snapshot(from.buffer, from.length));
            const total = text.length * 2 + 2;
            if (total > MAX_MAXIMUM)
            {
                // Widening doubled it past what MaximumLength can describe.
                return STATUS.INVALID_PARAMETER_2;
            }

            const to = readDescriptor(wholeAddress(destination));
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
            writeDescriptor(wholeAddress(destination), { length: total - 2, maximumLength,
                buffer });
            return STATUS.SUCCESS;
        },
    });

    /**
     * A wide counted string narrowed into a narrow one, in a code page, upper-
     * cased first where asked; a counted result has no terminator.
     *
     * Truncates into a buffer that is too small, terminates what it wrote and
     * says so with a status. A caller that ignores the status still holds a
     * valid string rather than an unterminated one, which is why this half of
     * the pair behaves differently from the other.
     *
     * @param {{ encode: (text: string) => Uint8Array, upcase?: boolean,
     *     counted?: boolean }} how
     */
    const wideToNarrow = ({ encode, upcase = false, counted = false })=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([destination, source, allocateDestination])=>{
            const from = readDescriptor(wholeAddress(source));
            const read = wideAt(from.buffer, from.length);
            const text = upcase ? foldName(read) : read;
            const terminator = counted ? 0 : 1;
            const total = text.length + terminator;
            if (total > MAX_MAXIMUM)
            {
                return STATUS.INVALID_PARAMETER_2;
            }

            const to = readDescriptor(wholeAddress(destination));
            let buffer = to.buffer;
            let maximumLength = to.maximumLength;
            let kept = text;
            /** @type {number} */
            let status = STATUS.SUCCESS;
            if (asked(allocateDestination))
            {
                buffer = host.allocate(Math.max(total, 1));
                if (buffer === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                maximumLength = total;
            }
            else if (total > to.maximumLength)
            {
                if (to.maximumLength < terminator || counted)
                {
                    // No room even for the terminator, so nothing is written.
                    return STATUS.BUFFER_OVERFLOW;
                }
                kept = text.slice(0, to.maximumLength - terminator);
                status = STATUS.BUFFER_OVERFLOW;
            }

            guest.setBytes(buffer, encode(counted ? kept : `${kept}\0`));
            writeDescriptor(wholeAddress(destination), { length: kept.length, maximumLength,
                buffer });
            return status;
        },
    });

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
                const at = wholeAddress(source);
                const text = at === 0 ? '' : host.readWideString(at, MAX_WIDE_BYTES);
                writeDescriptor(wholeAddress(destination), {
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
         */
        RtlAnsiStringToUnicodeString: narrowToWide(decodeAnsi),

        /** NTSTATUS RtlOemStringToUnicodeString(PUNICODE_STRING, PCOEM_STRING, BOOLEAN) */
        RtlOemStringToUnicodeString: narrowToWide(decodeOem),

        /**
         * NTSTATUS RtlUnicodeStringToAnsiString(PANSI_STRING DestinationString,
         *                                       PCUNICODE_STRING SourceString,
         *                                       BOOLEAN AllocateDestinationString)
         */
        RtlUnicodeStringToAnsiString: wideToNarrow({ encode: encodeAnsi }),

        /** NTSTATUS RtlUnicodeStringToOemString(POEM_STRING, PCUNICODE_STRING, BOOLEAN) */
        RtlUnicodeStringToOemString: wideToNarrow({ encode: encodeOem }),

        /** NTSTATUS RtlUpcaseUnicodeStringToAnsiString(PANSI_STRING, PCUNICODE_STRING, BOOLEAN) */
        RtlUpcaseUnicodeStringToAnsiString: wideToNarrow({ encode: encodeAnsi, upcase: true }),

        /** NTSTATUS RtlUpcaseUnicodeStringToOemString(POEM_STRING, PCUNICODE_STRING, BOOLEAN) */
        RtlUpcaseUnicodeStringToOemString: wideToNarrow({ encode: encodeOem, upcase: true }),

        /**
         * NTSTATUS RtlUpcaseUnicodeStringToCountedOemString(POEM_STRING, PCUNICODE_STRING,
         *                                                   BOOLEAN)
         *
         * Counted: no terminator, and no room is made for one.
         */
        RtlUpcaseUnicodeStringToCountedOemString:
            wideToNarrow({ encode: encodeOem, upcase: true, counted: true }),

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
                const text = host.readCString(wholeAddress(source), MAX_ANSI_BYTES);
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
                writeDescriptor(wholeAddress(destination),
                    { length: total - 2, maximumLength: total, buffer });
                return 1;
            },
        },

        /**
         * BOOLEAN RtlCreateUnicodeString(PUNICODE_STRING Destination, PCWSTR Source)
         *
         * The wide string copied into a buffer of its own, terminated, for
         * RtlFreeUnicodeString to give back; FALSE where it would not fit a
         * UNICODE_STRING or there is no room for it.
         */
        RtlCreateUnicodeString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                const text = host.readWideString(wholeAddress(source), MAX_WIDE_BYTES);
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
                writeDescriptor(wholeAddress(destination),
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
