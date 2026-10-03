/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A backing store that keeps its bytes in this process and nothing else.
 *
 * It exists twice over: as the writable layer of a build with no persistence,
 * and as the store every test in this layer runs against, so that the overlay
 * and the handle table are exercised without a browser anywhere near them.
 *
 * The store is deliberately dumb. It does not fold case, does not invent
 * directories, and knows nothing about drives or overlays -- a path is an
 * opaque key. Every Windows rule lives one level up, in the overlay, so that
 * there is exactly one place where those rules can be wrong.
 */

import { ErrorCode, fsError } from './errors.js';

/**
 * @typedef {Object} StoredStat
 * @property {boolean} directory
 * @property {number} size
 */

/**
 * @typedef {Object} StoredEntry
 * @property {string} path        Backslash-separated, relative to the mount root.
 * @property {boolean} directory
 * @property {number} size
 * @property {number} [modified]  Milliseconds since the epoch, where the store records it.
 * @property {boolean} [hidden]   Where the store records it: a disc's existence bit.
 */

/**
 * A read-only backing store. `list` is called once, when a drive is mounted:
 * the overlay indexes it and does not ask again, so a store that changes behind
 * the overlay's back is out of contract.
 *
 * @typedef {Object} SourceStore
 * @property {() => StoredEntry[]} list
 * @property {(path: string) => StoredStat | null} stat
 * @property {(path: string, offset: number, length: number) => Uint8Array} read
 */

/**
 * A writable backing store. `write` past the end of a file extends it, filling
 * the gap with zeroes, because that is what a guest seeking past EOF and
 * writing expects to find afterwards. It keeps a copy of the bytes it is given
 * and never the array: a writer may hand it a view of memory it reuses.
 *
 * The overlay guarantees that the parent directory of anything it writes has
 * been created first, so a store never has to invent one.
 *
 * @typedef {Object} WritableStoreMethods
 * @property {(path: string, offset: number, bytes: Uint8Array) => void} write
 * @property {(path: string, size: number) => void} truncate
 * @property {(path: string) => void} remove
 * @property {(path: string) => void} mkdir
 * @property {(path: string) => Uint8Array} [share]  A file's whole contents, which
 *           the store never changes afterwards: it copies them before it next
 *           changes the file, so the caller may hand them on as they are.
 * @property {(path: string, bytes: Uint8Array) => void} [adopt]  Makes `bytes` a
 *           file's contents without copying them, and never writes into them.
 * @property {(from: string, to: string) => void} [move]  Gives a file another
 *           path, its bytes staying where they are; `to` must not exist and its
 *           parent must. A store that cannot leaves it out, and a move copies.
 * @property {(path: string) => FileContents} [contents]  A file's contents as
 *           another store of this kind takes them without copying: what one
 *           process's volume hands the next. Neither store's later writes reach
 *           the other's, each copying a piece before it first changes it.
 * @property {(path: string, contents: FileContents) => void} [adoptContents]
 *           Makes a file of contents another store handed out.
 */

/**
 * A file's contents in the form they are kept: whole, or in pieces.
 *
 * @typedef {{ size: number, flat: Uint8Array | null,
 *     pieces: (Uint8Array | undefined)[] }} FileContents
 */

/** @typedef {SourceStore & WritableStoreMethods} WritableStore */

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
 * How much of a file one piece of its storage holds. A file is kept in pieces
 * so that one growing by a gigabyte never needs a gigabyte in one piece, nor
 * has the bytes it already holds copied to grow: an installer unpacks an
 * archive of a gigabyte or more thirty-two kilobytes at a time, and a buffer
 * doubled to make room copied the whole file at every doubling -- seconds of
 * the install, and a piece larger than a browser will allocate past two.
 */
export const PIECE_SIZE = 1 << 20;

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
 * The bytes of contents a store handed out, whole: what a reader that wants
 * one array, a session written out or a bottle packed, is given.
 *
 * @param {FileContents} contents
 * @returns {Uint8Array}
 */
export function bytesOf(contents){
    if (contents.flat)
    {
        return contents.flat;
    }
    const out = new Uint8Array(contents.size);
    contents.pieces.forEach((piece, index)=>{
        if (piece)
        {
            const at = index * PIECE_SIZE;
            out.set(piece.subarray(0, Math.max(0, Math.min(piece.length, contents.size - at))), at);
        }
    });
    return out;
}

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
     * Copies `length` bytes from `offset` into `out` at `into`; past the size,
     * and in a piece never written, they are zeroes, which `out` already holds.
     *
     * @param {StoredFile} entry @param {number} offset @param {number} length
     * @param {Uint8Array} out @param {number} into
     */
    const copyOut = (entry, offset, length, out, into)=>{
        if (entry.flat)
        {
            out.set(entry.flat.subarray(offset, offset + length), into);
            return;
        }
        for (let done = 0; done < length;)
        {
            const at = offset + done;
            const piece = entry.pieces[Math.floor(at / PIECE_SIZE)];
            const within = at % PIECE_SIZE;
            const span = Math.min(length - done, PIECE_SIZE - within);
            if (piece && within < piece.length)
            {
                out.set(piece.subarray(within, within + span), into + done);
            }
            done += span;
        }
    };

    /**
     * Makes a file's bytes its own pieces, from whole ones that are -- or may
     * be -- someone else's: the copy on a first change.
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
        entry.lent = null;
        for (let at = 0; at < entry.size; at += PIECE_SIZE)
        {
            entry.pieces.push(flat.slice(at, Math.min(at + PIECE_SIZE, entry.size)));
        }
    };

    /**
     * The piece at `index`, this store's own, able to hold `needed` bytes: a
     * short last piece is doubled, so a small file costs what it holds, not a
     * whole piece, and one another store holds too is copied first.
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
        let length = Math.max(piece?.length ?? 0, 4096);
        while (length < needed)
        {
            length *= 2;
        }
        const grown = new Uint8Array(Math.min(length, PIECE_SIZE));
        if (piece)
        {
            grown.set(piece);
        }
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
        entries.set(path, fileOf(toBytes(content)));
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
                entry.pieces.length = Math.min(entry.pieces.length, within === 0 ? last : last + 1);
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
            entry.size = contents.size;
            entry.flat = contents.flat;
            entry.shared = contents.flat !== null;
            entry.pieces = contents.pieces.slice();
            entry.lent = contents.flat ? null : entry.pieces.map(()=>true);
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
            if (!entries.delete(path))
            {
                throw fsError(ErrorCode.NOT_FOUND, `Nothing at "${path}" to remove`);
            }
        },

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
