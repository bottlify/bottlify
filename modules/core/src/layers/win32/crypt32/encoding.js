/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * crypt32's conversions that need no store: bytes to and from base64 and hex
 * text (the PEM a TLS library reads a certificate from), a certificate's hash
 * by its CNG name, the in-place memory sealing a browser keeps a secret in,
 * the few extension structures a TLS stack decodes and encodes, and X.500
 * names from text.
 *
 * Every call with an out-buffer follows crypt32's size protocol: no buffer
 * asks for the size, a buffer too small is ERROR_MORE_DATA with the size
 * written, and the size is always written back.
 */

import { childrenOf, DerError, expect, readBitString, readBoolean, readInteger,
    readNode, readOid, TAG } from '../crypto/der.js';
import { createMd5, createSha1, createSha256 } from '../crypto/digest.js';
import { derElement, oidContents, readGeneralNames } from '../crypto/x509.js';
import { NAME_STR, stringToName } from './names.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_DATA = 13;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const NTE_BAD_ALGID = 0x80090008;
const CRYPT_E_ASN1_BADTAG = 0x8009310b;
const CRYPT_E_INVALID_X500_STRING = 0x80092023;

/** CryptStringToBinary / CryptBinaryToString formats. */
export const STRING = Object.freeze({
    BASE64HEADER: 0, BASE64: 1, BINARY: 2, BASE64REQUESTHEADER: 3, HEX: 4, HEXASCII: 5,
    BASE64_ANY: 6, ANY: 7, HEX_ANY: 8, BASE64X509CRLHEADER: 9, HEXADDR: 10,
    HEXASCIIADDR: 11, HEXRAW: 12, NOCRLF: 0x40000000, NOCR: 0x80000000,
});

/** The struct types handled, by their number (an LPCSTR below 0x10000) and their OID. */
const STRUCT = Object.freeze({ ALTERNATE_NAME: 12, KEY_USAGE: 14, BASIC_CONSTRAINTS2: 15,
    ENHANCED_KEY_USAGE: 36 });
const STRUCT_OIDS = new Map([
    ['2.5.29.17', STRUCT.ALTERNATE_NAME], ['2.5.29.18', STRUCT.ALTERNATE_NAME],
    ['2.5.29.7', STRUCT.ALTERNATE_NAME], ['2.5.29.8', STRUCT.ALTERNATE_NAME],
    ['2.5.29.15', STRUCT.KEY_USAGE], ['2.5.29.19', STRUCT.BASIC_CONSTRAINTS2],
    ['2.5.29.37', STRUCT.ENHANCED_KEY_USAGE],
]);
const CRYPT_DECODE_ALLOC_FLAG = 0x8000;
const CRYPT_ENCODE_ALLOC_FLAG = 0x8000;

/** CERT_ALT_NAME_ENTRY's choices that hold a wide string, and the blob ones. */
const ALT_WIDE = new Set([2, 3, 7]);
const ALT_BLOB = new Set([5, 8]);

/** CryptProtectMemory's flags and block. */
const CRYPTPROTECTMEMORY_BLOCK_SIZE = 16;
const CRYPTPROTECTMEMORY_CROSS_PROCESS = 1;
const CRYPTPROTECTMEMORY_SAME_LOGON = 2;

/** The headers BASE64HEADER and its kin write and read. */
const HEADERS = Object.freeze({
    [STRING.BASE64HEADER]: 'CERTIFICATE',
    [STRING.BASE64REQUESTHEADER]: 'NEW CERTIFICATE REQUEST',
    [STRING.BASE64X509CRLHEADER]: 'X509 CRL',
});

/**
 * @typedef {Object} EncodingHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxBytes: number) => string} readWideString
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} setLastError
 * @property {(bytes: number) => number} localAlloc
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {Uint8Array} bytes */
const toBase64 = bytes=>{
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000)
    {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(text);
};

/**
 * Bytes as text in one of CryptBinaryToString's formats.
 *
 * @param {Uint8Array} bytes @param {number} flags
 * @returns {string | null} null for a format not known.
 */
