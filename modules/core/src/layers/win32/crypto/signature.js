/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The algorithms a certificate or a signed message names by object identifier,
 * and the RSA PKCS#1 v1.5 check (RFC 8017, 8.2.2) every signature here goes
 * through.
 */

import { childrenOf, contents, DerError, expect, readNode, readOid, TAG } from './der.js';
import { createMd5, createSha1, createSha256 } from './digest.js';
import { beToBigInt, bigIntToBe, modPow } from './rsa.js';

/** @typedef {import('./digest.js').Digest} Digest */

/** The object identifiers this build knows an algorithm for. */
export const OID = Object.freeze({
    MD5: '1.2.840.113549.2.5',
    SHA1: '1.3.14.3.2.26',
    SHA256: '2.16.840.1.101.3.4.2.1',
    RSA: '1.2.840.113549.1.1.1',
    MD5_RSA: '1.2.840.113549.1.1.4',
    SHA1_RSA: '1.2.840.113549.1.1.5',
    SHA256_RSA: '1.2.840.113549.1.1.11',
    // The OIW spelling of SHA-1 with RSA, still found in older certificates.
    SHA1_RSA_OIW: '1.3.14.3.2.29',
});

/** @type {Map<string, () => Digest>} */
const DIGESTS = new Map([
    [OID.MD5, createMd5],
    [OID.SHA1, createSha1],
    [OID.SHA256, createSha256],
]);

/**
 * The digest each signature algorithm hashes with.
 *
 * @type {Map<string, string>}
 */
const SIGNATURE_DIGESTS = new Map([
    [OID.MD5_RSA, OID.MD5],
    [OID.SHA1_RSA, OID.SHA1],
    [OID.SHA1_RSA_OIW, OID.SHA1],
    [OID.SHA256_RSA, OID.SHA256],
]);

/**
 * A fresh digest for a digest algorithm, or null for one this build does not know.
 *
 * @param {string} oid
 * @returns {Digest | null}
 */
export function createDigestFor(oid){
    return DIGESTS.get(oid)?.() ?? null;
}

/**
 * The digest of `bytes` under a digest algorithm, or null for one not known.
 *
 * @param {string} oid
 * @param {Uint8Array} bytes
 */
export function digestOf(oid, bytes){
    const digest = createDigestFor(oid);
    if (!digest)
    {
        return null;
    }
    digest.update(bytes);
    return digest.digest();
}

/**
 * The digest algorithm a signature algorithm hashes with, or null when it
 * names none (rsaEncryption, whose digest the signer states elsewhere) or is
 * not known.
 *
 * @param {string} oid
 * @returns {string | null}
 */
export const digestOfSignatureAlgorithm = oid=>SIGNATURE_DIGESTS.get(oid) ?? null;

/**
 * @typedef {Object} RsaKey
 * @property {bigint} n
 * @property {bigint} e
 * @property {number} size  The modulus's length in bytes.
 */

/** @param {Uint8Array} a @param {Uint8Array} b */
const equalBytes = (a, b)=>a.length === b.length && a.every((byte, i)=>byte === b[i]);

/**
 * Whether `signature` is `key`'s PKCS#1 v1.5 signature of `hash` under the
 * digest algorithm `digestOid`: 00 01, at least eight FF, 00, and a DigestInfo
 * naming that algorithm and holding that hash, filling the block exactly. The
 * DigestInfo's parameters may be NULL or absent, both of which signers produce.
 *
 * @param {RsaKey} key
 * @param {string} digestOid
 * @param {Uint8Array} hash
 * @param {Uint8Array} signature
 * @returns {boolean}
 */
export function verifyPkcs1(key, digestOid, hash, signature){
    if (signature.length === 0 || signature.length > key.size)
    {
        return false;
    }
    const value = beToBigInt(signature);
    if (value >= key.n)
    {
        return false;
    }
    const block = bigIntToBe(modPow(value, key.e, key.n), key.size);
    if (block[0] !== 0 || block[1] !== 1)
    {
        return false;
    }
    let at = 2;
    while (at < block.length && block[at] === 0xff)
    {
        at++;
    }
    if (at - 2 < 8 || block[at] !== 0)
    {
        return false;
    }
    try
    {
        const info = readNode(block, at + 1);
        if (info.end !== block.length)
        {
            return false;
        }
        const [algorithm, digest] = childrenOf(expect(info, TAG.SEQUENCE, 'a DigestInfo'));
        const [oid, parameters] = childrenOf(expect(algorithm, TAG.SEQUENCE, 'an algorithm'));
        if (readOid(oid) !== digestOid || (parameters && parameters.tag !== TAG.NULL))
        {
            return false;
        }
        return equalBytes(contents(expect(digest, TAG.OCTET_STRING, 'a digest')), hash);
    }
    catch (e){
        if (e instanceof DerError)
        {
            return false;
        }
        throw e;
    }
}

/**
 * Whether `signature` is `key`'s signature of `data` under a signature
 * algorithm that names its digest (md5/sha1/sha256WithRSAEncryption).
 *
 * @param {RsaKey} key
 * @param {string} algorithmOid
 * @param {Uint8Array} data
 * @param {Uint8Array} signature
 */
export function verifySigned(key, algorithmOid, data, signature){
    const digestOid = digestOfSignatureAlgorithm(algorithmOid);
    const hash = digestOid && digestOf(digestOid, data);
    return !!hash && verifyPkcs1(key, /** @type {string} */ (digestOid), hash, signature);
}
