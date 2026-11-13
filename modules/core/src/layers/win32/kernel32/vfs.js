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
/**
 * The most of one read fetched at once: a small share of the smallest place
 * blocks are kept (64 MiB in the heap), with room for the window a miss
 * brings in around it.
 */
export const FETCHED_PIECE_BYTES = 8 << 20;

/** How many times a read or write fetches the blocks it misses before it fails (`fetchedAgain`). */
export const MISS_FETCHES = 4;
/**
 * Large reads kept whole, by the file's identity, size and last write, once
 * the same range is read a second time: an engine maps its own executable,
 * reads its tables and unmaps it hundreds of times while it loads, and each
 * map decoded every bundle block of it again (a second a time for 111 MB).
 * Only a second read keeps: a setup extracting a cabinet reads it once, a
 * mebibyte a batch, and keeping each batch held a quarter of a gibibyte a
 * process of bytes nothing read again. Ranges read again share this pool,
 * the least recently read let go first.
 */
export const KEPT_READ_BYTES = 32 << 20;
/**
 * One range read again larger than the pool is kept alone, everything else let
 * go for it, up to this: the executable mapped whole again and again.
 */
export const KEPT_READ_LARGEST = 128 << 20;
/** A read smaller than this costs less than keeping it. */
export const KEPT_READ_MIN = 1 << 20;
/**
 * A kept range not read again for this long is let go at the next read: what
 * was read twice at a start and never after holds nothing for the rest of
 * the run.
 */
export const KEPT_IDLE_MS = 30000;
/** How many large ranges read once are remembered, by key alone, to tell a second read. */
const SEEN_READS = 256;
/**
 * A last write younger than this is not trusted to tell versions apart: two
 * writes in one millisecond carry the same stamp.
 */
const SETTLED_MS = 2000;

const CHANGE_FILE_NAME = 0x001;
const CHANGE_DIR_NAME = 0x002;
const CHANGE_ATTRIBUTES = 0x004;
const CHANGE_SIZE = 0x008;
const CHANGE_LAST_WRITE = 0x010;

/**
 * The FILE_ACTION_ a change to one name is, as ReadDirectoryChangesW reports
 * it. A rename is its old name and its new one; seen from a watch that holds
 * only one of the two, it is a name removed or a name added.
 */
export const FILE_ACTION_ADDED = 1;
export const FILE_ACTION_REMOVED = 2;
export const FILE_ACTION_MODIFIED = 3;
export const FILE_ACTION_RENAMED_OLD_NAME = 4;
export const FILE_ACTION_RENAMED_NEW_NAME = 5;

/**
 * One change as a watch is told it: what happened, and to which name, from
 * the watched directory down, as the volume spells it.
 *
 * @typedef {{ action: number, name: string }} ChangeRecord
 */

/**
 * @param {any} fs  The filesystem layer's API.
 * @param {((blocks: any[]) => Promise<void>) | null} [fetchBlocks]
 *        Brings absent bundle blocks in. Absent itself when nothing is mounted
 *        from a bundle, in which case a miss is a fault rather than a wait.
 * @param {{ now?: () => number }} [options]  `now`: the clock reads are kept
 *        by and a last write is aged against, in milliseconds (`Date.now`).
 */
