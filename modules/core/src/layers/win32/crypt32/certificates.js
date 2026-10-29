/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * crypt32's certificate stores, certificate contexts and chains: what a TLS
 * client that carries its own protocol (and leaves the question "do I trust
 * this server?" to Windows) calls once a handshake has handed it the server's
 * certificates. It puts them in a memory store, asks CertGetCertificateChain
 * for the chain from the server's certificate to a root, and reads the
 * chain's trust status or has CertVerifyCertificateChainPolicy judge it.
 *
 * A context is guest memory the program reads directly -- CERT_CONTEXT with
 * its CERT_INFO, the encoded bytes and every blob CERT_INFO points to, in one
 * LocalAlloc block -- so its layout is wincrypt.h's, field for field. Its
 * reference count and its store are kept here. A chain context is one block
 * too: CERT_CHAIN_CONTEXT, its one simple chain and the elements, each element
 * holding a reference to its certificate's context.
 *
 * The system store ROOT holds the machine's trusted roots (`trustedRoots`, the
 * ones WinVerifyTrust judges by); every other system store starts empty and
 * keeps what a program adds for the rest of the process. A chain is built
 * from the certificate's own store, the additional store the caller names,
 * and ROOT: an issuer is found by name and must have signed the certificate
 * below it. Nothing is fetched (no AIA, no CRL, no OCSP): revocation, when
 * asked, is unknown and offline, as on a machine that cannot reach the
 * certificates' distribution points.
 */

import { childrenOf, contents as contentsOf, DerError, encoding as encodingOf, expect,
    readBitString, readNode, readOid, TAG } from '../crypto/der.js';
import { createMd5, createSha1, createSha256 } from '../crypto/digest.js';
import { parseSignedData } from '../crypto/pkcs7.js';
import { verifySigned } from '../crypto/signature.js';
import { isSelfIssued, isSignedBy, parseCertificate, readGeneralNames, readName,
    rsaKeyFromBits, sameBytes, USAGE, TLS_USAGE } from '../crypto/x509.js';
import { readSubject } from '../wintrust/subject.js';
import { nameToString, NAME_STR } from './names.js';

/** @typedef {import('../crypto/x509.js').Certificate} Certificate */

const ERROR_INVALID_PARAMETER = 87;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const E_INVALIDARG = 0x80070057;
const CRYPT_E_NOT_FOUND = 0x80092004;
const CRYPT_E_EXISTS = 0x80092005;
const CRYPT_E_ASN1_BADTAG = 0x8009310b;
const ERROR_INVALID_HANDLE = 6;
const ERROR_MORE_DATA = 234;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const NTE_BAD_DATA = 0x80090005;
const NTE_BAD_SIGNATURE = 0x80090006;
const NTE_BAD_ALGID = 0x80090008;
const NTE_NOT_SUPPORTED = 0x80090029;
const CRYPT_E_NO_MATCH = 0x80092009;
const CRYPT_E_NO_KEY_PROPERTY = 0x8009200b;
const CRYPT_E_INVALID_MSG_TYPE = 0x80091004;
const CRYPT_E_INVALID_INDEX = 0x80091008;

/** Context properties, wincrypt.h's CERT_*_PROP_ID. */
export const PROP = Object.freeze({ KEY_PROV_INFO: 2, SHA1_HASH: 3, MD5_HASH: 4,
    FRIENDLY_NAME: 11, ACCESS_STATE: 14, KEY_IDENTIFIER: 20, SHA256_HASH: 107 });
const ACCESS_STATE_SYSTEM_STORE = 0x2;
/** CRYPT_KEY_PROV_INFO, 32-bit. */
const KEY_PROV_INFO_SIZE = 28;

/** CertGetNameString's types and flag. */
const NAME_TYPE = Object.freeze({ EMAIL: 1, RDN: 2, ATTR: 3, SIMPLE_DISPLAY: 4,
    FRIENDLY_DISPLAY: 5, DNS: 6, URL: 7 });
const CERT_NAME_ISSUER_FLAG = 0x1;

/** CertFindCertificateInStore: a find type is a comparison << 16 | the CERT_INFO field. */
const COMPARE = Object.freeze({ ANY: 0, SHA1_HASH: 1, NAME: 2, MD5_HASH: 4, PUBLIC_KEY: 6,
    NAME_STR_A: 7, NAME_STR_W: 8, ENHKEY_USAGE: 10, SUBJECT_CERT: 11, ISSUER_OF: 12,
    EXISTING: 13, KEY_IDENTIFIER: 15, HAS_PRIVATE_KEY: 21 });
const CERT_INFO_ISSUER_FLAG = 4;
const CERT_FIND_OR_ENHKEY_USAGE_FLAG = 0x10;
const CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG = 0x2;
const CERT_FIND_PROP_ONLY_ENHKEY_USAGE_FLAG = 0x4;

/** CertControlStore's controls. */
const STORE_CTRL = Object.freeze({ RESYNC: 1, NOTIFY_CHANGE: 2, COMMIT: 3, AUTO_RESYNC: 4,
    CANCEL_NOTIFY: 5 });

/** CryptQueryObject's objects, content types and formats (each flag is 1 << its number). */
const QUERY_OBJECT = Object.freeze({ FILE: 1, BLOB: 2 });
const CONTENT = Object.freeze({ CERT: 1, PKCS7_SIGNED: 8, PKCS7_SIGNED_EMBED: 10 });
const FORMAT = Object.freeze({ BINARY: 1, BASE64: 2 });
const PKCS_7_ASN_ENCODING = 0x10000;

/** CryptMsgGetParam's parameters, and the message type a SignedData is. */
const MSG_PARAM = Object.freeze({ TYPE: 1, CONTENT: 2, SIGNER_COUNT: 5, SIGNER_CERT_INFO: 7,
    CERT_COUNT: 11, CERT: 12 });
const CMSG_SIGNED = 2;

/** CryptVerifyCertificateSignatureEx's subject and issuer kinds. */
const VERIFY_SUBJECT = Object.freeze({ BLOB: 1, CERT: 2 });
const VERIFY_ISSUER = Object.freeze({ PUBKEY: 1, CERT: 2, CHAIN: 3 });

/** Chain engine and message handles, opaque and numbered apart from the stores'. */
const ENGINE_BASE = 0x5c800000;
const MESSAGE_BASE = 0x5c900000;

/** Trust policy errors, wincrypt.h's and winerror.h's numbers. */
const TRUST_E_CERT_SIGNATURE = 0x80096004;
const TRUST_E_BASIC_CONSTRAINTS = 0x80096019;
const CERT_E_EXPIRED = 0x800b0101;
const CERT_E_CRITICAL = 0x800b0105;
const CERT_E_UNTRUSTEDROOT = 0x800b0109;
const CERT_E_CHAINING = 0x800b010a;
const CERT_E_CN_NO_MATCH = 0x800b010f;
const CERT_E_WRONG_USAGE = 0x800b0110;
const CRYPT_E_REVOKED = 0x80092010;
const CRYPT_E_REVOCATION_OFFLINE = 0x80092013;

/** CERT_TRUST_STATUS error bits. */
export const TRUST_ERROR = Object.freeze({
    IS_NOT_TIME_VALID: 0x1,
    IS_REVOKED: 0x4,
    IS_NOT_SIGNATURE_VALID: 0x8,
    IS_NOT_VALID_FOR_USAGE: 0x10,
    IS_UNTRUSTED_ROOT: 0x20,
    REVOCATION_STATUS_UNKNOWN: 0x40,
    IS_CYCLIC: 0x80,
    INVALID_EXTENSION: 0x100,
    INVALID_BASIC_CONSTRAINTS: 0x400,
    IS_OFFLINE_REVOCATION: 0x1000000,
    IS_PARTIAL_CHAIN: 0x10000,
});

/** CERT_TRUST_STATUS information bits. */
export const TRUST_INFO = Object.freeze({
    HAS_NAME_MATCH_ISSUER: 0x4,
    IS_SELF_SIGNED: 0x8,
    HAS_PREFERRED_ISSUER: 0x100,
});

const X509_ASN_ENCODING = 0x1;

/** CertOpenStore's providers, by number (the names map onto these). */
const PROVIDER = Object.freeze({ MEMORY: 2, SYSTEM_A: 9, SYSTEM_W: 10, COLLECTION: 11,
    SYSTEM_REGISTRY_A: 12, SYSTEM_REGISTRY_W: 13 });
const PROVIDER_NAMES = new Map([['memory', PROVIDER.MEMORY], ['system', PROVIDER.SYSTEM_W],
    ['collection', PROVIDER.COLLECTION], ['systemregistry', PROVIDER.SYSTEM_REGISTRY_W]]);
const CERT_STORE_OPEN_EXISTING_FLAG = 0x4000;

/** CertAddCertificateContextToStore's dispositions. */
const ADD = Object.freeze({ NEW: 1, USE_EXISTING: 2, REPLACE_EXISTING: 3, ALWAYS: 4,
    REPLACE_EXISTING_INHERIT_PROPERTIES: 5, NEWER: 6, NEWER_INHERIT_PROPERTIES: 7 });

/** CertGetCertificateChain's revocation flags: any of them asks for a check. */
const REVOCATION_CHECK = Object.freeze({ END_CERT: 0x10000000, CHAIN: 0x20000000,
    CHAIN_EXCLUDE_ROOT: 0x40000000 });

/** Chain policies, passed as a small integer in place of an OID string. */
const POLICY = Object.freeze({ BASE: 1, AUTHENTICODE: 2, AUTHENTICODE_TS: 3, SSL: 4,
    BASIC_CONSTRAINTS: 5 });
/** CERT_CHAIN_POLICY_PARA flags that excuse a fault. */
const POLICY_IGNORE = Object.freeze({ NOT_TIME_VALID: 0x1, WRONG_USAGE: 0x8,
    UNKNOWN_CA: 0x10, ALL_REV_UNKNOWN: 0xf00 });
/** SSL_EXTRA_CERT_CHAIN_POLICY_PARA's fdwChecks (the SECURITY_FLAG_IGNORE_* bits). */
const SSL_IGNORE = Object.freeze({ REVOCATION: 0x80, UNKNOWN_CA: 0x100, WRONG_USAGE: 0x200,
    CN_INVALID: 0x1000, DATE_INVALID: 0x2000 });
const AUTHTYPE_CLIENT = 1;

/** Sizes of the structures a program reads. */
const CERT_CONTEXT_SIZE = 20;
const CERT_INFO_SIZE = 112;
const CERT_EXTENSION_SIZE = 16;
const CHAIN_CONTEXT_SIZE = 56;
const SIMPLE_CHAIN_SIZE = 32;
const CHAIN_ELEMENT_SIZE = 32;
const MAX_CHAIN = 16;
/** Where store handles are numbered from: opaque, never zero, never a pointer a program holds. */
const STORE_BASE = 0x5c000000;

