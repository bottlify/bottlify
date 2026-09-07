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
 */

/**
 * Builds the table of open files.
 *
 * @param {Object} [options]
 * @param {number} [options.limit]  Most files open at once.
 */
export function createFileTable({ limit = 4096 } = {}){
    /** @type {Set<FileHandle>} */
    const open = new Set();
    let nextId = 1;
    let opened = 0;
    let closed = 0;

    /**
     * Win32 refuses a second open whose access is not permitted by what the
     * first open agreed to share, and equally refuses one whose sharing does
     * not cover what the first open already took. Both directions matter: a
     * program that opens a save file for writing and then opens it again for
     * reading is relying on the second check, not the first.
     *
     * @param {string} key
     * @param {AccessFlags} access
     * @param {AccessFlags} share
     */
    const checkSharing = (key, access, share)=>{
        for (const handle of open)
        {
            if (handle.key !== key)
            {
                continue;
            }
            const denied = (access.read && !handle.share.read)
                || (access.write && !handle.share.write)
                || (handle.access.read && !share.read)
                || (handle.access.write && !share.write);
            if (denied)
            {
                throw fsError(ErrorCode.SHARING_VIOLATION,
                    `"${handle.path}" is already open on incompatible terms`);
            }
        }
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
            const existing = tree.stat(components);
            if (existing?.directory)
            {
                // CreateFile without FILE_FLAG_BACKUP_SEMANTICS cannot open a
                // directory; the caller decides which Win32 error says so.
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${existing.path}" is a directory`);
            }
            checkSharing(key, access, share);

            if (existing && disposition === Disposition.CREATE_NEW)
            {
                throw fsError(ErrorCode.ALREADY_EXISTS, `"${existing.path}" already exists`);
            }
            if (!existing && (disposition === Disposition.OPEN_EXISTING
                || disposition === Disposition.TRUNCATE_EXISTING))
            {
                throw fsError(ErrorCode.NOT_FOUND, `No file at "${components.join('\\')}"`);
            }
            const entry = existing ?? tree.createFile(components);
            if (existing && (disposition === Disposition.CREATE_ALWAYS
                || disposition === Disposition.TRUNCATE_EXISTING))
            {
                tree.truncate(components, 0);
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
            };
            open.add(handle);
            opened++;
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
            closed++;
        },

        /** @returns {FileHandle[]} */
        list(){
            return [...open];
        },

        diagnostics(){
            return { open: open.size, opened, closed };
        },
    };
}
