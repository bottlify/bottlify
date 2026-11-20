/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program does with counted strings once it has them: copies, appends,
 * comparisons, case, a hash, a search, numbers read and written, GUIDs, and
 * the conversions between UTF-16 and a code page or UTF-8 over plain buffers.
 *
 * Lengths are bytes throughout, the wide ones too, and a counted string ends
 * where its length says, terminated or not. Where a function writes a
 * terminator it writes one only when the room is there: the copy is the
 * contract, the terminator a courtesy.
 */

import { STATUS } from './status.js';
import { countedStringAccess, upcaseText } from './strings.js';
import { unitsFromUtf8, utf8FromUnits } from '../kernel32/utf8.js';
import { formatMessageText } from '../kernel32/format-message.js';
import { decodeAnsi, decodeOem, downcaseUnit, encodeAnsi, encodeOem, upcaseUnit }
    from '../kernel32/locale.js';
import { wholeAddress } from '../common/pointers.js';

const SOME_NOT_MAPPED = 0x00000107;
const NOT_FOUND = 0xc0000225;
const INVALID_PARAMETER_4 = 0xc00000f2;
const INVALID_PARAMETER_5 = 0xc00000f3;
/** The longest a UNICODE_STRING can say: its Length a whole character short of 64 KiB. */
const MAX_WIDE_BYTES = 0xfffc;

