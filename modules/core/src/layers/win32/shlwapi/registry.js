/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shell's registry helpers that read a value as something else: a
 * Boolean setting, and a stream over a value's bytes.
 *
 * Both go through advapi32's own calls with the caller's own strings, so an
 * HKEY the program holds names the key it does there, and either spelling
 * reads its names itself.
 */

import { dword, u32 } from './text.js';

const ERROR_SUCCESS = 0;
const KEY_READ = 0x20019;
const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;

const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const REG_BINARY = 3;
const REG_DWORD = 4;

/** The modes a stream may be opened in that write; reading is STGM_READ, 0. */
const STGM_WRITE = 0x1;
const STGM_READWRITE = 0x2;

/** The most of a value read for a Boolean; a longer one says neither yes nor no. */
const BOOL_VALUE_LIMIT = 0x100;

/**
 * @typedef {Object} RegistryHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {() => Record<string, { handler: (args: number[]) => any }>} [advapi32]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     [library]  ole32, whose stream over a block of memory is the stream handed out.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * What a value says as a Boolean: a string reads YES or TRUE, NO or FALSE,
 * without regard to case; a DWORD or a one-byte binary value is TRUE when it
 * is not zero. Anything else says nothing, and null is the caller's default.
 *
 * @param {number} type @param {Uint8Array} data @param {boolean} wide
 * @returns {boolean | null}
 */
