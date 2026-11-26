/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The writable layer of a run's volume, its pieces kept in the run's cache:
 * what a program writes is held in memory only while it is being written,
 * then put in the cache as a body of its own, the only copy (the cache keeps
 * it in shared memory and writes it to the run's folder for room or when
 * idle, never letting it go), and read from there in place.
 *
 * An installer writes gigabytes -- its own setup files unpacked, then what it
 * installs -- and a writable layer in memory held every byte of it on the
 * engine's thread until the tab was ended. A store of its own beside the
 * cache, a pool of pieces and a file on the disk, was a second budget and a
 * second disk neither of which the run's memory saw. A guest's ReadFile and
 * WriteFile answer synchronously, and so does the cache on the thread that
 * holds its keeper, which is the thread that holds the volume: a process in a
 * worker of its own reaches the volume across its link.
 *
 * Two parts: the page file (`createPageFile`), which knows pieces and nothing
 * of paths, shared by every drive of a run; and a store over it
 * (`createPageFileStore`), which keeps the same contract, answer for answer,
 * as the store in memory (`memory-store.js`) -- the differential gate holds
 * the two to that.
 */

import { ErrorCode, fsError } from './errors.js';
import { PIECE_SIZE, zeroes } from './memory-store.js';

/** The first piece of a small file; it doubles as the file grows, up to PIECE_SIZE. */
const SMALLEST_PIECE = 4096;

/**
 * Where the pieces are kept: one space of the run's cache, its bodies only
 * copies (`cacheSpace` with `onlyCopy` and `disk: 'run'`). `with` reads a body
 * in place, brought back from the disk first where it is cold (`wait`); `put`
 * replaces a body whole, false where the cache has no room for it.
 *
 * @typedef {Object} PieceSpace
 * @property {<T>(key: string, read: (body: Uint8Array) => T,
 *     options?: { wait?: boolean }) => T | undefined} with
 * @property {(key: string, bytes: Uint8Array) => boolean} put
 * @property {(key: string) => void} drop
 * @property {(key: string) => 'hot' | 'cold' | null} look
 */

/**
 * A piece of a file: its bytes while it is being written (`bytes`), else the
 * cache's body of it (`kept`). Shared by reference between a file and what a
 * `contents` handed out (`refs`), and copied before it is changed while more
 * than one holds it.
 *
 * @typedef {{ key: string, length: number, bytes: Uint8Array | null, kept: boolean,
 *     refs: number }} Piece
 */

/**
 * @typedef {ReturnType<typeof createPageFile>} PageFile
 */

/**
 * The bytes of pieces being written held in memory at most: an installer's
 * writes of a few kilobytes each fill a piece before it is put, so a piece is
 * put once, not once a write; past this the least recently written are put.
 */
export const WORKING_BYTES = 8 * 1024 * 1024;

/**
 * Trims a cache that had no room skips before it tries to put again, nothing
 * of this file let go of meanwhile: a refusal costs a look at the cache, and
 * a trim follows every write.
 */
const RETRY_EVERY = 256;

/**
 * A page file over `space`, holding at most `workingBytes` of pieces being
 * written in memory.
 *
 * A put the cache refuses -- no room left in it, its disk refusing too, or no
 * disk -- is said once through `onFailure`: the pieces stay in memory, as
 * they would in a store with no disk, and nothing the program wrote is lost.
 * They are put again once the cache may have room: a body of this file let
 * go of (a file deleted or cut, a piece brought in), or every
 * `RETRY_EVERY` trims for room another space let go of. A piece the cache
 * sent to its disk is brought back to be read; where its memory is all only
 * copies its full disk will not take, this file's own pieces in it are taken
 * into memory and let go of there, until it has room.
 *
 * @param {PieceSpace} space
 * @param {{ workingBytes?: number, onFailure?: (error: Error) => void,
 *     onClosed?: () => void }} [options]
 *     `onClosed`: the page file is done, after `close` and the last contents
 *     handed out were released
 */
