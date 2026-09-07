/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A backing store that keeps its bytes in this process and nothing else.
 *
 * It exists twice over: as the writable layer of a build with no persistence,
 * and as the store every test in this layer runs against, so that the overlay
 * and the handle table are exercised without a browser anywhere near them.
 *
 * The store is deliberately dumb. It does not fold case, does not invent
 * directories, and knows nothing about drives or overlays -- a path is an
 * opaque key. Every Windows rule lives one level up, in the overlay, so that
 * there is exactly one place where those rules can be wrong.
 */

import { ErrorCode, fsError } from './errors.js';

/**
 * @typedef {Object} StoredStat
 * @property {boolean} directory
 * @property {number} size
 */

/**
 * @typedef {Object} StoredEntry
 * @property {string} path        Backslash-separated, relative to the mount root.
 * @property {boolean} directory
 * @property {number} size
 */

/**
 * A read-only backing store. `list` is called once, when a drive is mounted:
 * the overlay indexes it and does not ask again, so a store that changes behind
 * the overlay's back is out of contract.
 *
 * @typedef {Object} SourceStore
 * @property {() => StoredEntry[]} list
 * @property {(path: string) => StoredStat | null} stat
 * @property {(path: string, offset: number, length: number) => Uint8Array} read
 */

/**
 * A writable backing store. `write` past the end of a file extends it, filling
 * the gap with zeroes, because that is what a guest seeking past EOF and
 * writing expects to find afterwards.
 *
 * The overlay guarantees that the parent directory of anything it writes has
 * been created first, so a store never has to invent one.
 *
 * @typedef {Object} WritableStoreMethods
 * @property {(path: string, offset: number, bytes: Uint8Array) => void} write
 * @property {(path: string, size: number) => void} truncate
 * @property {(path: string) => void} remove
 * @property {(path: string) => void} mkdir
 */

/** @typedef {SourceStore & WritableStoreMethods} WritableStore */

const EMPTY = new Uint8Array(0);

/** @param {string} path */
function parentOf(path){
    const cut = path.lastIndexOf('\\');
    return cut < 0 ? '' : path.slice(0, cut);
}

/**
 * @param {string | Uint8Array} content
 * @returns {Uint8Array}
 */
function toBytes(content){
    return typeof content === 'string'
        ? Uint8Array.from([...content].map(character=>character.charCodeAt(0) & 0xff))
        : Uint8Array.from(content);
}

/**
 * Builds a store, optionally seeded.
 *
 * A seed maps a path to its contents; `null` seeds a directory. Parent
 * directories implied by a seeded path are created, since spelling every one of
 * them out in a fixture teaches nothing about the code under test.
 *
 * @param {Record<string, string | Uint8Array | null>} [seed]
 * @returns {WritableStore}
 */
export function createMemoryStore(seed = {}){
    /** @type {Map<string, { directory: boolean, data: Uint8Array }>} */
    const entries = new Map();

    /** @param {string} path */
    const makeDirectory = path=>{
        if (path.length === 0 || entries.has(path))
        {
            return;
        }
        makeDirectory(parentOf(path));
        entries.set(path, { directory: true, data: EMPTY });
    };

    /** @param {string} path */
    const requireParent = path=>{
        const parent = parentOf(path);
        if (parent.length > 0 && !entries.get(parent)?.directory)
        {
            throw fsError(ErrorCode.PATH_NOT_FOUND, `No directory "${parent}" to hold "${path}"`);
        }
    };

    /** @param {string} path @returns {{ directory: boolean, data: Uint8Array }} */
    const file = path=>{
        const entry = entries.get(path);
        if (entry && entry.directory)
        {
            throw fsError(ErrorCode.IS_A_DIRECTORY, `"${path}" is a directory`);
        }
        if (entry)
        {
            return entry;
        }
        requireParent(path);
        const created = { directory: false, data: EMPTY };
        entries.set(path, created);
        return created;
    };

    for (const [path, content] of Object.entries(seed))
    {
        makeDirectory(parentOf(path));
        if (content === null)
        {
            makeDirectory(path);
            continue;
        }
        entries.set(path, { directory: false, data: toBytes(content) });
    }

    return {
        list(){
            return [...entries.entries()].map(([path, entry])=>({
                path,
                directory: entry.directory,
                size: entry.data.length,
            }));
        },

        /** @param {string} path */
        stat(path){
            const entry = entries.get(path);
            return entry ? { directory: entry.directory, size: entry.data.length } : null;
        },

        /**
         * A read that starts past the end returns nothing rather than failing:
         * end of file is a length, not an error.
         *
         * @param {string} path @param {number} offset @param {number} length
         */
        read(path, offset, length){
            const entry = entries.get(path);
            if (!entry || entry.directory)
            {
                throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" to read`);
            }
            const start = Math.min(Math.max(offset, 0), entry.data.length);
            const end = Math.min(start + Math.max(length, 0), entry.data.length);
            return entry.data.slice(start, end);
        },

        /** @param {string} path @param {number} offset @param {Uint8Array} bytes */
        write(path, offset, bytes){
            if (offset < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, `Negative offset writing "${path}"`);
            }
            const entry = file(path);
            const end = offset + bytes.length;
            if (end > entry.data.length)
            {
                const grown = new Uint8Array(end);
                grown.set(entry.data);
                entry.data = grown;
            }
            entry.data.set(bytes, offset);
        },

        /** @param {string} path @param {number} size */
        truncate(path, size){
            if (size < 0)
            {
                throw fsError(ErrorCode.INVALID_PARAMETER, `Negative size for "${path}"`);
            }
            const entry = file(path);
            const resized = new Uint8Array(size);
            resized.set(entry.data.subarray(0, Math.min(size, entry.data.length)));
            entry.data = resized;
        },

        /** @param {string} path */
        remove(path){
            if (!entries.delete(path))
            {
                throw fsError(ErrorCode.NOT_FOUND, `Nothing at "${path}" to remove`);
            }
        },

        /** @param {string} path */
        mkdir(path){
            if (entries.has(path))
            {
                throw fsError(ErrorCode.ALREADY_EXISTS, `"${path}" already exists`);
            }
            requireParent(path);
            entries.set(path, { directory: true, data: EMPTY });
        },
    };
}
