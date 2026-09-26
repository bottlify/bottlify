/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A test-side public key infrastructure: a DER writer, RSA keys from
 * node:crypto, and certificates and PKCS #7 signed messages built and signed
 * here, so the readers and the verifier are tested on structures nobody else
 * produced. Nothing in it is imported by the product.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';

/** @param {Uint8Array[]} parts */
const concat = parts=>{
    const out = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
    let at = 0;
    for (const part of parts)
    {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

/** @param {number} length */
const lengthOf = length=>{
    if (length < 0x80)
    {
        return [length];
    }
    const bytes = [];
    for (let rest = length; rest > 0; rest = Math.floor(rest / 256))
    {
        bytes.unshift(rest & 0xff);
    }
    return [0x80 | bytes.length, ...bytes];
};

/** The DER writer. */
export const der = {
    /** @param {number} tag @param {...Uint8Array} parts */
    node(tag, ...parts){
        const body = concat(parts);
        return concat([Uint8Array.from([tag, ...lengthOf(body.length)]), body]);
    },
    /** @param {...Uint8Array} parts */
    seq: (...parts)=>der.node(0x30, ...parts),
    /** @param {...Uint8Array} parts */
    set: (...parts)=>der.node(0x31, ...parts),
    /** An EXPLICIT [n]. @param {number} n @param {...Uint8Array} parts */
    ctx: (n, ...parts)=>der.node(0xa0 | n, ...parts),
    /** @param {string} text */
    oid(text){
        const arcs = text.split('.').map(Number);
        const bytes = [];
        for (const arc of [arcs[0] * 40 + arcs[1], ...arcs.slice(2)])
        {
            const groups = [arc & 0x7f];
            for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128))
            {
                groups.unshift(0x80 | (rest & 0x7f));
            }
            bytes.push(...groups);
        }
        return der.node(0x06, Uint8Array.from(bytes));
    },
    /** A non-negative INTEGER. @param {bigint | number} value */
    int(value){
        let hex = BigInt(value).toString(16);
        hex = hex.length % 2 ? `0${hex}` : hex;
        const bytes = [...Buffer.from(hex, 'hex')];
        return der.node(0x02, Uint8Array.from(bytes[0] & 0x80 ? [0, ...bytes] : bytes));
    },
    /** @param {Uint8Array} bytes */
    octets: bytes=>der.node(0x04, bytes),
    /** @param {Uint8Array} bytes */
    bits: bytes=>der.node(0x03, Uint8Array.of(0), bytes),
    nul: ()=>Uint8Array.of(0x05, 0),
    /** @param {boolean} value */
    bool: value=>Uint8Array.of(0x01, 1, value ? 0xff : 0),
    /** @param {number} ms */
    utc(ms){
        const text = new Date(ms).toISOString().replace(/[-:T]/g, '').slice(2, 14);
        return der.node(0x17, new Uint8Array(Buffer.from(`${text}Z`, 'latin1')));
    },
    /** @param {string} text */
    printable: text=>der.node(0x13, new Uint8Array(Buffer.from(text, 'latin1'))),
};

/** OIDs the builders use. */
export const OIDS = {
    sha1: '1.3.14.3.2.26',
    sha256: '2.16.840.1.101.3.4.2.1',
    md5: '1.2.840.113549.2.5',
    rsa: '1.2.840.113549.1.1.1',
    sha1Rsa: '1.2.840.113549.1.1.5',
    sha256Rsa: '1.2.840.113549.1.1.11',
    md5Rsa: '1.2.840.113549.1.1.4',
    data: '1.2.840.113549.1.7.1',
    signedData: '1.2.840.113549.1.7.2',
    contentType: '1.2.840.113549.1.9.3',
    messageDigest: '1.2.840.113549.1.9.4',
    signingTime: '1.2.840.113549.1.9.5',
    counterSignature: '1.2.840.113549.1.9.6',
    codeSigning: '1.3.6.1.5.5.7.3.3',
    timeStamping: '1.3.6.1.5.5.7.3.8',
    spcIndirectData: '1.3.6.1.4.1.311.2.1.4',
    spcCabData: '1.3.6.1.4.1.311.2.1.25',
    spcPeImageData: '1.3.6.1.4.1.311.2.1.15',
};

/** @typedef {'md5' | 'sha1' | 'sha256'} Hash */

const SIGNATURE_OIDS = { md5: OIDS.md5Rsa, sha1: OIDS.sha1Rsa, sha256: OIDS.sha256Rsa };

/** @param {string} oid */
const algorithm = oid=>der.seq(der.oid(oid), der.nul());

/**
 * @typedef {Object} Key
 * @property {import('node:crypto').KeyObject} privateKey
 * @property {Uint8Array} spki  Its public half as a SubjectPublicKeyInfo.
 */

/** @returns {Key} */
export function makeKey(){
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    return {
        privateKey,
        spki: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    };
}

/** @param {string} commonName */
export const nameOf = commonName=>der.seq(der.set(der.seq(der.oid('2.5.4.3'),
    der.printable(commonName))));

