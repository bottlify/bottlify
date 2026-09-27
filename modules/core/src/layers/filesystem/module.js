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

/** The filesystem layer's module for one graph; see `defaultModules`. */
export function createFilesystemModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * The module contract puts both on the module rather than on the api, so
     * something outside a `create()` call has to be able to see in. That is
     * the only reason this exists, and it holds a reference rather than the
     * state itself -- the drives, the open files and the current directory
     * belong to the closure `create()` returns, so a second instance in one
     * realm cannot take the first one's volume. Disposing marks the instance
     * closed, so a call still in flight when the volume went away answers
     * "not found" instead of dereferencing what is gone.
     *
     * @type {any}
     */
    let current = null;

    return {
        name: 'filesystem',
        version: '0.1.0',
        requires: /** @type {readonly string[]} */ (['log']),

        /**
         * @param {any} config
         * @returns {Promise<any>}
         */
        async create(config){
            /**
             * Everything this instance owns, and whether it is still open.
             *
             * The calls an api hands out close over this object rather than over
             * module-level bindings, because `create()` may run more than once in
             * one realm -- a process replacement does, and the plan for more than
             * one machine in a worker needs two at once -- so each run keeps its
             * own drives and open files.
             *
             * @type {{ drives: Map<string, any>, writables: Map<string, any>,
             *     directories: any, files: any, disposed: boolean }}
             */
            const state = {
                drives: new Map(),
                // Each drive's writable layer, kept across a remount: mounting a
                // bundle on a drive puts its files under what is already written
                // there -- the machine's own directories, made before the game
                // was mounted -- rather than giving the drive a blank disk.
                writables: new Map(),
                directories: null,
                files: createFileTable({ limit: config?.openFileLimit }),
                disposed: false,
            };

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
                    if (batch.length > 0 && !state.disposed)
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
                const writable = stores?.writable ?? state.writables.get(key)
                    ?? createMemoryStore();
                state.writables.set(key, writable);
                state.drives.set(key, createOverlay({
                    source: stores?.source ?? null,
                    // The engine's own volume, beneath every bundle: what a host
                    // mounts in `system32` as the machine's own, which no title may
                    // write to. A per-mount store overrides the configured one,
                    // which is how a test drives it without a module around it.
                    system: stores?.system ?? config?.system ?? null,
                    writable,
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
            if (state.drives.size === 0)
            {
                mount('C', {});
            }

            // The process starts on the first drive it has, at its root, so that a
            // relative path resolves to something even before anyone sets it.
            state.directories = createDirectoryState({ drive: [...state.drives.keys()][0] });

            /**
             * @param {string} path
             * @param {boolean} [allowWildcard]
             */
            const locate = (path, allowWildcard = false)=>{
                const resolved = state.directories.resolve(path);
                if (resolved.device)
                {
                    throw Object.assign(
                        fsError(ErrorCode.IS_DEVICE,
                            `"${path}" names the ${resolved.device} device`),
                        { device: resolved.device });
                }
                if (resolved.wildcard && !allowWildcard)
                {
                    // Only enumeration expands a wildcard; an open takes the name
                    // literally, and a name cannot contain one.
                    throw fsError(ErrorCode.INVALID_PATH,
                        `"${path}" is a pattern, not a file name`);
                }
                const tree = state.drives.get(resolved.drive);
                if (!tree)
                {
                    throw fsError(ErrorCode.NO_SUCH_DRIVE,
                        `No drive ${resolved.drive}: is mounted`);
                }
                return {
                    tree,
                    drive: resolved.drive,
                    components: resolved.components,
                    key: `${foldName(resolved.drive)}:${foldName(resolved.components.join('\\'))}`,
                };
            };

            /**
             * Whether this instance is still open. A call that was in flight when
             * the machine was disposed must not find the volume gone: after
             * disposal every method answers the way it would for a file that is
             * not there, rather than dereferencing what disposal took away.
             */
            const live = ()=>!state.disposed;

            current = state;
            return {
                ErrorCode,
                Disposition,
                SeekFrom,

                /** @param {string} letter @param {any} stores */
                mount: (letter, stores)=>{
                    if (live())
                    {
                        mount(letter, stores);
                    }
                },

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
                    if (live())
                    {
                        listener = handler;
                    }
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
                    if (!live())
                    {
                        return 0;
                    }
                    const open = new Set(state.files.list().map((/** @type {any} */ file)=>
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
                    if (!live())
                    {
                        return [];
                    }
                    /** @type {{ path: string, bytes: Uint8Array }[]} */
                    const out = [];
                    for (const [key, tree] of state.drives)
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
                drives: ()=>live() ? [...state.drives.keys()] : [],

                /**
                 * Resolves a path without touching the volume. This is what a
                 * caller uses to find out that a path names a device before it
                 * tries to open a file by that name.
                 *
                 * @param {string} path
                 */
                resolve(path){
                    if (!live())
                    {
                        return { drive: '', components: [], device: null, wildcard: false,
                            path: '' };
                    }
                    const resolved = state.directories.resolve(path);
                    return { ...resolved, path: formatPath(resolved.drive, resolved.components) };
                },

                /** @returns {string} the current directory, as a full path. */
                currentDirectory(){
                    if (!live())
                    {
                        return '';
                    }
                    const drive = state.directories.drive();
                    return formatPath(drive, state.directories.directoryOf(drive));
                },

                /**
                 * Moves the current directory, refusing a directory that is not
                 * there -- the check is the point, since everything relative
                 * afterwards is resolved against it.
                 *
                 * @param {string} path
                 */
                setCurrentDirectory(path){
                    if (!live())
                    {
                        return;
                    }
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
                    state.directories.setCurrent(drive, components);
                },

                /** @param {string} path @returns {any} */
                stat(path){
                    if (!live())
                    {
                        return null;
                    }
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
                    if (!live())
                    {
                        return;
                    }
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
                    if (!live())
                    {
                        return [];
                    }
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
                    if (!live())
                    {
                        return false;
                    }
                    const { tree, components } = locate(path);
                    return tree.createDirectory(components);
                },

                /** @param {string} path */
                removeDirectory(path){
                    if (!live())
                    {
                        return;
                    }
                    const { tree, components } = locate(path);
                    tree.removeDirectory(components);
                },

                /** @param {string} path */
                deleteFile(path){
                    if (!live())
                    {
                        return;
                    }
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
                    if (!live())
                    {
                        return null;
                    }
                    const { tree, components, key } = locate(path);
                    return state.files.open({
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
                read: (handle, length)=>live()
                    ? state.files.read(handle, length)
                    : new Uint8Array(0),
                /** @param {any} handle @param {Uint8Array} bytes @returns {number} */
                write: (handle, bytes)=>live() ? state.files.write(handle, bytes) : 0,
                /** @param {any} handle @param {number} offset @param {string} [from] */
                seek: (handle, offset, from)=>{
                    if (live())
                    {
                        state.files.seek(handle, offset, from);
                    }
                },
                /** @param {any} handle */
                position: handle=>live() ? state.files.position(handle) : 0,
                /** @param {any} handle */
                size: handle=>live() ? state.files.size(handle) : 0,
                /** @param {any} handle */
                setEndOfFile: handle=>{
                    if (live())
                    {
                        state.files.setEnd(handle);
                    }
                },
                /** @param {any} handle */
                close: handle=>{
                    if (live())
                    {
                        state.files.close(handle);
                    }
                },
                openFiles: ()=>live() ? state.files.list() : [],

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
                    if (!live())
                    {
                        return;
                    }
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
                            const chunk = state.files.read(source, MOVE_CHUNK);
                            if (chunk.length === 0)
                            {
                                break;
                            }
                            state.files.write(destination, chunk);
                        }
                    }
                    finally
                    {
                        state.files.close(source);
                        state.files.close(destination);
                    }
                    this.deleteFile(from);
                },
            };
        },

        /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
        diagnostics(){
            const instance = current;
            if (!instance || instance.disposed)
            {
                return { name: 'filesystem', version: '0.1.0', status: 'created', metrics: {} };
            }
            /** @type {Record<string, any>} */
            const volumes = {};
            for (const [letter, tree] of instance.drives)
            {
                volumes[`${letter}:`] = tree.diagnostics();
            }
            return {
                name: 'filesystem',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    volumes,
                    handles: instance.files.diagnostics(),
                    // A relative path that resolves somewhere unexpected is one
                    // of the harder failures to see from the outside.
                    current: formatPath(
                        instance.directories.drive(),
                        instance.directories.directoryOf(instance.directories.drive())),
                },
            };
        },

        async dispose(){
            if (current)
            {
                current.disposed = true;
            }
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const filesystemModule = createFilesystemModule();
