/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ntdll's loader calls: a module's handle, a load, an export's address, a
 * reference, the loader lock and the DLL directory.
 *
 * On Windows kernel32's loader calls are made of these; here the loader is
 * kernel32's, so each is that call answered as a status, its names counted
 * strings. One loader means a module loaded through LdrLoadDll is released
 * by FreeLibrary and found by GetModuleHandle, as a program mixing the two
 * expects.
 */

import { STATUS } from './status.js';
import { DLL_SEARCH_PATH } from '../kernel32/modules.js';

const STATUS_PROCEDURE_NOT_FOUND = 0xc000007a;
const STATUS_ORDINAL_NOT_FOUND = 0xc0000138;
const STATUS_INVALID_PARAMETER_1 = 0xc00000ef;
const STATUS_INVALID_PARAMETER_2 = 0xc00000f0;
const STATUS_INVALID_PARAMETER_3 = 0xc00000f1;

/** GetModuleHandleEx's flags. */
const GET_MODULE_HANDLE_EX_PIN = 0x1;
const GET_MODULE_HANDLE_EX_UNCHANGED_REFCOUNT = 0x2;
const GET_MODULE_HANDLE_EX_FROM_ADDRESS = 0x4;
/** LdrGetDllHandleEx's and LdrAddRefDll's. */
const LDR_UNCHANGED_REFCOUNT = 0x1;
const LDR_PIN = 0x2;
const LDR_ADDREF_DLL_PIN = 0x1;
/** LdrLockLoaderLock's: raise no exception, and only try. */
const LDR_LOCK_RAISE_ON_ERRORS = 0x1;
const LDR_LOCK_TRY_ONLY = 0x2;
/** The disposition a lock that was taken reports. */
const LDR_LOCK_ACQUIRED = 1;
/** The longest path, in characters, a string read here is taken to be. */
const MAX_PATH_CHARACTERS = 32767;
/** ERROR_PROC_NOT_FOUND, which GetProcAddress leaves. */
const ERROR_PROC_NOT_FOUND = 127;

/**
 * The calls these are made of; without one, the calls over it stay unexported.
 */
export const LOADER_ENTRIES = ['GetModuleHandleExW', 'LoadLibraryW', 'LoadLibraryExW',
    'GetProcAddress', 'GetLastError', 'SetDllDirectoryW', 'GetDllDirectoryW'];

/**
 * @typedef {Object} LoaderHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {Record<string, { handler: Function }>} kernel32
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => boolean} free
 * @property {{ register: (callback: number, context: number) => number,
 *     unregister: (cookie: number) => boolean }} [notifications]  The loader's
 *     LdrRegisterDllNotification callbacks; absent, the two calls are not exported.
 */

/**
 * @param {LoaderHost} host
 * @returns {Record<string, { argBytes: number, handler: Function }>}
 */
