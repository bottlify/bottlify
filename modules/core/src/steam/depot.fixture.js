/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Depots made up for a test, served as SteamPipe serves them: a manifest
 * zipped, its sections protobuf (ContentManifestPayload, ContentManifestMetadata),
 * the file names encrypted with the depot's key, and each chunk compressed --
 * zip or "VSZa" zstd by turns -- then encrypted the way Steam's symmetric
 * encryption does: the IV encrypted alone (ECB), the rest CBC under it.
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { encode } from './protobuf.js';
import { adler32 } from './depot.js';

/** @type {import('./protobuf.js').Schema} */
const Payload = {
    mappings: [1, {
        filename: [1, 'string'], size: [2, 'uint64'], flags: [3, 'uint32'],
        sha_filename: [4, 'bytes'], sha_content: [5, 'bytes'],
        chunks: [6, { sha: [1, 'bytes'], crc: [2, 'fixed32'], offset: [3, 'uint64'],
            cb_original: [4, 'uint32'], cb_compressed: [5, 'uint32'] }, 'repeated'],
        linktarget: [7, 'string'],
    }, 'repeated'],
};
/** @type {import('./protobuf.js').Schema} */
const Metadata = { depot_id: [1, 'uint32'], gid_manifest: [2, 'uint64'],
    creation_time: [3, 'uint32'], filenames_encrypted: [4, 'bool'],
    cb_disk_original: [5, 'uint64'] };

/** @param {Uint8Array} data @param {Uint8Array} key */
export function symmetricEncrypt(data, key){
    const iv = randomBytes(16);
    const head = createCipheriv('aes-256-ecb', key, null).setAutoPadding(false).update(iv);
    const cbc = createCipheriv('aes-256-cbc', key, iv);
    return new Uint8Array(Buffer.concat([head, cbc.update(data), cbc.final()]));
}

/** @param {string} name @param {Uint8Array} data */
function zipOne(name, data){
    const body = zlib.deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    return new Uint8Array(Buffer.concat([header, Buffer.from(name), body]));
}

/** "VSZa", a CRC, the zstd frame, and a footer of 15 bytes. @param {Uint8Array} data */
function zstdChunk(data){
    const footer = Buffer.alloc(15);
    footer.writeUInt32LE(data.length, 4);
    footer.write('zsv', 12, 'latin1');
    return new Uint8Array(Buffer.concat([Buffer.from('VSZa\0\0\0\0', 'latin1'),
        zlib.zstdCompressSync(data), footer]));
}

/** @param {...Uint8Array} parts  Each section with its magic. */
function sections(...parts){
    return Buffer.concat(parts.map(part=>Buffer.from(part)));
}

/** @param {number} magic @param {Uint8Array} body */
function section(magic, body){
    const head = Buffer.alloc(8);
    head.writeUInt32LE(magic, 0);
    head.writeUInt32LE(body.length, 4);
    return new Uint8Array(Buffer.concat([head, body]));
}

/**
 * @typedef {Object} FakeFile
 * @property {string} name  Backslashed.
 * @property {Uint8Array} [bytes]  A file's; none for a folder or a link.
 * @property {boolean} [directory]
 * @property {string} [link]
 */

/**
 * A depot at one manifest, ready to serve: `{ depot, gid, key, code }` opens
 * it (install.js's DepotOpening), `routes` answers its paths.
 *
 * @param {{ depot: number, gid: bigint, code?: bigint, key?: Uint8Array, files: FakeFile[],
 *     chunkSize?: number, shared?: boolean }} spec
 */
