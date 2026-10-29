/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * setupapi's string tables: a set of strings, each found by its id, with a
 * few bytes of data a caller keeps beside it.
 *
 * The table is what its handle points at, laid out as Windows lays it out,
 * because a program may read it in place: its data, the offset its next
 * string goes at, how much data it has room for, two words, how much extra
 * data a string carries, and its locale. The data begins with a hash
 * bucket area, 509 DWORDs; a string is an entry after it -- the offset of
 * the next entry in its bucket, the string in UTF-16 and its terminator,
 * and its extra data -- and its id is the entry's offset, so the string a
 * table hands back is in that data. Which strings it has is looked up here,
 * beside it.
 *
 * Each call is exported under its name and again with pSetup before it,
 * the name later Windows give it.
 */

/** The table's fields: data, next offset, allocated, two words, extra size, locale. */
const TABLE = Object.freeze({ DATA: 0, NEXT: 4, ALLOCATED: 8, UNKNOWN: 12, EXTRA: 20, LCID: 24,
    SIZE: 28 });

/** The hash buckets before the first string. */
const BUCKETS = 509;

/** What a new table's data has room for at first. */
const INITIAL_SIZE = 0x1000;

/** Compare case and all. */
const ST_CASE_SENSITIVE_COMPARE = 1;

/** The locale a table is made in: the thread's, which here is US English. */
const LOCALE_EN_US = 0x409;

/**
 * @typedef {Object} StringTableHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 *
 * @typedef {{ id: number, text: string }} Entry
 */

/**
 * @param {StringTableHost} host
 */
