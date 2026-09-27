/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { STATUS } from './status.js';

/**
 * The native virtual-memory calls, over kernel32's.
 *
 * kernel32's are these on Windows. What differs is the shape: the native
 * calls take the address and the size through pointers and write back what
 * they acted on -- the base rounded down to its page (or to the allocation
 * granularity a reservation starts on), the size rounded out to whole pages --
 * and they answer a status where kernel32 answers a BOOL and sets the last
 * error.
 */

/** A page; the native calls report what they did in whole ones. */
const PAGE = 0x1000;

/** VirtualQuery's MEMORY_BASIC_INFORMATION, the one information class kept. */
const MEMORY_BASIC_INFORMATION = 0;
const MEMORY_BASIC_INFORMATION_SIZE = 28;
const REGION_SIZE = 12;

/** The statuses these answer beyond the shared table's. */
const STATUS_CONFLICTING_ADDRESSES = 0xc0000018;
const STATUS_MEMORY_NOT_ALLOCATED = 0xc00000a0;
const STATUS_PARTIAL_COPY = 0x8000000d;

/** The last errors kernel32's calls set, and the status each stands for. */
const FROM_LAST_ERROR = new Map([
    [6, STATUS.INVALID_HANDLE],
    [8, STATUS.NO_MEMORY],
    [87, STATUS.INVALID_PARAMETER],
    [299, STATUS_PARTIAL_COPY],
    [998, STATUS.ACCESS_VIOLATION],
]);
/** ERROR_INVALID_ADDRESS, which is one status for an allocation and another for the rest. */
const ERROR_INVALID_ADDRESS = 487;

/**
 * @typedef {{ argBytes: number, handler: Function }} Entry
 */

/**
 * @typedef {Object} MemoryHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {Record<string, Entry>} kernel32
 * @property {(bytes: number) => number} allocate  scratch for a region's query
 */

/** The kernel32 entries these are built over. */
export const MEMORY_ENTRIES = Object.freeze(['VirtualAllocEx', 'VirtualFreeEx',
    'VirtualProtectEx', 'VirtualQueryEx', 'ReadProcessMemory', 'WriteProcessMemory',
    'GetLastError']);

/**
 * @param {MemoryHost} host
 */
