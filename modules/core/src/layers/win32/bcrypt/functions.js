/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * bcrypt -- Cryptography API: Next Generation, the parts of it a program
 * reaches for random bytes and for a digest: the system's generator, by the
 * flag that names it or through an RNG algorithm handle, and the MD4, MD5,
 * SHA-1 and SHA-256 hashes, plain or keyed (HMAC).
 *
 * Vista's C runtime and anything built against a newer SDK fill their seeds
 * from BCryptGenRandom where XP's took RtlGenRandom; both draw on the same
 * source here, the host's cryptographic generator. Every other algorithm is
 * refused as one no provider implements, which is what a program checks for
 * before it falls back to its own code.
 */

import { charactersOf, readToTerminator } from '../common/scan-windows.js';
import { createMd4, createMd5, createSha1, createSha256 } from '../crypto/digest.js';

const STATUS_SUCCESS = 0;
const STATUS_INVALID_HANDLE = 0xc0000008 | 0;
const STATUS_INVALID_PARAMETER = 0xc000000d | 0;
const STATUS_NOT_FOUND = 0xc0000225 | 0;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023 | 0;
const STATUS_NOT_SUPPORTED = 0xc00000bb | 0;

/** BCryptOpenAlgorithmProvider's flag: the hash is keyed, an HMAC. */
const BCRYPT_ALG_HANDLE_HMAC_FLAG = 0x8;

/** The hashes, by the name an algorithm handle is opened by. */
const HASHES = new Map([
    ['MD4', createMd4], ['MD5', createMd5], ['SHA1', createSha1], ['SHA256', createSha256],
]);

/** The bytes of each hash's block, the HMAC key's length. */
const HASH_BLOCK = 64;

/**
 * Hash object bytes BCryptGetProperty(BCRYPT_OBJECT_LENGTH) asks a caller to
 * hand CreateHash. The state is kept here, so any size will do; this one is
 * not zero, which a caller that allocates it checks.
 */
const HASH_OBJECT_LENGTH = 64;

/** BCryptGenRandom's flag: the system's generator, with no handle. */
const BCRYPT_USE_SYSTEM_PREFERRED_RNG = 0x2;

/** Windows 10's pseudo-handle for the RNG algorithm, which needs no opening. */
const BCRYPT_RNG_ALG_HANDLE = 0x81;

/** The algorithm names an RNG handle is opened by (bcrypt.h). */
const RNG_ALGORITHMS = new Set(['RNG', 'FIPS186DSARNG', 'DUALECRNG']);

/**
 * Handles of their own, apart from the kernel's: a BCRYPT_ALG_HANDLE is a
 * pointer on Windows, never closed with CloseHandle.
 */
const HANDLE_BASE = 0x5d000000;
const HANDLE_STRIDE = 8;

/** Text an algorithm name may run to. */
const MAX_NAME = 64;

/**
 * @typedef {Object} BcryptHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 */

/**
 * As many bytes from the host's cryptographic generator, which caps a single
 * call at 64 KiB.
 *
 * @param {number} count
 */
const randomBytes = count=>{
    const out = new Uint8Array(count);
    for (let at = 0; at < count; at += 65536)
    {
        crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, count)));
    }
    return out;
};