/**
 * @typedef {Object} CertificatesHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxBytes: number) => string} readWideString
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} setLastError
 * @property {(bytes: number) => number} localAlloc  LPTR; 0 when it cannot be had.
 * @property {(address: number) => void} localFree
 * @property {() => number} now  The guest's wall clock, ms since 1970 UTC.
 * @property {() => Uint8Array[]} trustedRoots  The machine's root store, as DER.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(path: string) => Uint8Array | null} [readFile]  A file's bytes, for
 *           CryptQueryObject's CERT_QUERY_OBJECT_FILE; absent, no file is found.
 */

/**
 * A block laid out before it is allocated: pieces appended at offsets, and
 * pointer fields that name an offset, made absolute once the base is known.
 */
class Layout {
    constructor(){
        /** @type {Uint8Array[]} */
        this.pieces = [];
        this.size = 0;
        /** @type {[number, number][]} field offset, target offset */
        this.pointers = [];
    }

    /** Room for `length` bytes, 4-aligned. @param {number} length */
    reserve(length){
        const at = this.size;
        this.pieces.push(new Uint8Array((length + 3) & ~3));
        this.size += (length + 3) & ~3;
        return at;
    }

    /** @param {Uint8Array} bytes */
    add(bytes){
        const at = this.reserve(bytes.length);
        this.pieces[this.pieces.length - 1].set(bytes);
        return at;
    }

    /** An ASCII string with its terminator. @param {string} text */
    addString(text){
        return this.add(Uint8Array.from([...text, '\0'], ch=>ch.charCodeAt(0)));
    }

    /** @param {number} field @param {number} target */
    point(field, target){
        this.pointers.push([field, target]);
    }

    /** The whole block for `base`, with `values` (offset -> dword) written in. */
    /** @param {number} base @param {Map<number, number>} values */
    build(base, values){
        const out = new Uint8Array(this.size);
        let at = 0;
        for (const piece of this.pieces)
        {
            out.set(piece, at);
            at += piece.length;
        }
        const view = new DataView(out.buffer);
        for (const [field, value] of values)
        {
            view.setUint32(field, value >>> 0, true);
        }
        for (const [field, target] of this.pointers)
        {
            view.setUint32(field, (base + target) >>> 0, true);
        }
        return out;
    }
}

/**
 * A FILETIME (100 ns since 1601) for milliseconds since 1970, as two dwords.
 *
 * @param {number} ms
 */
const fileTime = ms=>{
    const ticks = (BigInt(Math.round(ms)) + 11644473600000n) * 10000n;
    return [Number(ticks & 0xffffffffn), Number(ticks >> 32n)];
};

/**
 * A string as UTF-16 with its terminator; nothing for null.
 *
 * @param {string | null} text
 */
const wideBytes = text=>{
    if (text === null)
    {
        return new Uint8Array(0);
    }
    const out = new Uint8Array(text.length * 2 + 2);
    for (let i = 0; i < text.length; i++)
    {
        out[i * 2] = text.charCodeAt(i) & 0xff;
        out[i * 2 + 1] = text.charCodeAt(i) >> 8;
    }
    return out;
};

/**
 * Whether `host` is what `pattern` names: case aside, and a wildcard only as
 * the whole leftmost label of a name with at least two labels after it.
 *
 * @param {string} pattern @param {string} host
 */
export function nameMatches(pattern, host){
    const want = host.toLowerCase().replace(/\.$/, '');
    const name = pattern.toLowerCase().replace(/\.$/, '');
    if (name.startsWith('*.'))
    {
        const rest = name.slice(2);
        const dot = want.indexOf('.');
        return rest.includes('.') && dot > 0 && want.slice(dot + 1) === rest;
    }
    return name === want;
}