export const booleanOf = (type, data, wide)=>{
    if (type === REG_SZ || type === REG_EXPAND_SZ)
    {
        let text = '';
        for (let at = 0; at + (wide ? 1 : 0) < data.length; at += wide ? 2 : 1)
        {
            const code = wide ? data[at] | data[at + 1] << 8 : data[at];
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        const word = text.toUpperCase();
        return word === 'YES' || word === 'TRUE' ? true
            : word === 'NO' || word === 'FALSE' ? false : null;
    }
    if (type === REG_DWORD && data.length >= 4)
    {
        return u32(data) !== 0;
    }
    if (type === REG_BINARY && data.length === 1)
    {
        return data[0] !== 0;
    }
    return null;
};

/**
 * @param {RegistryHost} host
 */
export function createRegistryHelpers(host){
    /** @param {string} name @param {number[]} args @returns {number} */
    const registry = (name, args)=>
        /** @type {number} */ (host.advapi32?.()[name].handler(args)) >>> 0;

    /**
     * A value's type and bytes, read through advapi32 with the caller's own
     * key, subkey and value name; null when the key or the value is not
     * there, or there is no registry or guest memory to read it with.
     *
     * @param {'A' | 'W'} width @param {number} key @param {number} subKey
     * @param {number} value @param {number} [limit]  The most bytes read.
     * @returns {{ found: boolean, type: number, data: Uint8Array } | null}
     *     null when the key is not there; found false when only the value is not
     */
    const readValue = (width, key, subKey, value, limit = 0x100000)=>{
        if (!host.advapi32 || !host.allocate || !host.readMemory)
        {
            return null;
        }
        const scratch = host.allocate(12);
        if (!scratch)
        {
            return null;
        }
        const read = /** @type {(address: number, length: number) => Uint8Array} */ (
            host.readMemory);
        try
        {
            if (registry(`RegOpenKeyEx${width}`, [key, subKey, 0, KEY_READ, scratch])
                !== ERROR_SUCCESS)
            {
                return null;
            }
            const handle = u32(read(scratch, 4));
            try
            {
                host.writeMemory(scratch + 8, dword(0));
                if (registry(`RegQueryValueEx${width}`, [handle, value, 0, scratch + 4, 0,
                    scratch + 8]) !== ERROR_SUCCESS)
                {
                    return { found: false, type: 0, data: new Uint8Array(0) };
                }
                const size = Math.min(u32(read(scratch + 8, 4)), limit);
                const block = size > 0 ? host.allocate(size) : 0;
                if (size > 0 && !block)
                {
                    return null;
                }
                try
                {
                    host.writeMemory(scratch + 8, dword(size));
                    const status = size > 0 ? registry(`RegQueryValueEx${width}`,
                        [handle, value, 0, scratch + 4, block, scratch + 8]) : ERROR_SUCCESS;
                    if (status !== ERROR_SUCCESS)
                    {
                        return { found: false, type: 0, data: new Uint8Array(0) };
                    }
                    return {
                        found: true,
                        type: u32(read(scratch + 4, 4)),
                        data: size > 0 ? read(block, u32(read(scratch + 8, 4))).slice()
                            : new Uint8Array(0),
                    };
                }
                finally
                {
                    if (block)
                    {
                        host.free?.(block);
                    }
                }
            }
            finally
            {
                registry('RegCloseKey', [handle]);
            }
        }
        finally
        {
            host.free?.(scratch);
        }
    };

    /**
     * SHRegGetBoolUSValue for either spelling: the user's value, then the
     * machine's -- only the machine's when the caller ignores the user's --
     * and the default when neither says yes or no.
     *
     * @param {'A' | 'W'} width
     */
    const getBool = width=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([subKey, value, ignoreUser, fallback])=>{
            const roots = (ignoreUser | 0) !== 0
                ? [HKEY_LOCAL_MACHINE] : [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE];
            for (const root of roots)
            {
                const read = readValue(width, root, subKey, value, BOOL_VALUE_LIMIT);
                if (read?.found)
                {
                    const answer = booleanOf(read.type, read.data, width === 'W');
                    return answer === null ? (fallback | 0) !== 0 ? 1 : 0 : answer ? 1 : 0;
                }
            }
            return (fallback | 0) !== 0 ? 1 : 0;
        },
    });

    /** Said once: a stream that would write the value back is not made. */
    let refusedWrite = false;

    /**
     * SHOpenRegStream2 for either spelling: a stream over the value's bytes,
     * read when it is opened, in a block of memory ole32's own stream over
     * memory stands on. A value that is not there is an empty stream; a key
     * that is not there is NULL. A stream opened to write would carry what
     * was written back into the value when it is released, which ole32's
     * stream has no hook for, so a writing mode is refused with NULL, the
     * call's documented failure, rather than handed a stream whose writes
     * would be lost.
     *
     * @param {'A' | 'W'} width
     */
    const openStream = width=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([key, subKey, value, mode])=>{
            const name = `SHOpenRegStream2${width}`;
            if (((mode >>> 0) & (STGM_WRITE | STGM_READWRITE)) !== 0)
            {
                if (!refusedWrite)
                {
                    refusedWrite = true;
                    host.divergence?.(name, 'a stream that writes a registry value back is '
                        + 'not made: NULL');
                }
                return 0;
            }
            const create = (host.library?.('ole32.dll') ?? host.library?.('OLE32.dll'))
                ?.CreateStreamOnHGlobal;
            const read = create ? readValue(width, key, subKey, value) : null;
            if (!create || !read || !host.allocate || !host.readMemory)
            {
                if (!create)
                {
                    host.divergence?.(name, 'no stream over memory to read a value through');
                }
                return 0;
            }
            const block = read.data.length > 0 ? host.allocate(read.data.length) : 0;
            const out = host.allocate(4);
            if (!out || (read.data.length > 0 && !block))
            {
                [block, out].filter(Boolean).forEach(address=>host.free?.(address));
                return 0;
            }
            if (block)
            {
                host.writeMemory(block, read.data);
            }
            host.writeMemory(out, dword(0));
            const status = /** @type {number} */ (create.handler([block, 1, out])) | 0;
            const stream = status < 0 ? 0 : u32(host.readMemory(out, 4));
            host.free?.(out);
            if (stream === 0 && block)
            {
                host.free?.(block);
            }
            return stream;
        },
    });

    return {
        /**
         * BOOL SHRegGetBoolUSValueA(LPCSTR pszSubKey, LPCSTR pszValue,
         *                           BOOL fIgnoreHKCU, BOOL fDefault)
         */
        SHRegGetBoolUSValueA: getBool('A'),
        SHRegGetBoolUSValueW: getBool('W'),

        /**
         * IStream *SHOpenRegStream2A(HKEY hkey, LPCSTR pszSubkey, LPCSTR pszValue,
         *                            DWORD grfMode)
         */
        SHOpenRegStream2A: openStream('A'),
        SHOpenRegStream2W: openStream('W'),
    };
}
