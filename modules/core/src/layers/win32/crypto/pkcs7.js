/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * PKCS #7 SignedData (RFC 2315): the content, the certificates that came with
 * it and each signer's statement about it -- and whether a signer's statement
 * holds, as section 9.3 of the standard defines it.
 */

import {
    childrenOf, context, contents, DerError, encoding, expect, readInteger, readNode, readOid,
    readTime, TAG,
} from './der.js';
import { digestOf, digestOfSignatureAlgorithm, OID, verifyPkcs1 } from './signature.js';
import { parseCertificate, sameBytes } from './x509.js';

/** @typedef {import('./der.js').DerNode} DerNode */
/** @typedef {import('./x509.js').Certificate} Certificate */
/** @typedef {import('./signature.js').RsaKey} RsaKey */

/** Content types and attributes, as PKCS #7 and PKCS #9 number them. */
export const PKCS7 = Object.freeze({
    DATA: '1.2.840.113549.1.7.1',
    SIGNED_DATA: '1.2.840.113549.1.7.2',
    CONTENT_TYPE: '1.2.840.113549.1.9.3',
    MESSAGE_DIGEST: '1.2.840.113549.1.9.4',
    SIGNING_TIME: '1.2.840.113549.1.9.5',
    COUNTER_SIGNATURE: '1.2.840.113549.1.9.6',
});

/**
 * @typedef {Object} Attributes
 * @property {Uint8Array} signed        What the signer signed: the attributes
 *   re-encoded as the SET OF they are, not the [0] they are tagged with here.
 * @property {Map<string, DerNode[]>} values
 */

/**
 * @typedef {Object} SignerInfo
 * @property {Uint8Array} issuer          The signer certificate's issuer Name, as encoded.
 * @property {Uint8Array} serial          Its serial number's contents octets.
 * @property {string} digestAlgorithm
 * @property {Attributes | null} authenticated
 * @property {string} encryptionAlgorithm
 * @property {Uint8Array} encryptedDigest
 * @property {Map<string, DerNode[]>} unauthenticated
 */

/**
 * @typedef {Object} SignedData
 * @property {string[]} digestAlgorithms
 * @property {string} contentType
 * @property {DerNode | null} content      The content itself, inside its [0] EXPLICIT.
 * @property {Certificate[]} certificates  The ones this build can read; others are passed over.
 * @property {SignerInfo[]} signers
 */

/**
 * @param {DerNode} node  A [0] or [1] IMPLICIT SET OF Attribute.
 * @returns {Map<string, DerNode[]>}
 */
function readAttributes(node){
    /** @type {Map<string, DerNode[]>} */
    const values = new Map();
    for (const attribute of childrenOf(node))
    {
        const [type, set] = childrenOf(expect(attribute, TAG.SEQUENCE, 'an attribute'));
        values.set(readOid(type), childrenOf(expect(set, TAG.SET, 'attribute values')));
    }
    return values;
}

/**
 * Reads one SignerInfo -- a publisher's, or a countersigner's inside it.
 *
 * @param {DerNode} node
 * @returns {SignerInfo}
 */
export function parseSignerInfo(node){
    const fields = childrenOf(expect(node, TAG.SEQUENCE, 'a SignerInfo'));
    let at = 1; // past the version
    const [issuer, serial] = childrenOf(expect(fields[at++], TAG.SEQUENCE,
        'an issuer and serial number'));
    const digestAlgorithm = readOid(childrenOf(fields[at++])[0]);
    /** @type {Attributes | null} */
    let authenticated = null;
    if (fields[at]?.tag === context(0))
    {
        const signed = encoding(fields[at]).slice();
        signed[0] = TAG.SET;
        authenticated = { signed, values: readAttributes(fields[at]) };
        at++;
    }
    const encryptionAlgorithm = readOid(childrenOf(fields[at++])[0]);
    const encryptedDigest = contents(expect(fields[at++], TAG.OCTET_STRING,
        'an encrypted digest'));
    const unauthenticated = fields[at]?.tag === context(1) ? readAttributes(fields[at]) : new Map();
    return {
        issuer: encoding(expect(issuer, TAG.SEQUENCE, 'an issuer')),
        serial: contents(expect(serial, TAG.INTEGER, 'a serial number')),
        digestAlgorithm,
        authenticated,
        encryptionAlgorithm,
        encryptedDigest,
        unauthenticated,
    };
}

