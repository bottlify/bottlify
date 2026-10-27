/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The advapi32 surface over a CryptoAPI provider: hashing, keys and random.
 *
 * An installer of this era asks advapi32 for a cryptographic provider before it
 * trusts its own media -- it acquires a context, hashes a blob, derives a
 * session key, and verifies a signature against a public key it carries. Every
 * one of those answers has to be the real thing: a hash that is wrong by a byte
 * fails the signature check and stops the install, and a check that always says
 * "yes" is a per-title crutch rather than a contract.
 *
 * So the digests, RC4 and the RSA arithmetic are written out in full, in
 * win32/crypto/ where the Authenticode verifier finds them too, and the
 * PKCS#1 v1.5 verification here stands on them. They run synchronously,
 * because a call into the guest cannot await Web Crypto.
 *
 * What is not here is a private key. Signing therefore fails the way it fails
 * for a caller that holds only a public key, and importing a key blob that was
 * wrapped for a private key we do not have fails too; neither is faked.
 */

import { createMd5, createSha1, createSha256 } from '../crypto/digest.js';
import { createRc4 } from '../crypto/rc4.js';
import { createProviderRegistry } from './providers.js';
import { bigIntToBe, bigIntToLe, beToBigInt, leToBigInt, modPow } from '../crypto/rsa.js';

/** @typedef {import('../crypto/digest.js').Digest} Digest */
/** @typedef {import('../crypto/rc4.js').StreamCipher} StreamCipher */

/* ------------------------------------------------------------------ *
 * Guest integers in key blobs are little-endian.
 * ------------------------------------------------------------------ */

/** @param {Uint8Array} b @param {number} o */
const readU32LE = (b, o)=>((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
    | (b[o + 3] << 24)) >>> 0);

/** @param {Uint8Array} b @param {number} o @param {number} v */
const writeU32LE = (b, o, v)=>{
    b[o] = v & 0xff;
    b[o + 1] = (v >>> 8) & 0xff;
    b[o + 2] = (v >>> 16) & 0xff;
    b[o + 3] = (v >>> 24) & 0xff;
};

/* ------------------------------------------------------------------ *
 * Constants of the CryptoAPI contract.
 * ------------------------------------------------------------------ */

/** CryptAcquireContext flags. */
const CRYPT_VERIFYCONTEXT = 0xf0000000;
const CRYPT_NEWKEYSET = 0x00000008;
const CRYPT_DELETEKEYSET = 0x00000010;

/** CryptDeriveKey / CryptGenKey / CryptImportKey flags. */
const CRYPT_EXPORTABLE = 0x00000001;

/** CryptSignHash / CryptVerifySignature flags. */
const CRYPT_NOHASHOID = 0x00000020;
const CRYPT_X931_FORMAT = 0x00000080;

/** Algorithm identifiers this build knows. */
const CALG_MD5 = 0x8003;
const CALG_SHA1 = 0x8004;
const CALG_SHA256 = 0x800c;
const CALG_RC4 = 0x6801;

/** The class field of an ALG_ID. */
const ALG_CLASS_MASK = 0xe000;
const ALG_CLASS_SIGNATURE = 0x2000;
const ALG_CLASS_DATA_ENCRYPT = 0x6000;
const ALG_CLASS_KEY_EXCHANGE = 0xa000;

/** Hash parameters. */
const HP_ALGID = 1;
const HP_HASHVAL = 2;
const HP_HASHSIZE = 4;

/** Key blob types and the fixed parts of their headers. */
const SIMPLEBLOB = 1;
const PUBLICKEYBLOB = 6;
const PRIVATEKEYBLOB = 7;
const PLAINTEXTKEYBLOB = 8;
const CUR_BLOB_VERSION = 2;
const BLOBHEADER_SIZE = 8;
const RSAPUBKEY_SIZE = 12;
const RSA1_MAGIC = 0x31415352;

/** The provider's error codes, reported through the last error. */
const NTE_BAD_KEY = 0x80090003;
const NTE_BAD_LEN = 0x80090004;
const NTE_BAD_DATA = 0x80090005;
const NTE_BAD_SIGNATURE = 0x80090006;
const NTE_BAD_VER = 0x80090007;
const NTE_BAD_ALGID = 0x80090008;
const NTE_BAD_FLAGS = 0x80090009;
const NTE_BAD_TYPE = 0x8009000a;
const NTE_NO_KEY = 0x8009000d;
/** The two key pairs a container holds: for exchanging keys and for signing. */
const AT_KEYEXCHANGE = 1;
const AT_SIGNATURE = 2;
const NTE_BAD_HASH_STATE = 0x8009000c;
const NTE_FAIL = 0x80090020;
const NTE_BAD_KEYSET = 0x80090016;
const NTE_EXISTS = 0x8009000f;
const NTE_BAD_PROV_TYPE = 0x80090014;
const NTE_PROV_TYPE_NOT_DEF = 0x80090017;
const NTE_KEYSET_NOT_DEF = 0x80090019;
const NTE_PROV_TYPE_NO_MATCH = 0x8009001b;

/** Win32 codes the provider also reports, for buffer and parameter faults. */
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NOACCESS = 998;

/** CryptGetProvParam's and CryptSetProvParam's parameters. */
const PP_ENUMALGS = 1;
const PP_ENUMCONTAINERS = 2;
const PP_IMPTYPE = 3;
const PP_NAME = 4;
const PP_VERSION = 5;
const PP_CONTAINER = 6;
const PP_KEYSET_SEC_DESCR = 8;
const PP_PROVTYPE = 16;
const PP_ENUMALGS_EX = 22;
const PP_KEYSET_TYPE = 27;
const PP_UNIQUE_CONTAINER = 36;
const PP_KEYSPEC = 39;
const CRYPT_FIRST = 1;
const CRYPT_IMPL_SOFTWARE = 2;
const CRYPT_MACHINE_KEYSET = 0x20;
/** The version the Microsoft providers of XP answer: 2.0. */
const PROVIDER_VERSION = 0x200;

/** CryptGetKeyParam's and CryptSetKeyParam's parameters. */
const KP_IV = 1;
const KP_SALT = 2;
const KP_PADDING = 3;
const KP_MODE = 4;
const KP_MODE_BITS = 5;
const KP_PERMISSIONS = 6;
const KP_ALGID = 7;
const KP_BLOCKLEN = 8;
const KP_KEYLEN = 9;
const KP_SALT_EX = 10;
const KP_EFFECTIVE_KEYLEN = 19;
/** CRYPT_ENCRYPT, DECRYPT, READ, WRITE and MAC; CRYPT_EXPORT when it may leave. */
const KEY_PERMISSIONS = 0x3b;
const CRYPT_EXPORT = 0x4;

/** The algorithms this provider answers for, as PP_ENUMALGS lists them. */
const ALGORITHMS = [
    [0x6801, 128, 40, 128, 'RC4'], [0x8003, 128, 128, 128, 'MD5'],
    [0x8004, 160, 160, 160, 'SHA-1'], [0x2400, 1024, 384, 16384, 'RSA_SIGN'],
    [0xa400, 1024, 384, 16384, 'RSA_KEYX'],
];

/** The default RC4 key length, in bits, when a caller does not name one. */
const DEFAULT_RC4_BITS = 128;

