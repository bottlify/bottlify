/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CMSG_SIGNER_INFO as wincrypt.h lays it out for 32-bit code, made from a
 * SignerInfo (`pkcs7.js`): what CryptMsgGetParam answers for
 * CMSG_SIGNER_INFO_PARAM and CryptDecodeObject for PKCS7_SIGNER_INFO. A
 * program reads the signer's attributes from it - its countersignature
 * above all, whose signing time is when a certificate is judged.
 *
 *   0  dwVersion
 *   4  Issuer {cbData, pbData}            the Name's DER
 *  12  SerialNumber {cbData, pbData}      little-endian, as CRYPT_INTEGER_BLOB is
 *  20  HashAlgorithm {pszObjId, Parameters {cbData, pbData}}
 *  32  HashEncryptionAlgorithm, likewise
 *  44  EncryptedHash {cbData, pbData}
 *  52  AuthAttrs {cAttr, rgAttr}
 *  60  UnauthAttrs {cAttr, rgAttr}
 *
 * An attribute is {pszObjId, cValue, rgValue}, each value a blob of its DER.
 * The algorithms' parameters are the NULL a SignerInfo of RSA carries.
 */

import { encoding } from '../crypto/der.js';

/** @typedef {import('../crypto/pkcs7.js').SignerInfo} SignerInfo */

export const SIGNER_INFO_SIZE = 68;
const NULL_PARAMETERS = Uint8Array.of(0x05, 0x00);

/**
 * The structure for `signer`, its pointers made absolute for its place at
 * `base`: the fixed part, then every string and blob it points to.
 *
 * @param {SignerInfo} signer @param {number} base
 * @returns {Uint8Array}
 */
export function signerInfoBlock(signer, base){
    /** @type {Uint8Array[]} */
    const pieces = [];
    let tail = SIGNER_INFO_SIZE;
    /** A piece after the fixed part; its address. @param {Uint8Array} bytes */
    const place = bytes=>{
        const at = base + tail;
        pieces.push(bytes);
        tail += (bytes.length + 3) & ~3;
        return at;
    };
    /** @param {string} text */
    const ascii = text=>Uint8Array.from([...text, '\0'], ch=>ch.charCodeAt(0));
    /** @type {[number, number][]} offsets and values of the fixed part */
    const fixed = [[0, 1]];
    /** @param {number} at @param {Uint8Array} bytes */
    const blob = (at, bytes)=>{
        fixed.push([at, bytes.length], [at + 4, bytes.length ? place(bytes) : 0]);
    };
    /** @param {number} at @param {Map<string, any[]> | undefined} held */
    const attributes = (at, held)=>{
        const list = [...held ?? []];
        if (list.length === 0)
        {
            fixed.push([at, 0], [at + 4, 0]);
            return;
        }
        // The array of CRYPT_ATTRIBUTE first, its strings and values behind it.
        const array = new Uint8Array(list.length * 12);
        const arrayAt = place(array);
        const view = new DataView(array.buffer);
        list.forEach(([oid, values], index)=>{
            const blobs = new Uint8Array(values.length * 8);
            const blobsAt = place(blobs);
            const blobView = new DataView(blobs.buffer);
            values.forEach((/** @type {any} */ node, i)=>{
                const der = encoding(node).slice();
                blobView.setUint32(i * 8, der.length, true);
                blobView.setUint32(i * 8 + 4, place(der), true);
            });
            view.setUint32(index * 12, place(ascii(oid)), true);
            view.setUint32(index * 12 + 4, values.length, true);
            view.setUint32(index * 12 + 8, blobsAt, true);
        });
        fixed.push([at, list.length], [at + 4, arrayAt]);
    };
    blob(4, signer.issuer);
    blob(12, Uint8Array.from(signer.serial).reverse());
    fixed.push([20, place(ascii(signer.digestAlgorithm))]);
    blob(24, NULL_PARAMETERS);
    fixed.push([32, place(ascii(signer.encryptionAlgorithm))]);
    blob(36, NULL_PARAMETERS);
    blob(44, signer.encryptedDigest);
    attributes(52, signer.authenticated?.values);
    attributes(60, signer.unauthenticated);

    const out = new Uint8Array(tail);
    const view = new DataView(out.buffer);
    for (const [at, value] of fixed)
    {
        view.setUint32(at, value >>> 0, true);
    }
    let at = SIGNER_INFO_SIZE;
    for (const piece of pieces)
    {
        out.set(piece, at);
        at += (piece.length + 3) & ~3;
    }
    return out;
}
