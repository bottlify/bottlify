/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cryptographic service providers the machine has, as the registry lists
 * them: each provider a key under `...\Cryptography\Defaults\Provider` with
 * its type, each type a key under `...\Provider Types` naming its default
 * provider, and a user's own default under the user's hive. The enumerations
 * read the keys in the order the registry keeps them, and setting a default
 * writes them -- so a program that reads the registry and one that asks the
 * API agree.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_SZ } from './registry.js';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const NTE_BAD_FLAGS = 0x80090009;
const NTE_BAD_PROV_TYPE = 0x80090014;
const NTE_PROV_TYPE_NOT_DEF = 0x80090017;
const NTE_PROV_TYPE_ENTRY_BAD = 0x80090018;

/** CryptGetDefaultProvider's and CryptSetProviderEx's flags. */
const CRYPT_MACHINE_DEFAULT = 0x1;
const CRYPT_USER_DEFAULT = 0x2;
const CRYPT_DELETE_DEFAULT = 0x4;

export const PROVIDERS_PATH = 'SOFTWARE\\Microsoft\\Cryptography\\Defaults\\Provider';
export const PROVIDER_TYPES_PATH = 'SOFTWARE\\Microsoft\\Cryptography\\Defaults\\Provider Types';
const USER_TYPES_PATH = 'SOFTWARE\\Microsoft\\Cryptography\\Provider Type';

/** The longest provider name read out of the guest. */
const MAX_NAME = 1024;

/** @param {number} type @returns {string} the key a type's default is under: Type 001 */
export const typeKeyName = type=>`Type ${String(type).padStart(3, '0')}`;

/**
 * @typedef {Object} ProviderHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} [setLastError]
 * @property {ReturnType<typeof import('./registry-service.js').createRegistryService>} hive
 */

/**
 * The provider registry: what acquiring a context looks names up in, and the
 * enumerations and defaults over it.
 *
 * @param {ProviderHost} host
 */
