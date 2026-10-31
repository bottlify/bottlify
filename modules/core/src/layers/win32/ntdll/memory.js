/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { STATUS } from './status.js';
import { memoryBasicInformation } from '../kernel32/heap.js';

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
 * @property {() => any} [currentThread]
 * @property {(thread: any) => number} [lastErrorOf]  A thread's last error, for
 *           a call into another process answered after its thread stopped
 *           running.
 * @property {number} [pointerSize]  8 in a 64-bit process, whose PVOID and
 *           SIZE_T out-parameters and MEMORY_BASIC_INFORMATION are wider.
 */

/** The kernel32 entries these are built over. */
export const MEMORY_ENTRIES = Object.freeze(['VirtualAllocEx', 'VirtualAlloc2',
    'VirtualFreeEx', 'VirtualProtectEx', 'VirtualQueryEx', 'ReadProcessMemory',
    'WriteProcessMemory', 'GetLastError']);

/**
 * @param {MemoryHost} host
 */
export function createMemoryFunctions(host){
    const { kernel32 } = host;
    const pointer = host.pointerSize === 8 ? 8 : 4;
    const BASIC = memoryBasicInformation(pointer);

    /**
     * What a kernel32 call answered, now or -- made in another process --
     * later, and the last error it left the calling thread, which by then
     * need not be the one running.
     *
     * @template T
     * @param {number | Promise<number>} result
     * @param {(value: number, error: () => number) => T} then
     * @returns {T | Promise<T>}
     */
    const settled = (result, then)=>{
        if (typeof result === 'number')
        {
            return then(result, ()=>kernel32.GetLastError.handler([]) >>> 0);
        }
        const thread = host.currentThread?.();
        const lastErrorOf = host.lastErrorOf;
        return result.then(value=>then(value, ()=>(lastErrorOf && thread
            ? lastErrorOf(thread) >>> 0 : kernel32.GetLastError.handler([]) >>> 0)));
    };

    /** @param {number} address */
    const read32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /**
     * A PVOID or SIZE_T out-parameter, as wide as the process's: its high
     * half zero at 64 bits, every address and size below 4 GiB.
     *
     * @param {number} address @param {number} value
     */
    const write32 = (address, value)=>{
        const bytes = new Uint8Array(pointer);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    let scratch = 0;
    /**
     * How far the region at an address runs, which a release of size zero
     * reports it freed; one page when there is nothing to say.
     *
     * @param {number} process @param {number} base
     * @returns {number | Promise<number>}
     */
    const regionSize = (process, base)=>{
        scratch ||= host.allocate(BASIC.SIZE);
        if (scratch === 0)
        {
            return PAGE;
        }
        const at = scratch;
        return settled(kernel32.VirtualQueryEx.handler([process, base, at, BASIC.SIZE]),
            wrote=>(wrote ? read32(at + BASIC.RegionSize) : PAGE));
    };

    /**
     * What kernel32's failure was, as a status.
     *
     * @param {() => number} error  the last error the call left
     * @param {number} [invalidAddress]  what ERROR_INVALID_ADDRESS stands for here
     */
    const failure = (error, invalidAddress = STATUS_MEMORY_NOT_ALLOCATED)=>{
        const code = error();
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
                return settled(kernel32.VirtualAllocEx.handler(
                    [process, asked, size, type, protect]), (got, error)=>{
                    if ((got >>> 0) === 0)
                    {
                        return failure(error, STATUS_CONFLICTING_ADDRESSES);
                    }
                    report(baseOut, sizeOut, got >>> 0, (asked === 0 ? got >>> 0 : asked) + size);
                    return STATUS.SUCCESS;
                });
            },
        },

        /**
         * NTSTATUS NtAllocateVirtualMemoryEx(HANDLE ProcessHandle, PVOID *BaseAddress,
         *     PSIZE_T RegionSize, ULONG AllocationType, ULONG PageProtection,
         *     MEM_EXTENDED_PARAMETER *ExtendedParameters, ULONG ParameterCount)
         *
         * VirtualAlloc2 in the native shape, as NtAllocateVirtualMemory is
         * VirtualAllocEx in it.
         */
        NtAllocateVirtualMemoryEx: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([process, baseOut, sizeOut, type, protect, list, count])=>{
                const asked = read32(baseOut);
                const size = read32(sizeOut);
                return settled(kernel32.VirtualAlloc2.handler(
                    [process, asked, size, type, protect, list, count]), (got, error)=>{
                    if ((got >>> 0) === 0)
                    {
                        return failure(error, STATUS_CONFLICTING_ADDRESSES);
                    }
                    report(baseOut, sizeOut, got >>> 0, (asked === 0 ? got >>> 0 : asked) + size);
                    return STATUS.SUCCESS;
                });
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
                return settled(size === 0 ? regionSize(process, base) : size, extent=>
                    settled(kernel32.VirtualFreeEx.handler([process, base, size, type]),
                        (freed, error)=>{
                            if (!freed)
                            {
                                return failure(error);
                            }
                            report(baseOut, sizeOut, base, base + extent);
                            return STATUS.SUCCESS;
                        }));
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
                return settled(kernel32.VirtualProtectEx.handler(
                    [process, base, size, protect, old]), (changed, error)=>{
                    if (!changed)
                    {
                        return failure(error);
                    }
                    report(baseOut, sizeOut, base, base + size);
                    return STATUS.SUCCESS;
                });
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
                if ((length >>> 0) < BASIC.SIZE)
                {
                    return STATUS.INFO_LENGTH_MISMATCH;
                }
                return settled(kernel32.VirtualQueryEx.handler([process, base, buffer, length]),
                    (wrote, error)=>{
                        if ((wrote >>> 0) === 0)
                        {
                            return failure(error, STATUS.INVALID_PARAMETER);
                        }
                        if ((returned >>> 0) !== 0)
                        {
                            write32(returned, wrote >>> 0);
                        }
                        return STATUS.SUCCESS;
                    });
            },
        },

        /**
         * NTSTATUS NtReadVirtualMemory(HANDLE ProcessHandle, PVOID BaseAddress,
         *     PVOID Buffer, SIZE_T BufferSize, PSIZE_T NumberOfBytesRead)
         */
        NtReadVirtualMemory: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>settled(kernel32.ReadProcessMemory.handler(args),
                (read, error)=>(read ? STATUS.SUCCESS : failure(error))),
        },

        /**
         * NTSTATUS NtWriteVirtualMemory(HANDLE ProcessHandle, PVOID BaseAddress,
         *     const void *Buffer, SIZE_T BufferSize, PSIZE_T NumberOfBytesWritten)
         */
        NtWriteVirtualMemory: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>settled(kernel32.WriteProcessMemory.handler(args),
                (wrote, error)=>(wrote ? STATUS.SUCCESS : failure(error))),
        },
    };
}
