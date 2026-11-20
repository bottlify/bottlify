/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shell's user-and-machine keys (HUSKEY): one handle over the same path
 * under HKEY_CURRENT_USER and HKEY_LOCAL_MACHINE, read from the user's first
 * and the machine's after, written where the caller's flags say. Every call
 * goes through advapi32 with keys of its own, so what a program reads back
 * through RegOpenKeyEx is what these wrote.
 *
 * A HUSKEY is the address of a block of guest memory, so it is a pointer the
 * program can hold and compare like Windows' own; what it stands for is kept
 * here, by that address.
 */

import { dword, u32 } from './text.js';
import { wholeAddress } from '../common/pointers.js';

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_OUTOFMEMORY = 14;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_KEY_HAS_CHILDREN = 1020;
const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const KEY_ALL_ACCESS = 0xf003f;

/** SHREGSET_*: where SHRegWriteUSValue and SHRegCreateUSKey write. */
const SHREGSET_HKCU = 0x1;
const SHREGSET_FORCE_HKCU = 0x2;
const SHREGSET_HKLM = 0x4;
const SHREGSET_FORCE_HKLM = 0x8;
/** SHREGDEL_* and SHREGENUM_*, which share their values: the user's, the machine's, both. */
const ONLY_USER = 0x1;
const ONLY_MACHINE = 0x10;

/**
 * @typedef {Object} UsKeyHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {() => Record<string, { handler: (args: number[]) => any }>} [advapi32]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 */

/**
 * @typedef {Object} UsKey
 * @property {number} user     the open key under HKEY_CURRENT_USER, 0 for none
 * @property {number} machine  the open key under HKEY_LOCAL_MACHINE, 0 for none
 * @property {string} path     relative to each root, UTF-16 as the keys were opened by
 * @property {number} access
 */

/**
 * @param {UsKeyHost} host
 */