export function createPageFile(space, { workingBytes = WORKING_BYTES, onFailure,
    onClosed } = {})
{
    /** The pieces being written, held in memory, least recently written first. @type {Set<Piece>} */
    const working = new Set();
    let workingTotal = 0;
    /** The number the next piece's body is named by. */
    let next = 0;
    /** The pieces the cache holds a body of, and their bytes. @type {Set<Piece>} */
    const kept = new Set();
    let keptBytes = 0;
    /** The cache's last refusal, said once. @type {Error | null} */
    let refused = null;
    /** Trims since the cache refused with nothing of this file let go of: none try to put. */
    let stalled = -1;
    let closing = false;
    let closed = false;
    /** Contents handed out and not yet released, which keep the page file past `close`. */
    let outstanding = 0;
    const counts = { put: 0, putBytes: 0, readBytes: 0, loaded: 0, copied: 0, takenOut: 0 };

    /** The cache's body of `piece` let go of, where it has one. @param {Piece} piece */
    const forget = piece=>{
        if (piece.kept)
        {
            space.drop(piece.key);
            piece.kept = false;
            kept.delete(piece);
            keptBytes -= piece.length;
            stalled = -1;
        }
    };

    /** The cache had no room: said the first time. */
    const refuse = ()=>{
        stalled = 0;
        if (!refused)
        {
            refused = new Error('the run\'s cache has no room for what the program wrote');
            onFailure?.(refused);
        }
    };

    /**
     * Takes one of this file's pieces the cache holds in memory into memory
     * of its own and lets its body go, for room to bring another back; false
     * where none is left there.
     */
    const takeOut = ()=>{
        for (const piece of kept)
        {
            if (space.look(piece.key) !== 'hot')
            {
                continue;
            }
            const bytes = new Uint8Array(piece.length);
            if (space.with(piece.key, body=>{
                bytes.set(body);
                return true;
            }) !== true)
            {
                continue;
            }
            forget(piece);
            piece.bytes = bytes;
            working.add(piece);
            workingTotal += piece.length;
            counts.takenOut++;
            refuse();
            return true;
        }
        return false;
    };

    /**
     * Puts the least recently written pieces in the cache until those held
     * fit: each replaces the body it had there.
     */
    const trim = ()=>{
        if (stalled >= 0 && ++stalled % RETRY_EVERY !== 0)
        {
            return;
        }
        for (const piece of working)
        {
            if (workingTotal <= workingBytes)
            {
                return;
            }
            const bytes = /** @type {Uint8Array} */ (piece.bytes);
            if (!space.put(piece.key, bytes))
            {
                refuse();
                return;
            }
            stalled = -1;
            if (!piece.kept)
            {
                piece.kept = true;
                kept.add(piece);
                keptBytes += piece.length;
            }
            working.delete(piece);
            workingTotal -= piece.length;
            piece.bytes = null;
            counts.put++;
            counts.putBytes += bytes.length;
        }
    };

    /**
     * Hands `length` bytes of `piece` from `within` to `put`, a view of where
     * they lie, valid inside the call.
     *
     * @param {Piece} piece @param {number} within @param {number} length
     * @param {(bytes: Uint8Array) => void} put
     */
    const read = (piece, within, length, put)=>{
        if (piece.bytes)
        {
            put(piece.bytes.subarray(within, within + length));
            return;
        }
        const part = (/** @type {Uint8Array} */ body)=>{
            put(body.subarray(within, within + length));
            return true;
        };
        while (space.with(piece.key, part, { wait: true }) !== true)
        {
            if (space.look(piece.key) !== 'cold' || !takeOut())
            {
                throw new Error(`page file: the run's cache lost a piece of ${piece.length} bytes`);
            }
        }
        counts.readBytes += length;
    };

    const finishClose = ()=>{
        if (!closed)
        {
            closed = true;
            onClosed?.();
        }
    };

    const pageFile = {
        /** @param {number} length @returns {Piece} */
        make(length){
            /** @type {Piece} */
            const piece = { key: String(next++), length, bytes: new Uint8Array(length),
                kept: false, refs: 1 };
            working.add(piece);
            workingTotal += length;
            return piece;
        },

        read,

        /**
         * A piece's bytes to change, in memory: held until `trim` puts it. Its
         * body in the cache is let go of as it is brought in: a piece is in
         * one place, so every byte written is held once, and a body is never
         * stale.
         *
         * @param {Piece} piece @returns {Uint8Array}
         */
        change(piece){
            if (!piece.bytes)
            {
                const bytes = new Uint8Array(piece.length);
                read(piece, 0, piece.length, part=>bytes.set(part));
                forget(piece);
                piece.bytes = bytes;
                workingTotal += piece.length;
                counts.loaded++;
            }
            working.delete(piece);
            working.add(piece);
            return piece.bytes;
        },

        /**
         * The piece to change: this one, or a copy of it where something else
         * holds it too.
         *
         * @param {Piece} piece @returns {Piece}
         */
        own(piece){
            if (piece.refs <= 1)
            {
                return piece;
            }
            const copy = pageFile.make(piece.length);
            const bytes = /** @type {Uint8Array} */ (copy.bytes);
            read(piece, 0, piece.length, part=>bytes.set(part));
            pageFile.release(piece);
            counts.copied++;
            return copy;
        },

        /**
         * Makes a piece of one holder longer, its bytes kept and the rest
         * zeroes, in memory (`change`).
         *
         * @param {Piece} piece @param {number} length
         */
        grow(piece, length){
            const bytes = new Uint8Array(length);
            bytes.set(pageFile.change(piece));
            workingTotal += length - piece.length;
            piece.bytes = bytes;
            piece.length = length;
        },

        /** @param {Piece} piece */
        hold(piece){
            piece.refs++;
        },

        /** @param {Piece} piece */
        release(piece){
            piece.refs--;
            if (piece.refs > 0)
            {
                return;
            }
            if (working.delete(piece))
            {
                workingTotal -= piece.length;
            }
            piece.bytes = null;
            forget(piece);
        },

        trim,

        /** Counts contents handed out, which keep the page file until released. */
        lend(){
            outstanding++;
        },
        /** One handed out is released. */
        unlend(){
            outstanding--;
            if (closing && outstanding === 0)
            {
                finishClose();
            }
        },

        /**
         * Done once nothing handed out still reads from it: a save under way
         * when the run ends reads its files to the end.
         */
        close(){
            closing = true;
            if (outstanding === 0)
            {
                finishClose();
            }
        },

        /** Bytes of pieces being written held in memory. */
        workingBytes: ()=>workingTotal,

        diagnostics(){
            return {
                ...refused ? { refused: refused.message, stalled: stalled >= 0 } : {},
                workingBytes: workingTotal,
                workingPieces: working.size,
                workingLimit: workingBytes,
                keptPieces: kept.size,
                keptBytes,
                ...counts,
                outstanding,
                closed,
            };
        },
    };
    return pageFile;
}

