/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A saved session as a read-only source under a drive's writable layer, its
 * files read when the program reads them.
 *
 * A session laid on the volume whole before the first instruction read every
 * byte of it and wrote every byte into the writable layer again: a bottle
 * holding the .NET Framework and the folders its setup unpacked, 2 GB in
 * 1760 files, spent 54 s of an 80 s start doing it. Under the writable layer
 * it costs nothing until a file is read, and a file is read a piece at a time
 * (`PIECE_SIZE`), as a bundle is a block at a time: a read of a piece not here
 * throws a miss naming the pieces it needs (`BLOCK_MISS`, `layer` 'session'),
 * whoever can wait fetches them (`fetch`) and reads again. The overlay's rules
 * do the rest: a write copies the file up, a delete leaves a tombstone.
 *
 * Pieces are kept in the heap, the least recently used let go of past
 * `residentBytes`: what was read once is in the store it came from.
 */

import { ErrorCode, fsError } from './errors.js';
import { foldName } from './paths.js';
import { BLOCK_MISS } from './bundle/source.js';
import { PIECE_SIZE } from './memory-store.js';

/** What a miss of this source tags its pieces with, for the run's fetch to route them. */
export const SESSION_LAYER = 'session';

/** A piece's index: its file's number times this, plus the piece's place in the file. */
const PIECES_PER_FILE = 2 ** 21;

/**
 * A file of a session read lazily: its size now, its bytes when asked.
 *
 * @typedef {{ path: string, size: number, modified?: number,
 *     read: (offset?: number, length?: number) => Promise<Uint8Array> }} LazyFile
 */

/**
 * @param {{ path: string, file: LazyFile }[]} files  `path` relative to the
 *     drive's root; `file` handed back as it is by `kept`
 * @param {{ residentBytes?: number }} [options]
 */
export function createSessionSource(files, { residentBytes = 32 << 20 } = {}){
    /** @type {Map<string, { path: string, file: LazyFile, number: number }>} by folded path */
    const byPath = new Map();
    /** @type {Set<string>} folded */
    const directories = new Set();
    /** @type {LazyFile[]} by number */
    const numbered = [];
    for (const { path, file } of files)
    {
        const parts = path.split('\\').filter(part=>part.length > 0);
        for (let depth = 1; depth < parts.length; depth++)
        {
            directories.add(foldName(parts.slice(0, depth).join('\\')));
        }
        byPath.set(foldName(parts.join('\\')),
            { path: parts.join('\\'), file, number: numbered.length });
        numbered.push(file);
    }
    /** @type {Map<number, Uint8Array>} by piece index, the least recently used first */
    const resident = new Map();
    let held = 0;
    const counts = { fetches: 0, pieces: 0, bytes: 0 };

    /** @param {number} index @param {Uint8Array} bytes */
    const keep = (index, bytes)=>{
        const before = resident.get(index);
        if (before)
        {
            held -= before.length;
            resident.delete(index);
        }
        resident.set(index, bytes);
        held += bytes.length;
        for (const [oldest, kept] of resident)
        {
            if (held <= residentBytes || oldest === index)
            {
                break;
            }
            resident.delete(oldest);
            held -= kept.length;
        }
    };

    /** @param {string} path */
    const mustFind = path=>{
        const found = byPath.get(foldName(path));
        if (!found)
        {
            throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" in this session`);
        }
        return found;
    };

    return {
        list: ()=>[...byPath.values()].map(({ path, file })=>({ path, directory: false,
            size: file.size,
            ...typeof file.modified === 'number' ? { modified: file.modified } : {} })),

        /** @param {string} path */
        stat(path){
            const found = byPath.get(foldName(path));
            if (found)
            {
                return { directory: false, size: found.file.size };
            }
            return directories.has(foldName(path)) ? { directory: true, size: 0 } : null;
        },

        /**
         * From resident pieces, or a miss naming every piece of the range not here.
         *
         * @param {string} path @param {number} offset @param {number} length
         */
        read(path, offset, length){
            const { file, number } = mustFind(path);
            const end = Math.min(file.size, offset + length);
            if (end <= offset)
            {
                return new Uint8Array(0);
            }
            const first = Math.floor(offset / PIECE_SIZE);
            const last = Math.floor((end - 1) / PIECE_SIZE);
            /** @type {{ layer: string, index: number, offset: number, packed: number }[]} */
            const missing = [];
            for (let piece = first; piece <= last; piece++)
            {
                const index = number * PIECES_PER_FILE + piece;
                const bytes = resident.get(index);
                if (bytes)
                {
                    // The most recently used now.
                    resident.delete(index);
                    resident.set(index, bytes);
                    continue;
                }
                const at = piece * PIECE_SIZE;
                missing.push({ layer: SESSION_LAYER, index, offset: at,
                    packed: Math.min(PIECE_SIZE, file.size - at) });
            }
            if (missing.length > 0)
            {
                throw Object.assign(new Error(
                    `${missing.length} piece(s) of "${path}" are not read from the session yet`),
                { code: BLOCK_MISS, blocks: missing });
            }
            const out = new Uint8Array(end - offset);
            for (let piece = first; piece <= last; piece++)
            {
                const bytes = /** @type {Uint8Array} */ (
                    resident.get(number * PIECES_PER_FILE + piece));
                const at = piece * PIECE_SIZE;
                const from = Math.max(offset, at) - at;
                const to = Math.min(end, at + bytes.length) - at;
                out.set(bytes.subarray(from, to), at + from - offset);
            }
            return out;
        },

        /**
         * The session's own file at `path`, as it was handed in: what an export
         * of the volume carries for a file the program has not touched, so the
         * store it came from knows it holds it already.
         *
         * @param {string} path @returns {LazyFile | null}
         */
        kept: path=>byPath.get(foldName(path))?.file ?? null,

        /**
         * Reads the pieces a miss named. Each is kept once read.
         *
         * @param {{ index: number }[]} needed
         */
        async fetch(needed){
            counts.fetches++;
            await Promise.all(needed.map(async({ index })=>{
                const file = numbered[Math.floor(index / PIECES_PER_FILE)];
                const at = (index % PIECES_PER_FILE) * PIECE_SIZE;
                const bytes = await file.read(at, Math.min(PIECE_SIZE, file.size - at));
                counts.pieces++;
                counts.bytes += bytes.length;
                keep(index, bytes);
            }));
        },

        /** What it holds of the heap, and what it has read. */
        held: ()=>({ sessionPieces: held, sessionReads: counts.pieces,
            sessionReadBytes: counts.bytes }),
    };
}