export function fakeDepot({ depot, gid, files, code = 77n, key = new Uint8Array(randomBytes(32)),
    chunkSize = 1 << 16, shared = false })
{
    /** @type {Map<string, Uint8Array>} */
    const routes = new Map();
    let turn = 0;
    const mappings = files.map(file=>{
        const bytes = file.bytes ?? new Uint8Array(0);
        const chunks = [];
        for (let offset = 0; offset < bytes.length; offset += chunkSize)
        {
            const piece = bytes.subarray(offset, offset + chunkSize);
            const sha = new Uint8Array(createHash('sha1').update(piece).digest());
            const packed = symmetricEncrypt(
                turn++ % 2 ? zstdChunk(piece) : zipOne('z', piece), key);
            routes.set(`/depot/${depot}/chunk/${Buffer.from(sha).toString('hex')}`, packed);
            chunks.push({ sha, crc: adler32(piece), offset: BigInt(offset),
                cb_original: piece.length, cb_compressed: packed.length });
        }
        return {
            filename: Buffer.from(symmetricEncrypt(new TextEncoder().encode(file.name), key))
                .toString('base64'),
            size: BigInt(bytes.length),
            flags: file.directory ? 0x40 : 0,
            sha_content: new Uint8Array(createHash('sha1').update(bytes).digest()),
            chunks,
            ...file.link ? { linktarget: file.link } : {},
        };
    });
    const manifest = sections(
        section(0x71F617D0, encode(Payload, { mappings })),
        section(0x1F4812BE, encode(Metadata, { depot_id: depot, gid_manifest: gid,
            filenames_encrypted: true,
            cb_disk_original: BigInt(files.reduce((sum, f)=>sum + (f.bytes?.length ?? 0), 0)) })),
        section(0x1B81B817, new Uint8Array(0)),
        Uint8Array.of(0xAB, 0x15, 0xC4, 0x32));
    routes.set(`/depot/${depot}/manifest/${gid}/5/${code}`, zipOne('z', manifest));
    return { depot, gid, key, code, shared, routes };
}

/**
 * A `fetch` that is the content servers for depots: every host answers the
 * same, and counts what it was asked; `fail` names hosts that answer 503.
 *
 * @param {ReturnType<typeof fakeDepot>[]} depots
 * @param {{ fail?: string[] }} [options]
 */
export function contentServer(depots, { fail = [] } = {}){
    const asked = { chunks: 0, manifests: 0 };
    /** @param {string | URL | Request} input */
    const fetch = async input=>{
        const url = new URL(String(input));
        const body = depots.map(one=>one.routes.get(url.pathname)).find(Boolean);
        if (fail.includes(url.host) || !body)
        {
            return new Response(null, { status: fail.includes(url.host) ? 503 : 404 });
        }
        asked[url.pathname.includes('/chunk/') ? 'chunks' : 'manifests']++;
        return new Response(/** @type {Uint8Array<ArrayBuffer>} */ (body));
    };
    return { fetch, asked };
}

/** Bytes that do not repeat: a file of `size` from `seed`. @param {number} size @param {number} seed */
export function noise(size, seed){
    const out = new Uint8Array(size);
    let x = seed >>> 0 || 1;
    for (let at = 0; at < size; at++)
    {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[at] = x & 0xff;
    }
    return out;
}

/**
 * A file in memory as bundle-in-place.js reaches one: a worker's
 * FileSystemSyncAccessHandle's shape, growing as it is written.
 */
export function memoryFile(){
    let bytes = new Uint8Array(1 << 16);
    let size = 0;
    /** @param {number} wanted */
    const room = wanted=>{
        if (wanted > bytes.length)
        {
            const grown = new Uint8Array(Math.max(wanted, bytes.length * 2));
            grown.set(bytes.subarray(0, size));
            bytes = grown;
        }
    };
    return {
        /** @param {Uint8Array} buffer @param {{ at: number }} options */
        read(buffer, { at }){
            const part = bytes.subarray(at, Math.min(size, at + buffer.length));
            buffer.set(part);
            return part.length;
        },
        /** @param {Uint8Array} buffer @param {{ at: number }} options */
        write(buffer, { at }){
            room(at + buffer.length);
            bytes.set(buffer, at);
            size = Math.max(size, at + buffer.length);
            return buffer.length;
        },
        /** @param {number} length */
        truncate(length){
            // Past `size` is zeros, as a file grown by truncate reads.
            room(length);
            bytes.fill(0, length, size);
            size = length;
        },
        flush(){},
        getSize: ()=>size,
        /** The file as it is. */
        bytes: ()=>bytes.slice(0, size),
    };
}
