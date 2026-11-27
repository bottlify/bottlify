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

/** How many times a read or write fetches blocks it fetched before and misses again before it fails (`fetchedAgain`). */
export const MISS_FETCHES = 4;
/**
 * Large reads kept whole in the run's cache (the `cache` layer's space
 * `reads`), by the file's identity, size and last write, once the same range
 * is read a second time: an engine maps its own executable, reads its tables
 * and unmaps it hundreds of times while it loads, and each map decoded every
 * bundle block of it again (a second a time for 111 MB). Only a second read
 * keeps: a setup extracting a cabinet reads it once, a mebibyte a batch, and
 * keeping each batch held a quarter of a gibibyte a process of bytes nothing
 * read again. The cache's budget bounds them and its idle time lets them go;
 * every process of the run reads what one of them kept.
 *
 * Up to this many bytes a range: the executable mapped whole again and again.
 */
const KEPT_READ_LARGEST = 128 << 20;
/** A read smaller than this costs less than keeping it. */
export const KEPT_READ_MIN = 1 << 20;
/** A range is kept in parts of this many bytes at most, each a body of the cache's. */
export const KEPT_PART_BYTES = 8 << 20;
/** How many large ranges read once are remembered, by key alone, to tell a second read. */
const SEEN_READS = 256;
/**
 * A last write younger than this is not trusted to tell versions apart: two
 * writes in one millisecond carry the same stamp.
 */
const SETTLED_MS = 2000;

/** A volume with no cache to keep reads in. @type {import('../../cache/module.js').CacheSpace} */
const KEEP_NOTHING = Object.freeze({
    look: ()=>null, with: ()=>undefined, put: ()=>false, drop: ()=>{},
});

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
const FILE_ACTION_ADDED = 1;
const FILE_ACTION_REMOVED = 2;
const FILE_ACTION_MODIFIED = 3;
const FILE_ACTION_RENAMED_OLD_NAME = 4;
const FILE_ACTION_RENAMED_NEW_NAME = 5;

/**
 * One change as a watch is told it: what happened, and to which name, from
 * the watched directory down, as the volume spells it.
 *
 * @typedef {{ action: number, name: string }} ChangeRecord
 */

/**
 * `then` on a value that may be a promise: a read that had its blocks
 * answers at once, one that fetches answers later.
 *
 * @template T, U
 * @param {T | Promise<T>} value @param {(arrived: T) => U} then
 * @returns {U | Promise<U>}
 */
const settled = (value, then)=>(typeof (/** @type {any} */ (value))?.then === 'function'
    ? /** @type {Promise<T>} */ (value).then(then)
    : then(/** @type {T} */ (value)));

/**
 * `readInto` for a volume that keeps nothing of its own: its `read`, the
 * bytes handed on whole.
 *
 * @param {(node: any, offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 * @returns {(node: any, offset: number, length: number,
 *     put: (bytes: Uint8Array, at: number) => void) => number | Promise<number>}
 */
export const readIntoBy = read=>(node, offset, length, put)=>
    settled(read(node, offset, length), bytes=>{
        put(bytes, 0);
        return bytes.length;
    });

/**
 * @param {any} fs  The filesystem layer's API.
 * @param {((blocks: any[]) => Promise<void>) | null} [fetchBlocks]
 *        Brings absent bundle blocks in. Absent itself when nothing is mounted
 *        from a bundle, in which case a miss is a fault rather than a wait.
 * @param {{ now?: () => number,
 *     kept?: import('../../cache/module.js').CacheSpace }} [options]
 *        `now`: the clock a last write is aged against, in milliseconds
 *        (`Date.now`); `kept`: where ranges read again are kept (none: never)
 */
