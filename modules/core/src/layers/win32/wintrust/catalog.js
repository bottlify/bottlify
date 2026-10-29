/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The catalog administrator: the hash a file is listed by in a security
 * catalog, and the search for the catalogs that list it.
 *
 * A browser asks this of a module that carries no signature of its own,
 * since a system file is signed through a catalog instead. The hash is the
 * file's own digest as its subject interface package computes it -- for a PE
 * image or a cabinet the Authenticode digest, which leaves out the bytes that
 * locate a signature; for any other file the digest of all of it. This
 * machine has no catalog database, so no catalog lists anything: the search
 * ends at once with ERROR_NOT_FOUND, as on Windows for a file no catalog names.
 */

import { createDigestFor, OID } from '../crypto/signature.js';
import { readSubject } from './subject.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NOT_FOUND = 1168;
const NTE_BAD_ALGID = 0x80090008;

/** Context handles, opaque and apart from wintrust's other handles. */
const ADMIN_BASE = 0x5ca00000;

/**
 * @typedef {Object} CatalogHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxBytes: number) => string} readWideString
 * @property {(thread: any, code: number) => void} setLastErrorFor
 * @property {() => any} callerThread
 * @property {(handle: number) => Uint8Array | null | Promise<Uint8Array | null>} fileBytes
 *   The whole of the file a kernel32 handle is open on; null for no such handle.
 */

/**
 * The digest a catalog lists `bytes` by.
 *
 * @param {Uint8Array} bytes @param {string} oid
 */
export function catalogHash(bytes, oid){
    const subject = readSubject(bytes);
    if (subject)
    {
        return subject.digest(oid);
    }
    const digest = createDigestFor(oid);
    if (!digest)
    {
        return null;
    }
    digest.update(bytes);
    return digest.digest();
}

/** @param {CatalogHost} host */
export function createCatalogFunctions(host){
    /** @type {Map<number, string>} admin handle -> its hash's OID */
    const admins = new Map();
    let next = ADMIN_BASE;
    /** @param {number} address */
    const dword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
    /** @param {number} address @param {number} value */
    const setDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * @param {number} out @param {string} oid
     * @returns {number}
     */
    const acquire = (out, oid)=>{
        const thread = host.callerThread();
        if ((out >>> 0) === 0)
        {
            host.setLastErrorFor(thread, ERROR_INVALID_PARAMETER);
            return 0;
        }
        const handle = next;
        next += 4;
        admins.set(handle, oid);
        setDword(out, handle);
        return 1;
    };

    /**
     * Writes the file's hash, or the size it needs.
     *
     * @param {number} file @param {number} sizeAt @param {number} out @param {string} oid
     * @returns {number | Promise<number>}
     */
    const hashFile = (file, sizeAt, out, oid)=>{
        const thread = host.callerThread();
        /** @param {number} code */
        const fail = code=>{
            host.setLastErrorFor(thread, code);
            return 0;
        };
        if ((sizeAt >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const length = oid === OID.SHA256 ? 32 : 20;
        if ((out >>> 0) === 0 || dword(sizeAt) < length)
        {
            setDword(sizeAt, length);
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        /** @param {Uint8Array | null} bytes */
        const finish = bytes=>{
            if (!bytes)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const hash = catalogHash(bytes, oid);
            if (!hash)
            {
                return fail(NTE_BAD_ALGID);
            }
            host.writeMemory(out >>> 0, hash);
            setDword(sizeAt, hash.length);
            return 1;
        };
        const bytes = host.fileBytes(file >>> 0);
        return bytes instanceof Promise ? bytes.then(finish) : finish(bytes);
    };

    /** @param {number} code */
    const refuse = code=>{
        host.setLastErrorFor(host.callerThread(), code);
        return 0;
    };

    return {
        /** BOOL CryptCATAdminAcquireContext(HCATADMIN *phCatAdmin, const GUID *pgSubsystem, DWORD) */
        CryptCATAdminAcquireContext: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [out])=>acquire(out, OID.SHA1),
        },

        /**
         * BOOL CryptCATAdminAcquireContext2(HCATADMIN *phCatAdmin, const GUID *pgSubsystem,
         *     PCWSTR pwszHashAlgorithm, PCCERT_STRONG_SIGN_PARA pStrongHashPolicy, DWORD)
         *
         * SHA1 when no algorithm is named, as before Windows 8; SHA256 by name.
         */
        CryptCATAdminAcquireContext2: {
            argBytes: 20,
            handler: (/** @type {number[]} */ [out, , algorithm])=>{
                const name = (algorithm >>> 0) === 0 ? 'SHA1'
                    : host.readWideString(algorithm >>> 0, 32 * 2).toUpperCase();
                const oid = name === 'SHA1' ? OID.SHA1 : name === 'SHA256' ? OID.SHA256 : null;
                return oid ? acquire(out, oid) : refuse(NTE_BAD_ALGID);
            },
        },

        /**
         * BOOL CryptCATAdminCalcHashFromFileHandle(HANDLE hFile, DWORD *pcbHash,
         *     BYTE *pbHash, DWORD dwFlags)
         */
        CryptCATAdminCalcHashFromFileHandle: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [file, size, out])=>
                hashFile(file, size, out, OID.SHA1),
        },

        /**
         * BOOL CryptCATAdminCalcHashFromFileHandle2(HCATADMIN hCatAdmin, HANDLE hFile,
         *     DWORD *pcbHash, BYTE *pbHash, DWORD dwFlags)
         */
        CryptCATAdminCalcHashFromFileHandle2: {
            argBytes: 20,
            handler: (/** @type {number[]} */ [admin, file, size, out])=>{
                const oid = admins.get(admin >>> 0);
                return oid ? hashFile(file, size, out, oid) : refuse(ERROR_INVALID_PARAMETER);
            },
        },

        /**
         * HCATINFO CryptCATAdminEnumCatalogFromHash(HCATADMIN hCatAdmin, BYTE *pbHash,
         *     DWORD cbHash, DWORD dwFlags, HCATINFO *phPrevCatInfo)
         */
        CryptCATAdminEnumCatalogFromHash: {
            argBytes: 20,
            handler: (/** @type {number[]} */ [admin])=>refuse(admins.has(admin >>> 0)
                ? ERROR_NOT_FOUND : ERROR_INVALID_PARAMETER),
        },

        /** BOOL CryptCATAdminReleaseCatalogContext(HCATADMIN, HCATINFO, DWORD): there are none. */
        CryptCATAdminReleaseCatalogContext: {
            argBytes: 12,
            handler: ()=>refuse(ERROR_INVALID_PARAMETER),
        },

        /** BOOL CryptCATAdminReleaseContext(HCATADMIN hCatAdmin, DWORD dwFlags) */
        CryptCATAdminReleaseContext: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [admin])=>(admins.delete(admin >>> 0) ? 1
                : refuse(ERROR_INVALID_PARAMETER)),
        },

        /** BOOL CryptCATCatalogInfoFromContext(HCATINFO, CATALOG_INFO *, DWORD): there are none. */
        CryptCATCatalogInfoFromContext: {
            argBytes: 12,
            handler: ()=>refuse(ERROR_INVALID_PARAMETER),
        },
    };
}
