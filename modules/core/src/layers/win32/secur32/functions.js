/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * secur32 and ncrypt -- the Security Support Provider Interface and CNG's
 * key storage, as a machine answers them that has no security package and
 * no key storage provider installed.
 *
 * A program reaches both through libraries it carries -- a media library
 * with a TLS transport of the system's, a browser engine that can sign in to
 * a proxy -- and imports them whole, so a missing library stops the
 * program's own library from loading at all. What it can observe here is
 * the refusal a package-less machine gives: no credentials can be acquired,
 * so no context exists and every call on one is an invalid handle; no key
 * can be made. Each program on that path already handles those answers,
 * since they are what it gets when a package is disabled by policy.
 *
 * GetUserNameEx is here too, being secur32's: the one account's name in the
 * two formats a machine outside a domain has.
 */

import { COMPUTER_NAME } from '../kernel32/drives.js';
import { USER_NAME } from '../advapi32/tokens.js';

const SEC_E_OK = 0;
const SEC_E_INVALID_HANDLE = 0x80090301 | 0;
const SEC_E_SECPKG_NOT_FOUND = 0x80090305 | 0;

const NTE_INVALID_HANDLE = 0x80090026 | 0;
const NTE_INVALID_PARAMETER = 0x80090027 | 0;
const NTE_NOT_SUPPORTED = 0x80090029 | 0;

const STATUS_SUCCESS = 0;
const STATUS_INVALID_HANDLE = 0xc0000008 | 0;
const STATUS_NO_SUCH_PACKAGE = 0xc00000fe | 0;

const ERROR_MORE_DATA = 234;
const ERROR_NONE_MAPPED = 1332;
const ERROR_INVALID_PARAMETER = 87;

/** EXTENDED_NAME_FORMAT's two a local account has: DOMAIN\user, and its display name. */
const NAME_SAM_COMPATIBLE = 2;
const NAME_DISPLAY = 3;

/** The handle LsaConnectUntrusted gives: one, there being one local authority. */
const LSA_HANDLE = 0x5e000004;

/**
 * @typedef {Object} SecurityHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(code: number) => void} setLastError
 */

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * An export that answers the same status whatever it is given.
 *
 * @param {number} argBytes @param {number} status
 */
const answers = (argBytes, status)=>({ argBytes, handler: ()=>status });