export function createMemoryFunctions(host){
    const { kernel32 } = host;

    /** @param {number} address */
    const read32 = address=>new DataView(host.readMemory(address >>> 0, 4).buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const write32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    let scratch = 0;
    /**
     * How far the region at an address runs, which a release of size zero
     * reports it freed; one page when there is nothing to say.
     *
     * @param {number} process @param {number} base
     */
    const regionSize = (process, base)=>{
        scratch ||= host.allocate(MEMORY_BASIC_INFORMATION_SIZE);
        if (scratch === 0 || !kernel32.VirtualQueryEx.handler(
            [process, base, scratch, MEMORY_BASIC_INFORMATION_SIZE]))
        {
            return PAGE;
        }
        return read32(scratch + REGION_SIZE);
    };

    /**
     * What kernel32's failure was, as a status.
     *
     * @param {number} [invalidAddress]  what ERROR_INVALID_ADDRESS stands for here
     */
    const failure = (invalidAddress = STATUS_MEMORY_NOT_ALLOCATED)=>{
        const code = kernel32.GetLastError.handler([]) >>> 0;
        return code === ERROR_INVALID_ADDRESS
            ? invalidAddress
            : FROM_LAST_ERROR.get(code) ?? STATUS.UNSUCCESSFUL;
    };

    /**
     * Writes back the pages a call acted on: from the page the range starts in
     * (or `start`, where the call chose the base) to the end of the page it
     * ends in.
     *
     * @param {number} baseOut @param {number} sizeOut
     * @param {number} start @param {number} end
     */
    const report = (baseOut, sizeOut, start, end)=>{
        const first = (start & ~(PAGE - 1)) >>> 0;
        const last = Math.ceil(end / PAGE) * PAGE;
        write32(baseOut, first);
        write32(sizeOut, last - first);
    };

    return {
        /**
         * NTSTATUS NtAllocateVirtualMemory(HANDLE ProcessHandle, PVOID *BaseAddress,
         *     ULONG_PTR ZeroBits, PSIZE_T RegionSize, ULONG AllocationType,
         *     ULONG Protect)
         */
        NtAllocateVirtualMemory: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([process, baseOut, , sizeOut, type, protect])=>{
                const asked = read32(baseOut);
                const size = read32(sizeOut);
                const got = kernel32.VirtualAllocEx.handler([process, asked, size, type, protect])
                    >>> 0;
                if (got === 0)
                {
                    return failure(STATUS_CONFLICTING_ADDRESSES);
                }
                report(baseOut, sizeOut, got, (asked === 0 ? got : asked) + size);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtFreeVirtualMemory(HANDLE ProcessHandle, PVOID *BaseAddress,
         *     PSIZE_T RegionSize, ULONG FreeType)
         */
        NtFreeVirtualMemory: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([process, baseOut, sizeOut, type])=>{
                const base = read32(baseOut);
                const size = read32(sizeOut);
                // A size of zero is the whole region, which is what is reported
                // back; it is known only before the region is gone.
                const end = base + (size === 0 ? regionSize(process, base) : size);
                if (!kernel32.VirtualFreeEx.handler([process, base, size, type]))
                {
                    return failure();
                }
                report(baseOut, sizeOut, base, end);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtProtectVirtualMemory(HANDLE ProcessHandle, PVOID *BaseAddress,
         *     PSIZE_T NumberOfBytesToProtect, ULONG NewAccessProtection,
         *     PULONG OldAccessProtection)
         *
         * No old protection to write to is an access violation, as it is on
         * Windows, where the call writes it before it changes anything.
         */
        NtProtectVirtualMemory: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([process, baseOut, sizeOut, protect, old])=>{
                const base = read32(baseOut);
                const size = read32(sizeOut);
                if (!kernel32.VirtualProtectEx.handler([process, base, size, protect, old]))
                {
                    return failure();
                }
                report(baseOut, sizeOut, base, base + size);
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtQueryVirtualMemory(HANDLE ProcessHandle, PVOID BaseAddress,
         *     MEMORY_INFORMATION_CLASS MemoryInformationClass,
         *     PVOID MemoryInformation, SIZE_T MemoryInformationLength,
         *     PSIZE_T ReturnLength)
         */
        NtQueryVirtualMemory: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([process, base, infoClass, buffer, length, returned])=>{
                if (infoClass !== MEMORY_BASIC_INFORMATION)
                {
                    return STATUS.INVALID_INFO_CLASS;
                }
                if ((length >>> 0) < MEMORY_BASIC_INFORMATION_SIZE)
                {
                    return STATUS.INFO_LENGTH_MISMATCH;
                }
                const wrote = kernel32.VirtualQueryEx.handler([process, base, buffer, length])
                    >>> 0;
                if (wrote === 0)
                {
                    return failure(STATUS.INVALID_PARAMETER);
                }
                if ((returned >>> 0) !== 0)
                {
                    write32(returned, wrote);
                }
                return STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtReadVirtualMemory(HANDLE ProcessHandle, PVOID BaseAddress,
         *     PVOID Buffer, SIZE_T BufferSize, PSIZE_T NumberOfBytesRead)
         */
        NtReadVirtualMemory: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>(kernel32.ReadProcessMemory.handler(args) ? STATUS.SUCCESS : failure()),
        },

        /**
         * NTSTATUS NtWriteVirtualMemory(HANDLE ProcessHandle, PVOID BaseAddress,
         *     const void *Buffer, SIZE_T BufferSize, PSIZE_T NumberOfBytesWritten)
         */
        NtWriteVirtualMemory: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>(kernel32.WriteProcessMemory.handler(args) ? STATUS.SUCCESS : failure()),
        },
    };
}
