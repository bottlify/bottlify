/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A backing store that keeps its bytes in this process and nothing else: the
 * store every test of this layer runs against, so that the overlay and the
 * handle table are exercised without a cache or a browser anywhere near
 * them, and the reference the page file's store is held to answer for answer
 * (`tree-agreement.itest.js`). No run keeps its writes here: a run's writable
 * layer is its page file, in the run's cache.
 */

import { ErrorCode, fsError } from './errors.js';
import { PIECE_SIZE, SMALLEST_PIECE, zeroes } from './memory-store.js';

/** @typedef {import('./memory-store.js').WritableStore} WritableStore */
/** @typedef {import('./memory-store.js').FileContents} FileContents */
/** @typedef {import('./memory-store.js').Put} Put */

/** @param {string} path */
function parentOf(path){
    const cut = path.lastIndexOf('\\');
    return cut < 0 ? '' : path.slice(0, cut);
}

/**
 * @param {string | Uint8Array} content
 * @returns {Uint8Array}
 */
function toBytes(content){
    return typeof content === 'string'
        ? Uint8Array.from([...content].map(character=>character.charCodeAt(0) & 0xff))
        : Uint8Array.from(content);
}

/**
 * A file: its size, and its bytes either in pieces of PIECE_SIZE -- the last
 * one growing by doubling until it is whole, a missing one all zeroes -- or
 * whole in `flat`, as it arrived or as `share` handed it out. `shared` means
 * `flat` is also someone else's, so the first change copies it into pieces;
 * `lent` marks the pieces another store holds too, each copied before it is
 * first changed here.
 *
 * @typedef {{ directory: boolean, size: number, pieces: (Uint8Array | undefined)[],
 *     flat: Uint8Array | null, shared: boolean, lent: boolean[] | null }} StoredFile
 */

/**
 * Builds a store, optionally seeded.
 *
 * A seed maps a path to its contents; `null` seeds a directory. Parent
 * directories implied by a seeded path are created, since spelling every one of
 * them out in a fixture teaches nothing about the code under test.
 *
 * @param {Record<string, string | Uint8Array | null>} [seed]
 * @returns {WritableStore}
 */
