/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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

import { encodeAnsi } from './locale.js';

/** A module name is at most this long; longer is a pointer that is not a string. */
const MAX_NAME = 260;

/** The path separator, named so it is not confused with an escape. */
const SEPARATOR = String.fromCharCode(92);

/** ERROR_MOD_NOT_FOUND, ERROR_PROC_NOT_FOUND. */
const ERROR_MOD_NOT_FOUND = 126;
const ERROR_PROC_NOT_FOUND = 127;
const ERROR_INVALID_PARAMETER = 87;
/** What FreeLibrary says of a data-file handle that names no mapping. */
const ERROR_BAD_EXE_FORMAT = 193;

/**
 * A pointer whose high word is zero is an ordinal, not a string. It is the rule
 * GetProcAddress has always used, and the reason no string may live in the first
 * 64 KiB of the address space.
 *
 * @param {number} value
 */
const isOrdinal = value=>(value >>> 16) === 0;

/**
 * Whether a run-time load has to look beside the program before it answers
 * from the engine's own table.
 *
 * Windows maps a KnownDLL out of the system directory and never searches the
 * application's own directory for it, so for one of those the table entry is
 * the only answer and a file of the same name beside the program is ignored.
 * For every other name the application's directory is searched first: a file
 * the program brought is what loads, and our table is the fallback for when
 * there is none. A library already mapped out of a file is that file's answer
 * already -- a second LoadLibrary gets the handle it already has.
 *
 * @param {boolean} knownDll       The name is one Windows keeps under KnownDLLs.
 * @param {boolean} mappedFromFile It is already mapped out of a volume file.
 */
export function searchesBesideProgram(knownDll, mappedFromFile){
    return !knownDll && !mappedFromFile;
}

/**
 * @typedef {Object} ModuleRecord
 * @property {string} name
 * @property {number} base
 * @property {(name: string) => number | null} addressOf
 * @property {(ordinal: number) => number | null} addressOfOrdinal
 * @property {string} [path]  Where it was loaded from, when it came from a file.
 * @property {() => number | Promise<number>} [release]
 *           Gives back one reference a LoadLibrary took; the last one unloads
 *           the module, its DllMain told first. A module without one -- the
 *           program, and every library it imports -- is never unloaded.
 */

/**
 * @typedef {Object} ModulesHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(name: string | null) => ModuleRecord | null} find
 *           A module by name; null asks for the running program's own image.
 * @property {(base: number) => ModuleRecord | null} byBase
 * @property {(code: number) => void} setLastError
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {() => string} imagePath  The path the running program was loaded from.
 * @property {(name: string, flags?: number) => number | Promise<number>} [load]
 *           Brings a library in if it is not here yet, answering with its base
 *           or zero. Answers synchronously whenever it can -- see LoadLibraryA.
 *           `flags` are LoadLibraryEx's, which say how it is to be loaded.
 * @property {(handle: number) => ModuleRecord | null} [dataFile]
 *           A library LoadLibraryEx mapped as data, by the handle it gave out:
 *           no module, so not among the ones `byBase` knows.
 * @property {(asked: { module: string, name: string, found: number }) => void} [resolved]
 *           Told what a program looked up at runtime and what it was given. A
 *           name we answer zero to is one the program then decides about, and
 *           what it decides is usually invisible from anywhere else.
 */

/**
 * @param {ModulesHost} host
 */
