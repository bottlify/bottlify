/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a thread is asked about and told through information classes: the
 * native NtQueryInformationThread and NtSetInformationThread, and the kernel32
 * calls Windows builds on them -- a thread's group affinity and its
 * description.
 *
 * One reading of each field: kernel32's group affinity is the native class's,
 * and SetThreadAffinityMask keeps the same `thread.affinityMask` through the
 * process's `Processors`, so the three spellings cannot disagree.
 */

import { TEB } from './teb.js';

/** THREADINFOCLASS values answered here. */
export const THREAD_INFO = Object.freeze({
    BASIC: 0,
    TIMES: 1,
    AFFINITY_MASK: 4,
    AM_I_LAST_THREAD: 12,
    PRIORITY_BOOST: 14,
    HIDE_FROM_DEBUGGER: 17,
    GROUP: 30,
    NAME: 38,
});

/** NTSTATUS codes these calls answer. */
const STATUS_SUCCESS = 0;
const STATUS_INVALID_INFO_CLASS = 0xc0000003;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
/** What a thread that has not ended reports as its exit status. */
const STATUS_PENDING = 0x103;

/** The Win32 errors kernel32's spellings turn those into. */
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOACCESS = 998;

/** THREAD_BASIC_INFORMATION, 32-bit. */
const BASIC_SIZE = 28;
/** KERNEL_USER_TIMES: four LARGE_INTEGERs. */
const TIMES_SIZE = 32;
/** GROUP_AFFINITY, 32-bit: KAFFINITY Mask, WORD Group, WORD Reserved[3]. */
const GROUP_AFFINITY_SIZE = 12;
/** THREAD_NAME_INFORMATION, 32-bit: a UNICODE_STRING. */
const NAME_SIZE = 8;
/** What a normal-class process's threads are based at. */
const NORMAL_BASE_PRIORITY = 8;

/** GetCurrentThread hands out this, and it is -2 on every Windows. */
const CURRENT_THREAD = 0xfffffffe;

/** @param {number} status */
const hresultFromNt = status=>(status === STATUS_SUCCESS ? 0 : (status | 0x10000000) >>> 0);

/**
 * The Win32 error each status here becomes, as RtlNtStatusToDosError maps it.
 *
 * @param {number} status
 */
const errorOf = status=>(status === STATUS_INVALID_HANDLE ? ERROR_INVALID_HANDLE
    : status === STATUS_ACCESS_VIOLATION ? ERROR_NOACCESS
        : ERROR_INVALID_PARAMETER);

/**
 * @typedef {Object} ThreadInfoHost
 * @property {any} kernel                        The kernel layer's API.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 *           Throws where nothing is mapped.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => any} currentThread
 * @property {(thread?: any) => any} park
 * @property {(code: number) => void} [setLastError]
 * @property {(bytes: number) => number} allocate  A block LocalFree releases.
 * @property {import('./processor.js').Processors} processors
 * @property {(handle: number, at: number) => void} threadTimes
 *           GetThreadTimes' four FILETIMEs for a thread, written in a row at `at`.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {ThreadInfoHost} host
 */