/** @param {BcryptHost} host */
export function createBcryptFunctions(host){
    /** @type {Map<number, { name: string, hmac: boolean }>} */
    const algorithms = new Map();
    /**
     * Each hash in progress: its digest so far, for an HMAC the outer
     * digest's key block, and whether it was finished.
     *
     * @type {Map<number, { algorithm: string, digest: import('../crypto/digest.js').Digest,
     *     outer: Uint8Array | null, finished: boolean }>}
     */
    const hashes = new Map();
    let next = HANDLE_BASE;
    const handle = ()=>{
        const made = next;
        next += HANDLE_STRIDE;
        return made;
    };
    /** @param {number} address @param {number} value */
    const putU32 = (address, value)=>host.writeMemory(address,
        new Uint8Array(Uint32Array.of(value).buffer));
    /** A new digest of a hash algorithm. @param {string} name */
    const digestOf = name=>/** @type {() => import('../crypto/digest.js').Digest} */ (
        HASHES.get(name))();
    /** @param {string} name */
    const digestLength = name=>digestOf(name).digest().length;

    /** A wide name, up to its terminator. @param {number} address */
    const wideName = address=>charactersOf(
        readToTerminator(host, address >>> 0, 2, MAX_NAME).bytes, 2);

    return {
        /**
         * NTSTATUS BCryptOpenAlgorithmProvider(BCRYPT_ALG_HANDLE *phAlgorithm,
         *   LPCWSTR pszAlgId, LPCWSTR pszImplementation, ULONG dwFlags)
         *
         * A handle for one of the generators; any other algorithm is
         * STATUS_NOT_FOUND, as from a machine whose providers lack it.
         */
        BCryptOpenAlgorithmProvider: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, id, , flags])=>{
                if ((out >>> 0) === 0 || (id >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                const name = wideName(id).toUpperCase();
                const hmac = (flags & BCRYPT_ALG_HANDLE_HMAC_FLAG) !== 0;
                if (!(RNG_ALGORITHMS.has(name) && !hmac) && !HASHES.has(name))
                {
                    return STATUS_NOT_FOUND;
                }
                const made = handle();
                algorithms.set(made, { name, hmac });
                putU32(out >>> 0, made);
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS BCryptGetProperty(BCRYPT_HANDLE hObject, LPCWSTR pszProperty,
         *   PUCHAR pbOutput, ULONG cbOutput, ULONG *pcbResult, ULONG dwFlags)
         *
         * Of a hash algorithm or a hash: its object's length, its digest's
         * length, its block's length and its name. With no buffer, the size it
         * needs; with too small a one, STATUS_BUFFER_TOO_SMALL; a property this
         * does not keep, STATUS_NOT_SUPPORTED.
         */
        BCryptGetProperty: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([object, property, output, room, result])=>{
                const name = algorithms.get(object >>> 0)?.name
                    ?? hashes.get(object >>> 0)?.algorithm;
                if (name === undefined)
                {
                    return STATUS_INVALID_HANDLE;
                }
                if ((property >>> 0) === 0 || (result >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                /** @type {Record<string, () => Uint8Array>} */
                const properties = {
                    ObjectLength: ()=>new Uint8Array(Uint32Array.of(HASH_OBJECT_LENGTH).buffer),
                    HashDigestLength: ()=>new Uint8Array(
                        Uint32Array.of(digestLength(name)).buffer),
                    HashBlockLength: ()=>new Uint8Array(Uint32Array.of(HASH_BLOCK).buffer),
                    AlgorithmName: ()=>new Uint8Array(
                        Uint16Array.from(`${name}\0`, c=>c.charCodeAt(0)).buffer),
                };
                const which = wideName(property);
                const value = HASHES.has(name) && Object.hasOwn(properties, which)
                    ? properties[which]() : null;
                if (!value)
                {
                    return STATUS_NOT_SUPPORTED;
                }
                putU32(result >>> 0, value.length);
                if ((output >>> 0) === 0)
                {
                    return STATUS_SUCCESS;
                }
                if ((room >>> 0) < value.length)
                {
                    return STATUS_BUFFER_TOO_SMALL;
                }
                host.writeMemory(output >>> 0, value);
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS BCryptCreateHash(BCRYPT_ALG_HANDLE hAlgorithm,
         *   BCRYPT_HASH_HANDLE *phHash, PUCHAR pbHashObject, ULONG cbHashObject,
         *   PUCHAR pbSecret, ULONG cbSecret, ULONG dwFlags)
         *
         * A hash of the algorithm, keyed by the secret when the algorithm was
         * opened for an HMAC. The caller's hash object is not used: the state
         * is kept here.
         */
        BCryptCreateHash: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([algorithm, out, , , secret, secretLength])=>{
                const opened = algorithms.get(algorithm >>> 0);
                if (!opened || !HASHES.has(opened.name))
                {
                    return STATUS_INVALID_HANDLE;
                }
                if ((out >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                const digest = digestOf(opened.name);
                /** @type {Uint8Array | null} */
                let outer = null;
                if (opened.hmac)
                {
                    /** @type {Uint8Array} */
                    let key = (secretLength >>> 0) === 0 ? new Uint8Array(0)
                        : host.readMemory(secret >>> 0, secretLength >>> 0).slice();
                    if (key.length > HASH_BLOCK)
                    {
                        const long = digestOf(opened.name);
                        long.update(key);
                        key = long.digest();
                    }
                    const padded = new Uint8Array(HASH_BLOCK);
                    padded.set(key);
                    digest.update(padded.map(byte=>byte ^ 0x36));
                    outer = padded.map(byte=>byte ^ 0x5c);
                }
                const made = handle();
                hashes.set(made, { algorithm: opened.name, digest, outer, finished: false });
                putU32(out >>> 0, made);
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS BCryptHashData(BCRYPT_HASH_HANDLE hHash, PUCHAR pbInput,
         *   ULONG cbInput, ULONG dwFlags)
         */
        BCryptHashData: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hash, input, length])=>{
                const held = hashes.get(hash >>> 0);
                if (!held || held.finished)
                {
                    return STATUS_INVALID_HANDLE;
                }
                if ((length >>> 0) > 0)
                {
                    held.digest.update(host.readMemory(input >>> 0, length >>> 0).slice());
                }
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS BCryptFinishHash(BCRYPT_HASH_HANDLE hHash, PUCHAR pbOutput,
         *   ULONG cbOutput, ULONG dwFlags)
         *
         * The digest, into exactly its length - any other is
         * STATUS_INVALID_PARAMETER. The hash then takes no more data.
         */
        BCryptFinishHash: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hash, output, length])=>{
                const held = hashes.get(hash >>> 0);
                if (!held || held.finished)
                {
                    return STATUS_INVALID_HANDLE;
                }
                if ((length >>> 0) !== digestLength(held.algorithm) || (output >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                let value = held.digest.digest();
                if (held.outer)
                {
                    const outer = digestOf(held.algorithm);
                    outer.update(held.outer);
                    outer.update(value);
                    value = outer.digest();
                }
                host.writeMemory(output >>> 0, value);
                held.finished = true;
                return STATUS_SUCCESS;
            },
        },

        /** NTSTATUS BCryptDestroyHash(BCRYPT_HASH_HANDLE hHash) */
        BCryptDestroyHash: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hash])=>(hashes.delete(hash >>> 0)
                ? STATUS_SUCCESS : STATUS_INVALID_HANDLE),
        },

        /** NTSTATUS BCryptCloseAlgorithmProvider(BCRYPT_ALG_HANDLE hAlgorithm, ULONG dwFlags) */
        BCryptCloseAlgorithmProvider: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([algorithm])=>(algorithms.delete(algorithm >>> 0)
                ? STATUS_SUCCESS : STATUS_INVALID_HANDLE),
        },

        /**
         * NTSTATUS BCryptGenRandom(BCRYPT_ALG_HANDLE hAlgorithm, PUCHAR pbBuffer,
         *   ULONG cbBuffer, ULONG dwFlags)
         *
         * The buffer filled from the system's generator: named by the flag
         * with no handle, or by an RNG handle -- an opened one or Windows 10's
         * pseudo-handle -- without it. The flag with a handle is
         * STATUS_INVALID_PARAMETER, as the flag's contract has it; neither,
         * or a handle that is not an RNG's, is STATUS_INVALID_HANDLE; no
         * buffer is STATUS_INVALID_PARAMETER even for no bytes, as Wine's
         * conformance tests have it.
         */
        BCryptGenRandom: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([generator, buffer, count, flags])=>{
                const system = (flags & BCRYPT_USE_SYSTEM_PREFERRED_RNG) !== 0;
                const named = (generator >>> 0) === BCRYPT_RNG_ALG_HANDLE
                    || RNG_ALGORITHMS.has(algorithms.get(generator >>> 0)?.name ?? '');
                if (system ? (generator >>> 0) !== 0 : !named)
                {
                    return system ? STATUS_INVALID_PARAMETER : STATUS_INVALID_HANDLE;
                }
                if ((buffer >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                if ((count >>> 0) === 0)
                {
                    return STATUS_SUCCESS;
                }
                host.writeMemory(buffer >>> 0, randomBytes(count >>> 0));
                return STATUS_SUCCESS;
            },
        },
    };
}

/**
 * bcryptprimitives.dll: ProcessPrng, the per-process generator Windows 10's
 * own RNG calls rest on and a browser imports by name for its random bytes.
 * It cannot fail; it answers TRUE for any count, none included.
 *
 * @param {BcryptHost} host
 */
export function createBcryptPrimitivesFunctions(host){
    return {
        /** BOOL ProcessPrng(PBYTE pbData, SIZE_T cbData) */
        ProcessPrng: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, count])=>{
                if ((count >>> 0) > 0)
                {
                    host.writeMemory(buffer >>> 0, randomBytes(count >>> 0));
                }
                return 1;
            },
        },
    };
}
