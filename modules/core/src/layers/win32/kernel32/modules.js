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
const ERROR_INVALID_HANDLE = 6;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NOACCESS = 998;
/** sizeof(MODULEINFO): the base, the image's size and its entry point. */
const MODULEINFO_SIZE = 12;

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
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           For a module's own headers; absent, its information is not given.
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
 * @property {(code: number) => any} [exitThread]
 *           Ends the calling thread as ExitThread does, parking it: for a call
 *           still in flight.
 * @property {() => any} [currentThread]
 * @property {(thread: any, code: number) => Promise<number> | null} [endThread]
 *           Ends a thread that ended itself, without parking it: for a call
 *           that has already been suspended, whose thread is no longer the one
 *           on the processor. Null once it has ended, or the promise of
 *           telling the libraries of its detach on it first and then ending it.
 * @property {(base: number) => void} [disableThreadCalls]
 *           Stops telling a library of the threads that start and end. A
 *           library with static thread-local storage goes on being told: its
 *           TLS callbacks build each thread's thread-local objects.
 * @property {() => { base: number, path: string }[]} [list]
 *           Every module of the process, the image first: what psapi's
 *           EnumProcessModules hands out.
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
        /** @param {number} base */
        const settle = base=>{
            if (base === 0)
            {
                host.setLastError(ERROR_MOD_NOT_FOUND);
            }
            return base;
        };
        const answer = loadOnce(name, flags);
        // The directory SetDllDirectory named, for a bare name nothing else
        // found. Windows looks there before the system directories rather
        // than after them; the loader's own search is one step that cannot
        // be split, so a name the system also answers for comes from the
        // system here.
        const bare = !/[\\/:]/.test(name);
        if (!bare || dllDirectory === null || dllDirectory === '')
        {
            return typeof answer === 'number' ? settle(answer) : answer.then(settle);
        }
        const beside = `${dllDirectory.replace(/\\+$/, '')}\\${name}`;
        /** @param {number} base */
        const retry = base=>{
            if (base !== 0)
            {
                return base;
            }
            const again = loadOnce(beside, flags);
            return typeof again === 'number' ? settle(again) : again.then(settle);
        };
        return typeof answer === 'number' ? retry(answer) : answer.then(retry);
    };

    /**
     * One look for a library by the name given.
     *
     * @param {string} name @param {number} flags
     * @returns {number | Promise<number>}
     */
    const loadOnce = (name, flags)=>{
        // Through the loader even for a module already here: only it knows
        // whether this is the load that has to run the module's entry point.
        const known = host.find(name);
        const answer = host.load ? host.load(name, flags) : known?.base ?? 0;
        return typeof answer === 'number' ? answer || known?.base || 0 : answer;
    };

    /**
     * What SetDllDirectory last named: null for the default search, an empty
     * string for the default without the current directory.
     *
     * @type {string | null}
     */
    let dllDirectory = null;

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

    /**
     * A module's path or its file name, ANSI or wide, cut to `size`
     * characters with the terminator inside them; the characters written.
     *
     * @param {number} handle @param {number} buffer @param {number} size
     * @param {boolean} wide @param {boolean} baseName
     */
    const moduleText = (handle, buffer, size, wide, baseName)=>{
        const module = handle === 0 ? host.find(null) : host.byBase(handle >>> 0);
        if (!module)
        {
            host.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        const path = handle === 0 ? host.imagePath() : fileNameOf(module);
        const text = baseName ? path.slice(path.lastIndexOf(SEPARATOR) + 1) : path;
        if ((size >>> 0) === 0)
        {
            host.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
        if (!wide)
        {
            return writeString(buffer >>> 0, size >>> 0, text);
        }
        const kept = text.slice(0, (size >>> 0) - 1);
        const bytes = new Uint8Array((kept.length + 1) * 2);
        for (let at = 0; at < kept.length; at++)
        {
            bytes[at * 2] = kept.charCodeAt(at) & 0xff;
            bytes[at * 2 + 1] = kept.charCodeAt(at) >> 8;
        }
        host.writeMemory(buffer >>> 0, bytes);
        return kept.length;
    };

    /**
     * @param {number} size @param {number} buffer @param {boolean} wide
     */
    const getDllDirectory = (size, buffer, wide)=>{
        const text = dllDirectory ?? '';
        if (text.length + 1 > size || buffer === 0)
        {
            return text.length + 1;
        }
        if (wide)
        {
            const bytes = new Uint8Array((text.length + 1) * 2);
            for (let at = 0; at < text.length; at++)
            {
                bytes[at * 2] = text.charCodeAt(at) & 0xff;
                bytes[at * 2 + 1] = text.charCodeAt(at) >> 8;
            }
            host.writeMemory(buffer, bytes);
        }
        else
        {
            host.writeMemory(buffer, encodeAnsi(`${text}\0`));
        }
        return text.length;
    };

    /** @param {number} handle */
    const freeLibrary = handle=>{
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

        /**
         * BOOL SetDllDirectoryA/W(LPCSTR lpPathName) and
         * DWORD GetDllDirectoryA/W(DWORD nBufferLength, LPSTR lpBuffer)
         *
         * The directory LoadLibrary looks in for a bare name (`load`); NULL
         * puts the default search back. Getting it answers as the path calls
         * do: the length without the terminator when it fits, the size
         * needed with it when it does not, and an empty string when none is
         * set.
         */
        SetDllDirectoryA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>{
                dllDirectory = (path >>> 0) === 0 ? null : host.readCString(path >>> 0, MAX_NAME);
                return 1;
            },
        },
        SetDllDirectoryW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>{
                dllDirectory = (path >>> 0) === 0 ? null
                    : host.readWideString(path >>> 0, MAX_NAME * 2);
                return 1;
            },
        },
        GetDllDirectoryA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>getDllDirectory(size >>> 0, buffer >>> 0, false),
        },
        GetDllDirectoryW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>getDllDirectory(size >>> 0, buffer >>> 0, true),
        },

        /** BOOL FreeLibrary(HMODULE hLibModule) */
        FreeLibrary: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>freeLibrary(handle),
        },

        /**
         * VOID FreeLibraryAndExitThread(HMODULE hLibModule, DWORD dwExitCode) --
         * does not return
         *
         * What a thread running a library's code calls to unload that library
         * and end itself, which it could not do in two calls.
         */
        FreeLibraryAndExitThread: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                // Held before anything can wait: once the library's DllMain
                // has to hear the detach, this call is suspended and the loop
                // turns, and whichever thread is on the processor by the time
                // it is done -- if any, and on this executor at all -- is not
                // the one to end.
                const thread = host.currentThread?.();
                const freed = freeLibrary(handle);
                if (!(freed instanceof Promise))
                {
                    return host.exitThread?.(code >>> 0) ?? 0;
                }
                // Its call is no longer in flight to be parked; the answer it
                // is suspended on only has to arrive, and a thread that has
                // ended never returns to read it. Not before the libraries
                // still loaded are told of its end on it, as ExitThread tells
                // them: answered sooner, the call would resume the thread
                // under its own detach.
                return freed.then(()=>host.endThread?.(thread, code >>> 0) ?? 0);
            },
        },

        /**
         * BOOL DisableThreadLibraryCalls(HMODULE hLibModule)
         *
         * A library saying it does not want DLL_THREAD_ATTACH and
         * DLL_THREAD_DETACH for every thread that comes and goes: from now on
         * neither its entry point nor its TLS callbacks hear of a thread. Asked
         * from inside its own attach, as the documentation advises, and a
         * library that checks the answer is told yes -- also when it has static
         * thread-local storage, which goes on being told, the call making "no
         * optimisation" for it (decisions.md).
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
                host.disableThreadCalls?.(handle >>> 0);
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

        /**
         * BOOL K32GetModuleInformation(HANDLE hProcess, HMODULE hModule,
         *     LPMODULEINFO lpmodinfo, DWORD cb)
         *
         * psapi's GetModuleInformation as kernel32 exports it: where a module
         * of this process is mapped, the size of its image and where it starts,
         * read from its own headers -- a NULL handle is the program's.
         */
        K32GetModuleInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, info, size])=>{
                const module = handle === 0 ? host.find(null) : host.byBase(handle >>> 0);
                if (!module || !host.readMemory)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                if ((size >>> 0) < MODULEINFO_SIZE)
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                const read = (/** @type {number} */ address)=>new DataView(
                    host.readMemory?.(address, 4).slice().buffer ?? new ArrayBuffer(4))
                    .getUint32(0, true);
                const optional = module.base + read(module.base + 0x3c) + 24;
                const entry = read(optional + 16);
                const out = new DataView(new ArrayBuffer(MODULEINFO_SIZE));
                out.setUint32(0, module.base, true);
                out.setUint32(4, read(optional + 56), true);
                out.setUint32(8, entry === 0 ? 0 : module.base + entry, true);
                host.writeMemory(info >>> 0, new Uint8Array(out.buffer));
                return 1;
            },
        },

        /**
         * BOOL K32EnumProcessModules(HANDLE hProcess, HMODULE *lphModule, DWORD cb,
         *     LPDWORD lpcbNeeded)
         *
         * psapi's EnumProcessModules: as many module handles as fit in `cb`
         * bytes, the image first, and in `lpcbNeeded` the bytes all of them
         * take -- a caller sizes its array from a first call that fits none.
         */
        K32EnumProcessModules: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handles, size, needed])=>{
                if ((needed >>> 0) === 0)
                {
                    host.setLastError(ERROR_NOACCESS);
                    return 0;
                }
                const bases = (host.list?.() ?? []).map(module=>module.base >>> 0);
                const fits = Math.min(bases.length, Math.floor((size >>> 0) / 4));
                if (fits > 0)
                {
                    const out = new DataView(new ArrayBuffer(fits * 4));
                    bases.slice(0, fits).forEach((base, at)=>out.setUint32(at * 4, base, true));
                    host.writeMemory(handles >>> 0, new Uint8Array(out.buffer));
                }
                const total = new DataView(new ArrayBuffer(4));
                total.setUint32(0, bases.length * 4, true);
                host.writeMemory(needed >>> 0, new Uint8Array(total.buffer));
                return 1;
            },
        },

        /**
         * DWORD K32GetModuleFileNameExA(HANDLE hProcess, HMODULE hModule,
         *     LPSTR lpFilename, DWORD nSize) and the wide form: GetModuleFileName
         *     asked about a process, which here is always this one.
         */
        K32GetModuleFileNameExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, buffer, size])=>moduleText(handle, buffer, size, false, false),
        },
        K32GetModuleFileNameExW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, buffer, size])=>moduleText(handle, buffer, size, true, false),
        },

        /**
         * DWORD K32GetModuleBaseNameA(HANDLE hProcess, HMODULE hModule,
         *     LPSTR lpBaseName, DWORD nSize) and the wide form: the file name
         *     of a module's path, without its directory.
         */
        K32GetModuleBaseNameA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, buffer, size])=>moduleText(handle, buffer, size, false, true),
        },
        K32GetModuleBaseNameW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, buffer, size])=>moduleText(handle, buffer, size, true, true),
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
