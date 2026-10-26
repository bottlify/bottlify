/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a process was started with: its command line, its environment, the
 * startup record its parent filled in, and the directories it expects Windows
 * to be installed in.
 *
 * The command line is the one thing here that has to be the *same pointer* on
 * every call. A C runtime takes it once, keeps it, and parses it later into
 * argv -- so handing out a fresh copy each time works right up until something
 * compares the pointer or frees the one it kept. Windows returns a pointer into
 * the process parameters, which never moves, and so does this.
 *
 * The environment block is the shape that is easy to get wrong: NAME=VALUE
 * entries, each NUL-terminated, and a second NUL closing the block. A reader
 * walks it until it meets an empty entry, so a block missing its final NUL is
 * read past its end.
 */

import { encodeAnsi } from './locale.js';
import {
    PROCESSOR, PROCESSOR_IDENTIFIER, PROCESSOR_LEVEL, PROCESSOR_REVISION,
} from './processor.js';

/** Error codes this file can produce. */
const ERROR_ENVVAR_NOT_FOUND = 203;
const ERROR_INVALID_PARAMETER = 87;

/** sizeof(STARTUPINFOA). */
const STARTUPINFOA_SIZE = 68;

/** Where Windows lives, as a program of this era expects to find it. */
const WINDOWS_DIRECTORY = 'C:\\WINDOWS';
const SYSTEM_DIRECTORY = 'C:\\WINDOWS\\system32';

/**
 * @typedef {Object} EnvironmentHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate   Guest bytes that stay put.
 * @property {(code: number) => void} setLastError
 * @property {() => string} commandLine
 * @property {() => Record<string, string>} environment
 */

/**
 * The variables a process starts with: where Windows is, the scratch
 * directory GetTempPath answers -- as TEMP and as TMP, which Windows defines
 * beside it and a C runtime's `_tempnam` reads first -- and the profile
 * folders of the machine's
 * layout -- ALLUSERSPROFILE, APPDATA and USERPROFILE everywhere, and from
 * Vista's layout on LOCALAPPDATA, ProgramData and PUBLIC too. The folders are
 * the ones the registry and the shell name, so a program that joins %APPDATA%
 * and one that asks SHGetFolderPath arrive at the same directory. And the
 * processor, as every Windows defines it: how many, the architecture, and the
 * identifier, level and revision the registry and GetSystemInfo give, in the
 * forms Windows writes them -- the identifier with the vendor after it, the
 * revision four hex digits. In the order Windows keeps the block, sorted
 * without regard to case.
 *
 * @param {import('./versions.js').WindowsVersion} windows
 * @param {Readonly<Record<string, string>>} folders  That Windows's shell folders.
 * @param {number} [processors]  How many the machine has; absent, one.
 * @returns {Record<string, string>}
 */
export function defaultEnvironment(windows, folders, processors = 1){
    const { allUsers, public: shared } = windows.profiles;
    return {
        ALLUSERSPROFILE: allUsers,
        APPDATA: folders.AppData,
        ...shared === null ? {} : { LOCALAPPDATA: folders['Local AppData'] },
        NUMBER_OF_PROCESSORS: String(processors),
        PROCESSOR_ARCHITECTURE: 'x86',
        PROCESSOR_IDENTIFIER: `${PROCESSOR_IDENTIFIER}, ${PROCESSOR.vendor}`,
        PROCESSOR_LEVEL: String(PROCESSOR_LEVEL),
        PROCESSOR_REVISION: PROCESSOR_REVISION.toString(16).padStart(4, '0'),
        ...shared === null ? {} : {
            ProgramData: folders['Common AppData'],
            PUBLIC: shared,
        },
        SystemRoot: WINDOWS_DIRECTORY,
        TEMP: `${WINDOWS_DIRECTORY}\\TEMP`,
        TMP: `${WINDOWS_DIRECTORY}\\TEMP`,
        USERPROFILE: folders.Profile,
        windir: WINDOWS_DIRECTORY,
    };
}

/**
 * @param {EnvironmentHost} host
 */
