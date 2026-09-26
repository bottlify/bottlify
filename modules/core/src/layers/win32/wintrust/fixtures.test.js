/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Signed files built here: a cabinet and a PE image, each signed as
 * Authenticode signs, by certificates made here for the purpose -- a root, a
 * code-signing intermediate, a publisher, a timestamping intermediate and a
 * time-stamp authority -- any of which a test can replace.
 */

import { createHash } from 'node:crypto';
import {
    contentsOf, der, ext, makeCertificate, makeKey, makeSignedData, makeSignerInfo, OIDS,
} from '../crypto/pki.test.js';

/** @typedef {import('../crypto/pki.test.js').Key} Key */

export const YEAR = 365 * 24 * 3600 * 1000;
/** When the test certificates begin, the signatures are made, and "now". */
export const ISSUED = Date.UTC(2005, 0, 1);
export const SIGNED = Date.UTC(2010, 5, 1);
export const NOW = Date.UTC(2026, 8, 26);

export const KEYS = {
    root: makeKey(),
    pca: makeKey(),
    publisher: makeKey(),
    tspca: makeKey(),
    tsa: makeKey(),
    stranger: makeKey(),
};

/**
 * The chain an ordinary signature carries, each part replaceable.
 *
 * @param {Partial<Record<'root' | 'pca' | 'publisher' | 'tspca' | 'tsa',
 *   Partial<import('../crypto/pki.test.js').CertificateSpec>>>} [change]
 */
export function certificates(change = {}){
    const validity = { notBefore: ISSUED, notAfter: ISSUED + 10 * YEAR };
    return {
        root: makeCertificate({ subject: 'Test Root', key: KEYS.root, serial: 1,
            notBefore: ISSUED - YEAR, notAfter: ISSUED + 15 * YEAR, ...change.root }),
        pca: makeCertificate({ subject: 'Code PCA', issuer: 'Test Root', key: KEYS.pca,
            signer: KEYS.root, serial: 2, ...validity,
            extensions: [ext.basicConstraints(true), ext.extendedKeyUsage(OIDS.codeSigning)],
            ...change.pca }),
        publisher: makeCertificate({ subject: 'Publisher', issuer: 'Code PCA',
            key: KEYS.publisher, signer: KEYS.pca, serial: 3, notBefore: SIGNED - YEAR,
            notAfter: SIGNED + YEAR, extensions: [ext.extendedKeyUsage(OIDS.codeSigning)],
            ...change.publisher }),
        tspca: makeCertificate({ subject: 'Stamp PCA', issuer: 'Test Root', key: KEYS.tspca,
            signer: KEYS.root, serial: 4, ...validity,
            extensions: [ext.basicConstraints(true), ext.extendedKeyUsage(OIDS.timeStamping)],
            ...change.tspca }),
        tsa: makeCertificate({ subject: 'Stamp Service', issuer: 'Stamp PCA', key: KEYS.tsa,
            signer: KEYS.tspca, serial: 5, ...validity,
            extensions: [ext.extendedKeyUsage(OIDS.timeStamping)], ...change.tsa }),
    };
}

/**
 * @typedef {Object} SignOptions
 * @property {ReturnType<typeof certificates>} [chain]
 * @property {'root' | 'pca' | 'publisher' | 'tspca' | 'tsa'} [leave]  Carried
 *   certificates to leave out; the root is left out unless `withRoot`.
 * @property {boolean} [withRoot]
 * @property {number | null} [stamped]   The timestamp's time; null for none.
 * @property {Key} [signerKey]           In place of the publisher's key.
 * @property {Uint8Array} [countersigned]  What the countersignature covers, in place
 *   of the signer's encrypted digest.
 * @property {string} [dataType]         SpcAttributeTypeAndOptionalValue's type.
 */

/**
 * A PKCS #7 SignedData over `digest`, as Authenticode lays it out.
 *
 * @param {Uint8Array} digest  The file's SHA-1 digest.
 * @param {SignOptions} [options]
 */
