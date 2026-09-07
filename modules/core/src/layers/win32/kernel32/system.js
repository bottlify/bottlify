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

/** Thread priorities. One value, because the scheduler has one. */
const THREAD_PRIORITY_NORMAL = 0;
const THREAD_PRIORITY_ERROR_RETURN = 0x7fffffff;

/** FormatMessage's two flags that change what it does. */
const FORMAT_MESSAGE_ALLOCATE_BUFFER = 0x00000100;
const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;

/** A string argument is at most this long; longer is a pointer that is not one. */
const MAX_STRING = 4096;

/** Codes this surface can also report. */
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;

/**
 * What FormatMessage says about a code, for the codes this build produces.
 *
 * A program shows or logs these, so they are the real Windows wordings rather
 * than paraphrases: a person searching for the text of an error they saw should
 * find the same results they would from a real machine.
 */
const SYSTEM_MESSAGES = Object.freeze({
    0: 'The operation completed successfully.',
    2: 'The system cannot find the file specified.',
    3: 'The system cannot find the path specified.',
    5: 'Access is denied.',
    6: 'The handle is invalid.',
    8: 'Not enough memory resources are available to process this command.',
    18: 'There are no more files.',
    50: 'The request is not supported.',
    80: 'The file exists.',
    87: 'The parameter is incorrect.',
    111: 'The file name is too long.',
    120: 'This function is not supported on this system.',
    122: 'The data area passed to a system call is too small.',
    126: 'The specified module could not be found.',
    127: 'The specified procedure could not be found.',
    145: 'The directory is not empty.',
    183: 'Cannot create a file when that file already exists.',
    259: 'No more data is available.',
    267: 'The directory name is invalid.',
});

/**
 * @typedef {Object} SystemHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => number} systemTimeMs   Guest wall clock, milliseconds since 1970.
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, type?: string) => any} resolveHandle
 * @property {(code: number) => void} exit
 * @property {() => any} park
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory, for the one caller that asks for it:
 *           FormatMessage with FORMAT_MESSAGE_ALLOCATE_BUFFER. Without
 *           it that one flag is refused and everything else works.
 */

/**
 * @param {SystemHost} host
 */
