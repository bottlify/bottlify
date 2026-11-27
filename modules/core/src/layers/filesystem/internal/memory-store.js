/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The contract of a drive's backing stores - a read-only source (a bundle, a
 * disc, a session's files) and the writable layer over it - and what they
 * hand one another: a file's contents whole or in pieces, and reads handed
 * out where the bytes lie. The writable layer of a run is its page file
 * (`page-file.js`); a store in memory for tests is `memory-store.fixture.js`.
 *
 * A store is deliberately dumb. It does not fold case, does not invent
 * directories, and knows nothing about drives or overlays -- a path is an
 * opaque key. Every Windows rule lives one level up, in the overlay, so that
 * there is exactly one place where those rules can be wrong.
 */

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
 * @property {(path: string, offset: number, length: number, put: Put) => number} [readInto]
 *           read, the bytes handed to `put` where they lie (`Put`) rather than
 *           answered; how many there were. A store whose bytes are already
 *           arrays of its own offers it: the caller's one copy is from them.
 * @property {(path: string) => object | null} [kept]  A file the source keeps as
 *           its own, which an export of the volume carries while the program
 *           has not written it: a session's (`session-source.js`). A bundle keeps
 *           none - it is fetched by digest, never uploaded.
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
 * @property {() => number} [heldBytes]  What the store holds of the tab's
 *           memory: the bytes of every piece it keeps, lent ones included.
 */

/**
 * A file's contents in the form they are kept: whole, or in pieces. A store
 * that keeps its pieces on a disk (`page-file.js`) hands them out `paged`: read
 * a piece at a time, and let go of with `release` once whoever took them is
 * done -- until then the store copies a piece before it changes it. Its
 * `pieces` are read whole when asked for, a copy each.
 *
 * @typedef {{ size: number, flat: Uint8Array | null,
 *     pieces: (Uint8Array | undefined)[], paged?: PagedContents }} FileContents
 */

/**
 * @typedef {Object} PagedContents
 * @property {unknown} owner  The page file the pieces are kept in.
 * @property {(index: number) => Uint8Array | undefined} piece  A piece's bytes,
 *           a copy, or undefined for one never written (zeroes).
 * @property {(offset: number, length: number) => Uint8Array} read
 * @property {() => void} release
 */

/** @typedef {SourceStore & WritableStoreMethods} WritableStore */

/**
 * Where a read's bytes go, part by part: a view of where they lie and where
 * in the range it goes, valid only inside the call and never written to.
 *
 * @typedef {(bytes: Uint8Array, at: number) => void} Put
 */

/** Zeroes a part of a file never written is handed as; made at the first such part. @type {Uint8Array | null} */
let zeroPiece = null;

/**
 * `length` zero bytes to hand to a `Put`, from one buffer of a piece's size.
 * Consumers copy them; none writes them.
 *
 * @param {number} length
 */
export const zeroes = length=>(zeroPiece ??= new Uint8Array(PIECE_SIZE)).subarray(0, length);

/**
 * A source's read handed to `put`: its own `readInto` where it has one, its
 * answer whole where it has not.
 *
 * @param {SourceStore} store @param {string} path @param {number} offset @param {number} length
 * @param {Put} put
 * @returns {number}
 */
export function readFromInto(store, path, offset, length, put){
    if (store.readInto)
    {
        return store.readInto(path, offset, length, put);
    }
    const bytes = store.read(path, offset, length);
    put(bytes, 0);
    return bytes.length;
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
    if (contents.paged)
    {
        return contents.paged.read(0, contents.size);
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
 * The bytes of contents a store handed out, in its own pieces and in order,
 * none copied: what a writer that takes them a part at a time - a session
 * saved to the origin's files - is given instead of one whole array. Pieces
 * kept on a disk (`paged`) are read one at a time as the writer reaches
 * them, so a file of a gigabyte saved holds a piece of it, not all of it.
 *
 * @param {FileContents} contents
 * @returns {Iterable<Uint8Array>}
 */
export function piecesOf(contents){
    if (contents.flat)
    {
        return [contents.flat];
    }
    const paged = contents.paged;
    if (paged)
    {
        return (function* (){
            for (let at = 0, index = 0; at < contents.size; at += PIECE_SIZE, index++)
            {
                const length = Math.min(PIECE_SIZE, contents.size - at);
                yield paged.piece(index) ?? new Uint8Array(length);
            }
        })();
    }
    /** @type {Uint8Array[]} */
    const out = [];
    for (let at = 0, index = 0; at < contents.size; at += PIECE_SIZE, index++)
    {
        const length = Math.min(PIECE_SIZE, contents.size - at);
        const piece = contents.pieces[index];
        // A piece never written is zeros, as a read of it answers.
        out.push(piece ? (piece.length >= length ? piece.subarray(0, length)
            : Uint8Array.from({ length }, (_, i)=>piece[i] ?? 0)) : new Uint8Array(length));
    }
    return out;
}