export function createVolume(fs, fetchBlocks = null, { now = Date.now } = {}){
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
     * An operation done again after its miss: the blocks the miss named
     * fetched, then the operation again, and again fetched while it misses,
     * up to `MISS_FETCHES` fetches. A block fetched can be gone before the
     * operation comes back for it: a cache in the heap keeps 64 MiB and
     * another thread's reads landing between the fetch and the retry push the
     * oldest blocks out, and a read that waited on another read's request
     * finds nothing when that request failed. Each fetch makes the blocks the
     * newest the cache holds, so a second rarely misses; one that misses
     * every time is a fetch that does not deliver, and the operation fails
     * saying so.
     *
     * @template T
     * @param {() => T} operation
     * @param {{ blocks: any[] }} miss
     * @param {string} what  For the failure: what was not done.
     * @returns {Promise<T>}
     */
    const fetchedAgain = async(operation, miss, what)=>{
        const fetch = /** @type {(blocks: any[]) => Promise<void>} */ (fetchBlocks);
        for (let fetches = 1; ; fetches++)
        {
            await fetch(miss.blocks);
            try
            {
                return operation();
            }
            catch (e){
                const again = /** @type {any} */ (e);
                if (again?.code !== 'BLOCK_MISS')
                {
                    throw again;
                }
                if (fetches >= MISS_FETCHES)
                {
                    throw new Error(`${what}: ${again.blocks.length} blocks still absent`
                        + ` after ${fetches} fetches`, { cause: e });
                }
                miss = again;
            }
        }
    };

    /**
     * @param {any} node @param {number} offset @param {number} length
     * @param {{ blocks: any[] }} miss
     * @returns {Promise<Uint8Array>}
     */
    const fetchedRead = (node, offset, length, miss)=>fetchedAgain(()=>{
        fs.seek(node, offset, SeekFrom.BEGIN);
        return fs.read(node, length);
    }, miss, `${length} bytes at ${offset} not read`);

    /**
     * A read too large to fetch whole, fetched and copied a piece at a time.
     *
     * The blocks a read needs must all be resident when it copies them, and
     * where they are kept in the heap (no origin store) that keeps 64 MiB: a
     * program mapping a 241 MiB archive whole fetched every block, found the
     * first ones evicted by the last and was told the map failed. A piece
     * holds a fraction of that bound, so its fetch cannot evict itself; each
     * piece is fetched as a read is (`fetchedRead`).
     *
     * @param {any} node @param {number} offset @param {number} length
     * @returns {Promise<Uint8Array>}
     */
    const readInPieces = async(node, offset, length)=>{
        /** @type {Uint8Array[]} */
        const pieces = [];
        let total = 0;
        while (total < length)
        {
            const wanted = Math.min(FETCHED_PIECE_BYTES, length - total);
            fs.seek(node, offset + total, SeekFrom.BEGIN);
            let piece;
            try
            {
                piece = fs.read(node, wanted);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS')
                {
                    throw miss;
                }
                piece = await fetchedRead(node, offset + total, wanted, miss);
            }
            pieces.push(piece);
            total += piece.length;
            if (piece.length < wanted)
            {
                break;
            }
        }
        if (pieces.length === 1)
        {
            return pieces[0];
        }
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const piece of pieces)
        {
            bytes.set(piece, at);
            at += piece.length;
        }
        return bytes;
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
        ...entry.junction ? { junction: entry.junction } : {},
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
    /**
     * A file with more than one name says how many and what it is known by;
     * one with its own alone says nothing of either.
     *
     * @param {any} entry
     * @returns {{ links?: number, identity?: string }}
     */
    const linked = entry=>(entry.links > 1 ? { links: entry.links, identity: entry.identity } : {});

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
     *     changed: (records: ChangeRecord[]) => void, alive: () => boolean }>}
     */
    const watches = new Set();

    /** Why the last open was refused, for the surface to answer with: `openRefusal`. */
    /** @type {string | null} */
    let refusedOpen = null;

    /**
     * Where each open file is, so a write through it can be told to the
     * directory watching it. Kept only while something watches.
     *
     * @type {WeakMap<any, string>}
     */
    const openedAt = new WeakMap();

    /** The path each node was opened by, for its version. @type {WeakMap<any, string>} */
    const pathOf = new WeakMap();
    /**
     * Kept reads, the least recently read first, each with when it was read
     * last. @type {Map<string, { bytes: Uint8Array, at: number }>}
     */
    const kept = new Map();
    let keptBytes = 0;
    /** Large ranges read once, by key: a second read of one keeps it. @type {Set<string>} */
    const seen = new Set();
    /**
     * The key a read of a node is kept under, or null when it is not to be:
     * a small read, an unknown file, or one written moments ago.
     *
     * @param {any} node @param {number} offset @param {number} length
     */
    const keptKey = (node, offset, length)=>{
        const path = length >= KEPT_READ_MIN ? pathOf.get(node) : undefined;
        const entry = path === undefined ? null : attempt(()=>fs.stat(path), null);
        return entry && !entry.directory && now() - (entry.modified ?? 0) > SETTLED_MS
            ? `${entry.identity ?? entry.path}|${entry.size}|${entry.modified}|${offset}|${length}`
            : null;
    };
    /** @param {string} key */
    const letGo = key=>{
        keptBytes -= /** @type {{ bytes: Uint8Array }} */ (kept.get(key)).bytes.length;
        kept.delete(key);
    };
    /** Lets go of what was not read again for `KEPT_IDLE_MS`. @param {number} time */
    const expire = time=>{
        for (const [key, held] of kept)
        {
            if (time - held.at <= KEPT_IDLE_MS)
            {
                break;
            }
            letGo(key);
        }
    };
    /**
     * Keeps a read when its range was read before, and answers whether it
     * did: what is kept is handed out only as a copy, or as it is to a
     * caller that only copies out of it.
     *
     * @param {string | null} key @param {Uint8Array} bytes
     */
    const keep = (key, bytes)=>{
        if (key === null || bytes.length > KEPT_READ_LARGEST)
        {
            return false;
        }
        if (!seen.delete(key))
        {
            seen.add(key);
            if (seen.size > SEEN_READS)
            {
                seen.delete(/** @type {string} */ (seen.values().next().value));
            }
            return false;
        }
        kept.set(key, { bytes, at: now() });
        keptBytes += bytes.length;
        // A range past the pool is kept alone.
        const limit = Math.max(KEPT_READ_BYTES, bytes.length);
        for (const oldest of kept.keys())
        {
            if (keptBytes <= limit || oldest === key)
            {
                break;
            }
            letGo(oldest);
        }
        return true;
    };

    /** @param {string} path  The volume's own spelling, no trailing separator. */
    const spelled = path=>attempt(()=>fs.resolve(path).path, path).replace(/\\+$/, '');
    /** @param {string} path  The volume's own spelling, folded, no trailing separator. */
    const canonical = path=>spelled(path).toLowerCase();

    /**
     * A change to one name, told to every watch over the directory it is in
     * -- or over any directory above it, for a watch of the subtree -- whose
     * filter asks about it. Removing the watched directory itself is told
     * too, as Windows tells it. Nothing is worked out while nothing watches.
     *
     * One operation is one telling, whatever names it touches: a rename is
     * told once to a watch that sees both its names, as the records of
     * both. The watched directory's own removal is told with no record;
     * its rename is not told.
     *
     * @param {string | string[]} paths @param {number} kind  FILE_NOTIFY_CHANGE_ flags.
     * @param {number | number[]} actions  FILE_ACTION_ of each path.
     */
    const changed = (paths, kind, actions)=>{
        if (watches.size === 0)
        {
            return;
        }
        const given = Array.isArray(paths) ? paths : [paths];
        const names = given.map(spelled);
        const acts = Array.isArray(actions) ? actions : given.map(()=>actions);
        for (const watch of [...watches])
        {
            if (!watch.alive())
            {
                watches.delete(watch);
                continue;
            }
            if ((watch.filter & kind) === 0)
            {
                continue;
            }
            // Its removal is told; its move is not, as Windows does neither
            // more nor less.
            const self = names.some((name, index)=>name.toLowerCase() === watch.directory
                && kind === CHANGE_DIR_NAME && acts[index] === FILE_ACTION_REMOVED);
            /** @type {ChangeRecord[]} */
            const records = [];
            names.forEach((name, index)=>{
                const folded = name.toLowerCase();
                const parent = folded.slice(0, Math.max(folded.lastIndexOf('\\'), 0));
                if (parent === watch.directory
                    || (watch.subtree && parent.startsWith(`${watch.directory}\\`)))
                {
                    records.push({ action: acts[index],
                        name: name.slice(watch.directory.length + 1) });
                }
            });
            if (records.length === 1 && acts.length === 2)
            {
                // Half a rename: the name left the watch, or came into it.
                records[0].action = records[0].action === FILE_ACTION_RENAMED_OLD_NAME
                    ? FILE_ACTION_REMOVED : FILE_ACTION_ADDED;
            }
            if (records.length > 0 || self)
            {
                watch.changed(records);
            }
        }
    };

    return {
        /**
         * @param {string} path
         * @returns {{ exists: boolean, isDirectory: boolean, size: number,
         *             modified: number, readOnly?: boolean, hidden?: boolean,
         *             attributes?: number, links?: number, identity?: string,
         *             junction?: string } | null}
         */
        stat(path){
            const entry = attempt(()=>fs.stat(path), null);
            return entry
                ? { exists: true, isDirectory: Boolean(entry.directory), size: entry.size,
                    modified: entry.modified ?? 0, ...linked(entry), ...marks(entry),
                    ...setBy(path) }
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
            changed(path, CHANGE_ATTRIBUTES, FILE_ACTION_MODIFIED);
            // The attributes are the file's: every name it has shows them.
            for (const name of attempt(()=>fs.namesOf?.(path), null) ?? [path])
            {
                if (attributes === null)
                {
                    recorded.delete(keyOf(name));
                }
                else
                {
                    recorded.set(keyOf(name), attributes >>> 0);
                }
            }
            return true;
        },

        /**
         * Makes the empty directory at `path` a junction standing for the
         * directory `target` on its drive, or with null a directory again:
         * null when it did, or the volume's code for why not.
         *
         * @param {string} path @param {string | null} target
         * @returns {string | null}
         */
        setJunction(path, target){
            try
            {
                fs.setJunction(path, target);
            }
            catch (e){
                const error = /** @type {any} */ (e);
                if (!error?.code || !(error.code in ErrorCode))
                {
                    throw error;
                }
                return error.code;
            }
            return null;
        },

        /**
         * Gives the file at `existing` the further name `path`: null when it
         * did, or the volume's code for why not -- NOT_SAME_DEVICE across
         * drives, ACCESS_DENIED for a directory, ALREADY_EXISTS for a name
         * taken, NOT_FOUND or PATH_NOT_FOUND for what is not there. The new
         * name shows the attributes the file was given.
         *
         * @param {string} path @param {string} existing
         * @returns {string | null}
         */
        link(path, existing){
            try
            {
                fs.link(path, existing);
            }
            catch (e){
                const error = /** @type {any} */ (e);
                if (!error?.code || !(error.code in ErrorCode))
                {
                    throw error;
                }
                return error.code;
            }
            const attributes = recorded.get(keyOf(existing));
            if (attributes !== undefined)
            {
                recorded.set(keyOf(path), attributes);
            }
            changed(path, CHANGE_FILE_NAME, FILE_ACTION_ADDED);
            return null;
        },

        /**
         * @param {string} path
         * @param {number} modified  Milliseconds since the epoch.
         * @returns {boolean}
         */
        setModified(path, modified){
            return attempt(()=>{
                fs.setModified(path, modified);
                changed(path, CHANGE_LAST_WRITE, FILE_ACTION_MODIFIED);
                return true;
            }, false);
        },

        /**
         * Why the last `open` answered null: the volume's code -- NOT_FOUND,
         * SHARING_VIOLATION and the rest -- or null when it opened.
         *
         * @returns {string | null}
         */
        openRefusal: ()=>refusedOpen,

        /**
         * What the volume holds of the tab's heaps (`memory-zones.js`): the
         * ranges kept for a read again.
         *
         * @returns {{ keptReads: number }}
         */
        held: ()=>({ keptReads: keptBytes }),

        /**
         * @param {string} path
         * @param {any} mode
         * @returns {any} an open file, or null
         */
        open(path, mode){
            const existed = watches.size > 0 && (mode.create || mode.truncate)
                ? attempt(()=>fs.stat(path), null) !== null : null;
            refusedOpen = null;
            const node = attempt(()=>{
                try
                {
                    return fs.open(path, {
                        read: mode.read !== false,
                        write: Boolean(mode.write),
                        shareRead: mode.shareRead !== false,
                        shareWrite: mode.shareWrite === true,
                        delete: mode.delete === true,
                        // Only CreateFile says how it shares deletion; a layer's own
                        // reader (an installer's database, a library a DLL loads) does
                        // not stand in the way of the program deleting the file.
                        shareDelete: mode.shareDelete !== false,
                        disposition: dispositionOf(mode),
                        inherited: mode.inherited === true,
                    });
                }
                catch (e){
                    refusedOpen = /** @type {any} */ (e)?.code ?? null;
                    throw e;
                }
            }, null);
            if (node)
            {
                pathOf.set(node, path);
            }
            if (node && watches.size > 0)
            {
                openedAt.set(node, path);
                if (existed === false)
                {
                    changed(path, CHANGE_FILE_NAME, FILE_ACTION_ADDED);
                }
                else if (existed && mode.truncate)
                {
                    changed(path, CHANGE_SIZE | CHANGE_LAST_WRITE, FILE_ACTION_MODIFIED);
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
         * @param {boolean} [onlyCopied]  the caller copies the bytes out and
         *        never writes into them, so kept ones come as they are
         * @returns {Uint8Array | Promise<Uint8Array>}
         */
        read(node, offset, length, onlyCopied = false){
            const time = now();
            if (kept.size > 0)
            {
                expire(time);
            }
            const key = keptKey(node, offset, length);
            const held = key === null ? undefined : kept.get(key);
            if (held)
            {
                kept.delete(/** @type {string} */ (key));
                held.at = time;
                kept.set(/** @type {string} */ (key), held);
                return onlyCopied ? held.bytes : held.bytes.slice();
            }
            const bytes = this.readFresh(node, offset, length);
            // Copied out when kept: whoever reads may write into what it got.
            /** @param {Uint8Array} arrived */
            const kept_ = arrived=>(keep(key, arrived) && !onlyCopied ? arrived.slice() : arrived);
            return typeof (/** @type {any} */ (bytes))?.then === 'function'
                ? /** @type {Promise<Uint8Array>} */ (bytes).then(kept_)
                : kept_(/** @type {Uint8Array} */ (bytes));
        },

        /**
         * read, past what is kept.
         *
         * @param {any} node @param {number} offset @param {number} length
         * @returns {Uint8Array | Promise<Uint8Array>}
         */
        readFresh(node, offset, length){
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
                if (length <= FETCHED_PIECE_BYTES)
                {
                    return fetchedRead(node, offset, length, miss);
                }
                return readInPieces(node, offset, length);
            }
        },

        /** @param {any} node @param {number} offset @param {Uint8Array} bytes */
        write(node, offset, bytes){
            fs.seek(node, offset, SeekFrom.BEGIN);
            const written = fs.write(node, bytes);
            const path = watches.size > 0 ? openedAt.get(node) : undefined;
            if (path !== undefined && bytes.length > 0)
            {
                changed(path, CHANGE_SIZE | CHANGE_LAST_WRITE, FILE_ACTION_MODIFIED);
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
                return fetchedAgain(()=>this.write(node, offset, held), miss,
                    `${held.length} bytes at ${offset} not written`);
            }
        },

        /** @param {any} node @param {number} size */
        truncate(node, size){
            fs.seek(node, size, SeekFrom.BEGIN);
            fs.setEndOfFile(node);
            const path = watches.size > 0 ? openedAt.get(node) : undefined;
            if (path !== undefined)
            {
                changed(path, CHANGE_SIZE | CHANGE_LAST_WRITE, FILE_ACTION_MODIFIED);
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
                changed(path, entry.directory ? CHANGE_DIR_NAME : CHANGE_FILE_NAME,
                    FILE_ACTION_REMOVED);
                return true;
            }, false);
        },

        /**
         * Why the file at `path` may not be renamed or deleted as its opens
         * stand -- SHARING_VIOLATION, an open that does not share deletion --
         * or null when it may.
         *
         * @param {string} path
         * @returns {string | null}
         */
        removalRefused(path){
            try
            {
                fs.mayRemove?.(path);
                return null;
            }
            catch (e){
                const error = /** @type {any} */ (e);
                if (!error?.code || !(error.code in ErrorCode))
                {
                    throw error;
                }
                return error.code;
            }
        },

        /** @param {string} path @returns {boolean} whether any process holds the file open */
        isOpen: path=>attempt(()=>fs.isOpen?.(path) ?? false, false),

        /**
         * The device a path names wherever it is -- `nul`, `C:\\dir\\NUL.txt` --
         * in upper case, or null.
         *
         * @param {string} path @returns {string | null}
         */
        deviceOf: path=>attempt(()=>fs.resolve?.(path)?.device ?? null, null),

        /**
         * How a section maps the file, or null.
         *
         * @param {string} path @returns {'readonly' | 'readwrite' | 'image' | null}
         */
        mappedAs: path=>attempt(()=>fs.mappedAs?.(path) ?? null, null),

        /**
         * A section's own hold on the file `node` has open, on the section's
         * terms: what the section keeps once the file's handle is closed.
         * Null where the volume cannot give one.
         *
         * @param {any} node @param {'readonly' | 'readwrite' | 'image'} kind
         */
        section: (node, kind)=>{
            const held = attempt(()=>fs.reopenSection?.(node, kind) ?? null, null);
            const path = pathOf.get(node);
            if (held && path !== undefined)
            {
                pathOf.set(held, path);
            }
            return held;
        },

        /** @param {string} path @returns {boolean} */
        mkdir: path=>{
            const made = attempt(()=>fs.createDirectory(path), false);
            if (made !== false)
            {
                changed(path, CHANGE_DIR_NAME, FILE_ACTION_ADDED);
            }
            return made;
        },

        /**
         * rename for a caller that can park: a move from the bundle to the
         * overlay copies the file, and the copy needs every block under it.
         * When one is absent the copy stops at it, so what was copied is
         * removed, the blocks are fetched and the move is done again -- as
         * many times as it meets blocks not here yet, each time with more of
         * them here.
         *
         * @param {string} from @param {string} to
         * @returns {boolean | Promise<boolean>}
         */
        renameOrFetch(from, to){
            const existed = attempt(()=>fs.stat(to), null) !== null;
            try
            {
                return this.rename(from, to);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS' || !fetchBlocks)
                {
                    throw miss;
                }
                if (!existed)
                {
                    attempt(()=>fs.deleteFile(to), null);
                }
                return fetchBlocks(miss.blocks).then(()=>this.renameOrFetch(from, to));
            }
        },

        /** @param {string} from @param {string} to @returns {boolean} */
        rename: (from, to)=>attempt(()=>{
            fs.rename(from, to);
            carry(from, to);
            if (watches.size > 0)
            {
                const kind = attempt(()=>fs.stat(to), null)?.directory
                    ? CHANGE_DIR_NAME : CHANGE_FILE_NAME;
                changed([from, to], kind,
                    [FILE_ACTION_RENAMED_OLD_NAME, FILE_ACTION_RENAMED_NEW_NAME]);
            }
            return true;
        }, false),

        /**
         * Tells `notify` when a name under a directory changes in a way
         * `filter` asks about, until the watch is closed or `alive` says
         * nobody holds it any more.
         *
         * @param {string} path @param {boolean} subtree @param {number} filter
         * @param {(records: ChangeRecord[]) => void} notify @param {() => boolean} alive
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
                ...linked(entry),
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
