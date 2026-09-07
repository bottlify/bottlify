/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * What a program asks about the machine it is running on, the calendar, and the
 * handles it holds: the processor and page size, the two time formats Windows
 * keeps and the conversions between them, whether a pointer can be touched, and
 * what kind of thing a handle names.
 *
 * These sit together because none of them is large enough to be its own subject
 * and all of them are answered from the same three things -- the clock, the
 * handle table, and a decision about what machine to claim to be.
 *
 * The claim is deliberate: one processor, a 4 KiB page, a 64 KiB allocation
 * granularity, and a Pentium-class x86. A program branches on all four -- a
 * thread pool sizes itself from the processor count, an allocator rounds to the
 * granularity -- so the answer has to be one a program of this era knows what
 * to do with rather than one that flatters the host.
 */

/** Error codes this file can produce. */
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_INVALID_HANDLE = 6;

/** sizeof(SYSTEM_INFO) and sizeof(SYSTEMTIME). */
const SYSTEM_INFO_SIZE = 36;
const SYSTEMTIME_SIZE = 16;

/** The machine claimed. See the note above. */
const PROCESSOR_ARCHITECTURE_INTEL = 0;
const PROCESSOR_INTEL_PENTIUM = 586;
const PAGE_SIZE = 0x1000;
const ALLOCATION_GRANULARITY = 0x10000;
const MINIMUM_APPLICATION_ADDRESS = 0x00010000;
const MAXIMUM_APPLICATION_ADDRESS = 0x7ffeffff;

/** What GetFileType answers. */
const FILE_TYPE_UNKNOWN = 0x0000;
const FILE_TYPE_DISK = 0x0001;
const FILE_TYPE_CHAR = 0x0002;
const FILE_TYPE_PIPE = 0x0003;

/** Reported for a process that has not exited. */
const STILL_ACTIVE = 259;

/** The pseudo-handle for the running process; -1 on every Windows. */
const CURRENT_PROCESS = 0xffffffff;

/** 100ns units between the FILETIME epoch (1601-01-01) and the Unix one. */
const FILETIME_AT_UNIX_EPOCH = 116_444_736_000_000_000n;

/**
 * @typedef {Object} SystemHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => number} systemTimeMs   Guest wall clock, milliseconds since 1970.
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, type?: string) => any} resolveHandle
 * @property {(code: number) => void} exit
 * @property {() => any} park
 */

/**
 * @param {SystemHost} host
 */
