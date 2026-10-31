/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A depot's files as SteamPipe's content servers serve them: the manifest a
 * request code unlocks, and the chunks each file is cut into -- encrypted with
 * the depot's key, then compressed. The key, the code and the servers are the
 * store's to give (GameHub, `modules/bridge`); this reads the formats, through
 * WebCrypto and the platform's decompression streams, in a page as in Node.
 */

import { decode } from './protobuf.js';
import { decompressZstd } from '../zstd.js';
import { decodeLzma } from './lzma.js';

/** @typedef {import('./protobuf.js').Schema} Schema */
/** The manifest's sections, each a magic and (but the last) a length. */
const MANIFEST_PAYLOAD = 0x71F617D0;
const MANIFEST_METADATA = 0x1F4812BE;
const MANIFEST_SIGNATURE = 0x1B81B817;
const MANIFEST_END = 0x32C415AB;

/** @type {Schema} */
const ContentManifestPayload = {
    mappings: [1, {
        filename: [1, 'string'],
        size: [2, 'uint64'],
        flags: [3, 'uint32'],
        sha_filename: [4, 'bytes'],
        sha_content: [5, 'bytes'],
        chunks: [6, {
            sha: [1, 'bytes'],
            crc: [2, 'fixed32'],
            offset: [3, 'uint64'],
            cb_original: [4, 'uint32'],
            cb_compressed: [5, 'uint32'],
        }, 'repeated'],
        linktarget: [7, 'string'],
    }, 'repeated'],
};
/** @type {Schema} */
const ContentManifestMetadata = {
    depot_id: [1, 'uint32'],
    gid_manifest: [2, 'uint64'],
    creation_time: [3, 'uint32'],
    filenames_encrypted: [4, 'bool'],
    cb_disk_original: [5, 'uint64'],
    cb_disk_compressed: [6, 'uint64'],
    unique_chunks: [7, 'uint32'],
};

/** EDepotFileFlag: a directory, which has no chunks. */
export const FILE_FLAG_DIRECTORY = 0x40;

/**
 * @typedef {Object} ManifestChunk
 * @property {Uint8Array} sha  The chunk's name on the content servers.
 * @property {number} crc  Adler-32 of the chunk's bytes, as Steam seeds it (0).
 * @property {number} offset @property {number} size @property {number} compressedSize
 *
 * @typedef {Object} ManifestFile
 * @property {string} name  Backslashed, as in the depot.
 * @property {number} size @property {number} flags
 * @property {Uint8Array} sha  SHA-1 of the whole file.
 * @property {ManifestChunk[]} chunks
 * @property {string} [link]
 *
 * @typedef {Object} Manifest
 * @property {number} depot @property {bigint} gid @property {number} created
 * @property {number} size  The files' bytes on disk.
 * @property {ManifestFile[]} files
 *
 * @typedef {Object} ContentServer
 * @property {string} host  Its address, port included where it has one.
 * @property {string} vhost  The name it answers for.
 * @property {string} type
 */

/** @param {Uint8Array} bytes */
const asBuffer = bytes=>/** @type {Uint8Array<ArrayBuffer>} */ (bytes);

/**
 * Steam's symmetric decryption: the first block, decrypted alone with the
 * key (ECB), is the IV of the rest (CBC, PKCS #7 padding).
 *
 * WebCrypto has no ECB. The one block is decrypted as the first of a CBC
 * message with a zero IV, followed by a block made so that the second
 * decrypts to a whole block of padding: E(C xor 16 x 0x10), itself one CBC
 * encryption with a zero IV.
 *
 * @param {Uint8Array} data @param {Uint8Array} key
 * @returns {Promise<Uint8Array>}
 */
export async function symmetricDecrypt(data, key){
    const subtle = globalThis.crypto.subtle;
    const aes = await subtle.importKey('raw', asBuffer(key), 'AES-CBC', false,
        ['encrypt', 'decrypt']);
    const zero = new Uint8Array(16);
    const first = data.subarray(0, 16);
    const masked = first.map(byte=>byte ^ 0x10);
    const tail = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: zero }, aes, masked))
        .subarray(0, 16);
    const pair = new Uint8Array(32);
    pair.set(first);
    pair.set(tail, 16);
    const iv = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: zero }, aes, pair));
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, aes,
        asBuffer(data.subarray(16))));
}

