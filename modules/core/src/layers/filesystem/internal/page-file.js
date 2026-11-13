/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The writable layer on a disk, as a system keeps its file cache: what a
 * program writes goes into pieces held in memory, the least recently used of
 * them written out to one file and let go of once the pieces held pass a
 * bound, and read back when the program reaches them again.
 *
 * An installer writes gigabytes -- its own setup files unpacked, then what it
 * installs -- and a writable layer in memory held every byte of it on the
 * engine's thread until the tab was ended. The disk is the origin's private
 * file system through one synchronous access handle (a worker has one, and
 * the engine runs in one), because a guest's ReadFile and WriteFile answer
 * synchronously and so must the store under them.
 *
 * Two parts: the page file (`createPageFile`), which knows pieces and the
 * extents of its file and nothing of paths, shared by every drive of a run;
 * and a store over it (`createPageFileStore`), which keeps the same contract,
 * answer for answer, as the store in memory (`memory-store.js`) -- the
 * differential gate holds the two to that.
 */

import { ErrorCode, fsError } from './errors.js';
import { PIECE_SIZE } from './memory-store.js';

/** The first piece of a small file; it doubles as the file grows, up to PIECE_SIZE. */
const SMALLEST_PIECE = 4096;

/**
 * The synchronous access handle's surface this uses
 * (FileSystemSyncAccessHandle).
 *
 * @typedef {Object} SyncAccess
 * @property {(into: Uint8Array, where: { at: number }) => number} read
 * @property {(from: Uint8Array, where: { at: number }) => number} write
 * @property {() => number} getSize
 * @property {() => void} [flush]
 * @property {() => void} close
 */

/**
 * A piece of a file: its bytes while it is held, and where they are on the
 * disk once written out. Shared by reference between a file and what a
 * `contents` handed out (`refs`), and copied before it is changed while more
 * than one holds it.
 *
 * @typedef {{ length: number, bytes: Uint8Array | null, at: number, room: number,
 *     dirty: boolean, refs: number }} Piece
 */

/**
 * @typedef {ReturnType<typeof createPageFile>} PageFile
 */

/**
 * A page file over `access`, holding at most `residentBytes` of pieces in
 * memory; with no `access`, a pool that never writes out, which a test of the
 * store can stand on.
 *
 * A write out that fails -- the origin's quota reached, the disk full -- is
 * said once through `onFailure`, and from then on nothing more is written
 * out: the pieces stay in memory, as they would in a store with no disk, and
 * nothing the program wrote is lost.
 *
 * @param {SyncAccess | null} access
 * @param {{ residentBytes?: number, onFailure?: (error: Error) => void,
 *     onClosed?: () => void }} [options]
 *     `onClosed`: the file is let go of, after `close` and the last
 *     contents handed out were released
 */