export function createModuleFunctions(host){
    /**
     * Libraries that asked not to hear about threads. Kept because the answer
     * to asking twice is still yes and because a diagnostic should be able to
     * say which libraries opted out; nothing else reads it, since honouring the
     * request is indistinguishable from not honouring it.
     *
     * @type {Set<number>}
     */
    const withoutThreadCalls = new Set();

    /**
     * Where a module's file is, as a program asking about it expects.
     *
     * This matters more than it looks. A library is asked where it lives and
     * then looks for its own data beside itself, so a wrong directory does not
     * fail here: it fails much later, as data that is not where the program is
     * certain it put it.
     *
     * A library read off the volume knows its own path, and a library a game
     * ships does not live in a system directory. A module we synthesised has no
     * file at all, and the system directory is the honest answer for something
     * that exists only because Windows would have had it there — a program
     * comparing that path against the system directory is right to find them
     * equal.
     *
     * @param {ModuleRecord} module
     */
    const fileNameOf = module=>module.path
        ?? `C:${SEPARATOR}Windows${SEPARATOR}System32${SEPARATOR}${module.name}`;

    /**
     * What both LoadLibrary entry points do.
     *
     * The answer is a number when it can be, and a promise only when a library
     * has to be read off the volume. That distinction is the whole of it: the
     * dispatcher decides a call is asynchronous by whether a promise came back,
     * so an implementation that always returned one would park and unpark the
     * guest thread on every call -- including a library that is already here
     * and one that is known not to exist, which titles ask about once a frame
     * while probing for hardware that may have been plugged in.
     *
     * Which is also why there is no separate "is it loaded" predicate beside
     * this. A second decision function drifts from the first, and then the
     * answer about whether waiting is needed stops matching the waiting.
     *
     * @param {string} name
     * @param {number} [flags]  LoadLibraryEx's.
     * @returns {number | Promise<number>}
     */
    const load = (name, flags = 0)=>{
        // Through the loader even for a module already here: only it knows
        // whether this is the load that has to run the module's entry point.
        const known = host.find(name);
        const answer = host.load ? host.load(name, flags) : known?.base ?? 0;
        if (typeof answer === 'number')
        {
            const base = answer || known?.base || 0;
            if (base === 0)
            {
                host.setLastError(ERROR_MOD_NOT_FOUND);
            }
            return base;
        }
        return answer.then(base=>{
            if (base === 0)
            {
                host.setLastError(ERROR_MOD_NOT_FOUND);
            }
            return base;
        });
    };

    /**
     * Writes a NUL-terminated string and reports what a Win32 out-parameter of
     * this shape reports: characters written, not counting the terminator, and
     * the buffer's own size when the name did not fit -- truncated, terminated,
     * and not an error, which is exactly the trap in that API. The name is in
     * the ANSI page, as the paths a program gives the ANSI calls are read.
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
        host.writeMemory(buffer, encodeAnsi(`${text.slice(0, written)}\0`));
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
            handler: ([name])=>load(host.readCString(name >>> 0, MAX_NAME)),
        },

        /**
         * HMODULE LoadLibraryExA(LPCSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
         * HMODULE LoadLibraryExW(LPCWSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
         *
         * The flags say how the library is loaded -- as data for its resources,
         * or mapped without its imports resolved or its entry point run -- and
         * the loader acts on them. hFile is reserved and must be NULL.
         */
        LoadLibraryExA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, file, flags])=>{
                if ((file >>> 0) !== 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return load(host.readCString(name >>> 0, MAX_NAME), flags >>> 0);
            },
        },
        LoadLibraryExW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, file, flags])=>{
                if ((file >>> 0) !== 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return load(host.readWideString(name >>> 0, MAX_NAME * 2), flags >>> 0);
            },
        },

        /** BOOL FreeLibrary(HMODULE hLibModule) */
        FreeLibrary: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const module = host.byBase(handle >>> 0) ?? host.dataFile?.(handle >>> 0) ?? null;
                if (!module)
                {
                    // A handle with the low bits set is a data file's, and one
                    // that names no mapping is not an image at all.
                    host.setLastError(
                        (handle & 3) !== 0 ? ERROR_BAD_EXE_FORMAT : ERROR_MOD_NOT_FOUND);
                    return 0;
                }
                return module.release ? module.release() : 1;
            },
        },

        /**
         * BOOL DisableThreadLibraryCalls(HMODULE hLibModule)
         *
         * A library saying it does not want its entry point called for every
         * thread that comes and goes. Accepted and recorded rather than acted
         * on: the caller's intent is an optimisation, and the observable
         * behaviour of honouring it is a DllMain that is not called -- which is
         * indistinguishable from one that is called and does nothing.
         *
         * It is answered at all because a library calls this from inside its own
         * attach and checks the result, and because refusing a call that cannot
         * fail is worse than agreeing to something harmless.
         */
        DisableThreadLibraryCalls: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const module = host.byBase(handle >>> 0);
                if (!module)
                {
                    host.setLastError(ERROR_MOD_NOT_FOUND);
                    return 0;
                }
                withoutThreadCalls.add(handle >>> 0);
                return 1;
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

                const wanted = isOrdinal(name >>> 0)
                    ? `#${name >>> 0}`
                    : host.readCString(name >>> 0, MAX_NAME);
                const address = isOrdinal(name >>> 0)
                    ? module.addressOfOrdinal(name >>> 0)
                    : module.addressOf(wanted);

                host.resolved?.({ module: module.name, name: wanted, found: address ?? 0 });
                if (address === null)
                {
                    host.setLastError(ERROR_PROC_NOT_FOUND);
                    return 0;
                }
                return address;
            },
        },

        /** HMODULE LoadLibraryW(LPCWSTR lpLibFileName) */
        LoadLibraryW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>load(host.readWideString(name >>> 0, MAX_NAME * 2)),
        },

        /**
         * DWORD GetModuleFileNameW(HMODULE hModule, LPWSTR lpFilename, DWORD nSize)
         *
         * The same path as the ANSI form, written wide. A C runtime asks for its
         * own module path early and compares it with what it finds elsewhere, so
         * the two spellings must name one file.
         */
        GetModuleFileNameW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, size])=>{
                const module = handle === 0 ? host.find(null) : host.byBase(handle >>> 0);
                if (!module)
                {
                    host.setLastError(ERROR_MOD_NOT_FOUND);
                    return 0;
                }
                const path = handle === 0 ? host.imagePath() : fileNameOf(module);
                const room = size >>> 0;
                if (buffer === 0 || room === 0)
                {
                    return 0;
                }
                const kept = path.slice(0, room - 1);
                const bytes = new Uint8Array((kept.length + 1) * 2);
                for (let at = 0; at < kept.length; at++)
                {
                    const code = kept.charCodeAt(at);
                    bytes[at * 2] = code & 0xff;
                    bytes[at * 2 + 1] = code >> 8;
                }
                host.writeMemory(buffer >>> 0, bytes);
                return kept.length;
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
                const path = handle === 0 ? host.imagePath() : fileNameOf(module);
                return writeString(buffer >>> 0, size >>> 0, path);
            },
        },
    };
}
