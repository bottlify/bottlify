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
                return true;
            }, false);
        },

        /**
         * @param {string} path
         * @param {any} mode
         * @returns {any} an open file, or null
         */
        open(path, mode){
            return attempt(()=>fs.open(path, {
                read: mode.read !== false,
                write: Boolean(mode.write),
                shareWrite: mode.shareWrite === true,
                disposition: dispositionOf(mode),
            }), null);
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
            return fs.write(node, bytes);
        },

        /** @param {any} node @param {number} size */
        truncate(node, size){
            fs.seek(node, size, SeekFrom.BEGIN);
            fs.setEndOfFile(node);
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
                return true;
            }, false);
        },

        /** @param {string} path @returns {boolean} */
        mkdir: path=>attempt(()=>fs.createDirectory(path), false),

        /** @param {string} from @param {string} to @returns {boolean} */
        rename: (from, to)=>attempt(()=>{
            fs.rename(from, to);
            carry(from, to);
            return true;
        }, false),

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
