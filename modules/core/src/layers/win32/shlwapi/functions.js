/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi — the path helpers.
 *
 * Pure string functions over the caller's own buffer. Two of them answer with
 * a pointer into that buffer rather than a copy, so what is returned is an
 * address computed from where the text was read, never the text itself.
 */

/** As long as a path a program hands these may be, terminator included. */
const MAX_LENGTH = 0x1000;

/** @param {string} c */
const isSeparator = c=>c === '\\' || c === '/';

/**
 * @typedef {Object} ShlwapiHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {ShlwapiHost} host
 */
export function createShlwapiFunctions(host){
    /** @param {number} address */
    const pathAt = address=>
        (address >>> 0) === 0 ? null : host.readCString(address >>> 0, MAX_LENGTH);

    return {
        /**
         * LPSTR PathFindExtensionA(LPCSTR pszPath)
         *
         * The last dot of the last component, or the terminator when there is
         * none: a dot in a directory's name is not an extension of the file
         * inside it.
         */
        PathFindExtensionA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = pathAt(pointer);
                if (path === null)
                {
                    return 0;
                }
                let dot = path.length;
                for (let at = 0; at < path.length; at++)
                {
                    if (path[at] === '.')
                    {
                        dot = at;
                    }
                    else if (isSeparator(path[at]) || path[at] === ':')
                    {
                        dot = path.length;
                    }
                }
                return (pointer >>> 0) + dot;
            },
        },

        /**
         * LPSTR PathFindFileNameA(LPCSTR pszPath)
         *
         * What follows the last separator that has something after it, so a
         * path ending in a separator names its last directory, slash and all.
         */
        PathFindFileNameA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = pathAt(pointer);
                if (path === null)
                {
                    return 0;
                }
                let start = 0;
                for (let at = 0; at + 1 < path.length; at++)
                {
                    if (isSeparator(path[at]) || path[at] === ':')
                    {
                        start = at + 1;
                    }
                }
                return (pointer >>> 0) + start;
            },
        },

        /**
         * BOOL PathStripToRootA(LPSTR pszPath)
         *
         * Cuts the path down to its root in place: a drive with its backslash,
         * or a UNC server and share. A path with no root is cut to nothing and
         * refused, which is what removing one component at a time until only a
         * root is left does when there was never a root to reach.
         */
        PathStripToRootA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = pathAt(pointer);
                if (path === null)
                {
                    return 0;
                }
                const root = /^[A-Za-z]:[\\/]?/.exec(path)
                    ?? /^[\\/]{2}[^\\/]+(?:[\\/][^\\/]+)?/.exec(path)
                    ?? /^[\\/]/.exec(path);
                const keep = root ? root[0].length : 0;
                if (keep < path.length)
                {
                    host.writeMemory((pointer >>> 0) + keep, new Uint8Array([0]));
                }
                return root ? 1 : 0;
            },
        },

        /** BOOL PathIsUNCA(LPCSTR pszPath) */
        PathIsUNCA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = pathAt(pointer);
                return path !== null && path.length > 1
                    && isSeparator(path[0]) && isSeparator(path[1]) ? 1 : 0;
            },
        },
    };
}
