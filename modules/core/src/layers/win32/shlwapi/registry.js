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
import { formatGuid } from '../ole32/guid.js';

const ERROR_SUCCESS = 0;
const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const ERROR_KEY_HAS_CHILDREN = 1020;
const KEY_ALL_ACCESS = 0xf003f;
/** AssocCreate asked for a class other than the one it makes. */
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111 | 0;
const E_NOTIMPL = 0x80004001 | 0;
/** CLSID_QueryAssociations {a07034fd-6caa-4954-ac3f-97a27216f98a}, as the four words it is passed in. */
const CLSID_QUERY_ASSOCIATIONS = [0xa07034fd, 0x49546caa, 0xa2973fac, 0x8af91672];
/**
 * The file types AssocIsDangerous calls dangerous: programs, scripts and the
 * shortcuts and installers that run them.
 */
const DANGEROUS_EXTENSIONS = new Set(['.ade', '.adp', '.app', '.bas', '.bat', '.chm', '.cmd',
    '.com', '.cpl', '.crt', '.exe', '.hlp', '.hta', '.inf', '.ins', '.isp', '.js', '.jse',
    '.lnk', '.mda', '.mdb', '.mde', '.mdt', '.mdz', '.msc', '.msi', '.msp', '.mst', '.pcd',
    '.pif', '.reg', '.scf', '.scr', '.sct', '.shb', '.shs', '.url', '.vb', '.vbe', '.vbs',
    '.ws', '.wsc', '.wsf', '.wsh']);
/** Where SHRegGetCLSIDKey keeps a class's shell settings, under either root. */
const CLSID_SETTINGS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\CLSID\\';
const ERROR_FILE_NOT_FOUND = 2;
const KEY_READ = 0x20019;
const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;

