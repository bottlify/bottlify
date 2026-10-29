/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * X.509 certificates as RFC 5280 lays them out: the parts a chain is built
 * and judged from, each kept as the bytes it was encoded in where a comparison
 * or a signature needs them (names are matched as encoded, the to-be-signed
 * part is verified as encoded).
 */

import {
    childrenOf, context, contents, DerError, encoding, expect, readBitString, readBoolean,
    readInteger, readNode, readOid, readString, readTime, readUnsigned, TAG,
} from './der.js';
import { beToBigInt } from './rsa.js';
import { OID, verifySigned } from './signature.js';

/** @typedef {import('./der.js').DerNode} DerNode */
/** @typedef {import('./signature.js').RsaKey} RsaKey */

/** Extensions this build reads. */
export const EXTENSION = Object.freeze({
    KEY_USAGE: '2.5.29.15',
    BASIC_CONSTRAINTS: '2.5.29.19',
    EXTENDED_KEY_USAGE: '2.5.29.37',
    SUBJECT_ALT_NAME: '2.5.29.17',
});

/** Extended key usages a TLS chain is judged for. */
export const TLS_USAGE = Object.freeze({
    SERVER_AUTH: '1.3.6.1.5.5.7.3.1',
    CLIENT_AUTH: '1.3.6.1.5.5.7.3.2',
});

/** Extended key usages. */
export const USAGE = Object.freeze({
    CODE_SIGNING: '1.3.6.1.5.5.7.3.3',
    TIME_STAMPING: '1.3.6.1.5.5.7.3.8',
    ANY: '2.5.29.37.0',
    LIFETIME_SIGNING: '1.3.6.1.4.1.311.10.3.13',
});

/** KeyUsage bits, numbered as RFC 5280 numbers them. */
export const KEY_USAGE = Object.freeze({
    DIGITAL_SIGNATURE: 0,
    KEY_CERT_SIGN: 5,
});

/**
 * @typedef {Object} Certificate
 * @property {Uint8Array} encoded         The whole certificate.
 * @property {Uint8Array} tbs             The to-be-signed part, as encoded.
 * @property {number} version             1, 2 or 3.
 * @property {Uint8Array} serial          The serial number's contents octets.
 * @property {Uint8Array} issuer          The issuer Name, as encoded.
 * @property {Uint8Array} subject         The subject Name, as encoded.
 * @property {string} subjectName         The subject's common name, or its whole name, for reports.
 * @property {number} notBefore           Milliseconds since 1970, UTC.
 * @property {number} notAfter
 * @property {RsaKey | null} publicKey    Null for a key that is not RSA.
 * @property {string} signatureAlgorithm
 * @property {Uint8Array} signature
 * @property {{ ca: boolean, pathLength: number | null } | null} basicConstraints
 * @property {((bit: number) => boolean) | null} keyUsage  Null when absent.
 * @property {string[] | null} extendedKeyUsage           Null when absent.
 * @property {string[]} unknownCritical   Critical extensions this build does not read.
 * @property {Uint8Array} signatureParameters  The signature algorithm's parameters, as encoded
 *           (empty when absent).
 * @property {string} publicKeyAlgorithm  The subject key's algorithm.
 * @property {Uint8Array} publicKeyParameters  Its parameters, as encoded (empty when absent).
 * @property {{ unused: number, bits: Uint8Array }} publicKeyBits  The key's BIT STRING.
 * @property {{ id: string, critical: boolean, value: Uint8Array }[]} extensions
 *           Every extension, its value the OCTET STRING's contents.
 * @property {string[]} dnsNames          The subject alternative name's DNS names.
 * @property {string | null} commonName   The subject's common name.
 */

/**
 * A Name for a report: its common name, or every attribute value joined.
 *
 * @param {DerNode} name
 */
function describeName(name){
    const COMMON_NAME = '2.5.4.3';
    /** @type {string[]} */
    const values = [];
    let common = null;
    for (const set of childrenOf(name))
    {
        for (const pair of childrenOf(set))
        {
            const [type, value] = childrenOf(pair);
            const text = readString(value);
            values.push(text);
            if (readOid(type) === COMMON_NAME)
            {
                common = text;
            }
        }
    }
    return common ?? values.join(', ');
}

/**
 * A Name's common name (the last one, the most specific), or null.
 *
 * @param {DerNode} name
 */
function commonNameOf(name){
    let common = null;
    for (const set of childrenOf(name))
    {
        for (const pair of childrenOf(set))
        {
            const [type, value] = childrenOf(pair);
            if (readOid(type) === '2.5.4.3')
            {
                common = readString(value);
            }
        }
    }
    return common;
}

/**
 * An RSA SubjectPublicKeyInfo's key, or null for another algorithm.
 *
 * @param {DerNode} info
 * @returns {RsaKey | null}
 */
function readPublicKey(info){
    const [algorithm, key] = childrenOf(expect(info, TAG.SEQUENCE, 'a public key'));
    if (readOid(childrenOf(algorithm)[0]) !== OID.RSA)
    {
        return null;
    }
    const { bits } = readBitString(key);
    const [modulus, exponent] = childrenOf(readNode(bits));
    const n = readUnsigned(modulus);
    return { n: beToBigInt(n), e: beToBigInt(readUnsigned(exponent)), size: n.length };
}