/**
 * Reads a ContentInfo holding SignedData.
 *
 * @param {Uint8Array} der
 * @returns {SignedData}
 * @throws {DerError} when it is not one.
 */
export function parseSignedData(der){
    const [type, wrapped] = childrenOf(expect(readNode(der), TAG.SEQUENCE, 'a ContentInfo'));
    if (readOid(type) !== PKCS7.SIGNED_DATA)
    {
        throw new DerError('a ContentInfo that is not SignedData');
    }
    const fields = childrenOf(expect(childrenOf(expect(wrapped, context(0), 'content'))[0],
        TAG.SEQUENCE, 'SignedData'));
    readInteger(fields[0]);
    const digestAlgorithms = childrenOf(expect(fields[1], TAG.SET, 'digest algorithms'))
        .map(algorithm=>readOid(childrenOf(algorithm)[0]));
    const [contentType, explicit] = childrenOf(expect(fields[2], TAG.SEQUENCE, 'content'));
    const content = explicit
        ? childrenOf(expect(explicit, context(0), 'content'))[0] ?? null : null;
    let at = 3;
    /** @type {Certificate[]} */
    const certificates = [];
    if (fields[at]?.tag === context(0))
    {
        for (const choice of childrenOf(fields[at]))
        {
            if (choice.tag !== TAG.SEQUENCE)
            {
                continue; // an extended or attribute certificate
            }
            try
            {
                certificates.push(parseCertificate(encoding(choice)));
            }
            catch (e){
                if (!(e instanceof DerError))
                {
                    throw e;
                }
            }
        }
        at++;
    }
    if (fields[at]?.tag === context(1))
    {
        at++; // revocation lists
    }
    const signers = childrenOf(expect(fields[at], TAG.SET, 'signer infos')).map(parseSignerInfo);
    return { digestAlgorithms, contentType: readOid(contentType), content, certificates, signers };
}

/**
 * The certificate a signer names by issuer and serial number.
 *
 * @param {Certificate[]} certificates
 * @param {SignerInfo} signer
 */
export function signerCertificate(certificates, signer){
    return certificates.find(certificate=>sameBytes(certificate.issuer, signer.issuer)
        && sameBytes(certificate.serial, signer.serial)) ?? null;
}

/**
 * The bytes a signer's message digest covers: the contents octets of the
 * content's encoding (RFC 2315, 9.3) -- a data content's octets, or any other
 * content's value without the tag and length in front.
 *
 * @param {DerNode} content
 */
export const signedContent = content=>contents(content);

/**
 * Checks a signer's statement against the bytes it covers:
 *
 * - `'ok'`: the digest of `covered` is the one the signer signed, and the
 *   signature is `key`'s;
 * - `'digest'`: the authenticated attributes' message digest is not the
 *   digest of `covered`;
 * - `'signature'`: the signature does not verify under `key`;
 * - `'unsupported'`: an algorithm this build does not have.
 *
 * @param {SignerInfo} signer
 * @param {RsaKey | null} key
 * @param {Uint8Array} covered
 * @returns {'ok' | 'digest' | 'signature' | 'unsupported'}
 */
export function checkSigner(signer, key, covered){
    const hash = digestOf(signer.digestAlgorithm, covered);
    const rsa = signer.encryptionAlgorithm === OID.RSA
        || digestOfSignatureAlgorithm(signer.encryptionAlgorithm) !== null;
    if (!hash || !key || !rsa)
    {
        return 'unsupported';
    }
    let signedHash = hash;
    if (signer.authenticated)
    {
        const stated = signer.authenticated.values.get(PKCS7.MESSAGE_DIGEST)?.[0];
        if (!stated || stated.tag !== TAG.OCTET_STRING || !sameBytes(contents(stated), hash))
        {
            return 'digest';
        }
        signedHash = /** @type {Uint8Array} */ (digestOf(signer.digestAlgorithm,
            signer.authenticated.signed));
    }
    return verifyPkcs1(key, signer.digestAlgorithm, signedHash, signer.encryptedDigest)
        ? 'ok' : 'signature';
}

/**
 * The signing time a signer's authenticated attributes state, or null.
 *
 * @param {SignerInfo} signer
 */
export function signingTime(signer){
    const value = signer.authenticated?.values.get(PKCS7.SIGNING_TIME)?.[0];
    return value ? readTime(value) : null;
}
