/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A disc image, as the read-only source of a drive.
 *
 * A guest read is synchronous, so this store is too: the image it serves was
 * opened with a function that answers at once -- a worker reading the chosen
 * file with `FileReaderSync`, a host reading a file descriptor, bytes already
 * in memory. Unlike a bundle, nothing has to be fetched first: every byte of a
 * disc is on this machine already, which is also why nothing here has a miss
 * to report.
 *
 * What makes it cheap is `chunkedReads`, which the image is opened through.
 * An installer reads its cabinets a few bytes of header at a time and then in
 * long runs, and every read of the chosen file costs a call into the browser;
 * aligned chunks kept for the next read turn the small reads into lookups and
 * leave the long ones alone.
 */

import { ErrorCode, fsError } from '../errors.js';
import { foldName } from '../paths.js';

/** The unit reads are rounded to, and how many of them are kept. */
const CHUNK_BYTES = 64 * 1024;
const CHUNKS_KEPT = 64;
/** A read this long goes straight to the image rather than through the chunks. */
const DIRECT_BYTES = 4 * CHUNK_BYTES;

/**
 * A synchronous range reader that keeps the last chunks it read.
 *
 * @param {(offset: number, length: number) => Uint8Array} read
 * @param {{ size: number, chunkBytes?: number, chunks?: number, directBytes?: number }} options
 *        `size` is the image's length: a read is never asked past it.
 * @returns {((offset: number, length: number) => Uint8Array) & { reads: () => number }}
 */
export function chunkedReads(read, {
    size, chunkBytes = CHUNK_BYTES, chunks = CHUNKS_KEPT, directBytes = DIRECT_BYTES,
})
{
    /** Kept in use order, the least recent first. @type {Map<number, Uint8Array>} */
    const kept = new Map();
    let reads = 0;

    /** @param {number} index */
    const chunk = index=>{
        const held = kept.get(index);
        if (held)
        {
            kept.delete(index);
            kept.set(index, held);
            return held;
        }
        const at = index * chunkBytes;
        reads++;
        const bytes = read(at, Math.min(chunkBytes, size - at));
        kept.set(index, bytes);
        if (kept.size > chunks)
        {
            kept.delete(/** @type {number} */ (kept.keys().next().value));
        }
        return bytes;
    };

    /** @param {number} offset @param {number} length */
    const reader = (offset, length)=>{
        const start = Math.max(0, Math.min(offset, size));
        const end = Math.max(start, Math.min(offset + length, size));
        if (end - start >= directBytes)
        {
            reads++;
            return read(start, end - start);
        }
        const out = new Uint8Array(end - start);
        for (let at = start; at < end;)
        {
            const index = Math.floor(at / chunkBytes);
            const bytes = chunk(index);
            const from = at - index * chunkBytes;
            const take = Math.min(end - at, bytes.length - from);
            if (take <= 0)
            {
                // The image ended sooner than its size said.
                return out.subarray(0, at - start);
            }
            out.set(bytes.subarray(from, from + take), at - start);
            at += take;
        }
        return out;
    };
    return Object.assign(reader, { reads: ()=>reads });
}

/**
 * @param {import('./iso9660.js').IsoImage} image  Opened with a synchronous reader.
 * @returns {import('../memory-store.js').SourceStore}
 */
export function createIsoSource(image){
    /** @type {Map<string, import('./iso9660.js').IsoEntry>} */
    const byPath = new Map(image.entries.map(entry=>[foldName(entry.path), entry]));

    /** @param {string} path */
    const entryAt = path=>byPath.get(foldName(path)) ?? null;

    return {
        list(){
            return image.entries.map(entry=>({
                path: entry.path,
                directory: entry.directory,
                size: entry.size,
                hidden: entry.hidden,
                ...entry.modified === null ? {} : { modified: entry.modified },
            }));
        },

        /** @param {string} path */
        stat(path){
            const entry = entryAt(path);
            return entry ? { directory: entry.directory, size: entry.size } : null;
        },

        /** @param {string} path @param {number} offset @param {number} length */
        read(path, offset, length){
            const entry = entryAt(path);
            if (!entry || entry.directory)
            {
                throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" on the disc`);
            }
            const bytes = image.read(entry, offset, length);
            if (!(bytes instanceof Uint8Array))
            {
                // A programming error in whoever opened the image, not a
                // condition of the disc: a drive cannot wait for its bytes.
                throw new Error('a disc mounted as a drive has to be opened with a '
                    + 'synchronous reader');
            }
            return bytes;
        },
    };
}
