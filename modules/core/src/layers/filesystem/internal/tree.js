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
 * The read-only layer, `source`, is the bundle, and a title owns the files in
 * it: writing one copies it up, and deleting one leaves a tombstone.
 *
 * Three rules do all of the work:
 *
 * - A lookup finds the writable layer first, then the bundle.
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
 *
 * The stores do not fold case, and two layers need not agree on a spelling:
 * the machine makes `WINDOWS\TEMP` before a bundle that spells it `Windows`
 * is mounted over it. A node therefore keeps each layer's own key -- `path`
 * in the writable store, `sourcePath` in the source -- and a store is changed
 * before the node records the change, so a store that refuses leaves the tree
 * as it was. `verify` says where the two disagree.
 */

import { ErrorCode, fsError } from './errors.js';
import { foldName, matchName } from './paths.js';
import { bytesOf } from './memory-store.js';

/**
 * @typedef {Object} Node
 * @property {string} name        As created; enumeration reports this.
 * @property {string} path        Its key in the writable store: where it is there,
 *                                or where it will be made.
 * @property {string} sourcePath  Its key in the source, which may spell a directory
 *                                on the way to it otherwise.
 * @property {Node | null} parent
 * @property {boolean} directory
 * @property {boolean} inSource
 * @property {boolean} inWritable
 * @property {boolean} tombstone  Deleted here, still present in the source.
 * @property {Map<string, Node>} children  Keyed by folded name.
 * @property {number} modified    Milliseconds since the epoch; when it was last written.
 * @property {boolean} hidden     The source records it as hidden.
 */

/**
 * @typedef {Object} Entry
 * @property {string} name
 * @property {string} path
 * @property {boolean} directory
 * @property {number} size
 * @property {number} modified  Milliseconds since the epoch.
 * @property {boolean} hidden
 * @property {boolean} readOnly  On a volume nothing can be written to.
 */

/**
 * The time a file that nobody here has written carries: what came from the
 * source was written before this machine existed, and a program comparing
 * dates has to find it older than anything it writes itself. The start of
 * the DOS calendar is the oldest date every convention can still express.
 */
export const SOURCE_MODIFIED_MS = Date.UTC(1980, 0, 1);

/** @param {string} directory @param {string} name */
const joinPath = (directory, name)=>(directory.length === 0 ? name : `${directory}\\${name}`);

/**
 * @param {Node | null} parent
 * @param {string} name
 * @returns {Node}
 */
function makeNode(parent, name){
    return {
        name,
        path: joinPath(parent?.path ?? '', name),
        sourcePath: joinPath(parent?.sourcePath ?? '', name),
        parent,
        directory: false,
        inSource: false,
        inWritable: false,
        tombstone: false,
        children: new Map(),
        modified: SOURCE_MODIFIED_MS,
        hidden: false,
    };
}

/** What changes a drive: everything else of it only reads. */
const CHANGES = /** @type {const} */ (['setModified', 'replace', 'write', 'truncate', 'createFile',
    'createDirectory', 'moveFile', 'removeFile', 'removeDirectory']);

/**
 * @param {Object} options
 * @param {import('./memory-store.js').SourceStore | null} [options.source]
 * @param {import('./memory-store.js').WritableStore} options.writable
 * @param {((change: { path: string, kind: string }) => void) | null} [options.onChanged]
 * @param {() => number} [options.now]  The clock a write is stamped with.
 * @param {boolean} [options.readOnly]
 *        The whole volume is read-only media, a disc: every write, create and
 *        delete is `WRITE_PROTECTED`, whatever layer the name is in.
 * @param {{ words: Int32Array, index: number } | null} [options.revision]
 *        A word raised after every change to the drive, whatever made it: a
 *        process in another thread keeps what it read of the drive for as long
 *        as the word stands where it stood when it read (`volume-link.js`).
 */
