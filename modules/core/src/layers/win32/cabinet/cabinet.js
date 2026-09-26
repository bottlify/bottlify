/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createInflater, inflateMszipBlock } from './inflate.js';
import { createLzxDecoder } from './lzx.js';

/**
 * The cabinet container, as the Cabinet SDK's "Microsoft Cabinet File
 * Format" lays it out: a CFHEADER, its CFFOLDERs and CFFILEs, and each
 * folder's CFDATA blocks, which decode to one stream the folder's files are
 * cut from by offset.
 *
 * What is read here is one cabinet on its own. A folder continued from or
 * into another cabinet of a set is reported as such and not decoded; so is
 * a compression type this build does not have (Quantum).
 */

const SIGNATURE = 0x4643534d; // 'MSCF'
const HEADER_SIZE = 36;

const cfhdrPREV_CABINET = 0x0001;
const cfhdrNEXT_CABINET = 0x0002;
const cfhdrRESERVE_PRESENT = 0x0004;

const ifoldCONTINUED_FROM_PREV = 0xfffd;

/** CFFOLDER.typeCompress: the method in the low nibble, LZX's window above. */
export const COMPRESSION = Object.freeze({ NONE: 0, MSZIP: 1, QUANTUM: 2, LZX: 3 });

/** Thrown for bytes that are not a cabinet, or one that cannot be read. */
export class CabinetError extends Error {
    /**
     * @param {string} message
     * @param {'format' | 'corrupt' | 'unsupported'} kind
     *        Not a cabinet at all; a cabinet whose data does not decode or
     *        whose checksums disagree; one using what this build lacks.
     */
    constructor(message, kind){
        super(message);
        this.kind = kind;
    }
}

/**
 * @typedef {Object} CabinetFile
 * @property {string} name
 * @property {number} size
 * @property {number} offset  Into its folder's uncompressed stream.
 * @property {number} folder  CFFILE.iFolder as stored, continuation values included.
 * @property {number} date @property {number} time  MS-DOS date and time.
 * @property {number} attributes
 *
 * @typedef {Object} CabinetFolder
 * @property {number} dataOffset  Where its first CFDATA is.
 * @property {number} blocks
 * @property {number} compression  The whole typeCompress word.
 *
 * @typedef {Object} Cabinet
 * @property {number} size         cbCabinet.
 * @property {number} setId
 * @property {number} index        iCabinet.
 * @property {number} flags
 * @property {Uint8Array} reserve  The per-cabinet reserved area.
 * @property {number} folderReserve @property {number} dataReserve
 * @property {string | null} previous @property {string | null} next
 *           The cabinets before and after this one in a set.
 * @property {CabinetFolder[]} folders
 * @property {CabinetFile[]} files
 * @property {Uint8Array} bytes
 */

/**
 * The CFDATA checksum: the block's bytes XORed as little-endian ULONGs, a
 * short tail folded in as the SDK's own routine folds it.
 *
 * @param {Uint8Array} bytes @param {number} seed
 */
export function cabinetChecksum(bytes, seed){
    let sum = seed >>> 0;
    const whole = bytes.length & ~3;
    for (let at = 0; at < whole; at += 4)
    {
        sum ^= bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
    }
    // The remainder is gathered highest byte first, so one byte left lands
    // in the low eight bits, two in the low sixteen with the first above.
    let tail = 0;
    for (let at = whole; at < bytes.length; at++)
    {
        tail = (tail << 8) | bytes[at];
    }
    return (sum ^ tail) >>> 0;
}

/** @param {Uint8Array} bytes @param {number} at */
const cString = (bytes, at)=>{
    let end = at;
    while (end < bytes.length && bytes[end] !== 0)
    {
        end++;
    }
    if (end >= bytes.length)
    {
        throw new CabinetError('a name runs off the end of the cabinet', 'format');
    }
    return { text: String.fromCharCode(...bytes.subarray(at, end)), next: end + 1 };
};

/**
 * Reads a cabinet's directory: header, folders, files.
 *
 * @param {Uint8Array} bytes
 * @returns {Cabinet}
 */
