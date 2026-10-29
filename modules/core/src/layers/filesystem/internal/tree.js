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
 */

import { ErrorCode, fsError } from './errors.js';
import { foldName, matchName } from './paths.js';
import { bytesOf } from './memory-store.js';

/**
 * @typedef {Object} Node
 * @property {string} name        As created; enumeration reports this.
 * @property {string} path        Backslash-separated path handed to the stores.
 * @property {Node | null} parent
 * @property {boolean} directory
 * @property {boolean} inSource
 * @property {boolean} inWritable
 * @property {boolean} tombstone  Deleted here, still present in the source.
 * @property {Map<string, Node>} children  Keyed by folded name.
 * @property {number} modified    Milliseconds since the epoch; when it was last written.
 * @property {boolean} hidden     The source records it as hidden.
 * @property {Body | null} body   For a file with more than one name: what its names share.
 */

/**
 * A file with more than one name -- a hard link made it one. Each name is a
 * node of its own, in its own directory; the bytes are the writable store's
 * once, at the path of the name that `owner` is, and every store operation
 * on any of the names goes there. A name going away takes the bytes with it
 * only when it is the last: the owner's leaving moves them to another name's
 * path first, so the store never holds bytes under a name nobody sees.
 *
 * @typedef {Object} Body
 * @property {Node} owner
 * @property {Set<Node>} names  the owner among them
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
 * @property {number} links  How many names the file has.
 * @property {string} identity  What the file is known by under any of its names.
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
        inWritable: false,
        tombstone: false,
        children: new Map(),
        modified: SOURCE_MODIFIED_MS,
        hidden: false,
        body: null,
    };
}

/**
 * The path the stores hold a file's bytes under: its own, or its owner's.
 * Also what the file is known by under any of its names: always one of its
 * live names, so no other file can have it.
 *
 * @param {Node} node
 */
const storePath = node=>(node.body?.owner ?? node).path;

/** Every name a file has: itself alone, or its body's. @param {Node} node @returns {Node[]} */
const namesOf = node=>(node.body ? [...node.body.names] : [node]);

