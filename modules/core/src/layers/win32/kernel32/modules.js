/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Finding a module, and finding a function inside one.
 *
 * A program that only calls through its own import table never comes here. Real
 * programs do more: they ask for an address by name, keep it, and call it much
 * later -- and some ask before anything obliges us to have decided what the
 * answer is. The address must be the same either way (§13.3), because a program
 * that caches yesterday's answer calls yesterday's address.
 *
 * That is why nothing here creates anything. Every system module we implement is
 * synthesised into guest memory once, when the process is assembled, with its
 * exports already at fixed addresses. LoadLibrary then reports what is already
 * there rather than bringing it into being, and an address taken at the first
 * instruction is the address that works at the last.
 */

/** A module name is at most this long; longer is a pointer that is not a string. */
const MAX_NAME = 260;

/** ERROR_MOD_NOT_FOUND, ERROR_PROC_NOT_FOUND. */
const ERROR_MOD_NOT_FOUND = 126;
const ERROR_PROC_NOT_FOUND = 127;

/**
 * A pointer whose high word is zero is an ordinal, not a string. It is the rule
 * GetProcAddress has always used, and the reason no string may live in the first
 * 64 KiB of the address space.
 *
 * @param {number} value
 */
const isOrdinal = value=>(value >>> 16) === 0;

/**
 * @typedef {Object} ModuleRecord
 * @property {string} name
 * @property {number} base
 * @property {(name: string) => number | null} addressOf
 * @property {(ordinal: number) => number | null} addressOfOrdinal
 */

/**
 * @typedef {Object} ModulesHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(name: string | null) => ModuleRecord | null} find
 *           A module by name; null asks for the running program's own image.
 * @property {(base: number) => ModuleRecord | null} byBase
 * @property {(code: number) => void} setLastError
 * @property {() => string} imagePath  The path the running program was loaded from.
 */

/**
 * @param {ModulesHost} host
 */
export function createModuleFunctions(host){
    /**
     * Writes a NUL-terminated string and reports what a Win32 out-parameter of
     * this shape reports: characters written, not counting the terminator, and
     * the buffer's own size when the name did not fit -- truncated, terminated,
     * and not an error, which is exactly the trap in that API.
     *
     * @param {number} buffer
     * @param {number} size
     * @param {string} text
     */
    const writeString = (buffer, size, text)=>{
        if (size === 0)
        {
            return 0;
        }
        const written = Math.min(text.length, size - 1);
        const bytes = new Uint8Array(written + 1);
        for (let at = 0; at < written; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(buffer, bytes);
        return written;
    };

    return {
        /**
         * HMODULE LoadLibraryA(LPCSTR lpLibFileName)
         *
         * An HMODULE is the base address the module is mapped at, which is why
         * a program can pass one straight to GetProcAddress and why some pass
         * it to code that reads the PE header there.
         */
        LoadLibraryA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                const module = host.find(host.readCString(name >>> 0, MAX_NAME));
                if (!module)
                {
                    host.setLastError(ERROR_MOD_NOT_FOUND);
                    return 0;
                }
                return module.base;
            },
        },

        /** HMODULE LoadLibraryExA(LPCSTR, HANDLE, DWORD dwFlags) */
        LoadLibraryExA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name])=>{
                // The flags select how a library is mapped -- as data, with or
                // without running its entry point. Ours have no entry point and
                // one mapping, so every flag describes what already happened.
                const module = host.find(host.readCString(name >>> 0, MAX_NAME));
                if (!module)
                {
                    host.setLastError(ERROR_MOD_NOT_FOUND);
                    return 0;
                }
                return module.base;
            },
        },

        /** BOOL FreeLibrary(HMODULE hLibModule) */
        FreeLibrary: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                // Nothing is unmapped: an address handed out earlier must keep
                // working, and a system module has no lifetime of its own.
                return host.byBase(handle >>> 0) ? 1 : 0;
            },
        },

        /**
         * FARPROC GetProcAddress(HMODULE hModule, LPCSTR lpProcName)
         *
         * The address is the export's own trampoline inside the module, the
         * same one its import table entry was bound to -- so a program that
         * compares the two finds them equal, as it does on Windows.
         */
        GetProcAddress: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, name])=>{
                const module = host.byBase(handle >>> 0);
                if (!module)
                {
                    host.setLastError(ERROR_MOD_NOT_FOUND);
                    return 0;
                }

                const address = isOrdinal(name >>> 0)
                    ? module.addressOfOrdinal(name >>> 0)
                    : module.addressOf(host.readCString(name >>> 0, MAX_NAME));
                if (address === null)
                {
                    host.setLastError(ERROR_PROC_NOT_FOUND);
                    return 0;
                }
                return address;
            },
        },

        /** DWORD GetModuleFileNameA(HMODULE hModule, LPSTR lpFilename, DWORD nSize) */
        GetModuleFileNameA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, size])=>{
                const module = handle === 0 ? host.find(null) : host.byBase(handle >>> 0);
                if (!module)
                {
                    host.setLastError(ERROR_MOD_NOT_FOUND);
                    return 0;
                }
                const system = `C:\\Windows\\System32\\${module.name}`;
                const path = handle === 0 ? host.imagePath() : system;
                return writeString(buffer >>> 0, size >>> 0, path);
            },
        },
    };
}
