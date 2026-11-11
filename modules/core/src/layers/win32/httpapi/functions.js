/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * httpapi - the HTTP Server API's configuration store, which a setup writes
 * its URL reservations into (the .NET Framework's ServiceModelReg reserves the
 * prefixes WCF listens on).
 *
 * A URL reservation (HttpServiceConfigUrlAclInfo) is kept where Windows keeps
 * it, under `HKLM\SYSTEM\CurrentControlSet\Services\HTTP\Parameters\UrlAclInfo`,
 * one value a prefix holding its security descriptor in SDDL, so a bottle
 * carries what its installation reserved. Nothing listens here, so a
 * reservation only answers queries. The other stores - the IP listen list,
 * the SSL certificates, the timeouts, the cache - are taken and kept nowhere,
 * said once each, and a query of them finds nothing.
 */

const NO_ERROR = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_NO_MORE_ITEMS = 259;

/** HTTP_INITIALIZE_SERVER and HTTP_INITIALIZE_CONFIG: the only flags there are. */
const HTTP_INITIALIZE_ALL = 0x3;

/** HTTP_SERVICE_CONFIG_ID: the store a call names. */
const URL_ACL_INFO = 2;
const CONFIG_IDS = 7;

/** HTTP_SERVICE_CONFIG_QUERY_TYPE */
const QUERY_EXACT = 0;
const QUERY_NEXT = 1;

const HKEY_LOCAL_MACHINE = 0x80000002;
const URL_ACL_PATH = 'SYSTEM\\CurrentControlSet\\Services\\HTTP\\Parameters\\UrlAclInfo';
const REG_SZ = 1;

/** A string's length to read, in bytes; longer than any URL prefix or SDDL. */
const MAX_TEXT = 0x10000;

/**
 * @typedef {Object} HttpapiHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {ReturnType<typeof import('../advapi32/registry-service.js').createRegistryService>} hive
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {string} text */
const utf16z = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >> 8;
    }
    return bytes;
};

/** @param {Uint8Array} bytes */
const textOf = bytes=>{
    let text = '';
    for (let at = 0; at + 1 < bytes.length; at += 2)
    {
        const unit = bytes[at] | bytes[at + 1] << 8;
        if (unit === 0)
        {
            break;
        }
        text += String.fromCharCode(unit);
    }
    return text;
};

