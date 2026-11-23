/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Atom tables as the native interface keeps them: RtlCreateAtomTable and the
 * calls over a table a program made, and the Nt calls over the system's
 * global one.
 *
 * A table is the program's to hold: RtlCreateAtomTable hands back a block of
 * the process heap that begins with the table's signature ('Atom'), which a
 * program may read, and every other call takes that pointer back. What is in
 * the table lives here, keyed by the block.
 *
 * The rules are the native ones, which differ from kernel32's in the edges:
 * an integer atom is `#` and decimal digits only (`#7b`, `# 1` and `#+1` are
 * names), any number of leading zeros, from 1 to 0xbfff; it is always there,
 * counted once and pinned, without being added. A name is 1 to 255
 * characters, compared without case; names are numbered from 0xc000, the
 * lowest number free first. A pinned name is never deleted, only emptied
 * with the pinned ones.
 */

import { STATUS } from './status.js';
import { wholeAddress } from '../common/pointers.js';

/** The first word of a table, as Windows writes it: 'Atom'. */
const SIGNATURE = 0x6d6f7441;
const TABLE_SIZE = 16;
const FIRST_NAMED = 0xc000;
const LAST_NAMED = 0xffff;
const MAX_NAME = 255;
/** Read far enough for an integer atom written with any number of zeros. */
const MAX_READ_BYTES = 0x10000;
/** STATUS_WAS_LOCKED: the atom is pinned and stays. */
const WAS_LOCKED = 0x40000019;
/** ATOM_BASIC_INFORMATION: UsageCount, Flags, NameLength, then the name. */
const BASIC_NAME_AT = 6;
const BASIC_SIZE = 8;
const ATOM_BASIC_INFORMATION = 0;

/**
 * @typedef {Object} AtomTableHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate  The process heap.
 * @property {(address: number) => boolean} free
 */

/**
 * @typedef {{ name: string, references: number, pinned: boolean }} Named
 * @typedef {Map<number, Named>} Table
 */

/** @param {number} value @returns {Uint8Array} */
const u16 = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff);
/** @param {number} value @returns {Uint8Array} */
const u32 = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
    value >>> 24 & 0xff);

/** @param {string} text @returns {Uint8Array} UTF-16 without a terminator. */
const utf16 = text=>{
    const bytes = new Uint8Array(text.length * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >> 8;
    }
    return bytes;
};

/**
 * What a name argument stands for: an integer atom, a name, or the status
 * that refuses it.
 *
 * @param {number | string} given  A value below 64 KiB, or the text.
 * @returns {{ integer: number } | { name: string } | { status: number, atom?: number }}
 *     A number refused - zero, or `#` and one out of range - still answers
 *     the atom 0; a name refused leaves the caller's atom as it was.
 */
