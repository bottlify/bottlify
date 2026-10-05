/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Open files: what a handle remembers, and what two handles on one file are
 * allowed to do to each other.
 *
 * A handle is not the file. It carries an intent and a position and nothing
 * else -- the bytes live in the overlay, which is why two handles on the same
 * file see each other's writes immediately, and why a handle closed and
 * reopened finds what was written through the other one.
 *
 * The table is deliberately not the guest's handle table: it hands back an
 * object, and whoever implements CreateFile gives that object a number. Keeping
 * the numbering out of here means this file has no opinion about what a HANDLE
 * is worth.
 */

import { ErrorCode, fsError } from './errors.js';

/** What an open does to a file that is, or is not, already there. */
export const Disposition = {
    /** Fails if the file exists. */
    CREATE_NEW: 'create-new',
    /** Creates it, or empties the one that is there. */
    CREATE_ALWAYS: 'create-always',
    /** Fails if the file is missing. */
    OPEN_EXISTING: 'open-existing',
    /** Opens it, creating it only if it is missing. */
    OPEN_ALWAYS: 'open-always',
    /** Fails if the file is missing, empties it otherwise. */
    TRUNCATE_EXISTING: 'truncate-existing',
};

/** Where a seek counts from. */
export const SeekFrom = {
    BEGIN: 'begin',
    CURRENT: 'current',
    END: 'end',
};

/**
 * @typedef {Object} AccessFlags
 * @property {boolean} read
 * @property {boolean} write
 */

/**
 * @typedef {Object} FileHandle
 * @property {number} id
 * @property {string} key         Identity for the sharing check: drive plus folded path.
 * @property {string} path        As the file is spelled, for diagnostics.
 * @property {string[]} components
 * @property {any} tree           The overlay the file lives in.
 * @property {AccessFlags} access
 * @property {AccessFlags} share
 * @property {number} position
 * @property {boolean} closed
 * @property {number} token       Its open as the volume's sharing records it.
 */

/**
 * What one open agreed to, as the volume's sharing keeps it: values, so the
 * volume's half of the system can keep them for a process in another thread.
 *
 * @typedef {Object} OpenTerms
 * @property {string} key       Drive plus folded path.
 * @property {string} path      As the file is spelled, for the refusal's text.
 * @property {AccessFlags} access
 * @property {AccessFlags} share
 * @property {boolean} [inherited]  The same open file another process holds,
 *     handed on: no new terms, so none are checked.
 */

/**
 * Every file open on a volume, by every process that stands on it, and the
 * terms each open agreed to: what a new open is settled against, since
 * CreateFile's sharing is the system's and not a process's.
 *
 * @typedef {Object} Sharing
 * @property {(terms: OpenTerms) => number} admit
 *     Settles an open against every other, and records it: its number, or a
 *     SHARING_VIOLATION thrown. Settled and recorded in one step, so two
 *     processes opening at once cannot both get in.
 * @property {(token: number) => void} release
 * @property {(key: string) => boolean} isOpen
 */

/**
 * The sharing of a volume kept here, for the processes on this thread.
 *
 * @returns {Sharing}
 */
export function createSharing(){
    /** @type {Map<number, OpenTerms>} */
    const opens = new Map();
    let next = 1;
    return {
        admit(terms){
            if (!terms.inherited)
            {
                for (const other of opens.values())
                {
                    if (other.key !== terms.key)
                    {
                        continue;
                    }
                    const denied = (terms.access.read && !other.share.read)
                        || (terms.access.write && !other.share.write)
                        || (other.access.read && !terms.share.read)
                        || (other.access.write && !terms.share.write);
                    if (denied)
                    {
                        throw fsError(ErrorCode.SHARING_VIOLATION,
                            `"${other.path}" is already open on incompatible terms`);
                    }
                }
            }
            const token = next++;
            opens.set(token, { key: terms.key, path: terms.path,
                access: { ...terms.access }, share: { ...terms.share } });
            return token;
        },
        release(token){
            opens.delete(token);
        },
        isOpen: key=>[...opens.values()].some(terms=>terms.key === key),
    };
}