/**
 * Reads a DER certificate.
 *
 * @param {Uint8Array} der
 * @returns {Certificate}
 * @throws {DerError} when it is not one.
 */
export function parseCertificate(der){
    const root = readNode(der);
    const [tbsNode, algorithmNode, signatureNode] =
        childrenOf(expect(root, TAG.SEQUENCE, 'a certificate'));
    const fields = childrenOf(expect(tbsNode, TAG.SEQUENCE, 'a TBSCertificate'));
    const [signatureOid, signatureParameters] = childrenOf(
        expect(algorithmNode, TAG.SEQUENCE, 'a signature algorithm'));
    let at = 0;
    let version = 1;
    if (fields[0]?.tag === context(0))
    {
        version = Number(readInteger(childrenOf(fields[0])[0])) + 1;
        at++;
    }
    const serial = contents(expect(fields[at++], TAG.INTEGER, 'a serial number'));
    at++; // the signature algorithm, repeated outside
    const issuer = expect(fields[at++], TAG.SEQUENCE, 'an issuer');
    const [notBefore, notAfter] = childrenOf(expect(fields[at++], TAG.SEQUENCE, 'a validity'));
    const subject = expect(fields[at++], TAG.SEQUENCE, 'a subject');
    const keyInfo = fields[at++];
    const publicKey = readPublicKey(keyInfo);
    const [keyAlgorithm, keyBits] = childrenOf(keyInfo);
    const [keyOid, keyParameters] = childrenOf(keyAlgorithm);
    /** @type {Certificate['extensions']} */
    const extensionList = [];
    /** @type {string[]} */
    const dnsNames = [];

    /** @type {Certificate['basicConstraints']} */
    let basicConstraints = null;
    /** @type {Certificate['keyUsage']} */
    let keyUsage = null;
    /** @type {string[] | null} */
    let extendedKeyUsage = null;
    /** @type {string[]} */
    const unknownCritical = [];
    const extensions = fields.slice(at).find(field=>field.tag === context(3));
    for (const extension of extensions ? childrenOf(childrenOf(extensions)[0]) : [])
    {
        const parts = childrenOf(extension);
        const id = readOid(parts[0]);
        const critical = parts.length === 3 && readBoolean(parts[1]);
        const raw = contents(expect(parts[parts.length - 1], TAG.OCTET_STRING,
            'an extension value'));
        const value = readNode(raw);
        extensionList.push({ id, critical, value: raw });
        switch (id)
        {
            case EXTENSION.BASIC_CONSTRAINTS: {
                const [first, second] = childrenOf(value);
                const ca = first?.tag === TAG.BOOLEAN && readBoolean(first);
                const length = first?.tag === TAG.INTEGER ? first : second;
                basicConstraints = { ca, pathLength: length ? Number(readInteger(length)) : null };
                break;
            }
            case EXTENSION.KEY_USAGE: {
                const { bits } = readBitString(value);
                keyUsage = bit=>((bits[bit >> 3] ?? 0) & (0x80 >> (bit & 7))) !== 0;
                break;
            }
            case EXTENSION.EXTENDED_KEY_USAGE:
                extendedKeyUsage = childrenOf(value).map(readOid);
                break;
            case EXTENSION.SUBJECT_ALT_NAME:
                // dNSName is [2] IMPLICIT IA5String; the other forms are not names
                // a TLS client matches a host against.
                for (const general of childrenOf(value))
                {
                    if (general.tag === 0x82)
                    {
                        dnsNames.push(String.fromCharCode(...contents(general)));
                    }
                }
                break;
            default:
                if (critical)
                {
                    unknownCritical.push(id);
                }
        }
    }

    return {
        encoded: encoding(root),
        tbs: encoding(tbsNode),
        version,
        serial,
        issuer: encoding(issuer),
        subject: encoding(subject),
        subjectName: describeName(subject),
        notBefore: readTime(notBefore),
        notAfter: readTime(notAfter),
        publicKey,
        signatureAlgorithm: readOid(signatureOid),
        signature: readBitString(signatureNode).bits,
        basicConstraints,
        keyUsage,
        extendedKeyUsage,
        unknownCritical,
        signatureParameters: signatureParameters
            ? encoding(signatureParameters) : new Uint8Array(0),
        publicKeyAlgorithm: readOid(keyOid),
        publicKeyParameters: keyParameters ? encoding(keyParameters) : new Uint8Array(0),
        publicKeyBits: readBitString(keyBits),
        extensions: extensionList,
        dnsNames,
        commonName: commonNameOf(subject),
    };
}

/**
 * Whether `certificate` carries a valid signature by `issuerKey`.
 *
 * @param {Certificate} certificate
 * @param {RsaKey | null} issuerKey
 */
export function isSignedBy(certificate, issuerKey){
    return !!issuerKey && verifySigned(issuerKey, certificate.signatureAlgorithm,
        certificate.tbs, certificate.signature);
}

/** @param {Uint8Array} a @param {Uint8Array} b */
export const sameBytes = (a, b)=>a.length === b.length && a.every((byte, i)=>byte === b[i]);

/** Whether a certificate names itself as its issuer. @param {Certificate} certificate */
export const isSelfIssued = certificate=>sameBytes(certificate.issuer, certificate.subject);

export { DerError };