/** @param {Uint8Array} bytes @param {CompressionFormat} format */
async function inflate(bytes, format){
    const stream = new Blob([asBuffer(bytes)]).stream()
        .pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The one file of a zip archive, as a manifest and an old chunk come:
 * stored or deflated.
 *
 * @param {Uint8Array} zip
 */
async function unzipOne(zip){
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    if (view.getUint32(0, true) !== 0x04034b50)
    {
        throw new Error('steam: not a zip archive');
    }
    const method = view.getUint16(8, true);
    let compressed = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const start = 30 + nameLength + extraLength;
    if (compressed === 0 || compressed === 0xffffffff)
    {
        // Sizes in the central directory only: read them from there.
        const end = zip.byteLength - 22;
        const central = view.getUint32(end + 16, true);
        compressed = view.getUint32(central + 20, true);
    }
    const body = zip.subarray(start, start + compressed);
    if (method === 0)
    {
        return body;
    }
    if (method === 8)
    {
        return inflate(body, 'deflate-raw');
    }
    throw new Error(`steam: a zip entry compressed with method ${method}`);
}

/** @param {Uint8Array} bytes */
export function adler32(bytes){
    let a = 0;
    let b = 0;
    for (let at = 0; at < bytes.length;)
    {
        // 5552 bytes keep both sums inside 32 bits before the modulo.
        const end = Math.min(at + 5552, bytes.length);
        for (; at < end; at++)
        {
            a += bytes[at];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

/**
 * A chunk's bytes once decrypted: zip (deflate), "VZa" (LZMA) or "VSZa"
 * (zstd), each with its own header and footer.
 *
 * @param {Uint8Array} data @param {number} size  The bytes it holds.
 */
export async function decompressChunk(data, size){
    if (data[0] === 0x50 && data[1] === 0x4b)
    {
        return unzipOne(data);
    }
    if (data[0] === 0x56 && data[1] === 0x53 && data[2] === 0x5a && data[3] === 0x61)
    {
        // "VSZa", a CRC-32, the zstd frame, then a footer of CRC, size and "zsv".
        return decompressZstd(data.subarray(8, data.length - 15), size);
    }
    if (data[0] === 0x56 && data[1] === 0x5a && data[2] === 0x61)
    {
        // "VZa", four bytes of its own, the five LZMA properties, the stream,
        // then a footer of CRC-32, size and "zv".
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const held = view.getUint32(data.length - 6, true);
        return decodeLzma(data.subarray(7, 12), data.subarray(12, data.length - 10), held);
    }
    throw new Error(`steam: a chunk of an unknown kind (${[...data.subarray(0, 4)]})`);
}

/**
 * @param {ContentServer} server @param {string} path
 * @param {string} [shown]  The path as a failure names it: a manifest's without its code.
 * @returns {Promise<Uint8Array>}
 */
async function fetchFrom(server, path, shown = path){
    const answer = await fetch(`https://${server.vhost}${path}`);
    if (!answer.ok)
    {
        throw new Error(`steam: ${server.vhost}${shown} answered ${answer.status}`);
    }
    return new Uint8Array(await answer.arrayBuffer());
}

/**
 * A depot's manifest: its files, their chunks, and their names in clear.
 *
 * @param {ContentServer} server
 * @param {{ depot: number, gid: bigint, code: bigint, key: Uint8Array }} what
 * @returns {Promise<Manifest>}
 */
export async function manifest(server, { depot, gid, code, key }){
    const bytes = await unzipOne(await fetchFrom(server, `/depot/${depot}/manifest/${gid}/5/${code}`,
        `/depot/${depot}/manifest/${gid}`));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /** @type {Record<string, any> | null} */
    let payload = null;
    /** @type {Record<string, any> | null} */
    let metadata = null;
    for (let at = 0; at + 4 <= bytes.length;)
    {
        const magic = view.getUint32(at, true);
        if (magic === MANIFEST_END)
        {
            break;
        }
        const length = view.getUint32(at + 4, true);
        const section = bytes.subarray(at + 8, at + 8 + length);
        if (magic === MANIFEST_PAYLOAD)
        {
            payload = decode(ContentManifestPayload, section);
        }
        else if (magic === MANIFEST_METADATA)
        {
            metadata = decode(ContentManifestMetadata, section);
        }
        else if (magic !== MANIFEST_SIGNATURE)
        {
            throw new Error(`steam: a manifest section 0x${magic.toString(16)}`);
        }
        at += 8 + length;
    }
    if (!payload || !metadata)
    {
        throw new Error(`steam: manifest ${gid} of depot ${depot} has no payload or metadata`);
    }
    const decoder = new TextDecoder();
    /** @type {ManifestFile[]} */
    const files = [];
    for (const mapping of payload.mappings)
    {
        let name = mapping.filename;
        if (metadata.filenames_encrypted)
        {
            const encrypted = Uint8Array.from(atob(name), c=>c.charCodeAt(0));
            const clear = await symmetricDecrypt(encrypted, key);
            name = decoder.decode(clear).replace(/\0+$/, '');
        }
        files.push({
            name,
            size: Number(mapping.size ?? 0n),
            flags: mapping.flags ?? 0,
            sha: mapping.sha_content ?? new Uint8Array(0),
            chunks: (mapping.chunks ?? []).map((/** @type {any} */ piece)=>({
                sha: piece.sha,
                crc: piece.crc >>> 0,
                offset: Number(piece.offset ?? 0n),
                size: piece.cb_original,
                compressedSize: piece.cb_compressed,
            })).sort((/** @type {ManifestChunk} */ a, /** @type {ManifestChunk} */ b)=>a.offset - b.offset),
            ...mapping.linktarget ? { link: mapping.linktarget } : {},
        });
    }
    return {
        depot,
        gid,
        created: metadata.creation_time ?? 0,
        size: Number(metadata.cb_disk_original ?? 0n),
        files,
    };
}

/** @param {Uint8Array} bytes */
const hex = bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2, '0')).join('');

/**
 * One chunk's bytes, checked against the manifest's Adler-32 and length.
 *
 * @param {ContentServer} server @param {number} depot @param {ManifestChunk} chunk
 * @param {Uint8Array} key
 * @returns {Promise<Uint8Array>}
 */
export async function downloadChunk(server, depot, chunk, key){
    const encrypted = await fetchFrom(server, `/depot/${depot}/chunk/${hex(chunk.sha)}`);
    const bytes = await decompressChunk(await symmetricDecrypt(encrypted, key), chunk.size);
    if (bytes.length !== chunk.size || adler32(bytes) !== chunk.crc)
    {
        throw new Error(`steam: chunk ${hex(chunk.sha)} of depot ${depot}`
            + ' is not what the manifest says');
    }
    return bytes;
}