/** @param {CertificatesHost} host */
export function createCertificateFunctions(host){
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
     * @typedef {Object} Context
     * @property {Certificate} certificate
     * @property {number} refs
     * @property {number} store  The store handle it belongs to (0 for none).
     * @property {Map<number, any>} [properties]  Its context properties, by id.
     */
    /** @type {Map<number, Context>} */
    const contexts = new Map();

    /**
     * @typedef {Object} Store
     * @property {number} refs
     * @property {number[]} held   Context addresses it holds, a reference each.
     * @property {number[]} [members] A collection's stores.
     * @property {string} [system] The system store it is, by upper-case name.
     */
    /** @type {Map<number, Store>} */
    const stores = new Map();
    /** System stores by name, made once and kept for the process: each open is a handle on it. */
    /** @type {Map<string, Store>} */
    const systemStores = new Map();
    let nextStore = STORE_BASE;

    /** @type {Map<number, { refs: number, elements: number[], errors: number[], error: number }>} */
    const chains = new Map();

    /**
     * A new context for `certificate`, one reference held by the caller.
     *
     * @param {Certificate} certificate @param {number} store
     */
    const makeContext = (certificate, store)=>{
        const layout = new Layout();
        const context = layout.reserve(CERT_CONTEXT_SIZE);
        const info = layout.reserve(CERT_INFO_SIZE);
        /** @type {Map<number, number>} */
        const values = new Map();
        const encoded = layout.add(certificate.encoded);
        values.set(context, X509_ASN_ENCODING);
        layout.point(context + 4, encoded);
        values.set(context + 8, certificate.encoded.length);
        layout.point(context + 12, info);
        values.set(context + 16, store);

        /** A CRYPT_*_BLOB at `field`: count, then a pointer (none when empty). */
        const blob = (/** @type {number} */ field, /** @type {Uint8Array} */ bytes)=>{
            values.set(field, bytes.length);
            if (bytes.length > 0)
            {
                layout.point(field + 4, layout.add(bytes));
            }
        };
        values.set(info, certificate.version - 1);
        // CERT_INFO's serial number is little-endian, the reverse of DER's.
        blob(info + 4, Uint8Array.from(certificate.serial).reverse());
        layout.point(info + 12, layout.addString(certificate.signatureAlgorithm));
        blob(info + 16, certificate.signatureParameters);
        blob(info + 24, certificate.issuer);
        const [beforeLow, beforeHigh] = fileTime(certificate.notBefore);
        const [afterLow, afterHigh] = fileTime(certificate.notAfter);
        values.set(info + 32, beforeLow);
        values.set(info + 36, beforeHigh);
        values.set(info + 40, afterLow);
        values.set(info + 44, afterHigh);
        blob(info + 48, certificate.subject);
        layout.point(info + 56, layout.addString(certificate.publicKeyAlgorithm));
        blob(info + 60, certificate.publicKeyParameters);
        blob(info + 68, certificate.publicKeyBits.bits);
        values.set(info + 76, certificate.publicKeyBits.unused);
        values.set(info + 104, certificate.extensions.length);
        if (certificate.extensions.length > 0)
        {
            const list = layout.reserve(certificate.extensions.length * CERT_EXTENSION_SIZE);
            layout.point(info + 108, list);
            certificate.extensions.forEach((extension, index)=>{
                const at = list + index * CERT_EXTENSION_SIZE;
                layout.point(at, layout.addString(extension.id));
                values.set(at + 4, extension.critical ? 1 : 0);
                blob(at + 8, extension.value);
            });
        }
        const base = host.localAlloc(layout.size);
        if (base === 0)
        {
            return 0;
        }
        host.writeMemory(base, layout.build(base, values));
        contexts.set(base, { certificate, refs: 1, store });
        return base;
    };

    /** @param {number} address */
    const release = address=>{
        const context = contexts.get(address);
        if (!context)
        {
            return false;
        }
        if (--context.refs <= 0)
        {
            contexts.delete(address);
            host.localFree(address);
        }
        return true;
    };

    /** @param {number} address */
    const duplicate = address=>{
        const context = contexts.get(address);
        if (context)
        {
            context.refs++;
        }
        return context ? address : 0;
    };

    /** A new handle on `store`. @param {Store} store */
    const handleOf = store=>{
        const handle = nextStore;
        nextStore += 4;
        stores.set(handle, store);
        return handle;
    };

    /** The ROOT store, filled from the machine's roots the first time it is opened. */
    const systemStore = (/** @type {string} */ name)=>{
        const key = name.toUpperCase();
        let store = systemStores.get(key);
        if (!store)
        {
            store = { refs: 1, held: [], system: key };
            systemStores.set(key, store);
            if (key === 'ROOT')
            {
                const handle = handleOf(store);
                for (const der of host.trustedRoots())
                {
                    try
                    {
                        const address = makeContext(parseCertificate(der), handle);
                        if (address !== 0)
                        {
                            store.held.push(address);
                        }
                    }
                    catch (e){
                        if (!(e instanceof DerError))
                        {
                            throw e;
                        }
                        host.divergence?.('CertOpenStore',
                            'a configured root is not a certificate');
                    }
                }
                return handle;
            }
        }
        return handleOf(store);
    };

    /**
     * Every context a store holds, a collection's members' included.
     *
     * @param {number} handle @param {Set<Store>} [seen]
     * @returns {number[]}
     */
    const membersOf = (handle, seen = new Set())=>{
        const store = stores.get(handle);
        if (!store || seen.has(store))
        {
            return [];
        }
        seen.add(store);
        return [...store.held, ...(store.members ?? []).flatMap(member=>membersOf(member, seen))];
    };

    /**
     * The trust anchors: the ROOT store's contexts, or those of the store an
     * engine trusts instead.
     *
     * @param {number} [exclusive]  That store's handle.
     */
    const anchors = exclusive=>{
        const handle = exclusive || systemStore('ROOT');
        const out = membersOf(handle).flatMap(address=>{
            const certificate = contexts.get(address)?.certificate;
            return certificate ? [{ address, certificate }] : [];
        });
        if (!exclusive)
        {
            closeStore(handle);
        }
        return out;
    };

    /** @param {number} handle */
    const closeStore = handle=>{
        const store = stores.get(handle);
        if (!store)
        {
            return false;
        }
        stores.delete(handle);
        if (--store.refs <= 0 && !store.system)
        {
            for (const address of store.held.splice(0))
            {
                release(address);
            }
        }
        return true;
    };

    /**
     * Builds the chain from `leaf`: its issuer by name from the anchors and
     * the pool, one that signed it preferred; a trusted anchor ends it.
     *
     * @param {number} leafAddress
     * @param {number[]} pool  Context addresses to find issuers among.
     * @param {number} time
     * @param {{ and: boolean, usages: string[] }} usage
     * @param {number} flags
     * @param {number} [exclusiveRoot]  An engine's own root store.
     */
    const buildChain = (leafAddress, pool, time, usage, flags, exclusiveRoot)=>{
        const roots = anchors(exclusiveRoot);
        /** @param {Certificate} certificate */
        const trusted = certificate=>roots.some(root=>
            sameBytes(root.certificate.encoded, certificate.encoded));
        /** @type {{ address: number, certificate: Certificate, error: number, info: number }[]} */
        const elements = [];
        const leaf = /** @type {Context} */ (contexts.get(leafAddress)).certificate;
        elements.push({ address: leafAddress, certificate: leaf, error: 0, info: 0 });
        let chainError = 0;
        for (let current = elements[0]; ;)
        {
            if (trusted(current.certificate))
            {
                if (isSelfIssued(current.certificate))
                {
                    current.info |= TRUST_INFO.IS_SELF_SIGNED;
                }
                break;
            }
            if (isSelfIssued(current.certificate))
            {
                current.info |= TRUST_INFO.IS_SELF_SIGNED;
                if (!isSignedBy(current.certificate, current.certificate.publicKey))
                {
                    current.error |= TRUST_ERROR.IS_NOT_SIGNATURE_VALID;
                }
                current.error |= TRUST_ERROR.IS_UNTRUSTED_ROOT;
                break;
            }
            if (elements.length >= MAX_CHAIN)
            {
                chainError |= TRUST_ERROR.IS_PARTIAL_CHAIN;
                break;
            }
            /** @type {{ address: number, certificate: Certificate }[]} */
            const candidates = [...roots];
            for (const address of pool)
            {
                const certificate = contexts.get(address)?.certificate;
                if (certificate)
                {
                    candidates.push({ address, certificate });
                }
            }
            const named = candidates.filter(candidate=>sameBytes(candidate.certificate.subject,
                current.certificate.issuer) && !elements.some(element=>
                sameBytes(element.certificate.encoded, candidate.certificate.encoded)));
            if (named.length === 0)
            {
                chainError |= TRUST_ERROR.IS_PARTIAL_CHAIN;
                break;
            }
            // A trusted anchor that signed it first, then any issuer that signed it.
            const signer = named.filter(candidate=>trusted(candidate.certificate))
                .concat(named.filter(candidate=>!trusted(candidate.certificate)))
                .find(candidate=>isSignedBy(current.certificate, candidate.certificate.publicKey));
            const issuer = signer ?? named[0];
            current.info |= TRUST_INFO.HAS_NAME_MATCH_ISSUER | TRUST_INFO.HAS_PREFERRED_ISSUER;
            if (!signer)
            {
                current.error |= TRUST_ERROR.IS_NOT_SIGNATURE_VALID;
            }
            const address = duplicate(issuer.address);
            const next = { address, certificate: issuer.certificate, error: 0, info: 0 };
            if (issuer.certificate.basicConstraints !== null
                && !issuer.certificate.basicConstraints.ca)
            {
                next.error |= TRUST_ERROR.INVALID_BASIC_CONSTRAINTS;
            }
            elements.push(next);
            current = next;
        }
        for (const element of elements)
        {
            const certificate = element.certificate;
            if (time < certificate.notBefore || time > certificate.notAfter)
            {
                element.error |= TRUST_ERROR.IS_NOT_TIME_VALID;
            }
            if (certificate.unknownCritical.length > 0)
            {
                element.error |= TRUST_ERROR.INVALID_EXTENSION;
            }
        }
        if (usage.usages.length > 0)
        {
            // Every certificate that restricts its usage must allow what was
            // asked: all of it (AND) or some of it (OR).
            for (const element of elements)
            {
                const allowed = element.certificate.extendedKeyUsage;
                if (allowed === null || allowed.includes(USAGE.ANY))
                {
                    continue;
                }
                const ok = usage.and ? usage.usages.every(one=>allowed.includes(one))
                    : usage.usages.some(one=>allowed.includes(one));
                if (!ok)
                {
                    element.error |= TRUST_ERROR.IS_NOT_VALID_FOR_USAGE;
                }
            }
        }
        const revocation = flags & (REVOCATION_CHECK.END_CERT | REVOCATION_CHECK.CHAIN
            | REVOCATION_CHECK.CHAIN_EXCLUDE_ROOT);
        if (revocation !== 0)
        {
            const last = elements.length - 1;
            elements.forEach((element, index)=>{
                const checked = revocation & REVOCATION_CHECK.CHAIN ? true
                    : revocation & REVOCATION_CHECK.CHAIN_EXCLUDE_ROOT ? index < last
                        : index === 0;
                if (checked && !(element.info & TRUST_INFO.IS_SELF_SIGNED))
                {
                    element.error |= TRUST_ERROR.REVOCATION_STATUS_UNKNOWN
                        | TRUST_ERROR.IS_OFFLINE_REVOCATION;
                }
            });
        }
        return { elements, chainError };
    };

    /**
     * Lays out and allocates a chain context for `elements`.
     *
     * @param {{ address: number, error: number, info: number }[]} elements
     * @param {number} chainError @param {number} flags
     */
    const makeChainContext = (elements, chainError, flags)=>{
        const layout = new Layout();
        /** @type {Map<number, number>} */
        const values = new Map();
        const context = layout.reserve(CHAIN_CONTEXT_SIZE);
        const chainList = layout.reserve(4);
        const simple = layout.reserve(SIMPLE_CHAIN_SIZE);
        const elementList = layout.reserve(elements.length * 4);
        const error = elements.reduce((all, element)=>all | element.error, chainError);
        const info = elements.reduce((all, element)=>all | element.info, 0)
            & ~TRUST_INFO.IS_SELF_SIGNED & ~TRUST_INFO.HAS_NAME_MATCH_ISSUER;
        values.set(context, CHAIN_CONTEXT_SIZE);
        values.set(context + 4, error);
        values.set(context + 8, info);
        values.set(context + 12, 1);
        layout.point(context + 16, chainList);
        values.set(context + 36, flags);
        layout.point(chainList, simple);
        values.set(simple, SIMPLE_CHAIN_SIZE);
        values.set(simple + 4, error);
        values.set(simple + 8, info);
        values.set(simple + 12, elements.length);
        layout.point(simple + 16, elementList);
        elements.forEach((element, index)=>{
            const at = layout.reserve(CHAIN_ELEMENT_SIZE);
            layout.point(elementList + index * 4, at);
            values.set(at, CHAIN_ELEMENT_SIZE);
            values.set(at + 4, element.address);
            values.set(at + 8, element.error);
            values.set(at + 12, element.info);
        });
        const base = host.localAlloc(layout.size);
        if (base === 0)
        {
            return 0;
        }
        host.writeMemory(base, layout.build(base, values));
        chains.set(base, { refs: 1, elements: elements.map(element=>element.address),
            errors: elements.map(element=>element.error), error });
        return base;
    };

    /** A store's handle as given, or null. @param {number} handle */
    const storeOf = handle=>stores.get(handle >>> 0) ?? null;

    /**
     * The store name `pvPara` points to, in the width the provider says.
     *
     * @param {number} provider @param {number} pointer
     */
    const storeName = (provider, pointer)=>(pointer === 0 ? ''
        : provider === PROVIDER.SYSTEM_A || provider === PROVIDER.SYSTEM_REGISTRY_A
            ? host.readCString(pointer, 260) : host.readWideString(pointer, 260 * 2));

    /** CertOpenStore's work, the provider already a number. */
    /** @param {number} provider @param {number} flags @param {number} parameter */
    const openStore = (provider, flags, parameter)=>{
        switch (provider)
        {
            case PROVIDER.MEMORY:
                return handleOf({ refs: 1, held: [] });
            case PROVIDER.COLLECTION:
                return handleOf({ refs: 1, held: [], members: [] });
            case PROVIDER.SYSTEM_A:
            case PROVIDER.SYSTEM_W:
            case PROVIDER.SYSTEM_REGISTRY_A:
            case PROVIDER.SYSTEM_REGISTRY_W: {
                const name = storeName(provider, parameter);
                if (name === '')
                {
                    return fail(E_INVALIDARG);
                }
                if ((flags & CERT_STORE_OPEN_EXISTING_FLAG) !== 0
                    && !['ROOT', 'MY', 'CA', 'TRUST', 'DISALLOWED', 'TRUSTEDPUBLISHER',
                        'AUTHROOT', 'TRUSTEDPEOPLE'].includes(name.toUpperCase())
                    && !systemStores.has(name.toUpperCase()))
                {
                    return fail(ERROR_FILE_NOT_FOUND);
                }
                return systemStore(name);
            }
            default:
                host.divergence?.('CertOpenStore', `store provider ${provider} is not provided`);
                return fail(ERROR_FILE_NOT_FOUND);
        }
    };

    /**
     * Adds `address`'s certificate to `handle`'s store under `disposition`,
     * writing the store's context to `out` when asked.
     *
     * @param {number} handle @param {Certificate} certificate
     * @param {number} disposition @param {number} out
     */
    const addToStore = (handle, certificate, disposition, out)=>{
        const store = storeOf(handle);
        if (!store)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        const existing = store.held.find(address=>sameBytes(
            /** @type {Context} */ (contexts.get(address)).certificate.encoded,
            certificate.encoded));
        /** @type {number} */
        let result;
        switch (disposition)
        {
            case ADD.NEW:
                if (existing !== undefined)
                {
                    return fail(CRYPT_E_EXISTS);
                }
                result = 0;
                break;
            case ADD.USE_EXISTING:
            case ADD.NEWER:
            case ADD.NEWER_INHERIT_PROPERTIES:
                result = existing ?? 0;
                break;
            case ADD.REPLACE_EXISTING:
            case ADD.REPLACE_EXISTING_INHERIT_PROPERTIES:
                if (existing !== undefined)
                {
                    store.held.splice(store.held.indexOf(existing), 1);
                    release(existing);
                }
                result = 0;
                break;
            case ADD.ALWAYS:
                result = 0;
                break;
            default:
                return fail(E_INVALIDARG);
        }
        if (result === 0)
        {
            result = makeContext(certificate, handle >>> 0);
            if (result === 0)
            {
                return fail(ERROR_NOT_ENOUGH_MEMORY);
            }
            store.held.push(result);
        }
        if (out !== 0)
        {
            setDword(out, duplicate(result));
        }
        return 1;
    };

    /** @param {number} encodingType @param {number} pointer @param {number} length */
    const readCertificate = (encodingType, pointer, length)=>{
        if ((encodingType & X509_ASN_ENCODING) === 0 && encodingType !== 0)
        {
            return null;
        }
        try
        {
            return parseCertificate(host.readMemory(pointer, length).slice());
        }
        catch (e){
            if (!(e instanceof DerError))
            {
                throw e;
            }
            return null;
        }
    };

    /** Chain engines, by handle: their extra stores and the root store they trust. */
    /** @type {Map<number, { additional: number[], exclusiveRoot: number }>} */
    const engines = new Map();
    let nextEngine = ENGINE_BASE;

    /** Messages CryptQueryObject opened, by handle. */
    /** @type {Map<number, import('../crypto/pkcs7.js').SignedData & { der: Uint8Array }>} */
    const messages = new Map();
    let nextMessage = MESSAGE_BASE;

    /** A context's certificate, or null. @param {number} address */
    const certificateAt = address=>contexts.get(address >>> 0)?.certificate ?? null;

    /** @param {number} address @returns {Map<number, any>} */
    const propertiesOf = address=>{
        const context = /** @type {Context} */ (contexts.get(address));
        context.properties ??= new Map();
        return context.properties;
    };

    /** @param {Uint8Array} bytes @param {() => import('../crypto/digest.js').Digest} make */
    const hashOf = (bytes, make)=>{
        const digest = make();
        digest.update(bytes);
        return digest.digest();
    };

    /**
     * A property's bytes as the getter hands them out, laid at `at` (the
     * key provider record holds pointers into itself); null when the
     * context has none.
     *
     * @param {number} address @param {number} id @param {number} at
     * @returns {Uint8Array | null}
     */
    const propertyBytes = (address, id, at)=>{
        const certificate = /** @type {Certificate} */ (certificateAt(address));
        const kept = propertiesOf(address).get(id);
        if (kept instanceof Uint8Array)
        {
            return kept;
        }
        if (id === PROP.KEY_PROV_INFO && kept)
        {
            // CRYPT_KEY_PROV_INFO: container, provider, type, flags, no
            // parameters, key spec; the two names behind it.
            const container = wideBytes(kept.container);
            const provider = wideBytes(kept.provider);
            const out = new Uint8Array(KEY_PROV_INFO_SIZE + container.length + provider.length);
            const view = new DataView(out.buffer);
            view.setUint32(0, kept.container === null ? 0 : at + KEY_PROV_INFO_SIZE, true);
            view.setUint32(4, kept.provider === null ? 0
                : at + KEY_PROV_INFO_SIZE + container.length, true);
            view.setUint32(8, kept.type, true);
            view.setUint32(12, kept.flags, true);
            view.setUint32(24, kept.keySpec, true);
            out.set(container, KEY_PROV_INFO_SIZE);
            out.set(provider, KEY_PROV_INFO_SIZE + container.length);
            return out;
        }
        switch (id)
        {
            case PROP.SHA1_HASH: return hashOf(certificate.encoded, createSha1);
            case PROP.MD5_HASH: return hashOf(certificate.encoded, createMd5);
            case PROP.SHA256_HASH: return hashOf(certificate.encoded, createSha256);
            case PROP.KEY_IDENTIFIER: {
                // The subject key identifier's value where the certificate has
                // one, the SHA-1 of the key's bits otherwise (RFC 5280's method 1).
                const extension = certificate.extensions.find(one=>one.id === '2.5.29.14');
                if (extension)
                {
                    try
                    {
                        return contentsOf(readNode(extension.value)).slice();
                    }
                    catch (e){
                        if (!(e instanceof DerError))
                        {
                            throw e;
                        }
                    }
                }
                return hashOf(certificate.publicKeyBits.bits, createSha1);
            }
            case PROP.ACCESS_STATE: {
                // Writable for a store a program made; a system store's
                // certificates are the machine's.
                const store = stores.get(/** @type {Context} */ (contexts.get(address)).store);
                return Uint8Array.of(store?.system ? ACCESS_STATE_SYSTEM_STORE : 0, 0, 0, 0);
            }
            default:
                return null;
        }
    };

    /**
     * The name a CertGetNameString type asks for, or '' when there is none.
     *
     * @param {number} address @param {number} type @param {number} flags @param {number} para
     */
    const nameOf = (address, type, flags, para)=>{
        const certificate = /** @type {Certificate} */ (certificateAt(address));
        const issuer = (flags & CERT_NAME_ISSUER_FLAG) !== 0;
        const encoded = issuer ? certificate.issuer : certificate.subject;
        /** @type {import('../crypto/x509.js').NameAttribute[]} */
        let attributes = [];
        try
        {
            attributes = readName(encoded).flat();
        }
        catch (e){
            if (!(e instanceof DerError))
            {
                throw e;
            }
        }
        const alternative = certificate.extensions.find(one=>one.id
            === (issuer ? '2.5.29.18' : '2.5.29.17'));
        /** @type {import('../crypto/x509.js').GeneralName[]} */
        let alternatives = [];
        try
        {
            alternatives = alternative ? readGeneralNames(alternative.value) : [];
        }
        catch (e){
            if (!(e instanceof DerError))
            {
                throw e;
            }
        }
        /** @param {number} choice */
        const altText = choice=>{
            const found = alternatives.find(one=>one.choice === choice);
            return found ? String.fromCharCode(...found.raw) : null;
        };
        /** @param {string} oid */
        const attribute = oid=>attributes.find(one=>one.oid === oid)?.value ?? null;
        const EMAIL = '1.2.840.113549.1.9.1';
        switch (type)
        {
            case NAME_TYPE.EMAIL:
                return altText(1) ?? attribute(EMAIL) ?? '';
            case NAME_TYPE.RDN:
                return nameToString(encoded, para === 0 ? NAME_STR.X500 : dword(para));
            case NAME_TYPE.ATTR:
                return attribute(para === 0 ? '2.5.4.3' : host.readCString(para, 128)) ?? '';
            case NAME_TYPE.FRIENDLY_DISPLAY: {
                const friendly = propertiesOf(address).get(PROP.FRIENDLY_NAME);
                if (friendly instanceof Uint8Array && friendly.length >= 2)
                {
                    let text = '';
                    for (let i = 0; i + 1 < friendly.length; i += 2)
                    {
                        const code = friendly[i] | (friendly[i + 1] << 8);
                        if (code === 0)
                        {
                            break;
                        }
                        text += String.fromCharCode(code);
                    }
                    return text;
                }
            }
            // falls through: no friendly name is the simple display name
            case NAME_TYPE.SIMPLE_DISPLAY:
                return attribute('2.5.4.3') ?? attribute('2.5.4.11') ?? attribute('2.5.4.10')
                    ?? attribute(EMAIL) ?? altText(1) ?? attributes[0]?.value ?? '';
            case NAME_TYPE.DNS:
                return altText(2) ?? attribute('2.5.4.3') ?? '';
            case NAME_TYPE.URL:
                return altText(6) ?? '';
            default:
                return '';
        }
    };

    /**
     * CertFindCertificateInStore's test for one certificate, or null for a
     * find type not provided.
     *
     * @param {number} type @param {number} para @param {number} flags
     * @returns {((address: number) => boolean) | null}
     */
    const matcherFor = (type, para, flags)=>{
        const compare = type >>> 16;
        const which = type & 0xffff;
        /** @param {Certificate} certificate */
        const nameOfInfo = certificate=>(which === CERT_INFO_ISSUER_FLAG
            ? certificate.issuer : certificate.subject);
        /** @param {number} at */
        const blob = at=>{
            const size = dword(at);
            return size === 0 ? new Uint8Array(0) : host.readMemory(dword(at + 4), size).slice();
        };
        switch (compare)
        {
            case COMPARE.ANY:
                return ()=>true;
            case COMPARE.SHA1_HASH:
            case COMPARE.MD5_HASH:
            case COMPARE.KEY_IDENTIFIER: {
                const wanted = blob(para);
                const id = compare === COMPARE.SHA1_HASH ? PROP.SHA1_HASH
                    : compare === COMPARE.MD5_HASH ? PROP.MD5_HASH : PROP.KEY_IDENTIFIER;
                return address=>{
                    const bytes = propertyBytes(address, id, 0);
                    return bytes !== null && sameBytes(bytes, wanted);
                };
            }
            case COMPARE.NAME: {
                const wanted = blob(para);
                return address=>sameBytes(nameOfInfo(
                    /** @type {Certificate} */ (certificateAt(address))), wanted);
            }
            case COMPARE.NAME_STR_A:
            case COMPARE.NAME_STR_W: {
                const wanted = (compare === COMPARE.NAME_STR_W
                    ? host.readWideString(para, 1024 * 2) : host.readCString(para, 1024))
                    .toLowerCase();
                return address=>{
                    try
                    {
                        return readName(nameOfInfo(/** @type {Certificate} */ (
                            certificateAt(address)))).flat()
                            .some(attribute=>attribute.value.toLowerCase().includes(wanted));
                    }
                    catch (e){
                        if (!(e instanceof DerError))
                        {
                            throw e;
                        }
                        return false;
                    }
                };
            }
            case COMPARE.EXISTING: {
                const existing = certificateAt(para);
                return address=>existing !== null && sameBytes(
                    /** @type {Certificate} */ (certificateAt(address)).encoded, existing.encoded);
            }
            case COMPARE.ISSUER_OF: {
                const subject = certificateAt(para);
                return address=>{
                    const candidate = /** @type {Certificate} */ (certificateAt(address));
                    return subject !== null && sameBytes(candidate.subject, subject.issuer)
                        && isSignedBy(subject, candidate.publicKey);
                };
            }
            case COMPARE.SUBJECT_CERT: {
                // A CERT_INFO naming the certificate by issuer and serial number.
                const issuer = blob(para + 24);
                const serial = blob(para + 4).reverse();
                return address=>{
                    const candidate = /** @type {Certificate} */ (certificateAt(address));
                    return sameBytes(candidate.issuer, issuer)
                        && sameBytes(candidate.serial, serial);
                };
            }
            case COMPARE.PUBLIC_KEY: {
                const bits = blob(para + 12);
                return address=>sameBytes(
                    /** @type {Certificate} */ (certificateAt(address)).publicKeyBits.bits, bits);
            }
            case COMPARE.ENHKEY_USAGE: {
                const count = para === 0 ? 0 : dword(para);
                const list = para === 0 ? 0 : dword(para + 4);
                const usages = Array.from({ length: Math.min(count, 64) },
                    (_, i)=>host.readCString(dword(list + i * 4), 128));
                return address=>{
                    const allowed = /** @type {Certificate} */ (certificateAt(address))
                        .extendedKeyUsage;
                    if (allowed === null)
                    {
                        // No extension is valid for every usage, unless only
                        // the extension's say is asked for.
                        return (flags & CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG) === 0;
                    }
                    return (flags & CERT_FIND_OR_ENHKEY_USAGE_FLAG) !== 0
                        ? usages.some(one=>allowed.includes(one))
                        : usages.every(one=>allowed.includes(one));
                };
            }
            case COMPARE.HAS_PRIVATE_KEY:
                return address=>propertiesOf(address).has(PROP.KEY_PROV_INFO);
            default:
                return null;
        }
    };

    /**
     * Lays out a CERT_ENHKEY_USAGE: the count, the array inline after it, the
     * strings after that, its pointers made absolute for `at`.
     *
     * @param {string[]} usages @param {number} at
     */
    const enhancedKeyUsage = (usages, at)=>{
        const strings = usages.map(usage=>Uint8Array.from([...usage, '\0'],
            ch=>ch.charCodeAt(0)));
        const head = 8 + usages.length * 4;
        const out = new Uint8Array(head + strings.reduce((total, one)=>total + one.length, 0));
        const view = new DataView(out.buffer);
        view.setUint32(0, usages.length, true);
        view.setUint32(4, usages.length === 0 ? 0 : at + 8, true);
        let offset = head;
        strings.forEach((one, index)=>{
            view.setUint32(8 + index * 4, at + offset, true);
            out.set(one, offset);
            offset += one.length;
        });
        return out;
    };

    /**
     * Writes `bytes` under the size protocol: no buffer asks the size, a
     * buffer too small is ERROR_MORE_DATA with the size written.
     *
     * @param {Uint8Array | ((at: number) => Uint8Array)} bytes @param {number} out
     * @param {number} size
     */
    const answer = (bytes, out, size)=>{
        const length = (typeof bytes === 'function' ? bytes(0) : bytes).length;
        if (out === 0)
        {
            setDword(size, length);
            return 1;
        }
        if (dword(size) < length)
        {
            setDword(size, length);
            return fail(ERROR_MORE_DATA);
        }
        host.writeMemory(out, typeof bytes === 'function' ? bytes(out) : bytes);
        setDword(size, length);
        return 1;
    };

    /**
     * A signed structure's parts -- to-be-signed, algorithm, signature -- or
     * null when the bytes are not one.
     *
     * @param {Uint8Array} bytes
     */
    const signedParts = bytes=>{
        try
        {
            const [tbs, algorithm, signature] = childrenOf(expect(readNode(bytes), TAG.SEQUENCE,
                'a signed structure'));
            return { tbs: encodingOf(tbs), algorithm: readOid(childrenOf(algorithm)[0]),
                signature: readBitString(signature).bits };
        }
        catch (e){
            if (e instanceof DerError)
            {
                return null;
            }
            throw e;
        }
    };

    /**
     * What a CryptQueryObject object holds, as one of the content types it
     * names: a certificate (DER or PEM), a PKCS #7 SignedData, or the one a
     * signed PE image carries.
     *
     * @param {Uint8Array} bytes @param {number} wanted  The content type flags allowed.
     * @param {number} formats  The format flags allowed.
     */
    const queryContent = (bytes, wanted, formats)=>{
        /** @type {{ der: Uint8Array, format: number }[]} */
        const forms = [];
        if ((formats & (1 << FORMAT.BINARY)) !== 0)
        {
            forms.push({ der: bytes, format: FORMAT.BINARY });
        }
        if ((formats & (1 << FORMAT.BASE64)) !== 0)
        {
            const text = String.fromCharCode(...bytes.subarray(0, 0x100000));
            const pem = /-----BEGIN [^-]+-----([\s\S]*?)-----END/.exec(text);
            try
            {
                const body = (pem ? pem[1] : text).replace(/\s/g, '');
                if (/^[A-Za-z0-9+/]+={0,2}$/.test(body))
                {
                    forms.push({ der: Uint8Array.from(atob(body), ch=>ch.charCodeAt(0)),
                        format: FORMAT.BASE64 });
                }
            }
            catch {
                // not base64
            }
        }
        for (const { der, format } of forms)
        {
            if ((wanted & (1 << CONTENT.CERT)) !== 0)
            {
                try
                {
                    return { type: CONTENT.CERT, format, certificate: parseCertificate(der) };
                }
                catch (e){
                    if (!(e instanceof DerError))
                    {
                        throw e;
                    }
                }
            }
            if ((wanted & (1 << CONTENT.PKCS7_SIGNED)) !== 0)
            {
                try
                {
                    return { type: CONTENT.PKCS7_SIGNED, format, message: der,
                        signed: parseSignedData(der) };
                }
                catch (e){
                    if (!(e instanceof DerError))
                    {
                        throw e;
                    }
                }
            }
        }
        if ((wanted & (1 << CONTENT.PKCS7_SIGNED_EMBED)) !== 0
            && (formats & (1 << FORMAT.BINARY)) !== 0)
        {
            const subject = readSubject(bytes);
            if (subject?.signature)
            {
                try
                {
                    return { type: CONTENT.PKCS7_SIGNED_EMBED, format: FORMAT.BINARY,
                        message: subject.signature, signed: parseSignedData(subject.signature) };
                }
                catch (e){
                    if (!(e instanceof DerError))
                    {
                        throw e;
                    }
                }
            }
        }
        return null;
    };

    /** @param {boolean} wide */
    const getNameString = wide=>({
        argBytes: 24,
        handler: (/** @type {number[]} */ [address, type, flags, para, out, count])=>{
            if (!contexts.has(address >>> 0))
            {
                return fail(E_INVALIDARG);
            }
            const text = nameOf(address >>> 0, type >>> 0, flags >>> 0, para >>> 0);
            if ((out >>> 0) === 0 || (count >>> 0) === 0)
            {
                return text.length + 1;
            }
            const kept = text.slice(0, (count >>> 0) - 1);
            host.writeMemory(out >>> 0, wide ? wideBytes(kept)
                : Uint8Array.from([...kept, '\0'], ch=>ch.charCodeAt(0) & 0xff));
            return kept.length + 1;
        },
    });

    /** @param {number} address */
    const freeChain = address=>{
        const chain = chains.get(address);
        if (chain && --chain.refs <= 0)
        {
            chains.delete(address);
            chain.elements.forEach(release);
            host.localFree(address);
        }
    };

    return {
        /**
         * HCERTSTORE CertOpenStore(LPCSTR lpszStoreProvider, DWORD dwEncodingType,
         *     HCRYPTPROV_LEGACY hCryptProv, DWORD dwFlags, const void *pvPara)
         *
         * The provider is a number below 0x10000 or an ASCII name.
         */
        CertOpenStore: {
            argBytes: 20,
            handler: (/** @type {number[]} */ [provider, , , flags, parameter])=>{
                const which = (provider >>> 0) < 0x10000 ? provider >>> 0
                    : PROVIDER_NAMES.get(host.readCString(provider >>> 0, 64).toLowerCase()) ?? -1;
                return openStore(which, flags >>> 0, parameter >>> 0);
            },
        },

        /** HCERTSTORE CertOpenSystemStoreA(HCRYPTPROV_LEGACY hProv, LPCSTR szSubsystemProtocol) */
        CertOpenSystemStoreA: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [, name])=>
                openStore(PROVIDER.SYSTEM_A, 0, name >>> 0),
        },

        /** HCERTSTORE CertOpenSystemStoreW(HCRYPTPROV_LEGACY hProv, LPCWSTR szSubsystemProtocol) */
        CertOpenSystemStoreW: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [, name])=>
                openStore(PROVIDER.SYSTEM_W, 0, name >>> 0),
        },

        /** HCERTSTORE CertDuplicateStore(HCERTSTORE hCertStore) */
        CertDuplicateStore: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [handle])=>{
                const store = storeOf(handle);
                if (!store)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                store.refs++;
                return handleOf(store);
            },
        },

        /**
         * BOOL CertCloseStore(HCERTSTORE hCertStore, DWORD dwFlags)
         *
         * A NULL store is TRUE, as Windows has it.
         */
        CertCloseStore: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [handle])=>
                ((handle >>> 0) === 0 || closeStore(handle >>> 0) ? 1 : fail(ERROR_INVALID_HANDLE)),
        },

        /** BOOL CertAddStoreToCollection(HCERTSTORE hCollectionStore, HCERTSTORE hSiblingStore, DWORD, DWORD) */
        CertAddStoreToCollection: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [collection, sibling])=>{
                const store = storeOf(collection);
                const member = storeOf(sibling);
                if (!store?.members || !member)
                {
                    return fail(E_INVALIDARG);
                }
                member.refs++;
                store.members.push(handleOf(member));
                return 1;
            },
        },

        /**
         * PCCERT_CONTEXT CertCreateCertificateContext(DWORD dwCertEncodingType,
         *     const BYTE *pbCertEncoded, DWORD cbCertEncoded)
         */
        CertCreateCertificateContext: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [encodingType, pointer, length])=>{
                if ((pointer >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const certificate = readCertificate(encodingType >>> 0, pointer >>> 0,
                    length >>> 0);
                if (!certificate)
                {
                    return fail(CRYPT_E_ASN1_BADTAG);
                }
                return makeContext(certificate, 0) || fail(ERROR_NOT_ENOUGH_MEMORY);
            },
        },

        /** PCCERT_CONTEXT CertDuplicateCertificateContext(PCCERT_CONTEXT pCertContext) */
        CertDuplicateCertificateContext: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [address])=>duplicate(address >>> 0),
        },

        /** BOOL CertFreeCertificateContext(PCCERT_CONTEXT pCertContext); TRUE for NULL. */
        CertFreeCertificateContext: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [address])=>{
                if ((address >>> 0) !== 0)
                {
                    release(address >>> 0);
                }
                return 1;
            },
        },

        /**
         * BOOL CertAddCertificateContextToStore(HCERTSTORE hCertStore,
         *     PCCERT_CONTEXT pCertContext, DWORD dwAddDisposition,
         *     PCCERT_CONTEXT *ppStoreContext)
         *
         * The store keeps a context of its own; the one passed is the caller's still.
         */
        CertAddCertificateContextToStore: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [handle, address, disposition, out])=>{
                const context = contexts.get(address >>> 0);
                if (!context)
                {
                    return fail(E_INVALIDARG);
                }
                return addToStore(handle, context.certificate, disposition >>> 0, out >>> 0);
            },
        },

        /**
         * BOOL CertAddEncodedCertificateToStore(HCERTSTORE hCertStore,
         *     DWORD dwCertEncodingType, const BYTE *pbCertEncoded, DWORD cbCertEncoded,
         *     DWORD dwAddDisposition, PCCERT_CONTEXT *ppCertContext)
         */
        CertAddEncodedCertificateToStore: {
            argBytes: 24,
            handler: (/** @type {number[]} */ [handle, encodingType, pointer, length,
                disposition, out])=>{
                const certificate = (pointer >>> 0) === 0 ? null
                    : readCertificate(encodingType >>> 0, pointer >>> 0, length >>> 0);
                if (!certificate)
                {
                    return fail(CRYPT_E_ASN1_BADTAG);
                }
                return addToStore(handle, certificate, disposition >>> 0, out >>> 0);
            },
        },

        /**
         * PCCERT_CONTEXT CertEnumCertificatesInStore(HCERTSTORE hCertStore,
         *     PCCERT_CONTEXT pPrevCertContext)
         *
         * The previous context is freed; the one returned is the caller's to
         * free, or to pass back.
         */
        CertEnumCertificatesInStore: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [handle, previous])=>{
                if (!storeOf(handle))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const members = membersOf(handle >>> 0);
                let at = 0;
                if ((previous >>> 0) !== 0)
                {
                    const was = members.indexOf(previous >>> 0);
                    release(previous >>> 0);
                    at = was < 0 ? members.length : was + 1;
                }
                return at < members.length ? duplicate(members[at]) : fail(CRYPT_E_NOT_FOUND);
            },
        },

        /**
         * BOOL CertGetCertificateChain(HCERTCHAINENGINE hChainEngine,
         *     PCCERT_CONTEXT pCertContext, LPFILETIME pTime, HCERTSTORE hAdditionalStore,
         *     PCERT_CHAIN_PARA pChainPara, DWORD dwFlags, LPVOID pvReserved,
         *     PCCERT_CHAIN_CONTEXT *ppChainContext)
         *
         * One simple chain, its trust status in every element and summed into
         * the chain's: the call succeeds whatever the chain's faults are.
         */
        CertGetCertificateChain: {
            argBytes: 32,
            handler: (/** @type {number[]} */ [engineHandle, address, timePointer, additional,
                parameters, flags, , out])=>{
                const context = contexts.get(address >>> 0);
                if (!context || (out >>> 0) === 0 || (parameters >>> 0) === 0)
                {
                    return fail(E_INVALIDARG);
                }
                let time = host.now();
                if ((timePointer >>> 0) !== 0)
                {
                    const ticks = BigInt(dword(timePointer >>> 0))
                        | (BigInt(dword((timePointer >>> 0) + 4)) << 32n);
                    time = Number(ticks / 10000n - 11644473600000n);
                }
                // CERT_CHAIN_PARA.RequestedUsage: dwType, then CERT_ENHKEY_USAGE.
                const kind = dword((parameters >>> 0) + 4);
                const count = dword((parameters >>> 0) + 8);
                const list = dword((parameters >>> 0) + 12);
                /** @type {string[]} */
                const usages = [];
                for (let i = 0; i < (list === 0 ? 0 : Math.min(count, 64)); i++)
                {
                    usages.push(host.readCString(dword(list + i * 4), 128));
                }
                // HCCE_CURRENT_USER and HCCE_LOCAL_MACHINE (0 and 1) are the
                // default engine; one CertCreateCertificateChainEngine made
                // adds its stores and may trust a root store of its own.
                const engine = engines.get(engineHandle >>> 0);
                const pool = [...membersOf(context.store),
                    ...(additional >>> 0) === 0 ? [] : membersOf(additional >>> 0),
                    ...(engine?.additional ?? []).flatMap(one=>membersOf(one))];
                const { elements, chainError } = buildChain(address >>> 0,
                    pool.filter(one=>one !== (address >>> 0)), time,
                    { and: kind === 0, usages }, flags >>> 0, engine?.exclusiveRoot);
                // The leaf's element holds a reference of its own, as the others do.
                duplicate(address >>> 0);
                const chain = makeChainContext(elements, chainError, flags >>> 0);
                if (chain === 0)
                {
                    elements.forEach(element=>release(element.address));
                    return fail(ERROR_NOT_ENOUGH_MEMORY);
                }
                setDword(out >>> 0, chain);
                return 1;
            },
        },

        /** PCCERT_CHAIN_CONTEXT CertDuplicateCertificateChain(PCCERT_CHAIN_CONTEXT) */
        CertDuplicateCertificateChain: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [address])=>{
                const chain = chains.get(address >>> 0);
                if (!chain)
                {
                    return 0;
                }
                chain.refs++;
                return address >>> 0;
            },
        },

        /** VOID CertFreeCertificateChain(PCCERT_CHAIN_CONTEXT pChainContext) */
        CertFreeCertificateChain: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [address])=>{
                freeChain(address >>> 0);
                return 0;
            },
        },

        /**
         * BOOL CertVerifyCertificateChainPolicy(LPCSTR pszPolicyOID,
         *     PCCERT_CHAIN_CONTEXT pChainContext, PCERT_CHAIN_POLICY_PARA pPolicyPara,
         *     PCERT_CHAIN_POLICY_STATUS pPolicyStatus)
         *
         * TRUE whenever the policy could be applied; its verdict is in the
         * status's dwError, with the chain and element it is about (-1 when
         * it is about neither).
         */
        CertVerifyCertificateChainPolicy: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [policy, address, parameters, status])=>{
                const chain = chains.get(address >>> 0);
                if (!chain || (status >>> 0) === 0)
                {
                    return fail(E_INVALIDARG);
                }
                const which = policy >>> 0;
                if (!/** @type {number[]} */ (Object.values(POLICY)).includes(which))
                {
                    host.divergence?.('CertVerifyCertificateChainPolicy',
                        `policy ${which} is not provided`);
                    return fail(CRYPT_E_NOT_FOUND);
                }
                const flags = (parameters >>> 0) === 0 ? 0 : dword((parameters >>> 0) + 4);
                const extra = (parameters >>> 0) === 0 ? 0 : dword((parameters >>> 0) + 8);
                let ignore = 0;
                /** @type {string | null} */
                let serverName = null;
                let client = false;
                if (which === POLICY.SSL && extra !== 0)
                {
                    client = dword(extra + 4) === AUTHTYPE_CLIENT;
                    ignore = dword(extra + 8);
                    const name = dword(extra + 12);
                    serverName = name === 0 ? null : host.readWideString(name, 1024 * 2);
                }
                const { errors, error: chainError } = chain;
                /** The first element with `bit`, or -1. @param {number} bit */
                const elementWith = bit=>errors.findIndex(error=>(error & bit) !== 0);
                /** @type {[number, number]} the error and the element it is about */
                let verdict = [0, -1];
                const checks = [
                    [TRUST_ERROR.IS_NOT_SIGNATURE_VALID, TRUST_E_CERT_SIGNATURE, false],
                    [TRUST_ERROR.IS_UNTRUSTED_ROOT, CERT_E_UNTRUSTEDROOT,
                        (flags & POLICY_IGNORE.UNKNOWN_CA) !== 0
                        || (ignore & SSL_IGNORE.UNKNOWN_CA) !== 0],
                    [TRUST_ERROR.IS_CYCLIC | TRUST_ERROR.IS_PARTIAL_CHAIN, CERT_E_CHAINING, false],
                    [TRUST_ERROR.IS_NOT_TIME_VALID, CERT_E_EXPIRED,
                        (flags & POLICY_IGNORE.NOT_TIME_VALID) !== 0
                        || (ignore & SSL_IGNORE.DATE_INVALID) !== 0],
                    [TRUST_ERROR.IS_NOT_VALID_FOR_USAGE, CERT_E_WRONG_USAGE,
                        (flags & POLICY_IGNORE.WRONG_USAGE) !== 0
                        || (ignore & SSL_IGNORE.WRONG_USAGE) !== 0],
                    [TRUST_ERROR.INVALID_BASIC_CONSTRAINTS, TRUST_E_BASIC_CONSTRAINTS, false],
                    [TRUST_ERROR.INVALID_EXTENSION, CERT_E_CRITICAL, false],
                    [TRUST_ERROR.IS_REVOKED, CRYPT_E_REVOKED, false],
                ];
                for (const [bit, code, excused] of checks)
                {
                    if ((chainError & Number(bit)) !== 0 && !excused)
                    {
                        verdict = [Number(code), elementWith(Number(bit))];
                        break;
                    }
                }
                if (verdict[0] === 0 && which === POLICY.SSL)
                {
                    const leaf = contexts.get(chain.elements[0])?.certificate;
                    const offline = (chainError & TRUST_ERROR.REVOCATION_STATUS_UNKNOWN) !== 0
                        && (ignore & SSL_IGNORE.REVOCATION) === 0
                        && (flags & POLICY_IGNORE.ALL_REV_UNKNOWN) === 0;
                    const wanted = client ? TLS_USAGE.CLIENT_AUTH : TLS_USAGE.SERVER_AUTH;
                    if (offline)
                    {
                        verdict = [CRYPT_E_REVOCATION_OFFLINE,
                            elementWith(TRUST_ERROR.REVOCATION_STATUS_UNKNOWN)];
                    }
                    else if (leaf && serverName !== null && (ignore & SSL_IGNORE.CN_INVALID) === 0
                        && !(leaf.dnsNames.length > 0 ? leaf.dnsNames
                            : leaf.commonName !== null ? [leaf.commonName] : [])
                            .some(name=>nameMatches(name, serverName ?? '')))
                    {
                        verdict = [CERT_E_CN_NO_MATCH, 0];
                    }
                    else if (leaf && (ignore & SSL_IGNORE.WRONG_USAGE) === 0
                        && leaf.extendedKeyUsage !== null
                        && !leaf.extendedKeyUsage.includes(wanted)
                        && !leaf.extendedKeyUsage.includes(USAGE.ANY))
                    {
                        verdict = [CERT_E_WRONG_USAGE, 0];
                    }
                }
                setDword((status >>> 0) + 4, verdict[0]);
                setDword((status >>> 0) + 8, verdict[0] === 0 || verdict[1] < 0 ? -1 : 0);
                setDword((status >>> 0) + 12, verdict[0] === 0 ? -1 : verdict[1]);
                return 1;
            },
        },
        /**
         * PCCERT_CONTEXT CertFindCertificateInStore(HCERTSTORE hCertStore,
         *     DWORD dwCertEncodingType, DWORD dwFindFlags, DWORD dwFindType,
         *     const void *pvFindPara, PCCERT_CONTEXT pPrevCertContext)
         *
         * The search goes on after the previous context, which is freed.
         */
        CertFindCertificateInStore: {
            argBytes: 24,
            handler: (/** @type {number[]} */ [handle, , flags, type, para, previous])=>{
                if (!storeOf(handle))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const matches = matcherFor(type >>> 0, para >>> 0, flags >>> 0);
                if (!matches)
                {
                    host.divergence?.('CertFindCertificateInStore',
                        `find type 0x${(type >>> 0).toString(16)} is not provided`);
                    if ((previous >>> 0) !== 0)
                    {
                        release(previous >>> 0);
                    }
                    return fail(CRYPT_E_NOT_FOUND);
                }
                const members = membersOf(handle >>> 0);
                let at = 0;
                if ((previous >>> 0) !== 0)
                {
                    const was = members.indexOf(previous >>> 0);
                    release(previous >>> 0);
                    at = was < 0 ? members.length : was + 1;
                }
                for (; at < members.length; at++)
                {
                    if (matches(members[at]))
                    {
                        return duplicate(members[at]);
                    }
                }
                return fail(CRYPT_E_NOT_FOUND);
            },
        },

        /**
         * DWORD CertGetNameStringA(PCCERT_CONTEXT pCertContext, DWORD dwType,
         *     DWORD dwFlags, void *pvTypePara, LPSTR pszNameString, DWORD cchNameString)
         *
         * The count of characters with the terminator; a name not there is
         * the empty string and 1.
         */
        CertGetNameStringA: getNameString(false),
        CertGetNameStringW: getNameString(true),

        /**
         * BOOL CertGetCertificateContextProperty(PCCERT_CONTEXT pCertContext,
         *     DWORD dwPropId, void *pvData, DWORD *pcbData)
         */
        CertGetCertificateContextProperty: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [address, id, out, size])=>{
                if (!contexts.has(address >>> 0) || (size >>> 0) === 0)
                {
                    return fail(E_INVALIDARG);
                }
                const bytes = propertyBytes(address >>> 0, id >>> 0, out >>> 0);
                if (!bytes)
                {
                    return fail(CRYPT_E_NOT_FOUND);
                }
                return answer(at=>/** @type {Uint8Array} */ (
                    propertyBytes(address >>> 0, id >>> 0, at)), out >>> 0, size >>> 0);
            },
        },

        /**
         * BOOL CertSetCertificateContextProperty(PCCERT_CONTEXT pCertContext,
         *     DWORD dwPropId, DWORD dwFlags, const void *pvData)
         *
         * A NULL pvData removes the property. Every property is a
         * CRYPT_DATA_BLOB but the key provider record, which is kept by its
         * fields so its pointers can be laid out again where it is read.
         */
        CertSetCertificateContextProperty: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [address, id, , data])=>{
                if (!contexts.has(address >>> 0))
                {
                    return fail(E_INVALIDARG);
                }
                const properties = propertiesOf(address >>> 0);
                if ((data >>> 0) === 0)
                {
                    properties.delete(id >>> 0);
                    return 1;
                }
                if ((id >>> 0) === PROP.KEY_PROV_INFO)
                {
                    const at = data >>> 0;
                    const text = (/** @type {number} */ pointer)=>(pointer === 0 ? null
                        : host.readWideString(pointer, 1024 * 2));
                    properties.set(PROP.KEY_PROV_INFO, { container: text(dword(at)),
                        provider: text(dword(at + 4)), type: dword(at + 8),
                        flags: dword(at + 12), keySpec: dword(at + 24) });
                    return 1;
                }
                const length = dword(data >>> 0);
                properties.set(id >>> 0, length === 0 ? new Uint8Array(0)
                    : host.readMemory(dword((data >>> 0) + 4), length).slice());
                return 1;
            },
        },

        /**
         * BOOL CertCompareCertificateName(DWORD dwCertEncodingType,
         *     PCERT_NAME_BLOB pCertName1, PCERT_NAME_BLOB pCertName2)
         */
        CertCompareCertificateName: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [, first, second])=>{
                /** @param {number} at */
                const blob = at=>host.readMemory(dword(at + 4), dword(at)).slice();
                return sameBytes(blob(first >>> 0), blob(second >>> 0)) ? 1 : 0;
            },
        },

        /**
         * LONG CertVerifyTimeValidity(LPFILETIME pTimeToVerify, PCERT_INFO pCertInfo)
         *
         * -1 before the certificate's validity, 1 after it, 0 inside; NULL is now.
         */
        CertVerifyTimeValidity: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [timePointer, info])=>{
                const ticksAt = (/** @type {number} */ at)=>BigInt(dword(at))
                    | (BigInt(dword(at + 4)) << 32n);
                const now = (timePointer >>> 0) !== 0 ? ticksAt(timePointer >>> 0)
                    : (BigInt(Math.round(host.now())) + 11644473600000n) * 10000n;
                if (now < ticksAt((info >>> 0) + 32))
                {
                    return -1;
                }
                return now > ticksAt((info >>> 0) + 40) ? 1 : 0;
            },
        },

        /**
         * BOOL CertGetEnhancedKeyUsage(PCCERT_CONTEXT pCertContext, DWORD dwFlags,
         *     PCERT_ENHKEY_USAGE pUsage, DWORD *pcbUsage)
         *
         * A certificate with no usage restriction answers an empty list and
         * CRYPT_E_NOT_FOUND in the last error: valid for every usage.
         */
        CertGetEnhancedKeyUsage: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [address, flags, out, size])=>{
                const certificate = certificateAt(address);
                if (!certificate || (size >>> 0) === 0)
                {
                    return fail(E_INVALIDARG);
                }
                const fromExtension = ((flags >>> 0) & CERT_FIND_PROP_ONLY_ENHKEY_USAGE_FLAG) !== 0
                    ? null : certificate.extendedKeyUsage;
                const usages = fromExtension ?? [];
                const result = answer(at=>enhancedKeyUsage(usages, at), out >>> 0, size >>> 0);
                if (result === 1 && fromExtension === null)
                {
                    host.setLastError(CRYPT_E_NOT_FOUND);
                }
                return result;
            },
        },

        /**
         * BOOL CertGetIntendedKeyUsage(DWORD dwCertEncodingType, PCERT_INFO pCertInfo,
         *     BYTE *pbKeyUsage, DWORD cbKeyUsage)
         *
         * The key usage extension's bits, from the CERT_INFO's extensions; FALSE
         * with no error when the certificate has none.
         */
        CertGetIntendedKeyUsage: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [, info, out, length])=>{
                const count = dword((info >>> 0) + 104);
                const list = dword((info >>> 0) + 108);
                for (let i = 0; i < Math.min(count, 256); i++)
                {
                    const at = list + i * 16;
                    if (host.readCString(dword(at), 64) !== '2.5.29.15')
                    {
                        continue;
                    }
                    const value = host.readMemory(dword(at + 12), dword(at + 8)).slice();
                    let bits;
                    try
                    {
                        bits = readBitString(readNode(value)).bits;
                    }
                    catch (e){
                        if (!(e instanceof DerError))
                        {
                            throw e;
                        }
                        return fail(CRYPT_E_ASN1_BADTAG);
                    }
                    const written = new Uint8Array(length >>> 0);
                    written.set(bits.subarray(0, written.length));
                    host.writeMemory(out >>> 0, written);
                    return 1;
                }
                if ((length >>> 0) > 0)
                {
                    host.writeMemory(out >>> 0, new Uint8Array(length >>> 0));
                }
                host.setLastError(0);
                return 0;
            },
        },

        /**
         * PCERT_EXTENSION CertFindExtension(LPCSTR pszObjId, DWORD cExtensions,
         *     CERT_EXTENSION rgExtensions[])
         */
        CertFindExtension: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [oid, count, list])=>{
                if ((oid >>> 0) === 0)
                {
                    return fail(E_INVALIDARG);
                }
                const wanted = host.readCString(oid >>> 0, 128);
                for (let i = 0; i < Math.min(count >>> 0, 256); i++)
                {
                    const at = (list >>> 0) + i * 16;
                    if (host.readCString(dword(at), 128) === wanted)
                    {
                        return at;
                    }
                }
                return fail(CRYPT_E_NOT_FOUND);
            },
        },

        /**
         * BOOL CertControlStore(HCERTSTORE hCertStore, DWORD dwFlags, DWORD dwCtrlType,
         *     void const *pvCtrlPara)
         *
         * Nothing changes a store from outside here, so resynchronising has
         * nothing to do and a change notification is never signalled.
         */
        CertControlStore: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [handle, , control])=>{
                if (!storeOf(handle))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                return /** @type {number[]} */ (Object.values(STORE_CTRL)).includes(control >>> 0)
                    ? 1 : fail(ERROR_CALL_NOT_IMPLEMENTED);
            },
        },

        /**
         * BOOL CertCreateCertificateChainEngine(PCERT_CHAIN_ENGINE_CONFIG pConfig,
         *     HCERTCHAINENGINE *phChainEngine)
         *
         * The engine's additional stores join every chain built with it; an
         * exclusive root store (Windows 7's field) stands in for ROOT.
         */
        CertCreateCertificateChainEngine: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [config, out])=>{
                if ((config >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return fail(E_INVALIDARG);
                }
                const at = config >>> 0;
                const size = dword(at);
                const count = dword(at + 16);
                const list = dword(at + 20);
                const hold = (/** @type {number} */ handle)=>{
                    const store = storeOf(handle);
                    if (!store)
                    {
                        return 0;
                    }
                    store.refs++;
                    return handleOf(store);
                };
                const additional = Array.from({ length: Math.min(count, 64) },
                    (_, i)=>hold(dword(list + i * 4))).filter(handle=>handle !== 0);
                const exclusiveRoot = size >= 44 && dword(at + 40) !== 0 ? hold(dword(at + 40)) : 0;
                const engine = nextEngine;
                nextEngine += 4;
                engines.set(engine, { additional, exclusiveRoot });
                setDword(out >>> 0, engine);
                return 1;
            },
        },

        /** VOID CertFreeCertificateChainEngine(HCERTCHAINENGINE hChainEngine) */
        CertFreeCertificateChainEngine: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [handle])=>{
                const engine = engines.get(handle >>> 0);
                if (engine)
                {
                    engines.delete(handle >>> 0);
                    [...engine.additional, engine.exclusiveRoot].filter(one=>one !== 0)
                        .forEach(closeStore);
                }
                return 0;
            },
        },

        /**
         * PCCERT_CHAIN_CONTEXT CertFindChainInStore(HCERTSTORE hCertStore,
         *     DWORD dwCertEncodingType, DWORD dwFindFlags, DWORD dwFindType,
         *     const void *pvFindPara, PCCERT_CHAIN_CONTEXT pPrevChainContext)
         *
         * The one find type is a client certificate with a private key, and no
         * certificate here has one.
         */
        CertFindChainInStore: {
            argBytes: 24,
            handler: (/** @type {number[]} */ [, , , , , previous])=>{
                if ((previous >>> 0) !== 0)
                {
                    freeChain(previous >>> 0);
                }
                return fail(CRYPT_E_NOT_FOUND);
            },
        },

        /**
         * BOOL CryptAcquireCertificatePrivateKey(PCCERT_CONTEXT pCert, DWORD dwFlags,
         *     void *pvParameters, HCRYPTPROV_OR_NCRYPT_KEY_HANDLE *phCryptProvOrNCryptKey,
         *     DWORD *pdwKeySpec, BOOL *pfCallerFreeProvOrNCryptKey)
         *
         * No key container holds a private key on this machine.
         */
        CryptAcquireCertificatePrivateKey: {
            argBytes: 24,
            handler: ()=>fail(CRYPT_E_NO_KEY_PROPERTY),
        },

        /**
         * PCCERT_CONTEXT CertCreateSelfSignCertificate(HCRYPTPROV_OR_NCRYPT_KEY_HANDLE,
         *     PCERT_NAME_BLOB, DWORD, PCRYPT_KEY_PROV_INFO, PCRYPT_ALGORITHM_IDENTIFIER,
         *     PSYSTEMTIME, PSYSTEMTIME, PCERT_EXTENSIONS)
         *
         * Making one needs a key pair this machine cannot generate.
         */
        CertCreateSelfSignCertificate: {
            argBytes: 32,
            handler: ()=>{
                host.divergence?.('CertCreateSelfSignCertificate',
                    'no key pair can be generated: refused as a provider without the algorithm');
                return fail(NTE_NOT_SUPPORTED);
            },
        },

        /**
         * HCERTSTORE PFXImportCertStore(CRYPT_DATA_BLOB *pPFX, LPCWSTR szPassword, DWORD dwFlags)
         *
         * A PFX's bags are sealed with password-based ciphers this build does
         * not carry, so none is opened.
         */
        PFXImportCertStore: {
            argBytes: 12,
            handler: ()=>{
                host.divergence?.('PFXImportCertStore', 'PKCS #12 files are not opened');
                return fail(NTE_BAD_DATA);
            },
        },

        /**
         * BOOL CryptQueryObject(DWORD dwObjectType, const void *pvObject,
         *     DWORD dwExpectedContentTypeFlags, DWORD dwExpectedFormatTypeFlags,
         *     DWORD dwFlags, DWORD *pdwMsgAndCertEncodingType, DWORD *pdwContentType,
         *     DWORD *pdwFormatType, HCERTSTORE *phCertStore, HCRYPTMSG *phMsg,
         *     const void **ppvContext)
         *
         * A certificate (DER or base64), a PKCS #7 SignedData, or the one a
         * signed PE image carries; the store holds the certificates found and
         * the message answers CryptMsgGetParam.
         */
        CryptQueryObject: {
            argBytes: 44,
            handler: (/** @type {number[]} */ [objectType, object, contentTypes, formatTypes, ,
                encodingOut, contentOut, formatOut, storeOut, messageOut, contextOut])=>{
                /** @type {Uint8Array | null} */
                let bytes;
                if ((objectType >>> 0) === QUERY_OBJECT.BLOB)
                {
                    const size = dword(object >>> 0);
                    bytes = size === 0 ? new Uint8Array(0)
                        : host.readMemory(dword((object >>> 0) + 4), size).slice();
                }
                else if ((objectType >>> 0) === QUERY_OBJECT.FILE)
                {
                    bytes = host.readFile?.(host.readWideString(object >>> 0, 1024 * 2)) ?? null;
                    if (!bytes)
                    {
                        return fail(ERROR_FILE_NOT_FOUND);
                    }
                }
                else
                {
                    return fail(E_INVALIDARG);
                }
                const found = queryContent(bytes, contentTypes >>> 0, formatTypes >>> 0);
                if (!found)
                {
                    return fail(CRYPT_E_NO_MATCH);
                }
                /** @param {number} at @param {number} value */
                const put = (at, value)=>{
                    if ((at >>> 0) !== 0)
                    {
                        setDword(at >>> 0, value);
                    }
                };
                put(encodingOut, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING);
                put(contentOut, found.type);
                put(formatOut, found.format);
                const certificates = 'certificate' in found && found.certificate
                    ? [found.certificate] : found.signed?.certificates ?? [];
                if ((storeOut >>> 0) !== 0)
                {
                    const store = handleOf({ refs: 1, held: [] });
                    for (const certificate of certificates)
                    {
                        const address = makeContext(certificate, store);
                        if (address !== 0)
                        {
                            /** @type {Store} */ (storeOf(store)).held.push(address);
                        }
                    }
                    setDword(storeOut >>> 0, store);
                }
                if ((messageOut >>> 0) !== 0)
                {
                    if (found.signed && found.message)
                    {
                        const handle = nextMessage;
                        nextMessage += 4;
                        messages.set(handle, { ...found.signed, der: found.message });
                        setDword(messageOut >>> 0, handle);
                    }
                    else
                    {
                        setDword(messageOut >>> 0, 0);
                    }
                }
                if ((contextOut >>> 0) !== 0)
                {
                    setDword(contextOut >>> 0, found.type === CONTENT.CERT
                        ? makeContext(certificates[0], 0) : 0);
                }
                return 1;
            },
        },

        /**
         * BOOL CryptMsgGetParam(HCRYPTMSG hCryptMsg, DWORD dwParamType, DWORD dwIndex,
         *     void *pvData, DWORD *pcbData)
         *
         * The message's type, content, counts, its certificates by index and a
         * signer's issuer and serial number (CERT_INFO with those two filled).
         */
        CryptMsgGetParam: {
            argBytes: 20,
            handler: (/** @type {number[]} */ [handle, type, index, out, size])=>{
                const message = messages.get(handle >>> 0);
                if (!message || (size >>> 0) === 0)
                {
                    return fail(E_INVALIDARG);
                }
                const word = (/** @type {number} */ value)=>{
                    const bytes = new Uint8Array(4);
                    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
                    return bytes;
                };
                switch (type >>> 0)
                {
                    case MSG_PARAM.TYPE:
                        return answer(word(CMSG_SIGNED), out >>> 0, size >>> 0);
                    case MSG_PARAM.CONTENT:
                        return answer(message.content ? contentsOf(message.content)
                            : new Uint8Array(0), out >>> 0, size >>> 0);
                    case MSG_PARAM.SIGNER_COUNT:
                        return answer(word(message.signers.length), out >>> 0, size >>> 0);
                    case MSG_PARAM.CERT_COUNT:
                        return answer(word(message.certificates.length), out >>> 0, size >>> 0);
                    case MSG_PARAM.CERT: {
                        const certificate = message.certificates[index >>> 0];
                        return certificate ? answer(certificate.encoded, out >>> 0, size >>> 0)
                            : fail(CRYPT_E_INVALID_INDEX);
                    }
                    case MSG_PARAM.SIGNER_CERT_INFO: {
                        const signer = message.signers[index >>> 0];
                        if (!signer)
                        {
                            return fail(CRYPT_E_INVALID_INDEX);
                        }
                        return answer(at=>{
                            const serial = Uint8Array.from(signer.serial).reverse();
                            const out2 = new Uint8Array(CERT_INFO_SIZE + serial.length
                                + signer.issuer.length);
                            const view = new DataView(out2.buffer);
                            view.setUint32(4, serial.length, true);
                            view.setUint32(8, at + CERT_INFO_SIZE, true);
                            view.setUint32(24, signer.issuer.length, true);
                            view.setUint32(28, at + CERT_INFO_SIZE + serial.length, true);
                            out2.set(serial, CERT_INFO_SIZE);
                            out2.set(signer.issuer, CERT_INFO_SIZE + serial.length);
                            return out2;
                        }, out >>> 0, size >>> 0);
                    }
                    default:
                        host.divergence?.('CryptMsgGetParam',
                            `parameter ${type >>> 0} is not kept`);
                        return fail(CRYPT_E_INVALID_MSG_TYPE);
                }
            },
        },

        /** BOOL CryptMsgClose(HCRYPTMSG hCryptMsg); TRUE for NULL. */
        CryptMsgClose: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [handle])=>{
                messages.delete(handle >>> 0);
                return 1;
            },
        },

        /**
         * BOOL CryptVerifyCertificateSignatureEx(HCRYPTPROV_LEGACY hCryptProv,
         *     DWORD dwCertEncodingType, DWORD dwSubjectType, void *pvSubject,
         *     DWORD dwIssuerType, void *pvIssuer, DWORD dwFlags, void *pvExtra)
         *
         * The subject an encoded signed structure or a certificate context;
         * the issuer a public key, a certificate or a chain's next element.
         * RSA signatures only.
         */
        CryptVerifyCertificateSignatureEx: {
            argBytes: 32,
            handler: (/** @type {number[]} */ [, , subjectType, subject, issuerType, issuer])=>{
                /** @type {Uint8Array | null} */
                let signed = null;
                if ((subjectType >>> 0) === VERIFY_SUBJECT.BLOB)
                {
                    signed = host.readMemory(dword((subject >>> 0) + 4),
                        dword(subject >>> 0)).slice();
                }
                else if ((subjectType >>> 0) === VERIFY_SUBJECT.CERT)
                {
                    signed = certificateAt(subject)?.encoded ?? null;
                }
                const parts = signed ? signedParts(signed) : null;
                if (!parts)
                {
                    return fail(E_INVALIDARG);
                }
                /** @type {import('../crypto/signature.js').RsaKey | null} */
                let key;
                switch (issuerType >>> 0)
                {
                    case VERIFY_ISSUER.PUBKEY: {
                        // CERT_PUBLIC_KEY_INFO: the algorithm (12 bytes), then the key's bits.
                        const bits = host.readMemory(dword((issuer >>> 0) + 16),
                            dword((issuer >>> 0) + 12)).slice();
                        key = rsaKeyFromBits(bits);
                        break;
                    }
                    case VERIFY_ISSUER.CERT:
                        key = certificateAt(issuer)?.publicKey ?? null;
                        break;
                    case VERIFY_ISSUER.CHAIN:
                        // CERT_CHAIN_ELEMENT: its context at +4.
                        key = certificateAt(dword((issuer >>> 0) + 4))?.publicKey ?? null;
                        break;
                    default:
                        return fail(E_INVALIDARG);
                }
                if (!key)
                {
                    return fail(NTE_BAD_ALGID);
                }
                return verifySigned(key, parts.algorithm, parts.tbs, parts.signature)
                    ? 1 : fail(NTE_BAD_SIGNATURE);
            },
        },
    };
}
