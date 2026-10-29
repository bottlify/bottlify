/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * bcrypt -- Cryptography API: Next Generation, the part of it a program
 * reaches for random bytes: the system's generator, by the flag that names
 * it or through an RNG algorithm handle.
 *
 * Vista's C runtime and anything built against a newer SDK fill their seeds
 * from BCryptGenRandom where XP's took RtlGenRandom; both draw on the same
 * source here, the host's cryptographic generator. Every other algorithm is
 * refused as one no provider implements, which is what a program checks for
 * before it falls back to its own code.
 */

import { charactersOf, readToTerminator } from '../common/scan-windows.js';

const STATUS_SUCCESS = 0;
const STATUS_INVALID_HANDLE = 0xc0000008 | 0;
const STATUS_INVALID_PARAMETER = 0xc000000d | 0;
const STATUS_NOT_FOUND = 0xc0000225 | 0;

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
    /** @type {Map<number, string>} */
    const algorithms = new Map();
    let next = HANDLE_BASE;

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
            handler: ([out, id])=>{
                if ((out >>> 0) === 0 || (id >>> 0) === 0)
                {
                    return STATUS_INVALID_PARAMETER;
                }
                const name = wideName(id).toUpperCase();
                if (!RNG_ALGORITHMS.has(name))
                {
                    return STATUS_NOT_FOUND;
                }
                const handle = next;
                next += HANDLE_STRIDE;
                algorithms.set(handle, name);
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, handle, true);
                host.writeMemory(out >>> 0, bytes);
                return STATUS_SUCCESS;
            },
        },

        /** NTSTATUS BCryptCloseAlgorithmProvider(BCRYPT_ALG_HANDLE hAlgorithm, ULONG dwFlags) */
        BCryptCloseAlgorithmProvider: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>(algorithms.delete(handle >>> 0)
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
            handler: ([handle, buffer, count, flags])=>{
                const system = (flags & BCRYPT_USE_SYSTEM_PREFERRED_RNG) !== 0;
                const named = (handle >>> 0) === BCRYPT_RNG_ALG_HANDLE
                    || algorithms.has(handle >>> 0);
                if (system ? (handle >>> 0) !== 0 : !named)
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