export function createSystemFunctions(host){
    /** @param {number} address @param {number} length */
    const readable = (address, length)=>{
        try
        {
            host.readMemory(address, Math.max(length, 1));
            return true;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /** @param {number} handle @param {string} [type] */
    const object = (handle, type)=>{
        try
        {
            return host.resolveHandle(handle >>> 0, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /** @param {bigint} filetime @returns {Uint8Array} SYSTEMTIME */
    const systemTimeFrom = filetime=>{
        const milliseconds = Number((filetime - FILETIME_AT_UNIX_EPOCH) / 10_000n);
        const when = new Date(milliseconds);
        const bytes = new Uint8Array(SYSTEMTIME_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, when.getUTCFullYear(), true);
        view.setUint16(2, when.getUTCMonth() + 1, true);
        view.setUint16(4, when.getUTCDay(), true);
        view.setUint16(6, when.getUTCDate(), true);
        view.setUint16(8, when.getUTCHours(), true);
        view.setUint16(10, when.getUTCMinutes(), true);
        view.setUint16(12, when.getUTCSeconds(), true);
        view.setUint16(14, when.getUTCMilliseconds(), true);
        return bytes;
    };

    /** @param {number} address @returns {bigint} */
    const readFileTime = address=>{
        const bytes = host.readMemory(address, 8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
    };

    /** @param {number} address @param {bigint} value */
    const writeFileTime = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, value, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} address The SYSTEMTIME to read. */
    const filetimeFrom = address=>{
        const bytes = host.readMemory(address, SYSTEMTIME_SIZE);
        const view = new DataView(bytes.buffer, bytes.byteOffset, SYSTEMTIME_SIZE);
        const milliseconds = Date.UTC(
            view.getUint16(0, true), view.getUint16(2, true) - 1, view.getUint16(6, true),
            view.getUint16(8, true), view.getUint16(10, true), view.getUint16(12, true),
            view.getUint16(14, true));
        return BigInt(milliseconds) * 10_000n + FILETIME_AT_UNIX_EPOCH;
    };

    /** Both time queries answer the same thing; see GetLocalTime. */
    const nowAsSystemTime = ()=>systemTimeFrom(
        BigInt(Math.trunc(host.systemTimeMs())) * 10_000n + FILETIME_AT_UNIX_EPOCH);

    return {
        /** VOID GetSystemInfo(LPSYSTEM_INFO lpSystemInfo) */
        GetSystemInfo: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([info])=>{
                const bytes = new Uint8Array(SYSTEM_INFO_SIZE);
                const view = new DataView(bytes.buffer);
                view.setUint16(0, PROCESSOR_ARCHITECTURE_INTEL, true);
                view.setUint32(4, PAGE_SIZE, true);
                view.setUint32(8, MINIMUM_APPLICATION_ADDRESS, true);
                view.setUint32(12, MAXIMUM_APPLICATION_ADDRESS, true);
                view.setUint32(16, 1, true);   // one processor in the mask
                view.setUint32(20, 1, true);   // and one processor
                view.setUint32(24, PROCESSOR_INTEL_PENTIUM, true);
                view.setUint32(28, ALLOCATION_GRANULARITY, true);
                view.setUint16(32, 5, true);   // processor level: Pentium
                host.writeMemory(info >>> 0, bytes);
                return 0;
            },
        },

        /**
         * int MulDiv(int nNumber, int nNumerator, int nDenominator)
         *
         * Rounded rather than truncated, and computed at full width: the whole
         * point of the call is that the product does not fit in 32 bits, so a
         * caller doing it itself would have lost the answer already.
         */
        MulDiv: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([number, numerator, denominator])=>{
                const divisor = denominator | 0;
                if (divisor === 0)
                {
                    return -1 >>> 0;
                }
                const product = BigInt(number | 0) * BigInt(numerator | 0);
                const half = BigInt(Math.abs(divisor)) / 2n;
                const negative = product < 0n !== divisor < 0;
                const magnitude = (
                    (product < 0n ? -product : product) + half) / BigInt(Math.abs(divisor));
                const result = negative ? -magnitude : magnitude;
                if (result > 0x7fffffffn || result < -0x80000000n)
                {
                    return -1 >>> 0;
                }
                return Number(BigInt.asUintN(32, result));
            },
        },

        /**
         * VOID GetSystemTime(LPSYSTEMTIME lpSystemTime)
         */
        GetSystemTime: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([time])=>{
                host.writeMemory(time >>> 0, nowAsSystemTime());
                return 0;
            },
        },

        /**
         * VOID GetLocalTime(LPSYSTEMTIME lpSystemTime)
         *
         * The same answer as GetSystemTime. There is no time zone here, and
         * inventing an offset would make the two disagree about a clock that has
         * only one source -- a program that computes a duration from one and a
         * timestamp from the other would see time move sideways.
         */
        GetLocalTime: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([time])=>{
                host.writeMemory(time >>> 0, nowAsSystemTime());
                return 0;
            },
        },

        /** BOOL SystemTimeToFileTime(const SYSTEMTIME *lpSystemTime, LPFILETIME lpFileTime) */
        SystemTimeToFileTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([systemTime, fileTime])=>{
                writeFileTime(fileTime >>> 0, filetimeFrom(systemTime >>> 0));
                return 1;
            },
        },

        /** BOOL FileTimeToSystemTime(const FILETIME *lpFileTime, LPSYSTEMTIME lpSystemTime) */
        FileTimeToSystemTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([fileTime, systemTime])=>{
                host.writeMemory(systemTime >>> 0, systemTimeFrom(readFileTime(fileTime >>> 0)));
                return 1;
            },
        },

        /** LONG CompareFileTime(const FILETIME *lpFileTime1, const FILETIME *lpFileTime2) */
        CompareFileTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                const left = readFileTime(first >>> 0);
                const right = readFileTime(second >>> 0);
                if (left < right)
                {
                    return -1 >>> 0;
                }
                return left > right ? 1 : 0;
            },
        },

        /**
         * DWORD GetFileType(HANDLE hFile)
         *
         * A C runtime asks this of each standard handle before it decides how to
         * buffer it: a console is line buffered, a file is not. Answering DISK
         * for a console makes a program's output appear all at once at exit, or
         * not at all.
         */
        GetFileType: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const target = object(handle);
                if (!target)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return FILE_TYPE_UNKNOWN;
                }
                switch (target.kind ?? target.type)
                {
                    case 'console':
                        return FILE_TYPE_CHAR;
                    case 'pipe':
                        return FILE_TYPE_PIPE;
                    default:
                        return FILE_TYPE_DISK;
                }
            },
        },

        /**
         * UINT SetHandleCount(UINT uNumber)
         *
         * A request for a bigger handle table, which stopped meaning anything
         * when Win32 stopped having a fixed one. Windows returns the number it
         * was given, and so does this.
         */
        SetHandleCount: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([count])=>count >>> 0,
        },

        /** BOOL IsBadReadPtr(const VOID *lp, UINT_PTR ucb) */
        IsBadReadPtr: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, length])=>
                (pointer >>> 0) === 0 || !readable(pointer >>> 0, length >>> 0) ? 1 : 0,
        },

        /**
         * BOOL IsBadWritePtr(LPVOID lp, UINT_PTR ucb)
         *
         * Answered by whether the range is mapped, not by whether it is writable.
         * Distinguishing the two would mean probing with a write, and a probe
         * that succeeds has changed the guest's memory to find out.
         */
        IsBadWritePtr: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, length])=>
                (pointer >>> 0) === 0 || !readable(pointer >>> 0, length >>> 0) ? 1 : 0,
        },

        /** BOOL IsBadCodePtr(FARPROC lpfn) */
        IsBadCodePtr: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>(pointer >>> 0) === 0 || !readable(pointer >>> 0, 1) ? 1 : 0,
        },

        /**
         * BOOL CreateProcessA(...)
         *
         * There is no second process to create. Reporting the failure is the
         * only honest answer: returning success and a handle to nothing would
         * have the caller wait on a process that will never signal.
         */
        CreateProcessA: {
            argBytes: 40,
            handler: ()=>{
                host.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
                return 0;
            },
        },

        /** BOOL GetExitCodeProcess(HANDLE hProcess, LPDWORD lpExitCode) */
        GetExitCodeProcess: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                if ((handle >>> 0) !== CURRENT_PROCESS)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                // Asking a running process for its exit code is how a program
                // tests whether it is still running, and this one is.
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, STILL_ACTIVE, true);
                host.writeMemory(code >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL TerminateProcess(HANDLE hProcess, UINT uExitCode)
         *
         * Only the running process can be terminated, and terminating it does
         * not return -- so, like ExitProcess, the stub's own return is redirected
         * into the park loop rather than answered.
         */
        TerminateProcess: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                if ((handle >>> 0) !== CURRENT_PROCESS)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                host.exit(code >>> 0);
                return host.park();
            },
        },
    };
}
