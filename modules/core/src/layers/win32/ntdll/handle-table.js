/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Rtl handle tables: fixed-size records a program allocates from one
 * reservation and names by index.
 *
 * RTL_HANDLE_TABLE (32-bit): MaxHandleCount, HandleSize, Unused[2], NextFree,
 * FirstHandle, ReservedMemory, MaxHandle. Every record starts with an
 * RTL_HANDLE, whose Next links the free ones; the caller marks a record in use
 * by setting the low bit of that first word (RtlpMakeHandleAllocated), which
 * RtlIsValidIndexHandle and RtlFreeHandle read. The records are carved from the
 * reservation in order, the first unused field counting how many have been
 * given out, and a freed one goes on the free list to be given out first.
 */

const MAX_HANDLE_COUNT = 0;
const HANDLE_SIZE = 4;
const HANDED_OUT = 8;
const NEXT_FREE = 16;
const FIRST_HANDLE = 20;
const RESERVED_MEMORY = 24;
const MAX_HANDLE = 28;
const TABLE_SIZE = 32;

/** The record's first word's low bit: in use. */
const ALLOCATED = 1;

const STATUS_SUCCESS = 0;

/**
 * @typedef {Object} HandleTableHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  the process heap
 * @property {(address: number) => boolean} free
 */

/**
 * @param {HandleTableHost} host
 */
export function createHandleTableFunctions(host){
    /** @param {number} address */
    const read = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const write = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * The record at an index, where one has been given out and is in use.
     *
     * @param {number} table @param {number} index
     */
    const inUseAt = (table, index)=>{
        if (index >= read(table + HANDED_OUT))
        {
            return 0;
        }
        const record = read(table + FIRST_HANDLE) + index * read(table + HANDLE_SIZE);
        return (read(record) & ALLOCATED) !== 0 ? record : 0;
    };

    return {
        /**
         * void RtlInitializeHandleTable(ULONG MaxHandleCount, ULONG HandleSize,
         *                               PRTL_HANDLE_TABLE HandleTable)
         */
        RtlInitializeHandleTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([count, size, table])=>{
                host.writeMemory(table >>> 0, new Uint8Array(TABLE_SIZE));
                write(table + MAX_HANDLE_COUNT, count);
                write(table + HANDLE_SIZE, size);
                return 0;
            },
        },
        /**
         * PRTL_HANDLE RtlAllocateHandle(PRTL_HANDLE_TABLE, PULONG HandleIndex)
         *
         * A freed record first, else the next never given out; NULL where the
         * table is full or there is no memory for it.
         */
        RtlAllocateHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([table, index])=>{
                const size = read(table + HANDLE_SIZE);
                const count = read(table + MAX_HANDLE_COUNT);
                if (read(table + RESERVED_MEMORY) === 0)
                {
                    const reserved = size * count === 0 ? 0 : host.allocate(size * count);
                    if (reserved === 0)
                    {
                        return 0;
                    }
                    write(table + RESERVED_MEMORY, reserved);
                    write(table + FIRST_HANDLE, reserved);
                    write(table + MAX_HANDLE, reserved + size * count);
                }
                const first = read(table + FIRST_HANDLE);
                let record = read(table + NEXT_FREE);
                if (record !== 0)
                {
                    write(table + NEXT_FREE, read(record));
                }
                else
                {
                    const handed = read(table + HANDED_OUT);
                    if (handed >= count)
                    {
                        return 0;
                    }
                    record = first + handed * size;
                    write(table + HANDED_OUT, handed + 1);
                }
                host.writeMemory(record, new Uint8Array(size));
                if ((index >>> 0) !== 0)
                {
                    write(index, (record - first) / size);
                }
                return record;
            },
        },
        /**
         * BOOLEAN RtlFreeHandle(PRTL_HANDLE_TABLE, PRTL_HANDLE Handle)
         *
         * A record not in use is refused; a freed one goes first on the free list.
         */
        RtlFreeHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([table, record])=>{
                const first = read(table + FIRST_HANDLE);
                if ((record >>> 0) < first || (record >>> 0) >= read(table + MAX_HANDLE)
                    || (read(record) & ALLOCATED) === 0)
                {
                    return 0;
                }
                write(record, read(table + NEXT_FREE));
                write(table + NEXT_FREE, record);
                return 1;
            },
        },
        /**
         * BOOLEAN RtlIsValidHandle(PRTL_HANDLE_TABLE, PRTL_HANDLE Handle)
         */
        RtlIsValidHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([table, record])=>{
                const first = read(table + FIRST_HANDLE);
                const size = read(table + HANDLE_SIZE);
                if (size === 0 || (record >>> 0) < first || (record - first) % size !== 0)
                {
                    return 0;
                }
                return inUseAt(table, (record - first) / size) === (record >>> 0) ? 1 : 0;
            },
        },
        /**
         * BOOLEAN RtlIsValidIndexHandle(PRTL_HANDLE_TABLE, ULONG Index,
         *                               PRTL_HANDLE *ValidHandle)
         */
        RtlIsValidIndexHandle: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([table, index, out])=>{
                const record = inUseAt(table, index >>> 0);
                if (record === 0)
                {
                    return 0;
                }
                write(out, record);
                return 1;
            },
        },
        /** NTSTATUS RtlDestroyHandleTable(PRTL_HANDLE_TABLE) */
        RtlDestroyHandleTable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([table])=>{
                const reserved = read(table + RESERVED_MEMORY);
                if (reserved !== 0)
                {
                    host.free(reserved);
                }
                host.writeMemory(table >>> 0, new Uint8Array(TABLE_SIZE));
                return STATUS_SUCCESS;
            },
        },
    };
}
