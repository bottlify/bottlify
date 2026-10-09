/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The volume, in the vocabulary the file surface speaks.
 *
 * Two layers describe a filesystem differently, and both are right for where
 * they sit. The filesystem layer answers in named failures and hands out handle
 * objects that carry their own position, because that is what a filesystem is.
 * The Win32 surface wants something that never throws, tells apart "missing" and
 * "the directory above is missing", and reads at an offset it names itself,
 * because that is what CreateFile and ReadFile are.
 *
 * Translating between those two is the whole job of this file, and it lives on
 * the win32 side because the vocabulary being translated *into* is the guest's.
 * A failure becomes a return value here; which error number the guest is then
 * told is still the surface's decision, not ours.
 */

/**
 * @typedef {Object} VfsErrorNames
 * @property {string} NOT_FOUND
 * @property {string} PATH_NOT_FOUND
 */

/**
 * The FILE_NOTIFY_CHANGE_ kinds a change to a name is: its name (a file's or
 * a directory's), its attributes, its size and its last write.
 */
const CHANGE_FILE_NAME = 0x001;
const CHANGE_DIR_NAME = 0x002;
const CHANGE_ATTRIBUTES = 0x004;
const CHANGE_SIZE = 0x008;
const CHANGE_LAST_WRITE = 0x010;

/**
 * @param {any} fs  The filesystem layer's API.
 * @param {((blocks: any[]) => Promise<void>) | null} [fetchBlocks]
 *        Brings absent bundle blocks in. Absent itself when nothing is mounted
 *        from a bundle, in which case a miss is a fault rather than a wait.
 */