export function createProviderRegistry(host){
    const { hive } = host;

    /** @param {number} root @param {string} path */
    const keyAt = (root, path)=>{
        const base = hive.root(root);
        return base === null ? null : hive.open(base, path);
    };
    /** @param {any} key @param {string} name @returns {string | null} */
    const text = (key, name)=>{
        const value = key === null ? null : hive.getValue(key, name);
        if (!value)
        {
            return null;
        }
        const end = value.data.indexOf(0);
        return decodeAnsi(value.data.subarray(0, end < 0 ? value.data.length : end));
    };
    /** @param {any} key @param {string} name @returns {number | null} */
    const number = (key, name)=>{
        const value = key === null ? null : hive.getValue(key, name);
        return value && value.data.length >= 4
            ? new DataView(value.data.buffer, value.data.byteOffset).getUint32(0, true) : null;
    };

    /** The providers, in the registry's order: name and type. */
    const providers = ()=>{
        const key = keyAt(HKEY_LOCAL_MACHINE, PROVIDERS_PATH);
        return key === null ? [] : hive.subkeys(key).map(name=>({
            name, type: number(hive.open(key, name), 'Type') ?? 0 }));
    };

    /** The provider types, in the registry's order: number and name. */
    const types = ()=>{
        const key = keyAt(HKEY_LOCAL_MACHINE, PROVIDER_TYPES_PATH);
        return key === null ? [] : hive.subkeys(key).flatMap(entry=>{
            const found = /^Type (\d{3})$/i.exec(entry);
            return found ? [{ type: Number(found[1]),
                name: text(hive.open(key, entry), 'TypeName') ?? '' }] : [];
        });
    };

    /**
     * The default provider of a type: the user's if one is set and asked for,
     * else the machine's.
     *
     * @param {number} type @param {boolean} user @returns {string | null}
     */
    const defaultOf = (type, user)=>{
        if (user)
        {
            const own = text(keyAt(HKEY_CURRENT_USER, `${USER_TYPES_PATH} ${String(type)
                .padStart(3, '0')}`), 'Name');
            if (own !== null)
            {
                return own;
            }
        }
        return text(keyAt(HKEY_LOCAL_MACHINE, `${PROVIDER_TYPES_PATH}\\${typeKeyName(type)}`),
            'Name');
    };

    /** @param {string} name @returns {{ name: string, type: number } | null} */
    const providerNamed = name=>providers().find(entry=>
        entry.name.toUpperCase() === name.toUpperCase()) ?? null;

    /** @param {number} code */
    const fail = code=>{
        host.setLastError?.(code);
        return 0;
    };
    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {string} name @param {boolean} wide @returns {Uint8Array} */
    const encode = (name, wide)=>(wide
        ? new Uint8Array(Uint16Array.from(`${name}\0`, c=>c.charCodeAt(0)).buffer)
        : encodeAnsi(`${name}\0`));
    /** @param {number} address @param {boolean} wide */
    const readName = (address, wide)=>{
        if (!wide)
        {
            return host.readCString(address >>> 0, MAX_NAME);
        }
        let name = '';
        for (let at = address >>> 0; name.length < MAX_NAME; at += 2)
        {
            const unit = host.readMemory(at, 2);
            const code = unit[0] | unit[1] << 8;
            if (code === 0)
            {
                break;
            }
            name += String.fromCharCode(code);
        }
        return name;
    };

    /**
     * A name into the caller's buffer, by the size convention: no buffer is
     * a size asked for, too small a one ERROR_MORE_DATA; the size is in
     * bytes, terminator included.
     *
     * @param {string} name @param {boolean} wide @param {number} buffer @param {number} size
     */
    const nameOut = (name, wide, buffer, size)=>{
        const bytes = encode(name, wide);
        const room = readDword(size);
        writeDword(size, bytes.length);
        if ((buffer >>> 0) === 0)
        {
            return 1;
        }
        if (room < bytes.length)
        {
            return fail(ERROR_MORE_DATA);
        }
        host.writeMemory(buffer >>> 0, bytes);
        return 1;
    };

    /**
     * CryptEnumProviders and CryptEnumProviderTypes: the index-th entry's
     * type and name.
     *
     * @param {boolean} wide @param {boolean} ofTypes
     */
    const enumerate = (wide, ofTypes)=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [index, reserved, flags, typeOut, buffer, size])=>{
            if ((reserved >>> 0) !== 0 || (size >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if ((flags >>> 0) !== 0)
            {
                return fail(NTE_BAD_FLAGS);
            }
            const list = ofTypes ? types() : providers();
            const entry = list[index >>> 0];
            if (!entry)
            {
                return fail(ERROR_NO_MORE_ITEMS);
            }
            if ((typeOut >>> 0) !== 0)
            {
                writeDword(typeOut, entry.type);
            }
            return nameOut(entry.name, wide, buffer, size);
        },
    });

    /**
     * CryptGetDefaultProvider(DWORD dwProvType, DWORD *pdwReserved, DWORD dwFlags,
     *   LPTSTR pszProvName, DWORD *pcbProvName)
     *
     * @param {boolean} wide
     */
    const getDefault = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [type, reserved, flags, buffer, size])=>{
            if ((reserved >>> 0) !== 0 || (size >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if (((flags >>> 0) & ~(CRYPT_MACHINE_DEFAULT | CRYPT_USER_DEFAULT)) !== 0
                || (flags >>> 0) === (CRYPT_MACHINE_DEFAULT | CRYPT_USER_DEFAULT))
            {
                return fail(NTE_BAD_FLAGS);
            }
            if ((type >>> 0) === 0 || (type >>> 0) > 999)
            {
                return fail(NTE_BAD_PROV_TYPE);
            }
            const name = defaultOf(type >>> 0, ((flags >>> 0) & CRYPT_MACHINE_DEFAULT) === 0);
            if (name === null)
            {
                return fail(NTE_PROV_TYPE_ENTRY_BAD);
            }
            return nameOut(name, wide, buffer, size);
        },
    });

    /**
     * CryptSetProviderEx(LPCTSTR pszProvName, DWORD dwProvType, DWORD *pdwReserved,
     *   DWORD dwFlags)
     *
     * The type's default for the machine or the user, written where the
     * enumeration and the acquire read it; a user's default can be deleted,
     * the machine's cannot.
     *
     * @param {boolean} wide
     */
    const setDefault = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [nameAddress, type, reserved, flags])=>{
            if ((reserved >>> 0) !== 0 || (nameAddress >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const bits = flags >>> 0;
            if ((bits & ~(CRYPT_MACHINE_DEFAULT | CRYPT_USER_DEFAULT | CRYPT_DELETE_DEFAULT)) !== 0
                || (bits & (CRYPT_MACHINE_DEFAULT | CRYPT_USER_DEFAULT)) === 0)
            {
                return fail(NTE_BAD_FLAGS);
            }
            if ((type >>> 0) === 0 || (type >>> 0) > 999)
            {
                return fail(NTE_BAD_PROV_TYPE);
            }
            const machine = (bits & CRYPT_MACHINE_DEFAULT) !== 0;
            if ((bits & CRYPT_DELETE_DEFAULT) !== 0)
            {
                if (machine)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const base = hive.root(HKEY_CURRENT_USER);
                if (base !== null)
                {
                    hive.remove(base, `${USER_TYPES_PATH} ${String(type >>> 0).padStart(3, '0')}`);
                }
                return 1;
            }
            const provider = providerNamed(readName(nameAddress, wide));
            if (provider === null || provider.type !== (type >>> 0))
            {
                return fail(NTE_PROV_TYPE_NOT_DEF);
            }
            const root = hive.root(machine ? HKEY_LOCAL_MACHINE : HKEY_CURRENT_USER);
            if (root === null)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const key = hive.create(root, machine
                ? `${PROVIDER_TYPES_PATH}\\${typeKeyName(type >>> 0)}`
                : `${USER_TYPES_PATH} ${String(type >>> 0).padStart(3, '0')}`).key;
            hive.setValue(key, 'Name', REG_SZ, encodeAnsi(`${provider.name}\0`));
            return 1;
        },
    });

    return {
        defaultOf,
        providerNamed,
        functions: {
            /**
             * BOOL CryptEnumProviders(DWORD dwIndex, DWORD *pdwReserved, DWORD dwFlags,
             *   DWORD *pdwProvType, LPTSTR szProvName, DWORD *pcbProvName)
             */
            CryptEnumProvidersA: enumerate(false, false),
            CryptEnumProvidersW: enumerate(true, false),
            /**
             * BOOL CryptEnumProviderTypes(DWORD dwIndex, DWORD *pdwReserved, DWORD dwFlags,
             *   DWORD *pdwProvType, LPTSTR szTypeName, DWORD *pcbTypeName)
             */
            CryptEnumProviderTypesA: enumerate(false, true),
            CryptEnumProviderTypesW: enumerate(true, true),
            CryptGetDefaultProviderA: getDefault(false),
            CryptGetDefaultProviderW: getDefault(true),
            CryptSetProviderExA: setDefault(false),
            CryptSetProviderExW: setDefault(true),
            /** BOOL CryptSetProvider(LPCTSTR pszProvName, DWORD dwProvType): the user's default. */
            CryptSetProviderA: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([name, type])=>setDefault(false).handler([name, type, 0,
                    CRYPT_USER_DEFAULT]),
            },
            CryptSetProviderW: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([name, type])=>setDefault(true).handler([name, type, 0,
                    CRYPT_USER_DEFAULT]),
            },
        },
    };
}

