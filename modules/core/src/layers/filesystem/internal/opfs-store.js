/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The writable store, backed by the Origin Private File System.
 *
 * The same contract as the in-memory store, over bytes that survive the tab
 * being closed. Three properties of OPFS shape everything below.
 *
 * A guest calling ReadFile is mid-instruction and cannot be handed a promise,
 * so every byte operation goes through `FileSystemSyncAccessHandle`, whose
 * read/write/truncate are synchronous. That interface exists **only inside a
 * worker**: a build that runs the engine on the main thread cannot use this
 * store at all, and `open` says so with ACCESS_DENIED rather than hanging.
 *
 * Acquiring such a handle is not synchronous, and neither is creating a file
 * or a directory. So the store splits in two: `open(path)` is asynchronous and
 * is what makes a file answerable, and everything the overlay calls from guest
 * code is synchronous and works on what is already open. A byte operation on a
 * path nobody opened is INVALID_HANDLE -- a caller's bug, not a wait.
 *
 * A sync access handle is an exclusive lock on its file, for the whole origin
 * rather than the tab, so leaving one open blocks every other reader including
 * another window on the same game. Handles are therefore pooled and bounded:
 * the least recently used one is closed when the pool overflows, and `close`
 * empties it.
 */

import { ErrorCode, fsError } from './errors.js';

/** @typedef {{ create?: boolean }} OpfsGetOptions */
/** @typedef {{ at?: number }} OpfsAtOptions */

/**
 * The subset of `FileSystemSyncAccessHandle` this store uses. `read` and
 * `write` answer with the number of bytes transferred; `write` past the end of
 * the file extends it with zeroes, which is what the guest expects after
 * seeking past EOF and is why the store does not zero-fill for itself.
 *
 * @typedef {Object} OpfsAccess
 * @property {(buffer: Uint8Array, options?: OpfsAtOptions) => number} read
 * @property {(buffer: Uint8Array, options?: OpfsAtOptions) => number} write
 * @property {(size: number) => void} truncate
 * @property {() => number} getSize
 * @property {() => void} flush
 * @property {() => void} close
 */

/**
 * @typedef {Object} OpfsFile
 * @property {'file'} kind
 * @property {() => Promise<OpfsAccess>} [createSyncAccessHandle]
 * @property {() => Promise<{ size: number }>} getFile
 */

/**
 * @typedef {Object} OpfsDirectory
 * @property {'directory'} kind
 * @property {(name: string, options?: OpfsGetOptions) => Promise<OpfsDirectory>} getDirectoryHandle
 * @property {(name: string, options?: OpfsGetOptions) => Promise<OpfsFile>} getFileHandle
 * @property {(name: string, options?: { recursive?: boolean }) => Promise<void>} removeEntry
 * @property {() => AsyncIterableIterator<[string, OpfsFile | OpfsDirectory]>} entries
 */

/**
 * @typedef {Object} OpfsStoreExtras
 * @property {(path: string) => Promise<void>} open
 * @property {() => Promise<void>} flush
 * @property {() => Promise<void>} close
 * @property {() => { entries: number, open: number, limit: number }} diagnostics
 */

/** @typedef {import('./memory-store.js').WritableStore & OpfsStoreExtras} OpfsStore */

/** @param {string} path */
function parentOf(path){
    const cut = path.lastIndexOf('\\');
    return cut < 0 ? '' : path.slice(0, cut);
}

/** @param {string} path */
function nameOf(path){
    return path.slice(path.lastIndexOf('\\') + 1);
}

/**
 * Mounts a directory as a store. The whole tree is walked once, here, so that
 * `list` and `stat` can answer without a promise afterwards.
 *
 * @param {Object} options
 * @param {OpfsDirectory} options.root
 * @param {number} [options.maxOpenHandles]
 * @returns {Promise<OpfsStore>}
 */