/**
 * A file of the store: its size and its pieces, a missing one all zeroes.
 *
 * @typedef {{ directory: boolean, size: number, pieces: (Piece | undefined)[] }} PagedFile
 */

/** @param {string} path */
function parentOf(path){
    const cut = path.lastIndexOf('\\');
    return cut < 0 ? '' : path.slice(0, cut);
}

/**
 * A writable store whose pieces live in `pageFile`. Several stores -- a run's
 * drives -- may stand on one page file, and hand contents between them
 * without copying.
 *
 * @param {PageFile} pageFile
 * @returns {import('./memory-store.js').WritableStore & { pageFile: PageFile }}
 */
export function createPageFileStore(pageFile){
    /** @type {Map<string, PagedFile>} */
    const entries = new Map();

    /**
     * Releases what a contents handed out held, once: by its `release`, or
     * when it is collected without one.
     */
    const outstanding = new FinalizationRegistry((/** @type {Piece[]} */ pieces)=>{
        letGo(pieces);
    });
    /** @param {Piece[]} pieces */
    const letGo = pieces=>{
        for (const piece of pieces)
        {
            pageFile.release(piece);
        }
        pageFile.unlend();
    };

    /** @param {string} path */
    const requireParent = path=>{
        const parent = parentOf(path);
        if (parent.length > 0 && !entries.get(parent)?.directory)
        {
            throw fsError(ErrorCode.PATH_NOT_FOUND, `No directory "${parent}" to hold "${path}"`);
        }
    };

    /** @param {string} path @returns {PagedFile} */
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
        /** @type {PagedFile} */
        const created = { directory: false, size: 0, pieces: [] };
        entries.set(path, created);
        return created;
    };

    /** @param {string} path @returns {PagedFile} */
    const existing = path=>{
        const entry = entries.get(path);
        if (!entry || entry.directory)
        {
            throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" to read`);
        }
        return entry;
    };

    /** @param {PagedFile} entry */
    const dropPieces = entry=>{
        for (const piece of entry.pieces)
        {
            if (piece)
            {
                pageFile.release(piece);
            }
        }
        entry.pieces = [];
    };

    /**
     * Hands `length` bytes of `pieces` from `offset` to `put`, at `into`
     * onward, each piece's part where it lies: in memory while it is being
     * written, else in the cache's body of it. Past a piece, and in one never
     * written, they are zeroes, handed too unless `zeroed` says the
     * destination holds them already.
     *
     * @param {(Piece | undefined)[]} pieces @param {number} offset @param {number} length
     * @param {import('./memory-store.js').Put} put @param {number} into @param {boolean} zeroed
     */
    const putOut = (pieces, offset, length, put, into, zeroed)=>{
        for (let done = 0; done < length;)
        {
            const at = offset + done;
            const piece = pieces[Math.floor(at / PIECE_SIZE)];
            const within = at % PIECE_SIZE;
            const span = Math.min(length - done, PIECE_SIZE - within);
            const held = piece ? Math.max(0, Math.min(span, piece.length - within)) : 0;
            if (held > 0)
            {
                const to = into + done;
                pageFile.read(/** @type {Piece} */ (piece), within, held, bytes=>put(bytes, to));
            }
            if (held < span && !zeroed)
            {
                put(zeroes(span - held), into + done + held);
            }
            done += span;
        }
    };

    /**
     * Copies `length` bytes of `pieces` from `offset` into `out` at `into`;
     * past a piece, and in one never written, they are zeroes, which `out`
     * already holds.
     *
     * @param {(Piece | undefined)[]} pieces @param {number} offset @param {number} length
     * @param {Uint8Array} out @param {number} into
     */
    const copyOut = (pieces, offset, length, out, into)=>
        putOut(pieces, offset, length, (bytes, at)=>out.set(bytes, at), into, true);

    /**
     * The bytes of the piece at `index`, this file's own and able to hold
     * `needed`, held to change: the store in memory's rule for its length
     * (`memory-store.js` `pieceFor`).
     *
     * @param {PagedFile} entry @param {number} index @param {number} needed
     * @returns {Uint8Array}
     */
    const pieceFor = (entry, index, needed)=>{
        let piece = entry.pieces[index];
        if (piece)
        {
            piece = pageFile.own(piece);
            entry.pieces[index] = piece;
        }
        if (!piece || piece.length < needed)
        {
            let length = Math.max(piece?.length ?? 0, index > 0 ? PIECE_SIZE : SMALLEST_PIECE);
            while (length < needed)
            {
                length *= 2;
            }
            length = Math.min(length, PIECE_SIZE);
            if (piece)
            {
                pageFile.grow(piece, length);
            }
            else
            {
                piece = pageFile.make(length);
                entry.pieces[index] = piece;
            }
        }
        return pageFile.change(piece);
    };

    /**
     * Contents another store of this page file takes without copying, read
     * a piece at a time by anyone else.
     *
     * @param {PagedFile} entry
     * @returns {import('./memory-store.js').FileContents}
     */
    const handOut = entry=>{
        const size = entry.size;
        const pieces = entry.pieces.slice();
        /** @type {Piece[]} */
        const held = [];
        for (const piece of pieces)
        {
            if (piece)
            {
                pageFile.hold(piece);
                held.push(piece);
            }
        }
        pageFile.lend();
        let released = false;
        const token = {};
        /** @param {number} offset @param {number} length */
        const read = (offset, length)=>{
            if (released)
            {
                throw new Error('page file: contents read after they were released');
            }
            const start = Math.min(Math.max(offset, 0), size);
            const out = new Uint8Array(Math.min(start + Math.max(length, 0), size) - start);
            copyOut(pieces, start, out.length, out, 0);
            return out;
        };
        /** @type {import('./memory-store.js').PagedContents & { pieces: typeof pieces,
         *     released: boolean }} */
        const paged = {
            owner: pageFile,
            pieces,
            get released(){
                return released;
            },
            /** @param {number} index */
            piece(index){
                if (!pieces[index])
                {
                    return undefined;
                }
                const at = index * PIECE_SIZE;
                return read(at, Math.min(PIECE_SIZE, size - at));
            },
            read,
            release(){
                if (released)
                {
                    return;
                }
                released = true;
                outstanding.unregister(token);
                letGo(held);
            },
        };
        // Released when nothing reaches what reads them any more: a reader
        // may keep the contents or only what reads them.
        /** @type {import('./memory-store.js').FileContents} */
        const contents = /** @type {any} */ ({ size, flat: null, paged });
        // Read whole only when a reader asks for pieces of its own: what a
        // store in memory takes, or an exit's files moved to the page.
        Object.defineProperty(contents, 'pieces', {
            enumerable: true,
            get: ()=>pieces.map((_, index)=>paged.piece(index)),
        });
        outstanding.register(paged, held, token);
        return contents;
    };

    /** @param {string} path @param {number} offset @param {Uint8Array} bytes */
    const write = (path, offset, bytes)=>{
        if (offset < 0)
        {
            throw fsError(ErrorCode.INVALID_PARAMETER, `Negative offset writing "${path}"`);
        }
        const entry = file(path);
        for (let done = 0; done < bytes.length;)
        {
            const at = offset + done;
            const index = Math.floor(at / PIECE_SIZE);
            const within = at % PIECE_SIZE;
            const span = Math.min(bytes.length - done, PIECE_SIZE - within);
            pieceFor(entry, index, within + span).set(bytes.subarray(done, done + span), within);
            pageFile.trim();
            done += span;
        }
        entry.size = Math.max(entry.size, offset + bytes.length);
    };

    return {
        pageFile,

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

        /** @param {string} path @param {number} offset @param {number} length */
        read(path, offset, length){
            const entry = existing(path);
            const start = Math.min(Math.max(offset, 0), entry.size);
            const end = Math.min(start + Math.max(length, 0), entry.size);
            const out = new Uint8Array(end - start);
            copyOut(entry.pieces, start, end - start, out, 0);
            return out;
        },

        /**
         * read, handed to `put` piece by piece where the bytes lie.
         *
         * @param {string} path @param {number} offset @param {number} length
         * @param {import('./memory-store.js').Put} put
         */
        readInto(path, offset, length, put){
            const entry = existing(path);
            const start = Math.min(Math.max(offset, 0), entry.size);
            const end = Math.min(start + Math.max(length, 0), entry.size);
            putOut(entry.pieces, start, end - start, put, 0, false);
            return end - start;
        },

        write,

        /** @param {string} path @param {number} size */
        truncate(path, size){
            if (size < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, `Negative size for "${path}"`);
            }
            const entry = file(path);
            if (size < entry.size)
            {
                // What lies past the new end reads as zeroes if the file grows
                // again, so the cut piece is cleared beyond it.
                const last = Math.floor(size / PIECE_SIZE);
                const within = size % PIECE_SIZE;
                const kept = Math.min(entry.pieces.length, within === 0 ? last : last + 1);
                for (const dropped of entry.pieces.splice(kept))
                {
                    if (dropped)
                    {
                        pageFile.release(dropped);
                    }
                }
                const piece = entry.pieces[last];
                if (within !== 0 && piece)
                {
                    pieceFor(entry, last, piece.length).fill(0, within);
                    pageFile.trim();
                }
            }
            entry.size = size;
        },

        /** @param {string} path @returns {import('./memory-store.js').FileContents} */
        contents(path){
            return handOut(existing(path));
        },

        /**
         * Takes contents handed out: the same pieces where they are this page
         * file's, a copy a piece at a time where they are not.
         *
         * @param {string} path @param {import('./memory-store.js').FileContents} contents
         */
        adoptContents(path, contents){
            const paged = /** @type {any} */ (contents.paged);
            if (paged?.released)
            {
                throw new Error('page file: contents adopted after they were released');
            }
            const entry = file(path);
            dropPieces(entry);
            entry.size = 0;
            if (paged?.owner === pageFile)
            {
                entry.pieces = paged.pieces.slice();
                for (const piece of entry.pieces)
                {
                    if (piece)
                    {
                        pageFile.hold(piece);
                    }
                }
                entry.size = contents.size;
                return;
            }
            for (let at = 0, index = 0; at < contents.size; at += PIECE_SIZE, index++)
            {
                const span = Math.min(PIECE_SIZE, contents.size - at);
                const part = contents.flat ? contents.flat.subarray(at, at + span)
                    : paged ? paged.piece(index) : contents.pieces[index]?.subarray(0, span);
                if (part)
                {
                    write(path, at, part);
                }
            }
            entry.size = contents.size;
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
            dropPieces(entry);
            entries.delete(path);
        },

        /** @param {string} path */
        mkdir(path){
            if (entries.has(path))
            {
                throw fsError(ErrorCode.ALREADY_EXISTS, `"${path}" already exists`);
            }
            requireParent(path);
            entries.set(path, { directory: true, size: 0, pieces: [] });
        },

        /** The page file's pieces held in memory, every store on it together. */
        heldBytes: ()=>pageFile.workingBytes(),
    };
}