export function createVolume(fs, fetchBlocks = null){
    const { ErrorCode, Disposition, SeekFrom } = fs;

    /**
     * Runs an operation that may fail, and answers with a value instead.
     *
     * Every failure this layer reports is one the guest has a code for, so
     * swallowing them here is not losing information -- it is moving where the
     * information is expressed. What is not caught is a bug in us, and that
     * should still be a thrown error rather than a file that quietly is not
     * there.
     *
     * @template T
     * @param {() => T} operation
     * @param {T} fallback
     * @returns {T}
     */
    const attempt = (operation, fallback)=>{
        try
        {
            return operation();
        }
        catch (e){
            const error = /** @type {any} */ (e);
            if (!error?.code || !(error.code in ErrorCode))
            {
                throw error;
            }
            return fallback;
        }
    };

    /**
     * How many holders an open file has beyond the handle that opened it.
     *
     * On Windows a file mapping holds the file it maps and a view holds its
     * mapping, so a program may close the three in any order. Here each of
     * them shares the one open node, and `close` gives back one hold rather
     * than closing it outright: the node is closed when the last holder lets
     * go, whichever that is.
     *
     * @type {WeakMap<any, number>}
     */
    const holds = new WeakMap();

    /**
     * The disposition names the two layers use for the same five behaviours.
     *
     * @param {any} mode
     */
    const dispositionOf = mode=>{
        if (mode.failIfExists)
        {
            return Disposition.CREATE_NEW;
        }
        if (mode.create && mode.truncate)
        {
            return Disposition.CREATE_ALWAYS;
        }
        if (mode.create)
        {
            return Disposition.OPEN_ALWAYS;
        }
        return mode.truncate ? Disposition.TRUNCATE_EXISTING : Disposition.OPEN_EXISTING;
    };

    /**
     * What sets a name apart from an ordinary file: it is on read-only media,
     * or the media records it as hidden. Said only when it is so.
     *
     * @param {any} entry
     */
    const marks = entry=>({
        ...entry.readOnly ? { readOnly: true } : {},
        ...entry.hidden ? { hidden: true } : {},
    });

    /**
     * The attributes programs set, by name folded to one case as the volume
     * folds it. The filesystem below keeps no attribute bits, and read-only
     * is not decoration: a program marks a file read-only and expects the
     * delete and the write it did not mean to allow to be refused. Kept for
     * the life of the process, following a name through a rename, a delete
     * and a directory's removal.
     *
     * @type {Map<string, number>}
     */
    const recorded = new Map();
    /** @param {string} path */
    const keyOf = path=>path.toLowerCase();
    /** @param {string} path */
    const setBy = path=>{
        const attributes = recorded.get(keyOf(path));
        return attributes === undefined ? {} : { attributes };
    };
    /**
     * Moves what was recorded under one name, and under every name below it,
     * to another; with no destination, forgets it.
     *
     * @param {string} from @param {string | null} to
     */
    const carry = (from, to)=>{
        const key = keyOf(from);
        for (const [name, attributes] of [...recorded])
        {
            if (name !== key && !name.startsWith(`${key}\\`))
            {
                continue;
            }
            recorded.delete(name);
            if (to !== null)
            {
                recorded.set(keyOf(to) + name.slice(key.length), attributes);
            }
        }
    };

    /**
     * The watches FindFirstChangeNotification set, each a directory, whether
     * the names below its own children count, the FILE_NOTIFY_CHANGE_ kinds
     * it asked for, what to tell, and whether anyone still holds it.
     *
     * @type {Set<{ directory: string, subtree: boolean, filter: number,
     *     changed: () => void, alive: () => boolean }>}
     */
    const watches = new Set();

    /**
     * Where each open file is, so a write through it can be told to the
     * directory watching it. Kept only while something watches.
     *
     * @type {WeakMap<any, string>}
     */
    const openedAt = new WeakMap();

    /** @param {string} path  The volume's own spelling, folded, no trailing separator. */
    const canonical = path=>attempt(()=>fs.resolve(path).path, path)
        .replace(/\\+$/, '').toLowerCase();

    /**
     * A change to one name, told to every watch over the directory it is in
     * -- or over any directory above it, for a watch of the subtree -- whose
     * filter asks about it. Removing the watched directory itself is told
     * too, as Windows tells it. Nothing is worked out while nothing watches.
     *
     * One operation is one change, whatever names it touches: a rename is
     * told once to a watch that sees both its names.
     *
     * @param {string | string[]} paths @param {number} kind  FILE_NOTIFY_CHANGE_ flags.
     */
    const changed = (paths, kind)=>{
        if (watches.size === 0)
        {
            return;
        }
        const names = (Array.isArray(paths) ? paths : [paths]).map(canonical);
        for (const watch of [...watches])
        {
            if (!watch.alive())
            {
                watches.delete(watch);
                continue;
            }
            const within = names.some(name=>{
                const parent = name.slice(0, Math.max(name.lastIndexOf('\\'), 0));
                return parent === watch.directory
                    || (watch.subtree && parent.startsWith(`${watch.directory}\\`))
                    || (name === watch.directory && kind === CHANGE_DIR_NAME);
            });
            if (within && (watch.filter & kind) !== 0)
            {
                watch.changed();
            }
        }
    };

    return {
        /**
         * @param {string} path
         * @returns {{ exists: boolean, isDirectory: boolean, size: number,
         *             modified: number, readOnly?: boolean, hidden?: boolean,
         *             attributes?: number } | null}
         */
        stat(path){
            const entry = attempt(()=>fs.stat(path), null);
            return entry
                ? { exists: true, isDirectory: Boolean(entry.directory), size: entry.size,
                    modified: entry.modified ?? 0, ...marks(entry), ...setBy(path) }
                : null;
        },

        /**
         * Records the attributes a program set on a name, or forgets them
         * with `null`, which leaves the name as the volume reports it.
         *
         * @param {string} path @param {number | null} attributes
         * @returns {boolean} whether the name is there to carry them
         */
        setAttributes(path, attributes){
            if (!attempt(()=>fs.stat(path), null))
            {
                return false;
            }
            changed(path, CHANGE_ATTRIBUTES);
            if (attributes === null)
            {
                recorded.delete(keyOf(path));
            }
            else
            {
                recorded.set(keyOf(path), attributes >>> 0);
            }
            return true;
        },

        /**
         * @param {string} path
         * @param {number} modified  Milliseconds since the epoch.
         * @returns {boolean}
         */
        setModified(path, modified){
            return attempt(()=>{
                fs.setModified(path, modified);
                changed(path, CHANGE_LAST_WRITE);
                return true;
            }, false);
        },

        /**
         * @param {string} path
         * @param {any} mode
         * @returns {any} an open file, or null
         */
        open(path, mode){
            const existed = watches.size > 0 && (mode.create || mode.truncate)
                ? attempt(()=>fs.stat(path), null) !== null : null;
            const node = attempt(()=>fs.open(path, {
                read: mode.read !== false,
                write: Boolean(mode.write),
                shareWrite: mode.shareWrite === true,
                disposition: dispositionOf(mode),
                inherited: mode.inherited === true,
            }), null);
            if (node && watches.size > 0)
            {
                openedAt.set(node, path);
                if (existed === false)
                {
                    changed(path, CHANGE_FILE_NAME);
                }
                else if (existed && mode.truncate)
                {
                    changed(path, CHANGE_SIZE | CHANGE_LAST_WRITE);
                }
            }
            return node;
        },

        /**
         * The surface names the offset on every read, because a Win32 handle's
         * position is the surface's to move. Seeking first is how that maps
         * onto a handle that keeps its own.
         *
         * The answer is bytes when the data is here and a promise when it is
         * not. That is the whole of how an asynchronous fetch lives underneath
         * a synchronous guest call: the volume reports which blocks are absent
         * rather than awaiting anything, whoever is assembling the process
         * fetches them, and the guest thread is parked in the meantime by the
         * same machinery that parks it on any other call that cannot answer yet.
         *
         * @param {any} node @param {number} offset @param {number} length
         * @returns {Uint8Array | Promise<Uint8Array>}
         */
        read(node, offset, length){
            fs.seek(node, offset, SeekFrom.BEGIN);
            try
            {
                return fs.read(node, length);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS' || !fetchBlocks)
                {
                    throw miss;
                }
                return (async()=>{
                    await fetchBlocks(miss.blocks);
                    fs.seek(node, offset, SeekFrom.BEGIN);
                    // One retry, not a loop: the miss named every absent block,
                    // so a second miss means the fetch did not deliver and
                    // looping would only hide that.
                    return fs.read(node, length);
                })();
            }
        },

        /** @param {any} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            fs.seek(node, offset, SeekFrom.BEGIN);
            const written = fs.write(node, bytes);
            const path = watches.size > 0 ? openedAt.get(node) : undefined;
            if (path !== undefined && bytes.length > 0)
            {
                changed(path, CHANGE_SIZE | CHANGE_LAST_WRITE);
            }
            return written;
        },

        /**
         * write for a caller that can park: a write into a file the bundle
         * holds copies the file up first, and the copy needs the blocks under
         * it, so absent ones are fetched and the answer is a promise -- as read
         * answers.
         *
         * @param {any} node @param {number} offset @param {Uint8Array} bytes
         * @returns {number | Promise<number>}
         */
        writeOrFetch(node, offset, bytes){
            try
            {
                return this.write(node, offset, bytes);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS' || !fetchBlocks)
                {
                    throw miss;
                }
                // The guest's buffer may change while it is parked; what it
                // asked to write is what it passed at the call.
                const held = bytes.slice();
                // One retry, as read: the miss named every absent block.
                return fetchBlocks(miss.blocks).then(()=>this.write(node, offset, held));
            }
        },

        /** @param {any} node @param {number} size */
        truncate(node, size){
            fs.seek(node, size, SeekFrom.BEGIN);
            fs.setEndOfFile(node);
            const path = watches.size > 0 ? openedAt.get(node) : undefined;
            if (path !== undefined)
            {
                changed(path, CHANGE_SIZE | CHANGE_LAST_WRITE);
            }
        },

        /**
         * One more holder of an open node, given back by a `close` of its own.
         *
         * @param {any} node
         */
        retain(node){
            holds.set(node, (holds.get(node) ?? 0) + 1);
        },

        /**
         * Gives back one hold, and closes the node when it was the last.
         *
         * @param {any} node
         */
        close(node){
            const extra = holds.get(node) ?? 0;
            if (extra > 0)
            {
                holds.set(node, extra - 1);
                return;
            }
            fs.close(node);
        },

        /**
         * Removes a file or an empty directory; the surface above already knows
         * which of the two it asked for and reports accordingly.
         *
         * @param {string} path
         * @returns {boolean}
         */
        remove(path){
            const entry = attempt(()=>fs.stat(path), null);
            if (!entry)
            {
                return false;
            }
            return attempt(()=>{
                if (entry.directory)
                {
                    fs.removeDirectory(path);
                }
                else
                {
                    fs.deleteFile(path);
                }
                carry(path, null);
                changed(path, entry.directory ? CHANGE_DIR_NAME : CHANGE_FILE_NAME);
                return true;
            }, false);
        },

        /** @param {string} path @returns {boolean} */
        mkdir: path=>{
            const made = attempt(()=>fs.createDirectory(path), false);
            if (made !== false)
            {
                changed(path, CHANGE_DIR_NAME);
            }
            return made;
        },

        /** @param {string} from @param {string} to @returns {boolean} */
        rename: (from, to)=>attempt(()=>{
            fs.rename(from, to);
            carry(from, to);
            if (watches.size > 0)
            {
                const kind = attempt(()=>fs.stat(to), null)?.directory
                    ? CHANGE_DIR_NAME : CHANGE_FILE_NAME;
                changed([from, to], kind);
            }
            return true;
        }, false),

        /**
         * Tells `notify` when a name under a directory changes in a way
         * `filter` asks about, until the watch is closed or `alive` says
         * nobody holds it any more.
         *
         * @param {string} path @param {boolean} subtree @param {number} filter
         * @param {() => void} notify @param {() => boolean} alive
         * @returns {{ close: () => void }}
         */
        watch(path, subtree, filter, notify, alive){
            const watch = { directory: canonical(path), subtree, filter, changed: notify, alive };
            watches.add(watch);
            return { close: ()=>void watches.delete(watch) };
        },

        /**
         * @param {string} path @param {string} [pattern]
         * @returns {{ name: string, isDirectory: boolean, size: number }[]}
         */
        list: (path, pattern)=>attempt(
            ()=>fs.list(path, pattern).map((/** @type {any} */ entry)=>({
                name: entry.name,
                isDirectory: Boolean(entry.directory),
                size: entry.size,
                modified: entry.modified ?? 0,
                ...marks(entry),
                ...setBy(`${path.replace(/\\$/, '')}\\${entry.name}`),
            })), []),

        /**
         * Whether a path is on read-only media. Asked by the surface before a
         * change, so it can answer with the code a disc answers with; a path
         * on no drive at all is not, and fails however it fails.
         *
         * @param {string} path
         * @returns {boolean}
         */
        writeProtected: path=>attempt(
            ()=>fs.volume?.(fs.resolve(path).drive)?.readOnly === true, false),

        currentDirectory: ()=>fs.currentDirectory(),
        /** @param {string} path */
        setCurrentDirectory: path=>attempt(()=>{
            fs.setCurrentDirectory(path);
            return true;
        }, false),
    };
}