export function createPageFile(access, { residentBytes = 64 * 1024 * 1024, onFailure,
    onClosed } = {})
{
    /** The pieces held in memory, least recently used first. @type {Set<Piece>} */
    const resident = new Set();
    let residentTotal = 0;
    /** Extents given back, by length, for the next piece of that length. @type {Map<number, number[]>} */
    const free = new Map();
    /** Where the file ends: a new extent is taken here when none of its length is free. */
    let end = 0;
    /** The bytes of extents pieces hold on the disk. */
    let onDisk = 0;
    /** @type {Error | null} */
    let failed = null;
    let closing = false;
    let closed = false;
    /** Contents handed out and not yet released, which keep the file open past `close`. */
    let outstanding = 0;
    const counts = { written: 0, writtenBytes: 0, readBytes: 0, evicted: 0, copied: 0 };

    /** @param {Piece} piece */
    const touch = piece=>{
        resident.delete(piece);
        resident.add(piece);
    };

    /** @param {number} length @returns {number} */
    const extent = length=>{
        const reused = free.get(length)?.pop();
        if (reused !== undefined)
        {
            return reused;
        }
        const at = end;
        end += length;
        return at;
    };

    /** @param {Piece} piece */
    const giveBack = piece=>{
        if (piece.at < 0)
        {
            return;
        }
        let list = free.get(piece.room);
        if (!list)
        {
            list = [];
            free.set(piece.room, list);
        }
        list.push(piece.at);
        onDisk -= piece.room;
        piece.at = -1;
        piece.room = 0;
    };

    /**
     * Writes a piece's bytes to its extent, a larger one taken first when it
     * grew past the one it had. False when the write failed: the piece stays.
     *
     * @param {Piece} piece @returns {boolean}
     */
    const writeOut = piece=>{
        if (!access || failed || !piece.bytes)
        {
            return false;
        }
        if (piece.room < piece.length)
        {
            giveBack(piece);
            piece.at = extent(piece.length);
            piece.room = piece.length;
            onDisk += piece.room;
        }
        try
        {
            const wrote = access.write(piece.bytes, { at: piece.at });
            if (wrote !== piece.length)
            {
                throw new Error(`page file: ${wrote} of ${piece.length} bytes written`);
            }
        }
        catch (e){
            failed = /** @type {Error} */ (e);
            onFailure?.(failed);
            return false;
        }
        piece.dirty = false;
        counts.written++;
        counts.writtenBytes += piece.length;
        return true;
    };

    /** Lets go of the least recently used pieces until those held fit. */
    const trim = ()=>{
        if (!access || failed)
        {
            return;
        }
        for (const piece of resident)
        {
            if (residentTotal <= residentBytes)
            {
                return;
            }
            if (piece.dirty && !writeOut(piece))
            {
                return;
            }
            resident.delete(piece);
            residentTotal -= piece.length;
            piece.bytes = null;
            counts.evicted++;
        }
    };

    const finishClose = ()=>{
        if (closed)
        {
            return;
        }
        closed = true;
        try
        {
            access?.close();
        }
        finally
        {
            onClosed?.();
        }
    };

    const pageFile = {
        /** @param {number} length @returns {Piece} */
        make(length){
            /** @type {Piece} */
            const piece = { length, bytes: new Uint8Array(length), at: -1, room: 0,
                dirty: true, refs: 1 };
            resident.add(piece);
            residentTotal += length;
            return piece;
        },

        /**
         * A piece's bytes, read back from the disk if it was let go of. Used
         * at once: the next `trim` may let go of them again.
         *
         * @param {Piece} piece @returns {Uint8Array}
         */
        bytesOf(piece){
            if (piece.bytes)
            {
                touch(piece);
                return piece.bytes;
            }
            if (!access || closed)
            {
                throw new Error('page file: a piece was let go of and the file is closed');
            }
            const bytes = new Uint8Array(piece.length);
            const got = access.read(bytes, { at: piece.at });
            if (got !== piece.length)
            {
                throw new Error(`page file: ${got} of ${piece.length} bytes read back`);
            }
            counts.readBytes += got;
            piece.bytes = bytes;
            resident.add(piece);
            residentTotal += piece.length;
            return bytes;
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
            /** @type {Uint8Array} */ (copy.bytes).set(pageFile.bytesOf(piece));
            pageFile.release(piece);
            counts.copied++;
            return copy;
        },

        /**
         * Makes a piece of one holder longer, its bytes kept and the rest zeroes.
         *
         * @param {Piece} piece @param {number} length
         */
        grow(piece, length){
            const bytes = new Uint8Array(length);
            bytes.set(pageFile.bytesOf(piece));
            residentTotal += length - piece.length;
            piece.bytes = bytes;
            piece.length = length;
            piece.dirty = true;
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
            if (resident.delete(piece))
            {
                residentTotal -= piece.length;
            }
            piece.bytes = null;
            giveBack(piece);
        },

        trim,

        /** Counts contents handed out, which keep the file open until released. */
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
         * Closes the file once nothing handed out still reads from it: a save
         * under way when the run ends reads its files to the end.
         */
        close(){
            closing = true;
            if (outstanding === 0)
            {
                finishClose();
            }
        },

        /** Bytes of pieces held in memory. */
        residentBytes: ()=>residentTotal,

        diagnostics(){
            return {
                disk: access !== null,
                ...failed ? { failed: failed.message } : {},
                residentBytes: residentTotal,
                residentPieces: resident.size,
                residentLimit: residentBytes,
                onDisk,
                fileBytes: end,
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
     * Copies `length` bytes of `pieces` from `offset` into `out` at `into`;
     * past a piece, and in one never written, they are zeroes, which `out`
     * already holds.
     *
     * @param {(Piece | undefined)[]} pieces @param {number} offset @param {number} length
     * @param {Uint8Array} out @param {number} into
     */
    const copyOut = (pieces, offset, length, out, into)=>{
        for (let done = 0; done < length;)
        {
            const at = offset + done;
            const piece = pieces[Math.floor(at / PIECE_SIZE)];
            const within = at % PIECE_SIZE;
            const span = Math.min(length - done, PIECE_SIZE - within);
            if (piece && within < piece.length)
            {
                out.set(pageFile.bytesOf(piece).subarray(within, within + span), into + done);
                pageFile.trim();
            }
            done += span;
        }
    };

    /**
     * The bytes of the piece at `index`, this file's own and able to hold
     * `needed`, marked changed: the store in memory's rule for its length
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
        piece.dirty = true;
        return pageFile.bytesOf(piece);
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
        heldBytes: ()=>pageFile.residentBytes(),
    };
}

/** The folder of the origin's file system the page files are kept in. */
const FOLDER = 'bottlify-pages';

/**
 * Opens a page file of its own for a run in the origin's private file system,
 * or answers null where there is none to be had synchronously: no origin file
 * system, a thread with no synchronous access handles (a page's own thread),
 * or a browser whose handles answer with promises (WebKit before 16.4).
 *
 * The file is the run's alone and holds nothing a later run reads: what is
 * kept across runs is the session. Page files left behind by a run that
 * ended without closing -- a tab that was killed -- are taken away here,
 * except those a running run holds (its lock, where the browser has locks;
 * otherwise the open handle refuses the removal).
 *
 * @param {{ root?: any, residentBytes?: number, onFailure?: (error: Error) => void }} [options]
 *     `root`: the origin's file system by default; a test hands in its own
 * @returns {Promise<PageFile | null>}
 */
export async function openPageFile({ root, residentBytes, onFailure } = {}){
    const nav = /** @type {any} */ (globalThis).navigator;
    let base = root;
    if (!base)
    {
        // A page's own thread has the folders and no synchronous handles; the
        // check costs a folder opened for nothing, so it is made first.
        const Handle = /** @type {any} */ (globalThis).FileSystemFileHandle;
        if (typeof nav?.storage?.getDirectory !== 'function'
            || typeof Handle?.prototype?.createSyncAccessHandle !== 'function')
        {
            return null;
        }
        base = await nav.storage.getDirectory();
    }
    const locks = nav?.locks;
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.pages`;
    /** @type {() => void} */
    let unlock = ()=>{};
    try
    {
        const folder = await base.getDirectoryHandle(FOLDER, { create: true });
        if (typeof locks?.request === 'function')
        {
            await new Promise(held=>{
                locks.request(`bottlify-pages:${name}`, ()=>new Promise(done=>{
                    unlock = ()=>done(undefined);
                    held(undefined);
                })).catch(()=>held(undefined));
            });
        }
        await sweep(folder, locks);
        const handle = await folder.getFileHandle(name, { create: true });
        if (typeof handle.createSyncAccessHandle !== 'function')
        {
            unlock();
            await folder.removeEntry(name).catch(()=>{});
            return null;
        }
        const access = await handle.createSyncAccessHandle();
        if (typeof access?.getSize?.()?.then === 'function')
        {
            // An early handle whose calls are promises cannot answer a guest's
            // read synchronously.
            await access.close();
            unlock();
            await folder.removeEntry(name).catch(()=>{});
            return null;
        }
        return createPageFile(access, {
            residentBytes,
            onFailure,
            onClosed: ()=>{
                folder.removeEntry(name).catch(()=>{}).finally(unlock);
            },
        });
    }
    catch {
        unlock();
        return null;
    }
}

/**
 * Takes away the page files of runs that are gone.
 *
 * @param {any} folder @param {any} locks
 */
async function sweep(folder, locks){
    /** @type {Set<string> | null} */
    let held = null;
    if (typeof locks?.query === 'function')
    {
        const state = await locks.query().catch(()=>null);
        held = state ? new Set([...state.held ?? [], ...state.pending ?? []]
            .map((/** @type {any} */ lock)=>lock.name)) : null;
    }
    /** @type {string[]} */
    const names = [];
    for await (const [entryName] of folder.entries())
    {
        names.push(entryName);
    }
    for (const entryName of names)
    {
        if (held && held.has(`bottlify-pages:${entryName}`))
        {
            continue;
        }
        if (!held && locks)
        {
            continue;
        }
        await folder.removeEntry(entryName).catch(()=>{});
    }
}