/** @param {SecurityHost} host */
export function createSecur32Functions(host){
    let lsaOpen = false;

    /** @param {number} address */
    const u32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);

    /**
     * GetUserNameEx in either width: the name into a buffer of `*size`
     * characters, the count without its terminator written back; too small a
     * buffer is ERROR_MORE_DATA with the count it needs, terminator included.
     *
     * @param {boolean} wide
     */
    const userNameEx = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([format, buffer, size])=>{
            const name = (format >>> 0) === NAME_SAM_COMPATIBLE ? `${COMPUTER_NAME}\\${USER_NAME}`
                : (format >>> 0) === NAME_DISPLAY ? USER_NAME : null;
            if ((size >>> 0) === 0)
            {
                host.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }
            if (name === null)
            {
                host.setLastError(ERROR_NONE_MAPPED);
                return 0;
            }
            if (u32(size) < name.length + 1 || (buffer >>> 0) === 0)
            {
                host.writeMemory(size >>> 0, dword(name.length + 1));
                host.setLastError(ERROR_MORE_DATA);
                return 0;
            }
            const text = wide
                ? new Uint8Array(Uint16Array.from(`${name}\0`, c=>c.charCodeAt(0)).buffer)
                : Uint8Array.from(`${name}\0`, c=>c.charCodeAt(0));
            host.writeMemory(buffer >>> 0, text);
            host.writeMemory(size >>> 0, dword(name.length));
            return 1;
        },
    });

    /**
     * QuerySecurityPackageInfo in either width: there is no package by any
     * name, and NULL is written where its record would go.
     */
    const packageInfo = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([, out])=>{
            if ((out >>> 0) !== 0)
            {
                host.writeMemory(out >>> 0, dword(0));
            }
            return SEC_E_SECPKG_NOT_FOUND;
        },
    };

    /** EnumerateSecurityPackages in either width: none, and no array to free. */
    const enumeratePackages = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([count, out])=>{
            if ((count >>> 0) !== 0)
            {
                host.writeMemory(count >>> 0, dword(0));
            }
            if ((out >>> 0) !== 0)
            {
                host.writeMemory(out >>> 0, dword(0));
            }
            return SEC_E_OK;
        },
    };

    return {
        AcquireCredentialsHandleA: answers(36, SEC_E_SECPKG_NOT_FOUND),
        AcquireCredentialsHandleW: answers(36, SEC_E_SECPKG_NOT_FOUND),
        InitializeSecurityContextA: answers(48, SEC_E_INVALID_HANDLE),
        InitializeSecurityContextW: answers(48, SEC_E_INVALID_HANDLE),
        AcceptSecurityContext: answers(36, SEC_E_INVALID_HANDLE),
        CompleteAuthToken: answers(8, SEC_E_INVALID_HANDLE),
        ApplyControlToken: answers(8, SEC_E_INVALID_HANDLE),
        DeleteSecurityContext: answers(4, SEC_E_INVALID_HANDLE),
        FreeCredentialsHandle: answers(4, SEC_E_INVALID_HANDLE),
        QueryContextAttributesA: answers(12, SEC_E_INVALID_HANDLE),
        QueryContextAttributesW: answers(12, SEC_E_INVALID_HANDLE),
        SetContextAttributesA: answers(16, SEC_E_INVALID_HANDLE),
        SetContextAttributesW: answers(16, SEC_E_INVALID_HANDLE),
        EncryptMessage: answers(16, SEC_E_INVALID_HANDLE),
        DecryptMessage: answers(16, SEC_E_INVALID_HANDLE),
        MakeSignature: answers(16, SEC_E_INVALID_HANDLE),
        VerifySignature: answers(16, SEC_E_INVALID_HANDLE),
        // Nothing here hands out a buffer to free, and freeing NULL is fine.
        FreeContextBuffer: answers(4, SEC_E_OK),
        QuerySecurityPackageInfoA: packageInfo,
        QuerySecurityPackageInfoW: packageInfo,
        EnumerateSecurityPackagesA: enumeratePackages,
        EnumerateSecurityPackagesW: enumeratePackages,

        /** BOOLEAN GetUserNameExA/W(EXTENDED_NAME_FORMAT NameFormat, LPSTR lpNameBuffer, PULONG nSize) */
        GetUserNameExA: userNameEx(false),
        GetUserNameExW: userNameEx(true),

        /**
         * NTSTATUS LsaConnectUntrusted(PHANDLE LsaHandle)
         *
         * The local authority, which anyone may connect to; it knows no
         * authentication package, so a logon through it is refused.
         */
        LsaConnectUntrusted: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                lsaOpen = true;
                host.writeMemory(out >>> 0, dword(LSA_HANDLE));
                return STATUS_SUCCESS;
            },
        },

        /** NTSTATUS LsaDeregisterLogonProcess(HANDLE LsaHandle) */
        LsaDeregisterLogonProcess: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!lsaOpen || (handle >>> 0) !== LSA_HANDLE)
                {
                    return STATUS_INVALID_HANDLE;
                }
                lsaOpen = false;
                return STATUS_SUCCESS;
            },
        },

        /** NTSTATUS LsaLookupAuthenticationPackage(HANDLE, PLSA_STRING, PULONG) */
        LsaLookupAuthenticationPackage: answers(12, STATUS_NO_SUCH_PACKAGE),
        /** NTSTATUS LsaLogonUser(...), fourteen arguments: no package to log on through. */
        LsaLogonUser: answers(56, STATUS_NO_SUCH_PACKAGE),
        /** NTSTATUS LsaFreeReturnBuffer(PVOID): nothing is ever returned to free. */
        LsaFreeReturnBuffer: answers(4, STATUS_SUCCESS),
    };
}

/**
 * ncrypt: no key storage provider to open, so no key is ever made and every
 * handle a program could pass is not one.
 *
 * @param {SecurityHost} host
 */
export function createNcryptFunctions(host){
    return {
        /**
         * SECURITY_STATUS NCryptOpenStorageProvider(NCRYPT_PROV_HANDLE *phProvider,
         *   LPCWSTR pszProviderName, DWORD dwFlags)
         *
         * Not supported: zero written where the handle would go.
         */
        NCryptOpenStorageProvider: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return NTE_INVALID_PARAMETER;
                }
                host.writeMemory(out >>> 0, dword(0));
                return NTE_NOT_SUPPORTED;
            },
        },
        NCryptCreatePersistedKey: answers(24, NTE_INVALID_HANDLE),
        NCryptOpenKey: answers(20, NTE_INVALID_HANDLE),
        NCryptFinalizeKey: answers(8, NTE_INVALID_HANDLE),
        NCryptDeleteKey: answers(8, NTE_INVALID_HANDLE),
        NCryptFreeObject: answers(4, NTE_INVALID_HANDLE),
        NCryptSetProperty: answers(20, NTE_INVALID_HANDLE),
        NCryptGetProperty: answers(24, NTE_INVALID_HANDLE),
        NCryptExportKey: answers(32, NTE_INVALID_HANDLE),
        NCryptImportKey: answers(32, NTE_INVALID_HANDLE),
        NCryptSignHash: answers(32, NTE_INVALID_HANDLE),
        NCryptDecrypt: answers(32, NTE_INVALID_HANDLE),
        NCryptEncrypt: answers(32, NTE_INVALID_HANDLE),
        NCryptIsKeyHandle: answers(4, 0),
        // Nothing allocated here for a caller to free.
        NCryptFreeBuffer: answers(4, 0),
    };
}
