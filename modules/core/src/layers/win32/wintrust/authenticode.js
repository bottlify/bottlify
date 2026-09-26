/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Authenticode verification, the policy WinVerifyTrust applies under
 * WINTRUST_ACTION_GENERIC_VERIFY_V2, as Microsoft's "Windows Authenticode
 * Portable Executable Signature Format" describes it:
 *
 * 1. the file's own digest is the one SpcIndirectDataContent states, and the
 *    one signer signed that content with the certificate it names;
 * 2. a timestamp -- a PKCS #9 countersignature over the signer's encrypted
 *    digest -- holds, its certificate chains to a trusted root at the time it
 *    states and may time-stamp;
 * 3. the publisher's certificate chains to a trusted root and may sign code, at
 *    the timestamp's time when there is one, now when there is none.
 *
 * The integrity of the file is judged before the certificates, as Windows
 * does: a changed file is TRUST_E_BAD_DIGEST whatever its chain would have
 * said (Wine's wintrust tests, test_wintrust_digest). Revocation is not
 * checked: this machine has no network path to a CRL.
 */

import { childrenOf, contents, DerError, expect, readOid, TAG } from '../crypto/der.js';
import {
    checkSigner, parseSignedData, parseSignerInfo, PKCS7, signedContent, signerCertificate,
    signingTime,
} from '../crypto/pkcs7.js';
import { isSelfIssued, isSignedBy, sameBytes, USAGE } from '../crypto/x509.js';
import { readSubject } from './subject.js';

/** @typedef {import('../crypto/x509.js').Certificate} Certificate */

/** WinVerifyTrust's answers, as wintrust's headers number them. */
export const TRUST = Object.freeze({
    OK: 0,
    NTE_BAD_SIGNATURE: 0x80090006,
    NTE_BAD_ALGID: 0x80090008,
    TRUST_E_NO_SIGNER_CERT: 0x80096002,
    TRUST_E_COUNTER_SIGNER: 0x80096003,
    TRUST_E_CERT_SIGNATURE: 0x80096004,
    TRUST_E_TIME_STAMP: 0x80096005,
    TRUST_E_BAD_DIGEST: 0x80096010,
    TRUST_E_BASIC_CONSTRAINTS: 0x80096019,
    TRUST_E_SUBJECT_FORM_UNKNOWN: 0x800b0003,
    TRUST_E_NOSIGNATURE: 0x800b0100,
    CERT_E_EXPIRED: 0x800b0101,
    CERT_E_CRITICAL: 0x800b0105,
    CERT_E_UNTRUSTEDROOT: 0x800b0109,
    CERT_E_CHAINING: 0x800b010a,
    CERT_E_WRONG_USAGE: 0x800b0110,
});

const SPC_INDIRECT_DATA = '1.3.6.1.4.1.311.2.1.4';

/** Chains longer than this are not built; no real one comes near it. */
const MAX_CHAIN = 16;

/**
 * @typedef {Object} TrustOptions
 * @property {Certificate[]} roots   The trusted roots.
 * @property {number} now            Milliseconds since 1970: the machine's time.
 * @property {boolean} [hashOnly]    WTD_HASH_ONLY_FLAG: the file's digest alone.
 * @property {boolean} [lifetime]    WTD_LIFETIME_SIGNING_FLAG: judged now, timestamp or not.
 */

/**
 * The chain from `leaf` up to a root, built from the certificates the message
 * carried and the trusted roots: an issuer is found by name and must have
 * signed the certificate below it. A trusted root ends the chain as it is; its
 * own signature is not what makes it trusted.
 *
 * @param {Certificate} leaf
 * @param {Certificate[]} pool
 * @param {Certificate[]} roots
 * @returns {{ chain: Certificate[], status: number }}
 */
function buildChain(leaf, pool, roots){
    const chain = [leaf];
    /** @param {Certificate} certificate */
    const trusted = certificate=>roots.some(root=>sameBytes(root.encoded, certificate.encoded)
        || (sameBytes(root.subject, certificate.subject) && root.publicKey !== null
            && certificate.publicKey !== null && root.publicKey.n === certificate.publicKey.n));
    for (let current = leaf; chain.length <= MAX_CHAIN;)
    {
        if (trusted(current))
        {
            return { chain, status: TRUST.OK };
        }
        if (isSelfIssued(current))
        {
            return { chain, status: isSignedBy(current, current.publicKey)
                ? TRUST.CERT_E_UNTRUSTEDROOT : TRUST.TRUST_E_CERT_SIGNATURE };
        }
        const named = [...roots, ...pool].filter(candidate=>!chain.includes(candidate)
            && sameBytes(candidate.subject, current.issuer));
        if (named.length === 0)
        {
            return { chain, status: TRUST.CERT_E_CHAINING };
        }
        const issuer = named.find(candidate=>isSignedBy(current, candidate.publicKey));
        if (!issuer)
        {
            return { chain, status: TRUST.TRUST_E_CERT_SIGNATURE };
        }
        chain.push(issuer);
        current = issuer;
    }
    return { chain, status: TRUST.CERT_E_CHAINING };
}

/**
 * Whether a chain allows `usage`: every certificate that restricts its
 * extended key usage must allow it (or any usage). A chain that restricts
 * nothing allows everything.
 *
 * @param {Certificate[]} chain
 * @param {string} usage
 */
const allowsUsage = (chain, usage)=>chain.every(certificate=>
    certificate.extendedKeyUsage === null
    || certificate.extendedKeyUsage.includes(usage)
    || certificate.extendedKeyUsage.includes(USAGE.ANY));

/**
 * Builds and judges a chain at `time` for `usage`: an issuer that is not a CA,
 * a critical extension not understood, a certificate outside its validity, a
 * usage not allowed -- in that order after the chain itself.
 *
 * @param {Certificate} leaf
 * @param {Certificate[]} pool
 * @param {Certificate[]} roots
 * @param {number} time
 * @param {string} usage
 */
export function judgeChain(leaf, pool, roots, time, usage){
    const { chain, status } = buildChain(leaf, pool, roots);
    if (status !== TRUST.OK)
    {
        return status;
    }
    if (chain.slice(1).some(issuer=>issuer.basicConstraints !== null
        && !issuer.basicConstraints.ca))
    {
        return TRUST.TRUST_E_BASIC_CONSTRAINTS;
    }
    if (chain.some(certificate=>certificate.unknownCritical.length > 0))
    {
        return TRUST.CERT_E_CRITICAL;
    }
    if (chain.some(certificate=>time < certificate.notBefore || time > certificate.notAfter))
    {
        return TRUST.CERT_E_EXPIRED;
    }
    return allowsUsage(chain, usage) ? TRUST.OK : TRUST.CERT_E_WRONG_USAGE;
}

/**
 * The digest algorithm and value SpcIndirectDataContent states for the file.
 *
 * @param {import('../crypto/der.js').DerNode} content
 */
function statedDigest(content){
    const [, digestInfo] = childrenOf(expect(content, TAG.SEQUENCE, 'SpcIndirectDataContent'));
    const [algorithm, digest] = childrenOf(expect(digestInfo, TAG.SEQUENCE, 'a DigestInfo'));
    return {
        algorithm: readOid(childrenOf(algorithm)[0]),
        value: contents(expect(digest, TAG.OCTET_STRING, 'a digest')),
    };
}

/**
 * WinVerifyTrust's answer for a file under the Authenticode policy.
 *
 * @param {Uint8Array} bytes
 * @param {TrustOptions} options
 * @returns {number}
 */
export function verifyAuthenticode(bytes, options){
    const subject = readSubject(bytes);
    if (!subject)
    {
        return TRUST.TRUST_E_SUBJECT_FORM_UNKNOWN;
    }
    if (!subject.signature)
    {
        return TRUST.TRUST_E_NOSIGNATURE;
    }
    let signed;
    let stated;
    try
    {
        signed = parseSignedData(subject.signature);
        if (signed.contentType !== SPC_INDIRECT_DATA || !signed.content
            || signed.signers.length !== 1)
        {
            return TRUST.TRUST_E_NOSIGNATURE;
        }
        stated = statedDigest(signed.content);
    }
    catch (e){
        if (e instanceof DerError)
        {
            return TRUST.TRUST_E_NOSIGNATURE;
        }
        throw e;
    }
    const actual = subject.digest(stated.algorithm);
    if (!actual)
    {
        return TRUST.NTE_BAD_ALGID;
    }
    if (!sameBytes(actual, stated.value))
    {
        return TRUST.TRUST_E_BAD_DIGEST;
    }
    if (options.hashOnly)
    {
        return TRUST.OK;
    }

    const [signer] = signed.signers;
    const certificate = signerCertificate(signed.certificates, signer);
    if (!certificate)
    {
        return TRUST.TRUST_E_NO_SIGNER_CERT;
    }
    const checked = checkSigner(signer, certificate.publicKey, signedContent(signed.content));
    if (checked !== 'ok')
    {
        return checked === 'digest' ? TRUST.TRUST_E_BAD_DIGEST
            : checked === 'signature' ? TRUST.NTE_BAD_SIGNATURE : TRUST.NTE_BAD_ALGID;
    }

    let time = options.now;
    const countersignature = signer.unauthenticated.get(PKCS7.COUNTER_SIGNATURE)?.[0];
    if (countersignature)
    {
        let countersigner;
        try
        {
            countersigner = parseSignerInfo(countersignature);
        }
        catch (e){
            if (e instanceof DerError)
            {
                return TRUST.TRUST_E_TIME_STAMP;
            }
            throw e;
        }
        const authority = signerCertificate(signed.certificates, countersigner);
        if (!authority || checkSigner(countersigner, authority.publicKey,
            signer.encryptedDigest) !== 'ok')
        {
            return TRUST.TRUST_E_COUNTER_SIGNER;
        }
        const stamped = signingTime(countersigner);
        if (stamped === null)
        {
            return TRUST.TRUST_E_TIME_STAMP;
        }
        const timestamp = judgeChain(authority, signed.certificates, options.roots, stamped,
            USAGE.TIME_STAMPING);
        if (timestamp !== TRUST.OK)
        {
            return timestamp;
        }
        const lifetime = options.lifetime
            || certificate.extendedKeyUsage?.includes(USAGE.LIFETIME_SIGNING);
        time = lifetime ? options.now : stamped;
    }
    return judgeChain(certificate, signed.certificates, options.roots, time, USAGE.CODE_SIGNING);
}