export function createStringTableFunctions(host){
    /** Each table's strings, by the table's address. @type {Map<number, Entry[]>} */
    const tables = new Map();

    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /** @param {string} text */
    const wide = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        return bytes;
    };

    /**
     * A new table, empty, its data of the size given.
     *
     * @param {number} extraSize @param {number} size
     */
    const create = (extraSize, size = INITIAL_SIZE)=>{
        const table = host.allocate(TABLE.SIZE);
        const data = table ? host.allocate(size) : 0;
        if (!data)
        {
            return 0;
        }
        host.writeMemory(data, new Uint8Array(BUCKETS * 4));
        const fields = new DataView(new ArrayBuffer(TABLE.SIZE));
        fields.setUint32(TABLE.DATA, data, true);
        fields.setUint32(TABLE.NEXT, BUCKETS * 4, true);
        fields.setUint32(TABLE.ALLOCATED, size, true);
        fields.setUint32(TABLE.UNKNOWN, 1, true);
        fields.setUint32(TABLE.UNKNOWN + 4, 1, true);
        fields.setUint32(TABLE.EXTRA, extraSize, true);
        fields.setUint32(TABLE.LCID, LOCALE_EN_US, true);
        host.writeMemory(table, new Uint8Array(fields.buffer));
        tables.set(table, []);
        return table;
    };

    /**
     * The entry for a string: the same text, or the same case aside unless
     * asked otherwise.
     *
     * @param {number} table @param {string} text @param {number} flags
     */
    const find = (table, text, flags)=>{
        const sensitive = (flags & ST_CASE_SENSITIVE_COMPARE) !== 0;
        return tables.get(table)?.find(entry=>(sensitive ? entry.text === text
            : entry.text.toLowerCase() === text.toLowerCase())) ?? null;
    };

    /**
     * Copies a string's extra data out, as much as both sides hold.
     *
     * @param {number} table @param {Entry} entry @param {number} buffer @param {number} size
     */
    const extraOut = (table, entry, buffer, size)=>{
        const length = Math.min(size >>> 0, readU32(table + TABLE.EXTRA));
        if ((buffer >>> 0) !== 0 && length > 0)
        {
            host.writeMemory(buffer >>> 0, host.readMemory(extraAt(table, entry), length).slice());
        }
    };

    /** Where an entry's extra data is. @param {number} table @param {Entry} entry */
    const extraAt = (table, entry)=>readU32(table + TABLE.DATA) + entry.id + 4
        + (entry.text.length + 1) * 2;

    /**
     * Adds a string, its extra data with it, and answers its id; a string
     * the table has keeps its id and its data. -1 when there is no room.
     *
     * @param {number} table @param {number} pointer @param {number} flags
     * @param {number} extra @param {number} extraSize
     */
    const add = (table, pointer, flags, extra, extraSize)=>{
        const entries = tables.get(table >>> 0);
        if (!entries || (pointer >>> 0) === 0)
        {
            return 0xffffffff;
        }
        const text = host.readWideString(pointer >>> 0, 0x10000);
        const found = find(table >>> 0, text, flags);
        if (found)
        {
            return found.id;
        }
        const maxExtra = readU32(table + TABLE.EXTRA);
        const entrySize = 4 + (text.length + 1) * 2 + maxExtra;
        let data = readU32(table + TABLE.DATA);
        const next = readU32(table + TABLE.NEXT);
        let allocated = readU32(table + TABLE.ALLOCATED);
        if (next + entrySize > allocated)
        {
            const grown = Math.max(allocated * 2, next + entrySize);
            const moved = host.allocate(grown);
            if (!moved)
            {
                return 0xffffffff;
            }
            host.writeMemory(moved, host.readMemory(data, next).slice());
            host.free(data);
            data = moved;
            allocated = grown;
            writeU32(table + TABLE.DATA, data);
            writeU32(table + TABLE.ALLOCATED, allocated);
        }
        const entry = new Uint8Array(entrySize);
        entry.set(wide(text), 4);
        if ((extra >>> 0) !== 0 && maxExtra > 0)
        {
            entry.set(host.readMemory(extra >>> 0, Math.min(extraSize >>> 0, maxExtra)).slice(),
                4 + (text.length + 1) * 2);
        }
        host.writeMemory(data + next, entry);
        writeU32(table + TABLE.NEXT, next + entrySize);
        entries.push({ id: next, text });
        return next;
    };

    /**
     * @param {number} argBytes
     * @param {(args: number[]) => number} handler
     */
    const stdcall = (argBytes, handler)=>({ argBytes, handler });

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */
    const calls = {
        /** HSTRING_TABLE StringTableInitialize(void) */
        StringTableInitialize: stdcall(0, ()=>create(0)),

        /** HSTRING_TABLE StringTableInitializeEx(DWORD MaxExtraDataSize, DWORD Reserved) */
        StringTableInitializeEx: stdcall(8, ([extraSize])=>create(extraSize >>> 0)),

        /** VOID StringTableDestroy(HSTRING_TABLE hStringTable) */
        StringTableDestroy: stdcall(4, ([table])=>{
            if (tables.delete(table >>> 0))
            {
                host.free(readU32(table + TABLE.DATA));
                host.free(table >>> 0);
            }
            return 0;
        }),

        /** HSTRING_TABLE StringTableDuplicate(HSTRING_TABLE hStringTable) -- every string, the same ids */
        StringTableDuplicate: stdcall(4, ([table])=>{
            const entries = tables.get(table >>> 0);
            if (!entries)
            {
                return 0;
            }
            const allocated = readU32(table + TABLE.ALLOCATED);
            const copy = create(readU32(table + TABLE.EXTRA), allocated);
            if (copy)
            {
                host.writeMemory(readU32(copy + TABLE.DATA),
                    host.readMemory(readU32(table + TABLE.DATA), readU32(table + TABLE.NEXT))
                        .slice());
                writeU32(copy + TABLE.NEXT, readU32(table + TABLE.NEXT));
                tables.set(copy, entries.map(entry=>({ ...entry })));
            }
            return copy;
        }),

        /** DWORD StringTableAddString(HSTRING_TABLE, LPWSTR String, DWORD dwFlags) */
        StringTableAddString: stdcall(12, ([table, text, flags])=>add(table, text, flags, 0, 0)),

        /**
         * DWORD StringTableAddStringEx(HSTRING_TABLE, LPWSTR String, DWORD dwFlags,
         *                              LPVOID lpExtraData, DWORD dwExtraDataSize)
         */
        StringTableAddStringEx: stdcall(20, ([table, text, flags, extra, size])=>
            add(table, text, flags, extra, size)),

        /** DWORD StringTableLookUpString(HSTRING_TABLE, LPWSTR String, DWORD dwFlags) -- -1 for none */
        StringTableLookUpString: stdcall(12, ([table, text, flags])=>{
            if (!tables.has(table >>> 0) || (text >>> 0) === 0)
            {
                return 0xffffffff;
            }
            return find(table >>> 0, host.readWideString(text >>> 0, 0x10000), flags)?.id
                ?? 0xffffffff;
        }),

        /**
         * DWORD StringTableLookUpStringEx(HSTRING_TABLE, LPWSTR String, DWORD dwFlags,
         *                                 LPVOID lpExtraData, DWORD dwReserved)
         *
         * The id, and the extra data copied out -- as much as the size given
         * and the table's carry.
         */
        StringTableLookUpStringEx: stdcall(20, ([table, text, flags, extra, size])=>{
            if (!tables.has(table >>> 0) || (text >>> 0) === 0)
            {
                return 0xffffffff;
            }
            const entry = find(table >>> 0, host.readWideString(text >>> 0, 0x10000), flags);
            if (!entry)
            {
                return 0xffffffff;
            }
            extraOut(table >>> 0, entry, extra, size);
            return entry.id;
        }),

        /** LPWSTR StringTableStringFromId(HSTRING_TABLE, DWORD dwId) -- in the table's own data */
        StringTableStringFromId: stdcall(8, ([table, id])=>{
            const entry = tables.get(table >>> 0)?.find(candidate=>candidate.id === (id >>> 0));
            return entry ? readU32(table + TABLE.DATA) + entry.id + 4 : 0;
        }),

        /**
         * BOOL StringTableGetExtraData(HSTRING_TABLE, DWORD dwId, LPVOID lpExtraData,
         *                              DWORD dwExtraDataSize)
         *
         * More than the table carries is a failure.
         */
        StringTableGetExtraData: stdcall(16, ([table, id, extra, size])=>{
            const entry = tables.get(table >>> 0)?.find(candidate=>candidate.id === (id >>> 0));
            if (!entry || (size >>> 0) > readU32(table + TABLE.EXTRA))
            {
                return 0;
            }
            extraOut(table >>> 0, entry, extra, size);
            return 1;
        }),

        /**
         * BOOL StringTableSetExtraData(HSTRING_TABLE, DWORD dwId, LPVOID lpExtraData,
         *                              DWORD dwExtraDataSize)
         */
        StringTableSetExtraData: stdcall(16, ([table, id, extra, size])=>{
            const entry = tables.get(table >>> 0)?.find(candidate=>candidate.id === (id >>> 0));
            if (!entry || (size >>> 0) > readU32(table + TABLE.EXTRA) || (extra >>> 0) === 0)
            {
                return 0;
            }
            host.writeMemory(extraAt(table >>> 0, entry),
                host.readMemory(extra >>> 0, size >>> 0).slice());
            return 1;
        }),
    };

    return Object.fromEntries(Object.entries(calls).flatMap(([name, call])=>[
        [name, call], [`pSetup${name}`, call],
    ]));
}