export function createLoaderFunctions({
    readMemory, writeMemory, kernel32, allocate, free, notifications,
})
{
    /** How many times the loader lock was taken: each a cookie of its own. */
    let locks = 0;
    /** @param {number} address */
    const u32 = address=>new DataView(readMemory(address, 4).buffer.slice(0)).getUint32(0, true);
    /** @param {number} address */
    const u16 = address=>new DataView(readMemory(address, 2).buffer.slice(0)).getUint16(0, true);
    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        writeMemory(address, bytes);
    };
    /**
     * A NUL-terminated UTF-16 string, read up to the longest path there is.
     *
     * @param {number} address
     */
    const wideAt = address=>{
        let text = '';
        for (let at = address; text.length < MAX_PATH_CHARACTERS; at += 2)
        {
            const unit = u16(at);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };
    /**
     * A string, terminated, as UTF-16 in a block of the process heap the
     * caller frees with RtlFreeHeap.
     *
     * @param {string} text
     */
    const heapWide = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at * 2] = text.charCodeAt(at) & 0xff;
            bytes[at * 2 + 1] = text.charCodeAt(at) >> 8;
        }
        const at = allocate(bytes.length);
        writeMemory(at, bytes);
        return at;
    };
    /**
     * A counted string's bytes, terminated, in a block of the process heap the
     * caller frees: what a kernel32 call taking a C string reads.
     *
     * @param {number} counted @param {number} unit  2 for UNICODE_STRING, 1 for ANSI_STRING
     */
    const terminated = (counted, unit)=>{
        const length = u16(counted);
        const at = allocate(length + unit);
        writeMemory(at, new Uint8Array(length + unit));
        if (length > 0)
        {
            writeMemory(at, readMemory(u32(counted + 4), length));
        }
        return at;
    };
    /**
     * A module's handle through GetModuleHandleExW, as a status.
     *
     * @param {number} flags  GetModuleHandleEx's @param {number} name @param {number} out
     */
    const handleOf = (flags, name, out)=>{
        if ((out >>> 0) === 0)
        {
            return STATUS.INVALID_PARAMETER;
        }
        const scratch = allocate(4);
        const text = (flags & GET_MODULE_HANDLE_EX_FROM_ADDRESS) !== 0 ? name
            : terminated(name >>> 0, 2);
        try
        {
            const found = kernel32.GetModuleHandleExW.handler([flags, text, scratch]) !== 0;
            setU32(out >>> 0, found ? u32(scratch) : 0);
            return found ? STATUS.SUCCESS : STATUS.DLL_NOT_FOUND;
        }
        finally
        {
            free(scratch);
            if (text !== name)
            {
                free(text);
            }
        }
    };

    return {
        /**
         * NTSTATUS LdrGetDllHandle(PWSTR DllPath, PULONG DllCharacteristics,
         *     PUNICODE_STRING DllName, PVOID *DllHandle)
         *
         * A loaded module by its name, its reference count left as it was.
         */
        LdrGetDllHandle: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , name, out])=>handleOf(GET_MODULE_HANDLE_EX_UNCHANGED_REFCOUNT,
                name, out),
        },

        /**
         * NTSTATUS LdrGetDllHandleEx(ULONG Flags, PWSTR DllPath, PULONG DllCharacteristics,
         *     PUNICODE_STRING DllName, PVOID *DllHandle)
         *
         * The same, a reference taken unless the flags say otherwise, or the
         * module pinned.
         */
        LdrGetDllHandleEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([flags, , , name, out])=>{
                if (((flags >>> 0) & ~(LDR_UNCHANGED_REFCOUNT | LDR_PIN)) !== 0
                    || (flags & (LDR_UNCHANGED_REFCOUNT | LDR_PIN))
                        === (LDR_UNCHANGED_REFCOUNT | LDR_PIN))
                {
                    return STATUS.INVALID_PARAMETER;
                }
                return handleOf(((flags & LDR_UNCHANGED_REFCOUNT) !== 0
                    ? GET_MODULE_HANDLE_EX_UNCHANGED_REFCOUNT : 0)
                    | ((flags & LDR_PIN) !== 0 ? GET_MODULE_HANDLE_EX_PIN : 0), name, out);
            },
        },

        /**
         * NTSTATUS LdrAddRefDll(ULONG Flags, PVOID BaseAddress)
         *
         * One more reference on a loaded module, or the module pinned.
         */
        LdrAddRefDll: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flags, base])=>{
                if (((flags >>> 0) & ~LDR_ADDREF_DLL_PIN) !== 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const scratch = allocate(4);
                try
                {
                    return handleOf(GET_MODULE_HANDLE_EX_FROM_ADDRESS
                        | ((flags & LDR_ADDREF_DLL_PIN) !== 0 ? GET_MODULE_HANDLE_EX_PIN : 0),
                    base, scratch);
                }
                finally
                {
                    free(scratch);
                }
            },
        },

        /**
         * NTSTATUS LdrLoadDll(PWSTR SearchPath, PULONG DllCharacteristics,
         *     PUNICODE_STRING DllName, PVOID *BaseAddress)
         *
         * LoadLibraryW's load and search; a module it cannot find is
         * STATUS_DLL_NOT_FOUND, and *BaseAddress is left as it was. A
         * SearchPath with its low bit set is not a path but LoadLibraryEx's
         * LOAD_LIBRARY_SEARCH_* flags, as kernelbase hands them down since
         * Windows 8; a path is the directories, `;` apart, a name that does
         * not say where it is is looked for in - those alone, in order.
         */
        LdrLoadDll: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([path, , name, out])=>{
                if ((out >>> 0) === 0 || (name >>> 0) === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const counted = terminated(name >>> 0, 2);
                const asked = wideAt(counted);
                free(counted);
                const fixed = /^([A-Za-z]:|[\\/]|\.\.?[\\/])/.test(asked);
                /** Where it is looked for: as asked, or under each directory of the path. */
                const places = (path & 1) !== 0 || (path >>> 0) === 0 || fixed ? [asked]
                    : wideAt(path >>> 0).split(';').filter(directory=>directory !== '')
                        .map(directory=>`${directory.replace(/[\\/]+$/, '')}\\${asked}`);
                /**
                 * @param {number} next
                 * @returns {number | Promise<number>}
                 */
                const look = next=>{
                    if (next >= places.length)
                    {
                        return STATUS.DLL_NOT_FOUND;
                    }
                    const text = heapWide(places[next]);
                    /** @param {number} base */
                    const settle = base=>{
                        free(text);
                        if ((base >>> 0) === 0)
                        {
                            return look(next + 1);
                        }
                        setU32(out >>> 0, base >>> 0);
                        return STATUS.SUCCESS;
                    };
                    const base = (path & 1) !== 0
                        ? kernel32.LoadLibraryExW.handler([text, 0, (path >>> 0) & ~1])
                        : kernel32.LoadLibraryW.handler([text]);
                    return typeof base?.then === 'function' ? base.then(settle) : settle(base);
                };
                return look(0);
            },
        },

        /**
         * NTSTATUS LdrGetDllPath(PCWSTR Module, ULONG Flags, PWSTR *Path, PWSTR *Unknown)
         *
         * The directories a library is looked for in, `;` apart, in a block of
         * the process heap RtlReleasePath gives back: under LoadLibraryEx's
         * flags `Flags`, for the library `Module` names (its own directory for
         * LOAD_WITH_ALTERED_SEARCH_PATH and LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR).
         * *Unknown is NULL.
         */
        LdrGetDllPath: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([module, flags, out, unknown])=>{
                const search = /** @type {any} */ (kernel32)[DLL_SEARCH_PATH];
                if ((out >>> 0) === 0 || (unknown >>> 0) === 0 || !search)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const named = (module >>> 0) === 0 ? '' : wideAt(module >>> 0);
                setU32(out >>> 0, heapWide(search(named, flags >>> 0).join(';')));
                setU32(unknown >>> 0, 0);
                return STATUS.SUCCESS;
            },
        },

        ...notifications ? {
            /**
             * NTSTATUS LdrRegisterDllNotification(ULONG Flags,
             *     PLDR_DLL_NOTIFICATION_FUNCTION Callback, PVOID Context, PVOID *Cookie)
             *
             * The callback is told of every library loaded after its mapping
             * and before its DllMain, and of every one unloaded after its
             * DllMain, with the context; the cookie takes it back. Flags must
             * be zero.
             */
            LdrRegisterDllNotification: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([flags, callback, context, cookie])=>{
                    if (flags !== 0 || (callback >>> 0) === 0 || (cookie >>> 0) === 0)
                    {
                        return STATUS.INVALID_PARAMETER;
                    }
                    setU32(cookie >>> 0, notifications.register(callback, context));
                    return STATUS.SUCCESS;
                },
            },
            /**
             * NTSTATUS LdrUnregisterDllNotification(PVOID Cookie): a cookie
             * not handed out, or already taken back, is STATUS_DLL_NOT_FOUND.
             */
            LdrUnregisterDllNotification: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([cookie])=>(notifications.unregister(cookie)
                    ? STATUS.SUCCESS : STATUS.DLL_NOT_FOUND),
            },
        } : {},

        /** void RtlReleasePath(PWSTR Path): what LdrGetDllPath handed out. */
        RtlReleasePath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>{
                if ((path >>> 0) !== 0)
                {
                    free(path >>> 0);
                }
                return 0;
            },
        },

        /**
         * NTSTATUS LdrGetProcedureAddress(PVOID BaseAddress, PANSI_STRING Name,
         *     ULONG Ordinal, PVOID *Address)
         *
         * An export by name, or by ordinal where no name is given.
         */
        LdrGetProcedureAddress: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([base, name, ordinal, out])=>{
                if ((out >>> 0) === 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const text = (name >>> 0) === 0 ? 0 : terminated(name >>> 0, 1);
                try
                {
                    const address = kernel32.GetProcAddress.handler([base,
                        text !== 0 ? text : ordinal & 0xffff]) >>> 0;
                    setU32(out >>> 0, address);
                    if (address !== 0)
                    {
                        return STATUS.SUCCESS;
                    }
                    if (kernel32.GetLastError.handler([]) !== ERROR_PROC_NOT_FOUND)
                    {
                        return STATUS.DLL_NOT_FOUND;
                    }
                    return text !== 0 ? STATUS_PROCEDURE_NOT_FOUND : STATUS_ORDINAL_NOT_FOUND;
                }
                finally
                {
                    if (text !== 0)
                    {
                        free(text);
                    }
                }
            },
        },

        /**
         * NTSTATUS LdrLockLoaderLock(ULONG Flags, PULONG Disposition, PULONG_PTR Cookie)
         *
         * The engine's loader runs a load whole, so the lock is always to be
         * had: taken, with a cookie to hand back. A try with nowhere to say
         * whether it was taken is refused.
         */
        LdrLockLoaderLock: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([flags, disposition, cookie])=>{
                // Both answers are cleared before anything is judged, a
                // refusal's included.
                if ((disposition >>> 0) !== 0)
                {
                    setU32(disposition >>> 0, 0);
                }
                if ((cookie >>> 0) !== 0)
                {
                    setU32(cookie >>> 0, 0);
                }
                if (((flags >>> 0) & ~(LDR_LOCK_RAISE_ON_ERRORS | LDR_LOCK_TRY_ONLY)) !== 0)
                {
                    return STATUS_INVALID_PARAMETER_1;
                }
                if ((flags & LDR_LOCK_TRY_ONLY) !== 0 && (disposition >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER_2;
                }
                if ((cookie >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER_3;
                }
                if ((disposition >>> 0) !== 0)
                {
                    setU32(disposition >>> 0, LDR_LOCK_ACQUIRED);
                }
                setU32(cookie >>> 0, ++locks);
                return STATUS.SUCCESS;
            },
        },

        /** NTSTATUS LdrUnlockLoaderLock(ULONG Flags, ULONG_PTR Cookie): a cookie of none refused. */
        LdrUnlockLoaderLock: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flags, cookie])=>{
                if (((flags >>> 0) & ~LDR_LOCK_RAISE_ON_ERRORS) !== 0)
                {
                    return STATUS_INVALID_PARAMETER_1;
                }
                return (cookie >>> 0) === 0 ? STATUS_INVALID_PARAMETER_2 : STATUS.SUCCESS;
            },
        },

        /** NTSTATUS LdrSetDllDirectory(PUNICODE_STRING Directory): SetDllDirectoryW's. */
        LdrSetDllDirectory: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([directory])=>{
                const text = terminated(directory >>> 0, 2);
                try
                {
                    kernel32.SetDllDirectoryW.handler([text]);
                    return STATUS.SUCCESS;
                }
                finally
                {
                    free(text);
                }
            },
        },

        /**
         * NTSTATUS LdrGetDllDirectory(PUNICODE_STRING Directory)
         *
         * GetDllDirectoryW's into the string's buffer; one too small is told
         * the length it needs in bytes.
         */
        LdrGetDllDirectory: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([directory])=>{
                const room = u16((directory >>> 0) + 2) >>> 1;
                const needed = kernel32.GetDllDirectoryW.handler([0, 0]) >>> 0;
                const length = (needed - 1) * 2;
                writeMemory(directory >>> 0, Uint8Array.of(length & 0xff, length >>> 8 & 0xff));
                if (needed > room)
                {
                    return STATUS.BUFFER_TOO_SMALL;
                }
                kernel32.GetDllDirectoryW.handler([room, u32((directory >>> 0) + 4)]);
                return STATUS.SUCCESS;
            },
        },

        /** BOOLEAN RtlDllShutdownInProgress(void): the process is not ending while it runs. */
        RtlDllShutdownInProgress: { argBytes: 0, handler: ()=>0 },
    };
}
