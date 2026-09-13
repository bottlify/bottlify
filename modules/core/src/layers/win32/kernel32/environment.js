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

/** Error codes this file can produce. */
const ERROR_ENVVAR_NOT_FOUND = 203;

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
    const variables = new Map(Object.entries(host.environment()));

    /** @param {string} text */
    const writeAnsi = text=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
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

        const entries = [...variables].map(([name, value])=>`${name}=${value}`);
        const text = `${entries.map(entry=>`${entry}\0`).join('')}\0`;
        const unit = wide ? 2 : 1;
        const bytes = new Uint8Array(text.length * unit);
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            bytes[at * unit] = code & 0xff;
            if (wide)
            {
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
        host.writeMemory(buffer >>> 0, new Uint8Array(
            [...path].map(character=>character.charCodeAt(0) & 0xff).concat(0)));
        return path.length;
    };

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

        /** LPCH GetEnvironmentStrings(VOID) */
        GetEnvironmentStrings: { argBytes: 0, handler: ()=>environmentBlock(false) },

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
                const wanted = host.readCString(name >>> 0, 0x400);
                const value = variables.get(wanted);
                if (value === undefined)
                {
                    host.setLastError(ERROR_ENVVAR_NOT_FOUND);
                    return 0;
                }
                return reportPath(value, buffer, size);
            },
        },

        /** BOOL SetEnvironmentVariableA(LPCSTR lpName, LPCSTR lpValue) */
        SetEnvironmentVariableA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, value])=>{
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
                const text = host.readCString(source >>> 0, 0x8000);
                const expanded = text.replace(/%([^%]*)%/g, (whole, name)=>variables.get(name) ?? whole);
                if ((size >>> 0) >= expanded.length + 1 && (destination >>> 0) !== 0)
                {
                    reportPath(expanded, destination, size);
                }
                return expanded.length + 1;
            },
        },

        /**
         * VOID GetStartupInfoA(LPSTARTUPINFOA lpStartupInfo)
         *
         * Every field but the size is zero, and that is a real answer rather than
         * a placeholder: no parent handed this process a desktop, a title, a
         * window position or a set of standard handles to inherit, and dwFlags
         * of zero is precisely how a program is told not to read the rest.
         */
        GetStartupInfoA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([info])=>{
                const bytes = new Uint8Array(STARTUPINFOA_SIZE);
                new DataView(bytes.buffer).setUint32(0, STARTUPINFOA_SIZE, true);
                host.writeMemory(info >>> 0, bytes);
                return 0;
            },
        },

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
    };
}