/** What changes a drive: everything else of it only reads. */
const CHANGES = /** @type {const} */ (['setModified', 'replace', 'write', 'truncate', 'createFile',
    'createDirectory', 'moveFile', 'removeFile', 'removeDirectory', 'link', 'restoreLinks']);

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
                child.inWritable = true;
            }
            node = child;
        });
    };

    for (const entry of source?.list() ?? [])
    {
        index(entry.path, entry.directory, 'source', entry);
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
        const store = node.inWritable ? writable : node.inSource ? source : null;
        return store?.stat(storePath(node))?.size ?? 0;
    };

    /**
     * Stamps a file's time on every name it has: the time is the file's,
     * not a name's.
     *
     * @param {Node} node @param {number} time
     */
    const stamp = (node, time)=>{
        for (const name of namesOf(node))
        {
            name.modified = time;
        }
    };

    /**
     * Announces a write to a file under every name it has: a reader watching
     * any of them sees it change.
     *
     * @param {Node} node
     */
    const written = node=>{
        for (const name of namesOf(node))
        {
            changed(name.path, 'written');
        }
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
        if (node.body)
        {
            unname(node);
        }
        else if (node.inWritable)
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

    /**
     * Takes one name off a file with several: the bytes stay for the others,
     * moved to one of their paths first when they lived at this one's, and a
     * file left with one name is an ordinary file again.
     *
     * @param {Node} node
     */
    const unname = node=>{
        const body = /** @type {Body} */ (node.body);
        body.names.delete(node);
        node.body = null;
        node.inWritable = false;
        const [heir] = body.names;
        if (body.owner === node)
        {
            relocate(node.path, heir.path);
            body.owner = heir;
        }
        if (body.names.size === 1)
        {
            heir.body = null;
        }
    };

    /**
     * Moves a file's bytes in the writable store from one path to another,
     * by the store's own move where it has one.
     *
     * @param {string} from @param {string} to
     */
    const relocate = (from, to)=>{
        if (writable.move)
        {
            writable.move(from, to);
            return;
        }
        const size = writable.stat(from)?.size ?? 0;
        writable.truncate(to, 0);
        writable.write(to, 0, writable.read(from, 0, size));
        writable.remove(from);
    };

    /**
     * Gives an existing file one more name. The file is copied up first if
     * the source holds it, as a write would: the names share bytes only the
     * writable layer can keep.
     *
     * @param {Node} node @param {Node} parent @param {string} name
     */
    const addName = (node, parent, name)=>{
        copyUp(node);
        const body = node.body ?? { owner: node, names: new Set([node]) };
        node.body = body;
        const target = childFor(parent, name);
        target.directory = false;
        materialiseParents(target);
        target.inWritable = true;
        target.body = body;
        target.modified = node.modified;
        body.names.add(target);
        return target;
    };

    /**
     * Moves one name of a file with several to another place in the drive:
     * the other names stay, and the bytes move only when they were kept at
     * this name's path.
     *
     * @param {Node} node @param {string[]} to
     * @returns {boolean}
     */
    const renameName = (node, to)=>{
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
        const body = /** @type {Body} */ (node.body);
        const target = childFor(parent, name);
        target.directory = false;
        materialiseParents(target);
        target.inWritable = true;
        target.modified = node.modified;
        target.body = body;
        body.names.add(target);
        if (body.owner === node)
        {
            relocate(node.path, target.path);
            body.owner = target;
        }
        body.names.delete(node);
        node.body = null;
        node.inWritable = false;
        if (node.inSource)
        {
            node.tombstone = true;
        }
        else
        {
            node.parent?.children.delete(foldName(node.name));
        }
        changed(node.path, 'removed');
        changed(target.path, 'written');
        return true;
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
                    links: node.body?.names.size ?? 1,
                    identity: storePath(node),
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
            stamp(mustFind(components), modified);
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
                    links: child.body?.names.size ?? 1,
                    identity: storePath(child),
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
            const store = node.inWritable ? writable : node.inSource ? source : null;
            return store ? store.read(storePath(node), offset, length) : new Uint8Array(0);
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
                return writable.share(storePath(node));
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
                ? writable.contents(storePath(node))
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
                materialiseParents(node);
                node.inWritable = true;
            }
            const at = storePath(node);
            if (contents && writable.adoptContents)
            {
                writable.adoptContents(at, contents);
            }
            else
            {
                const whole = bytes ?? (contents ? bytesOf(contents) : new Uint8Array(0));
                if (writable.adopt)
                {
                    writable.adopt(at, whole);
                }
                else
                {
                    writable.truncate(at, 0);
                    writable.write(at, 0, whole);
                }
            }
            stamp(node, now());
            written(node);
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
            writable.write(storePath(node), offset, bytes);
            stamp(node, now());
            written(node);
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
                materialiseParents(node);
                node.inWritable = true;
            }
            else
            {
                copyUp(node);
            }
            writable.truncate(storePath(node), size);
            stamp(node, now());
            written(node);
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
            const node = childFor(parent, name);
            node.directory = false;
            materialiseParents(node);
            writable.truncate(node.path, 0);
            node.inWritable = true;
            node.modified = now();
            changed(node.path, 'written');
            return { name: node.name, path: node.path, directory: false, size: 0,
                modified: node.modified, hidden: false, readOnly, links: 1, identity: node.path };
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
            if (node.body)
            {
                return renameName(node, to);
            }
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
            const target = childFor(parent, name);
            target.directory = false;
            materialiseParents(target);
            writable.move(node.path, target.path);
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
         * Gives the file at `from` the further name `to`, in this drive: the
         * names share the file's bytes, times and identity from then on. A
         * directory has no second name (ACCESS_DENIED), and a name taken is
         * ALREADY_EXISTS.
         *
         * @param {string[]} from @param {string[]} to
         * @returns {Entry}
         */
        link(from, to){
            mustBeWritable(to);
            const node = mustFind(from);
            if (node.directory)
            {
                throw fsError(ErrorCode.ACCESS_DENIED, `"${node.path}" is a directory`);
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
            const target = addName(node, parent, name);
            changed(target.path, 'written');
            return /** @type {Entry} */ (this.stat(to));
        },

        /**
         * Every name the file at `components` has, as paths: itself alone
         * unless it is linked.
         *
         * @param {string[]} components @returns {string[]}
         */
        namesOf(components){
            return namesOf(mustFind(components)).map(name=>name.path);
        },

        /**
         * The files with more than one name, each as the path its bytes are
         * kept under and its other names: what a session carries besides the
         * files themselves. Empty for a drive with no links.
         *
         * @returns {{ owner: string, names: string[] }[]}
         */
        links(){
            /** @type {Set<Body>} */
            const bodies = new Set();
            /** @param {Node} node */
            const walk = node=>{
                for (const child of node.children.values())
                {
                    if (child.body)
                    {
                        bodies.add(child.body);
                    }
                    if (child.directory)
                    {
                        walk(child);
                    }
                }
            };
            walk(root);
            return [...bodies].map(body=>({ owner: body.owner.path,
                names: [...body.names].filter(name=>name !== body.owner).map(name=>name.path) }));
        },

        /**
         * Gives files back the further names a session recorded for them,
         * once the files themselves are on the drive. A name that a file
         * already holds is taken over: the session is what the program left.
         *
         * @param {{ owner: string, names: string[] }[]} records
         */
        restoreLinks(records){
            for (const record of records)
            {
                const owner = find(record.owner.split('\\').filter(part=>part.length > 0));
                if (!owner || owner.directory)
                {
                    continue;
                }
                for (const path of record.names)
                {
                    const components = path.split('\\').filter(part=>part.length > 0);
                    const present = find(components);
                    if (present && (present.directory || present.body === owner.body
                        && owner.body !== null))
                    {
                        continue;
                    }
                    if (present)
                    {
                        forget(present);
                    }
                    for (let depth = 1; depth < components.length; depth++)
                    {
                        if (!find(components.slice(0, depth)))
                        {
                            overlay.createDirectory(components.slice(0, depth));
                        }
                    }
                    addName(owner, parentOf(components),
                        /** @type {string} */ (components[components.length - 1]));
                }
            }
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
                    else if (child.inWritable && (!child.body || child.body.owner === child))
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
