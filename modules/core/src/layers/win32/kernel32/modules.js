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

/** A module name is at most this long; longer is a pointer that is not a string. */
const MAX_NAME = 260;

/** The path separator, named so it is not confused with an escape. */
const SEPARATOR = String.fromCharCode(92);

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
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {() => string} imagePath  The path the running program was loaded from.
 * @property {(name: string) => number | Promise<number>} [load]
 *           Brings a library in if it is not here yet, answering with its base
 *           or zero. Answers synchronously whenever it can -- see LoadLibraryA.
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
     * @returns {number | Promise<number>}
     */
    const load = name=>{
        const known = host.find(name);
        if (known)
        {
            return known.base;
        }
        const answer = host.load?.(name) ?? 0;
        if (typeof answer === 'number')
        {
            if (answer === 0)
            {
                host.setLastError(ERROR_MOD_NOT_FOUND);
            }
            return answer;
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
            handler: ([name])=>load(host.readCString(name >>> 0, MAX_NAME)),
        },

        /** HMODULE LoadLibraryExA(LPCSTR, HANDLE, DWORD dwFlags) */
        LoadLibraryExA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name])=>{
                // The flags select how a library is mapped -- as data, with or
                // without running its entry point. Ours have no entry point and
                // one mapping, so every flag describes what already happened.
                return load(host.readCString(name >>> 0, MAX_NAME));
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
            handler: ([name])=>load(host.readWideString(name >>> 0, MAX_NAME)),
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
                const system = `C:${SEPARATOR}Windows${SEPARATOR}System32${SEPARATOR}`
                    + module.name;
                const path = handle === 0 ? host.imagePath() : system;
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
                const system = `C:\\Windows\\System32\\${module.name}`;
                const path = handle === 0 ? host.imagePath() : system;
                return writeString(buffer >>> 0, size >>> 0, path);
            },
        },
    };
}