const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const REG_BINARY = 3;
const REG_DWORD = 4;
const ERROR_MORE_DATA = 234;
const ERROR_OUTOFMEMORY = 14;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
/** HRESULT_FROM_WIN32(ERROR_NO_ASSOCIATION): nothing is associated with the type asked. */
const E_NO_ASSOCIATION = 0x80070483 | 0;
/** How long an expanded value may grow, in characters: as far as a registry string goes. */
const EXPAND_ROOM = 0x8000;

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
 * @property {(address: number, maxLength: number) => string} [readCString]
 * @property {(address: number, maxLength: number) => string} [readWideString]
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

    /**
     * SHQueryValueEx for either spelling: RegQueryValueEx, but a REG_EXPAND_SZ
     * value is answered expanded, as REG_SZ, and counted as the larger of
     * what it is stored as and what it expands to (Wine's test_SHQueryValueEx).
     *
     * @param {'A' | 'W'} width @param {number[]} args
     */
    const queryValue = async(width, [key, value, , typeOut, data, sizeOut])=>{
        const unit = width === 'W' ? 2 : 1;
        const call = async(/** @type {string} */ name, /** @type {number[]} */ args)=>
            /** @type {number} */ (await host.advapi32?.()[name].handler(args)) >>> 0;
        if (!host.allocate || !host.readMemory)
        {
            return ERROR_CALL_NOT_IMPLEMENTED;
        }
        const read = /** @type {(address: number, length: number) => Uint8Array} */ (
            host.readMemory);
        const room = (sizeOut >>> 0) === 0 ? 0 : u32(read(sizeOut >>> 0, 4));
        const scratch = host.allocate(8);
        if (!scratch)
        {
            return ERROR_OUTOFMEMORY;
        }
        try
        {
            host.writeMemory(scratch, dword(0));
            host.writeMemory(scratch + 4, dword(0));
            let status = await call(`RegQueryValueEx${width}`, [key, value, 0, scratch, 0,
                scratch + 4]);
            const type = u32(read(scratch, 4));
            const stored = u32(read(scratch + 4, 4));
            if (status !== ERROR_SUCCESS || type !== REG_EXPAND_SZ)
            {
                return await call(`RegQueryValueEx${width}`, [key, value, 0, typeOut, data,
                    sizeOut]);
            }
            const raw = host.allocate(stored + unit);
            const expanded = host.allocate(EXPAND_ROOM * unit);
            try
            {
                if (!raw || !expanded)
                {
                    return ERROR_OUTOFMEMORY;
                }
                host.writeMemory(raw + stored, new Uint8Array(unit));
                status = await call(`RegQueryValueEx${width}`, [key, value, 0, scratch, raw,
                    scratch + 4]);
                const expand = host.library?.('KERNEL32.dll')?.[`ExpandEnvironmentStrings${width}`];
                const length = status === ERROR_SUCCESS && expand
                    ? /** @type {number} */ (await expand.handler([raw, expanded, EXPAND_ROOM]))
                        >>> 0
                    : 0;
                if (length === 0)
                {
                    return status === ERROR_SUCCESS ? ERROR_CALL_NOT_IMPLEMENTED : status;
                }
                const needed = Math.max(stored, length * unit);
                if ((typeOut >>> 0) !== 0)
                {
                    host.writeMemory(typeOut >>> 0, dword(REG_SZ));
                }
                if ((sizeOut >>> 0) !== 0)
                {
                    host.writeMemory(sizeOut >>> 0, dword(needed));
                }
                if ((data >>> 0) === 0)
                {
                    return ERROR_SUCCESS;
                }
                if (length * unit > room)
                {
                    // Room for what is stored but not for its expansion: what
                    // was read is taken back, an empty string left.
                    if (room >= stored)
                    {
                        host.writeMemory(data >>> 0, new Uint8Array(unit));
                    }
                    return ERROR_MORE_DATA;
                }
                host.writeMemory(data >>> 0, read(expanded, length * unit).slice());
                return ERROR_SUCCESS;
            }
            finally
            {
                [raw, expanded].filter(Boolean).forEach(at=>host.free?.(at));
            }
        }
        finally
        {
            host.free?.(scratch);
        }
    };

    /**
     * SHRegGetUSValue for either spelling: the value under the user's key,
     * then the machine's -- only the machine's when the caller ignores the
     * user's -- its type and as much of its data as the buffer holds, and
     * ERROR_MORE_DATA with the size needed when it holds less. Where neither
     * has it, a default given is copied in, as much as fits, and the call
     * succeeds; otherwise the lookup's ERROR_FILE_NOT_FOUND (Wine's shlwapi
     * SHRegQueryUSValue).
     *
     * @param {'A' | 'W'} width
     */
    const getUSValue = width=>({
        argBytes: 32,
        /** @param {number[]} args */
        handler: ([subKey, value, typeOut, data, sizeOut, ignoreUser, fallback, fallbackSize])=>{
            const read = /** @type {(address: number, length: number) => Uint8Array} */ (
                host.readMemory);
            const room = (sizeOut >>> 0) !== 0 ? u32(read(sizeOut >>> 0, 4)) : 0;
            const roots = (ignoreUser | 0) !== 0
                ? [HKEY_LOCAL_MACHINE] : [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE];
            for (const root of roots)
            {
                const found = readValue(width, root, subKey, value);
                if (!found?.found)
                {
                    continue;
                }
                if ((typeOut >>> 0) !== 0)
                {
                    host.writeMemory(typeOut >>> 0, dword(found.type));
                }
                if ((sizeOut >>> 0) !== 0)
                {
                    host.writeMemory(sizeOut >>> 0, dword(found.data.length));
                }
                if ((data >>> 0) === 0)
                {
                    return ERROR_SUCCESS;
                }
                if (found.data.length > room)
                {
                    return ERROR_MORE_DATA;
                }
                host.writeMemory(data >>> 0, found.data);
                return ERROR_SUCCESS;
            }
            if ((fallback >>> 0) !== 0 && (fallbackSize >>> 0) !== 0 && (sizeOut >>> 0) !== 0
                && (data >>> 0) !== 0)
            {
                host.writeMemory(data >>> 0,
                    read(fallback >>> 0, Math.min(fallbackSize >>> 0, room)).slice());
                return ERROR_SUCCESS;
            }
            return ERROR_FILE_NOT_FOUND;
        },
    });

    /**
     * SHGetValue for either spelling: SHQueryValueEx on the subkey, opened
     * for the call.
     *
     * @param {'A' | 'W'} width
     */
    const getValue = width=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: async([key, subKey, value, typeOut, data, sizeOut])=>{
            if (!host.allocate || !host.readMemory || !host.advapi32)
            {
                return ERROR_CALL_NOT_IMPLEMENTED;
            }
            const out = host.allocate(4);
            if (!out)
            {
                return ERROR_OUTOFMEMORY;
            }
            try
            {
                const open = host.advapi32()[`RegOpenKeyEx${width}`];
                const status = /** @type {number} */ (await open.handler([key, subKey, 0,
                    KEY_READ, out])) >>> 0;
                if (status !== ERROR_SUCCESS)
                {
                    return status;
                }
                const handle = u32(host.readMemory(out, 4));
                try
                {
                    return await queryValue(width, [handle, value, 0, typeOut, data, sizeOut]);
                }
                finally
                {
                    await host.advapi32().RegCloseKey.handler([handle]);
                }
            }
            finally
            {
                host.free?.(out);
            }
        },
    });

    /**
     * An advapi32 call with the caller's own arguments, picked as the
     * shell's call lays its own out.
     *
     * @param {string} name @param {number} argBytes @param {(args: number[]) => number[]} pick
     */
    const passed = (name, argBytes, pick)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>(host.advapi32 ? registry(name, pick(args)) : ERROR_CALL_NOT_IMPLEMENTED),
    });

    /**
     * A key opened or created under a root by a path the engine spells,
     * through the wide call; 0 when it cannot be had.
     *
     * @param {number} root @param {string} path @param {boolean} create
     */
    const keyAt = (root, path, create)=>{
        if (!host.advapi32 || !host.allocate || !host.readMemory)
        {
            return 0;
        }
        const units = [...path, '\0'];
        const name = host.allocate(units.length * 2 + 4);
        const out = name + units.length * 2;
        host.writeMemory(name, Uint8Array.from(units.flatMap(unit=>[unit.charCodeAt(0) & 0xff,
            unit.charCodeAt(0) >>> 8])));
        host.writeMemory(out, dword(0));
        try
        {
            const status = create
                ? registry('RegCreateKeyExW', [root, name, 0, 0, 0, KEY_ALL_ACCESS, 0, out, 0])
                : registry('RegOpenKeyExW', [root, name, 0, KEY_ALL_ACCESS, out]);
            return status === ERROR_SUCCESS ? u32(host.readMemory(out, 4)) : 0;
        }
        finally
        {
            host.free?.(name);
        }
    };

    /**
     * SHDeleteOrphanKey for either spelling: the subkey goes when it has no
     * subkey of its own and no default value - named values do not keep it.
     *
     * @param {'A' | 'W'} width
     */
    const deleteOrphan = width=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([key, subKey])=>{
            if (!host.advapi32 || !host.allocate || !host.readMemory)
            {
                return ERROR_CALL_NOT_IMPLEMENTED;
            }
            const out = host.allocate(8);
            try
            {
                host.writeMemory(out, dword(0));
                const status = registry(`RegOpenKeyEx${width}`, [key, subKey, 0, KEY_READ, out]);
                if (status !== ERROR_SUCCESS)
                {
                    return status;
                }
                const child = u32(host.readMemory(out, 4));
                host.writeMemory(out + 4, dword(0));
                registry('RegQueryInfoKeyW', [child, 0, 0, 0, out + 4, 0, 0, 0, 0, 0, 0, 0]);
                const subKeys = u32(host.readMemory(out + 4, 4));
                const hasDefault = registry(`RegQueryValueEx${width}`, [child, 0, 0, 0, 0, 0])
                    === ERROR_SUCCESS;
                registry('RegCloseKey', [child]);
                return subKeys !== 0 || hasDefault ? ERROR_KEY_HAS_CHILDREN
                    : registry(`RegDeleteKey${width}`, [key, subKey]);
            }
            finally
            {
                host.free?.(out);
            }
        },
    });

    /**
     * SHRegGetCLSIDKey for either spelling: the class's settings key, or one
     * of its subkeys, under the user's root or the machine's, created when
     * the caller asks; the handle is the caller's to close.
     *
     * @param {'A' | 'W'} width
     */
    const clsidKey = width=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([guid, value, user, create, out])=>{
            if ((guid >>> 0) === 0 || (out >>> 0) === 0 || !host.readMemory)
            {
                return E_INVALIDARG;
            }
            const read = width === 'W' ? host.readWideString : host.readCString;
            const sub = (value >>> 0) !== 0 && read ? read(value >>> 0, 0x1000) : '';
            const path = `${CLSID_SETTINGS}${formatGuid(host.readMemory(guid >>> 0, 16).slice())}`
                + (sub ? `\\${sub}` : '');
            const key = keyAt((user | 0) !== 0 ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE, path,
                (create | 0) !== 0);
            host.writeMemory(out >>> 0, dword(key));
            return key === 0 ? E_FAIL : S_OK;
        },
    });

    /**
     * SHRegGetIntW: a string value read as a decimal number, the default
     * for a value that is not there or not a string.
     */
    const getInt = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([key, value, fallback])=>{
            const read = readValue('W', key, 0, value, 0x200);
            if (!read?.found || (read.type !== REG_SZ && read.type !== REG_EXPAND_SZ))
            {
                return fallback | 0;
            }
            let text = '';
            for (let at = 0; at + 1 < read.data.length; at += 2)
            {
                const code = read.data[at] | read.data[at + 1] << 8;
                if (code === 0)
                {
                    break;
                }
                text += String.fromCharCode(code);
            }
            const number = /^\s*([-+]?\d+)/.exec(text);
            return number ? Number.parseInt(number[1], 10) | 0 : fallback | 0;
        },
    };

    /**
     * SHOpenRegStream: SHOpenRegStream2's stream, or where that has none a
     * stream over nothing, which the caller reads as empty and need not
     * check for NULL - the documented difference between the two.
     *
     * @param {'A' | 'W'} width
     */
    const openStreamOrEmpty = width=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: args=>{
            const stream = openStream(width).handler(args);
            if (stream !== 0)
            {
                return stream;
            }
            const create = (host.library?.('ole32.dll') ?? host.library?.('OLE32.dll'))
                ?.CreateStreamOnHGlobal;
            const out = host.allocate?.(4) ?? 0;
            if (!create || !out || !host.readMemory)
            {
                return 0;
            }
            host.writeMemory(out, dword(0));
            const status = /** @type {number} */ (create.handler([0, 1, out])) | 0;
            const empty = status < 0 ? 0 : u32(host.readMemory(out, 4));
            host.free?.(out);
            return empty;
        },
    });

    /** Said once: AssocCreate makes no object. */
    let noQueryAssociations = false;

    /** @param {string} name */
    const noAssociation = name=>({
        argBytes: 24,
        handler: ()=>{
            host.divergence?.(name, 'file associations are not looked up: none is answered');
            return E_NO_ASSOCIATION;
        },
    });

    return {
        /**
         * DWORD SHQueryValueExA(HKEY hkey, LPCSTR pszValue, DWORD *pdwReserved,
         *                       DWORD *pdwType, void *pvData, DWORD *pcbData)
         */
        SHQueryValueExA: {
            argBytes: 24,
            handler: (/** @type {number[]} */ args)=>queryValue('A', args),
        },
        SHQueryValueExW: {
            argBytes: 24,
            handler: (/** @type {number[]} */ args)=>queryValue('W', args),
        },

        /**
         * DWORD SHGetValueA(HKEY hkey, LPCSTR pszSubKey, LPCSTR pszValue, DWORD *pdwType,
         *                   void *pvData, DWORD *pcbData)
         */
        SHGetValueA: getValue('A'),
        SHGetValueW: getValue('W'),

        /**
         * HRESULT AssocQueryStringA(ASSOCF flags, ASSOCSTR str, LPCSTR pszAssoc,
         *   LPCSTR pszExtra, LPSTR pszOut, DWORD *pcchOut)
         *
         * No association is looked up: every query is answered as one for a
         * type nothing is associated with, HRESULT_FROM_WIN32(ERROR_NO_ASSOCIATION),
         * which a caller is written to handle (the .NET Framework setups' interface
         * asks it which program opens a link), and said once.
         */
        AssocQueryStringA: noAssociation('AssocQueryStringA'),

        /**
         * HRESULT AssocQueryKeyA(ASSOCF cfFlags, ASSOCKEY assockey, LPCSTR pszAssoc,
         *     LPCSTR pszExtra, HKEY *phkeyOut)
         * HRESULT AssocQueryStringByKeyA(ASSOCF cfFlags, ASSOCSTR str, HKEY hkAssoc,
         *     LPCSTR pszExtra, LPSTR pszOut, DWORD *pcchOut)
         *
         * As AssocQueryString: nothing is associated.
         */
        AssocQueryKeyA: { ...noAssociation('AssocQueryKeyA'), argBytes: 20 },
        AssocQueryKeyW: { ...noAssociation('AssocQueryKeyW'), argBytes: 20 },
        AssocQueryStringByKeyA: noAssociation('AssocQueryStringByKeyA'),
        AssocQueryStringByKeyW: noAssociation('AssocQueryStringByKeyW'),

        /**
         * HRESULT AssocCreate(CLSID clsid, REFIID riid, void **ppv)
         *
         * The class is passed by value, four words. Nowhere to put an object
         * is E_INVALIDARG and another class CLASS_E_CLASSNOTAVAILABLE, as
         * Windows answers; the IQueryAssociations object itself is not made,
         * so CLSID_QueryAssociations is E_NOTIMPL, the answer Windows gave
         * where it had none, NULL is written, and that is said once.
         */
        AssocCreate: {
            argBytes: 24,
            structs: { 0: 4 },
            /** @param {number[]} args */
            handler: args=>{
                const out = args[5] >>> 0;
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out, dword(0));
                if (CLSID_QUERY_ASSOCIATIONS.some((word, at)=>(args[at] >>> 0) !== word))
                {
                    return CLASS_E_CLASSNOTAVAILABLE;
                }
                if (!noQueryAssociations)
                {
                    noQueryAssociations = true;
                    host.divergence?.('AssocCreate', 'no IQueryAssociations object is made');
                }
                return E_NOTIMPL;
            },
        },

        /**
         * BOOL AssocIsDangerous(LPCWSTR pszAssoc)
         *
         * Whether opening a file of the type may run code: one of the kinds
         * that run as programs or scripts (decisions.md A260: the list is
         * chosen, the per-type EditFlags are not read).
         */
        AssocIsDangerous: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const text = (pointer >>> 0) === 0 ? null
                    : host.readWideString?.(pointer >>> 0, 0x100 * 2) ?? null;
                if (text === null || text === '')
                {
                    return 0;
                }
                const extension = text.startsWith('.') ? text.toLowerCase()
                    : `.${text.toLowerCase()}`;
                return DANGEROUS_EXTENSIONS.has(extension) ? 1 : 0;
            },
        },
        AssocQueryStringW: noAssociation('AssocQueryStringW'),

        /**
         * LSTATUS SHRegGetUSValueA(LPCSTR pszSubKey, LPCSTR pszValue, DWORD *pdwType,
         *     void *pvData, DWORD *pcbData, BOOL fIgnoreHKCU, void *pvDefaultData,
         *     DWORD dwDefaultDataSize)
         */
        SHRegGetUSValueA: getUSValue('A'),
        SHRegGetUSValueW: getUSValue('W'),

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
        SHOpenRegStream2A: { ...openStream('A'), returns: 'pointer' },
        SHOpenRegStream2W: openStream('W'),

        /**
         * IStream *SHOpenRegStreamA(HKEY hkey, LPCSTR pszSubkey, LPCSTR pszValue,
         *                           DWORD grfMode)
         */
        SHOpenRegStreamA: { ...openStreamOrEmpty('A'), returns: 'pointer' },
        SHOpenRegStreamW: openStreamOrEmpty('W'),

        /**
         * DWORD SHSetValueA(HKEY hkey, LPCSTR pszSubKey, LPCSTR pszValue, DWORD dwType,
         *                   LPCVOID pvData, DWORD cbData)
         *
         * The subkey made when it is not there and the value written in it:
         * RegSetKeyValue's work.
         */
        SHSetValueA: passed('RegSetKeyValueA', 24, args=>args),
        SHSetValueW: passed('RegSetKeyValueW', 24, args=>args),

        /** LONG SHEnumKeyExA(HKEY hkey, DWORD dwIndex, LPSTR pszName, LPDWORD pcchName) */
        SHEnumKeyExA: passed('RegEnumKeyExA', 16, ([key, index, name, size])=>
            [key, index, name, size, 0, 0, 0, 0]),
        SHEnumKeyExW: passed('RegEnumKeyExW', 16, ([key, index, name, size])=>
            [key, index, name, size, 0, 0, 0, 0]),

        /**
         * LONG SHEnumValueA(HKEY hkey, DWORD dwIndex, LPSTR pszValueName,
         *     LPDWORD pcchValueName, LPDWORD pdwType, LPVOID pvData, LPDWORD pcbData)
         */
        SHEnumValueA: passed('RegEnumValueA', 28, ([key, index, name, size, type, data, length])=>
            [key, index, name, size, 0, type, data, length]),
        SHEnumValueW: passed('RegEnumValueW', 28, ([key, index, name, size, type, data, length])=>
            [key, index, name, size, 0, type, data, length]),

        /**
         * LONG SHQueryInfoKeyA(HKEY hkey, LPDWORD pcSubKeys, LPDWORD pcchMaxSubKeyLen,
         *     LPDWORD pcValues, LPDWORD pcchMaxValueNameLen)
         */
        SHQueryInfoKeyA: passed('RegQueryInfoKeyA', 20, ([key, subKeys, subKeyLength, values,
            valueLength])=>[key, 0, 0, 0, subKeys, subKeyLength, 0, values, valueLength, 0, 0, 0]),
        SHQueryInfoKeyW: passed('RegQueryInfoKeyW', 20, ([key, subKeys, subKeyLength, values,
            valueLength])=>[key, 0, 0, 0, subKeys, subKeyLength, 0, values, valueLength, 0, 0, 0]),

        /** DWORD SHDeleteOrphanKeyA(HKEY hkey, LPCSTR pszSubKey) */
        SHDeleteOrphanKeyA: deleteOrphan('A'),
        SHDeleteOrphanKeyW: deleteOrphan('W'),

        /**
         * DWORD SHGetValueGoodBootA(HKEY hkey, LPCSTR pszSubKey, LPCSTR pszValue,
         *     DWORD *pdwType, void *pvData, DWORD *pcbData)
         *
         * SHGetValue, refused only in a safe-mode boot, which this machine never is.
         */
        SHGetValueGoodBootA: getValue('A'),
        SHGetValueGoodBootW: getValue('W'),

        /** int SHRegGetIntW(HKEY hk, LPCWSTR pwzKey, int iDefault) */
        SHRegGetIntW: getInt,

        /**
         * HRESULT SHRegGetCLSIDKeyA(REFGUID guid, LPCSTR lpszValue, BOOL bUseHKCU,
         *     BOOL bCreate, PHKEY phKey)
         */
        SHRegGetCLSIDKeyA: clsidKey('A'),
        SHRegGetCLSIDKeyW: clsidKey('W'),
    };
}