/** @param {HttpapiHost} host */
export function createHttpapiFunctions(host){
    /** @param {number} address */
    const dword = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} pointer */
    const wide = pointer=>((pointer >>> 0) === 0 ? null
        : host.readWideString(pointer >>> 0, MAX_TEXT));

    /** The stores this machine takes and keeps nowhere, each said once. */
    const said = new Set();
    /** @param {string} api @param {number} id */
    const keptNowhere = (api, id)=>{
        if (!said.has(id))
        {
            said.add(id);
            host.divergence?.(api, `HTTP service configuration ${id} is taken and kept nowhere`);
        }
    };

    /** The reservations' key, made when it is to be written. @param {boolean} make */
    const reservations = make=>{
        const root = /** @type {number} */ (host.hive.root(HKEY_LOCAL_MACHINE));
        return make ? host.hive.create(root, URL_ACL_PATH).key : host.hive.open(root, URL_ACL_PATH);
    };
    /** Every reservation, in the order it was made. */
    const reserved = ()=>{
        const key = reservations(false);
        return key === null ? [] : host.hive.values(key).map(value=>({ url: value.name,
            sddl: textOf(value.data) }));
    };
    /** @param {string} url */
    const find = url=>reserved().find(one=>one.url.toLowerCase() === url.toLowerCase()) ?? null;

    /** The prefix and descriptor a URL ACL call is given, or null for a bad record. */
    const urlAclSet = (/** @type {number} */ record, /** @type {number} */ length)=>{
        if ((record >>> 0) === 0 || length < 8)
        {
            return null;
        }
        const url = wide(dword(record));
        return url === null || url === '' ? null : { url, sddl: wide(dword(record + 4)) };
    };

    return {
        /**
         * ULONG HttpInitialize(HTTPAPI_VERSION Version, ULONG Flags, PVOID pReserved)
         *
         * The version is two USHORTs passed by value: 1.0 or 2.0.
         */
        HttpInitialize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([version, flags, spare])=>{
                const major = version & 0xffff;
                if ((major !== 1 && major !== 2) || (version >>> 16) !== 0
                    || (flags & ~HTTP_INITIALIZE_ALL) !== 0 || flags === 0
                    || (spare >>> 0) !== 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                return NO_ERROR;
            },
        },

        /** ULONG HttpTerminate(ULONG Flags, PVOID pReserved) */
        HttpTerminate: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flags, spare])=>((flags & ~HTTP_INITIALIZE_ALL) !== 0 || flags === 0
                || (spare >>> 0) !== 0 ? ERROR_INVALID_PARAMETER : NO_ERROR),
        },

        /**
         * ULONG HttpSetServiceConfiguration(HANDLE ServiceHandle,
         *   HTTP_SERVICE_CONFIG_ID ConfigId, PVOID pConfigInformation,
         *   ULONG ConfigInformationLength, LPOVERLAPPED pOverlapped)
         *
         * A URL reservation made: a prefix already reserved is ERROR_ALREADY_EXISTS.
         */
        HttpSetServiceConfiguration: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, id, record, length])=>{
                if ((id >>> 0) >= CONFIG_IDS || (record >>> 0) === 0 || (length >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if ((id >>> 0) !== URL_ACL_INFO)
                {
                    keptNowhere('HttpSetServiceConfiguration', id >>> 0);
                    return NO_ERROR;
                }
                const set = urlAclSet(record, length >>> 0);
                if (!set || !set.sddl)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if (find(set.url))
                {
                    return ERROR_ALREADY_EXISTS;
                }
                host.hive.setValue(/** @type {number} */ (reservations(true)), set.url, REG_SZ,
                    utf16z(set.sddl));
                return NO_ERROR;
            },
        },

        /**
         * ULONG HttpDeleteServiceConfiguration(HANDLE, HTTP_SERVICE_CONFIG_ID,
         *   PVOID pConfigInformation, ULONG ConfigInformationLength, LPOVERLAPPED)
         *
         * A URL reservation taken off: one not made is ERROR_FILE_NOT_FOUND.
         */
        HttpDeleteServiceConfiguration: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, id, record, length])=>{
                if ((id >>> 0) >= CONFIG_IDS || (record >>> 0) === 0 || (length >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if ((id >>> 0) !== URL_ACL_INFO)
                {
                    keptNowhere('HttpDeleteServiceConfiguration', id >>> 0);
                    return ERROR_FILE_NOT_FOUND;
                }
                const set = urlAclSet(record, length >>> 0);
                if (!set)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const found = find(set.url);
                const key = reservations(false);
                if (!found || key === null)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                host.hive.deleteValue(key, found.url);
                return NO_ERROR;
            },
        },

        /**
         * ULONG HttpQueryServiceConfiguration(HANDLE, HTTP_SERVICE_CONFIG_ID,
         *   PVOID pInput, ULONG InputLength, PVOID pOutput, ULONG OutputLength,
         *   PULONG pReturnLength, LPOVERLAPPED)
         *
         * A URL reservation by its prefix (HttpServiceConfigQueryExact) or by
         * its place among them (HttpServiceConfigQueryNext, dwToken), written
         * as an HTTP_SERVICE_CONFIG_URLACL_SET with its two strings after it;
         * a buffer too small is ERROR_INSUFFICIENT_BUFFER with the size wanted.
         */
        HttpQueryServiceConfiguration: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([, id, input, inputLength, output, outputLength, returned])=>{
                if ((id >>> 0) >= CONFIG_IDS || (input >>> 0) === 0 || (inputLength >>> 0) < 4)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const type = dword(input);
                if ((id >>> 0) !== URL_ACL_INFO)
                {
                    keptNowhere('HttpQueryServiceConfiguration', id >>> 0);
                    return type === QUERY_NEXT ? ERROR_NO_MORE_ITEMS : ERROR_FILE_NOT_FOUND;
                }
                if ((inputLength >>> 0) < 12 || (type !== QUERY_EXACT && type !== QUERY_NEXT))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                let found;
                if (type === QUERY_EXACT)
                {
                    const url = wide(dword(input + 4));
                    if (!url)
                    {
                        return ERROR_INVALID_PARAMETER;
                    }
                    found = find(url);
                    if (!found)
                    {
                        return ERROR_FILE_NOT_FOUND;
                    }
                }
                else
                {
                    found = reserved()[dword(input + 8)];
                    if (!found)
                    {
                        return ERROR_NO_MORE_ITEMS;
                    }
                }
                const url = utf16z(found.url);
                const sddl = utf16z(found.sddl);
                const size = 8 + url.length + sddl.length;
                if ((returned >>> 0) !== 0)
                {
                    writeDword(returned, size);
                }
                if ((output >>> 0) === 0 || (outputLength >>> 0) < size)
                {
                    return ERROR_INSUFFICIENT_BUFFER;
                }
                const at = output >>> 0;
                writeDword(at, at + 8);
                writeDword(at + 4, at + 8 + url.length);
                host.writeMemory(at + 8, url);
                host.writeMemory(at + 8 + url.length, sddl);
                return NO_ERROR;
            },
        },
    };
}
