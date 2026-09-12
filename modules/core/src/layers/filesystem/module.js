/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 * A store path back into the components the rest of this layer works in.
 *
 * @param {string} path
 * @returns {string[]}
 */
const splitComponents = path=>path.split(/[\\/]/).filter(Boolean);

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

        // What has changed since anyone last asked. Kept as a set of paths
        // rather than a log: a program writes one save in hundreds of writes,
        // and the useful answer is "this file is different now", once.
        /** @type {Map<string, { path: string, kind: string }>} */
        const changes = new Map();
        /** @type {((changes: any[]) => void) | null} */
        let listener = config?.onChanged ?? null;
        let notifying = false;

        // Announced on a microtask so a burst of writes to one file becomes one
        // notification, and so nothing is announced from inside a guest call
        // that has not finished making the change it is announcing.
        const notify = ()=>{
            if (notifying || !listener)
            {
                return;
            }
            notifying = true;
            queueMicrotask(()=>{
                notifying = false;
                const batch = [...changes.values()];
                changes.clear();
                if (batch.length > 0)
                {
                    listener?.(batch);
                }
            });
        };

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
                now: config?.now,
                onChanged: (/** @type {any} */ change)=>{
                    changes.set(`${key}:${change.path}`, {
                        path: formatPath(key, splitComponents(change.path)),
                        kind: change.kind,
                    });
                    notify();
                },
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

            /**
             * Says what has changed, once per file, after the writes settle.
             *
             * One way out, on purpose: nothing pulls files in behind a running
             * program's back. What arrives from outside arrives through
             * `apply`, and only when the caller asks for it.
             *
             * @param {(changes: { path: string, kind: string }[]) => void} handler
             */
            onChanged(handler){
                listener = handler;
            },

            /**
             * Puts files in from outside: a save restored from elsewhere, a
             * config, an add-on.
             *
             * Through the overlay rather than into the store beneath it,
             * because the overlay indexes the store once, at mount -- a write
             * that went behind its back would be invisible until the next one.
             *
             * Refuses the whole batch if any of it names a file the guest holds
             * open. Half an applied save is worse than none: the program reads
             * a header from the new one and a body from the old.
             *
             * @param {{ path: string, bytes?: Uint8Array, delete?: boolean }[]} batch
             * @returns {number} how many entries were applied
             */
            apply(batch){
                const open = new Set(files.list().map((/** @type {any} */ file)=>
                    foldName(file.path)));
                for (const entry of batch)
                {
                    const { components, drive } = locate(entry.path);
                    if (open.has(foldName(formatPath(drive, components))))
                    {
                        throw fsError(ErrorCode.SHARING_VIOLATION,
                            `"${entry.path}" is open; the batch was not applied`);
                    }
                }

                for (const entry of batch)
                {
                    const { tree, components } = locate(entry.path);
                    if (entry.delete)
                    {
                        if (tree.stat(components))
                        {
                            tree.removeFile(components);
                        }
                        continue;
                    }

                    // The parent may not exist yet: what arrives from outside
                    // carries its own shape, and a save lives in a directory
                    // the program has not created yet on a fresh install.
                    for (let depth = 1; depth < components.length; depth++)
                    {
                        const parent = components.slice(0, depth);
                        if (!tree.stat(parent))
                        {
                            tree.createDirectory(parent);
                        }
                    }
                    if (tree.stat(components))
                    {
                        tree.truncate(components, 0);
                    }
                    else
                    {
                        tree.createFile(components);
                    }
                    tree.write(components, 0, entry.bytes ?? new Uint8Array(0));
                }
                return batch.length;
            },

            /**
             * Everything the writable layer holds: what a session is made of.
             *
             * The source is not in it. A bundle is named by its own digest and
             * fetched, never uploaded, so what travels is only what the program
             * itself produced.
             *
             * @param {string} [letter]
             * @returns {{ path: string, bytes: Uint8Array }[]}
             */
            export(letter){
                /** @type {{ path: string, bytes: Uint8Array }[]} */
                const out = [];
                for (const [key, tree] of drives)
                {
                    if (letter && key !== String(letter).toUpperCase())
                    {
                        continue;
                    }
                    for (const entry of tree.writableFiles())
                    {
                        const components = splitComponents(entry.path);
                        out.push({
                            path: formatPath(key, components),
                            bytes: tree.read(components, 0, entry.size),
                        });
                    }
                }
                return out;
            },

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
             * Stamps a file with a modification time of the caller's choosing.
             *
             * @param {string} path @param {number} modified  Milliseconds since the epoch.
             */
            setModified(path, modified){
                const { tree, components } = locate(path);
                tree.setModified(components, modified);
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