export function createSystemFunctions(host){
    /**
     * What SetErrorMode last recorded. Nothing reads it but the next call, and
     * that is enough: the save-and-restore pattern a caller uses depends only on
     * getting back what it put in.
     */
    let errorMode = 0;

    /** @param {number} address @param {number} maxLength */
    const readAnsi = (address, maxLength)=>{
        let text = '';
        for (let at = 0; at < maxLength; at++)
        {
            const byte = host.readMemory(address + at, 1)[0];
            if (byte === 0)
            {
                break;
            }
            text += String.fromCharCode(byte);
        }
        return text;
    };

    /** @param {number} address @param {string} text  Written with a terminator. */
    const writeAnsi = (address, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(address, bytes);
    };

    /**
     * The buffer protocol these two share: nothing written and the length
     * reported when there is no room, the length written otherwise -- in both
     * cases without the terminator, which is what FormatMessage and
     * GetProfileString both document.
     *
     * @param {number} buffer @param {number} size @param {string} text
     */
    const writeAnsiTo = (buffer, size, text)=>{
        if (buffer === 0 || text.length + 1 > size)
        {
            return 0;
        }
        writeAnsi(buffer, text);
        return text.length;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

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

        /**
         * BOOL Beep(DWORD dwFreq, DWORD dwDuration)
         *
         * Succeeds and makes no sound. The PC speaker it drives is not something
         * this build has, and blocking for the duration -- which is what a real
         * Beep does -- would stall the guest for a tone nobody hears.
         */
        Beep: {
            argBytes: 8,
            handler: ()=>1,
        },

        /**
         * UINT SetErrorMode(UINT uMode)
         *
         * Remembered and reported back, because the value is the return of the
         * next call: a caller sets a mode, does its work, and puts the previous
         * one back from what this returned. Nothing acts on it -- there are no
         * system error dialogs here to suppress -- but the save-and-restore
         * pattern has to work or a caller restores a mode it never had.
         */
        SetErrorMode: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([mode])=>{
                const previous = errorMode;
                errorMode = mode >>> 0;
                return previous;
            },
        },

        /**
         * int GetThreadPriority(HANDLE hThread)
         *
         * Every thread runs at normal priority. The scheduler here is round
         * robin over equal quanta, so a priority would be a number a caller
         * could set and read back while nothing about the run changed --
         * reporting normal is the one answer that is true.
         */
        GetThreadPriority: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>object(handle, 'thread')
                ? THREAD_PRIORITY_NORMAL
                : THREAD_PRIORITY_ERROR_RETURN,
        },

        /**
         * BOOL SetThreadPriority(HANDLE hThread, int nPriority)
         *
         * Accepted and not acted on, for the reason above. It succeeds rather
         * than failing because a program that cannot lower a worker's priority
         * often refuses to start the worker at all.
         */
        SetThreadPriority: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>object(handle, 'thread') ? 1 : 0,
        },

        /**
         * BOOL CreateProcessW(...)
         *
         * The same refusal as CreateProcessA, from the same place, because the
         * two differing about whether a process can be started would be a
         * program that succeeds through one spelling and not the other.
         */
        CreateProcessW: {
            argBytes: 40,
            handler: ()=>{
                host.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
                return 0;
            },
        },

        /**
         * DWORD GetProfileStringA(LPCSTR lpAppName, LPCSTR lpKeyName,
         *   LPCSTR lpDefault, LPSTR lpReturnedString, DWORD nSize)
         *
         * Reads win.ini, which does not exist, so every key is absent and the
         * caller's own default is what comes back. That is the documented
         * behaviour for a missing key and is exactly what a caller passing a
         * default is prepared for -- inventing a value instead would override a
         * choice the program already made.
         */
        GetProfileStringA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, , fallback, buffer, size])=>{
                const text = fallback === 0 ? '' : readAnsi(fallback >>> 0, MAX_STRING);
                return writeAnsiTo(buffer >>> 0, size >>> 0, text);
            },
        },

        /**
         * DWORD FormatMessageA(DWORD dwFlags, LPCVOID lpSource, DWORD dwMessageId,
         *   DWORD dwLanguageId, LPSTR lpBuffer, DWORD nSize, va_list *Arguments)
         *
         * Only the system half. A program calls this to turn the code it just
         * got from GetLastError into something to show or log, so the table
         * below covers the codes this build actually produces; anything else
         * gets a line naming the number, which is more use than an empty string
         * and cannot be mistaken for a real message.
         *
         * FORMAT_MESSAGE_ALLOCATE_BUFFER changes what lpBuffer means: it is no
         * longer the buffer but a pointer to where the address of one goes, and
         * a caller that passes it will call LocalFree on what it finds there.
         */
        FormatMessageA: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([flags, , messageId, , buffer, size])=>{
                if ((flags >>> 0 & FORMAT_MESSAGE_FROM_SYSTEM) === 0)
                {
                    // FROM_STRING and FROM_HMODULE both need a source this can
                    // not read: one is a format the caller supplies with inserts
                    // to expand, the other a message table in a module.
                    host.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
                    return 0;
                }
                const code = messageId >>> 0;
                const text = /** @type {Record<number, string>} */ (SYSTEM_MESSAGES)[code]
                    ?? `Error ${code}.`;

                if ((flags >>> 0 & FORMAT_MESSAGE_ALLOCATE_BUFFER) !== 0)
                {
                    if (!host.allocate || buffer === 0)
                    {
                        host.setLastError(ERROR_INVALID_PARAMETER);
                        return 0;
                    }
                    const address = host.allocate(text.length + 1);
                    if (address === 0)
                    {
                        host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                        return 0;
                    }
                    writeAnsi(address, text);
                    writeDword(buffer >>> 0, address);
                    return text.length;
                }
                return writeAnsiTo(buffer >>> 0, size >>> 0, text);
            },
        },

        /**
         * LPSTR lstrcatA(LPSTR lpString1, LPCSTR lpString2)
         *
         * Appends in place, and cannot check the destination has room -- the
         * signature carries no size, which is why Windows deprecated it. What it
         * does check is that both pointers are readable, because the usual
         * failure is a null second argument and the usual result of not checking
         * is a fault inside kernel32 rather than a NULL return the caller
         * handles.
         */
        lstrcatA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                if (first === 0 || second === 0)
                {
                    return 0;
                }
                const head = readAnsi(first >>> 0, MAX_STRING);
                const tail = readAnsi(second >>> 0, MAX_STRING);
                writeAnsi((first >>> 0) + head.length, tail);
                return first >>> 0;
            },
        },

        /**
         * LPSTR lstrcpynA(LPSTR lpString1, LPCSTR lpString2, int iMaxLength)
         *
         * Copies at most iMaxLength characters *including* the terminator, and
         * always terminates -- which is the difference from strncpy and the
         * whole reason a program reaches for it. Off by one here truncates every
         * copy or overruns every buffer.
         */
        lstrcpynA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, max])=>{
                const room = max | 0;
                if (destination === 0 || source === 0 || room <= 0)
                {
                    return 0;
                }
                const text = readAnsi(source >>> 0, MAX_STRING).slice(0, room - 1);
                writeAnsi(destination >>> 0, text);
                return destination >>> 0;
            },
        },
    };
}
