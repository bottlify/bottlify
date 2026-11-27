/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ntdll's environment calls: query, expand and set a variable, create and
 * destroy a block, make one the process's.
 *
 * A block is the Unicode form kernel32 hands out: NAME=VALUE entries, each
 * terminated, an empty one closing the block. Every call takes a block, or
 * NULL for the process's own - and then it is kernel32's store that answers,
 * so a variable set through either library is read back through the other.
 * Names compare without regard to case, as RtlEqualUnicodeString compares
 * them with CaseInSensitive set.
 */

import { STATUS } from './status.js';
import { wholeAddress } from '../common/pointers.js';
import { utf16, utf16z } from '../common/utf16.js';

const STATUS_VARIABLE_NOT_FOUND = 0xc0000100;
/** The most a block may hold, in UTF-16 units; a walk stops there. */
const BLOCK_LIMIT = 0x100000;

/**
 * @typedef {Object} EnvironmentHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {Record<string, { handler: Function }>} kernel32
 * @property {(bytes: number) => number} allocate  From the process heap.
 * @property {(address: number) => boolean} free
 */

/**
 * @param {EnvironmentHost} host
 * @returns {Record<string, { argBytes: number, sizes?: number[], handler: Function }>}
 */
export function createEnvironmentFunctions({ readMemory, writeMemory, kernel32, allocate, free }){
    /** @param {number} address */
    const u32 = address=>new DataView(readMemory(address, 4).buffer.slice(0)).getUint32(0, true);
    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        writeMemory(address, bytes);
    };
    /** @param {number} address @param {number} units */
    const readUnits = (address, units)=>{
        const bytes = readMemory(address, units * 2);
        let text = '';
        for (let at = 0; at + 1 < bytes.length; at += 2)
        {
            text += String.fromCharCode(bytes[at] | bytes[at + 1] << 8);
        }
        return text;
    };
    /** A UNICODE_STRING's text. @param {number} address */
    const counted = address=>readUnits(u32(address + 4), (readMemory(address, 2)[0]
        | readMemory(address, 2)[1] << 8) >>> 1);

    /**
     * The entries of a block, in order.
     *
     * @param {number} block
     * @returns {[string, string][]}
     */
    const entries = block=>{
        /** @type {[string, string][]} */
        const list = [];
        let at = block;
        let entry = '';
        for (let units = 0; units < BLOCK_LIMIT; units++, at += 2)
        {
            const pair = readMemory(at, 2);
            const code = pair[0] | pair[1] << 8;
            if (code !== 0)
            {
                entry += String.fromCharCode(code);
                continue;
            }
            if (entry === '')
            {
                break;
            }
            // A name may itself begin with '=' (the drives' current folders).
            const split = entry.indexOf('=', 1);
            list.push(split < 0 ? [entry, ''] : [entry.slice(0, split), entry.slice(split + 1)]);
            entry = '';
        }
        return list;
    };
    /** The process's block, kernel32's, read and given back. */
    const processEntries = ()=>{
        const block = kernel32.GetEnvironmentStringsW.handler([]) >>> 0;
        try
        {
            return entries(block);
        }
        finally
        {
            kernel32.FreeEnvironmentStringsW?.handler([block]);
        }
    };
    /**
     * A variable's value in a block, or the process's where it is NULL.
     *
     * @param {number} block @param {string} name
     * @returns {string | undefined}
     */
    const lookup = (block, name)=>{
        const wanted = name.toUpperCase();
        return (block === 0 ? processEntries() : entries(block))
            .find(([key])=>key.toUpperCase() === wanted)?.[1];
    };
    /**
     * The expansion's pieces: the text between variables as it is, each
     * `%NAME%` with a variable as its value; one with no variable is text.
     *
     * @param {number} block @param {string} text
     * @returns {{ text: string, value: boolean }[]}
     */
    const expand = (block, text)=>{
        /** @type {{ text: string, value: boolean }[]} */
        const pieces = [];
        let last = 0;
        for (const match of text.matchAll(/%([^%]+)%/g))
        {
            const found = lookup(block, match[1]);
            if (found === undefined)
            {
                continue;
            }
            pieces.push({ text: text.slice(last, match.index), value: false },
                { text: found, value: true });
            last = match.index + match[0].length;
        }
        pieces.push({ text: text.slice(last), value: false });
        return pieces;
    };
    /**
     * An expansion written into `count` characters as ntdll writes it, its
     * length in characters with the terminator returned. What does not fit
     * is written as far as it goes and the writing stops there: text one
     * character at a time, keeping a place for the terminator and writing
     * none; a value whole with its terminator, or, not fitting, a terminator
     * alone where it would have gone. All of it fitting, it is terminated.
     *
     * @param {{ text: string, value: boolean }[]} pieces
     * @param {number} destination @param {number} count
     */
    const writeExpanded = (pieces, destination, count)=>{
        const total = pieces.reduce((sum, piece)=>sum + piece.text.length, 0) + 1;
        let written = 0;
        let stopped = false;
        for (const { text, value } of pieces)
        {
            if (value)
            {
                if (written + text.length + 1 <= count)
                {
                    writeMemory(destination + written * 2, utf16z(text));
                    written += text.length;
                    continue;
                }
                if (written < count)
                {
                    writeMemory(destination + written * 2, utf16('\0'));
                }
                stopped = true;
                break;
            }
            const fits = Math.max(0, Math.min(text.length, count - 1 - written));
            if (fits > 0)
            {
                writeMemory(destination + written * 2, utf16(text.slice(0, fits)));
                written += fits;
            }
            if (fits < text.length)
            {
                stopped = true;
                break;
            }
        }
        if (!stopped && written < count)
        {
            writeMemory(destination + written * 2, utf16('\0'));
        }
        return total;
    };
    /** A new block of these entries. @param {[string, string][]} list */
    const blockOf = list=>{
        const text = `${list.map(([key, value])=>`${key}=${value}\0`).join('')}\0`;
        const at = allocate(text.length * 2);
        if (at !== 0)
        {
            writeMemory(at, utf16(text));
        }
        return at;
    };
    /**
     * A value into a buffer of `room` bytes, terminated where the terminator
     * fits too: the status says whether it did.
     *
     * @param {string} value @param {number} buffer @param {number} room
     */
    const put = (value, buffer, room)=>{
        if (value.length * 2 > room)
        {
            return STATUS.BUFFER_TOO_SMALL;
        }
        writeMemory(buffer, utf16(value.length * 2 + 2 <= room ? `${value}\0` : value));
        return STATUS.SUCCESS;
    };

    return {
        /**
         * NTSTATUS RtlQueryEnvironmentVariable_U(PWSTR Environment,
         *     PUNICODE_STRING Name, PUNICODE_STRING Value)
         *
         * Value.Length is the value's length in bytes whether or not it fitted
         * in Value.MaximumLength.
         */
        RtlQueryEnvironmentVariable_U: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([block, name, value])=>{
                const found = lookup(wholeAddress(block), counted(wholeAddress(name)));
                if (found === undefined)
                {
                    return STATUS_VARIABLE_NOT_FOUND;
                }
                const head = readMemory(wholeAddress(value), 4);
                const room = head[2] | head[3] << 8;
                writeMemory(wholeAddress(value), Uint8Array.of(found.length * 2 & 0xff,
                    found.length * 2 >>> 8 & 0xff));
                return put(found, u32(wholeAddress(value) + 4), room);
            },
        },

        /**
         * NTSTATUS RtlQueryEnvironmentVariable(PWSTR Environment, PCWSTR Name,
         *     SIZE_T NameLength, PWSTR Value, SIZE_T ValueLength, PSIZE_T ReturnLength)
         *
         * Lengths in characters.
         */
        RtlQueryEnvironmentVariable: {
            argBytes: 24,
            sizes: [2, 4],
            /** @param {number[]} args */
            handler: ([block, name, nameLength, value, valueLength, returned])=>{
                const found = lookup(wholeAddress(block), readUnits(wholeAddress(name),
                    nameLength >>> 0));
                if (found === undefined)
                {
                    return STATUS_VARIABLE_NOT_FOUND;
                }
                // A buffer that holds the value and its terminator gets both and
                // the value's length; a smaller one, nothing and the length the
                // terminator needs too.
                if (found.length + 1 > (valueLength >>> 0))
                {
                    setU32(wholeAddress(returned), found.length + 1);
                    return STATUS.BUFFER_TOO_SMALL;
                }
                setU32(wholeAddress(returned), found.length);
                return put(found, wholeAddress(value), (valueLength >>> 0) * 2);
            },
        },

        /**
         * NTSTATUS RtlExpandEnvironmentStrings_U(PWSTR Environment,
         *     PUNICODE_STRING Source, PUNICODE_STRING Destination, PULONG ReturnLength)
         *
         * ReturnLength is the expansion's size in bytes with its terminator;
         * what does not fit is written as RtlExpandEnvironmentStrings writes it.
         */
        RtlExpandEnvironmentStrings_U: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([block, source, destination, returned])=>{
                const pieces = expand(wholeAddress(block), counted(wholeAddress(source)));
                const head = readMemory(wholeAddress(destination), 4);
                const room = (head[2] | head[3] << 8) >>> 1;
                const total = writeExpanded(pieces, u32(wholeAddress(destination) + 4), room);
                if (wholeAddress(returned) !== 0)
                {
                    setU32(wholeAddress(returned), total * 2);
                }
                if (total > room)
                {
                    return STATUS.BUFFER_TOO_SMALL;
                }
                writeMemory(wholeAddress(destination), Uint8Array.of(total * 2 - 2 & 0xff,
                    total * 2 - 2 >>> 8 & 0xff));
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlExpandEnvironmentStrings(PWSTR Environment, PWSTR Source,
         *     SIZE_T SourceLength, PWSTR Destination, SIZE_T DestinationLength,
         *     PSIZE_T ReturnLength)
         *
         * In characters, the count including the terminator; what does not
         * fit is written as far as it goes (`writeExpanded`).
         */
        RtlExpandEnvironmentStrings: {
            argBytes: 24,
            sizes: [2, 4],
            /** @param {number[]} args */
            handler: ([block, source, sourceLength, destination, destinationLength, returned])=>{
                const pieces = expand(wholeAddress(block), readUnits(wholeAddress(source),
                    sourceLength >>> 0));
                const total = writeExpanded(pieces, wholeAddress(destination),
                    destinationLength >>> 0);
                if (wholeAddress(returned) !== 0)
                {
                    setU32(wholeAddress(returned), total);
                }
                return total > (destinationLength >>> 0) ? STATUS.BUFFER_TOO_SMALL
                    : STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlSetEnvironmentVariable(PWSTR *Environment,
         *     PUNICODE_STRING Name, PUNICODE_STRING Value)
         *
         * Into the block *Environment names, which is replaced by a new one and
         * the old freed; into the process's where Environment is NULL. A NULL
         * value removes the variable; a name with '=' past its first character
         * is no name.
         */
        RtlSetEnvironmentVariable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([where, name, value])=>{
                const key = counted(wholeAddress(name));
                if (key === '' || key.indexOf('=', 1) >= 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const text = wholeAddress(value) === 0 ? null : counted(wholeAddress(value));
                if (wholeAddress(where) === 0)
                {
                    set(key, text);
                    return STATUS.SUCCESS;
                }
                const old = u32(wholeAddress(where));
                const list = (old === 0 ? [] : entries(old))
                    .filter(([entry])=>entry.toUpperCase() !== key.toUpperCase());
                if (text !== null)
                {
                    list.push([key, text]);
                }
                const fresh = blockOf(list);
                if (fresh === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                setU32(wholeAddress(where), fresh);
                if (old !== 0)
                {
                    free(old);
                }
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlCreateEnvironment(BOOLEAN CloneCurrent, PWSTR *Environment)
         *
         * A copy of the process's block, or an empty one.
         */
        RtlCreateEnvironment: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([clone, out])=>{
                const fresh = blockOf((clone & 0xff) !== 0 ? processEntries() : []);
                if (fresh === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                setU32(wholeAddress(out), fresh);
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS RtlDestroyEnvironment(PWSTR Environment) */
        RtlDestroyEnvironment: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                free(wholeAddress(block));
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlSetCurrentEnvironment(PWSTR NewEnvironment, PWSTR *OldEnvironment)
         *
         * The block's variables become the process's, all others gone; the
         * process's as they were are handed back as a block of their own. The
         * block stays the caller's: the store copies what it holds.
         */
        RtlSetCurrentEnvironment: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([block, old])=>{
                const before = processEntries();
                if (wholeAddress(old) !== 0)
                {
                    setU32(wholeAddress(old), blockOf(before));
                }
                // No block is no variables at all.
                const after = wholeAddress(block) === 0 ? [] : entries(wholeAddress(block));
                const kept = new Set(after.map(([key])=>key.toUpperCase()));
                for (const [key] of before)
                {
                    if (!kept.has(key.toUpperCase()))
                    {
                        set(key, null);
                    }
                }
                for (const [key, value] of after)
                {
                    set(key, value);
                }
                return STATUS.SUCCESS;
            },
        },
    };

    /** @param {string} key @param {string | null} value */
    function set(key, value){
        const scratch = allocate((key.length + (value?.length ?? 0) + 2) * 2);
        try
        {
            writeMemory(scratch, utf16(`${key}\0${value ?? ''}\0`));
            kernel32.SetEnvironmentVariableW.handler([scratch,
                value === null ? 0 : scratch + (key.length + 1) * 2]);
        }
        finally
        {
            free(scratch);
        }
    }
}
