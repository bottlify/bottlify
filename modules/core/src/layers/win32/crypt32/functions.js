/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * crypt32 — the data protection calls.
 *
 * CryptProtectData seals a buffer so only CryptUnprotectData on the same
 * account opens it again; a program keeps a remembered password that way and
 * treats the blob as opaque bytes. This machine has one user and no key store
 * to bind a blob to, so the blob carries its own data, description and
 * entropy behind a header: what a program can observe -- the round trip, the
 * description handed back, a refusal for the wrong entropy or for bytes that
 * are not a blob -- is what Windows answers.
 */

import { createCertificateFunctions } from './certificates.js';
import { createEncodingFunctions } from './encoding.js';

const ERROR_INVALID_PARAMETER = 87;
/** What Windows sets when the blob is damaged or the entropy is not the one it was sealed with. */
const NTE_BAD_DATA = 0x80090005;

/** The header's tag, "BTDP". */
const MAGIC = 0x50445442;
const HEADER = 16;

/**
 * @typedef {Object} Crypt32Host
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(code: number) => void} setLastError
 * @property {(bytes: number) => number} localAlloc An LPTR block, which the caller
 *           LocalFrees; 0 when it cannot be had.
 * @typedef {Crypt32Host & Omit<import('./certificates.js').CertificatesHost,
 *     keyof Crypt32Host>} Crypt32FullHost
 */

/**
 * The data protection calls, and the certificate calls when the host can
 * free and knows the time and the roots (certificates.js).
 *
 * @param {Crypt32Host | Crypt32FullHost} host
 */
export function createCrypt32Functions(host){
    const certificates = 'localFree' in host
        ? { ...createCertificateFunctions(host), ...createEncodingFunctions(host) } : {};
    /** @param {number} address */
    const dword = address=>{
        const bytes = host.readMemory(address, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
    /**
     * A DATA_BLOB's bytes: { DWORD cbData; BYTE *pbData; }.
     *
     * @param {number} blob
     */
    const readBlob = blob=>{
        const size = dword(blob);
        const data = dword(blob + 4);
        return size === 0 ? new Uint8Array(0) : host.readMemory(data, size).slice();
    };
    /**
     * Fills a DATA_BLOB with a fresh LocalAlloc copy of `bytes`.
     *
     * @param {number} blob @param {Uint8Array} bytes
     */
    const writeBlob = (blob, bytes)=>{
        const at = host.localAlloc(Math.max(bytes.length, 1));
        if (at === 0)
        {
            return false;
        }
        host.writeMemory(at, bytes);
        const out = new Uint8Array(8);
        const view = new DataView(out.buffer);
        view.setUint32(0, bytes.length, true);
        view.setUint32(4, at, true);
        host.writeMemory(blob, out);
        return true;
    };
    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };

    return {
        ...certificates,
        /**
         * BOOL CryptProtectData(DATA_BLOB *pDataIn, LPCWSTR szDataDescr,
         *     DATA_BLOB *pOptionalEntropy, PVOID pvReserved,
         *     CRYPTPROTECT_PROMPTSTRUCT *pPromptStruct, DWORD dwFlags,
         *     DATA_BLOB *pDataOut)
         *
         * The blob: magic, then the byte lengths of the UTF-16 description,
         * the entropy and the data, then those three in order.
         */
        CryptProtectData: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([dataIn, description, entropy, , , , dataOut])=>{
                if ((dataIn >>> 0) === 0 || (dataOut >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const data = readBlob(dataIn >>> 0);
                const text = (description >>> 0) === 0
                    ? '' : host.readWideString(description >>> 0, 0x10000);
                const mixed = (entropy >>> 0) === 0 ? new Uint8Array(0) : readBlob(entropy >>> 0);
                const blob = new Uint8Array(HEADER + text.length * 2 + mixed.length + data.length);
                const view = new DataView(blob.buffer);
                view.setUint32(0, MAGIC, true);
                view.setUint32(4, text.length * 2, true);
                view.setUint32(8, mixed.length, true);
                view.setUint32(12, data.length, true);
                for (let i = 0; i < text.length; i++)
                {
                    view.setUint16(HEADER + i * 2, text.charCodeAt(i), true);
                }
                blob.set(mixed, HEADER + text.length * 2);
                blob.set(data, HEADER + text.length * 2 + mixed.length);
                return writeBlob(dataOut >>> 0, blob) ? 1 : 0;
            },
        },

        /**
         * BOOL CryptUnprotectData(DATA_BLOB *pDataIn, LPWSTR *ppszDataDescr,
         *     DATA_BLOB *pOptionalEntropy, PVOID pvReserved,
         *     CRYPTPROTECT_PROMPTSTRUCT *pPromptStruct, DWORD dwFlags,
         *     DATA_BLOB *pDataOut)
         *
         * The description, when asked for, is a LocalAlloc'd string too.
         */
        CryptUnprotectData: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([dataIn, descriptionOut, entropy, , , , dataOut])=>{
                if ((dataIn >>> 0) === 0 || (dataOut >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const blob = readBlob(dataIn >>> 0);
                const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
                if (blob.length < HEADER || view.getUint32(0, true) !== MAGIC)
                {
                    return fail(NTE_BAD_DATA);
                }
                const textBytes = view.getUint32(4, true);
                const mixedBytes = view.getUint32(8, true);
                const dataBytes = view.getUint32(12, true);
                if (HEADER + textBytes + mixedBytes + dataBytes !== blob.length
                    || textBytes % 2 !== 0)
                {
                    return fail(NTE_BAD_DATA);
                }
                const mixed = blob.subarray(HEADER + textBytes, HEADER + textBytes + mixedBytes);
                const given = (entropy >>> 0) === 0 ? new Uint8Array(0) : readBlob(entropy >>> 0);
                if (given.length !== mixed.length || given.some((byte, i)=>byte !== mixed[i]))
                {
                    return fail(NTE_BAD_DATA);
                }
                if (!writeBlob(dataOut >>> 0, blob.slice(HEADER + textBytes + mixedBytes)))
                {
                    return 0;
                }
                if ((descriptionOut >>> 0) !== 0)
                {
                    const text = new Uint8Array(textBytes + 2);
                    text.set(blob.subarray(HEADER, HEADER + textBytes));
                    const at = host.localAlloc(text.length);
                    if (at === 0)
                    {
                        return 0;
                    }
                    host.writeMemory(at, text);
                    const pointer = new Uint8Array(4);
                    new DataView(pointer.buffer).setUint32(0, at, true);
                    host.writeMemory(descriptionOut >>> 0, pointer);
                }
                return 1;
            },
        },
    };
}
