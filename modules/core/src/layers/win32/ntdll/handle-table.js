/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

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
 * @property {import('../common/guest.js').Guest} guest
 * @property {(bytes: number) => number} allocate  the process heap
 * @property {(address: number) => boolean} free
 */

/**
 * @param {HandleTableHost} host
 */
export function createHandleTableFunctions(host){
    const { guest } = host;

    /**
     * The record at an index, where one has been given out and is in use.
     *
     * @param {number} table @param {number} index
     */
    const inUseAt = (table, index)=>{
        if (index >= guest.u32(table + HANDED_OUT))
        {
            return 0;
        }
        const record = guest.u32(table + FIRST_HANDLE) + index * guest.u32(table + HANDLE_SIZE);
        return (guest.u32(record) & ALLOCATED) !== 0 ? record : 0;
    };

    return {
        /**
         * void RtlInitializeHandleTable(ULONG MaxHandleCount, ULONG HandleSize,
         *                               PRTL_HANDLE_TABLE HandleTable)
         */
        RtlInitializeHandleTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([count, size, handed])=>{
                const table = wholeAddress(handed);
                guest.fill(table, 0, TABLE_SIZE);
                guest.set32(table + MAX_HANDLE_COUNT, count);
                guest.set32(table + HANDLE_SIZE, size);
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
            returns: 'pointer',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([given, index])=>{
                const table = wholeAddress(given);
                const size = guest.u32(table + HANDLE_SIZE);
                const count = guest.u32(table + MAX_HANDLE_COUNT);
                if (guest.u32(table + RESERVED_MEMORY) === 0)
                {
                    const reserved = size * count === 0 ? 0 : host.allocate(size * count);
                    if (reserved === 0)
                    {
                        return 0;
                    }
                    guest.set32(table + RESERVED_MEMORY, reserved);
                    guest.set32(table + FIRST_HANDLE, reserved);
                    guest.set32(table + MAX_HANDLE, reserved + size * count);
                }
                const first = guest.u32(table + FIRST_HANDLE);
                let record = guest.u32(table + NEXT_FREE);
                if (record !== 0)
                {
                    guest.set32(table + NEXT_FREE, guest.u32(record));
                }
                else
                {
                    const handed = guest.u32(table + HANDED_OUT);
                    if (handed >= count)
                    {
                        return 0;
                    }
                    record = first + handed * size;
                    guest.set32(table + HANDED_OUT, handed + 1);
                }
                guest.fill(record, 0, size);
                if (wholeAddress(index) !== 0)
                {
                    guest.set32(wholeAddress(index), (record - first) / size);
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
            handler: ([handed, given])=>{
                const table = wholeAddress(handed);
                const record = wholeAddress(given);
                const first = guest.u32(table + FIRST_HANDLE);
                if (record < first || record >= guest.u32(table + MAX_HANDLE)
                    || (guest.u32(record) & ALLOCATED) === 0)
                {
                    return 0;
                }
                guest.set32(record, guest.u32(table + NEXT_FREE));
                guest.set32(table + NEXT_FREE, record);
                return 1;
            },
        },
        /**
         * BOOLEAN RtlIsValidHandle(PRTL_HANDLE_TABLE, PRTL_HANDLE Handle)
         */
        RtlIsValidHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handed, given])=>{
                const table = wholeAddress(handed);
                const record = wholeAddress(given);
                const first = guest.u32(table + FIRST_HANDLE);
                const size = guest.u32(table + HANDLE_SIZE);
                if (size === 0 || record < first || (record - first) % size !== 0)
                {
                    return 0;
                }
                return inUseAt(table, (record - first) / size) === record ? 1 : 0;
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
                const record = inUseAt(wholeAddress(table), index >>> 0);
                if (record === 0)
                {
                    return 0;
                }
                guest.set32(wholeAddress(out), record);
                return 1;
            },
        },
        /** NTSTATUS RtlDestroyHandleTable(PRTL_HANDLE_TABLE) */
        RtlDestroyHandleTable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handed])=>{
                const table = wholeAddress(handed);
                const reserved = guest.u32(table + RESERVED_MEMORY);
                if (reserved !== 0)
                {
                    host.free(reserved);
                }
                guest.fill(table, 0, TABLE_SIZE);
                return STATUS_SUCCESS;
            },
        },
    };
}
