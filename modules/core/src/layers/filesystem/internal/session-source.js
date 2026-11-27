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
 * Pieces are kept where the caller says (`kept`, a space of the run's cache),
 * read there in place, and let go of as that place decides: what was read
 * once is in the store it came from, so a piece let go of is read from there
 * again. A piece the place had no room for is held here until the next fetch
 * begins with none in flight, so that the read waiting on it finds it.
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
 * Where pieces are kept: a space of the run's cache (`cache` layer,
 * `CacheSpace`), its bodies read in place inside `with`; `put` false where
 * it had no room.
 *
 * @typedef {{ look: (key: string) => 'hot' | 'cold' | null,
 *     with: <T>(key: string, read: (body: Uint8Array) => T, options?: { wait?: boolean })
 *         => T | undefined,
 *     put: (key: string, bytes: Uint8Array) => boolean }} PieceSpace
 */

/** A place that keeps nothing: every piece is held only from its fetch to the next. */
const KEEP_NOTHING = Object.freeze(/** @type {PieceSpace} */ ({
    look: ()=>null,
    with: ()=>undefined,
    put: ()=>false,
}));

/**
 * @param {{ path: string, file: LazyFile }[]} files  `path` relative to the
 *     drive's root; `file` handed back as it is by `kept`
 * @param {{ kept?: PieceSpace }} [options]  where the pieces read are kept,
 *     their keys this source's alone
 */
export function createSessionSource(files, { kept = KEEP_NOTHING } = {}){
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
    /**
     * Pieces `kept` had no room for, by index: held from their fetch until a
     * fetch begins with none in flight, the reads waiting on them done.
     *
     * @type {Map<number, Uint8Array>}
     */
    const unkept = new Map();
    let unkeptBytes = 0;
    let fetching = 0;
    const counts = { fetches: 0, pieces: 0, bytes: 0, unkept: 0 };
    /** @param {number} index */
    const present = index=>unkept.has(index) || kept.look(String(index)) !== null;
    /**
     * Hands `index`'s bytes from `from` to `to` (within the piece) to `put`
     * at `into`: false where the piece is gone since it was looked at.
     *
     * @param {number} index @param {number} from @param {number} to
     * @param {import('./memory-store.js').Put} put @param {number} into
     */
    const handOut = (index, from, to, put, into)=>{
        const held = unkept.get(index);
        if (held)
        {
            put(held.subarray(from, to), into);
            return true;
        }
        return kept.with(String(index), body=>{
            put(body.subarray(from, to), into);
            return true;
        }, { wait: true }) === true;
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

    const source = {
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
         * From the pieces kept, each part handed to `put` where it lies, or a
         * miss naming every piece of the range not here (nothing handed then).
         * A piece let go of between the look and its read (another thread
         * made room) leaves the parts before it handed; the caller fetches
         * and reads the range again, handed the same bytes again.
         *
         * @param {string} path @param {number} offset @param {number} length
         * @param {import('./memory-store.js').Put} put
         */
        readInto(path, offset, length, put){
            const { file, number } = mustFind(path);
            const end = Math.min(file.size, offset + length);
            if (end <= offset)
            {
                return 0;
            }
            const first = Math.floor(offset / PIECE_SIZE);
            const last = Math.floor((end - 1) / PIECE_SIZE);
            /** @param {number} piece */
            const missOf = piece=>{
                const at = piece * PIECE_SIZE;
                return { layer: SESSION_LAYER, index: number * PIECES_PER_FILE + piece,
                    offset: at, packed: Math.min(PIECE_SIZE, file.size - at) };
            };
            /** @type {{ layer: string, index: number, offset: number, packed: number }[]} */
            const missing = [];
            for (let piece = first; piece <= last; piece++)
            {
                if (!present(number * PIECES_PER_FILE + piece))
                {
                    missing.push(missOf(piece));
                }
            }
            for (let piece = first; piece <= last && missing.length === 0; piece++)
            {
                const at = piece * PIECE_SIZE;
                const from = Math.max(offset, at) - at;
                const to = Math.min(end, at + PIECE_SIZE) - at;
                if (!handOut(number * PIECES_PER_FILE + piece, from, to, put, at + from - offset))
                {
                    missing.push(missOf(piece));
                }
            }
            if (missing.length > 0)
            {
                throw Object.assign(new Error(
                    `${missing.length} piece(s) of "${path}" are not read from the session yet`),
                { code: BLOCK_MISS, blocks: missing });
            }
            return end - offset;
        },

        /**
         * readInto, copied out: whoever gets these bytes may keep or write them.
         *
         * @param {string} path @param {number} offset @param {number} length
         */
        read(path, offset, length){
            const { file } = mustFind(path);
            const out = new Uint8Array(Math.max(0, Math.min(file.size, offset + length) - offset));
            source.readInto(path, offset, length, (bytes, at)=>out.set(bytes, at));
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
         * Reads the pieces a miss named. Each is kept once read, or held here
         * where `kept` has no room for it.
         *
         * @param {{ index: number }[]} needed
         */
        async fetch(needed){
            counts.fetches++;
            if (fetching === 0)
            {
                unkept.clear();
                unkeptBytes = 0;
            }
            fetching++;
            try
            {
                await Promise.all(needed.map(async({ index })=>{
                    const file = numbered[Math.floor(index / PIECES_PER_FILE)];
                    const at = (index % PIECES_PER_FILE) * PIECE_SIZE;
                    const bytes = await file.read(at, Math.min(PIECE_SIZE, file.size - at));
                    counts.pieces++;
                    counts.bytes += bytes.length;
                    if (!kept.put(String(index), bytes) && !unkept.has(index))
                    {
                        counts.unkept++;
                        unkept.set(index, bytes);
                        unkeptBytes += bytes.length;
                    }
                }));
            }
            finally
            {
                fetching--;
            }
        },

        /**
         * What it holds of the heap itself: the pieces `kept` had no room for.
         * Those kept are the cache's, counted there.
         */
        held: ()=>({ sessionUnkept: unkeptBytes }),

        /** What it read of the session: fetches, pieces and their bytes, and those not kept. */
        reads: ()=>({ ...counts }),
    };
    return source;
}