export function createVolume(fs, fetchBlocks = null, { now = Date.now, kept = KEEP_NOTHING } = {}){
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
     * The operation, its refusal's code kept as `refused` on the way out.
     *
     * @template T @param {() => T} operation @returns {T}
     */
    const refusing = operation=>{
        try
        {
            return operation();
        }
        catch (e){
            refused = /** @type {any} */ (e)?.code ?? null;
            throw e;
        }
    };

    /**
     * An operation done again after its miss: the blocks the miss named
     * fetched, then the operation again, and again fetched while it misses
     * blocks it never fetched, or up to `MISS_FETCHES` fetches of blocks it
     * had. A block fetched can be gone before the
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
        /** @param {any} block */
        const keyOf = block=>`${block.layer ?? 0}:${block.index}`;
        /** Every block this operation has fetched. */
        const fetched = new Set();
        // Counted only when the operation asks again for nothing but blocks
        // it had fetched: one that misses blocks it never asked for has gone
        // further - a copy up stops at each piece it lacks (`tree.js`) and
        // goes on from there - and would otherwise fail at its fifth piece.
        for (let fetches = 1; ;)
        {
            for (const block of miss.blocks)
            {
                fetched.add(keyOf(block));
            }
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
                if (again.blocks.every((/** @type {any} */ block)=>fetched.has(keyOf(block))))
                {
                    if (fetches >= MISS_FETCHES)
                    {
                        throw new Error(`${what}: ${again.blocks.length} blocks still absent`
                            + ` after ${fetches} fetches`, { cause: e });
                    }
                    fetches++;
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
        ...entry.reparseTag ? { reparseTag: entry.reparseTag } : {},
    });

    /**
     * A file with more than one name says how many and what it is known by;
     * one with its own alone says nothing of either.
     *
     * @param {any} entry
     * @returns {{ links?: number, identity?: string }}
     */
    const linked = entry=>(entry.links > 1 ? { links: entry.links, identity: entry.identity } : {});

    /**
     * The attributes a program set on the file, which the volume keeps for
     * every name it has; none recorded leaves it as the volume reports it.
     *
     * @param {any} entry
     */
    const setBy = entry=>(typeof entry.attributes === 'number'
        ? { attributes: entry.attributes } : {});

    /**
     * The watches FindFirstChangeNotification set, each a directory, whether
     * the names below its own children count, the FILE_NOTIFY_CHANGE_ kinds
     * it asked for, what to tell, and whether anyone still holds it.
     *
     * @type {Set<{ directory: string, subtree: boolean, filter: number,
     *     changed: (records: ChangeRecord[]) => void, alive: () => boolean }>}
     */
    const watches = new Set();

    /**
     * Why the last open, directory made or rename was refused - the
     * filesystem's code - for the surface to answer with: `refusal`.
     */
    /** @type {string | null} */
    let refused = null;

    /**
     * Where each open file is, so a write through it can be told to the
     * directory watching it. Kept only while something watches.
     *
     * @type {WeakMap<any, string>}
     */
    const openedAt = new WeakMap();

    /** The path each node was opened by, for its version. @type {WeakMap<any, string>} */
    const pathOf = new WeakMap();
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
    /** @param {string} key @param {number} part */
    const partOf = (key, part)=>`${key}#${part}`;
    /**
     * A range kept by any process of the run, handed to `put` part by part as
     * the cache holds it, read in place: true where every part was there. A
     * part missing after others were handed leaves those handed; the caller
     * reads the range afresh and hands the same bytes again.
     *
     * @param {string} key @param {number} length
     * @param {(bytes: Uint8Array, at: number) => void} put
     */
    const keptInto = (key, length, put)=>{
        if (kept.look(partOf(key, 0)) === null)
        {
            return false;
        }
        for (let at = 0, part = 0; at < length; at += KEPT_PART_BYTES, part++)
        {
            const want = Math.min(KEPT_PART_BYTES, length - at);
            const whole = kept.with(partOf(key, part), body=>{
                if (body.length !== want)
                {
                    return false;
                }
                put(body, at);
                return true;
            });
            if (whole !== true)
            {
                return false;
            }
        }
        return true;
    };
    /**
     * Keeps a read when its range was read before: a copy of it, in parts, in
     * the cache. A part the cache had no room for leaves the range unkept.
     *
     * @param {string | null} key @param {Uint8Array} bytes
     */
    const keep = (key, bytes)=>{
        if (key === null || bytes.length > KEPT_READ_LARGEST)
        {
            return;
        }
        if (!seen.delete(key))
        {
            seen.add(key);
            if (seen.size > SEEN_READS)
            {
                seen.delete(/** @type {string} */ (seen.values().next().value));
            }
            return;
        }
        for (let at = 0, part = 0; at < bytes.length; at += KEPT_PART_BYTES, part++)
        {
            if (!kept.put(partOf(key, part), bytes.subarray(at, at + KEPT_PART_BYTES)))
            {
                for (let earlier = 0; earlier < part; earlier++)
                {
                    kept.drop(partOf(key, earlier));
                }
                return;
            }
        }
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

    /**
     * What follows a name moved: the watches are told. Its attributes are the
     * volume's, and go with it there.
     *
     * @param {string} from @param {string} to
     */
    const moved = (from, to)=>{
        if (watches.size > 0)
        {
            const kind = attempt(()=>fs.stat(to), null)?.directory
                ? CHANGE_DIR_NAME : CHANGE_FILE_NAME;
            changed([from, to], kind,
                [FILE_ACTION_RENAMED_OLD_NAME, FILE_ACTION_RENAMED_NEW_NAME]);
        }
    };

    return {
        /**
         * @param {string} path
         * @returns {{ exists: boolean, isDirectory: boolean, size: number,
         *             modified: number, readOnly?: boolean, hidden?: boolean,
         *             attributes?: number, links?: number, identity?: string,
         *             junction?: string, reparseTag?: number } | null}
         */
        stat(path){
            const entry = attempt(()=>fs.stat(path), null);
            return entry
                ? { exists: true, isDirectory: Boolean(entry.directory), size: entry.size,
                    modified: entry.modified ?? 0, ...linked(entry), ...marks(entry),
                    ...setBy(entry) }
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
            return attempt(()=>{
                fs.setAttributes(path, attributes === null ? null : attributes >>> 0);
                return true;
            }, false);
        },

        /**
         * Sets a reparse point on the file or directory at `path`, or with
         * null takes it off: null when it did, or the volume's code for why
         * not. `target`, the place a mount point or a symbolic link names,
         * makes it stand for that place on its drive; `away` is set when that
         * place is on another drive, and the point stands for nothing here.
         *
         * @param {string} path
         * @param {{ tag: number, data: Uint8Array | null, target: string | null } | null} point
         * @returns {string | null | { away: true }}
         */
        setReparse(path, point){
            try
            {
                return fs.setReparse(path, point) === false ? { away: true } : null;
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

        /**
         * The reparse point at `path` as it was set, null for none.
         *
         * @param {string} path
         * @returns {{ tag: number, data: Uint8Array | null } | null}
         */
        reparseOf(path){
            return attempt(()=>fs.reparseOf?.(path) ?? null, null);
        },

        /**
         * Holds the directory at `path` open on `access` and `share`: its
         * number, or the volume's code for why not - SHARING_VIOLATION when
         * the opens already there do not allow it.
         *
         * @param {string} path
         * @param {{ read?: boolean, write?: boolean, delete?: boolean }} access
         * @param {{ read?: boolean, write?: boolean, delete?: boolean }} share
         * @returns {{ token: number } | { error: string }}
         */
        holdDirectory(path, access, share){
            try
            {
                return { token: fs.holdDirectory(path, access, share) };
            }
            catch (e){
                const error = /** @type {any} */ (e);
                if (!error?.code || !(error.code in ErrorCode))
                {
                    throw error;
                }
                return { error: error.code };
            }
        },

        /** @param {number} token */
        releaseDirectory(token){
            fs.releaseDirectory(token);
        },

        /**
         * The number of the file at `path` on its volume, the same under
         * every name and across renames: 0 for a path that names nothing.
         *
         * @param {string} path @returns {number}
         */
        fileId(path){
            return attempt(()=>fs.fileId(path), 0);
        },

        /**
         * The path `path` reaches as its volume spells it, every junction on
         * the way taken: itself where it names nothing.
         *
         * @param {string} path @returns {string}
         */
        finalPath(path){
            return attempt(()=>fs.finalPath(path), path);
        },

        /**
         * Where the file numbered `id` is on the volume `path` is on: null
         * for a number no file there has.
         *
         * @param {string} path @param {number} id @returns {string | null}
         */
        pathOfFileId(path, id){
            return attempt(()=>fs.pathOfFileId(path, id), null);
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
         * Why the last `open`, `mkdir` or rename was refused: the volume's code
         * -- NOT_FOUND, SHARING_VIOLATION, INVALID_PATH and the rest -- or null
         * when it was made.
         *
         * @returns {string | null}
         */
        refusal: ()=>refused,


        /**
         * @param {string} path
         * @param {any} mode
         * @returns {any} an open file, or null
         */
        open(path, mode){
            const existed = watches.size > 0 && (mode.create || mode.truncate)
                ? attempt(()=>fs.stat(path), null) !== null : null;
            refused = null;
            const node = attempt(()=>refusing(()=>fs.open(path, {
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
            })), null);
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
         * The bytes are the caller's own: whoever reads may write into them or
         * keep them. A caller that only copies them on, into guest memory
         * above all, reads with `readInto` and is handed what the run's cache
         * holds where it lies.
         *
         * @param {any} node @param {number} offset @param {number} length
         * @returns {Uint8Array | Promise<Uint8Array>}
         */
        read(node, offset, length){
            const key = keptKey(node, offset, length);
            if (key !== null)
            {
                const out = new Uint8Array(length);
                if (keptInto(key, length, (bytes, at)=>out.set(bytes, at)))
                {
                    return out;
                }
            }
            return settled(this.readFresh(node, offset, length), arrived=>{
                keep(key, arrived);
                return arrived;
            });
        },

        /**
         * read, the bytes handed to `put` (with where in the range they go)
         * rather than answered: what the run's cache keeps is read in place,
         * valid only inside `put`, so its one copy is the caller's own (into
         * guest memory). Answers how many bytes the range had.
         *
         * @param {any} node @param {number} offset @param {number} length
         * @param {(bytes: Uint8Array, at: number) => void} put
         * @returns {number | Promise<number>}
         */
        readInto(node, offset, length, put){
            const key = keptKey(node, offset, length);
            if (key !== null && keptInto(key, length, put))
            {
                return length;
            }
            if (key === null)
            {
                // Nothing to keep: the volume hands its bytes where they lie.
                fs.seek(node, offset, SeekFrom.BEGIN);
                try
                {
                    return fs.readInto(node, length, put);
                }
                catch (e){
                    if (/** @type {any} */ (e)?.code !== 'BLOCK_MISS' || !fetchBlocks)
                    {
                        throw e;
                    }
                    // What was handed before the miss is handed again whole
                    // once the blocks are here.
                }
            }
            return settled(this.readFresh(node, offset, length), arrived=>{
                keep(key, arrived);
                put(arrived, 0);
                return arrived.length;
            });
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

        /**
         * truncate for a caller that can park: a file the bundle holds is
         * copied up first, as for a write, and absent blocks under it are
         * fetched; the answer is then a promise.
         *
         * @param {any} node @param {number} size
         * @returns {void | Promise<void>}
         */
        truncateOrFetch(node, size){
            try
            {
                return this.truncate(node, size);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS' || !fetchBlocks)
                {
                    throw miss;
                }
                return fetchedAgain(()=>this.truncate(node, size), miss,
                    `the end at ${size} not set`);
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
            refused = null;
            const made = attempt(()=>refusing(()=>fs.createDirectory(path)), false);
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
         * them here. A directory's move stopped part way goes on from there:
         * what it moved is under its new name, which is not there to move to
         * again.
         *
         * @param {string} from @param {string} to
         * @param {{ held?: boolean }} [options]  `held`: through a handle that
         *     holds the file for deletion (the file system's `rename`)
         * @returns {boolean | Promise<boolean>}
         */
        renameOrFetch(from, to, options = {}){
            const existed = attempt(()=>fs.stat(to), null) !== null;
            try
            {
                return this.rename(from, to, options);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS' || !fetchBlocks)
                {
                    throw miss;
                }
                if (!existed && attempt(()=>fs.stat(to), null)?.directory)
                {
                    return fetchBlocks(miss.blocks).then(()=>this.moveRest(from, to))
                        .then(done=>{
                            if (done)
                            {
                                moved(from, to);
                            }
                            return done;
                        });
                }
                if (!existed)
                {
                    attempt(()=>fs.deleteFile(to), null);
                }
                return fetchBlocks(miss.blocks).then(()=>this.renameOrFetch(from, to, options));
            }
        },

        /**
         * What is left of a directory's move a miss stopped, moved into the
         * directory it was going to: everything under `to` is the move's own,
         * so a file at both names is a copy the miss cut short.
         *
         * @param {string} from @param {string} to
         * @returns {Promise<boolean>}
         */
        async moveRest(from, to){
            for (const child of attempt(()=>fs.list(from), []))
            {
                const leaving = `${from}\\${child.name}`;
                const arriving = `${to}\\${child.name}`;
                const there = attempt(()=>fs.stat(arriving), null);
                if (child.directory && there?.directory)
                {
                    if (!await this.moveRest(leaving, arriving))
                    {
                        return false;
                    }
                    continue;
                }
                if (there)
                {
                    attempt(()=>fs.deleteFile(arriving), null);
                }
                if (!await this.renameOrFetch(leaving, arriving))
                {
                    return false;
                }
            }
            return attempt(()=>{
                fs.removeDirectory(from);
                return true;
            }, false);
        },

        /**
         * @param {string} from @param {string} to
         * @param {{ held?: boolean }} [options]  as `renameOrFetch`'s
         * @returns {boolean}
         */
        rename: (from, to, options = {})=>{
            refused = null;
            return attempt(()=>{
                refusing(()=>fs.rename(from, to, options));
                moved(from, to);
                return true;
            }, false);
        },

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
                ...setBy(entry),
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
