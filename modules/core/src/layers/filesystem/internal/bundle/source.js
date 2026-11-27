/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A bundle, as the read-only source of the overlay.
 *
 * Two constraints shape all of it.
 *
 * A guest read is synchronous: when a program calls `ReadFile` the engine is
 * mid-instruction and wants bytes now, so `read` cannot return a promise. It
 * therefore serves only blocks that are already here, and reports the ones that
 * are not by throwing a miss that names them. The caller above fetches those and
 * calls again. That is the whole trick by which an asynchronous fetch lives
 * above a synchronous read -- the alternative, parking the guest thread on every
 * read of every cached block, is a different engine.
 *
 * Nothing is decoded here. A block is kept decoded (`cache.js`) by whoever
 * fetched it, where waiting is allowed -- the platform's inflate answers with a
 * promise -- and a block decoded once is read in place by every read after.
 */

import { ErrorCode, fsError } from '../errors.js';
import { foldName } from '../paths.js';

/**
 * The code on the error `read` throws when it cannot be served.
 *
 * Deliberately not one of `ErrorCode`: it is not a failure of the operation but
 * a request for bytes, and a caller that treats it as one has a bug rather than
 * an error to report to the guest.
 */
export const BLOCK_MISS = 'BLOCK_MISS';

/**
 * @typedef {Object} MissingBlock
 * @property {number} index    Position in the container's block array.
 * @property {number} offset   Where its stored bytes start in the container.
 * @property {number} packed   How many stored bytes to fetch.
 */

/**
 * Thrown by `read`; `blocks` are exactly the ones that were not resident, in
 * ascending order, so one round trip satisfies the retry.
 *
 * @typedef {Error & { code: string, blocks: MissingBlock[] }} BlockMissError
 */

/**
 * Where a bundle's blocks are kept decoded (`cache.js`).
 *
 * @typedef {Object} KeptBlocks
 * @property {<T>(index: number, read: (body: Uint8Array) => T) => T | undefined} with
 *     the block read in place inside `read`, brought back from the disk first
 *     where it went there; undefined where it is not here
 */

/** The path separator, named so it is not confused with an escape. */
const SEPARATOR = String.fromCharCode(92);

/**
 * @param {Object} options
 * @param {import('./format.js').Bundle} options.bundle
 * @param {KeptBlocks} options.blocks  Its blocks, decoded, as they are here.
 * @param {string | null} [options.prefix]
 *        A directory the whole bundle appears under, without separators at
 *        either end. A game belongs in a directory of its own rather than at
 *        the root of the volume: a program works out where its data lives from
 *        where it is itself, and a bundle mounted at the root makes every
 *        answer to that question -- right or wrong -- happen to work. `null`:
 *        nowhere, only what `relocate` places appears (a layer, which has no
 *        program directory), and `unplaced` counts the files left out.
 * @param {Record<string, string>} [options.relocate]
 *        Directories of the bundle that appear somewhere other than under
 *        `prefix`, by their path in the bundle: what a bottle carries for
 *        `C:\WINDOWS\system32` lies in the bundle beside its registry, and is
 *        found where Windows keeps it. No separators at either end of either.
 * @returns {import('../memory-store.js').SourceStore & { unplaced: number,
 *     readInto: NonNullable<import('../memory-store.js').SourceStore['readInto']> }}
 */
export function createBundleSource({
    bundle, blocks, prefix = '', relocate = {},
})
{
    /** @type {import('../memory-store.js').StoredEntry[]} */
    const entries = [];
    /** @type {Map<string, import('./format.js').BundleFile>} */
    const byPath = new Map();

    const under = prefix === '' || prefix === null ? '' : prefix + SEPARATOR;
    const moved = Object.entries(relocate).map(([from, to])=>({ from: foldName(from), to }));
    /** @param {string} path @returns {string | null} */
    const outward = path=>{
        const folded = foldName(path);
        for (const { from, to } of moved)
        {
            if (folded === from)
            {
                return to;
            }
            if (folded.startsWith(from + SEPARATOR))
            {
                // An empty `to` is the volume's root, which takes no separator.
                return to === '' ? path.slice(from.length + 1) : `${to}${path.slice(from.length)}`;
            }
        }
        return prefix === null ? null : `${under}${path}`;
    };

    let unplaced = 0;
    for (const file of bundle.files)
    {
        const path = outward(file.path);
        if (path === null)
        {
            unplaced++;
            continue;
        }
        byPath.set(foldName(path), file);
        entries.push({ path, directory: false, size: file.size });
    }
    // A directory only appears here when it is empty: every other one is implied
    // by the paths under it, and the overlay puts those back on its own.
    /** @type {Set<string>} */
    const directories = new Set();
    for (const path of bundle.directories.map(outward))
    {
        if (path !== null)
        {
            directories.add(foldName(path));
            entries.push({ path, directory: true, size: 0 });
        }
    }
    // The prefix's own components are directories nothing else declares: they
    // hold the bundle rather than coming from it. So are a relocated
    // directory's.
    for (const holder of [prefix ?? '', ...moved.map(({ to })=>to)])
    {
        const parts = holder.split(SEPARATOR).filter(Boolean);
        for (const part of parts.map((_, at)=>parts.slice(0, at + 1).join(SEPARATOR)))
        {
            if (!directories.has(foldName(part)))
            {
                directories.add(foldName(part));
                entries.push({ path: part, directory: true, size: 0 });
            }
        }
    }

    const source = {
        unplaced,

        list: ()=>entries.map(entry=>({ ...entry })),

        /** @param {string} path */
        stat(path){
            const file = byPath.get(foldName(path));
            if (file)
            {
                return { directory: false, size: file.size };
            }
            return directories.has(foldName(path)) ? { directory: true, size: 0 } : null;
        },

        /**
         * Serves a read from resident blocks, each block's part handed to
         * `put` where it lies (a kept block inside its `with`), or throws a
         * miss naming the blocks that would make it serviceable once every
         * part here was handed: a retry after the fetch hands them all again.
         *
         * @param {string} path @param {number} offset @param {number} length
         * @param {import('../memory-store.js').Put} put
         * @returns {number}
         */
        readInto(path, offset, length, put){
            const file = byPath.get(foldName(path));
            if (!file)
            {
                throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" in this bundle`);
            }
            /** @type {MissingBlock[]} */
            const missing = [];
            let at = 0;
            for (const range of bundle.rangesFor(file, offset, length))
            {
                const { block } = range;
                const into = at;
                at += range.to - range.from;
                if (blocks.with(block.index, body=>{
                    put(body.subarray(range.from, range.to), into);
                    return true;
                }) !== true)
                {
                    missing.push({
                        index: block.index, offset: block.offset, packed: block.packed,
                    });
                }
            }

            if (missing.length > 0)
            {
                const miss = /** @type {BlockMissError} */ (new Error(
                    `${missing.length} block(s) of "${path}" are not resident yet`));
                miss.code = BLOCK_MISS;
                miss.blocks = missing;
                throw miss;
            }
            return at;
        },

        /**
         * readInto, copied out: whoever gets these bytes may keep or write
         * them, and a kept block is valid only inside its `with`.
         *
         * @param {string} path @param {number} offset @param {number} length
         * @returns {Uint8Array}
         */
        read(path, offset, length){
            const file = byPath.get(foldName(path));
            let total = 0;
            for (const range of file ? bundle.rangesFor(file, offset, length) : [])
            {
                total += range.to - range.from;
            }
            const out = new Uint8Array(total);
            source.readInto(path, offset, length, (bytes, into)=>out.set(bytes, into));
            return out;
        },
    };
    return source;
}