export function createUsKeyFunctions(host){
    /** @type {Map<number, UsKey>} */
    const keys = new Map();

    /** @param {string} name @param {number[]} args @returns {number} */
    const registry = (name, args)=>
        /** @type {number} */ (host.advapi32?.()[name].handler(args)) >>> 0;

    /** @param {'A' | 'W'} width @param {number} address */
    const readName = (width, address)=>((address >>> 0) === 0 ? ''
        : width === 'W' ? host.readWideString?.(address >>> 0, 0x10000) ?? ''
            : host.readCString(wholeAddress(address), 0x10000));

    /**
     * A wide string in a block of its own, for the calls made with the
     * engine's own spelling of a path; freed by `release`.
     *
     * @param {string} text
     */
    const wideBlock = text=>{
        const at = /** @type {(bytes: number) => number} */ (host.allocate)((text.length + 1) * 2);
        const bytes = new Uint8Array((text.length + 1) * 2);
        [...text].forEach((unit, index)=>{
            bytes[index * 2] = unit.charCodeAt(0) & 0xff;
            bytes[index * 2 + 1] = unit.charCodeAt(0) >>> 8;
        });
        host.writeMemory(at, bytes);
        return at;
    };

    /**
     * A key under a root or a parent key, opened or created; 0 when it is
     * not there or cannot be made.
     *
     * @param {number} parent @param {string} path @param {number} access @param {boolean} create
     */
    const openKey = (parent, path, access, create)=>{
        if (parent === 0)
        {
            return 0;
        }
        const name = wideBlock(path);
        const out = /** @type {(bytes: number) => number} */ (host.allocate)(4);
        try
        {
            host.writeMemory(out, dword(0));
            const status = create
                ? registry('RegCreateKeyExW', [parent, name, 0, 0, 0, access, 0, out, 0])
                : registry('RegOpenKeyExW', [parent, name, 0, access, out]);
            return status === ERROR_SUCCESS
                ? u32(/** @type {(a: number, l: number) => Uint8Array} */ (host.readMemory)(out, 4))
                : 0;
        }
        finally
        {
            host.free?.(name);
            host.free?.(out);
        }
    };

    const usable = ()=>Boolean(host.advapi32 && host.allocate && host.readMemory);

    /**
     * SHRegOpenUSKey and SHRegCreateUSKey: the path under each root, or
     * under a US key it is relative to; the user's left out when the caller
     * ignores it.
     *
     * @param {'A' | 'W'} width @param {number[]} args @param {boolean} create
     */
    const openUs = (width, [path, access, relative, out, flags], create)=>{
        if ((out >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if (!usable())
        {
            return ERROR_CALL_NOT_IMPLEMENTED;
        }
        const parent = (relative >>> 0) !== 0 ? keys.get(relative >>> 0) : null;
        if ((relative >>> 0) !== 0 && !parent)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const sub = readName(width, path);
        const wantUser = create ? (flags & (SHREGSET_HKCU | SHREGSET_FORCE_HKCU)) !== 0
            : (flags | 0) === 0;
        const wantMachine = create ? (flags & (SHREGSET_HKLM | SHREGSET_FORCE_HKLM)) !== 0 : true;
        const user = wantUser ? openKey(parent ? parent.user : HKEY_CURRENT_USER, sub,
            access >>> 0, create) : 0;
        const machine = wantMachine ? openKey(parent ? parent.machine : HKEY_LOCAL_MACHINE, sub,
            access >>> 0, create) : 0;
        if (user === 0 && machine === 0)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        const handle = /** @type {(bytes: number) => number} */ (host.allocate)(16);
        if (!handle)
        {
            [user, machine].filter(Boolean).forEach(key=>registry('RegCloseKey', [key]));
            return ERROR_OUTOFMEMORY;
        }
        keys.set(handle, { user, machine,
            path: parent ? `${parent.path}\\${sub}` : sub, access: access >>> 0 });
        host.writeMemory(wholeAddress(out), dword(handle));
        return ERROR_SUCCESS;
    };

    /**
     * The root key a US key has for one side, opened with write access
     * when the write needs it and the key was opened without that side.
     *
     * @param {UsKey} key @param {'user' | 'machine'} side
     */
    const sideFor = (key, side)=>{
        if (key[side] === 0)
        {
            key[side] = openKey(side === 'user' ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE,
                key.path, KEY_ALL_ACCESS, true);
        }
        return key[side];
    };

    /**
     * The keys a read, a deletion or an enumeration looks at, by the
     * SHREGDEL/SHREGENUM flags: the user's, the machine's, or the default -
     * the user's when the key has one, else the machine's.
     *
     * @param {UsKey} key @param {number} flags
     */
    const sidesOf = (key, flags)=>{
        if ((flags & ONLY_USER) !== 0 && (flags & ONLY_MACHINE) === 0)
        {
            return [key.user];
        }
        if ((flags & ONLY_MACHINE) !== 0 && (flags & ONLY_USER) === 0)
        {
            return [key.machine];
        }
        if ((flags & ONLY_USER) !== 0)
        {
            return [key.user, key.machine];
        }
        return [key.user !== 0 ? key.user : key.machine];
    };

    /**
     * @param {string} name @param {number} argBytes
     * @param {(width: 'A' | 'W', args: number[]) => number} body
     */
    const both = (name, argBytes, body)=>({
        [`${name}A`]: { argBytes, handler: (/** @type {number[]} */ args)=>body('A', args) },
        [`${name}W`]: { argBytes, handler: (/** @type {number[]} */ args)=>body('W', args) },
    });

    /**
     * SHRegWriteUSValue's body: the value under the user's key, the
     * machine's or both, as the flags say; a plain SHREGSET flag writes only
     * where the value is not there yet, a FORCE one over it.
     *
     * @param {'A' | 'W'} width @param {UsKey} key @param {number[]} args
     */
    const writeValue = (width, key, [, value, type, data, size, flags])=>{
        let status = ERROR_SUCCESS;
        for (const [side, plain, force] of /** @type {const} */ ([
            ['user', SHREGSET_HKCU, SHREGSET_FORCE_HKCU],
            ['machine', SHREGSET_HKLM, SHREGSET_FORCE_HKLM]]))
        {
            if ((flags & (plain | force)) === 0)
            {
                continue;
            }
            const handle = sideFor(key, side);
            if (handle === 0)
            {
                status = ERROR_FILE_NOT_FOUND;
                continue;
            }
            if ((flags & force) === 0 && registry(`RegQueryValueEx${width}`,
                [handle, value, 0, 0, 0, 0]) === ERROR_SUCCESS)
            {
                continue;
            }
            const written = registry(`RegSetValueEx${width}`, [handle, value, 0, type, data, size]);
            if (written !== ERROR_SUCCESS)
            {
                status = written;
            }
        }
        return status;
    };

    return {
        /**
         * LONG SHRegOpenUSKeyA(LPCSTR pszPath, REGSAM samDesired, HUSKEY hRelativeUSKey,
         *     PHUSKEY phNewUSKey, BOOL fIgnoreHKCU)
         */
        ...both('SHRegOpenUSKey', 20, (width, args)=>openUs(width, args, false)),

        /**
         * LONG SHRegCreateUSKeyA(LPCSTR pszPath, REGSAM samDesired, HUSKEY hRelativeUSKey,
         *     PHUSKEY phNewUSKey, DWORD dwFlags)
         *
         * Made under the roots the SHREGSET flags name.
         */
        ...both('SHRegCreateUSKey', 20, (width, args)=>openUs(width, args, true)),

        /** LONG SHRegCloseUSKey(HUSKEY hUSKey) */
        SHRegCloseUSKey: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const key = keys.get(handle >>> 0);
                if (!key)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                keys.delete(handle >>> 0);
                let status = ERROR_SUCCESS;
                for (const open of [key.user, key.machine].filter(Boolean))
                {
                    const closed = registry('RegCloseKey', [open]);
                    status = closed !== ERROR_SUCCESS ? closed : status;
                }
                host.free?.(handle >>> 0);
                return status;
            },
        },

        /**
         * LONG SHRegQueryUSValueA(HUSKEY hUSKey, LPCSTR pszValue, DWORD *pdwType,
         *     void *pvData, DWORD *pcbData, BOOL fIgnoreHKCU, void *pvDefaultData,
         *     DWORD dwDefaultDataSize)
         *
         * The user's value, then the machine's; with neither, the default
         * data in its place, as SHRegGetUSValue answers.
         */
        ...both('SHRegQueryUSValue', 32, (width, args)=>{
            const [handle, value, typeOut, data, sizeOut, ignoreUser, fallback, fallbackSize]
                = args;
            const key = keys.get(handle >>> 0);
            if (!key)
            {
                return ERROR_INVALID_PARAMETER;
            }
            const read = /** @type {(a: number, l: number) => Uint8Array} */ (host.readMemory);
            const room = (sizeOut >>> 0) !== 0 ? u32(read(wholeAddress(sizeOut), 4)) : 0;
            let status = ERROR_FILE_NOT_FOUND;
            for (const open of [(ignoreUser | 0) !== 0 ? 0 : key.user, key.machine])
            {
                if (open === 0)
                {
                    continue;
                }
                if ((sizeOut >>> 0) !== 0)
                {
                    host.writeMemory(wholeAddress(sizeOut), dword(room));
                }
                status = registry(`RegQueryValueEx${width}`, [open, value, 0, typeOut, data,
                    sizeOut]);
                if (status === ERROR_SUCCESS)
                {
                    return status;
                }
            }
            if ((fallback >>> 0) !== 0 && (fallbackSize >>> 0) !== 0 && (data >>> 0) !== 0
                && (sizeOut >>> 0) !== 0)
            {
                const length = Math.min(fallbackSize >>> 0, room);
                host.writeMemory(wholeAddress(data), read(wholeAddress(fallback), length).slice());
                host.writeMemory(wholeAddress(sizeOut), dword(length));
                return ERROR_SUCCESS;
            }
            return status;
        }),

        /**
         * LONG SHRegWriteUSValueA(HUSKEY hUSKey, LPCSTR pszValue, DWORD dwType,
         *     const void *pvData, DWORD cbData, DWORD dwFlags)
         */
        ...both('SHRegWriteUSValue', 24, (width, args)=>{
            const key = keys.get(args[0] >>> 0);
            return key ? writeValue(width, key, args) : ERROR_INVALID_PARAMETER;
        }),

        /**
         * LONG SHRegSetUSValueA(LPCSTR pszSubKey, LPCSTR pszValue, DWORD dwType,
         *     const void *pvData, DWORD cbData, DWORD dwFlags)
         *
         * SHRegCreateUSKey, SHRegWriteUSValue and SHRegCloseUSKey in one.
         */
        ...both('SHRegSetUSValue', 24, (width, [subKey, value, type, data, size, flags])=>{
            if (!usable())
            {
                return ERROR_CALL_NOT_IMPLEMENTED;
            }
            const out = /** @type {(bytes: number) => number} */ (host.allocate)(4);
            try
            {
                const opened = openUs(width, [subKey, KEY_ALL_ACCESS, 0, out, flags], true);
                if (opened !== ERROR_SUCCESS)
                {
                    return opened;
                }
                const handle = u32(/** @type {(a: number, l: number) => Uint8Array} */ (
                    host.readMemory)(out, 4));
                const key = /** @type {UsKey} */ (keys.get(handle));
                const status = writeValue(width, key, [handle, value, type, data, size, flags]);
                for (const open of [key.user, key.machine].filter(Boolean))
                {
                    registry('RegCloseKey', [open]);
                }
                keys.delete(handle);
                host.free?.(handle);
                return status;
            }
            finally
            {
                host.free?.(out);
            }
        }),

        /**
         * LONG SHRegDeleteUSValueA(HUSKEY hUSKey, LPCSTR pszValue, SHREGDEL_FLAGS delRegFlags)
         */
        ...both('SHRegDeleteUSValue', 12, (width, [handle, value, flags])=>{
            const key = keys.get(handle >>> 0);
            if (!key)
            {
                return ERROR_INVALID_PARAMETER;
            }
            let status = ERROR_FILE_NOT_FOUND;
            for (const open of sidesOf(key, flags).filter(Boolean))
            {
                const deleted = registry(`RegDeleteValue${width}`, [open, value]);
                status = status === ERROR_SUCCESS ? status : deleted;
            }
            return status;
        }),

        /**
         * LONG SHRegDeleteEmptyUSKeyA(HUSKEY hUSKey, LPCSTR pszSubKey,
         *     SHREGDEL_FLAGS delRegFlags)
         *
         * SHDeleteEmptyKey under the sides the flags name.
         */
        ...both('SHRegDeleteEmptyUSKey', 12, (width, [handle, subKey, flags])=>{
            const key = keys.get(handle >>> 0);
            if (!key)
            {
                return ERROR_INVALID_PARAMETER;
            }
            let status = ERROR_FILE_NOT_FOUND;
            for (const open of sidesOf(key, flags).filter(Boolean))
            {
                const child = openKey(open, readName(width, subKey), KEY_ALL_ACCESS, false);
                if (child === 0)
                {
                    continue;
                }
                const info = /** @type {(bytes: number) => number} */ (host.allocate)(8);
                registry('RegQueryInfoKeyW', [child, 0, 0, 0, info, 0, 0, info + 4, 0, 0, 0, 0]);
                const counts = /** @type {(a: number, l: number) => Uint8Array} */ (
                    host.readMemory)(info, 8);
                host.free?.(info);
                registry('RegCloseKey', [child]);
                status = u32(counts) !== 0 || u32(counts, 4) !== 0 ? ERROR_KEY_HAS_CHILDREN
                    : registry(`RegDeleteKey${width}`, [open, subKey]);
            }
            return status;
        }),

        /**
         * LONG SHRegEnumUSKeyA(HUSKEY hUSKey, DWORD dwIndex, LPSTR pszName,
         *     LPDWORD pcchName, SHREGENUM_FLAGS enumRegFlags)
         */
        ...both('SHRegEnumUSKey', 20, (width, [handle, index, name, size, flags])=>{
            const key = keys.get(handle >>> 0);
            const [open] = key ? sidesOf(key, flags) : [0];
            return open ? registry(`RegEnumKeyEx${width}`, [open, index, name, size, 0, 0, 0, 0])
                : ERROR_INVALID_PARAMETER;
        }),

        /**
         * LONG SHRegEnumUSValueA(HUSKEY hUSKey, DWORD dwIndex, LPSTR pszValueName,
         *     LPDWORD pcchValueNameLen, LPDWORD pdwType, void *pvData, LPDWORD pcbData,
         *     SHREGENUM_FLAGS enumRegFlags)
         */
        ...both('SHRegEnumUSValue', 32, (width, args)=>{
            const [handle, index, name, size, type, data, dataSize, flags] = args;
            const key = keys.get(handle >>> 0);
            const [open] = key ? sidesOf(key, flags) : [0];
            return open ? registry(`RegEnumValue${width}`, [open, index, name, size, 0, type, data,
                dataSize]) : ERROR_INVALID_PARAMETER;
        }),

        /**
         * LONG SHRegQueryInfoUSKeyA(HUSKEY hUSKey, LPDWORD pcSubKeys,
         *     LPDWORD pcchMaxSubKeyLen, LPDWORD pcValues, LPDWORD pcchMaxValueNameLen,
         *     SHREGENUM_FLAGS enumRegFlags)
         */
        ...both('SHRegQueryInfoUSKey', 24, (width, args)=>{
            const [handle, subKeys, subKeyLength, values, valueLength, flags] = args;
            const key = keys.get(handle >>> 0);
            const [open] = key ? sidesOf(key, flags) : [0];
            return open ? registry(`RegQueryInfoKey${width}`, [open, 0, 0, 0, subKeys,
                subKeyLength, 0, values, valueLength, 0, 0, 0]) : ERROR_INVALID_PARAMETER;
        }),
    };
}
