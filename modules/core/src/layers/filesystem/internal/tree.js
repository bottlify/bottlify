/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The overlay: read-only sources, a writable layer, and the rules that make
 * them look like a single volume to a program that cannot be told its
 * installation is not writable.
 *
 * There are two read-only layers. `source` is the bundle, and a title owns the
 * files in it: writing one copies it up, and deleting one leaves a tombstone.
 * `system` is the engine's own volume -- files a host mounts under
 * `C:\WINDOWS\system32\` -- and it is genuinely read-only: a write is refused,
 * the way writing a system directory is refused on a machine where the program
 * is not an administrator. The bundle wins where both name a file.
 *
 * Three rules do all of the work:
 *
 * - A lookup finds the writable layer first, then the bundle, then the system
 *   volume.
 * - The first write to a file that exists only in the bundle copies it up, so
 *   the bundle is never modified and never has to be.
 * - Deleting something that came from the bundle leaves a tombstone, because
 *   the bundle cannot forget it and would otherwise hand it back on the next
 *   enumeration.
 *
 * Every layer is indexed into one tree of nodes when the drive is mounted, and
 * the tree is kept in step by every mutation that goes through here. A node is
 * therefore the single answer to "does this exist, in which layer, and under
 * what spelling" -- which is also what makes case-insensitive lookup with
 * case-preserving enumeration cheap: the folded name is the key, the node's own
 * name is what enumeration reports.
 */

import { ErrorCode, fsError } from './errors.js';
import { foldName, matchName } from './paths.js';

/**
 * @typedef {Object} Node
 * @property {string} name        As created; enumeration reports this.
 * @property {string} path        Backslash-separated path handed to the stores.
 * @property {Node | null} parent
 * @property {boolean} directory
 * @property {boolean} inSource
 * @property {boolean} inSystem
 * @property {boolean} inWritable
 * @property {boolean} tombstone  Deleted here, still present in the source.
 * @property {Map<string, Node>} children  Keyed by folded name.
 * @property {number} modified    Milliseconds since the epoch; when it was last written.
 */

/**
 * @typedef {Object} Entry
 * @property {string} name
 * @property {string} path
 * @property {boolean} directory
 * @property {number} size
 * @property {number} modified  Milliseconds since the epoch.
 */

/**
 * The time a file that nobody here has written carries: what came from the
 * source was written before this machine existed, and a program comparing
 * dates has to find it older than anything it writes itself. The start of
 * the DOS calendar is the oldest date every convention can still express.
 */
export const SOURCE_MODIFIED_MS = Date.UTC(1980, 0, 1);

/**
 * @param {Node | null} parent
 * @param {string} name
 * @returns {Node}
 */
function makeNode(parent, name){
    const path = !parent || parent.path.length === 0 ? name : `${parent.path}\\${name}`;
    return {
        name,
        path,
        parent,
        directory: false,
        inSource: false,
        inSystem: false,
        inWritable: false,
        tombstone: false,
        children: new Map(),
        modified: SOURCE_MODIFIED_MS,
    };
}

/**
 * @param {Object} options
 * @param {import('./memory-store.js').SourceStore | null} [options.source]
 * @param {import('./memory-store.js').SourceStore | null} [options.system]
 *        The engine's own read-only volume, beneath the source and refused for
 *        writing. `source` wins where both name the same path.
 * @param {import('./memory-store.js').WritableStore} options.writable
 * @param {((change: { path: string, kind: string }) => void) | null} [options.onChanged]
 * @param {() => number} [options.now]  The clock a write is stamped with.
 */
export function createOverlay({
    source = null, system = null, writable, onChanged = null, now = Date.now,
})
{
    /**
     * Announces that a path in the writable layer now differs from what anyone
     * outside has. Only the fact and the path: a program writes a save in
     * hundreds of small writes, and carrying the bytes on each of them would
     * mean copying the file once per write to deliver something already stale
     * by the next one. Whoever listens reads the file when it settles.
     *
     * @param {string} path
     * @param {'written' | 'removed'} kind
     */
    const changed = (path, kind)=>onChanged?.({ path, kind });
    const root = makeNode(null, '');
    root.directory = true;
    root.inSource = source !== null;
    root.inWritable = true;

    /**
     * @param {string} path
     * @param {boolean} directory
     * @param {'source' | 'system' | 'writable'} layer
     */
    const index = (path, directory, layer)=>{
        let node = root;
        const parts = path.split('\\').filter(part=>part.length > 0);
        parts.forEach((part, position)=>{
            const key = foldName(part);
            let child = node.children.get(key);
            if (!child)
            {
                child = makeNode(node, part);
                node.children.set(key, child);
            }
            // Anything with something under it is a directory, whether or not
            // the store bothered to list it as one.
            const leaf = position === parts.length - 1;
            child.directory = child.directory || !leaf || directory;
            if (layer === 'source')
            {
                child.inSource = true;
            }
            else if (layer === 'system')
            {
                child.inSystem = true;
            }
            else
            {
                child.inWritable = true;
            }
            node = child;
        });
    };

    // The bundle is indexed before the system volume so that, where both name
    // a path, the node keeps the bundle's spelling and the bundle's bytes win
    // in every lookup below.
    for (const entry of source?.list() ?? [])
    {
        index(entry.path, entry.directory, 'source');
    }
    for (const entry of system?.list() ?? [])
    {
        index(entry.path, entry.directory, 'system');
    }
    for (const entry of writable.list())
    {
        index(entry.path, entry.directory, 'writable');
    }

    /**
     * @param {string[]} components
     * @returns {Node | null}
     */
    const find = components=>{
        let node = root;
        for (const part of components)
        {
            if (!node.directory)
            {
                return null;
            }
            const child = node.children.get(foldName(part));
            if (!child || child.tombstone)
            {
                return null;
            }
            node = child;
        }
        return node;
    };

    /**
     * The parent a create or a delete has to act on. Missing it is a different
     * failure from missing the file itself, and Win32 reports it differently.
     *
     * @param {string[]} components
     * @returns {Node}
     */
    const parentOf = components=>{
        const node = find(components.slice(0, -1));
        if (!node)
        {
            throw fsError(ErrorCode.PATH_NOT_FOUND,
                `No directory holds "${components.join('\\')}"`);
        }
        if (!node.directory)
        {
            throw fsError(ErrorCode.NOT_A_DIRECTORY, `"${node.path}" is not a directory`);
        }
        return node;
    };

    /** @param {string[]} components @returns {Node} */
    const mustFind = components=>{
        const node = find(components);
        if (!node)
        {
            // Distinguishing the two costs one extra walk and saves a caller
            // from reporting "file not found" for a missing directory.
            parentOf(components);
            throw fsError(ErrorCode.NOT_FOUND, `Nothing at "${components.join('\\')}"`);
        }
        return node;
    };

    /** @param {Node} node @returns {number} */
    const sizeOf = node=>{
        if (node.directory)
        {
            return 0;
        }
        const store = node.inWritable ? writable : node.inSource ? source : system;
        return store?.stat(node.path)?.size ?? 0;
    };

    /**
     * A node that only the engine's volume holds. Its bytes are not a title's
     * to change: the host put them in `system32` as the machine's own, and a
     * write is a mistake rather than a save.
     *
     * @param {Node} node
     */
    const readOnly = node=>node.inSystem && !node.inSource && !node.inWritable;

    /**
     * Gives a node somewhere in the writable layer to live, parents first. A
     * store is never asked to invent a directory it was not told about.
     *
     * @param {Node} node
     */
    const materialiseParents = node=>{
        /** @type {Node[]} */
        const missing = [];
        for (let at = node.parent; at && !at.inWritable; at = at.parent)
        {
            missing.unshift(at);
        }
        for (const directory of missing)
        {
            writable.mkdir(directory.path);
            directory.inWritable = true;
        }
    };

    /**
     * Copy-on-write: the moment a source file is first written to, its bytes
     * move into the writable layer and every later read comes from there.
     *
     * @param {Node} node
     */
    const copyUp = node=>{
        if (node.inWritable)
        {
            return;
        }
        materialiseParents(node);
        const size = source?.stat(node.path)?.size ?? 0;
        writable.write(node.path, 0, source ? source.read(node.path, 0, size) : new Uint8Array(0));
        node.inWritable = true;
    };

    /**
     * @param {Node} parent
     * @param {string} name
     * @returns {Node}
     */
    const childFor = (parent, name)=>{
        const key = foldName(name);
        const existing = parent.children.get(key);
        if (!existing)
        {
            const created = makeNode(parent, name);
            parent.children.set(key, created);
            return created;
        }
        if (existing.tombstone)
        {
            // Recreating a deleted name must not resurrect what used to live
            // under it, and takes the spelling it is being recreated with.
            // `inSource` stays: the source still holds the name, so deleting
            // this again has to leave a tombstone rather than uncover it.
            existing.children.clear();
            existing.tombstone = false;
            existing.name = name;
            existing.path = parent.path.length === 0 ? name : `${parent.path}\\${name}`;
        }
        return existing;
    };

    /**
     * Drops a node from the writable layer, leaving a tombstone if the source
     * would otherwise hand it straight back on the next enumeration.
     *
     * @param {Node} node
     */
    const forget = node=>{
        if (node.inWritable)
        {
            writable.remove(node.path);
            node.inWritable = false;
        }
        if (node.inSource)
        {
            node.tombstone = true;
            return;
        }
        node.parent?.children.delete(foldName(node.name));
    };

    return {
        /** @param {string[]} components @returns {Entry | null} */
        stat(components){
            const node = find(components);
            return node
                ? {
                    name: node.name,
                    path: node.path,
                    directory: node.directory,
                    size: sizeOf(node),
                    modified: node.modified,
                }
                : null;
        },

        /**
         * Stamps a file with a time of the caller's choosing, which is what an
         * installer does to every file it unpacks: the archive carries the
         * time, and the next pass compares against it.
         *
         * @param {string[]} components @param {number} modified
         */
        setModified(components, modified){
            mustFind(components).modified = modified;
        },

        /**
         * Merges both layers into one listing: tombstoned names are gone, and a
         * name present in both appears once, under the spelling it was created
         * with rather than the one the caller asked about.
         *
         * @param {string[]} components
         * @param {string} [pattern]
         * @returns {Entry[]}
         */
        list(components, pattern){
            const node = mustFind(components);
            if (!node.directory)
            {
                throw fsError(ErrorCode.NOT_A_DIRECTORY, `"${node.path}" is not a directory`);
            }
            const entries = [];
            for (const child of node.children.values())
            {
                if (child.tombstone || (pattern && !matchName(pattern, child.name)))
                {
                    continue;
                }
                entries.push({
                    name: child.name,
                    path: child.path,
                    directory: child.directory,
                    size: sizeOf(child),
                    modified: child.modified,
                });
            }
            return entries;
        },

        /** @param {string[]} components @returns {number} */
        size(components){
            return sizeOf(mustFind(components));
        },

        /**
         * @param {string[]} components @param {number} offset @param {number} length
         * @returns {Uint8Array}
         */
        read(components, offset, length){
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
            }
            const store = node.inWritable ? writable : node.inSource ? source : system;
            return store ? store.read(node.path, offset, length) : new Uint8Array(0);
        },

        /** @param {string[]} components @param {number} offset @param {Uint8Array} bytes */
        write(components, offset, bytes){
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
            }
            if (readOnly(node))
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${node.path}" is on the engine's read-only volume`);
            }
            copyUp(node);
            writable.write(node.path, offset, bytes);
            node.modified = now();
            changed(node.path, 'written');
        },

        /** @param {string[]} components @param {number} size */
        truncate(components, size){
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
            }
            if (readOnly(node))
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${node.path}" is on the engine's read-only volume`);
            }
            if (size === 0 && !node.inWritable)
            {
                // Nothing of the source file survives a truncation to nothing,
                // so copying it up first would only be work.
                materialiseParents(node);
                node.inWritable = true;
            }
            else
            {
                copyUp(node);
            }
            writable.truncate(node.path, size);
            node.modified = now();
        },

        /**
         * Creates an empty file, failing if the name is taken.
         *
         * @param {string[]} components
         * @returns {Entry}
         */
        createFile(components){
            const parent = parentOf(components);
            if (readOnly(parent))
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${parent.path}" is on the engine's read-only volume`);
            }
            const name = components[components.length - 1];
            if (name === undefined)
            {
                throw fsError(ErrorCode.INVALID_PATH, 'A root is not a file');
            }
            const existing = parent.children.get(foldName(name));
            if (existing && !existing.tombstone)
            {
                throw fsError(ErrorCode.ALREADY_EXISTS, `"${existing.path}" already exists`);
            }
            const node = childFor(parent, name);
            node.directory = false;
            materialiseParents(node);
            writable.truncate(node.path, 0);
            node.inWritable = true;
            node.modified = now();
            changed(node.path, 'written');
            return { name: node.name, path: node.path, directory: false, size: 0,
                modified: node.modified };
        },

        /**
         * Creates a directory. One that already exists in the source is joined
         * rather than replaced, so what the source put in it stays visible.
         *
         * @param {string[]} components
         * @returns {boolean} false when the directory was already there.
         */
        createDirectory(components){
            const parent = parentOf(components);
            if (readOnly(parent))
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${parent.path}" is on the engine's read-only volume`);
            }
            const name = components[components.length - 1];
            if (name === undefined)
            {
                throw fsError(ErrorCode.INVALID_PATH, 'A root always exists');
            }
            const existing = parent.children.get(foldName(name));
            if (existing && !existing.tombstone)
            {
                if (!existing.directory)
                {
                    throw fsError(ErrorCode.ALREADY_EXISTS, `"${existing.path}" is a file`);
                }
                if (existing.inWritable)
                {
                    return false;
                }
                materialiseParents(existing);
                writable.mkdir(existing.path);
                existing.inWritable = true;
                return false;
            }
            const node = childFor(parent, name);
            node.directory = true;
            materialiseParents(node);
            writable.mkdir(node.path);
            node.inWritable = true;
            return true;
        },

        /** @param {string[]} components */
        removeFile(components){
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
            }
            if (readOnly(node))
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${node.path}" is on the engine's read-only volume`);
            }
            forget(node);
            changed(node.path, 'removed');
        },

        /**
         * Removes an empty directory. A directory holding anything at all --
         * including something that only exists in the source -- is refused.
         *
         * @param {string[]} components
         */
        removeDirectory(components){
            const node = mustFind(components);
            if (!node.directory)
            {
                throw fsError(ErrorCode.NOT_A_DIRECTORY, `"${node.path}" is not a directory`);
            }
            if (node === root)
            {
                throw fsError(ErrorCode.ACCESS_DENIED, 'A root cannot be removed');
            }
            if (readOnly(node))
            {
                throw fsError(ErrorCode.ACCESS_DENIED,
                    `"${node.path}" is on the engine's read-only volume`);
            }
            const live = [...node.children.values()].some(child=>!child.tombstone);
            if (live)
            {
                throw fsError(ErrorCode.DIRECTORY_NOT_EMPTY, `"${node.path}" is not empty`);
            }
            forget(node);
        },

        /**
         * Every file that lives in the writable layer: what the program itself
         * has produced, and therefore what a session is made of. Nothing from
         * the source is in it -- a bundle is fetched by digest, never uploaded.
         *
         * @returns {{ path: string, size: number }[]}
         */
        writableFiles(){
            /** @type {{ path: string, size: number }[]} */
            const found = [];
            /** @param {Node} node */
            const walk = node=>{
                for (const child of node.children.values())
                {
                    if (child.tombstone)
                    {
                        continue;
                    }
                    if (child.directory)
                    {
                        walk(child);
                    }
                    else if (child.inWritable)
                    {
                        found.push({
                            path: child.path,
                            size: writable.stat(child.path)?.size ?? 0,
                        });
                    }
                }
            };
            walk(root);
            return found;
        },

        diagnostics(){
            let files = 0;
            let directories = 0;
            let tombstones = 0;
            let copied = 0;
            /** @param {Node} node */
            const walk = node=>{
                for (const child of node.children.values())
                {
                    if (child.tombstone)
                    {
                        tombstones++;
                    }
                    else if (child.directory)
                    {
                        directories++;
                    }
                    else
                    {
                        files++;
                        copied += child.inSource && child.inWritable ? 1 : 0;
                    }
                    walk(child);
                }
            };
            walk(root);
            return { files, directories, tombstones, copied, layered: source !== null };
        },
    };
}