/** The largest session key this build holds. */
const MAX_KEY_BYTES = 64;

/** PKCS#1 v1.5 DigestInfo prefixes, concatenated with the hash value. */
const DIGEST_INFO = new Map([
    [CALG_MD5, [0x30, 0x20, 0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48,
        0x86, 0xf7, 0x0d, 0x02, 0x05, 0x05, 0x00, 0x04, 0x10]],
    [CALG_SHA1, [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03,
        0x02, 0x1a, 0x05, 0x00, 0x04, 0x14]],
    [CALG_SHA256, [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48,
        0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20]],
]);

/* ------------------------------------------------------------------ *
 * The provider object model.
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} RsaPublicKey
 * @property {bigint} n
 * @property {bigint} e
 * @property {number} bitlen
 * @property {bigint} [d]  The private exponent, when a private key was imported.
 */

/**
 * @typedef {Object} ProviderObject
 * @property {'provider'} kind
 * @property {number} type
 * @property {string} container
 * @property {boolean} verify
 * @property {Set<number>} children
 * @property {string} name      The provider's name, as the registry lists it.
 * @property {number} refs      CryptAcquireContext's one, and each CryptContextAddRef's.
 * @property {number} [enumAt]       Where PP_ENUMALGS goes on from.
 * @property {number} [containerAt]  Where PP_ENUMCONTAINERS goes on from.
 */

/**
 * @typedef {Object} HashObject
 * @property {'hash'} kind
 * @property {number} prov
 * @property {number} algid
 * @property {Digest} digest
 * @property {number} size
 * @property {Uint8Array | null} value
 */

/**
 * @typedef {Object} KeyObject
 * @property {'key'} kind
 * @property {number} prov
 * @property {number} algid
 * @property {'data' | 'signature' | 'keyexchange'} role
 * @property {number} keyLen in bytes
 * @property {Uint8Array} value
 * @property {boolean} exportable
 * @property {RsaPublicKey | null} rsa
 * @property {StreamCipher | null} stream
 * @property {number} [permissions]  KP_PERMISSIONS, once set.
 * @property {Uint8Array} [salt]
 */

/** @typedef {ProviderObject | HashObject | KeyObject} CryptoObject */

/** The hash each supported digest algorithm produces, in bytes. */
const HASH_SIZE = new Map([[CALG_MD5, 16], [CALG_SHA1, 20], [CALG_SHA256, 32]]);

/** @param {number} algid @returns {Digest | null} */
function createDigest(algid){
    switch (algid){
        case CALG_MD5:
            return createMd5();
        case CALG_SHA1:
            return createSha1();
        case CALG_SHA256:
            return createSha256();
        default:
            return null;
    }
}

/**
 * @typedef {Object} CryptoHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} [setLastError]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {ReturnType<typeof import('./registry-service.js').createRegistryService>} [hive]
 *           Where the providers are listed. Without it every provider name
 *           is taken as one of this provider's, and nothing is enumerated.
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory a handle points into. Without it handles are small numbers.
 * @property {(address: number, length: number) => boolean} [canWrite]
 *           Whether the guest may write a range: what RtlGenRandom checks
 *           before it fills one.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * @param {CryptoHost} host
 */