/**
 * Builds the table of open files.
 *
 * @param {Object} [options]
 * @param {number} [options.limit]  Most files open at once.
 * @param {Sharing} [options.sharing]
 *     The volume's: every process's opens, which a new one is settled
 *     against. A table with no one to share the volume with keeps its own.
 */
export function createFileTable({ limit = 4096, sharing = createSharing() } = {}){
    /** This process's own. @type {Set<FileHandle>} */
    const open = new Set();
    let nextId = 1;
    let opened = 0;
    let closed = 0;
    // What was opened and how much was read of it, by path. A bring-up
    // question that keeps coming back is whether a program ever went looking
    // for a piece of its own data -- a sound it should be playing, a map it
    // should be loading -- and the handle counts cannot answer it: they say
    // seventeen files were opened and nothing about which.
    /** @type {Map<string, { opens: number, read: number }>} */
    const paths = new Map();
    /** @param {string} path @returns {{ opens: number, read: number }} */
    const track = path=>{
        const known = paths.get(path);
        if (known)
        {
            return known;
        }
        // Bounded, because a program that walks a tree would otherwise grow
        // this without end. The cap is high enough that a normal run is whole.
        const fresh = { opens: 0, read: 0 };
        if (paths.size < 4096)
        {
            paths.set(path, fresh);
        }
        return fresh;
    };

    /** @param {FileHandle} handle */
    const live = handle=>{
        if (!handle || handle.closed || !open.has(handle))
        {
            throw fsError(ErrorCode.INVALID_HANDLE, 'That file handle is not open');
        }
        return handle;
    };

    return {
        /**
         * Opens a file, creating or emptying it as the disposition asks.
         *
         * Sharing is settled before anything is created, so a refused open
         * leaves the volume exactly as it found it.
         *
         * @param {Object} request
         * @param {any} request.tree
         * @param {string} request.key
         * @param {string[]} request.components
         * @param {AccessFlags} request.access
         * @param {AccessFlags} [request.share]
         * @param {string} [request.disposition]
         * @param {boolean} [request.inherited]  The open is one a process was
         *     handed by another, the same file it already holds: no new terms
         *     are agreed, so none are checked.
         * @returns {FileHandle}
         */
        open(request){
            const { tree, key, components, access } = request;
            const share = request.share ?? { read: true, write: false };
            const disposition = request.disposition ?? Disposition.OPEN_EXISTING;
            if (open.size >= limit)
            {
                throw fsError(ErrorCode.ACCESS_DENIED, 'Too many files open');
            }
            // Read-only media refuses the access itself, whether or not the
            // file is there; creating or emptying one is refused by the tree.
            if (access.write && tree.readOnly)
            {
                throw fsError(ErrorCode.WRITE_PROTECTED,
                    `"${components.join('\\')}" is on read-only media`);
            }
            const existing = tree.stat(components);
            if (existing?.directory)
            {
                // CreateFile without FILE_FLAG_BACKUP_SEMANTICS cannot open a
                // directory; the caller decides which Win32 error says so.
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${existing.path}" is a directory`);
            }
            // Win32 refuses a second open whose access is not permitted by
            // what the first agreed to share, and equally one whose sharing
            // does not cover what the first already took: a program that
            // opens a save file for writing and then again for reading relies
            // on the second.
            const token = sharing.admit({ key, path: existing?.path ?? components.join('\\'),
                access: { read: !!access.read, write: !!access.write },
                share: { read: !!share.read, write: !!share.write },
                inherited: request.inherited === true });
            /** @type {any} */
            let entry;
            try
            {
                if (existing && disposition === Disposition.CREATE_NEW)
                {
                    throw fsError(ErrorCode.ALREADY_EXISTS, `"${existing.path}" already exists`);
                }
                if (!existing && (disposition === Disposition.OPEN_EXISTING
                    || disposition === Disposition.TRUNCATE_EXISTING))
                {
                    throw fsError(ErrorCode.NOT_FOUND, `No file at "${components.join('\\')}"`);
                }
                entry = existing ?? tree.createFile(components);
                if (existing && (disposition === Disposition.CREATE_ALWAYS
                    || disposition === Disposition.TRUNCATE_EXISTING))
                {
                    tree.truncate(components, 0);
                }
            }
            catch (e){
                sharing.release(token);
                throw e;
            }

            const handle = {
                id: nextId++,
                key,
                path: entry.path,
                components,
                tree,
                access: { read: !!access.read, write: !!access.write },
                share: { read: !!share.read, write: !!share.write },
                position: 0,
                closed: false,
                token,
            };
            open.add(handle);
            opened++;
            track(entry.path).opens++;
            return handle;
        },

        /**
         * Reads up to `length` bytes from the handle's position.
         *
         * A read that runs past the end returns what was there and no more --
         * end of file is a short read, never a failure.
         *
         * @param {FileHandle} handle @param {number} length
         * @returns {Uint8Array}
         */
        read(handle, length){
            live(handle);
            if (!handle.access.read)
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${handle.path}" was not opened for reading`);
            }
            if (length < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, 'A read cannot be of negative length');
            }
            const size = handle.tree.size(handle.components);
            const available = Math.max(0, Math.min(length, size - handle.position));
            const data = available > 0
                ? handle.tree.read(handle.components, handle.position, available)
                : new Uint8Array(0);
            handle.position += data.length;
            track(handle.path).read += data.length;
            return data;
        },

        /**
         * @param {FileHandle} handle @param {Uint8Array} bytes
         * @returns {number} bytes written
         */
        write(handle, bytes){
            live(handle);
            if (!handle.access.write)
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${handle.path}" was not opened for writing`);
            }
            handle.tree.write(handle.components, handle.position, bytes);
            handle.position += bytes.length;
            return bytes.length;
        },

        /**
         * Moves the position. Seeking past the end is legal and does not grow
         * the file -- the write that follows is what grows it.
         *
         * @param {FileHandle} handle @param {number} offset @param {string} [from]
         * @returns {number} the new position
         */
        seek(handle, offset, from = SeekFrom.BEGIN){
            live(handle);
            let base = 0;
            if (from === SeekFrom.CURRENT)
            {
                base = handle.position;
            }
            else if (from === SeekFrom.END)
            {
                base = handle.tree.size(handle.components);
            }
            const position = base + offset;
            if (position < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, 'A seek cannot land before the start');
            }
            handle.position = position;
            return position;
        },

        /** @param {FileHandle} handle @returns {number} */
        position(handle){
            return live(handle).position;
        },

        /** @param {FileHandle} handle @returns {number} */
        size(handle){
            live(handle);
            return handle.tree.size(handle.components);
        },

        /**
         * Makes the current position the end of the file, which is what
         * SetEndOfFile does -- it truncates and extends alike.
         *
         * @param {FileHandle} handle
         */
        setEnd(handle){
            live(handle);
            if (!handle.access.write)
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${handle.path}" was not opened for writing`);
            }
            handle.tree.truncate(handle.components, handle.position);
        },

        /** @param {FileHandle} handle */
        close(handle){
            live(handle);
            handle.closed = true;
            open.delete(handle);
            sharing.release(handle.token);
            closed++;
        },

        /** Closes everything this process holds: it has ended. */
        closeAll(){
            for (const handle of open)
            {
                handle.closed = true;
                sharing.release(handle.token);
                closed++;
            }
            open.clear();
        },

        /**
         * Whether any process sharing the volume holds the file open.
         *
         * @param {string} key
         */
        isOpen: key=>sharing.isOpen(key),

        /** @returns {FileHandle[]} */
        list(){
            return [...open];
        },

        diagnostics(){
            return {
                open: open.size,
                opened,
                closed,
                // Ordered by what was read rather than by name: the answer this
                // is here for is which files a run actually spent its reads on.
                byPath: Object.fromEntries([...paths]
                    .sort((left, right)=>right[1].read - left[1].read)
                    .slice(0, 40)
                    .map(([path, counts])=>[path, `${counts.opens} opens, ${counts.read} bytes`])),
            };
        },
    };
}