export function binaryToString(bytes, flags){
    const format = flags & 0xffff;
    const eol = (flags & STRING.NOCRLF) !== 0 ? '' : (flags & STRING.NOCR) !== 0 ? '\n' : '\r\n';
    /** @param {string} text @param {number} width */
    const lines = (text, width)=>{
        let out = '';
        for (let at = 0; at < text.length; at += width)
        {
            out += text.slice(at, at + width) + eol;
        }
        return out;
    };
    const hex = (/** @type {number} */ byte)=>byte.toString(16).padStart(2, '0');
    switch (format)
    {
        case STRING.BASE64:
            return lines(toBase64(bytes), 64);
        case STRING.BASE64HEADER:
        case STRING.BASE64REQUESTHEADER:
        case STRING.BASE64X509CRLHEADER: {
            const label = HEADERS[/** @type {0 | 3 | 9} */ (format)];
            const crlf = eol === '' ? '\r\n' : eol;
            return `-----BEGIN ${label}-----${crlf}${lines(toBase64(bytes), 64)}`
                + `-----END ${label}-----${crlf}`;
        }
        case STRING.BINARY:
            return String.fromCharCode(...bytes);
        case STRING.HEXRAW:
            return [...bytes].map(hex).join('') + eol;
        case STRING.HEX: {
            // Sixteen bytes a line, a space between, two in the middle.
            let out = '';
            for (let at = 0; at < bytes.length; at += 16)
            {
                const row = [...bytes.subarray(at, at + 16)].map(hex);
                out += `${row.slice(0, 8).join(' ')}${row.length > 8 ? '  ' : ''}`
                    + `${row.slice(8).join(' ')}${eol}`;
            }
            return out;
        }
        default:
            return null;
    }
}

/**
 * Text in one of CryptStringToBinary's formats as bytes, with the format it
 * turned out to be (the _ANY formats try theirs in turn).
 *
 * @param {string} text @param {number} format
 * @returns {{ bytes: Uint8Array, format: number } | null}
 */
export function stringToBinary(text, format){
    /** @param {string} body */
    const base64 = body=>{
        const clean = body.replace(/[\s]/g, '');
        if (clean === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1)
        {
            return null;
        }
        try
        {
            return Uint8Array.from(atob(clean), ch=>ch.charCodeAt(0));
        }
        catch {
            return null;
        }
    };
    /** @param {number} which */
    const withHeader = which=>{
        const match = /-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/.exec(text);
        if (!match)
        {
            return null;
        }
        const label = HEADERS[/** @type {0 | 3 | 9} */ (which)];
        if (which !== STRING.BASE64HEADER && match[1] !== label)
        {
            return null;
        }
        return base64(match[2]);
    };
    /** @param {string} body */
    const hexText = body=>{
        const clean = body.replace(/\s/g, '');
        return clean.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(clean) && clean !== ''
            ? Uint8Array.from(clean.match(/../g) ?? [], pair=>parseInt(pair, 16)) : null;
    };
    /** @type {(number)[]} */
    const tries = format === STRING.BASE64_ANY ? [STRING.BASE64HEADER, STRING.BASE64]
        : format === STRING.ANY ? [STRING.BASE64HEADER, STRING.BASE64, STRING.BINARY]
            : format === STRING.HEX_ANY ? [STRING.HEX, STRING.HEXRAW] : [format];
    for (const one of tries)
    {
        const bytes = one === STRING.BASE64 ? base64(text)
            : one === STRING.BASE64HEADER || one === STRING.BASE64REQUESTHEADER
                || one === STRING.BASE64X509CRLHEADER ? withHeader(one)
                : one === STRING.BINARY ? Uint8Array.from(text, ch=>ch.charCodeAt(0) & 0xff)
                    : one === STRING.HEX || one === STRING.HEXRAW ? hexText(text) : null;
        if (bytes)
        {
            return { bytes, format: one };
        }
    }
    return null;
}