export function readCabinet(bytes){
    if (bytes.length < HEADER_SIZE)
    {
        throw new CabinetError('too short for a cabinet header', 'format');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== SIGNATURE)
    {
        throw new CabinetError('no MSCF signature', 'format');
    }
    const size = view.getUint32(8, true);
    const filesAt = view.getUint32(16, true);
    const versionMinor = bytes[24];
    const versionMajor = bytes[25];
    if (versionMajor !== 1 || versionMinor !== 3)
    {
        throw new CabinetError(`cabinet version ${versionMajor}.${versionMinor}`, 'unsupported');
    }
    const folderCount = view.getUint16(26, true);
    const fileCount = view.getUint16(28, true);
    const flags = view.getUint16(30, true);
    let at = HEADER_SIZE;
    let reserve = new Uint8Array(0);
    let folderReserve = 0;
    let dataReserve = 0;
    if (flags & cfhdrRESERVE_PRESENT)
    {
        const headerReserve = view.getUint16(at, true);
        folderReserve = bytes[at + 2];
        dataReserve = bytes[at + 3];
        at += 4;
        reserve = bytes.slice(at, at + headerReserve);
        at += headerReserve;
    }
    /** @type {string | null} */
    let previous = null;
    /** @type {string | null} */
    let next = null;
    if (flags & cfhdrPREV_CABINET)
    {
        const cabinet = cString(bytes, at);
        previous = cabinet.text;
        at = cString(bytes, cabinet.next).next;
    }
    if (flags & cfhdrNEXT_CABINET)
    {
        const cabinet = cString(bytes, at);
        next = cabinet.text;
        at = cString(bytes, cabinet.next).next;
    }
    /** @type {CabinetFolder[]} */
    const folders = [];
    for (let i = 0; i < folderCount; i++)
    {
        if (at + 8 > bytes.length)
        {
            throw new CabinetError('the folder table runs off the end', 'format');
        }
        folders.push({
            dataOffset: view.getUint32(at, true),
            blocks: view.getUint16(at + 4, true),
            compression: view.getUint16(at + 6, true),
        });
        at += 8 + folderReserve;
    }
    /** @type {CabinetFile[]} */
    const files = [];
    at = filesAt;
    for (let i = 0; i < fileCount; i++)
    {
        if (at + 16 > bytes.length)
        {
            throw new CabinetError('the file table runs off the end', 'format');
        }
        const name = cString(bytes, at + 16);
        files.push({
            size: view.getUint32(at, true),
            offset: view.getUint32(at + 4, true),
            folder: view.getUint16(at + 8, true),
            date: view.getUint16(at + 10, true),
            time: view.getUint16(at + 12, true),
            attributes: view.getUint16(at + 14, true),
            name: name.text,
        });
        at = name.next;
    }
    return {
        size, setId: view.getUint16(32, true), index: view.getUint16(34, true), flags,
        reserve, folderReserve, dataReserve, previous, next, folders, files, bytes,
    };
}

/**
 * The folder a file's bytes come from, or null for one continued from or
 * into another cabinet, which a single cabinet cannot answer for.
 *
 * @param {Cabinet} cabinet @param {CabinetFile} file
 */
export const folderOf = (cabinet, file)=>(file.folder >= ifoldCONTINUED_FROM_PREV
    ? null : cabinet.folders[file.folder] ?? null);

/**
 * Decodes one folder's whole stream.
 *
 * @param {Cabinet} cabinet @param {number} index
 * @returns {Uint8Array}
 */
export function decodeFolder(cabinet, index){
    const folder = cabinet.folders[index];
    if (!folder)
    {
        throw new CabinetError(`no folder ${index}`, 'format');
    }
    const { bytes } = cabinet;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const method = folder.compression & 0x0f;

    /** @type {(block: Uint8Array, size: number) => Uint8Array} */
    let decode;
    if (method === COMPRESSION.NONE)
    {
        decode = (block, size)=>{
            if (block.length !== size)
            {
                throw new CabinetError('a stored block whose sizes differ', 'corrupt');
            }
            return block;
        };
    }
    else if (method === COMPRESSION.MSZIP)
    {
        const inflater = createInflater();
        decode = (block, size)=>inflateMszipBlock(inflater, block, size);
    }
    else if (method === COMPRESSION.LZX)
    {
        const lzx = createLzxDecoder((folder.compression >> 8) & 0x1f);
        decode = (block, size)=>lzx.decodeFrame(block, size);
    }
    else
    {
        throw new CabinetError(`compression type ${method}`, 'unsupported');
    }

    /** @type {Uint8Array[]} */
    const parts = [];
    let total = 0;
    let at = folder.dataOffset;
    for (let i = 0; i < folder.blocks; i++)
    {
        if (at + 8 + cabinet.dataReserve > bytes.length)
        {
            throw new CabinetError('a data block runs off the end', 'corrupt');
        }
        const checksum = view.getUint32(at, true);
        const packed = view.getUint16(at + 4, true);
        const size = view.getUint16(at + 6, true);
        const start = at + 8 + cabinet.dataReserve;
        if (start + packed > bytes.length)
        {
            throw new CabinetError('a data block runs off the end', 'corrupt');
        }
        if (size === 0)
        {
            throw new CabinetError('a data block continued into the next cabinet', 'unsupported');
        }
        const block = bytes.subarray(start, start + packed);
        if (checksum !== 0)
        {
            // Over the compressed bytes first, then the header from cbData on.
            const header = bytes.subarray(at + 4, at + 8 + cabinet.dataReserve);
            if (cabinetChecksum(header, cabinetChecksum(block, 0)) !== checksum)
            {
                throw new CabinetError(`data block ${i} fails its checksum`, 'corrupt');
            }
        }
        let out;
        try
        {
            out = decode(block, size);
        }
        catch (e){
            if (e instanceof CabinetError)
            {
                throw e;
            }
            throw new CabinetError(`data block ${i}: ${/** @type {Error} */ (e).message}`,
                'corrupt');
        }
        parts.push(out);
        total += out.length;
        at = start + packed;
    }
    const stream = new Uint8Array(total);
    let offset = 0;
    for (const part of parts)
    {
        stream.set(part, offset);
        offset += part.length;
    }
    return stream;
}