export function createOverlay({
    source = null, writable, onChanged = null, now = Date.now, readOnly = false, revision = null,
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
     * @param {'source' | 'writable'} layer
     * @param {import('./memory-store.js').StoredEntry} [entry]
     *        What the store said of it: a disc records when each file was
     *        written and which are hidden, and a program reading those reads
     *        the disc's answer rather than the overlay's default.
     */
    const index = (path, directory, layer, entry)=>{
        let node = root;
        const parts = path.split('\\').filter(part=>part.length > 0);
        let key = '';
        parts.forEach((part, position)=>{
            const folded = foldName(part);
            key = joinPath(key, part);
            let child = node.children.get(folded);
            if (!child)
            {
                child = makeNode(node, part);
                node.children.set(folded, child);
            }
            // Anything with something under it is a directory, whether or not
            // the store bothered to list it as one.
            const leaf = position === parts.length - 1;
            child.directory = child.directory || !leaf || directory;
            // The store's own spelling, whatever the other layer calls it.
            if (layer === 'source')
            {
                child.sourcePath = key;
                child.inSource = true;
                if (leaf && typeof entry?.modified === 'number')
                {
                    child.modified = entry.modified;
                }
                if (leaf && entry?.hidden)
                {
                    child.hidden = true;
                }
            }
            else
            {
                child.path = key;
                child.inWritable = true;
            }
            node = child;
        });
    };

    /**
     * What a layer does not hold of a node, it would hold under the node's
     * parent as that layer spells it: a file made under `Windows` that the
     * writable store holds as `WINDOWS` is made in `WINDOWS`. Settled after
     * both layers are indexed, since the second may respell a directory the
     * first already put children under.
     *
     * @param {Node} node
     */
    const settleKeys = node=>{
        for (const child of node.children.values())
        {
            if (!child.inWritable)
            {
                child.path = joinPath(node.path, child.name);
            }
            if (!child.inSource)
            {
                child.sourcePath = joinPath(node.sourcePath, child.name);
            }
            settleKeys(child);
        }
    };

    for (const entry of source?.list() ?? [])
    {
        index(entry.path, entry.directory, 'source', entry);
    }
    for (const entry of writable.list())
    {
        index(entry.path, entry.directory, 'writable');
    }
    settleKeys(root);

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
        if (node.inWritable)
        {
            return writable.stat(node.path)?.size ?? 0;
        }
        return node.inSource ? source?.stat(node.sourcePath)?.size ?? 0 : 0;
    };

    /**
     * Refuses a change on read-only media before anything else is looked at:
     * the device refuses it, not the file, so whether the name exists does
     * not change the answer.
     *
     * @param {string[]} components
     */
    const mustBeWritable = components=>{
        if (readOnly)
        {
            throw fsError(ErrorCode.WRITE_PROTECTED,
                `"${components.join('\\')}" is on read-only media`);
        }
    };

    /**
     * Makes a directory and every one above it in the writable layer, so that
     * something can be put in it. A store is never asked to invent a
     * directory it was not told about.
     *
     * @param {Node} directory
     */
    const materialise = directory=>{
        /** @type {Node[]} */
        const missing = [];
        for (let at = /** @type {Node | null} */ (directory); at && !at.inWritable; at = at.parent)
        {
            missing.unshift(at);
        }
        for (const made of missing)
        {
            writable.mkdir(made.path);
            made.inWritable = true;
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
        materialise(/** @type {Node} */ (node.parent));
        const size = source?.stat(node.sourcePath)?.size ?? 0;
        writable.write(node.path, 0,
            source ? source.read(node.sourcePath, 0, size) : new Uint8Array(0));
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
            // `inSource` stays, and `sourcePath` with it: the source still
            // holds the name, so deleting this again has to leave a tombstone
            // rather than uncover it.
            existing.children.clear();
            existing.tombstone = false;
            existing.name = name;
            existing.path = joinPath(parent.path, name);
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

    const overlay = {
        readOnly,

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
                    hidden: node.hidden,
                    readOnly,
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
            mustBeWritable(components);
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
                    hidden: child.hidden,
                    readOnly,
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
            if (node.inWritable)
            {
                return writable.read(node.path, offset, length);
            }
            return node.inSource && source
                ? source.read(node.sourcePath, offset, length)
                : new Uint8Array(0);
        },

        /**
         * A file's whole contents, shared rather than copied where the store
         * can: what one process wrote goes to the next as the same bytes.
         *
         * @param {string[]} components @returns {Uint8Array}
         */
        share(components){
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
            }
            if (node.inWritable && writable.share)
            {
                return writable.share(node.path);
            }
            return this.read(components, 0, sizeOf(node));
        },

        /**
         * A file's contents as the writable store hands them to another of its
         * kind without copying, or null when it cannot -- a file the source
         * holds, a store that keeps none: `share` is the way then.
         *
         * @param {string[]} components
         * @returns {import('./memory-store.js').FileContents | null}
         */
        contentsOf(components){
            const node = mustFind(components);
            return !node.directory && node.inWritable && writable.contents
                ? writable.contents(node.path)
                : null;
        },

        /**
         * Replaces a file's contents with `bytes`, taken as they are where the
         * store can keep them without copying (see `share`) -- or with what
         * another store's `contentsOf` handed out, given as `contents`, which
         * a store that cannot adopt takes as their bytes.
         *
         * @param {string[]} components @param {Uint8Array | null} bytes
         * @param {import('./memory-store.js').FileContents} [contents]
         */
        replace(components, bytes, contents){
            mustBeWritable(components);
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
            }
            if (!node.inWritable)
            {
                materialise(/** @type {Node} */ (node.parent));
            }
            if (contents && writable.adoptContents)
            {
                writable.adoptContents(node.path, contents);
            }
            else
            {
                const whole = bytes ?? (contents ? bytesOf(contents) : new Uint8Array(0));
                if (writable.adopt)
                {
                    writable.adopt(node.path, whole);
                }
                else
                {
                    writable.truncate(node.path, 0);
                    writable.write(node.path, 0, whole);
                }
            }
            node.inWritable = true;
            node.modified = now();
            changed(node.path, 'written');
        },

        /** @param {string[]} components @param {number} offset @param {Uint8Array} bytes */
        write(components, offset, bytes){
            mustBeWritable(components);
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
            }
            copyUp(node);
            writable.write(node.path, offset, bytes);
            node.modified = now();
            changed(node.path, 'written');
        },

        /** @param {string[]} components @param {number} size */
        truncate(components, size){
            mustBeWritable(components);
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
            }
            if (size === 0 && !node.inWritable)
            {
                // Nothing of the source file survives a truncation to nothing,
                // so copying it up first would only be work.
                materialise(/** @type {Node} */ (node.parent));
            }
            else
            {
                copyUp(node);
            }
            writable.truncate(node.path, size);
            node.inWritable = true;
            node.modified = now();
            changed(node.path, 'written');
        },

        /**
         * Creates an empty file, failing if the name is taken.
         *
         * @param {string[]} components
         * @returns {Entry}
         */
        createFile(components){
            mustBeWritable(components);
            const parent = parentOf(components);
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
            materialise(parent);
            writable.truncate(joinPath(parent.path, name), 0);
            const node = childFor(parent, name);
            node.directory = false;
            node.inWritable = true;
            node.modified = now();
            changed(node.path, 'written');
            return { name: node.name, path: node.path, directory: false, size: 0,
                modified: node.modified, hidden: false, readOnly };
        },

        /**
         * Creates a directory. One that already exists in the source is joined
         * rather than replaced, so what the source put in it stays visible.
         *
         * @param {string[]} components
         * @returns {boolean} false when the directory was already there.
         */
        createDirectory(components){
            mustBeWritable(components);
            const parent = parentOf(components);
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
                materialise(existing);
                return false;
            }
            materialise(parent);
            writable.mkdir(joinPath(parent.path, name));
            const node = childFor(parent, name);
            node.directory = true;
            node.inWritable = true;
            return true;
        },

        /**
         * Gives a file another name with its bytes where they are: what a
         * rename is for a file only the writable layer holds. False, with
         * nothing done, for one the source holds too -- the source keeps its
         * name whatever happens -- or a store that cannot move a file; the
         * caller copies it then.
         *
         * @param {string[]} from @param {string[]} to
         * @returns {boolean}
         */
        moveFile(from, to){
            mustBeWritable(from);
            const node = mustFind(from);
            if (node.directory || node.inSource || !node.inWritable || !writable.move)
            {
                return false;
            }
            const parent = parentOf(to);
            const name = to[to.length - 1];
            if (name === undefined)
            {
                throw fsError(ErrorCode.INVALID_PATH, 'A root is not a file');
            }
            const existing = parent.children.get(foldName(name));
            if (existing && !existing.tombstone)
            {
                throw fsError(ErrorCode.ALREADY_EXISTS, `"${existing.path}" already exists`);
            }
            materialise(parent);
            writable.move(node.path, joinPath(parent.path, name));
            const target = childFor(parent, name);
            target.directory = false;
            target.inWritable = true;
            target.modified = node.modified;
            node.inWritable = false;
            forget(node);
            changed(node.path, 'removed');
            changed(target.path, 'written');
            return true;
        },

        /** @param {string[]} components */
        removeFile(components){
            mustBeWritable(components);
            const node = mustFind(components);
            if (node.directory)
            {
                throw fsError(ErrorCode.IS_A_DIRECTORY, `"${node.path}" is a directory`);
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
            mustBeWritable(components);
            const node = mustFind(components);
            if (!node.directory)
            {
                throw fsError(ErrorCode.NOT_A_DIRECTORY, `"${node.path}" is not a directory`);
            }
            if (node === root)
            {
                throw fsError(ErrorCode.ACCESS_DENIED, 'A root cannot be removed');
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

        /**
         * The directories the writable layer made that hold nothing. A list of
         * files cannot say they exist, and a program that creates a file in one
         * relies on it being there: CreateDirectory does not make parents.
         *
         * @returns {string[]}
         */
        writableDirectories(){
            /** @type {string[]} */
            const found = [];
            /** @param {Node} node */
            const walk = node=>{
                let live = 0;
                for (const child of node.children.values())
                {
                    if (child.tombstone)
                    {
                        continue;
                    }
                    live++;
                    if (child.directory)
                    {
                        walk(child);
                    }
                }
                if (live === 0 && node !== root && node.inWritable)
                {
                    found.push(node.path);
                }
            };
            walk(root);
            return found;
        },

        /**
         * Where the tree and its stores disagree, one line each; empty when
         * they agree. What the tree says is in a layer must be there under
         * the node's key for that layer, every node must be in one layer or
         * the other, and nothing may be in the writable store that the tree
         * does not hold there under that same key -- a file the program can
         * neither see nor, if the tree lists it, read.
         *
         * @returns {string[]}
         */
        verify(){
            /** @type {string[]} */
            const problems = [];
            /** @param {Node} node */
            const walk = node=>{
                for (const child of node.children.values())
                {
                    const kind = child.directory ? 'directory' : 'file';
                    if (child.inWritable)
                    {
                        const stored = writable.stat(child.path);
                        if (!stored || stored.directory !== child.directory)
                        {
                            problems.push(`the writable layer has no ${kind} "${child.path}"`);
                        }
                        if (child.tombstone)
                        {
                            problems.push(`"${child.path}" is deleted and still written`);
                        }
                    }
                    else if (!child.inSource)
                    {
                        problems.push(`"${child.path}" is in neither layer`);
                    }
                    if (child.inSource && !child.tombstone && !child.directory)
                    {
                        const held = source?.stat(child.sourcePath);
                        if (!held || held.directory)
                        {
                            problems.push(`the source has no file "${child.sourcePath}"`);
                        }
                    }
                    walk(child);
                }
            };
            walk(root);
            for (const entry of writable.list())
            {
                let node = /** @type {Node | undefined} */ (root);
                for (const part of entry.path.split('\\').filter(name=>name.length > 0))
                {
                    node = node?.children.get(foldName(part));
                }
                if (!node || !node.inWritable || node.path !== entry.path)
                {
                    problems.push(`the writable layer holds "${entry.path}", which the tree `
                        + (node?.inWritable ? `holds as "${node.path}"` : 'does not hold there'));
                }
            }
            return problems;
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
            return { files, directories, tombstones, copied, layered: source !== null,
                disagreements: overlay.verify().length };
        },
    };
    if (revision)
    {
        // Raised whether the change finished or failed half way: a reader that
        // throws away what it kept for nothing loses a read, one that keeps
        // what changed reads a file that is not there.
        for (const name of CHANGES)
        {
            const change = /** @type {(...args: any[]) => any} */ (overlay[name]);
            overlay[name] = /** @type {any} */ ((/** @type {any[]} */ ...args)=>{
                try
                {
                    return change.apply(overlay, args);
                }
                finally
                {
                    Atomics.add(revision.words, revision.index, 1);
                }
            });
        }
    }
    return overlay;
}