export function parseAtomName(given){
    if (typeof given === 'number')
    {
        if (given === 0)
        {
            return { status: STATUS.INVALID_PARAMETER, atom: 0 };
        }
        // Windows reads 0xc000 to 0xffff as the pointer it is, and faults.
        return given < FIRST_NAMED ? { integer: given } : { status: STATUS.ACCESS_VIOLATION };
    }
    if (/^#\d+$/.test(given))
    {
        const digits = given.slice(1).replace(/^0+/, '');
        const value = digits.length > 5 ? Infinity : Number(digits || '0');
        return value === 0 || value >= FIRST_NAMED ? { status: STATUS.INVALID_PARAMETER, atom: 0 }
            : { integer: value };
    }
    if (given === '')
    {
        return { status: STATUS.OBJECT_NAME_INVALID };
    }
    return given.length > MAX_NAME ? { status: STATUS.INVALID_PARAMETER } : { name: given };
}

/**
 * @param {AtomTableHost} host
 */
export function createAtomTableFunctions(host){
    /** @type {Map<number, Table>} */
    const tables = new Map();
    /** The system's table, the one NtAddAtom and its kin keep. */
    /** @type {Table} */
    const global = new Map();

    /** @param {number} pointer */
    const tableAt = pointer=>tables.get(pointer >>> 0) ?? null;

    /** @param {number} at @param {number} atom */
    const putAtom = (at, atom)=>{
        if (at !== 0)
        {
            host.writeMemory(wholeAddress(at), u16(atom));
        }
    };

    /** @param {number} pointer @returns {ReturnType<typeof parseAtomName>} */
    const nameAt = pointer=>{
        const raw = wholeAddress(pointer);
        return parseAtomName(raw < 0x10000 ? raw : host.readWideString(raw, MAX_READ_BYTES));
    };

    /** @param {Table} table @param {string} name */
    const findNamed = (table, name)=>{
        const key = name.toLowerCase();
        for (const [atom, entry] of table)
        {
            if (entry.name.toLowerCase() === key)
            {
                return atom;
            }
        }
        return 0;
    };

    /**
     * @param {Table} table @param {ReturnType<typeof parseAtomName>} parsed
     * @returns {{ status: number, atom?: number }}
     */
    const add = (table, parsed)=>{
        if ('status' in parsed)
        {
            return parsed;
        }
        if ('integer' in parsed)
        {
            return { status: STATUS.SUCCESS, atom: parsed.integer };
        }
        const known = findNamed(table, parsed.name);
        if (known !== 0)
        {
            const entry = /** @type {Named} */ (table.get(known));
            entry.references++;
            return { status: STATUS.SUCCESS, atom: known };
        }
        for (let atom = FIRST_NAMED; atom <= LAST_NAMED; atom++)
        {
            if (!table.has(atom))
            {
                table.set(atom, { name: parsed.name, references: 1, pinned: false });
                return { status: STATUS.SUCCESS, atom };
            }
        }
        return { status: STATUS.NO_MEMORY };
    };

    /**
     * @param {Table} table @param {ReturnType<typeof parseAtomName>} parsed
     * @returns {{ status: number, atom?: number }}
     */
    const lookup = (table, parsed)=>{
        if ('status' in parsed)
        {
            return { status: parsed.status };
        }
        if ('integer' in parsed)
        {
            return { status: STATUS.SUCCESS, atom: parsed.integer };
        }
        const atom = findNamed(table, parsed.name);
        return atom === 0 ? { status: STATUS.OBJECT_NAME_NOT_FOUND }
            : { status: STATUS.SUCCESS, atom };
    };

    /** @param {Table} table @param {number} atom @returns {number} */
    const remove = (table, atom)=>{
        const value = atom & 0xffff;
        if (value !== 0 && value < FIRST_NAMED)
        {
            return STATUS.SUCCESS;
        }
        const entry = table.get(value);
        if (!entry)
        {
            return STATUS.INVALID_HANDLE;
        }
        if (entry.pinned)
        {
            return WAS_LOCKED;
        }
        if (--entry.references === 0)
        {
            table.delete(value);
        }
        return STATUS.SUCCESS;
    };

    /**
     * What an atom is: its name and counts, or the status refusing it. An
     * integer atom is `#` and its number, counted once and pinned.
     *
     * @param {Table} table @param {number} atom
     * @returns {{ status: number, name?: string, references?: number, pinned?: boolean }}
     */
    const describe = (table, atom)=>{
        const value = atom & 0xffff;
        if (value === 0)
        {
            return { status: STATUS.INVALID_PARAMETER };
        }
        if (value < FIRST_NAMED)
        {
            return { status: STATUS.SUCCESS, name: `#${value}`, references: 1, pinned: true };
        }
        const entry = table.get(value);
        return entry ? { status: STATUS.SUCCESS, ...entry } : { status: STATUS.INVALID_HANDLE };
    };

    /** @param {number} at @returns {number} */
    const readU32 = at=>{
        const bytes = host.readMemory(wholeAddress(at), 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    return {
        /** NTSTATUS RtlCreateAtomTable(ULONG Buckets, PRTL_ATOM_TABLE *Table) */
        RtlCreateAtomTable: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, out])=>{
                if (out === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const block = host.allocate(TABLE_SIZE);
                if (block === 0)
                {
                    return STATUS.NO_MEMORY;
                }
                host.writeMemory(block, u32(SIGNATURE));
                tables.set(block, new Map());
                host.writeMemory(wholeAddress(out), u32(block));
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS RtlDestroyAtomTable(PRTL_ATOM_TABLE Table) */
        RtlDestroyAtomTable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([table])=>{
                if (!tableAt(table))
                {
                    return STATUS.INVALID_PARAMETER;
                }
                tables.delete(wholeAddress(table));
                host.free(wholeAddress(table));
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS RtlEmptyAtomTable(PRTL_ATOM_TABLE Table, BOOLEAN DeletePinned) */
        RtlEmptyAtomTable: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, pinnedToo])=>{
                const table = tableAt(pointer);
                if (!table)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                for (const [atom, entry] of table)
                {
                    if ((pinnedToo & 0xff) !== 0 || !entry.pinned)
                    {
                        table.delete(atom);
                    }
                }
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS RtlAddAtomToAtomTable(PRTL_ATOM_TABLE Table, PCWSTR Name, PRTL_ATOM Atom) */
        RtlAddAtomToAtomTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, name, out])=>{
                const table = tableAt(pointer);
                if (!table)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const { status, atom } = add(table, nameAt(name));
                if (atom !== undefined)
                {
                    putAtom(out, atom);
                }
                return status;
            },
        },

        /** NTSTATUS RtlLookupAtomInAtomTable(PRTL_ATOM_TABLE Table, PCWSTR Name, PRTL_ATOM Atom) */
        RtlLookupAtomInAtomTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pointer, name, out])=>{
                const table = tableAt(pointer);
                if (!table)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const { status, atom } = lookup(table, nameAt(name));
                if (atom !== undefined)
                {
                    putAtom(out, atom);
                }
                return status;
            },
        },

        /** NTSTATUS RtlDeleteAtomFromAtomTable(PRTL_ATOM_TABLE Table, RTL_ATOM Atom) */
        RtlDeleteAtomFromAtomTable: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, atom])=>{
                const table = tableAt(pointer);
                return table ? remove(table, atom) : STATUS.INVALID_PARAMETER;
            },
        },

        /** NTSTATUS RtlPinAtomInAtomTable(PRTL_ATOM_TABLE Table, RTL_ATOM Atom) */
        RtlPinAtomInAtomTable: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, atom])=>{
                const table = tableAt(pointer);
                if (!table)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const value = atom & 0xffff;
                if (value !== 0 && value < FIRST_NAMED)
                {
                    return STATUS.SUCCESS;
                }
                const entry = table.get(value);
                if (!entry)
                {
                    return STATUS.INVALID_HANDLE;
                }
                entry.pinned = true;
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlQueryAtomInAtomTable(PRTL_ATOM_TABLE Table, RTL_ATOM Atom,
         *     PULONG RefCount, PULONG PinCount, PWSTR Name, PULONG NameLength)
         *
         * NameLength is the buffer's bytes on the way in and the name's bytes
         * written on the way out, its terminator not counted; a name longer
         * than the buffer holds is cut to fit with its terminator. No room at
         * all is STATUS_BUFFER_TOO_SMALL, with the whole name's length.
         */
        RtlQueryAtomInAtomTable: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([pointer, atom, refCount, pinCount, name, nameLength])=>{
                const table = tableAt(pointer);
                if (!table)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const found = describe(table, atom);
                if (found.name === undefined)
                {
                    return found.status;
                }
                if (refCount !== 0)
                {
                    host.writeMemory(wholeAddress(refCount), u32(/** @type {number} */ (found.references)));
                }
                if (pinCount !== 0)
                {
                    host.writeMemory(wholeAddress(pinCount), u32(found.pinned ? 1 : 0));
                }
                if (name === 0 || nameLength === 0)
                {
                    return STATUS.SUCCESS;
                }
                const room = readU32(nameLength);
                if (room < 2)
                {
                    host.writeMemory(wholeAddress(nameLength), u32(found.name.length * 2));
                    return STATUS.BUFFER_TOO_SMALL;
                }
                const text = found.name.slice(0, Math.floor(room / 2) - 1);
                host.writeMemory(wholeAddress(name), utf16(`${text}\0`));
                host.writeMemory(wholeAddress(nameLength), u32(text.length * 2));
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS NtAddAtom(PCWSTR Name, ULONG Length, PRTL_ATOM Atom) */
        NtAddAtom: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, length, out])=>{
                const { status, atom } = add(global, counted(name, length));
                if (atom !== undefined)
                {
                    putAtom(out, atom);
                }
                return status;
            },
        },

        /** NTSTATUS NtFindAtom(PCWSTR Name, ULONG Length, PRTL_ATOM Atom) */
        NtFindAtom: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, length, out])=>{
                const { status, atom } = lookup(global, counted(name, length));
                if (atom !== undefined)
                {
                    putAtom(out, atom);
                }
                return status;
            },
        },

        /** NTSTATUS NtDeleteAtom(RTL_ATOM Atom) */
        NtDeleteAtom: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([atom])=>remove(global, atom),
        },

        /**
         * NTSTATUS NtQueryInformationAtom(RTL_ATOM Atom, ATOM_INFORMATION_CLASS Class,
         *     PVOID Buffer, ULONG Length, PULONG ReturnLength)
         *
         * AtomBasicInformation: the usage count, the flags (1 pinned), the
         * name's length in bytes and the name, cut to the buffer with its
         * terminator. A buffer no larger than the structure's own size holds
         * no name: STATUS_BUFFER_TOO_SMALL, with the length filled in.
         */
        NtQueryInformationAtom: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([atom, infoClass, buffer, length, returned])=>{
                if (infoClass !== ATOM_BASIC_INFORMATION)
                {
                    return STATUS.INVALID_INFO_CLASS;
                }
                const found = describe(global, atom);
                if (found.name === undefined)
                {
                    return found.status;
                }
                const size = length >>> 0;
                if (size < BASIC_NAME_AT)
                {
                    return STATUS.INFO_LENGTH_MISMATCH;
                }
                const head = new Uint8Array(BASIC_NAME_AT);
                head.set(u16(/** @type {number} */ (found.references)), 0);
                head.set(u16(found.pinned ? 1 : 0), 2);
                head.set(u16(found.name.length * 2), 4);
                host.writeMemory(wholeAddress(buffer), head);
                if (size <= BASIC_SIZE)
                {
                    return STATUS.BUFFER_TOO_SMALL;
                }
                const text = found.name.slice(0, Math.floor((size - BASIC_NAME_AT) / 2) - 1);
                host.writeMemory((buffer + BASIC_NAME_AT) >>> 0, utf16(`${text}\0`));
                host.writeMemory((buffer + 4) >>> 0, u16(text.length * 2));
                if (returned !== 0)
                {
                    host.writeMemory(wholeAddress(returned),
                        u32(BASIC_NAME_AT + (text.length + 1) * 2));
                }
                return STATUS.SUCCESS;
            },
        },
    };

    /**
     * A name the Nt calls take counted, in bytes, not terminated.
     *
     * @param {number} pointer @param {number} length
     * @returns {ReturnType<typeof parseAtomName>}
     */
    function counted(pointer, length){
        if (pointer === 0)
        {
            return { status: STATUS.INVALID_PARAMETER };
        }
        const bytes = host.readMemory(wholeAddress(pointer), Math.min(length >>> 0,
            MAX_READ_BYTES) & ~1);
        let text = '';
        for (let at = 0; at + 1 < bytes.length; at += 2)
        {
            text += String.fromCharCode(bytes[at] | bytes[at + 1] << 8);
        }
        return parseAtomName(text);
    }
}