/** A GUID as text: `{` 8-4-4-4-12 hexadecimal digits `}`. */
const GUID_TEXT = /^\{([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}$/i;

/**
 * @typedef {Object} StringOpsHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate
 */

/** @param {number} value */
const u32 = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
    value >>> 24 & 0xff);

/** @param {number[]} units @returns {Uint8Array} */
const unitsBytes = units=>{
    const bytes = new Uint8Array(units.length * 2);
    units.forEach((unit, index)=>{
        bytes[index * 2] = unit & 0xff;
        bytes[index * 2 + 1] = unit >> 8;
    });
    return bytes;
};

/** @param {string} text */
const textUnits = text=>Array.from({ length: text.length }, (_, at)=>text.charCodeAt(at));

/**
 * A number in a base, as RtlCharToInteger reads one: blanks first (anything up
 * to a space), a sign, then with base 0 a prefix `0x`, `0o` or `0b` choosing
 * it (else ten), then the digits that are digits of the base. No digit at all
 * is zero.
 *
 * @param {string} text  @param {number} base
 * @returns {number | null}  the value as a 32-bit word, null for a base not 0, 2, 8, 10 or 16
 */
export function parseInteger(text, base){
    if (![0, 2, 8, 10, 16].includes(base))
    {
        return null;
    }
    let at = 0;
    while (at < text.length && text.charCodeAt(at) <= 0x20 && text.charCodeAt(at) !== 0)
    {
        at++;
    }
    let negative = false;
    if (text[at] === '+' || text[at] === '-')
    {
        negative = text[at] === '-';
        at++;
    }
    let radix = base;
    if (base === 0)
    {
        radix = 10;
        if (text[at] === '0')
        {
            const prefix = text[at + 1];
            const chosen = prefix === 'x' ? 16 : prefix === 'o' ? 8 : prefix === 'b' ? 2 : 0;
            if (chosen !== 0)
            {
                radix = chosen;
                at += 2;
            }
        }
    }
    let value = 0;
    for (; at < text.length; at++)
    {
        const digit = parseInt(text[at], 36);
        if (Number.isNaN(digit) || digit >= radix)
        {
            break;
        }
        value = (Math.imul(value, radix) + digit) >>> 0;
    }
    return (negative ? -value : value) >>> 0;
}

/**
 * @param {StringOpsHost} host
 */
export function createStringOperations(host){
    const { readDescriptor, writeDescriptor, wideAt } = countedStringAccess(host);

    /** @param {number} at @returns {number} */
    const readU32 = at=>{
        const bytes = host.readMemory(wholeAddress(at), 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** The characters of a narrow counted string, as bytes. @param {number} at */
    const narrowBytes = at=>{
        const { length, buffer } = readDescriptor(wholeAddress(at));
        return buffer === 0 || length === 0 ? new Uint8Array(0) : host.readMemory(buffer, length);
    };

    /** The units of a wide counted string. @param {number} at */
    const wideUnits = at=>{
        const { length, buffer } = readDescriptor(wholeAddress(at));
        return textUnits(wideAt(buffer, length));
    };

    /** @param {number} flag  A BOOLEAN in its slot. */
    const asked = flag=>(flag & 0xff) !== 0;

    /**
     * Two sequences compared as Windows' string comparisons do: the first
     * difference, else the difference in length.
     *
     * @param {ArrayLike<number>} first @param {ArrayLike<number>} second
     * @param {(unit: number) => number} fold
     */
    const compare = (first, second, fold)=>{
        const shared = Math.min(first.length, second.length);
        for (let at = 0; at < shared; at++)
        {
            const difference = fold(first[at]) - fold(second[at]);
            if (difference !== 0)
            {
                return difference | 0;
            }
        }
        return first.length - second.length | 0;
    };

    /** @param {number} byte  ASCII letters only, as RtlUpperChar. */
    const upperByte = byte=>(byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte);
    /** @param {number} unit */
    const same = unit=>unit;

    /**
     * Copies characters into a counted string's buffer as far as its room
     * allows, terminating when there is room left, and sets its length.
     *
     * @param {number} destination @param {Uint8Array} bytes @param {number} unit 1 or 2
     * @param {boolean} terminate
     */
    const copyInto = (destination, bytes, unit, terminate)=>{
        const to = readDescriptor(wholeAddress(destination));
        const length = Math.min(bytes.length, to.maximumLength) & (unit === 2 ? ~1 : ~0);
        host.writeMemory(to.buffer, bytes.subarray(0, length));
        if (terminate && length + unit <= to.maximumLength)
        {
            host.writeMemory(to.buffer + length, new Uint8Array(unit));
        }
        writeDescriptor(destination >>> 0, { ...to, length });
    };

    /**
     * Appends to a counted string, or refuses with STATUS_BUFFER_TOO_SMALL
     * when the whole of it does not fit; a wide one is terminated when there
     * is room.
     *
     * @param {number} destination @param {Uint8Array} bytes @param {number} unit
     */
    const append = (destination, bytes, unit)=>{
        // Nothing to append fits anywhere, even where the length is already
        // past the room.
        if (bytes.length === 0)
        {
            return STATUS.SUCCESS;
        }
        const to = readDescriptor(wholeAddress(destination));
        const length = to.length + bytes.length;
        if (length > to.maximumLength)
        {
            return STATUS.BUFFER_TOO_SMALL;
        }
        host.writeMemory(to.buffer + to.length, bytes);
        if (unit === 2 && length + 2 <= to.maximumLength)
        {
            host.writeMemory(to.buffer + length, new Uint8Array(2));
        }
        writeDescriptor(destination >>> 0, { ...to, length });
        return STATUS.SUCCESS;
    };

    /**
     * A wide counted string upper- or lower-cased, into the caller's buffer or
     * one allocated for it.
     *
     * @param {(unit: number) => number} fold
     */
    const recase = fold=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([destination, source, allocate])=>{
            const units = wideUnits(source).map(fold);
            const length = units.length * 2;
            const to = readDescriptor(wholeAddress(destination));
            let { buffer, maximumLength } = to;
            if (asked(allocate))
            {
                buffer = host.allocate(Math.max(length, 2));
                if (buffer === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                maximumLength = length;
            }
            else if (length > to.maximumLength)
            {
                return STATUS.BUFFER_OVERFLOW;
            }
            host.writeMemory(buffer, unitsBytes(units));
            writeDescriptor(destination >>> 0, { length, maximumLength, buffer });
            return STATUS.SUCCESS;
        },
    });

    /**
     * Conversion over plain buffers, counted in bytes on both sides: as many
     * whole characters as the destination holds, and how many bytes were
     * written. They are SBCS code pages here, a byte a character.
     *
     * @param {(bytes: Uint8Array) => Uint8Array} convert  all of the source's
     * @param {number} unitIn  bytes a source character @param {number} unitOut
     */
    const plain = (convert, unitIn, unitOut)=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([destination, maximum, written, source, length])=>{
            const count = Math.floor((length >>> 0) / unitIn);
            const all = count === 0 ? new Uint8Array(0)
                : convert(host.readMemory(wholeAddress(source), count * unitIn));
            const room = Math.floor((maximum >>> 0) / unitOut) * unitOut;
            const kept = all.subarray(0, Math.min(all.length, room));
            if (kept.length > 0)
            {
                host.writeMemory(wholeAddress(destination), kept);
            }
            if (written !== 0)
            {
                host.writeMemory(wholeAddress(written), u32(kept.length));
            }
            return STATUS.SUCCESS;
        },
    });

    /** @param {Uint8Array} bytes @returns {string} */
    const unitsText = bytes=>{
        let text = '';
        for (let at = 0; at + 1 < bytes.length; at += 2)
        {
            text += String.fromCharCode(bytes[at] | bytes[at + 1] << 8);
        }
        return text;
    };
    /** @param {string} text */
    const wideBytes = text=>unitsBytes(textUnits(text));
    /**
     * What RtlFormatMessage leaves in a buffer its text outgrew: the
     * message's own characters as far as they fit, unterminated; an escape
     * that does not fit not at all; an insert cut to leave room for its
     * terminator, as its printf cuts it - where any of it fits.
     *
     * @param {string} text  the text as far as it was made
     * @param {{ start: number, kind: string }} piece  the piece that outgrew it
     * @param {number} total  the buffer's characters
     */
    const overflowed = (text, piece, total)=>{
        if (piece.kind === 'insert' && total - 1 > piece.start)
        {
            return wideBytes(`${text.slice(0, total - 1)}\0`);
        }
        return wideBytes(text.slice(0, piece.kind === 'character' ? total
            : Math.min(piece.start, total)));
    };

    /** @param {number} address */
    const guidText = address=>{
        const bytes = host.readMemory(wholeAddress(address), 16);
        const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
        /** @param {number} value @param {number} width */
        const hex = (value, width)=>value.toString(16).toUpperCase().padStart(width, '0');
        const tail = [...bytes.subarray(8)].map(byte=>hex(byte, 2));
        return `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-`
            + `${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 2).join('')}-`
            + `${tail.slice(2).join('')}}`;
    };

    return {
        /** NTSTATUS RtlInitUnicodeStringEx(PUNICODE_STRING Destination, PCWSTR Source) */
        RtlInitUnicodeStringEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                if (source === 0)
                {
                    writeDescriptor(destination >>> 0, { length: 0, maximumLength: 0, buffer: 0 });
                    return STATUS.SUCCESS;
                }
                const text = host.readWideString(wholeAddress(source), MAX_WIDE_BYTES + 2 * 2);
                if (text.length * 2 > MAX_WIDE_BYTES)
                {
                    return STATUS.NAME_TOO_LONG;
                }
                writeDescriptor(destination >>> 0, { length: text.length * 2,
                    maximumLength: text.length * 2 + 2, buffer: source >>> 0 });
                return STATUS.SUCCESS;
            },
        },

        /** VOID RtlCopyString(PSTRING Destination, const STRING *Source) */
        RtlCopyString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                if (source === 0)
                {
                    const to = readDescriptor(wholeAddress(destination));
                    writeDescriptor(destination >>> 0, { ...to, length: 0 });
                    return 0;
                }
                copyInto(destination, narrowBytes(source), 1, false);
                return 0;
            },
        },

        /** VOID RtlCopyUnicodeString(PUNICODE_STRING Destination, PCUNICODE_STRING Source) */
        RtlCopyUnicodeString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                const units = source === 0 ? [] : wideUnits(source);
                copyInto(destination, unitsBytes(units), 2, true);
                return 0;
            },
        },

        /** NTSTATUS RtlAppendStringToString(PSTRING Destination, const STRING *Source) */
        RtlAppendStringToString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>append(destination, narrowBytes(source), 1),
        },

        /** NTSTATUS RtlAppendAsciizToString(PSTRING Destination, PCSZ Source) */
        RtlAppendAsciizToString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                if (source === 0)
                {
                    return STATUS.SUCCESS;
                }
                return append(destination, encodeAnsi(host.readCString(wholeAddress(source),
                    0x10000)), 1);
            },
        },

        /** NTSTATUS RtlAppendUnicodeToString(PUNICODE_STRING Destination, PCWSTR Source) */
        RtlAppendUnicodeToString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                if (source === 0)
                {
                    return STATUS.SUCCESS;
                }
                return append(destination,
                    wideBytes(host.readWideString(wholeAddress(source), 0x20000)), 2);
            },
        },

        /**
         * NTSTATUS RtlAppendUnicodeStringToString(PUNICODE_STRING Destination,
         *     PCUNICODE_STRING Source)
         */
        RtlAppendUnicodeStringToString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>append(destination,
                unitsBytes(wideUnits(source)), 2),
        },

        /** CHAR RtlUpperChar(CHAR Character): ASCII letters only. */
        RtlUpperChar: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([character])=>upperByte(character & 0xff),
        },

        /**
         * WCHAR RtlAnsiCharToUnicodeChar(PUCHAR *SourceCharacter)
         *
         * The ANSI character the pointer points at, as a WCHAR, and the
         * pointer moved past it: one byte, the ANSI page being single-byte.
         */
        RtlAnsiCharToUnicodeChar: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const at = readU32(wholeAddress(pointer));
                const unit = decodeAnsi(host.readMemory(at, 1)).charCodeAt(0);
                const next = at + 1 >>> 0;
                host.writeMemory(wholeAddress(pointer),
                    Uint8Array.of(next & 0xff, next >>> 8 & 0xff, next >>> 16 & 0xff, next >>> 24));
                return unit;
            },
        },

        /** VOID RtlUpperString(PSTRING Destination, const STRING *Source) */
        RtlUpperString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, source])=>{
                copyInto(destination, narrowBytes(source).map(upperByte), 1, false);
                return 0;
            },
        },

        /** NTSTATUS RtlUpcaseUnicodeString(PUNICODE_STRING, PCUNICODE_STRING, BOOLEAN) */
        RtlUpcaseUnicodeString: recase(upcaseUnit),

        /** NTSTATUS RtlDowncaseUnicodeString(PUNICODE_STRING, PCUNICODE_STRING, BOOLEAN) */
        RtlDowncaseUnicodeString: recase(downcaseUnit),

        /** LONG RtlCompareString(const STRING *, const STRING *, BOOLEAN CaseInSensitive) */
        RtlCompareString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([first, second, insensitive])=>compare(narrowBytes(first),
                narrowBytes(second), asked(insensitive) ? upperByte : same),
        },

        /** BOOLEAN RtlEqualString(const STRING *, const STRING *, BOOLEAN CaseInSensitive) */
        RtlEqualString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([first, second, insensitive])=>(compare(narrowBytes(first),
                narrowBytes(second), asked(insensitive) ? upperByte : same) === 0 ? 1 : 0),
        },

        /** BOOLEAN RtlPrefixString(const STRING *Prefix, const STRING *String, BOOLEAN) */
        RtlPrefixString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([prefix, string, insensitive])=>{
                const head = narrowBytes(prefix);
                const whole = narrowBytes(string).subarray(0, head.length);
                return head.length <= narrowBytes(string).length
                    && compare(head, whole, asked(insensitive) ? upperByte : same) === 0 ? 1 : 0;
            },
        },

        /**
         * LONG RtlCompareUnicodeString(PCUNICODE_STRING, PCUNICODE_STRING,
         *     BOOLEAN CaseInSensitive)
         */
        RtlCompareUnicodeString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([first, second, insensitive])=>compare(wideUnits(first), wideUnits(second),
                asked(insensitive) ? upcaseUnit : same),
        },

        /**
         * LONG RtlCompareUnicodeStrings(const WCHAR *, SIZE_T Length1, const WCHAR *,
         *     SIZE_T Length2, BOOLEAN CaseInSensitive)
         *
         * The lengths are in characters.
         */
        RtlCompareUnicodeStrings: {
            argBytes: 20,
            sizes: [1, 3],
            /** @param {number[]} args */
            handler: ([first, firstLength, second, secondLength, insensitive])=>compare(
                textUnits(unitsText(host.readMemory(wholeAddress(first), (firstLength >>> 0) * 2))),
                textUnits(unitsText(host.readMemory(wholeAddress(second),
                    (secondLength >>> 0) * 2))),
                asked(insensitive) ? upcaseUnit : same),
        },

        /** BOOLEAN RtlEqualUnicodeString(PCUNICODE_STRING, PCUNICODE_STRING, BOOLEAN) */
        RtlEqualUnicodeString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([first, second, insensitive])=>(compare(wideUnits(first), wideUnits(second),
                asked(insensitive) ? upcaseUnit : same) === 0 ? 1 : 0),
        },

        /** BOOLEAN RtlPrefixUnicodeString(PCUNICODE_STRING Prefix, PCUNICODE_STRING, BOOLEAN) */
        RtlPrefixUnicodeString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([prefix, string, insensitive])=>{
                const head = wideUnits(prefix);
                const whole = wideUnits(string);
                return head.length <= whole.length && compare(head, whole.slice(0, head.length),
                    asked(insensitive) ? upcaseUnit : same) === 0 ? 1 : 0;
            },
        },

        /**
         * NTSTATUS RtlDuplicateUnicodeString(ULONG Flags, PCUNICODE_STRING Source,
         *     PUNICODE_STRING Destination)
         *
         * Flags: 1 terminate the copy, 2 allocate a string even for an empty
         * one, which only goes with 1. An empty source with no 2 is an empty
         * string with no buffer.
         */
        RtlDuplicateUnicodeString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([flags, source, destination])=>{
                const terminate = (flags & 1) !== 0;
                const always = (flags & 2) !== 0;
                if ((flags >>> 0) > 3 || (always && !terminate) || source === 0
                    || destination === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const from = readDescriptor(wholeAddress(source));
                if (from.length > from.maximumLength || (from.length & 1) !== 0
                    || (from.buffer === 0 && from.maximumLength !== 0))
                {
                    return STATUS.INVALID_PARAMETER;
                }
                if (from.length === 0 && !always)
                {
                    writeDescriptor(destination >>> 0, { length: 0, maximumLength: 0, buffer: 0 });
                    return STATUS.SUCCESS;
                }
                const size = from.length + (terminate ? 2 : 0);
                const buffer = host.allocate(size);
                if (buffer === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                if (from.length > 0)
                {
                    host.writeMemory(buffer, host.readMemory(from.buffer, from.length));
                }
                if (terminate)
                {
                    host.writeMemory(buffer + from.length, new Uint8Array(2));
                }
                writeDescriptor(destination >>> 0,
                    { length: from.length, maximumLength: size, buffer });
                return STATUS.SUCCESS;
            },
        },

        /** VOID RtlEraseUnicodeString(PUNICODE_STRING String) */
        RtlEraseUnicodeString: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>{
                const to = readDescriptor(wholeAddress(string));
                if (to.buffer !== 0 && to.maximumLength > 0)
                {
                    host.writeMemory(to.buffer, new Uint8Array(to.maximumLength));
                }
                writeDescriptor(string >>> 0, { ...to, length: 0 });
                return 0;
            },
        },

        /**
         * NTSTATUS RtlHashUnicodeString(PCUNICODE_STRING String, BOOLEAN CaseInSensitive,
         *     ULONG HashAlgorithm, PULONG HashValue)
         *
         * The one algorithm Windows has, X65599 (0 is the default, the same):
         * each unit added to the hash times 65599, upper-cased first when
         * asked.
         */
        RtlHashUnicodeString: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([string, insensitive, algorithm, out])=>{
                if (string === 0 || out === 0 || (algorithm >>> 0) > 1)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                let hash = 0;
                for (const unit of wideUnits(string))
                {
                    const folded = asked(insensitive) ? upcaseUnit(unit) : unit;
                    hash = (Math.imul(hash, 65599) + folded) >>> 0;
                }
                host.writeMemory(wholeAddress(out), u32(hash));
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlFindCharInUnicodeString(ULONG Flags, PCUNICODE_STRING Search,
         *     PCUNICODE_STRING MatchSet, USHORT *Position)
         *
         * Flags: 1 from the end, 2 a character not in the set. The position is
         * in bytes: past the character found from the start, at it from the
         * end; zero, with STATUS_NOT_FOUND, when none is.
         */
        RtlFindCharInUnicodeString: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([flags, search, matchSet, position])=>{
                if ((flags >>> 0) > 3)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const units = wideUnits(search);
                const set = new Set(wideUnits(matchSet));
                const complement = (flags & 2) !== 0;
                /** @param {number} at */
                const hit = at=>set.has(units[at]) !== complement;
                let found = 0;
                let status = NOT_FOUND;
                if ((flags & 1) === 0)
                {
                    const at = units.findIndex((_, index)=>hit(index));
                    if (at >= 0)
                    {
                        found = (at + 1) * 2;
                        status = STATUS.SUCCESS;
                    }
                }
                else
                {
                    for (let at = units.length - 1; at >= 0; at--)
                    {
                        if (hit(at))
                        {
                            found = at * 2;
                            status = STATUS.SUCCESS;
                            break;
                        }
                    }
                }
                host.writeMemory(wholeAddress(position), Uint8Array.of(found & 0xff, found >> 8));
                return status;
            },
        },

        /** NTSTATUS RtlCharToInteger(PCSZ String, ULONG Base, PULONG Value) */
        RtlCharToInteger: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([string, base, out])=>{
                const value = parseInteger(host.readCString(wholeAddress(string), 0x10000),
                    base >>> 0);
                if (value === null)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                if (out === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                host.writeMemory(wholeAddress(out), u32(value));
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS RtlUnicodeStringToInteger(PCUNICODE_STRING String, ULONG Base, PULONG Value) */
        RtlUnicodeStringToInteger: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([string, base, out])=>{
                const { length, buffer } = readDescriptor(wholeAddress(string));
                const value = parseInteger(wideAt(buffer, length), base >>> 0);
                if (value === null)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                if (out === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                host.writeMemory(wholeAddress(out), u32(value));
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlIntegerToChar(ULONG Value, ULONG Base, ULONG Length, PCHAR String)
         *
         * Upper-case digits, base 0 as ten. A number exactly as long as the
         * buffer is written without its terminator; a longer one is
         * STATUS_BUFFER_OVERFLOW.
         */
        RtlIntegerToChar: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([value, base, length, out])=>{
                const radix = (base >>> 0) === 0 ? 10 : base >>> 0;
                if (![2, 8, 10, 16].includes(radix))
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const text = (value >>> 0).toString(radix).toUpperCase();
                const room = length | 0;
                if (text.length > room)
                {
                    return STATUS.BUFFER_OVERFLOW;
                }
                if (out === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                host.writeMemory(wholeAddress(out),
                    encodeAnsi(text.length < room ? `${text}\0` : text));
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlIntegerToUnicodeString(ULONG Value, ULONG Base, PUNICODE_STRING String)
         *
         * Into the string's buffer with its terminator, which must fit too.
         */
        RtlIntegerToUnicodeString: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([value, base, string])=>{
                const radix = (base >>> 0) === 0 ? 10 : base >>> 0;
                if (![2, 8, 10, 16].includes(radix))
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const text = (value >>> 0).toString(radix).toUpperCase();
                const to = readDescriptor(wholeAddress(string));
                if (text.length * 2 >= to.maximumLength)
                {
                    return STATUS.BUFFER_OVERFLOW;
                }
                host.writeMemory(to.buffer, wideBytes(`${text}\0`));
                writeDescriptor(string >>> 0, { ...to, length: text.length * 2 });
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS RtlGUIDFromString(PCUNICODE_STRING GuidString, GUID *Guid) */
        RtlGUIDFromString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([string, guid])=>{
                const { length, buffer } = readDescriptor(wholeAddress(string));
                const match = GUID_TEXT.exec(wideAt(buffer, length));
                if (!match)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const bytes = new Uint8Array(16);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, parseInt(match[1], 16), true);
                view.setUint16(4, parseInt(match[2], 16), true);
                view.setUint16(6, parseInt(match[3], 16), true);
                const tail = match[4] + match[5];
                for (let at = 0; at < 8; at++)
                {
                    bytes[8 + at] = parseInt(tail.slice(at * 2, at * 2 + 2), 16);
                }
                host.writeMemory(wholeAddress(guid), bytes);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlStringFromGUID(REFGUID Guid, PUNICODE_STRING GuidString)
         *
         * `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`, upper case, in a buffer
         * allocated for it, for RtlFreeUnicodeString.
         */
        RtlStringFromGUID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([guid, string])=>{
                const text = guidText(guid);
                const buffer = host.allocate((text.length + 1) * 2);
                if (buffer === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                host.writeMemory(buffer, wideBytes(`${text}\0`));
                writeDescriptor(string >>> 0,
                    { length: text.length * 2, maximumLength: (text.length + 1) * 2, buffer });
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlUnicodeToUTF8N(PCHAR Destination, ULONG Maximum, PULONG Written,
         *     PCWCH Source, ULONG SourceBytes)
         *
         * With no destination, the bytes the whole would take. A half pair
         * alone is U+FFFD and STATUS_SOME_NOT_MAPPED; whole characters only
         * go where they fit, and the rest is STATUS_BUFFER_TOO_SMALL.
         */
        RtlUnicodeToUTF8N: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([destination, maximum, written, source, length])=>{
                if (source === 0)
                {
                    return INVALID_PARAMETER_4;
                }
                if (written === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                if (destination !== 0 && ((length & 1) !== 0))
                {
                    return INVALID_PARAMETER_5;
                }
                const count = Math.floor((length >>> 0) / 2);
                const units = count === 0 ? []
                    : textUnits(unitsText(host.readMemory(wholeAddress(source), count * 2)));
                const { bytes, unmapped } = utf8FromUnits(units);
                return emit(destination, maximum, written, bytes, 1, unmapped);
            },
        },

        /**
         * NTSTATUS RtlUTF8ToUnicodeN(PWSTR Destination, ULONG Maximum, PULONG Written,
         *     PCCH Source, ULONG SourceBytes)
         */
        RtlUTF8ToUnicodeN: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([destination, maximum, written, source, length])=>{
                if (source === 0)
                {
                    return INVALID_PARAMETER_4;
                }
                if (written === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const bytes = (length >>> 0) === 0 ? new Uint8Array(0)
                    : host.readMemory(wholeAddress(source), length >>> 0);
                const { units, unmapped } = unitsFromUtf8(bytes);
                // A unit at a time: a pair is cut where the buffer ends.
                return emit(destination, maximum, written,
                    units.flat().map(unit=>[unit & 0xff, unit >> 8]), 2, unmapped);
            },
        },

        /**
         * NTSTATUS RtlFormatMessage(PWSTR Message, ULONG MaxWidth, BOOLEAN IgnoreInserts,
         *     BOOLEAN ArgumentsAreAnsi, BOOLEAN ArgumentsAreAnArray, va_list *Arguments,
         *     PWSTR Buffer, ULONG BufferSize, PULONG ReturnLength)
         *
         * FormatMessageW's formatter over a wide message, into a buffer counted
         * in bytes: the text and its terminator, their bytes in ReturnLength;
         * STATUS_BUFFER_OVERFLOW, with ReturnLength left alone, when they do
         * not fit.
         */
        RtlFormatMessage: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([message, width, ignoreInserts, ansi, isArray, list, buffer, size,
                returned])=>{
                const format = message === 0 ? '' : host.readWideString(wholeAddress(message),
                    0x20000);
                // A va_list is a pointer to the first argument, passed by
                // address; an array is passed as itself.
                const slots = list === 0 ? 0 : asked(isArray) ? list >>> 0
                    : readU32(wholeAddress(list));
                const total = Math.floor((size >>> 0) / 2);
                const room = total - 1;
                const { text, error, reads, piece } = formatMessageText(format, {
                    wide: !asked(ansi),
                    ignoreInserts: asked(ignoreInserts),
                    width: width >>> 0,
                    args: list === 0 ? null
                        : { array: asked(isArray), read: slot=>readU32(slots + slot * 4) },
                    readString: (address, wide)=>(address === 0 ? '(null)' : wide
                        ? host.readWideString(wholeAddress(address), 0x20000)
                        : host.readCString(wholeAddress(address), 0x10000)),
                    room,
                });
                // A va_list is used up as far as it was read, as va_arg leaves it.
                if (list !== 0 && !asked(isArray) && reads > 0)
                {
                    host.writeMemory(wholeAddress(list), u32(slots + reads * 4));
                }
                if (error === 87)
                {
                    // What was written before the fault stays, unterminated.
                    host.writeMemory(wholeAddress(buffer), wideBytes(text.slice(0, total)));
                    return STATUS.INVALID_PARAMETER;
                }
                if (error !== 0 || text.length > room)
                {
                    host.writeMemory(wholeAddress(buffer), overflowed(text, piece, total));
                    return STATUS.BUFFER_OVERFLOW;
                }
                host.writeMemory(wholeAddress(buffer), wideBytes(`${text}\0`));
                if (returned !== 0)
                {
                    host.writeMemory(wholeAddress(returned), u32((text.length + 1) * 2));
                }
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS RtlMultiByteToUnicodeN(PWCH, ULONG, PULONG, const CHAR *, ULONG) */
        RtlMultiByteToUnicodeN: plain(bytes=>wideBytes(decodeAnsi(bytes)), 1, 2),
        /** NTSTATUS RtlOemToUnicodeN(PWCH, ULONG, PULONG, PCCH, ULONG) */
        RtlOemToUnicodeN: plain(bytes=>wideBytes(decodeOem(bytes)), 1, 2),
        /** NTSTATUS RtlUnicodeToMultiByteN(PCHAR, ULONG, PULONG, PCWCH, ULONG) */
        RtlUnicodeToMultiByteN: plain(bytes=>encodeAnsi(unitsText(bytes)), 2, 1),
        /** NTSTATUS RtlUnicodeToOemN(PCHAR, ULONG, PULONG, PCWCH, ULONG) */
        RtlUnicodeToOemN: plain(bytes=>encodeOem(unitsText(bytes)), 2, 1),
        /** NTSTATUS RtlUpcaseUnicodeToMultiByteN(PCHAR, ULONG, PULONG, PCWCH, ULONG) */
        RtlUpcaseUnicodeToMultiByteN: plain(bytes=>encodeAnsi(upcaseText(unitsText(bytes))), 2, 1),
        /** NTSTATUS RtlUpcaseUnicodeToOemN(PCHAR, ULONG, PULONG, PCWCH, ULONG) */
        RtlUpcaseUnicodeToOemN: plain(bytes=>encodeOem(upcaseText(unitsText(bytes))), 2, 1),

        /** NTSTATUS RtlMultiByteToUnicodeSize(PULONG Bytes, const CHAR *Source, ULONG Length) */
        RtlMultiByteToUnicodeSize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, , length])=>{
                host.writeMemory(wholeAddress(out), u32(wholeAddress(length) * 2));
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS RtlUnicodeToMultiByteSize(PULONG Bytes, PCWCH Source, ULONG Length) */
        RtlUnicodeToMultiByteSize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, , length])=>{
                host.writeMemory(wholeAddress(out), u32(wholeAddress(length) >>> 1));
                return STATUS.SUCCESS;
            },
        },

        /** ULONG RtlAnsiStringToUnicodeSize(PCANSI_STRING): widened, with its terminator. */
        RtlAnsiStringToUnicodeSize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>(readDescriptor(wholeAddress(string)).length + 1) * 2,
        },

        /** ULONG RtlOemStringToUnicodeSize(PCOEM_STRING) */
        RtlOemStringToUnicodeSize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>(readDescriptor(wholeAddress(string)).length + 1) * 2,
        },

        /** ULONG RtlUnicodeStringToAnsiSize(PCUNICODE_STRING): narrowed, with its terminator. */
        RtlUnicodeStringToAnsiSize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>(readDescriptor(wholeAddress(string)).length >>> 1) + 1,
        },

        /** ULONG RtlUnicodeStringToOemSize(PCUNICODE_STRING) */
        RtlUnicodeStringToOemSize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([string])=>(readDescriptor(wholeAddress(string)).length >>> 1) + 1,
        },
    };

    /**
     * Writes converted characters where they fit, whole, and says how many
     * bytes that was; with no destination, how many the whole would take.
     *
     * @param {number} destination @param {number} maximum @param {number} written
     * @param {number[][]} characters @param {number} unit @param {boolean} unmapped
     */
    function emit(destination, maximum, written, characters, unit, unmapped){
        const all = characters.reduce((total, character)=>total + character.length, 0);
        if (destination === 0)
        {
            host.writeMemory(wholeAddress(written), u32(all));
            return unmapped ? SOME_NOT_MAPPED : STATUS.SUCCESS;
        }
        const room = Math.floor((maximum >>> 0) / unit) * unit;
        /** @type {number[]} */
        const out = [];
        for (const character of characters)
        {
            if (out.length + character.length > room)
            {
                break;
            }
            out.push(...character);
        }
        if (out.length > 0)
        {
            host.writeMemory(wholeAddress(destination), Uint8Array.from(out));
        }
        host.writeMemory(wholeAddress(written), u32(out.length));
        if (out.length < all)
        {
            return STATUS.BUFFER_TOO_SMALL;
        }
        return unmapped ? SOME_NOT_MAPPED : STATUS.SUCCESS;
    }
}