export function createEnvironmentFunctions(host){
    /** Handed out once and kept, because callers keep it. @type {number | null} */
    let commandLineAddress = null;
    /** The same text in the other encoding, kept for the same reason. */
    /** @type {number | null} */
    let commandLineWideAddress = null;
    /** @type {Map<string, number>} */
    const blocks = new Map();
    /**
     * Names compare without regard to case, as Windows compares them, and
     * keep the spelling they were first set with: the block lists `Path` as
     * it was given, and `PATH` finds it.
     *
     * @type {Map<string, { name: string, value: string }>}
     */
    const byFolded = new Map(Object.entries(host.environment())
        .map(([name, value])=>[name.toUpperCase(), { name, value }]));
    const variables = {
        /** @param {string} name */
        get: name=>byFolded.get(name.toUpperCase())?.value,
        /** @param {string} name @param {string} value */
        set: (name, value)=>{
            const folded = name.toUpperCase();
            byFolded.set(folded, { name: byFolded.get(folded)?.name ?? name, value });
        },
        /** @param {string} name */
        delete: name=>byFolded.delete(name.toUpperCase()),
        /** @returns {[string, string][]} */
        entries: ()=>[...byFolded.values()].map(({ name, value })=>[name, value]),
    };

    /**
     * Text in the ANSI page, which is how the memory layer reads what a
     * program sets: a value goes back in the bytes it was read from.
     *
     * @param {string} text
     */
    const writeAnsi = text=>{
        const bytes = encodeAnsi(`${text}\0`);
        const address = host.allocate(bytes.length);
        host.writeMemory(address, bytes);
        return address;
    };

    /** @param {string} text */
    const writeWideString = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            bytes[at * 2] = code & 0xff;
            bytes[at * 2 + 1] = code >> 8;
        }
        const address = host.allocate(bytes.length);
        host.writeMemory(address, bytes);
        return address;
    };

    /**
     * The environment as one block: NAME=VALUE, each terminated, and a second
     * terminator closing the whole. Cached, so the pointer a caller was given
     * stays meaningful for as long as it holds it.
     *
     * @param {boolean} wide
     */
    const environmentBlock = wide=>{
        const key = wide ? 'wide' : 'ansi';
        const held = blocks.get(key);
        if (held !== undefined)
        {
            return held;
        }

        const entries = variables.entries().map(([name, value])=>`${name}=${value}`);
        const text = `${entries.map(entry=>`${entry}\0`).join('')}\0`;
        const bytes = wide ? new Uint8Array(text.length * 2) : encodeAnsi(text);
        if (wide)
        {
            for (let at = 0; at < text.length; at++)
            {
                const code = text.charCodeAt(at);
                bytes[at * 2] = code & 0xff;
                bytes[at * 2 + 1] = code >> 8;
            }
        }
        const address = host.allocate(bytes.length);
        host.writeMemory(address, bytes);
        blocks.set(key, address);
        return address;
    };

    /**
     * The answer both directory queries give.
     *
     * The count means two different things either side of "it fits", and that
     * is the whole protocol: what was written, excluding the terminator, or
     * what is needed, including it.
     *
     * @param {string} path @param {number} buffer @param {number} size
     */
    const reportPath = (path, buffer, size)=>{
        if ((size >>> 0) < path.length + 1)
        {
            return path.length + 1;
        }
        host.writeMemory(buffer >>> 0, encodeAnsi(`${path}\0`));
        return path.length;
    };

    /**
     * `%NAME%` replaced by the variable's value where there is one; the
     * expansion both forms of ExpandEnvironmentStrings answer with.
     *
     * @param {string} text
     */
    const expand = text=>text.replace(/%([^%]*)%/g, (whole, name)=>variables.get(name) ?? whole);

    /**
     * The wide twin of reportPath. Counted in characters in both forms, so only
     * the writing differs.
     *
     * @param {string} path @param {number} buffer @param {number} size
     */
    const reportWidePath = (path, buffer, size)=>{
        if ((size >>> 0) < path.length + 1)
        {
            return path.length + 1;
        }
        const bytes = new Uint8Array((path.length + 1) * 2);
        for (let at = 0; at < path.length; at++)
        {
            const code = path.charCodeAt(at);
            bytes[at * 2] = code & 0xff;
            bytes[at * 2 + 1] = code >> 8;
        }
        host.writeMemory(buffer >>> 0, bytes);
        return path.length;
    };

    /**
     * VOID GetStartupInfoA(LPSTARTUPINFOA lpStartupInfo)
     *
     * Every field but the size is zero, and that is a real answer rather than
     * a placeholder: no parent handed this process a desktop, a title, a
     * window position or a set of standard handles to inherit, and dwFlags of
     * zero is precisely how a program is told not to read the rest.
     */
    const startupInfo = {
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([info])=>{
            const bytes = new Uint8Array(STARTUPINFOA_SIZE);
            new DataView(bytes.buffer).setUint32(0, STARTUPINFOA_SIZE, true);
            host.writeMemory(info >>> 0, bytes);
            return 0;
        },
    };

    return {
        /** LPSTR GetCommandLineA(VOID) */
        GetCommandLineA: {
            argBytes: 0,
            handler: ()=>{
                commandLineAddress ??= writeAnsi(host.commandLine());
                return commandLineAddress;
            },
        },

        /**
         * LPWSTR GetCommandLineW(VOID)
         *
         * The same text as the ANSI form, in the other encoding, and cached
         * separately -- a caller keeps whichever pointer it was given, so the
         * two must each stay put once handed out.
         */
        GetCommandLineW: {
            argBytes: 0,
            handler: ()=>{
                commandLineWideAddress ??= writeWideString(host.commandLine());
                return commandLineWideAddress;
            },
        },

        /**
         * LPCH GetEnvironmentStrings(VOID), exported under both of its
         * names, as kernel32 exports it.
         */
        GetEnvironmentStrings: { argBytes: 0, handler: ()=>environmentBlock(false) },
        GetEnvironmentStringsA: { argBytes: 0, handler: ()=>environmentBlock(false) },

        /** LPWCH GetEnvironmentStringsW(VOID) */
        GetEnvironmentStringsW: { argBytes: 0, handler: ()=>environmentBlock(true) },

        /**
         * BOOL FreeEnvironmentStringsA(LPCH penv)
         *
         * The block is cached rather than copied per call, so there is nothing
         * to release -- but the pointer is still checked, because answering TRUE
         * to a pointer we never handed out would hide a caller's mistake.
         */
        FreeEnvironmentStringsA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>blocks.get('ansi') === (block >>> 0) ? 1 : 0,
        },

        /** BOOL FreeEnvironmentStringsW(LPWCH penv) */
        FreeEnvironmentStringsW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>blocks.get('wide') === (block >>> 0) ? 1 : 0,
        },

        /**
         * DWORD GetEnvironmentVariableA(LPCSTR lpName, LPSTR lpBuffer, DWORD nSize)
         */
        GetEnvironmentVariableA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, buffer, size])=>{
                // A NULL name names no variable.
                const value = (name >>> 0) === 0 ? undefined
                    : variables.get(host.readCString(name >>> 0, 0x400));
                if (value === undefined)
                {
                    host.setLastError(ERROR_ENVVAR_NOT_FOUND);
                    return 0;
                }
                return reportPath(value, buffer, size);
            },
        },

        /** DWORD GetEnvironmentVariableW(LPCWSTR lpName, LPWSTR lpBuffer, DWORD nSize) */
        GetEnvironmentVariableW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, buffer, size])=>{
                const value = (name >>> 0) === 0 ? undefined
                    : variables.get(host.readWideString(name >>> 0, 0x400));
                if (value === undefined)
                {
                    host.setLastError(ERROR_ENVVAR_NOT_FOUND);
                    return 0;
                }
                return reportWidePath(value, buffer, size);
            },
        },

        /** BOOL SetEnvironmentVariableA(LPCSTR lpName, LPCSTR lpValue) */
        SetEnvironmentVariableA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, value])=>{
                if ((name >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const wanted = host.readCString(name >>> 0, 0x400);
                if ((value >>> 0) === 0)
                {
                    variables.delete(wanted);
                }
                else
                {
                    variables.set(wanted, host.readCString(value >>> 0, 0x2000));
                }
                // The cached blocks describe an environment that no longer
                // exists. Dropping them means the next reader builds a fresh
                // one; the pointers already handed out keep their old contents,
                // which is exactly what Windows does with a block a caller holds.
                blocks.clear();
                return 1;
            },
        },

        /**
         * DWORD ExpandEnvironmentStringsA(LPCSTR lpSrc, LPSTR lpDst, DWORD nSize)
         *
         * A `%NAME%` whose variable does not exist is left as it was, percent
         * signs included; an unpaired `%` is ordinary text. The count is the
         * whole answer including its terminator whether or not it fitted, and
         * a buffer too small gets nothing: a caller sizes from a first call
         * with no buffer and asks again.
         */
        ExpandEnvironmentStringsA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, destination, size])=>{
                const expanded = (source >>> 0) === 0 ? ''
                    : expand(host.readCString(source >>> 0, 0x8000));
                if ((size >>> 0) >= expanded.length + 1 && (destination >>> 0) !== 0)
                {
                    reportPath(expanded, destination, size);
                }
                return expanded.length + 1;
            },
        },

        /**
         * DWORD ExpandEnvironmentStringsW(LPCWSTR lpSrc, LPWSTR lpDst, DWORD nSize)
         *
         * The A form's expansion, from the same variables, in UTF-16; nSize and
         * the count are in characters.
         */
        ExpandEnvironmentStringsW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, destination, size])=>{
                const expanded = (source >>> 0) === 0 ? ''
                    : expand(host.readWideString(source >>> 0, 0x8000));
                if ((size >>> 0) >= expanded.length + 1 && (destination >>> 0) !== 0)
                {
                    reportWidePath(expanded, destination, size);
                }
                return expanded.length + 1;
            },
        },

        /** VOID GetStartupInfoA(LPSTARTUPINFOA lpStartupInfo) */
        GetStartupInfoA: startupInfo,

        /**
         * VOID GetStartupInfoW(LPSTARTUPINFOW lpStartupInfo): the same answer,
         * STARTUPINFOW being STARTUPINFOA's size with its three strings wide,
         * and none of them given.
         */
        GetStartupInfoW: startupInfo,

        /**
         * BOOL SetEnvironmentVariableW(LPCWSTR lpName, LPCWSTR lpValue)
         *
         * The same store as the ANSI form. Two stores would let a program set a
         * variable one way and fail to read it back the other.
         */
        SetEnvironmentVariableW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, value])=>{
                if ((name >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const wanted = host.readWideString(name >>> 0, 0x400);
                if ((value >>> 0) === 0)
                {
                    variables.delete(wanted);
                }
                else
                {
                    variables.set(wanted, host.readWideString(value >>> 0, 0x2000));
                }
                blocks.clear();
                return 1;
            },
        },

        /** UINT GetSystemDirectoryW(LPWSTR lpBuffer, UINT uSize) */
        GetSystemDirectoryW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>reportWidePath(SYSTEM_DIRECTORY, buffer, size),
        },

        /** UINT GetSystemDirectoryA(LPSTR lpBuffer, UINT uSize) */
        GetSystemDirectoryA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>reportPath(SYSTEM_DIRECTORY, buffer, size),
        },

        /** UINT GetWindowsDirectoryA(LPSTR lpBuffer, UINT uSize) */
        GetWindowsDirectoryA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>reportPath(WINDOWS_DIRECTORY, buffer, size),
        },

        /** UINT GetWindowsDirectoryW(LPWSTR lpBuffer, UINT uSize) */
        GetWindowsDirectoryW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>reportWidePath(WINDOWS_DIRECTORY, buffer, size),
        },

        /**
         * UINT GetSystemWindowsDirectoryA/W(LPSTR/LPWSTR lpBuffer, UINT uSize)
         *
         * The shared Windows directory, which differs from the one above only
         * for a user of a terminal server, which this is not.
         */
        GetSystemWindowsDirectoryA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>reportPath(WINDOWS_DIRECTORY, buffer, size),
        },
        GetSystemWindowsDirectoryW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>reportWidePath(WINDOWS_DIRECTORY, buffer, size),
        },
    };
}