export function createThreadInfoFunctions(host){
    const { kernel, processors } = host;

    /** @param {number} handle */
    const threadOf = handle=>{
        if ((handle >>> 0) === CURRENT_THREAD)
        {
            return host.currentThread();
        }
        try
        {
            return kernel.handles.resolve(handle >>> 0, 'thread');
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * A copy of guest memory, or null where any of it is not there.
     *
     * @param {number} address @param {number} length
     */
    const read = (address, length)=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        try
        {
            return host.readMemory(address >>> 0, length).slice();
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {number} address @param {Uint8Array} bytes @returns {boolean} */
    const write = (address, bytes)=>{
        if ((address >>> 0) === 0)
        {
            return false;
        }
        try
        {
            host.writeMemory(address >>> 0, bytes);
            return true;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /** @param {number} value */
    const dword = value=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        return bytes;
    };

    /** @param {any} thread */
    const ended = thread=>thread.state === 'terminated';

    /** @param {any} thread @param {number} offset @returns {number} */
    const tebDword = (thread, offset)=>{
        const bytes = thread.tebAddress ? read(thread.tebAddress + offset, 4) : null;
        return bytes ? new DataView(bytes.buffer).getUint32(0, true) : 0;
    };

    /**
     * What one class answers for a thread: the bytes, before the length is
     * looked at.
     *
     * @param {any} thread @param {number} infoClass @param {number} handle @param {number} at
     * @returns {Uint8Array | null}  null for a class not answered here.
     */
    const answer = (thread, infoClass, handle, at)=>{
        switch (infoClass)
        {
            case THREAD_INFO.BASIC: {
                const bytes = new Uint8Array(BASIC_SIZE);
                const view = new DataView(bytes.buffer);
                const exit = ended(thread) ? (thread.exitCode ?? 0) >>> 0 : STATUS_PENDING;
                view.setUint32(0, exit, true);
                view.setUint32(4, thread.tebAddress ?? 0, true);
                view.setUint32(8, tebDword(thread, TEB.PROCESS_ID), true);
                view.setUint32(12, thread.id >>> 0, true);
                view.setUint32(16, processors.threadMask(thread), true);
                view.setInt32(20, NORMAL_BASE_PRIORITY + (thread.priority ?? 0), true);
                view.setInt32(24, thread.priority ?? 0, true);
                return bytes;
            }
            case THREAD_INFO.TIMES: {
            // Written in place by GetThreadTimes; read back to go out the one way.
                host.threadTimes(handle, at);
                return read(at, TIMES_SIZE) ?? new Uint8Array(TIMES_SIZE);
            }
            case THREAD_INFO.AM_I_LAST_THREAD: {
                const others = (kernel.threads?.() ?? [])
                    .filter((/** @type {any} */ each)=>each !== thread && !ended(each));
                return dword(others.length === 0 ? 1 : 0);
            }
            case THREAD_INFO.PRIORITY_BOOST:
                return dword(thread.priorityBoostDisabled ? 1 : 0);
            case THREAD_INFO.GROUP: {
                const bytes = new Uint8Array(GROUP_AFFINITY_SIZE);
                new DataView(bytes.buffer).setUint32(0, processors.threadMask(thread), true);
                return bytes;
            }
            default:
                return null;
        }
    };

    /**
     * THREAD_NAME_INFORMATION: the UNICODE_STRING and the name behind it, the
     * string's buffer pointing just past the structure as Windows points it.
     *
     * @param {any} thread @param {number} at @param {number} length @param {number} returned
     */
    const queryName = (thread, at, length, returned)=>{
        const name = String(thread.description ?? '');
        const needed = NAME_SIZE + name.length * 2;
        write(returned, dword(needed));
        if (length < needed)
        {
            return STATUS_BUFFER_TOO_SMALL;
        }
        const bytes = new Uint8Array(needed);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, name.length * 2, true);
        view.setUint16(2, name.length * 2, true);
        view.setUint32(4, (at + NAME_SIZE) >>> 0, true);
        for (let i = 0; i < name.length; i++)
        {
            view.setUint16(NAME_SIZE + i * 2, name.charCodeAt(i), true);
        }
        return write(at, bytes) ? STATUS_SUCCESS : STATUS_ACCESS_VIOLATION;
    };

    /**
     * NTSTATUS NtQueryInformationThread(HANDLE, THREADINFOCLASS, PVOID, ULONG, PULONG)
     *
     * @param {number[]} args
     */
    const query = ([handle, infoClass, at, length, returned])=>{
        const thread = threadOf(handle);
        if (!thread)
        {
            return STATUS_INVALID_HANDLE;
        }
        if ((infoClass >>> 0) === THREAD_INFO.NAME)
        {
            return queryName(thread, at >>> 0, length >>> 0, returned >>> 0);
        }
        /** @type {Map<number, number>} */
        const sizes = new Map([[THREAD_INFO.BASIC, BASIC_SIZE], [THREAD_INFO.TIMES, TIMES_SIZE],
            [THREAD_INFO.AM_I_LAST_THREAD, 4], [THREAD_INFO.PRIORITY_BOOST, 4],
            [THREAD_INFO.GROUP, GROUP_AFFINITY_SIZE]]);
        const size = sizes.get(infoClass >>> 0);
        if (size === undefined)
        {
            host.divergence?.('NtQueryInformationThread',
                `information class ${infoClass >>> 0} is not answered`);
            return STATUS_INVALID_INFO_CLASS;
        }
        if ((length >>> 0) !== size)
        {
            return STATUS_INFO_LENGTH_MISMATCH;
        }
        if (read(at, size) === null)
        {
            return STATUS_ACCESS_VIOLATION;
        }
        const bytes = /** @type {Uint8Array} */ (answer(thread, infoClass >>> 0, handle, at >>> 0));
        if (!write(at, bytes))
        {
            return STATUS_ACCESS_VIOLATION;
        }
        write(returned, dword(size));
        return STATUS_SUCCESS;
    };

    /**
     * The thread's affinity: a mask naming the process's processors, or 0 for
     * the process's own again. A thread moved off the processor it runs on
     * gives up its turn, as SetThreadAffinityMask's does.
     *
     * @param {any} thread @param {number} mask
     * @param {number} result  What the call answers, a moved caller included.
     */
    const setAffinity = (thread, mask, result)=>{
        if (mask === 0)
        {
            delete thread.affinityMask;
        }
        else
        {
            thread.affinityMask = mask;
        }
        const self = host.currentThread();
        const on = processors.processorOf(self);
        if (thread === self && (processors.threadMask(self) >>> on & 1) === 0)
        {
            kernel.block(self, 'NtSetInformationThread', {
                deadline: kernel.clock.virtualTime(),
                result,
            });
            return host.park();
        }
        return result;
    };

    /**
     * The mask a GROUP_AFFINITY at `at` asks for, or the status refusing it.
     * One group, and no every-processor shorthand here: a bit past the
     * machine's processors is refused rather than dropped.
     *
     * @param {number} at
     * @returns {{ mask: number } | { status: number }}
     */
    const groupMask = at=>{
        const bytes = read(at, GROUP_AFFINITY_SIZE);
        if (!bytes)
        {
            return { status: STATUS_ACCESS_VIOLATION };
        }
        const view = new DataView(bytes.buffer);
        const mask = view.getUint32(0, true);
        return view.getUint16(4, true) !== 0 || (mask & ~processors.systemMask()) !== 0
            ? { status: STATUS_INVALID_PARAMETER }
            : { mask };
    };

    /**
     * NTSTATUS NtSetInformationThread(HANDLE, THREADINFOCLASS, PVOID, ULONG)
     *
     * @param {number[]} args
     */
    const set = ([handle, infoClass, at, length])=>{
        const thread = threadOf(handle);
        if (!thread)
        {
            return STATUS_INVALID_HANDLE;
        }
        switch (infoClass >>> 0)
        {
            case THREAD_INFO.AFFINITY_MASK: {
                if ((length >>> 0) !== 4)
                {
                    return STATUS_INFO_LENGTH_MISMATCH;
                }
                const bytes = read(at, 4);
                if (!bytes)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                // Every bit set is every processor the process has; this is where
                // that is understood, beneath SetThreadAffinityMask.
                const asked = new DataView(bytes.buffer).getUint32(0, true);
                const wanted = processors.threadMaskFor(asked);
                return wanted === 0 ? STATUS_INVALID_PARAMETER
                    : setAffinity(thread, wanted, STATUS_SUCCESS);
            }
            case THREAD_INFO.GROUP: {
                if ((length >>> 0) !== GROUP_AFFINITY_SIZE)
                {
                    return STATUS_INFO_LENGTH_MISMATCH;
                }
                const asked = groupMask(at);
                return 'status' in asked ? asked.status
                    : setAffinity(thread, asked.mask, STATUS_SUCCESS);
            }
            case THREAD_INFO.HIDE_FROM_DEBUGGER:
            // No debugger is told of this process's threads to hide one from.
                return (length >>> 0) === 0 ? STATUS_SUCCESS : STATUS_INFO_LENGTH_MISMATCH;
            case THREAD_INFO.NAME: {
                if ((length >>> 0) !== NAME_SIZE)
                {
                    return STATUS_INFO_LENGTH_MISMATCH;
                }
                const header = read(at, NAME_SIZE);
                if (!header)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                const view = new DataView(header.buffer);
                const bytes = view.getUint16(0, true) & ~1;
                const text = bytes === 0 ? new Uint8Array(0) : read(view.getUint32(4, true), bytes);
                if (!text)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                const units = new DataView(text.buffer);
                let name = '';
                for (let i = 0; i < bytes; i += 2)
                {
                    name += String.fromCharCode(units.getUint16(i, true));
                }
                thread.description = name;
                return STATUS_SUCCESS;
            }
            default:
                host.divergence?.('NtSetInformationThread',
                    `information class ${infoClass >>> 0} is not taken`);
                return STATUS_INVALID_INFO_CLASS;
        }
    };

    return {
        /**
         * BOOL GetThreadGroupAffinity(HANDLE hThread, PGROUP_AFFINITY GroupAffinity)
         *
         * The native ThreadGroupInformation query; no structure to fill is
         * ERROR_INVALID_PARAMETER.
         */
        GetThreadGroupAffinity: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                if ((out >>> 0) === 0)
                {
                    host.setLastError?.(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const status = query([handle, THREAD_INFO.GROUP, out, GROUP_AFFINITY_SIZE, 0]);
                if (status !== STATUS_SUCCESS)
                {
                    host.setLastError?.(errorOf(status));
                    return 0;
                }
                return 1;
            },
        },

        /**
         * BOOL SetThreadGroupAffinity(HANDLE hThread, const GROUP_AFFINITY *GroupAffinity,
         *                             PGROUP_AFFINITY PreviousGroupAffinity)
         *
         * The previous affinity is read first and written only once the new
         * one is taken; a mask of 0 is the process's affinity again.
         */
        SetThreadGroupAffinity: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, wanted, previous])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    host.setLastError?.(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const asked = groupMask(wanted);
                if ('status' in asked)
                {
                    host.setLastError?.(errorOf(asked.status));
                    return 0;
                }
                const before = /** @type {Uint8Array} */ (answer(thread, THREAD_INFO.GROUP, handle, 0));
                if ((previous >>> 0) !== 0 && !write(previous, before))
                {
                    host.setLastError?.(ERROR_NOACCESS);
                    return 0;
                }
                return setAffinity(thread, asked.mask, 1);
            },
        },

        /**
         * HRESULT GetThreadDescription(HANDLE hThread, PWSTR *ppszThreadDescription)
         *
         * The description in a block LocalFree releases, empty for a thread
         * never given one. The name an exception-raising debugger convention
         * gives a thread is not this.
         */
        GetThreadDescription: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    write(out, dword(0));
                    return hresultFromNt(STATUS_INVALID_HANDLE);
                }
                const name = String(thread.description ?? '');
                const block = host.allocate((name.length + 1) * 2);
                const bytes = new Uint8Array((name.length + 1) * 2);
                const view = new DataView(bytes.buffer);
                for (let i = 0; i < name.length; i++)
                {
                    view.setUint16(i * 2, name.charCodeAt(i), true);
                }
                if (block === 0 || !write(block, bytes) || !write(out, dword(block)))
                {
                    return hresultFromNt(STATUS_ACCESS_VIOLATION);
                }
                return 0;
            },
        },

        /**
         * HRESULT SetThreadDescription(HANDLE hThread, PCWSTR lpThreadDescription)
         *
         * NULL is the empty description.
         */
        SetThreadDescription: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, text])=>{
                const thread = threadOf(handle);
                if (!thread)
                {
                    return hresultFromNt(STATUS_INVALID_HANDLE);
                }
                let name = '';
                for (let at = text >>> 0; at !== 0; at += 2)
                {
                    const unit = read(at, 2);
                    if (!unit)
                    {
                        return hresultFromNt(STATUS_ACCESS_VIOLATION);
                    }
                    const code = unit[0] | unit[1] << 8;
                    if (code === 0)
                    {
                        break;
                    }
                    name += String.fromCharCode(code);
                }
                thread.description = name;
                return 0;
            },
            natives: {
                NtQueryInformationThread: { argBytes: 20, handler: query },
                NtSetInformationThread: { argBytes: 16, handler: set },
            },
        },
    };
}
