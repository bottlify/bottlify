/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { ErrorCode, fsError } from './internal/errors.js';
import { Disposition, SeekFrom, createFileTable } from './internal/handles.js';
import { createMemoryStore } from './internal/memory-store.js';
import { createOverlay } from './internal/tree.js';
import {
    createDirectoryState,
    foldName,
    formatPath,
    splitPattern,
} from './internal/paths.js';

/** How much of a file to move at a time when renaming across the overlay. */
const MOVE_CHUNK = 1 << 20;

/**
 * filesystem -- the volume a Win32 program sees: drive letters, Windows path
 * rules, a read-only source under a writable layer, and open files.
 *
 * Nothing here knows what a HANDLE is or which error number an API returns.
 * That belongs to whoever implements CreateFile; this layer answers in named
 * failures and hands back handle objects, so the same volume can serve a
 * console program, a file dialog and a save routine without any of them
 * agreeing on numbering first.
 *
 * The backing stores are injected. A build with persistence supplies its own;
 * a build without one gets the in-memory store here, and behaves identically
 * until it is closed.
 */

/** @type {any} */
let drives = null;
/** @type {any} */
let directories = null;
/** @type {any} */
let files = null;

export const filesystemModule = {
    name: 'filesystem',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['log']),

    /**
     * @param {any} config
     * @returns {Promise<any>}
     */
    async create(config){
        drives = new Map();
        files = createFileTable({ limit: config?.openFileLimit });

        /**
         * @param {string} letter
         * @param {any} stores
         */
        const mount = (letter, stores)=>{
            const key = String(letter).toUpperCase();
            if (!/^[A-Z]$/.test(key))
            {
                throw fsError(ErrorCode.INVALID_PATH, `"${letter}" is not a drive letter`);
            }
            drives.set(key, createOverlay({
                source: stores?.source ?? null,
                writable: stores?.writable ?? createMemoryStore(),
            }));
        };

        for (const [letter, stores] of Object.entries(config?.drives ?? {}))
        {
            mount(letter, stores);
        }
        if (drives.size === 0)
        {
            mount('C', {});
        }

        // The process starts on the first drive it has, at its root, so that a
        // relative path resolves to something even before anyone sets it.
        directories = createDirectoryState({ drive: [...drives.keys()][0] });

        /**
         * @param {string} path
         * @param {boolean} [allowWildcard]
         */
        const locate = (path, allowWildcard = false)=>{
            const resolved = directories.resolve(path);
            if (resolved.device)
            {
                throw Object.assign(
                    fsError(ErrorCode.IS_DEVICE, `"${path}" names the ${resolved.device} device`),
                    { device: resolved.device });
            }
            if (resolved.wildcard && !allowWildcard)
            {
                // Only enumeration expands a wildcard; an open takes the name
                // literally, and a name cannot contain one.
                throw fsError(ErrorCode.INVALID_PATH, `"${path}" is a pattern, not a file name`);
            }
            const tree = drives.get(resolved.drive);
            if (!tree)
            {
                throw fsError(ErrorCode.NO_SUCH_DRIVE, `No drive ${resolved.drive}: is mounted`);
            }
            return {
                tree,
                drive: resolved.drive,
                components: resolved.components,
                key: `${foldName(resolved.drive)}:${foldName(resolved.components.join('\\'))}`,
            };
        };

        return {
            ErrorCode,
            Disposition,
            SeekFrom,

            /** @param {string} letter @param {any} stores */
            mount: (letter, stores)=>mount(letter, stores),

            /** @returns {string[]} */
            drives: ()=>[...drives.keys()],

            /**
             * Resolves a path without touching the volume. This is what a
             * caller uses to find out that a path names a device before it
             * tries to open a file by that name.
             *
             * @param {string} path
             */
            resolve(path){
                const resolved = directories.resolve(path);
                return { ...resolved, path: formatPath(resolved.drive, resolved.components) };
            },

            /** @returns {string} the current directory, as a full path. */
            currentDirectory(){
                const drive = directories.drive();
                return formatPath(drive, directories.directoryOf(drive));
            },

            /**
             * Moves the current directory, refusing a directory that is not
             * there -- the check is the point, since everything relative
             * afterwards is resolved against it.
             *
             * @param {string} path
             */
            setCurrentDirectory(path){
                const { tree, drive, components } = locate(path);
                const entry = tree.stat(components);
                if (!entry)
                {
                    throw fsError(ErrorCode.PATH_NOT_FOUND, `No directory at "${path}"`);
                }
                if (!entry.directory)
                {
                    throw fsError(ErrorCode.NOT_A_DIRECTORY, `"${path}" is not a directory`);
                }
                directories.setCurrent(drive, components);
            },

            /** @param {string} path @returns {any} */
            stat(path){
                const { tree, drive, components } = locate(path);
                const entry = tree.stat(components);
                return entry ? { ...entry, path: formatPath(drive, components) } : null;
            },

            /**
             * Lists a directory. A trailing wildcard component is taken as the
             * filter, so a search path can be passed whole.
             *
             * @param {string} path @param {string} [pattern]
             * @returns {any[]}
             */
            list(path, pattern){
                const split = pattern === undefined
                    ? splitPattern(path)
                    : { directory: path, pattern };
                const { tree, drive, components } = locate(split.directory);
                return tree.list(components, split.pattern ?? undefined).map(
                    (/** @type {any} */ entry)=>({
                        ...entry,
                        path: formatPath(drive, [...components, entry.name]),
                    }));
            },

            /** @param {string} path @returns {boolean} true when it was created. */
            createDirectory(path){
                const { tree, components } = locate(path);
                return tree.createDirectory(components);
            },

            /** @param {string} path */
            removeDirectory(path){
                const { tree, components } = locate(path);
                tree.removeDirectory(components);
            },

            /** @param {string} path */
            deleteFile(path){
                const { tree, components } = locate(path);
                tree.removeFile(components);
            },

            /**
             * Opens a file.
             *
             * @param {string} path
             * @param {Object} [options]
             * @param {boolean} [options.read]
             * @param {boolean} [options.write]
             * @param {boolean} [options.shareRead]
             * @param {boolean} [options.shareWrite]
             * @param {string} [options.disposition]  One of Disposition.
             */
            open(path, options = {}){
                const { tree, components, key } = locate(path);
                return files.open({
                    tree,
                    key,
                    components,
                    access: { read: options.read !== false, write: options.write === true },
                    share: {
                        read: options.shareRead !== false,
                        write: options.shareWrite === true,
                    },
                    disposition: options.disposition ?? Disposition.OPEN_EXISTING,
                });
            },

            /** @param {any} handle @param {number} length @returns {Uint8Array} */
            read: (handle, length)=>files.read(handle, length),
            /** @param {any} handle @param {Uint8Array} bytes @returns {number} */
            write: (handle, bytes)=>files.write(handle, bytes),
            /** @param {any} handle @param {number} offset @param {string} [from] */
            seek: (handle, offset, from)=>files.seek(handle, offset, from),
            /** @param {any} handle */
            position: handle=>files.position(handle),
            /** @param {any} handle */
            size: handle=>files.size(handle),
            /** @param {any} handle */
            setEndOfFile: handle=>files.setEnd(handle),
            /** @param {any} handle */
            close: handle=>files.close(handle),
            openFiles: ()=>files.list(),

            /**
             * Moves a name to another name.
             *
             * Not a rename in the writable layer: whatever is being moved may
             * live in the read-only source, where nothing can be renamed. So it
             * is a copy followed by a delete, which is what the overlay would
             * have to do anyway -- and the delete leaves the tombstone that
             * keeps the old name from coming back from the source.
             *
             * @param {string} from
             * @param {string} to
             */
            rename(from, to){
                const entry = this.stat(from);
                if (!entry)
                {
                    throw fsError(ErrorCode.NOT_FOUND, `${from} does not exist`);
                }
                if (this.stat(to))
                {
                    throw fsError(ErrorCode.ALREADY_EXISTS, `${to} already exists`);
                }

                if (entry.directory)
                {
                    this.createDirectory(to);
                    for (const child of this.list(from))
                    {
                        this.rename(`${from}\\${child.name}`, `${to}\\${child.name}`);
                    }
                    this.removeDirectory(from);
                    return;
                }

                const source = this.open(from, { read: true });
                const destination = this.open(to, {
                    write: true,
                    disposition: Disposition.CREATE_NEW,
                });
                try
                {
                    // A chunk at a time: what a program moves is as large as
                    // what it shipped, and holding one whole is a move that
                    // works in a test and fails on a real install.
                    for (;;)
                    {
                        const chunk = files.read(source, MOVE_CHUNK);
                        if (chunk.length === 0)
                        {
                            break;
                        }
                        files.write(destination, chunk);
                    }
                }
                finally
                {
                    files.close(source);
                    files.close(destination);
                }
                this.deleteFile(from);
            },
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        /** @type {Record<string, any>} */
        const volumes = {};
        for (const [letter, tree] of drives ?? [])
        {
            volumes[`${letter}:`] = tree.diagnostics();
        }
        return {
            name: 'filesystem',
            version: '0.1.0',
            status: drives ? 'ready' : 'created',
            metrics: drives
                ? {
                    volumes,
                    handles: files.diagnostics(),
                    // A relative path that resolves somewhere unexpected is one
                    // of the harder failures to see from the outside.
                    current: formatPath(
                        directories.drive(), directories.directoryOf(directories.drive())),
                }
                : {},
        };
    },

    async dispose(){
        drives = null;
        directories = null;
        files = null;
    },
};
