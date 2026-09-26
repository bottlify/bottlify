/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The file forms an Authenticode signature is found in, and the digest each
 * signs: what Windows' subject interface packages (SIPs) answer for a
 * cabinet and for a PE image.
 *
 * A signature cannot cover the bytes that record where it is, so each form
 * leaves those out of its digest. For a PE image the published rule is
 * Microsoft's "Windows Authenticode Portable Executable Signature Format":
 * the headers without the checksum and the certificate table's directory
 * entry, the sections in file order, then whatever follows them up to the
 * certificate table. For a cabinet no rule is published; the one here was
 * measured, and every one of 154 signed cabinets in a Microsoft redistributable
 * obeys it: the bytes up to cbCabinet, less reserved1, cbCFHeader and the
 * twenty bytes of the header's reserved area that locate the signature.
 */

import { createDigestFor } from '../crypto/signature.js';

/**
 * @typedef {Object} Subject
 * @property {'cab' | 'pe'} form
 * @property {Uint8Array | null} signature  The PKCS #7 SignedData, or null for none.
 * @property {(digestOid: string) => Uint8Array | null} digest
 *   The file's digest as the signature covers it; null for an algorithm not known.
 */

/** A cabinet header with a reserved area holds this where a signature is located. */
const CAB_SIGNATURE_MARKER = 0x00100000;
const CAB_RESERVE_PRESENT = 0x0004;
const CAB_HEADER = 36;

/** WIN_CERTIFICATE: a PKCS #7 SignedData, under either revision. */
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 0x0002;
const WIN_CERT_REVISIONS = [0x0100, 0x0200];
const CERTIFICATE_DIRECTORY = 4;

/**
 * The digest of the given byte ranges, in order.
 *
 * @param {Uint8Array} bytes
 * @param {[number, number][]} ranges  [start, end) pairs, clipped to the file.
 */
const digestOfRanges = (bytes, ranges)=>(/** @type {string} */ digestOid)=>{
    const digest = createDigestFor(digestOid);
    if (!digest)
    {
        return null;
    }
    for (const [start, end] of ranges)
    {
        if (end > start)
        {
            digest.update(bytes.subarray(Math.min(start, bytes.length),
                Math.min(end, bytes.length)));
        }
    }
    return digest.digest();
};

/** @param {Uint8Array} bytes @returns {Subject | null} */
function cabinetSubject(bytes){
    if (bytes.length < CAB_HEADER || bytes[0] !== 0x4d || bytes[1] !== 0x53
        || bytes[2] !== 0x43 || bytes[3] !== 0x46)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const size = view.getUint32(8, true);
    const flags = view.getUint16(30, true);
    const digest = digestOfRanges(bytes, [[0, 4], [8, 36], [38, 40], [60, size]]);
    if ((flags & CAB_RESERVE_PRESENT) === 0 || bytes.length < 60
        || view.getUint16(36, true) < 20 || view.getUint32(40, true) !== CAB_SIGNATURE_MARKER)
    {
        return { form: 'cab', signature: null, digest };
    }
    const at = view.getUint32(44, true);
    const length = view.getUint32(48, true);
    const signature = at >= size && length > 0 && at + length <= bytes.length
        ? bytes.subarray(at, at + length) : null;
    return { form: 'cab', signature, digest };
}

/** @param {Uint8Array} bytes @returns {Subject | null} */
function peSubject(bytes){
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const header = view.getUint32(60, true);
    const optional = header + 24;
    if (optional + 96 > bytes.length || view.getUint32(header, true) !== 0x4550)
    {
        return null;
    }
    const magic = view.getUint16(optional, true);
    const directories = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : 0;
    if (directories === 0 || directories > bytes.length)
    {
        return null;
    }
    const checksum = optional + 64;
    const entry = directories + CERTIFICATE_DIRECTORY * 8;
    const count = view.getUint32(directories - 4, true);
    const sizeOfHeaders = view.getUint32(optional + 60, true);
    if (count <= CERTIFICATE_DIRECTORY || entry + 8 > bytes.length)
    {
        return { form: 'pe', signature: null, digest: ()=>null };
    }
    const tableAt = view.getUint32(entry, true);
    const tableSize = view.getUint32(entry + 4, true);

    const sections = view.getUint16(header + 6, true);
    const sectionTable = optional + view.getUint16(header + 20, true);
    /** @type {[number, number][]} */
    const raw = [];
    for (let i = 0; i < sections && sectionTable + i * 40 + 40 <= bytes.length; i++)
    {
        const size = view.getUint32(sectionTable + i * 40 + 16, true);
        const pointer = view.getUint32(sectionTable + i * 40 + 20, true);
        if (size > 0)
        {
            raw.push([pointer, pointer + size]);
        }
    }
    raw.sort((a, b)=>a[0] - b[0]);
    const hashed = sizeOfHeaders + raw.reduce((sum, [start, end])=>sum + end - start, 0);
    /** @type {[number, number][]} */
    const ranges = [[0, checksum], [checksum + 4, entry], [entry + 8, sizeOfHeaders], ...raw];
    if (bytes.length > hashed)
    {
        ranges.push([hashed, bytes.length - tableSize]);
    }
    const digest = digestOfRanges(bytes, ranges);

    // The table has to be the file's last bytes: a file with more after its
    // signature is not the file that was signed (Wine's wintrust tests,
    // test_wintrust_digest, see TRUST_E_NOSIGNATURE for one).
    if (tableSize < 8 || tableAt + tableSize !== bytes.length)
    {
        return { form: 'pe', signature: null, digest };
    }
    const length = view.getUint32(tableAt, true);
    const revision = view.getUint16(tableAt + 4, true);
    const type = view.getUint16(tableAt + 6, true);
    const signature = length > 8 && length <= tableSize && WIN_CERT_REVISIONS.includes(revision)
        && type === WIN_CERT_TYPE_PKCS_SIGNED_DATA
        ? bytes.subarray(tableAt + 8, tableAt + length) : null;
    return { form: 'pe', signature, digest };
}

/**
 * The signature form a file is, or null for one no SIP here answers for.
 *
 * @param {Uint8Array} bytes
 * @returns {Subject | null}
 */
export function readSubject(bytes){
    return cabinetSubject(bytes) ?? peSubject(bytes);
}
