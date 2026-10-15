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
 * A guest read is synchronous: when a program calls `ReadFile` the emulator is
 * mid-instruction and wants bytes now, so `read` cannot return a promise. It
 * therefore serves only blocks that are already here, and reports the ones that
 * are not by throwing a miss that names them. The caller above fetches those and
 * calls again. That is the whole trick by which an asynchronous fetch lives
 * above a synchronous read -- the alternative, parking the guest thread on every
 * read of every cached block, is a different engine.
 *
 * Decompression is injected. In the engine the deflate path is the platform's
 * own and the zstd path is the decoder already inside the emulator; neither is
 * this layer's business, and importing a compressor here would add the one thing
 * this package does not have.
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
 * Hands back the stored (still compressed) bytes of one block, or `null` when
 * they are not here yet. Offset and length are passed so a provider reading a
 * file at an offset needs no index of its own.
 *
 * @typedef {(index: number, offset: number, packed: number) => Uint8Array | null} ReadBlock
 */

/**
 * How many decoded blocks to keep. A guest reads the same block many times over
 * -- a structure, then the record after it -- and decoding it again each time is
 * the cost this avoids.
 */
const DEFAULT_CACHE_BLOCKS = 16;

/**
 * How many of those are blocks the program has read a second time.
 *
 * A program that consults a structure and then streams the file past it does
 * both through one cache, and the scan evicts the structure between two looks
 * at it: the block is decoded, every other block pushed through evicts it, and
 * the next look pays for the decode of the whole block again -- which for a
 * packed block is the decompression of everything it holds. A block read twice
 * has been asked for deliberately, so it is kept in a tier of its own, where a
 * scan through the other tier cannot reach it and the next thousand looks are a
 * map lookup.
 */
const DEFAULT_HOT_BLOCKS = 8;

/** The path separator, named so it is not confused with an escape. */
const SEPARATOR = String.fromCharCode(92);

/**
 * @param {Object} options
 * @param {import('./format.js').Bundle} options.bundle
 * @param {ReadBlock} options.readBlock
 * @param {import('./format.js').Decode} options.decode
 * @param {number} [options.cacheBlocks]
 * @param {number} [options.hotBlocks]
 *        Blocks kept because they were read more than once, out of reach of a
 *        scan through the rest.
 * @param {string} [options.prefix]
 *        A directory the whole bundle appears under, without separators at
 *        either end. A game belongs in a directory of its own rather than at
 *        the root of the volume: a program works out where its data lives from
 *        where it is itself, and a bundle mounted at the root makes every
 *        answer to that question -- right or wrong -- happen to work.
 * @param {Record<string, string>} [options.relocate]
 *        Directories of the bundle that appear somewhere other than under
 *        `prefix`, by their path in the bundle: what a bottle carries for
 *        `C:\WINDOWS\system32` lies in the bundle beside its registry, and is
 *        found where Windows keeps it. No separators at either end of either.
 * @returns {import('../memory-store.js').SourceStore}
 */