export function createMemoryStore(seed = {}){
    /** @type {Map<string, StoredFile>} */
    const entries = new Map();
    /** The bytes every file's pieces and whole contents hold, for `heldBytes`. */
    let held = 0;

    /** @param {StoredFile} entry @returns {number} */
    const weigh = entry=>entry.flat
        ? entry.flat.length
        : entry.pieces.reduce((sum, piece)=>sum + (piece?.length ?? 0), 0);

    /** @param {Uint8Array | null} flat @returns {StoredFile} */
    const fileOf = flat=>({ directory: false, size: flat?.length ?? 0, pieces: [], flat,
        shared: false, lent: null });

    /** @param {string} path */
    const makeDirectory = path=>{
        if (path.length === 0 || entries.has(path))
        {
            return;
        }
        makeDirectory(parentOf(path));
        entries.set(path, { ...fileOf(null), directory: true });
    };

    /** @param {string} path */
    const requireParent = path=>{
        const parent = parentOf(path);
        if (parent.length > 0 && !entries.get(parent)?.directory)
        {
            throw fsError(ErrorCode.PATH_NOT_FOUND, `No directory "${parent}" to hold "${path}"`);
        }
    };

    /** @param {string} path @returns {StoredFile} */
    const file = path=>{
        const entry = entries.get(path);
        if (entry && entry.directory)
        {
            throw fsError(ErrorCode.IS_A_DIRECTORY, `"${path}" is a directory`);
        }
        if (entry)
        {
            return entry;
        }
        requireParent(path);
        const created = fileOf(null);
        entries.set(path, created);
        return created;
    };

    /** @param {string} path @returns {StoredFile} */
    const existing = path=>{
        const entry = entries.get(path);
        if (!entry || entry.directory)
        {
            throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" to read`);
        }
        return entry;
    };

    /**
     * Hands `length` bytes from `offset` to `put`, at `into` onward, where
     * they lie: the whole bytes, or each piece's part. Past a piece, and in a
     * piece never written, they are zeroes, handed too unless `zeroed` says
     * the destination holds them already.
     *
     * @param {StoredFile} entry @param {number} offset @param {number} length
     * @param {Put} put @param {number} into @param {boolean} zeroed
     */
    const putOut = (entry, offset, length, put, into, zeroed)=>{
        if (entry.flat)
        {
            put(entry.flat.subarray(offset, offset + length), into);
            return;
        }
        for (let done = 0; done < length;)
        {
            const at = offset + done;
            const piece = entry.pieces[Math.floor(at / PIECE_SIZE)];
            const within = at % PIECE_SIZE;
            const span = Math.min(length - done, PIECE_SIZE - within);
            const here = piece ? Math.max(0, Math.min(span, piece.length - within)) : 0;
            if (here > 0)
            {
                put(/** @type {Uint8Array} */ (piece).subarray(within, within + here), into + done);
            }
            if (here < span && !zeroed)
            {
                put(zeroes(span - here), into + done + here);
            }
            done += span;
        }
    };

    /**
     * Copies `length` bytes from `offset` into `out` at `into`; past the size,
     * and in a piece never written, they are zeroes, which `out` already holds.
     *
     * @param {StoredFile} entry @param {number} offset @param {number} length
     * @param {Uint8Array} out @param {number} into
     */
    const copyOut = (entry, offset, length, out, into)=>
        putOut(entry, offset, length, (bytes, at)=>out.set(bytes, at), into, true);

    /**
     * Makes a file kept whole a file kept in pieces, before its first change:
     * each piece a view of the whole bytes, lent, so only the pieces the
     * change reaches are copied -- a write of a few bytes into an archive of
     * a gigabyte copied the gigabyte.
     *
     * @param {StoredFile} entry
     */
    const intoPieces = entry=>{
        const flat = entry.flat;
        if (!flat)
        {
            return;
        }
        entry.flat = null;
        entry.shared = false;
        entry.pieces = [];
        for (let at = 0; at < entry.size; at += PIECE_SIZE)
        {
            entry.pieces.push(flat.subarray(at, Math.min(at + PIECE_SIZE, entry.size)));
        }
        entry.lent = entry.pieces.map(()=>true);
    };

    /**
     * The piece at `index`, this store's own, able to hold `needed` bytes: a
     * short last piece of a small file is doubled, so the file costs what it
     * holds, not a whole piece, and one another store holds too is copied
     * first. A piece after the first is whole from the start: the file is
     * past small, and growing it by doubling would copy, and touch fresh
     * memory for, twice what it holds.
     *
     * @param {StoredFile} entry @param {number} index @param {number} needed
     */
    const pieceFor = (entry, index, needed)=>{
        const piece = entry.pieces[index];
        const lent = entry.lent?.[index] === true;
        if (lent && entry.lent)
        {
            entry.lent[index] = false;
        }
        if (piece && piece.length >= needed && !lent)
        {
            return piece;
        }
        let length = Math.max(piece?.length ?? 0, index > 0 ? PIECE_SIZE : SMALLEST_PIECE);
        while (length < needed)
        {
            length *= 2;
        }
        const grown = new Uint8Array(Math.min(length, PIECE_SIZE));
        if (piece)
        {
            grown.set(piece);
        }
        held += grown.length - (piece?.length ?? 0);
        entry.pieces[index] = grown;
        return grown;
    };

    for (const [path, content] of Object.entries(seed))
    {
        makeDirectory(parentOf(path));
        if (content === null)
        {
            makeDirectory(path);
            continue;
        }
        const made = fileOf(toBytes(content));
        held += weigh(made);
        entries.set(path, made);
    }

    return {
        list(){
            return [...entries.entries()].map(([path, entry])=>({
                path,
                directory: entry.directory,
                size: entry.size,
            }));
        },

        /** @param {string} path */
        stat(path){
            const entry = entries.get(path);
            return entry ? { directory: entry.directory, size: entry.size } : null;
        },

        /**
         * A read that starts past the end returns nothing rather than failing:
         * end of file is a length, not an error.
         *
         * @param {string} path @param {number} offset @param {number} length
         */
        read(path, offset, length){
            const entry = existing(path);
            const start = Math.min(Math.max(offset, 0), entry.size);
            const end = Math.min(start + Math.max(length, 0), entry.size);
            if (entry.flat)
            {
                return entry.flat.slice(start, end);
            }
            const out = new Uint8Array(end - start);
            copyOut(entry, start, end - start, out, 0);
            return out;
        },

        /**
         * read, handed to `put` where the bytes lie: the caller's one copy is
         * from the store's own arrays.
         *
         * @param {string} path @param {number} offset @param {number} length @param {Put} put
         */
        readInto(path, offset, length, put){
            const entry = existing(path);
            const start = Math.min(Math.max(offset, 0), entry.size);
            const end = Math.min(start + Math.max(length, 0), entry.size);
            putOut(entry, start, end - start, put, 0, false);
            return end - start;
        },

        /** @param {string} path @param {number} offset @param {Uint8Array} bytes */
        write(path, offset, bytes){
            if (offset < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, `Negative offset writing "${path}"`);
            }
            const entry = file(path);
            intoPieces(entry);
            for (let done = 0; done < bytes.length;)
            {
                const at = offset + done;
                const index = Math.floor(at / PIECE_SIZE);
                const within = at % PIECE_SIZE;
                const span = Math.min(bytes.length - done, PIECE_SIZE - within);
                pieceFor(entry, index, within + span)
                    .set(bytes.subarray(done, done + span), within);
                done += span;
            }
            entry.size = Math.max(entry.size, offset + bytes.length);
        },

        /** @param {string} path @param {number} size */
        truncate(path, size){
            if (size < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, `Negative size for "${path}"`);
            }
            const entry = file(path);
            intoPieces(entry);
            if (size < entry.size)
            {
                // What lies past the new end reads as zeroes if the file grows
                // again, so the cut piece is cleared beyond it.
                const last = Math.floor(size / PIECE_SIZE);
                const within = size % PIECE_SIZE;
                const kept = Math.min(entry.pieces.length, within === 0 ? last : last + 1);
                for (const dropped of entry.pieces.slice(kept))
                {
                    held -= dropped?.length ?? 0;
                }
                entry.pieces.length = kept;
                entry.lent?.splice(kept);
                const piece = entry.pieces[last];
                if (within !== 0 && piece)
                {
                    pieceFor(entry, last, piece.length).fill(0, within);
                }
            }
            entry.size = size;
        },

        /**
         * A file's whole contents: kept whole from here on, so a second share
         * is the same bytes, and copied into pieces before it next changes.
         *
         * @param {string} path
         */
        share(path){
            const entry = existing(path);
            if (!entry.flat)
            {
                const flat = new Uint8Array(entry.size);
                copyOut(entry, 0, entry.size, flat, 0);
                held += flat.length - weigh(entry);
                entry.flat = flat;
                entry.pieces = [];
                entry.lent = null;
            }
            entry.shared = true;
            return entry.flat;
        },

        /** @param {string} path @param {Uint8Array} bytes */
        adopt(path, bytes){
            const entry = file(path);
            held += bytes.length - weigh(entry);
            entry.flat = bytes;
            entry.pieces = [];
            entry.lent = null;
            entry.size = bytes.length;
            entry.shared = true;
        },

        /** @param {string} path @returns {FileContents} */
        contents(path){
            const entry = existing(path);
            if (entry.flat)
            {
                entry.shared = true;
                return { size: entry.size, flat: entry.flat, pieces: [] };
            }
            entry.lent = entry.pieces.map(()=>true);
            return { size: entry.size, flat: null, pieces: entry.pieces.slice() };
        },

        /** @param {string} path @param {FileContents} contents */
        adoptContents(path, contents){
            const entry = file(path);
            held -= weigh(entry);
            entry.size = contents.size;
            entry.flat = contents.flat;
            entry.shared = contents.flat !== null;
            entry.pieces = contents.flat ? [] : contents.pieces.slice();
            entry.lent = contents.flat ? null : entry.pieces.map(()=>true);
            held += weigh(entry);
        },

        /** @param {string} from @param {string} to */
        move(from, to){
            const entry = entries.get(from);
            if (!entry || entry.directory)
            {
                throw fsError(ErrorCode.NOT_FOUND, `No file "${from}" to move`);
            }
            if (entries.has(to))
            {
                throw fsError(ErrorCode.ALREADY_EXISTS, `"${to}" already exists`);
            }
            requireParent(to);
            entries.delete(from);
            entries.set(to, entry);
        },

        /** @param {string} path */
        remove(path){
            const entry = entries.get(path);
            if (!entry)
            {
                throw fsError(ErrorCode.NOT_FOUND, `Nothing at "${path}" to remove`);
            }
            held -= weigh(entry);
            entries.delete(path);
        },

        /**
         * What the store holds of the tab's memory: every piece and whole
         * contents it keeps, lent ones and views of another's whole bytes
         * included -- they live as long as this store keeps them.
         */
        heldBytes: ()=>held,

        /** @param {string} path */
        mkdir(path){
            if (entries.has(path))
            {
                throw fsError(ErrorCode.ALREADY_EXISTS, `"${path}" already exists`);
            }
            requireParent(path);
            entries.set(path, { ...fileOf(null), directory: true });
        },
    };
}