/** @param {EncodingHost} host */
export function createEncodingFunctions(host){
    /** @param {number} address */
    const dword = address=>{
        const bytes = host.readMemory(address, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
    /** @param {number} address @param {number} value */
    const setDword = (address, value)=>{
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, out);
    };
    /** @param {number} code @param {number} [value] */
    const fail = (code, value = 0)=>{
        host.setLastError(code);
        return value;
    };

    /**
     * Writes `bytes` to `out` under the size protocol, the size at `size`.
     *
     * @param {Uint8Array} bytes @param {number} out @param {number} size
     */
    const answerBytes = (bytes, out, size)=>{
        if (out === 0)
        {
            setDword(size, bytes.length);
            return 1;
        }
        if (dword(size) < bytes.length)
        {
            setDword(size, bytes.length);
            return fail(ERROR_MORE_DATA);
        }
        host.writeMemory(out, bytes);
        setDword(size, bytes.length);
        return 1;
    };

    /** @param {boolean} wide */
    const stringToBinaryCall = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: ([pointer, count, flags, out, size, skip, used])=>{
            if ((pointer >>> 0) === 0 || (size >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const limit = (count >>> 0) === 0 ? 0x100000 : count >>> 0;
            const read = wide ? host.readWideString(pointer >>> 0, limit * 2)
                : host.readCString(pointer >>> 0, limit);
            const text = (count >>> 0) === 0 ? read : read.slice(0, count >>> 0);
            const found = stringToBinary(text, flags & 0xffff);
            if (!found)
            {
                return fail(ERROR_INVALID_DATA);
            }
            if ((skip >>> 0) !== 0)
            {
                const begin = text.indexOf('-----BEGIN');
                setDword(skip >>> 0, found.format === STRING.BASE64HEADER && begin > 0 ? begin : 0);
            }
            if ((used >>> 0) !== 0)
            {
                setDword(used >>> 0, found.format);
            }
            return answerBytes(found.bytes, out >>> 0, size >>> 0);
        },
    });

    /** @param {boolean} wide */
    const binaryToStringCall = wide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([pointer, length, flags, out, size])=>{
            if ((size >>> 0) === 0 || ((pointer >>> 0) === 0 && (length >>> 0) !== 0))
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const bytes = (length >>> 0) === 0 ? new Uint8Array(0)
                : host.readMemory(pointer >>> 0, length >>> 0).slice();
            const text = binaryToString(bytes, flags >>> 0);
            if (text === null)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            // Without a buffer the count is with the terminator; with one,
            // without it.
            if ((out >>> 0) === 0)
            {
                setDword(size >>> 0, text.length + 1);
                return 1;
            }
            if (dword(size >>> 0) < text.length + 1)
            {
                setDword(size >>> 0, text.length + 1);
                return fail(ERROR_MORE_DATA);
            }
            const encoded = new Uint8Array(wide ? text.length * 2 + 2 : text.length + 1);
            for (let i = 0; i < text.length; i++)
            {
                if (wide)
                {
                    encoded[i * 2] = text.charCodeAt(i) & 0xff;
                    encoded[i * 2 + 1] = text.charCodeAt(i) >> 8;
                }
                else
                {
                    encoded[i] = text.charCodeAt(i) & 0xff;
                }
            }
            host.writeMemory(out >>> 0, encoded);
            setDword(size >>> 0, text.length);
            return 1;
        },
    });

    // The process's sealing key, and the one every process of the machine
    // shares for the cross-process and same-logon flags.
    const processKey = crypto.getRandomValues(new Uint8Array(32));
    const machineKey = new TextEncoder().encode('crypt32 CryptProtectMemory machine');
    /**
     * XORs a buffer with a keystream from the key: protecting and unprotecting
     * are the same operation, and the length never changes, as the API needs.
     *
     */
    const sealMemory = ()=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([pointer, length, scope])=>{
            if ((length >>> 0) % CRYPTPROTECTMEMORY_BLOCK_SIZE !== 0 || (pointer >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const key = (scope & (CRYPTPROTECTMEMORY_CROSS_PROCESS | CRYPTPROTECTMEMORY_SAME_LOGON))
                !== 0 ? machineKey : processKey;
            const bytes = host.readMemory(pointer >>> 0, length >>> 0).slice();
            for (let block = 0; block * 32 < bytes.length; block++)
            {
                const digest = createSha256();
                digest.update(key);
                digest.update(Uint8Array.of(block & 0xff, (block >> 8) & 0xff,
                    (block >> 16) & 0xff, block >>> 24));
                const stream = digest.digest();
                for (let i = 0; i < 32 && block * 32 + i < bytes.length; i++)
                {
                    bytes[block * 32 + i] ^= stream[i];
                }
            }
            host.writeMemory(pointer >>> 0, bytes);
            return 1;
        },
    });

    /** An LPCSTR struct type for a report. @param {number} pointer */
    const structName = pointer=>((pointer >>> 0) < 0x10000 ? String(pointer >>> 0)
        : host.readCString(pointer >>> 0, 128));
    /** The struct type an LPCSTR names, or -1. @param {number} pointer */
    const structOf = pointer=>((pointer >>> 0) < 0x10000 ? pointer >>> 0
        : STRUCT_OIDS.get(host.readCString(pointer >>> 0, 128)) ?? -1);

    /**
     * Lays out a decoded structure: `build` is given a writer of trailing
     * data (strings, blobs) and answers the fixed part as dwords, each a
     * number, `{ tail: n }` (an offset into the trailing data) or `{ self: n }`
     * (a byte offset into the fixed part itself, where an array of entries is
     * laid inline); both are made absolute once the base is known.
     *
     * @param {(tail: { bytes: (data: Uint8Array) => number }) =>
     *     (number | { tail: number } | { self: number })[]} build
     */
    const layOut = build=>{
        /** @type {Uint8Array[]} */
        const pieces = [];
        let tailSize = 0;
        const fixed = build({
            bytes: data=>{
                const at = tailSize;
                pieces.push(data);
                tailSize += (data.length + 3) & ~3;
                return at;
            },
        });
        return (/** @type {number} */ base)=>{
            const out = new Uint8Array(fixed.length * 4 + tailSize);
            const view = new DataView(out.buffer);
            const tailBase = fixed.length * 4;
            fixed.forEach((value, index)=>view.setUint32(index * 4, (typeof value === 'number'
                ? value : 'tail' in value ? base + tailBase + value.tail : base + value.self) >>> 0,
            true));
            let at = tailBase;
            for (const piece of pieces)
            {
                out.set(piece, at);
                at += (piece.length + 3) & ~3;
            }
            return out;
        };
    };

    /** @param {string} text */
    const wideZ = text=>{
        const out = new Uint8Array(text.length * 2 + 2);
        for (let i = 0; i < text.length; i++)
        {
            out[i * 2] = text.charCodeAt(i) & 0xff;
            out[i * 2 + 1] = text.charCodeAt(i) >> 8;
        }
        return out;
    };
    /** @param {string} text */
    const asciiZ = text=>Uint8Array.from([...text, '\0'], ch=>ch.charCodeAt(0));

    /**
     * A structure's layout for the DER `bytes`, or null for a struct type not decoded.
     *
     * @param {number} type @param {Uint8Array} bytes
     * @returns {((base: number) => Uint8Array) | null}
     */
    const decode = (type, bytes)=>{
        const root = readNode(bytes);
        if (root.end !== bytes.length)
        {
            throw new DerError('bytes after the value');
        }
        switch (type)
        {
            case STRUCT.BASIC_CONSTRAINTS2: {
                // CERT_BASIC_CONSTRAINTS2_INFO: fCA, fPathLenConstraint, dwPathLenConstraint.
                const [first, second] = childrenOf(expect(root, TAG.SEQUENCE, 'constraints'));
                const ca = first?.tag === TAG.BOOLEAN && readBoolean(first);
                const length = first?.tag === TAG.INTEGER ? first : second;
                return layOut(()=>[ca ? 1 : 0, length ? 1 : 0,
                    length ? Number(readInteger(length)) : 0]);
            }
            case STRUCT.ENHANCED_KEY_USAGE: {
                // CERT_ENHKEY_USAGE: cUsageIdentifier, rgpszUsageIdentifier.
                const usages = childrenOf(expect(root, TAG.SEQUENCE, 'usages')).map(readOid);
                // The array of string pointers is laid inline after the two fields.
                return layOut(tail=>[usages.length, { self: 8 },
                    ...usages.map(usage=>({ tail: tail.bytes(asciiZ(usage)) }))]);
            }
            case STRUCT.KEY_USAGE: {
                // CRYPT_BIT_BLOB: cbData, pbData, cUnusedBits.
                const { bits, unused } = readBitString(root);
                return layOut(tail=>[bits.length, { tail: tail.bytes(bits.slice()) }, unused]);
            }
            case STRUCT.ALTERNATE_NAME: {
                // CERT_ALT_NAME_INFO: cAltEntry, rgAltEntry of CERT_ALT_NAME_ENTRY
                // (dwAltNameChoice, then a string pointer or a blob).
                const names = readGeneralNames(bytes);
                return layOut(tail=>[names.length, { self: 8 }, ...names.flatMap(name=>{
                    const choice = name.choice + 1;
                    if (ALT_WIDE.has(choice))
                    {
                        return [choice,
                            { tail: tail.bytes(wideZ(String.fromCharCode(...name.raw))) }, 0];
                    }
                    if (ALT_BLOB.has(choice))
                    {
                        return [choice, name.raw.length, { tail: tail.bytes(name.raw.slice()) }];
                    }
                    if (choice === 9)
                    {
                        const oid = readOid(readNode(derElement(TAG.OID, name.raw)));
                        return [choice, { tail: tail.bytes(asciiZ(oid)) }, 0];
                    }
                    return [choice, 0, 0];
                })]);
            }
            default:
                return null;
        }
    };

    /**
     * The DER for a structure in guest memory, or null for a type not encoded.
     *
     * @param {number} type @param {number} pointer
     */
    const encode = (type, pointer)=>{
        switch (type)
        {
            case STRUCT.BASIC_CONSTRAINTS2: {
                const parts = [];
                if (dword(pointer) !== 0)
                {
                    parts.push(Uint8Array.of(TAG.BOOLEAN, 1, 0xff));
                }
                if (dword(pointer + 4) !== 0)
                {
                    const value = dword(pointer + 8);
                    /** @type {number[]} */
                    const octets = [];
                    for (let left = value; ; left = Math.floor(left / 256))
                    {
                        octets.unshift(left & 0xff);
                        if (left < 256)
                        {
                            break;
                        }
                    }
                    if (octets[0] & 0x80)
                    {
                        octets.unshift(0);
                    }
                    parts.push(derElement(TAG.INTEGER, Uint8Array.from(octets)));
                }
                return derElement(TAG.SEQUENCE, ...parts);
            }
            case STRUCT.ENHANCED_KEY_USAGE: {
                const count = dword(pointer);
                const list = dword(pointer + 4);
                const oids = Array.from({ length: Math.min(count, 256) },
                    (_, i)=>derElement(TAG.OID,
                        oidContents(host.readCString(dword(list + i * 4), 128))));
                return derElement(TAG.SEQUENCE, ...oids);
            }
            default:
                return null;
        }
    };

    /** @param {boolean} wide */
    const strToName = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: ([, text, type, , out, size, error])=>{
            if ((text >>> 0) === 0 || (size >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const string = wide ? host.readWideString(text >>> 0, 0x10000)
                : host.readCString(text >>> 0, 0x8000);
            const kind = (type >>> 0) & 0xffff;
            if (kind !== NAME_STR.X500 && kind !== NAME_STR.OID && kind !== NAME_STR.SIMPLE
                && kind !== 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const parsed = stringToName(string, type >>> 0);
            if ('error' in parsed)
            {
                if ((error >>> 0) !== 0)
                {
                    setDword(error >>> 0, (text >>> 0) + parsed.error * (wide ? 2 : 1));
                }
                return fail(CRYPT_E_INVALID_X500_STRING);
            }
            if ((error >>> 0) !== 0)
            {
                setDword(error >>> 0, 0);
            }
            return answerBytes(parsed.encoded, out >>> 0, size >>> 0);
        },
    });

    return {
        /**
         * BOOL CryptStringToBinaryA(LPCSTR pszString, DWORD cchString, DWORD dwFlags,
         *     BYTE *pbBinary, DWORD *pcbBinary, DWORD *pdwSkip, DWORD *pdwFlags)
         */
        CryptStringToBinaryA: stringToBinaryCall(false),
        CryptStringToBinaryW: stringToBinaryCall(true),

        /**
         * BOOL CryptBinaryToStringA(const BYTE *pbBinary, DWORD cbBinary, DWORD dwFlags,
         *     LPSTR pszString, DWORD *pcchString)
         */
        CryptBinaryToStringA: binaryToStringCall(false),
        CryptBinaryToStringW: binaryToStringCall(true),

        /**
         * BOOL CryptHashCertificate2(LPCWSTR pwszCNGHashAlgid, DWORD dwFlags,
         *     void *pvReserved, const BYTE *pbEncoded, DWORD cbEncoded,
         *     BYTE *pbComputedHash, DWORD *pcbComputedHash)
         */
        CryptHashCertificate2: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([algorithm, , , pointer, length, out, size])=>{
                if ((algorithm >>> 0) === 0 || (size >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const name = host.readWideString(algorithm >>> 0, 64 * 2).toUpperCase();
                const make = { SHA1: createSha1, SHA256: createSha256, MD5: createMd5 }[name];
                if (!make)
                {
                    return fail(NTE_BAD_ALGID);
                }
                const digest = make();
                if ((length >>> 0) > 0)
                {
                    digest.update(host.readMemory(pointer >>> 0, length >>> 0));
                }
                return answerBytes(digest.digest(), out >>> 0, size >>> 0);
            },
        },

        /** BOOL CryptProtectMemory(LPVOID pDataIn, DWORD cbDataIn, DWORD dwFlags) */
        CryptProtectMemory: sealMemory(),
        /** BOOL CryptUnprotectMemory(LPVOID pDataIn, DWORD cbDataIn, DWORD dwFlags) */
        CryptUnprotectMemory: sealMemory(),

        /**
         * BOOL CryptDecodeObjectEx(DWORD dwCertEncodingType, LPCSTR lpszStructType,
         *     const BYTE *pbEncoded, DWORD cbEncoded, DWORD dwFlags,
         *     PCRYPT_DECODE_PARA pDecodePara, void *pvStructInfo, DWORD *pcbStructInfo)
         *
         * With CRYPT_DECODE_ALLOC_FLAG the structure is a LocalAlloc block
         * whose address goes to pvStructInfo.
         */
        CryptDecodeObjectEx: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([, structType, pointer, length, flags, , out, size])=>{
                if ((pointer >>> 0) === 0 || (size >>> 0) === 0 && ((flags >>> 0)
                    & CRYPT_DECODE_ALLOC_FLAG) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const type = structOf(structType);
                /** @type {((base: number) => Uint8Array) | null} */
                let build;
                try
                {
                    build = type < 0 ? null
                        : decode(type, host.readMemory(pointer >>> 0, length >>> 0).slice());
                }
                catch (e){
                    if (!(e instanceof DerError))
                    {
                        throw e;
                    }
                    return fail(CRYPT_E_ASN1_BADTAG);
                }
                if (!build)
                {
                    host.divergence?.('CryptDecodeObjectEx',
                        `struct type ${structName(structType)} is not decoded`);
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                const size0 = build(0).length;
                if (((flags >>> 0) & CRYPT_DECODE_ALLOC_FLAG) !== 0)
                {
                    const block = host.localAlloc(size0);
                    host.writeMemory(block, build(block));
                    setDword(out >>> 0, block);
                    if ((size >>> 0) !== 0)
                    {
                        setDword(size >>> 0, size0);
                    }
                    return 1;
                }
                if ((out >>> 0) === 0)
                {
                    setDword(size >>> 0, size0);
                    return 1;
                }
                if (dword(size >>> 0) < size0)
                {
                    setDword(size >>> 0, size0);
                    return fail(ERROR_MORE_DATA);
                }
                host.writeMemory(out >>> 0, build(out >>> 0));
                setDword(size >>> 0, size0);
                return 1;
            },
        },

        /**
         * BOOL CryptEncodeObjectEx(DWORD dwCertEncodingType, LPCSTR lpszStructType,
         *     const void *pvStructInfo, DWORD dwFlags, PCRYPT_ENCODE_PARA pEncodePara,
         *     void *pvEncoded, DWORD *pcbEncoded)
         */
        CryptEncodeObjectEx: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([, structType, info, flags, , out, size])=>{
                if ((info >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const type = structOf(structType);
                const bytes = type < 0 ? null : encode(type, info >>> 0);
                if (!bytes)
                {
                    host.divergence?.('CryptEncodeObjectEx',
                        `struct type ${structName(structType)} is not encoded`);
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                if (((flags >>> 0) & CRYPT_ENCODE_ALLOC_FLAG) !== 0)
                {
                    const block = host.localAlloc(bytes.length);
                    host.writeMemory(block, bytes);
                    setDword(out >>> 0, block);
                    if ((size >>> 0) !== 0)
                    {
                        setDword(size >>> 0, bytes.length);
                    }
                    return 1;
                }
                if ((size >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                return answerBytes(bytes, out >>> 0, size >>> 0);
            },
        },

        /**
         * BOOL CertStrToNameA(DWORD dwCertEncodingType, LPCSTR pszX500, DWORD dwStrType,
         *     void *pvReserved, BYTE *pbEncoded, DWORD *pcbEncoded, LPCSTR *ppszError)
         */
        CertStrToNameA: strToName(false),
        CertStrToNameW: strToName(true),
    };
}