export function createCryptoFunctions(host){
    /** @type {Map<number, CryptoObject>} */
    const handles = new Map();
    /** Containers a CRYPT_NEWKEYSET acquire has created, by name. */
    const containers = new Set();
    let next = 4;

    /**
     * A handle for an object: where the guest can allocate, a pointer to a
     * block whose first word is not zero, as Windows' handles are pointers
     * to the provider's own structures -- a program has been seen to read
     * through one.
     *
     * @param {CryptoObject} object @returns {number}
     */
    const alloc = object=>{
        let handle = next;
        if (host.allocate)
        {
            handle = host.allocate(8) >>> 0;
            writeDword(handle, handle);
        }
        else
        {
            next += 4;
        }
        handles.set(handle, object);
        return handle;
    };

    /** @param {number} code @returns {number} always 0, the failure return */
    const fail = code=>{
        host.setLastError?.(code);
        return 0;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address >>> 0, new Uint8Array([
            value & 0xff, (value >>> 8) & 0xff,
            (value >>> 16) & 0xff, (value >>> 24) & 0xff,
        ]));
    };

    /** @param {number} address */
    const readDword = address=>readU32LE(host.readMemory(address >>> 0, 4), 0);

    /** @param {number} address @param {number} length */
    const readBytes = (address, length)=>host.readMemory(address >>> 0, length).slice();

    /** @param {number} handle */
    const asProvider = handle=>{
        const object = handles.get(handle >>> 0);
        return object && object.kind === 'provider' ? object : null;
    };

    /** @param {number} handle */
    const asHash = handle=>{
        const object = handles.get(handle >>> 0);
        return object && object.kind === 'hash' ? object : null;
    };

    /** @param {number} handle */
    const asKey = handle=>{
        const object = handles.get(handle >>> 0);
        return object && object.kind === 'key' ? object : null;
    };

    /** @param {number} pointer @param {number} max @returns {string | null} */
    const readAnsi = (pointer, max)=>((pointer >>> 0) === 0
        ? null
        : host.readCString(pointer >>> 0, max));

    /** @param {number} pointer @param {number} max @returns {string | null} */
    const readWide = (pointer, max)=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        let text = '';
        for (let at = 0; at < max; at++)
        {
            const pair = host.readMemory((pointer >>> 0) + at * 2, 2);
            const code = pair[0] | (pair[1] << 8);
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };

    /**
     * Fills a caller buffer, honouring the size-query convention: a NULL
     * buffer reports the length, a short one reports ERROR_MORE_DATA.
     *
     * @param {number} buffer @param {number} sizePointer
     * @param {Uint8Array} data @returns {number} 1 on success, 0 on failure
     */
    const copyOut = (buffer, sizePointer, data)=>{
        if (sizePointer === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const room = readDword(sizePointer);
        if ((buffer >>> 0) === 0)
        {
            writeDword(sizePointer, data.length);
            return 1;
        }
        if (room < data.length)
        {
            writeDword(sizePointer, data.length);
            return fail(ERROR_MORE_DATA);
        }
        host.writeMemory(buffer >>> 0, data);
        writeDword(sizePointer, data.length);
        return 1;
    };

    /** @param {number} value */
    const dwordBytes = value=>{
        const bytes = new Uint8Array(4);
        writeU32LE(bytes, 0, value >>> 0);
        return bytes;
    };

    /**
     * A key container's descriptor, self-relative, with the parts asked for:
     * the system and the administrators own it, as a machine's are owned.
     *
     * @param {number} wanted @returns {Uint8Array}
     */
    const containerDescriptor = wanted=>{
        const administrators = new Uint8Array([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0]);
        const parts = [(wanted & 1) !== 0 ? administrators : null,
            (wanted & 2) !== 0 ? administrators : null];
        const out = new Uint8Array(20 + parts.reduce((sum, part)=>sum + (part?.length ?? 0), 0));
        out[0] = 1;
        out[3] = 0x80;
        let at = 20;
        parts.forEach((part, index)=>{
            if (part)
            {
                writeU32LE(out, 4 + index * 4, at);
                out.set(part, at);
                at += part.length;
            }
        });
        return out;
    };

    /** @param {number} bytes */
    const randomBytes = bytes=>{
        const out = new Uint8Array(bytes);
        // getRandomValues caps a single call at 64 KiB; fill in slices.
        for (let at = 0; at < bytes; at += 65536)
        {
            crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, bytes)));
        }
        return out;
    };

    /**
     * Finalises a hash and caches its value; reading the value is what
     * finalises it, and hashing afterwards is refused.
     *
     * @param {HashObject} hash @returns {Uint8Array}
     */
    const hashValue = hash=>{
        if (hash.value === null)
        {
            hash.value = hash.digest.digest();
        }
        return hash.value;
    };

    /** @param {number} algid @returns {'data' | 'signature' | 'keyexchange' | null} */
    const keyRole = algid=>{
        switch (algid & ALG_CLASS_MASK){
            case ALG_CLASS_DATA_ENCRYPT:
                return 'data';
            case ALG_CLASS_SIGNATURE:
                return 'signature';
            case ALG_CLASS_KEY_EXCHANGE:
                return 'keyexchange';
            default:
                return null;
        }
    };

    /** @param {number} algid @param {number} flags @returns {number} key length in bytes */
    const keyLengthOf = (algid, flags)=>{
        const bits = (flags >>> 16) & 0xffff;
        if (bits !== 0)
        {
            return bits >>> 3;
        }
        return algid === CALG_RC4 ? DEFAULT_RC4_BITS >>> 3 : 0;
    };

    /**
     * Builds a session key object and its cipher state. The owning provider
     * handle is filled in once the key is allocated.
     *
     * @param {number} algid @param {Uint8Array} value @param {boolean} exportable
     * @returns {KeyObject}
     */
    const sessionKey = (algid, value, exportable)=>({
        kind: 'key', prov: 0, algid, role: 'data', keyLen: value.length,
        value, exportable, rsa: null,
        stream: algid === CALG_RC4 ? createRc4(value) : null,
    });

    /** @param {ProviderObject} prov @param {CryptoObject} child @returns {number} */
    const track = (prov, child)=>{
        const handle = alloc(child);
        prov.children.add(handle);
        return handle;
    };

    /**
     * Derives key material from a hash value, padding it out with the
     * 0x36 / 0x5C blocks when the hash is shorter than the key.
     *
     * @param {HashObject} hash @param {number} keyBytes
     * @returns {Uint8Array}
     */
    const deriveMaterial = (hash, keyBytes)=>{
        const value = hashValue(hash);
        if (value.length >= keyBytes)
        {
            return value.slice(0, keyBytes);
        }
        const material = new Uint8Array(value.length * 2);
        let at = 0;
        for (const padChar of [0x36, 0x5c])
        {
            const padded = new Uint8Array(64);
            for (let i = 0; i < 64; i++)
            {
                padded[i] = padChar ^ (i < value.length ? value[i] : 0);
            }
            const fresh = createDigest(hash.algid);
            if (!fresh)
            {
                return material.slice(0, keyBytes);
            }
            fresh.update(padded);
            material.set(fresh.digest(), at);
            at += value.length;
        }
        return material.slice(0, keyBytes);
    };

    /**
     * Lays out a PKCS#1 v1.5 encoded message: 00 01 <0xff pad> 00 [OID] <hash>.
     *
     * @param {number} length @param {number} algid
     * @param {Uint8Array} value @param {boolean} noOid
     * @returns {Uint8Array | null} null when the algorithm has no OID and one is wanted
     */
    const encodeEm = (length, algid, value, noOid)=>{
        const oid = noOid ? [] : (DIGEST_INFO.get(algid) ?? null);
        if (oid === null)
        {
            return null;
        }
        const tLen = oid.length + value.length;
        if (length < tLen + 11)
        {
            return null;
        }
        const em = new Uint8Array(length);
        em[0] = 0;
        em[1] = 1;
        let at = 2;
        while (at < length - tLen - 1)
        {
            em[at++] = 0xff;
        }
        em[at++] = 0;
        for (const byte of oid)
        {
            em[at++] = byte;
        }
        em.set(value, at);
        return em;
    };

    /**
     * BOOL CryptAcquireContextA/W(PHCRYPTPROV phProv, LPCSTR pszContainer,
     *   LPCSTR pszProvider, DWORD dwProvType, DWORD dwFlags)
     *
     * The installer dance: acquire, and on NTE_BAD_KEYSET acquire again with
     * CRYPT_NEWKEYSET. Both answers have to be right, so an unknown container
     * fails without the flag and is created with it.
     *
     * @param {string | null} container @param {number} provType
     * @param {number} flags @param {number} out
     */
    const registry = host.hive ? createProviderRegistry({
        readMemory: host.readMemory, writeMemory: host.writeMemory,
        readCString: host.readCString, setLastError: host.setLastError, hive: host.hive,
    }) : null;

    /**
     * CryptAcquireContext's body: the provider named -- or the type's default
     * -- of that type, and its container.
     *
     * @param {string | null} container @param {string | null} providerName
     * @param {number} provType @param {number} flags @param {number} out
     */
    const acquire = (container, providerName, provType, flags, out)=>{
        if (provType === 0 || provType > 999)
        {
            return fail(NTE_BAD_PROV_TYPE);
        }
        let name = providerName ?? '';
        if (registry)
        {
            if (name === '')
            {
                const fallback = registry.defaultOf(provType, true);
                if (fallback === null)
                {
                    return fail(NTE_PROV_TYPE_NOT_DEF);
                }
                name = fallback;
            }
            const provider = registry.providerNamed(name);
            if (provider === null)
            {
                return fail(NTE_KEYSET_NOT_DEF);
            }
            if (provider.type !== provType)
            {
                return fail(NTE_PROV_TYPE_NO_MATCH);
            }
            name = provider.name;
        }
        if ((out >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const verify = (flags & CRYPT_VERIFYCONTEXT) !== 0;
        // A machine's containers are not the user's.
        const keyset = `${(flags & CRYPT_MACHINE_KEYSET) !== 0 ? 'machine' : 'user'}:${
            container || 'DefaultKeyContainer'}`;
        if (!verify)
        {
            if ((flags & CRYPT_DELETEKEYSET) !== 0)
            {
                if (!containers.delete(keyset))
                {
                    return fail(NTE_BAD_KEYSET);
                }
                writeDword(out, 0);
                return 1;
            }
            if ((flags & CRYPT_NEWKEYSET) !== 0)
            {
                if (containers.has(keyset))
                {
                    return fail(NTE_EXISTS);
                }
                containers.add(keyset);
            }
            else if (!containers.has(keyset))
            {
                return fail(NTE_BAD_KEYSET);
            }
        }
        writeDword(out, alloc({ kind: 'provider', type: provType, container: keyset,
            verify, children: new Set(), name, refs: 1 }));
        host.setLastError?.(0);
        return 1;
    };

    /**
     * CryptSignHashA and CryptSignHashW. Signing needs a private key, which
     * an installer verifying its media does not carry and this provider does
     * not hold. It fails the way a caller with only a public key fails,
     * rather than inventing a signature that would not verify anywhere.
     *
     * @param {string} name
     */
    const signHash = name=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [hashHandle])=>{
            if (!asHash(hashHandle))
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            host.divergence?.(name, 'no private key is held here, so nothing can be signed');
            return fail(NTE_BAD_KEY);
        },
    });

    /**
     * CryptVerifySignatureA and CryptVerifySignatureW: a real RSA PKCS#1
     * v1.5 verification -- the signature raised to the public exponent over
     * the modulus, the recovered DigestInfo compared with the hash's own.
     */
    const verifySignature = {
        argBytes: 24,
        /** @param {number[]} args */
        handler: ([hashHandle, signature, sigLen, pubKeyHandle, , flags])=>{
            const hash = asHash(hashHandle);
            const pub = asKey(pubKeyHandle);
            if (!hash)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if (!pub)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if (!pub.rsa)
            {
                return fail(NTE_BAD_KEY);
            }
            const dwFlags = flags >>> 0;
            if ((dwFlags & ~(CRYPT_NOHASHOID | CRYPT_X931_FORMAT)) !== 0)
            {
                return fail(NTE_BAD_FLAGS);
            }
            const len = sigLen >>> 0;
            if (len !== pub.keyLen)
            {
                return fail(NTE_BAD_SIGNATURE);
            }
            if ((signature >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const value = hashValue(hash);
            const recovered = bigIntToBe(modPow(leToBigInt(readBytes(signature, len)),
                pub.rsa.e, pub.rsa.n), len);
            /** @param {boolean} noOid */
            const matches = noOid=>{
                const em = encodeEm(len, hash.algid, value, noOid);
                return em !== null && em.every((byte, at)=>byte === recovered[at]);
            };
            if (matches(false) || ((dwFlags & CRYPT_NOHASHOID) === 0 && matches(true)))
            {
                return 1;
            }
            return fail(NTE_BAD_SIGNATURE);
        },
    };

    return {
        CryptAcquireContextA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, container, provider, provType, flags])=>
                acquire(readAnsi(container, 512), readAnsi(provider, 512), provType >>> 0,
                    flags >>> 0, out),
        },

        CryptAcquireContextW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, container, provider, provType, flags])=>
                acquire(readWide(container, 512), readWide(provider, 512), provType >>> 0,
                    flags >>> 0, out),
        },

        /**
         * BOOL CryptReleaseContext(HCRYPTPROV hProv, DWORD dwFlags)
         *
         * One reference let go; the last takes the provider's hashes and keys
         * with it. Flags are refused -- after the reference is let go, as
         * Windows does.
         */
        CryptReleaseContext: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, flags])=>{
                const prov = asProvider(handle);
                if (!prov)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                prov.refs--;
                if (prov.refs <= 0)
                {
                    // Live hashes and keys die with their provider.
                    for (const child of prov.children)
                    {
                        handles.delete(child);
                    }
                    handles.delete(handle >>> 0);
                }
                return (flags >>> 0) === 0 ? 1 : fail(NTE_BAD_FLAGS);
            },
        },

        /** BOOL CryptContextAddRef(HCRYPTPROV hProv, DWORD *pdwReserved, DWORD dwFlags) */
        CryptContextAddRef: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, reserved, flags])=>{
                const prov = asProvider(handle);
                if (!prov || (reserved >>> 0) !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(NTE_BAD_FLAGS);
                }
                prov.refs++;
                return 1;
            },
        },

        ...registry?.functions ?? {},

        /**
         * BOOL CryptGetProvParam(HCRYPTPROV hProv, DWORD dwParam, BYTE *pbData,
         *   DWORD *pdwDataLen, DWORD dwFlags)
         *
         * The provider's name, type, version and implementation, its
         * container's name, the algorithms one by one (CRYPT_FIRST starts
         * over), and the container's descriptor -- which a size query answers
         * TRUE with ERROR_INSUFFICIENT_BUFFER set, as Windows' does.
         */
        CryptGetProvParam: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([provHandle, param, buffer, size, flags])=>{
                const prov = asProvider(provHandle);
                if (!prov)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((size >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const text = (/** @type {string} */ words)=>
                    new Uint8Array([...words].map(c=>c.charCodeAt(0) & 0xff).concat(0));
                const container = prov.container.slice(prov.container.indexOf(':') + 1);
                switch (param >>> 0)
                {
                    case PP_NAME:
                        return copyOut(buffer, size, text(prov.name));
                    case PP_CONTAINER:
                    case PP_UNIQUE_CONTAINER:
                        return copyOut(buffer, size, text(container));
                    case PP_IMPTYPE:
                        return copyOut(buffer, size, dwordBytes(CRYPT_IMPL_SOFTWARE));
                    case PP_VERSION:
                        return copyOut(buffer, size, dwordBytes(PROVIDER_VERSION));
                    case PP_PROVTYPE:
                        return copyOut(buffer, size, dwordBytes(prov.type));
                    case PP_KEYSPEC:
                        return copyOut(buffer, size, dwordBytes(AT_KEYEXCHANGE | AT_SIGNATURE));
                    case PP_KEYSET_TYPE:
                        return copyOut(buffer, size, dwordBytes(
                            prov.container.startsWith('machine:') ? CRYPT_MACHINE_KEYSET : 0));
                    case PP_ENUMALGS:
                    case PP_ENUMALGS_EX:
                    {
                        const at = ((flags >>> 0) & CRYPT_FIRST) !== 0 ? 0 : prov.enumAt ?? 0;
                        const entry = ALGORITHMS[at];
                        if (!entry)
                        {
                            return fail(ERROR_NO_MORE_ITEMS);
                        }
                        const [algid, bits, min, max, name] = /** @type {[number, number, number,
                            number, string]} */ (entry);
                        const ex = (param >>> 0) === PP_ENUMALGS_EX;
                        const out = new Uint8Array(ex ? 4 + 4 * 3 + 4 + 20 + 4 + 40 : 32);
                        const view = new DataView(out.buffer);
                        view.setUint32(0, algid, true);
                        view.setUint32(4, bits, true);
                        if (ex)
                        {
                            view.setUint32(8, min, true);
                            view.setUint32(12, max, true);
                            view.setUint32(20, name.length + 1, true);
                            out.set(text(name), 24);
                            view.setUint32(44, name.length + 1, true);
                            out.set(text(name), 48);
                        }
                        else
                        {
                            view.setUint32(8, name.length + 1, true);
                            out.set(text(name), 12);
                        }
                        const done = copyOut(buffer, size, out);
                        if (done && (buffer >>> 0) !== 0)
                        {
                            prov.enumAt = at + 1;
                        }
                        return done;
                    }
                    case PP_ENUMCONTAINERS:
                    {
                        const prefix = prov.container.slice(0, prov.container.indexOf(':') + 1);
                        const names = [...containers].filter(name=>name.startsWith(prefix))
                            .map(name=>name.slice(prefix.length));
                        const at = ((flags >>> 0) & CRYPT_FIRST) !== 0 ? 0
                            : prov.containerAt ?? 0;
                        if (at >= names.length)
                        {
                            return fail(ERROR_NO_MORE_ITEMS);
                        }
                        const done = copyOut(buffer, size, text(names[at]));
                        if (done && (buffer >>> 0) !== 0)
                        {
                            prov.containerAt = at + 1;
                        }
                        return done;
                    }
                    case PP_KEYSET_SEC_DESCR:
                    {
                        const descriptor = containerDescriptor(flags >>> 0);
                        if ((buffer >>> 0) === 0)
                        {
                            writeDword(size, descriptor.length);
                            host.setLastError?.(ERROR_INSUFFICIENT_BUFFER);
                            return 1;
                        }
                        return copyOut(buffer, size, descriptor);
                    }
                    default:
                        return fail(NTE_BAD_TYPE);
                }
            },
        },

        /**
         * BOOL CryptSetProvParam(HCRYPTPROV hProv, DWORD dwParam, const BYTE *pbData,
         *   DWORD dwFlags)
         *
         * The container's descriptor is taken -- nobody else shares the
         * container to be kept out -- and anything else is not a parameter
         * that can be set.
         */
        CryptSetProvParam: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([provHandle, param, data])=>{
                if (!asProvider(provHandle))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((data >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                return (param >>> 0) === PP_KEYSET_SEC_DESCR ? 1 : fail(NTE_BAD_TYPE);
            },
        },

        /**
         * BOOL CryptGetKeyParam(HCRYPTKEY hKey, DWORD dwParam, BYTE *pbData,
         *   DWORD *pdwDataLen, DWORD dwFlags)
         *
         * A key's algorithm, length in bits, block length (none for a stream
         * cipher), permissions -- export among them only for an exportable
         * key -- salt, and the mode, padding and IV a block cipher would use.
         */
        CryptGetKeyParam: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([keyHandle, param, buffer, size, flags])=>{
                const key = asKey(keyHandle);
                if (!key)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(NTE_BAD_FLAGS);
                }
                if ((size >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const stream = key.stream !== null || key.rsa !== null;
                switch (param >>> 0)
                {
                    case KP_ALGID:
                        return copyOut(buffer, size, dwordBytes(key.algid));
                    case KP_KEYLEN:
                    case KP_EFFECTIVE_KEYLEN:
                        return copyOut(buffer, size, dwordBytes(key.keyLen * 8));
                    case KP_BLOCKLEN:
                        return copyOut(buffer, size, dwordBytes(0));
                    case KP_PERMISSIONS:
                        return copyOut(buffer, size, dwordBytes(key.permissions
                            ?? (KEY_PERMISSIONS | (key.exportable ? CRYPT_EXPORT : 0))));
                    case KP_SALT:
                        return copyOut(buffer, size, key.salt ?? new Uint8Array(0));
                    case KP_MODE:
                    case KP_MODE_BITS:
                    case KP_PADDING:
                    case KP_IV:
                        return stream ? fail(NTE_BAD_TYPE) : copyOut(buffer, size, dwordBytes(0));
                    default:
                        return fail(NTE_BAD_TYPE);
                }
            },
        },

        /**
         * BOOL CryptSetKeyParam(HCRYPTKEY hKey, DWORD dwParam, const BYTE *pbData,
         *   DWORD dwFlags)
         *
         * The salt and the permissions are a key's own; a stream cipher has no
         * mode, padding or IV to set.
         */
        CryptSetKeyParam: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([keyHandle, param, data, flags])=>{
                const key = asKey(keyHandle);
                if (!key)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((data >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(NTE_BAD_FLAGS);
                }
                switch (param >>> 0)
                {
                    case KP_PERMISSIONS:
                        key.permissions = readDword(data);
                        return 1;
                    case KP_SALT:
                        key.salt = readBytes(data, 11);
                        return 1;
                    case KP_SALT_EX:
                        // CRYPT_DATA_BLOB: the size, then the bytes' pointer.
                        key.salt = readBytes(readDword(data + 4), readDword(data));
                        return 1;
                    default:
                        return fail(NTE_BAD_TYPE);
                }
            },
        },

        /**
         * BOOL CryptDuplicateKey(HCRYPTKEY hKey, DWORD *pdwReserved, DWORD dwFlags,
         *   HCRYPTKEY *phKey)
         *
         * A second key of the same material, its own cipher state from here on.
         */
        CryptDuplicateKey: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([keyHandle, reserved, flags, out])=>{
                const key = asKey(keyHandle);
                if (!key)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((reserved >>> 0) !== 0 || (out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(NTE_BAD_FLAGS);
                }
                const prov = asProvider(key.prov);
                // The duplicate's cipher starts over from the key, as a key
                // just made does.
                const copy = { ...key, stream: key.stream ? createRc4(key.value) : null };
                writeDword(out, prov ? track(prov, copy) : alloc(copy));
                return 1;
            },
        },

        /**
         * BOOL CryptHashSessionKey(HCRYPTHASH hHash, HCRYPTKEY hKey, DWORD dwFlags)
         *
         * The session key's material hashed in, as CryptHashData would hash it.
         */
        CryptHashSessionKey: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hashHandle, keyHandle, flags])=>{
                const hash = asHash(hashHandle);
                if (!hash)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const key = asKey(keyHandle);
                if (!key)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (key.rsa !== null)
                {
                    return fail(NTE_BAD_KEY);
                }
                if (((flags >>> 0) & ~1) !== 0)
                {
                    return fail(NTE_BAD_FLAGS);
                }
                if (hash.value !== null)
                {
                    return fail(NTE_BAD_HASH_STATE);
                }
                // CRYPT_LITTLE_ENDIAN hashes the bytes as they are; without it
                // the provider hashes them reversed.
                hash.digest.update((flags >>> 0) === 1 ? key.value : key.value.slice().reverse());
                return 1;
            },
        },

        /**
         * BOOL CryptCreateHash(HCRYPTPROV hProv, ALG_ID Algid, HCRYPTKEY hKey,
         *   DWORD dwFlags, HCRYPTHASH *phHash)
         *
         * A keyed hash (hKey non-zero, an HMAC) is not built here; a plain
         * digest is, which is what an installer hashes its media with.
         */
        CryptCreateHash: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([provHandle, algid, key, , out])=>{
                const prov = asProvider(provHandle);
                if (!prov)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const digest = createDigest(algid >>> 0);
                const size = HASH_SIZE.get(algid >>> 0);
                if (!digest || size === undefined)
                {
                    return fail(NTE_BAD_ALGID);
                }
                if ((key >>> 0) !== 0)
                {
                    host.divergence?.('CryptCreateHash',
                        `${(algid >>> 0).toString(16)}: keyed hash (HMAC) is not built`);
                    return fail(NTE_BAD_KEY);
                }
                writeDword(out, track(prov, { kind: 'hash', prov: provHandle >>> 0,
                    algid: algid >>> 0, digest, size, value: null }));
                return 1;
            },
        },

        /** BOOL CryptHashData(HCRYPTHASH hHash, const BYTE *pbData, DWORD len, DWORD flags) */
        CryptHashData: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hashHandle, data, length, flags])=>{
                const hash = asHash(hashHandle);
                if (!hash)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(NTE_BAD_FLAGS);
                }
                if (hash.value !== null)
                {
                    return fail(NTE_BAD_HASH_STATE);
                }
                const len = length >>> 0;
                if (len > 0)
                {
                    hash.digest.update(readBytes(data, len));
                }
                return 1;
            },
        },

        /**
         * BOOL CryptGetHashParam(HCRYPTHASH hHash, DWORD dwParam, BYTE *pbData,
         *   DWORD *pdwDataLen, DWORD dwFlags)
         */
        CryptGetHashParam: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([hashHandle, param, data, sizePointer, flags])=>{
                const hash = asHash(hashHandle);
                if (!hash)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0 || sizePointer === 0)
                {
                    return fail((flags >>> 0) !== 0 ? NTE_BAD_FLAGS : ERROR_INVALID_PARAMETER);
                }
                switch (param >>> 0){
                    case HP_ALGID:
                    {
                        const bytes = new Uint8Array(4);
                        writeU32LE(bytes, 0, hash.algid);
                        return copyOut(data, sizePointer, bytes);
                    }
                    case HP_HASHSIZE:
                    {
                        const bytes = new Uint8Array(4);
                        writeU32LE(bytes, 0, hash.size);
                        return copyOut(data, sizePointer, bytes);
                    }
                    case HP_HASHVAL:
                        return copyOut(data, sizePointer, hashValue(hash));
                    default:
                        return fail(NTE_BAD_TYPE);
                }
            },
        },

        /**
         * BOOL CryptSetHashParam(HCRYPTHASH hHash, DWORD dwParam,
         *   const BYTE *pbData, DWORD dwFlags)
         *
         * Only HP_HASHVAL is meaningful: it loads a hash value computed
         * elsewhere, which finalises the hash exactly as reading one does.
         */
        CryptSetHashParam: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hashHandle, param, data, flags])=>{
                const hash = asHash(hashHandle);
                if (!hash)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0)
                {
                    return fail(NTE_BAD_FLAGS);
                }
                if ((param >>> 0) !== HP_HASHVAL)
                {
                    return fail(NTE_BAD_TYPE);
                }
                if (hash.value !== null)
                {
                    return fail(NTE_BAD_HASH_STATE);
                }
                hash.value = readBytes(data, hash.size);
                return 1;
            },
        },

        /** BOOL CryptDestroyHash(HCRYPTHASH hHash) */
        CryptDestroyHash: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hashHandle])=>{
                const hash = asHash(hashHandle);
                if (!hash)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                handles.delete(hashHandle >>> 0);
                asProvider(hash.prov)?.children.delete(hashHandle >>> 0);
                return 1;
            },
        },

        /**
         * BOOL CryptDuplicateHash(HCRYPTHASH hHash, DWORD *pdwReserved,
         *   DWORD dwFlags, HCRYPTHASH *phHash)
         */
        CryptDuplicateHash: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([hashHandle, , flags, out])=>{
                const hash = asHash(hashHandle);
                const prov = hash ? asProvider(hash.prov) : null;
                if (!hash || !prov)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags >>> 0) !== 0 || (out >>> 0) === 0)
                {
                    return fail((flags >>> 0) !== 0 ? NTE_BAD_FLAGS : ERROR_INVALID_PARAMETER);
                }
                writeDword(out, track(prov, { kind: 'hash', prov: hash.prov,
                    algid: hash.algid, digest: hash.digest.clone(), size: hash.size,
                    value: hash.value ? hash.value.slice() : null }));
                return 1;
            },
        },

        /**
         * BOOL CryptDeriveKey(HCRYPTPROV hProv, ALG_ID Algid, HCRYPTHASH hBaseData,
         *   DWORD dwFlags, HCRYPTKEY *phKey)
         */
        CryptDeriveKey: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([provHandle, algid, hashHandle, flags, out])=>{
                const prov = asProvider(provHandle);
                const hash = asHash(hashHandle);
                if (!prov)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (!hash)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const id = algid >>> 0;
                if ((id & ALG_CLASS_MASK) !== ALG_CLASS_DATA_ENCRYPT)
                {
                    return fail(NTE_BAD_ALGID);
                }
                const keyBytes = keyLengthOf(id, flags >>> 0);
                if (keyBytes === 0 || keyBytes > MAX_KEY_BYTES || keyBytes > 2 * hash.size)
                {
                    return fail(NTE_BAD_FLAGS);
                }
                const key = sessionKey(id, deriveMaterial(hash, keyBytes),
                    (flags >>> 0 & CRYPT_EXPORTABLE) !== 0);
                const handle = track(prov, key);
                key.prov = provHandle >>> 0;
                writeDword(out, handle);
                return 1;
            },
        },

        /**
         * BOOL CryptGenKey(HCRYPTPROV hProv, ALG_ID Algid, DWORD dwFlags,
         *   HCRYPTKEY *phKey)
         *
         * A random session key. An RSA key pair is not generated: there is no
         * prime search here, and an installer verifies with a public key it
         * carries rather than making one, so the gap is reported, not faked.
         */
        CryptGenKey: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([provHandle, algid, flags, out])=>{
                const prov = asProvider(provHandle);
                if (!prov)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const id = algid >>> 0;
                if ((id & ALG_CLASS_MASK) !== ALG_CLASS_DATA_ENCRYPT)
                {
                    host.divergence?.('CryptGenKey',
                        `${id.toString(16)}: only session keys are generated here`);
                    return fail(NTE_FAIL);
                }
                if (id !== CALG_RC4)
                {
                    host.divergence?.('CryptGenKey',
                        `${id.toString(16)}: no cipher for this algorithm here`);
                    return fail(NTE_BAD_ALGID);
                }
                const keyBytes = keyLengthOf(id, flags >>> 0) || (DEFAULT_RC4_BITS >>> 3);
                const key = sessionKey(id, randomBytes(keyBytes),
                    (flags >>> 0 & CRYPT_EXPORTABLE) !== 0);
                const handle = track(prov, key);
                key.prov = provHandle >>> 0;
                writeDword(out, handle);
                return 1;
            },
        },

        /**
         * BOOL CryptGetUserKey(HCRYPTPROV hProv, DWORD dwKeySpec, HCRYPTKEY *phUserKey)
         *
         * The container's key pair of that kind. No container here holds one
         * -- no pair is ever generated (CryptGenKey) -- so it is NTE_NO_KEY,
         * as a fresh container answers on Windows.
         */
        CryptGetUserKey: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([provHandle, spec, out])=>{
                if (!asProvider(provHandle))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((spec >>> 0) !== AT_KEYEXCHANGE && (spec >>> 0) !== AT_SIGNATURE)
                {
                    return fail(NTE_BAD_KEY);
                }
                return fail(NTE_NO_KEY);
            },
        },

        /** BOOL CryptDestroyKey(HCRYPTKEY hKey) */
        CryptDestroyKey: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([keyHandle])=>{
                const key = asKey(keyHandle);
                if (!key)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                handles.delete(keyHandle >>> 0);
                asProvider(key.prov)?.children.delete(keyHandle >>> 0);
                return 1;
            },
        },

        /**
         * BOOL CryptEncrypt(HCRYPTKEY hKey, HCRYPTHASH hHash, BOOL Final,
         *   DWORD dwFlags, BYTE *pbData, DWORD *pdwDataLen, DWORD dwBufLen)
         *
         * RC4 is a stream cipher, so the output is the length of the input and
         * a final call adds nothing; it resets the keystream so the key can be
         * reused, which is what Windows does.
         */
        CryptEncrypt: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([keyHandle, hashHandle, final, , data, sizePointer, bufLen])=>{
                const key = asKey(keyHandle);
                if (!key)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (!key.stream)
                {
                    host.divergence?.('CryptEncrypt',
                        `${key.algid.toString(16)}: no cipher for this algorithm here`);
                    return fail(NTE_BAD_ALGID);
                }
                if (sizePointer === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const len = readDword(sizePointer);
                if ((bufLen >>> 0) < len)
                {
                    writeDword(sizePointer, len);
                    return fail(ERROR_MORE_DATA);
                }
                if ((hashHandle >>> 0) !== 0)
                {
                    const hash = asHash(hashHandle);
                    if (!hash)
                    {
                        return fail(ERROR_INVALID_PARAMETER);
                    }
                    if (hash.value !== null)
                    {
                        return fail(NTE_BAD_HASH_STATE);
                    }
                    if (len > 0)
                    {
                        hash.digest.update(readBytes(data, len));
                    }
                }
                if (len > 0)
                {
                    host.writeMemory(data >>> 0, key.stream.transform(readBytes(data, len)));
                }
                writeDword(sizePointer, len);
                if ((final >>> 0) !== 0)
                {
                    key.stream.reset();
                }
                return 1;
            },
        },

        /**
         * BOOL CryptDecrypt(HCRYPTKEY hKey, HCRYPTHASH hHash, BOOL Final,
         *   DWORD dwFlags, BYTE *pbData, DWORD *pdwDataLen)
         */
        CryptDecrypt: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([keyHandle, hashHandle, final, , data, sizePointer])=>{
                const key = asKey(keyHandle);
                if (!key)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (!key.stream)
                {
                    host.divergence?.('CryptDecrypt',
                        `${key.algid.toString(16)}: no cipher for this algorithm here`);
                    return fail(NTE_BAD_ALGID);
                }
                if (sizePointer === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const len = readDword(sizePointer);
                // A final block of nothing is a length error: there is no
                // padding to take off an empty buffer.
                if (len === 0 && (final >>> 0) !== 0)
                {
                    return fail(NTE_BAD_LEN);
                }
                if (len > 0)
                {
                    const plain = key.stream.transform(readBytes(data, len));
                    host.writeMemory(data >>> 0, plain);
                    if ((hashHandle >>> 0) !== 0)
                    {
                        const hash = asHash(hashHandle);
                        if (!hash)
                        {
                            return fail(ERROR_INVALID_PARAMETER);
                        }
                        if (hash.value !== null)
                        {
                            return fail(NTE_BAD_HASH_STATE);
                        }
                        hash.digest.update(plain);
                    }
                }
                writeDword(sizePointer, len);
                if ((final >>> 0) !== 0)
                {
                    key.stream.reset();
                }
                return 1;
            },
        },

        /**
         * BOOLEAN SystemFunction036(PVOID RandomBuffer, ULONG RandomBufferLength)
         *
         * RtlGenRandom, the generator under CryptGenRandom, which a C runtime's
         * rand_s looks up by this name: the buffer filled from the same source.
         */
        SystemFunction036: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, length])=>{
                const len = length >>> 0;
                if (len === 0)
                {
                    return 1;
                }
                // The whole range is checked before a byte is drawn: a length
                // the buffer does not have fails at once, rather than after
                // drawing gigabytes for nowhere.
                if ((buffer >>> 0) === 0 || host.canWrite?.(buffer >>> 0, len) === false)
                {
                    host.setLastError?.(ERROR_NOACCESS);
                    return 0;
                }
                host.writeMemory(buffer >>> 0, randomBytes(len));
                return 1;
            },
        },

        /** BOOL CryptGenRandom(HCRYPTPROV hProv, DWORD dwLen, BYTE *pbBuffer) */
        CryptGenRandom: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([provHandle, length, buffer])=>{
                if (!asProvider(provHandle))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const len = length >>> 0;
                if (len === 0 || (buffer >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                host.writeMemory(buffer >>> 0, randomBytes(len));
                return 1;
            },
        },

        /**
         * BOOL CryptImportKey(HCRYPTPROV hProv, const BYTE *pbData, DWORD dwDataLen,
         *   HCRYPTKEY hPubKey, DWORD dwFlags, HCRYPTKEY *phKey)
         *
         * A public-key blob is parsed and stored for a later verification; a
         * plaintext session-key blob is loaded as a key. A simple blob was
         * wrapped for a private key this provider does not hold, so it fails
         * the way an unwrappable key does rather than pretending to load it.
         */
        CryptImportKey: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([provHandle, data, dataLen, , flags, out])=>{
                const prov = asProvider(provHandle);
                if (!prov)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((out >>> 0) === 0 || (data >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const len = dataLen >>> 0;
                if (len < BLOBHEADER_SIZE)
                {
                    return fail(NTE_BAD_DATA);
                }
                const blob = readBytes(data, len);
                const type = blob[0];
                const version = blob[1];
                const aiKeyAlg = readU32LE(blob, 4);
                if (version !== CUR_BLOB_VERSION)
                {
                    return fail(NTE_BAD_VER);
                }
                if (type === PUBLICKEYBLOB)
                {
                    if (len < BLOBHEADER_SIZE + RSAPUBKEY_SIZE)
                    {
                        return fail(NTE_BAD_DATA);
                    }
                    const magic = readU32LE(blob, 8);
                    const bitlen = readU32LE(blob, 12);
                    const pubexp = readU32LE(blob, 16);
                    if (magic !== RSA1_MAGIC || (bitlen & 7) !== 0)
                    {
                        return fail(NTE_BAD_DATA);
                    }
                    const modBytes = bitlen >>> 3;
                    if (len < BLOBHEADER_SIZE + RSAPUBKEY_SIZE + modBytes)
                    {
                        return fail(NTE_BAD_DATA);
                    }
                    const modulus = blob.subarray(BLOBHEADER_SIZE + RSAPUBKEY_SIZE,
                        BLOBHEADER_SIZE + RSAPUBKEY_SIZE + modBytes);
                    const key = { kind: /** @type {const} */ ('key'), prov: 0,
                        algid: aiKeyAlg,
                        role: /** @type {'data' | 'signature' | 'keyexchange'} */
                        (keyRole(aiKeyAlg) ?? 'signature'),
                        keyLen: modBytes, value: new Uint8Array(0), exportable: true,
                        stream: null,
                        rsa: { n: leToBigInt(modulus), e: BigInt(pubexp), bitlen } };
                    const handle = track(prov, key);
                    key.prov = provHandle >>> 0;
                    writeDword(out, handle);
                    return 1;
                }
                if (type === PLAINTEXTKEYBLOB)
                {
                    if (len < BLOBHEADER_SIZE + 4)
                    {
                        return fail(NTE_BAD_DATA);
                    }
                    const keyBytes = readU32LE(blob, 8);
                    if (len < BLOBHEADER_SIZE + 4 + keyBytes || keyBytes > MAX_KEY_BYTES)
                    {
                        return fail(NTE_BAD_DATA);
                    }
                    const value = blob.slice(BLOBHEADER_SIZE + 4,
                        BLOBHEADER_SIZE + 4 + keyBytes);
                    const key = sessionKey(aiKeyAlg, value,
                        (flags >>> 0 & CRYPT_EXPORTABLE) !== 0);
                    const handle = track(prov, key);
                    key.prov = provHandle >>> 0;
                    writeDword(out, handle);
                    return 1;
                }
                if (type === SIMPLEBLOB)
                {
                    host.divergence?.('CryptImportKey',
                        'a simple blob is wrapped for a private key this provider lacks');
                    return fail(NTE_BAD_KEY);
                }
                if (type === PRIVATEKEYBLOB)
                {
                    // RSA2: the public modulus and exponent, then the private
                    // halves. The public part is kept so the key verifies a
                    // signature and exports its public blob; the private
                    // exponent is kept too, for signing.
                    if (len < BLOBHEADER_SIZE + RSAPUBKEY_SIZE)
                    {
                        return fail(NTE_BAD_DATA);
                    }
                    const magic = readU32LE(blob, 8);
                    const bitlen = readU32LE(blob, 12);
                    const pubexp = readU32LE(blob, 16);
                    const modBytes = bitlen >>> 3;
                    const RSA2_MAGIC = 0x32415352;
                    // header, pubkey, modulus, prime1, prime2, exp1, exp2,
                    // coefficient (each a half), then the private exponent.
                    const privAt = BLOBHEADER_SIZE + RSAPUBKEY_SIZE + modBytes + modBytes / 2 * 5;
                    if (magic !== RSA2_MAGIC || (bitlen & 15) !== 0
                        || len < privAt + modBytes)
                    {
                        return fail(NTE_BAD_DATA);
                    }
                    const at = BLOBHEADER_SIZE + RSAPUBKEY_SIZE;
                    const modulus = blob.subarray(at, at + modBytes);
                    const key = { kind: /** @type {const} */ ('key'), prov: 0, algid: aiKeyAlg,
                        role: /** @type {'data' | 'signature' | 'keyexchange'} */
                        (keyRole(aiKeyAlg) ?? 'signature'),
                        keyLen: modBytes, value: new Uint8Array(0),
                        exportable: (flags >>> 0 & CRYPT_EXPORTABLE) !== 0, stream: null,
                        rsa: { n: leToBigInt(modulus), e: BigInt(pubexp), bitlen,
                            d: leToBigInt(blob.subarray(privAt, privAt + modBytes)) } };
                    const handle = track(prov, key);
                    key.prov = provHandle >>> 0;
                    writeDword(out, handle);
                    return 1;
                }
                return fail(NTE_BAD_TYPE);
            },
        },

        /**
         * BOOL CryptExportKey(hKey, hExpKey, dwBlobType, dwFlags, pbData, pdwDataLen)
         *
         * A public key exports as its blob; a session key exports in the clear
         * when it is exportable, or wrapped as a simple blob under a public key
         * this provider holds.
         */
        CryptExportKey: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([keyHandle, expKeyHandle, blobType, , data, sizePointer])=>{
                const key = asKey(keyHandle);
                if (!key)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (sizePointer === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const type = blobType >>> 0;
                if (type === PUBLICKEYBLOB)
                {
                    if (!key.rsa)
                    {
                        return fail(NTE_BAD_KEY);
                    }
                    const modBytes = key.keyLen;
                    const whole = new Uint8Array(BLOBHEADER_SIZE + RSAPUBKEY_SIZE + modBytes);
                    whole[0] = PUBLICKEYBLOB;
                    whole[1] = CUR_BLOB_VERSION;
                    writeU32LE(whole, 4, key.algid);
                    writeU32LE(whole, 8, RSA1_MAGIC);
                    writeU32LE(whole, 12, key.rsa.bitlen);
                    writeU32LE(whole, 16, Number(key.rsa.e & 0xffffffffn));
                    whole.set(bigIntToLe(key.rsa.n, modBytes),
                        BLOBHEADER_SIZE + RSAPUBKEY_SIZE);
                    return copyOut(data, sizePointer, whole);
                }
                if (type === PLAINTEXTKEYBLOB)
                {
                    if (key.role !== 'data' || !key.exportable)
                    {
                        return fail(NTE_BAD_KEY);
                    }
                    const whole = new Uint8Array(BLOBHEADER_SIZE + 4 + key.keyLen);
                    whole[0] = PLAINTEXTKEYBLOB;
                    whole[1] = CUR_BLOB_VERSION;
                    writeU32LE(whole, 4, key.algid);
                    writeU32LE(whole, 8, key.keyLen);
                    whole.set(key.value, BLOBHEADER_SIZE + 4);
                    return copyOut(data, sizePointer, whole);
                }
                if (type === SIMPLEBLOB)
                {
                    const pub = asKey(expKeyHandle);
                    if (key.role !== 'data' || !pub || !pub.rsa)
                    {
                        return fail(NTE_BAD_KEY);
                    }
                    const modBytes = pub.keyLen;
                    // PKCS#1 v1.5 type 2: 00 02 <non-zero pad> 00 <key>.
                    const padLen = modBytes - key.keyLen - 3;
                    if (padLen < 8)
                    {
                        return fail(NTE_BAD_LEN);
                    }
                    const em = new Uint8Array(modBytes);
                    em[1] = 2;
                    const pad = randomBytes(padLen);
                    for (let i = 0; i < padLen; i++)
                    {
                        em[2 + i] = pad[i] === 0 ? 1 : pad[i];
                    }
                    em[2 + padLen] = 0;
                    em.set(key.value, 3 + padLen);
                    const cipher = bigIntToLe(
                        modPow(beToBigInt(em), pub.rsa.e, pub.rsa.n), modBytes);
                    const whole = new Uint8Array(BLOBHEADER_SIZE + 4 + modBytes);
                    whole[0] = SIMPLEBLOB;
                    whole[1] = CUR_BLOB_VERSION;
                    writeU32LE(whole, 4, key.algid);
                    writeU32LE(whole, 8, pub.algid);
                    whole.set(cipher, BLOBHEADER_SIZE + 4);
                    return copyOut(data, sizePointer, whole);
                }
                return fail(type === 0 ? ERROR_INVALID_PARAMETER : NTE_BAD_TYPE);
            },
        },

        /**
         * BOOL CryptSignHashA(hHash, dwKeySpec, sDescription, dwFlags,
         *   pbSignature, pdwSigLen)
         */
        CryptSignHashA: signHash('CryptSignHashA'),

        /**
         * BOOL CryptSignHashW(hHash, dwKeySpec, LPCWSTR szDescription, dwFlags,
         *   pbSignature, pdwSigLen)
         *
         * The A form's answer: the description, the only text, is ignored by
         * every provider since NT 4 and read by neither.
         */
        CryptSignHashW: signHash('CryptSignHashW'),

        /**
         * BOOL CryptVerifySignatureA(hHash, pbSignature, dwSigLen, hPubKey,
         *   sDescription, dwFlags)
         */
        CryptVerifySignatureA: verifySignature,

        /**
         * BOOL CryptVerifySignatureW(hHash, pbSignature, dwSigLen, hPubKey,
         *   LPCWSTR szDescription, dwFlags)
         *
         * The same verification: the description is not read.
         */
        CryptVerifySignatureW: verifySignature,
    };
}
