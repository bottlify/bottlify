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

import { DerError } from '../crypto/der.js';
import { isSelfIssued, isSignedBy, parseCertificate, sameBytes, USAGE, TLS_USAGE }
    from '../crypto/x509.js';

/** @typedef {import('../crypto/x509.js').Certificate} Certificate */

const ERROR_INVALID_PARAMETER = 87;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const E_INVALIDARG = 0x80070057;
const CRYPT_E_NOT_FOUND = 0x80092004;
const CRYPT_E_EXISTS = 0x80092005;
const CRYPT_E_ASN1_BADTAG = 0x8009310b;
const ERROR_INVALID_HANDLE = 6;

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

    /** The ROOT store's contexts, the trust anchors. */
    const anchors = ()=>{
        const handle = systemStore('ROOT');
        const out = membersOf(handle).flatMap(address=>{
            const certificate = contexts.get(address)?.certificate;
            return certificate ? [{ address, certificate }] : [];
        });
        closeStore(handle);
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
     */
    const buildChain = (leafAddress, pool, time, usage, flags)=>{
        const roots = anchors();
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
            handler: (/** @type {number[]} */ [, address, timePointer, additional, parameters,
                flags, , out])=>{
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
                const pool = [...membersOf(context.store),
                    ...(additional >>> 0) === 0 ? [] : membersOf(additional >>> 0)];
                const { elements, chainError } = buildChain(address >>> 0,
                    pool.filter(one=>one !== (address >>> 0)), time,
                    { and: kind === 0, usages }, flags >>> 0);
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
                const chain = chains.get(address >>> 0);
                if (chain && --chain.refs <= 0)
                {
                    chains.delete(address >>> 0);
                    chain.elements.forEach(release);
                    host.localFree(address >>> 0);
                }
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
    };
}
