/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An OBJREF: what CoMarshalInterface writes for an interface pointer and
 * CoUnmarshalInterface reads, and what an interface pointer is inside an NDR
 * buffer. The layout is DCOM's standard one (MS-DCOM 2.2.18):
 *
 *     +0   signature 'MEOW'
 *     +4   flags, OBJREF_STANDARD
 *     +8   the IID
 *     +24  STDOBJREF: flags, public references, OXID, OID, IPID
 *     +64  DUALSTRINGARRAY: no string bindings, no security bindings
 *
 * The reference inside is the one the out-of-process channel keeps
 * (`remote.js`): the exporting process is the OXID and the object's number in
 * its table the OID, and the packet carries the one reference every
 * reference that crosses carries. The IPID says the same again, as a GUID, so
 * that a program reading the packet sees one that differs per object.
 */

/** 'MEOW', read as a little-endian word. */
export const SIGNATURE = 0x574f454d;
export const OBJREF_STANDARD = 1;
export const OBJREF_CUSTOM = 4;

/**
 * What every OBJREF begins with: the signature, the flags, the IID. A reader
 * takes this much first and then what its flags say follows.
 */
export const OBJREF_HEADER_BYTES = 24;

/**
 * A custom OBJREF's header, after which the object's own marshaler wrote its
 * data (MS-DCOM 2.2.18.6): the common header, the class that unmarshals it,
 * no extension, and the data's size.
 */
export const OBJREF_CUSTOM_BYTES = 48;

/** The whole packet: the header, the STDOBJREF and an empty binding array. */
export const OBJREF_BYTES = 72;

/**
 * @typedef {Object} ObjrefReference
 * @property {number} endpoint  The exporting process.
 * @property {number} object    The object's number there.
 */

/**
 * @param {Uint8Array} iid  The interface's sixteen bytes.
 * @param {ObjrefReference} reference
 * @param {number} [publicRefs]  The references the packet carries: one, or
 *     none for a packet marshaled into a table, which the table holds the
 *     reference behind and each reader takes one of its own from.
 * @returns {Uint8Array}
 */
export function encodeObjref(iid, reference, publicRefs = 1){
    const bytes = new Uint8Array(OBJREF_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, SIGNATURE, true);
    view.setUint32(4, OBJREF_STANDARD, true);
    bytes.set(iid.subarray(0, 16), 8);
    // STDOBJREF
    view.setUint32(24, 0, true);
    view.setUint32(28, publicRefs >>> 0, true);
    view.setUint32(32, reference.endpoint >>> 0, true);
    view.setUint32(40, reference.object >>> 0, true);
    view.setUint32(48, reference.endpoint >>> 0, true);
    view.setUint32(52, reference.object >>> 0, true);
    bytes.set(iid.subarray(8, 16), 56);
    // DUALSTRINGARRAY: two entries, each list ended by its empty string.
    view.setUint16(64, 2, true);
    view.setUint16(66, 1, true);
    return bytes;
}

/**
 * The IID and reference an OBJREF carries, or null for bytes that are not a
 * standard one.
 *
 * @param {Uint8Array} bytes
 * @returns {{ iid: Uint8Array, reference: ObjrefReference, publicRefs: number } | null}
 */
export function decodeObjref(bytes){
    if (bytes.length < OBJREF_BYTES)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== SIGNATURE || view.getUint32(4, true) !== OBJREF_STANDARD
        || view.getUint32(36, true) !== 0 || view.getUint32(44, true) !== 0)
    {
        return null;
    }
    return {
        iid: bytes.slice(8, 24),
        reference: { endpoint: view.getUint32(32, true), object: view.getUint32(40, true) },
        publicRefs: view.getUint32(28, true),
    };
}

/**
 * A custom OBJREF's header: what CoMarshalInterface writes before an object's
 * own marshaler writes its `size` bytes.
 *
 * @param {Uint8Array} iid @param {Uint8Array} clsid  The unmarshaler's class.
 * @param {number} size
 * @returns {Uint8Array}
 */
export function encodeCustomHeader(iid, clsid, size){
    const bytes = new Uint8Array(OBJREF_CUSTOM_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, SIGNATURE, true);
    view.setUint32(4, OBJREF_CUSTOM, true);
    bytes.set(iid.subarray(0, 16), 8);
    bytes.set(clsid.subarray(0, 16), 24);
    view.setUint32(40, 0, true);
    view.setUint32(44, size >>> 0, true);
    return bytes;
}