export function authenticode(digest, options = {}){
    const chain = options.chain ?? certificates();
    const content = der.seq(
        der.seq(der.oid(options.dataType ?? OIDS.spcCabData), der.seq()),
        der.seq(der.seq(der.oid(OIDS.sha1), der.nul()), der.octets(digest)),
    );
    const covered = contentsOf(content);
    const first = makeSignerInfo({ issuer: 'Code PCA', serial: 3,
        key: options.signerKey ?? KEYS.publisher, covered,
        attributes: [[OIDS.contentType, der.oid(OIDS.spcIndirectData)]] });
    /** @type {[string, Uint8Array][]} */
    const unauthenticated = [];
    if (options.stamped !== null)
    {
        const counter = makeSignerInfo({ issuer: 'Stamp PCA', serial: 5, key: KEYS.tsa,
            covered: options.countersigned ?? first.encryptedDigest,
            attributes: [[OIDS.contentType, der.oid(OIDS.data)],
                [OIDS.signingTime, der.utc(options.stamped ?? SIGNED)]] });
        unauthenticated.push([OIDS.counterSignature, counter.encoded]);
    }
    const signer = makeSignerInfo({ issuer: 'Code PCA', serial: 3,
        key: options.signerKey ?? KEYS.publisher, covered,
        attributes: [[OIDS.contentType, der.oid(OIDS.spcIndirectData)]], unauthenticated });
    const carried = /** @type {const} */ (['pca', 'publisher', 'tspca', 'tsa'])
        .filter(name=>name !== options.leave).map(name=>chain[name]);
    return makeSignedData({ contentType: OIDS.spcIndirectData, content,
        certificates: options.withRoot ? [chain.root, ...carried] : carried,
        signers: [signer.encoded] });
}

/** @param {Uint8Array[]} parts */
const sha1 = parts=>{
    const hash = createHash('sha1');
    parts.forEach(part=>hash.update(part));
    return new Uint8Array(hash.digest());
};

/**
 * A cabinet whose header reserves the twenty bytes that locate a signature,
 * signed over the ranges the signature covers.
 *
 * @param {SignOptions & { unsigned?: boolean }} [options]
 */
export function signedCabinet(options = {}){
    const body = new Uint8Array(200).map((_, i)=>(i * 7 + 3) & 0xff);
    const size = 60 + body.length;
    const cab = new Uint8Array(size);
    const view = new DataView(cab.buffer);
    cab.set([0x4d, 0x53, 0x43, 0x46]);
    view.setUint32(8, size, true);
    view.setUint16(30, 0x0004, true);
    view.setUint16(36, 20, true);
    cab.set(body, 60);
    if (options.unsigned)
    {
        return cab;
    }
    const digest = sha1([cab.subarray(0, 4), cab.subarray(8, 36), cab.subarray(38, 40),
        cab.subarray(60)]);
    const signature = authenticode(digest, options);
    view.setUint32(40, 0x00100000, true);
    view.setUint32(44, size, true);
    view.setUint32(48, signature.length, true);
    const out = new Uint8Array(size + signature.length);
    out.set(cab);
    out.set(signature, size);
    return out;
}

/**
 * A PE32 image of headers and two sections, followed by its certificate table.
 *
 * @param {SignOptions & { unsigned?: boolean }} [options]
 */
export function signedImage(options = {}){
    const lfanew = 0x40;
    const optional = lfanew + 24;
    const sizeOfHeaders = 0x200;
    const sections = [[0x400, 0x200], [0x200, 0x200]]; // listed out of file order
    const size = 0x600;
    const image = new Uint8Array(size);
    const view = new DataView(image.buffer);
    image.set([0x4d, 0x5a]);
    view.setUint32(60, lfanew, true);
    view.setUint32(lfanew, 0x4550, true);
    view.setUint16(lfanew + 6, sections.length, true);
    view.setUint16(lfanew + 20, 224, true);
    view.setUint16(optional, 0x10b, true);
    view.setUint32(optional + 60, sizeOfHeaders, true);
    view.setUint32(optional + 64, 0x12345678, true);
    view.setUint32(optional + 92, 16, true);
    sections.forEach(([pointer, length], i)=>{
        const at = optional + 224 + i * 40;
        view.setUint32(at + 16, length, true);
        view.setUint32(at + 20, pointer, true);
        image.fill(0x11 * (i + 1), pointer, pointer + length);
    });
    if (options.unsigned)
    {
        return image;
    }
    const entry = optional + 96 + 4 * 8;
    const digest = sha1([image.subarray(0, optional + 64), image.subarray(optional + 68, entry),
        image.subarray(entry + 8, sizeOfHeaders), image.subarray(0x200, 0x400),
        image.subarray(0x400, 0x600)]);
    const signature = authenticode(digest, { dataType: OIDS.spcPeImageData, ...options });
    const length = 8 + signature.length;
    const padded = (length + 7) & ~7;
    view.setUint32(entry, size, true);
    view.setUint32(entry + 4, padded, true);
    const out = new Uint8Array(size + padded);
    out.set(image);
    const table = new DataView(out.buffer, size);
    table.setUint32(0, length, true);
    table.setUint16(4, 0x0200, true);
    table.setUint16(6, 0x0002, true);
    out.set(signature, size + 8);
    return out;
}