/** Extension builders: each answers an Extension. */
export const ext = {
    /** @param {boolean} ca @param {number} [pathLength] */
    basicConstraints: (ca, pathLength)=>der.seq(der.oid('2.5.29.19'), der.bool(true),
        der.octets(der.seq(...(ca ? [der.bool(true)] : []),
            ...(pathLength === undefined ? [] : [der.int(pathLength)])))),
    /** @param {...number} bits  RFC 5280's numbering: 0 digitalSignature, 5 keyCertSign. */
    keyUsage(...bits){
        const bytes = Uint8Array.of(0);
        bits.forEach(bit=>{
            bytes[0] |= 0x80 >> bit;
        });
        return der.seq(der.oid('2.5.29.15'), der.bool(true), der.octets(der.bits(bytes)));
    },
    /** @param {...string} usages */
    extendedKeyUsage: (...usages)=>der.seq(der.oid('2.5.29.37'),
        der.octets(der.seq(...usages.map(der.oid)))),
    /** A critical extension this build cannot read. */
    unknownCritical: ()=>der.seq(der.oid('1.2.3.4.5'), der.bool(true), der.octets(der.nul())),
};

const YEAR = 365 * 24 * 3600 * 1000;

/**
 * @typedef {Object} CertificateSpec
 * @property {string} subject
 * @property {string} [issuer]            The issuer's common name; the subject's by default.
 * @property {Key} key                    The subject's key.
 * @property {Key} [signer]               The issuer's key; the subject's by default.
 * @property {number} [serial]
 * @property {number} [notBefore]
 * @property {number} [notAfter]
 * @property {Uint8Array[]} [extensions]
 * @property {Hash} [hash]
 * @property {boolean} [v1]               No version field and no extensions.
 */

/**
 * @param {CertificateSpec} spec
 * @returns {Uint8Array}
 */
export function makeCertificate(spec){
    const hash = spec.hash ?? 'sha1';
    const notBefore = spec.notBefore ?? Date.UTC(2000, 0, 1);
    const notAfter = spec.notAfter ?? notBefore + 50 * YEAR;
    const tbs = der.seq(
        ...(spec.v1 ? [] : [der.ctx(0, der.int(2))]),
        der.int(spec.serial ?? 1),
        algorithm(SIGNATURE_OIDS[hash]),
        nameOf(spec.issuer ?? spec.subject),
        der.seq(der.utc(notBefore), der.utc(notAfter)),
        nameOf(spec.subject),
        spec.key.spki,
        ...(spec.v1 || !spec.extensions?.length ? [] : [der.ctx(3, der.seq(...spec.extensions))]),
    );
    const signature = sign(hash, tbs, (spec.signer ?? spec.key).privateKey);
    return der.seq(tbs, algorithm(SIGNATURE_OIDS[hash]), der.bits(new Uint8Array(signature)));
}

/** @param {Hash} hash @param {Uint8Array} bytes */
export const hashOf = (hash, bytes)=>new Uint8Array(createHash(hash).update(bytes).digest());

/**
 * @typedef {Object} SignerSpec
 * @property {string} issuer          The signer certificate's issuer's common name.
 * @property {number} serial          The signer certificate's serial number.
 * @property {Key} key
 * @property {Uint8Array} covered     The bytes the message digest is of.
 * @property {Hash} [hash]
 * @property {[string, Uint8Array][] | null} [attributes]  Authenticated attributes
 *   besides the message digest; null for none at all, the digest included.
 * @property {Uint8Array} [messageDigest]  In place of the digest of `covered`.
 * @property {[string, Uint8Array][]} [unauthenticated]
 */

/**
 * A SignerInfo whose signature covers `covered` as RFC 2315 section 9 says.
 *
 * @param {SignerSpec} spec
 * @returns {{ encoded: Uint8Array, encryptedDigest: Uint8Array }}
 */
export function makeSignerInfo(spec){
    const hash = spec.hash ?? 'sha1';
    const digest = hashOf(hash, spec.covered);
    /** @param {[string, Uint8Array][]} list */
    const attributesOf = list=>list.map(([oid, value])=>der.seq(der.oid(oid), der.set(value)));
    let authenticated = null;
    let encryptedDigest;
    if (spec.attributes === null)
    {
        encryptedDigest = new Uint8Array(sign(hash, spec.covered, spec.key.privateKey));
    }
    else
    {
        const list = attributesOf([...(spec.attributes ?? []),
            [OIDS.messageDigest, der.octets(spec.messageDigest ?? digest)]]);
        authenticated = der.ctx(0, ...list);
        encryptedDigest = new Uint8Array(sign(hash, der.set(...list), spec.key.privateKey));
    }
    const encoded = der.seq(
        der.int(1),
        der.seq(nameOf(spec.issuer), der.int(spec.serial)),
        algorithm(OIDS[hash]),
        ...(authenticated ? [authenticated] : []),
        algorithm(OIDS.rsa),
        der.octets(encryptedDigest),
        ...(spec.unauthenticated?.length
            ? [der.node(0xa1, ...attributesOf(spec.unauthenticated))] : []),
    );
    return { encoded, encryptedDigest };
}

/**
 * @param {Object} spec
 * @param {string} spec.contentType
 * @param {Uint8Array} spec.content        The content's own encoding.
 * @param {Uint8Array[]} spec.certificates
 * @param {Uint8Array[]} spec.signers      Encoded SignerInfos.
 * @param {Hash} [spec.hash]
 */
export function makeSignedData(spec){
    return der.seq(der.oid(OIDS.signedData), der.ctx(0, der.seq(
        der.int(1),
        der.set(algorithm(OIDS[spec.hash ?? 'sha1'])),
        der.seq(der.oid(spec.contentType), der.ctx(0, spec.content)),
        der.ctx(0, ...spec.certificates),
        der.set(...spec.signers),
    )));
}

/**
 * The bytes a message digest covers: the content's encoding without its own
 * tag and length.
 *
 * @param {Uint8Array} encoded  A DER encoding whose length fits the short or long form.
 */
export function contentsOf(encoded){
    const first = encoded[1];
    return encoded.subarray(2 + (first & 0x80 ? first & 0x7f : 0));
}