export function createBundleSource({
    bundle, readBlock, decode, cacheBlocks = DEFAULT_CACHE_BLOCKS,
    hotBlocks = DEFAULT_HOT_BLOCKS, prefix = '', relocate = {},
})
{
    /** @type {import('../memory-store.js').StoredEntry[]} */
    const entries = [];
    /** @type {Map<string, import('./format.js').BundleFile>} */
    const byPath = new Map();

    const under = prefix === '' ? '' : prefix + SEPARATOR;
    const moved = Object.entries(relocate).map(([from, to])=>({ from: foldName(from), to }));
    /** @param {string} path */
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
        return `${under}${path}`;
    };

    for (const file of bundle.files)
    {
        byPath.set(foldName(outward(file.path)), file);
        entries.push({ path: outward(file.path), directory: false, size: file.size });
    }
    // A directory only appears here when it is empty: every other one is implied
    // by the paths under it, and the overlay puts those back on its own.
    /** @type {Set<string>} */
    const directories = new Set(bundle.directories.map(path=>foldName(outward(path))));
    for (const path of bundle.directories)
    {
        entries.push({ path: outward(path), directory: true, size: 0 });
    }
    // The prefix's own components are directories nothing else declares: they
    // hold the bundle rather than coming from it. So are a relocated
    // directory's.
    for (const holder of [prefix, ...moved.map(({ to })=>to)])
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

    /** @type {Map<number, Uint8Array>} Decoded blocks, oldest use first. */
    const cache = new Map();
    /**
     * Decoded blocks the program has read a second time, oldest use first. Kept
     * apart from the scan tier so that a structure read between two passes of a
     * scan is not evicted by the scan and decoded again.
     *
     * @type {Map<number, Uint8Array>}
     */
    const hot = new Map();

    /** @param {Map<number, Uint8Array>} tier @param {number} bound */
    const trim = (tier, bound)=>{
        while (tier.size > bound)
        {
            tier.delete(/** @type {number} */ (tier.keys().next().value));
        }
    };

    /** @param {number} index */
    const cached = index=>{
        const hit = cache.get(index);
        if (hit === undefined)
        {
            const kept = hot.get(index);
            if (kept !== undefined)
            {
                hot.delete(index);
                hot.set(index, kept);
            }
            return kept ?? null;
        }
        // Read twice: this is a block the program keeps coming back to, and the
        // tier a scan cannot evict is where it belongs from now on.
        cache.delete(index);
        hot.set(index, hit);
        trim(hot, hotBlocks);
        return hit;
    };

    /** @param {number} index @param {Uint8Array} bytes */
    const remember = (index, bytes)=>{
        cache.set(index, bytes);
        trim(cache, cacheBlocks);
    };

    return {
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
         * Serves a read from resident blocks, or throws a miss naming the ones
         * that would make it serviceable. Whatever could be decoded on the way
         * stays cached, so the retry after a fetch costs only the fetched
         * blocks.
         *
         * @param {string} path @param {number} offset @param {number} length
         * @returns {Uint8Array}
         */
        read(path, offset, length){
            const file = byPath.get(foldName(path));
            if (!file)
            {
                throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" in this bundle`);
            }

            const ranges = bundle.rangesFor(file, offset, length);
            /** @type {(Uint8Array | null)[]} */
            const decoded = [];
            /** @type {MissingBlock[]} */
            const missing = [];

            for (const range of ranges)
            {
                const { block } = range;
                const hit = cached(block.index);
                if (hit)
                {
                    decoded.push(hit);
                    continue;
                }
                const stored = readBlock(block.index, block.offset, block.packed);
                if (!stored)
                {
                    missing.push({
                        index: block.index, offset: block.offset, packed: block.packed,
                    });
                    decoded.push(null);
                    continue;
                }
                const bytes = decode(block.codec, stored, block.length);
                if (bytes.length !== block.length)
                {
                    // Not an fsError: nothing the guest asked for is wrong, the
                    // bundle or the decoder is, and a short block would
                    // otherwise be handed out as zeroes.
                    throw new Error(`Block ${block.index} of this bundle decoded to `
                        + `${bytes.length} bytes, not ${block.length}`);
                }
                remember(block.index, bytes);
                decoded.push(bytes);
            }

            if (missing.length > 0)
            {
                const miss = /** @type {BlockMissError} */ (new Error(
                    `${missing.length} block(s) of "${path}" are not resident yet`));
                miss.code = BLOCK_MISS;
                miss.blocks = missing;
                throw miss;
            }

            let total = 0;
            for (const range of ranges)
            {
                total += range.to - range.from;
            }
            // Copied rather than handed out as a view: the cache keeps the
            // decoded block, and whoever gets these bytes may write to them.
            const out = new Uint8Array(total);
            let at = 0;
            ranges.forEach((range, position)=>{
                const bytes = /** @type {Uint8Array} */ (decoded[position]);
                out.set(bytes.subarray(range.from, range.to), at);
                at += range.to - range.from;
            });
            return out;
        },
    };
}