/**
 * userenv's environment blocks: the variables a process started for the user
 * gets, which on this machine of one user are the process's own.
 * ponytail: bInherit FALSE still answers the process's own variables; read
 * the user's from the registry if a program tells the two apart.
 *
 * @param {{ block: () => number, free: (block: number) => number,
 *     writeMemory: (address: number, bytes: Uint8Array) => void,
 *     setLastError: (code: number) => void }} host
 *     `block` is GetEnvironmentStringsW, `free` FreeEnvironmentStringsW.
 */
export function createUserenvFunctions(host){
    return {
        /**
         * BOOL CreateEnvironmentBlock(LPVOID *lpEnvironment, HANDLE hToken, BOOL bInherit)
         *
         * A Unicode block, each variable NAME=value and terminated, the whole
         * ending in an empty one, for DestroyEnvironmentBlock to free.
         */
        CreateEnvironmentBlock: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    host.setLastError(87);
                    return 0;
                }
                const block = host.block() >>> 0;
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, block, true);
                host.writeMemory(out >>> 0, bytes);
                return block === 0 ? 0 : 1;
            },
        },

        /** BOOL DestroyEnvironmentBlock(LPVOID lpEnvironment) */
        DestroyEnvironmentBlock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>host.free(block),
        },
    };
}