export async function createOpfsStore({ root, maxOpenHandles = 16 }){
    if (!Number.isInteger(maxOpenHandles) || maxOpenHandles < 1)
    {
        throw fsError(ErrorCode.INVALID_PARAMETER, 'At least one handle has to fit in the pool');
    }

    /** @type {Map<string, { directory: boolean, size: number }>} */
    const index = new Map();
    /** @type {Map<string, OpfsDirectory>} */
    const directories = new Map([['', root]]);
    /** @type {Map<string, OpfsFile>} */
    const files = new Map();
    /** Insertion order is the least-recently-used order. @type {Map<string, OpfsAccess>} */
    const handles = new Map();

    let pending = Promise.resolve();
    /** @type {Error | null} */
    let failure = null;

    /**
     * Creating and deleting entries is asynchronous in OPFS and synchronous in
     * this contract, so those two are applied to the index at once and to the
     * directory tree in order, behind this queue. Serialising it is what keeps
     * a file's creation from overtaking its directory's.
     *
     * @param {() => Promise<void>} task
     */
    const enqueue = task=>{
        pending = pending.then(task).catch(e=>{
            failure ??= e;
        });
    };

    const settle = async()=>{
        await pending;
        if (failure)
        {
            const e = failure;
            failure = null;
            throw e;
        }
    };

    /**
     * @param {string} path
     * @param {boolean} create
     * @returns {Promise<OpfsDirectory>}
     */
    const directoryHandle = async(path, create)=>{
        const known = directories.get(path);
        if (known)
        {
            return known;
        }
        const parent = await directoryHandle(parentOf(path), create);
        const handle = await parent.getDirectoryHandle(nameOf(path), { create });
        directories.set(path, handle);
        return handle;
    };

    /**
     * @param {string} path
     * @param {boolean} create
     * @returns {Promise<OpfsFile>}
     */
    const fileHandle = async(path, create)=>{
        const known = files.get(path);
        if (known)
        {
            return known;
        }
        const parent = await directoryHandle(parentOf(path), false);
        const handle = await parent.getFileHandle(nameOf(path), { create });
        files.set(path, handle);
        return handle;
    };

    /** @param {string} path */
    const release = path=>{
        const access = handles.get(path);
        if (!access)
        {
            return;
        }
        access.flush();
        access.close();
        handles.delete(path);
    };

    const evict = ()=>{
        while (handles.size > maxOpenHandles)
        {
            const oldest = handles.keys().next().value;
            if (oldest === undefined)
            {
                return;
            }
            release(oldest);
        }
    };

    /** @param {string} path @returns {OpfsAccess} */
    const resident = path=>{
        const access = handles.get(path);
        if (!access)
        {
            throw fsError(ErrorCode.INVALID_HANDLE,
                `No open handle for "${path}"; it has to be opened before its bytes are touched`);
        }
        // Re-inserting moves it to the young end of the pool.
        handles.delete(path);
        handles.set(path, access);
        return access;
    };

    /** @param {string} path */
    const requireParent = path=>{
        const parent = parentOf(path);
        if (parent.length > 0 && !index.get(parent)?.directory)
        {
            throw fsError(ErrorCode.PATH_NOT_FOUND, `No directory "${parent}" to hold "${path}"`);
        }
    };

    /**
     * The entry a byte operation is about to work on, or the reason it cannot.
     * Unlike the in-memory store this one cannot conjure a missing file on the
     * spot -- creating it in OPFS is asynchronous, so `open` does it.
     *
     * @param {string} path
     */
    const writableEntry = path=>{
        const entry = index.get(path);
        if (entry?.directory)
        {
            throw fsError(ErrorCode.IS_A_DIRECTORY, `"${path}" is a directory`);
        }
        if (!entry)
        {
            requireParent(path);
            throw fsError(ErrorCode.INVALID_HANDLE, `"${path}" has to be opened before it exists`);
        }
        return entry;
    };

    /**
     * @param {OpfsFile} handle
     * @param {string} path
     * @returns {Promise<OpfsAccess>}
     */
    const acquireAccess = async(handle, path)=>{
        if (typeof handle.createSyncAccessHandle !== 'function')
        {
            throw fsError(ErrorCode.ACCESS_DENIED,
                `No synchronous access to "${path}": this store only works inside a worker`);
        }
        try
        {
            return await handle.createSyncAccessHandle();
        }
        catch (e){
            // The lock is per origin, so the holder may be another window
            // entirely -- indistinguishable from here, and the same answer.
            if (e instanceof Error && e.name === 'NoModificationAllowedError')
            {
                throw fsError(ErrorCode.SHARING_VIOLATION, `"${path}" is open somewhere else`);
            }
            throw e;
        }
    };

    /**
     * Makes a file answerable synchronously, creating it if it is not there.
     *
     * @param {string} path
     */
    const open = async path=>{
        await settle();
        if (handles.has(path))
        {
            resident(path);
            return;
        }
        const known = index.get(path);
        if (known?.directory)
        {
            throw fsError(ErrorCode.IS_A_DIRECTORY, `"${path}" is a directory`);
        }
        requireParent(path);
        const access = await acquireAccess(await fileHandle(path, true), path);
        handles.set(path, access);
        evict();
        if (!known)
        {
            index.set(path, { directory: false, size: access.getSize() });
        }
    };

    /**
     * @param {OpfsDirectory} directory
     * @param {string} prefix
     */
    const walk = async(directory, prefix)=>{
        for await (const [name, handle] of directory.entries())
        {
            const path = prefix.length > 0 ? `${prefix}\\${name}` : name;
            if (handle.kind === 'directory')
            {
                directories.set(path, handle);
                index.set(path, { directory: true, size: 0 });
                await walk(handle, path);
                continue;
            }
            files.set(path, handle);
            // `getFile` rather than an access handle: reading a size must not
            // take the exclusive lock, or mounting would fail over any file
            // something else already holds open.
            index.set(path, { directory: false, size: (await handle.getFile()).size });
        }
    };

    await walk(root, '');

    return {
        list(){
            return [...index.entries()].map(([path, entry])=>({
                path,
                directory: entry.directory,
                size: entry.size,
            }));
        },

        /** @param {string} path */
        stat(path){
            const entry = index.get(path);
            return entry ? { directory: entry.directory, size: entry.size } : null;
        },

        /**
         * A read that starts past the end returns nothing rather than failing:
         * end of file is a length, not an error.
         *
         * @param {string} path @param {number} offset @param {number} length
         */
        read(path, offset, length){
            const entry = index.get(path);
            if (!entry || entry.directory)
            {
                throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" to read`);
            }
            const start = Math.min(Math.max(offset, 0), entry.size);
            const end = Math.min(start + Math.max(length, 0), entry.size);
            const buffer = new Uint8Array(end - start);
            if (buffer.length === 0)
            {
                return buffer;
            }
            const read = resident(path).read(buffer, { at: start });
            return read === buffer.length ? buffer : buffer.subarray(0, read);
        },

        /** @param {string} path @param {number} offset @param {Uint8Array} bytes */
        write(path, offset, bytes){
            if (offset < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, `Negative offset writing "${path}"`);
            }
            const entry = writableEntry(path);
            resident(path).write(bytes, { at: offset });
            entry.size = Math.max(entry.size, offset + bytes.length);
        },

        /** @param {string} path @param {number} size */
        truncate(path, size){
            if (size < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, `Negative size for "${path}"`);
            }
            const entry = writableEntry(path);
            resident(path).truncate(size);
            entry.size = size;
        },

        /**
         * A populated directory is refused here rather than by the queue, so
         * that the index and the directory tree cannot disagree about what is
         * still there while the removal is in flight.
         *
         * @param {string} path
         */
        remove(path){
            const entry = index.get(path);
            if (!entry)
            {
                throw fsError(ErrorCode.NOT_FOUND, `Nothing at "${path}" to remove`);
            }
            const prefix = `${path}\\`;
            if (entry.directory && [...index.keys()].some(other=>other.startsWith(prefix)))
            {
                throw fsError(ErrorCode.DIRECTORY_NOT_EMPTY, `"${path}" still holds something`);
            }
            release(path);
            index.delete(path);
            files.delete(path);
            directories.delete(path);
            enqueue(async()=>{
                const parent = await directoryHandle(parentOf(path), false);
                await parent.removeEntry(nameOf(path));
            });
        },

        /** @param {string} path */
        mkdir(path){
            if (index.has(path))
            {
                throw fsError(ErrorCode.ALREADY_EXISTS, `"${path}" already exists`);
            }
            requireParent(path);
            index.set(path, { directory: true, size: 0 });
            enqueue(async()=>{
                await directoryHandle(path, true);
            });
        },

        open,

        /** Every pending change on its way to the disk, and nothing released. */
        async flush(){
            await settle();
            for (const access of handles.values())
            {
                access.flush();
            }
        },

        /** The pool emptied, so another mount of the same tree can take over. */
        async close(){
            await settle();
            for (const path of [...handles.keys()])
            {
                release(path);
            }
        },

        diagnostics(){
            return { entries: index.size, open: handles.size, limit: maxOpenHandles };
        },
    };
}
