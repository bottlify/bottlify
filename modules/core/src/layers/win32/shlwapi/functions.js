/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi — the path helpers, and the colour-space pair a colour picker uses.
 *
 * Pure string functions over the caller's own buffer. Two of them answer with
 * a pointer into that buffer rather than a copy, so what is returned is an
 * address computed from where the text was read, never the text itself.
 */

import { encodeAnsi } from '../kernel32/locale.js';

/** As long as a path a program hands these may be, terminator included. */
const MAX_LENGTH = 0x1000;

/** What PathCombine may produce, terminator included. */
const MAX_PATH = 260;

const FILE_ATTRIBUTE_DIRECTORY = 0x10;

/**
 * Hue, luminance and saturation each run from 0 to 240 here, against 255 for
 * a colour channel. A grey has no hue and is given two thirds of the way
 * round, which is what the colour dialog shows for one.
 */
const HLSMAX = 240;
const RGBMAX = 255;
const HUE_UNDEFINED = HLSMAX * 2 / 3;

/** @param {string} c */
const isSeparator = c=>c === '\\' || c === '/';

/**
 * @typedef {Object} ShlwapiHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} [readWideString]
 *           Reads a UTF-16 argument. Absent in a build that cannot, and the
 *           W spellings then fail as they would for an argument they could
 *           not read.
 * @property {{ stat(path: string): { exists: boolean, isDirectory: boolean } | null }} [files]
 *           The volume, for the functions that ask what a path names. Absent,
 *           every path names nothing.
 * @property {(path: string) => string} [fullPath]
 *           A path made absolute against the current directory, as the file
 *           functions make it.
 */

/**
 * The root a path starts with -- a drive and its backslash, a UNC server and
 * share, or a lone backslash -- or nothing. A forward slash is not a
 * separator to PathCombine and its canonicalisation, only to the finders.
 *
 * @param {string} path
 */
const rootOf = path=>(/^[A-Za-z]:\\/.exec(path)
    ?? /^\\\\[^\\]+\\[^\\]+\\?/.exec(path)
    ?? /^\\/.exec(path))?.[0] ?? '';

/**
 * A path with its `.` components dropped and each `..` taking the component
 * before it, never the root; an empty path is the root of the current drive,
 * a lone backslash.
 *
 * @param {string} path
 */
const canonical = path=>{
    if (path === '')
    {
        return '\\';
    }
    const root = rootOf(path);
    /** @type {string[]} */
    const kept = [];
    for (const part of path.slice(root.length).split('\\'))
    {
        if (part === '..')
        {
            kept.pop();
        }
        else if (part !== '.')
        {
            kept.push(part);
        }
    }
    return root + kept.join('\\');
};

/**
 * PathCombine's answer, or null when there is none: both parts missing, or a
 * result that would not fit MAX_PATH. A file with a drive or a share of its
 * own stands alone, one that starts with a backslash starts at the
 * directory's root, and anything else goes under the directory.
 *
 * @param {string | null} directory @param {string | null} file
 * @returns {string | null}
 */
const combine = (directory, file)=>{
    if (directory === null && file === null)
    {
        return null;
    }
    let joined;
    if (file === null || file === '')
    {
        joined = directory ?? '';
    }
    else if (/^[A-Za-z]:/.test(file) || file.startsWith('\\\\'))
    {
        joined = file;
    }
    else if (file.startsWith('\\'))
    {
        joined = directory ? rootOf(directory) + file.slice(1) : file;
    }
    else if (!directory)
    {
        joined = file;
    }
    else
    {
        joined = directory.endsWith('\\') ? directory + file : `${directory}\\${file}`;
    }
    const result = joined.length < MAX_PATH ? canonical(joined) : null;
    return result !== null && result.length < MAX_PATH ? result : null;
};

/**
 * A DOS wildcard match of a whole string, without regard to case: `*` any run
 * of characters, `?` any one.
 *
 * @param {string} text @param {string} mask
 */
const wildcard = (text, mask)=>{
    const t = text.toLowerCase();
    const m = mask.toLowerCase();
    let ti = 0;
    let mi = 0;
    let star = -1;
    let resume = 0;
    while (ti < t.length)
    {
        if (mi < m.length && (m[mi] === '?' || m[mi] === t[ti]))
        {
            ti++;
            mi++;
        }
        else if (mi < m.length && m[mi] === '*')
        {
            star = mi++;
            resume = ti;
        }
        else if (star >= 0)
        {
            mi = star + 1;
            ti = ++resume;
        }
        else
        {
            return false;
        }
    }
    while (m[mi] === '*')
    {
        mi++;
    }
    return mi === m.length;
};

/**
 * PathMatchSpec: the whole path against each mask of a `;`-separated list,
 * leading spaces of each mask skipped and trailing ones kept. `*.*` is every
 * file, a name without a dot included, as in a directory search.
 *
 * @param {string} path @param {string} spec
 */
const matchesSpec = (path, spec)=>spec.split(';').some(item=>{
    const mask = item.replace(/^ +/, '');
    return mask === '*.*' || wildcard(path, mask);
});

/**
 * A component of a colour on the 0..240 scale from the two values that
 * bracket it and where its hue falls, in HLSMAX units.
 *
 * @param {number} low @param {number} high @param {number} hue
 */
const hueToChannel = (low, high, hue)=>{
    const at = hue < 0 ? hue + HLSMAX : hue > HLSMAX ? hue - HLSMAX : hue;
    if (at < HLSMAX / 6)
    {
        return low + Math.trunc(((high - low) * at + HLSMAX / 12) / (HLSMAX / 6));
    }
    if (at < HLSMAX / 2)
    {
        return high;
    }
    if (at < HLSMAX * 2 / 3)
    {
        return low + Math.trunc(((high - low) * (HLSMAX * 2 / 3 - at) + HLSMAX / 12)
            / (HLSMAX / 6));
    }
    return low;
};

/**
 * @param {ShlwapiHost} host
 */
export function createShlwapiFunctions(host){
    /** @param {number} address */
    const pathAt = address=>
        (address >>> 0) === 0 ? null : host.readCString(address >>> 0, MAX_LENGTH);

    /** @param {number} address */
    const widePathAt = address=>((address >>> 0) === 0 || !host.readWideString
        ? null : host.readWideString(address >>> 0, MAX_LENGTH));

    /** In the ANSI page a path is read in. @param {string} text */
    const narrow = text=>encodeAnsi(`${text}\0`);

    /** @param {string} text */
    const wide = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at * 2] = text.charCodeAt(at) & 0xff;
            bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
        }
        return bytes;
    };

    /**
     * PathCombine for either width. The destination may be one of the two
     * sources, so both are read before it is written; a failure leaves it
     * empty rather than as it was.
     *
     * @param {(address: number) => string | null} read
     * @param {(text: string) => Uint8Array} encode
     */
    const pathCombine = (read, encode)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([destination, directory, file])=>{
            if ((destination >>> 0) === 0)
            {
                return 0;
            }
            const result = combine(read(directory), read(file));
            host.writeMemory(destination >>> 0, encode(result ?? ''));
            return result === null ? 0 : destination >>> 0;
        },
    });

    /** @param {(address: number) => string | null} read */
    const pathMatchSpec = read=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([file, spec])=>{
            const path = read(file);
            const masks = read(spec);
            return path !== null && masks !== null && matchesSpec(path, masks) ? 1 : 0;
        },
    });

    /**
     * PathIsDirectory for either width: the directory attribute of what the
     * path names, which is what Windows answers with, or 0 for a file or for
     * nothing there.
     *
     * @param {(address: number) => string | null} read
     */
    const pathIsDirectory = read=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([pointer])=>{
            const path = read(pointer);
            if (!path || !host.files || !host.fullPath)
            {
                return 0;
            }
            const entry = host.files.stat(host.fullPath(path));
            return entry?.exists && entry.isDirectory ? FILE_ATTRIBUTE_DIRECTORY : 0;
        },
    });

    /** @param {number} address @param {number} value */
    const writeWord = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(address >>> 0, new Uint8Array([value & 0xff, value >>> 8 & 0xff]));
        }
    };

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

        /**
         * BOOL PathIsDirectoryA(LPCSTR pszPath)
         * BOOL PathIsDirectoryW(LPCWSTR pszPath)
         */
        PathIsDirectoryA: pathIsDirectory(pathAt),
        PathIsDirectoryW: pathIsDirectory(widePathAt),

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

        /**
         * LPSTR PathCombineA(LPSTR pszDest, LPCSTR pszDir, LPCSTR pszFile)
         * LPWSTR PathCombineW(LPWSTR, LPCWSTR, LPCWSTR)
         */
        PathCombineA: pathCombine(pathAt, narrow),
        PathCombineW: pathCombine(widePathAt, wide),

        /**
         * BOOL PathMatchSpecA(LPCSTR pszFile, LPCSTR pszSpec)
         * BOOL PathMatchSpecW(LPCWSTR, LPCWSTR)
         */
        PathMatchSpecA: pathMatchSpec(pathAt),
        PathMatchSpecW: pathMatchSpec(widePathAt),

        /**
         * void ColorRGBToHLS(COLORREF clrRGB, WORD *pwHue, WORD *pwLuminance,
         *                    WORD *pwSaturation)
         *
         * Integer arithmetic rounded at each step, so a colour taken apart and
         * put back together with ColorHLSToRGB lands within a step or two of
         * each channel it started from.
         */
        ColorRGBToHLS: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([rgb, hueOut, luminanceOut, saturationOut])=>{
                const red = rgb & 0xff;
                const green = rgb >>> 8 & 0xff;
                const blue = rgb >>> 16 & 0xff;
                const most = Math.max(red, green, blue);
                const least = Math.min(red, green, blue);
                const sum = most + least;
                const span = most - least;
                const luminance = Math.trunc((sum * HLSMAX + RGBMAX) / (2 * RGBMAX));
                let hue = HUE_UNDEFINED;
                let saturation = 0;
                if (span !== 0)
                {
                    saturation = luminance <= HLSMAX / 2
                        ? Math.trunc((span * HLSMAX + Math.trunc(sum / 2)) / sum)
                        : Math.trunc((span * HLSMAX + Math.trunc((2 * RGBMAX - sum) / 2))
                            / (2 * RGBMAX - sum));
                    /** @param {number} channel */
                    const delta = channel=>Math.trunc(((most - channel) * (HLSMAX / 6)
                        + Math.trunc(span / 2)) / span);
                    hue = red === most ? delta(blue) - delta(green)
                        : green === most ? HLSMAX / 3 + delta(red) - delta(blue)
                            : HLSMAX * 2 / 3 + delta(green) - delta(red);
                    hue = hue < 0 ? hue + HLSMAX : hue > HLSMAX ? hue - HLSMAX : hue;
                }
                writeWord(hueOut, hue);
                writeWord(luminanceOut, luminance);
                writeWord(saturationOut, saturation);
                return 0;
            },
        },

        /** COLORREF ColorHLSToRGB(WORD wHue, WORD wLuminance, WORD wSaturation) */
        ColorHLSToRGB: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hueArgument, luminanceArgument, saturationArgument])=>{
                const hue = hueArgument & 0xffff;
                const luminance = luminanceArgument & 0xffff;
                const saturation = saturationArgument & 0xffff;
                if (saturation === 0)
                {
                    const grey = Math.min(RGBMAX, Math.trunc(luminance * RGBMAX / HLSMAX));
                    return (grey | grey << 8 | grey << 16) >>> 0;
                }
                const high = luminance <= HLSMAX / 2
                    ? Math.trunc((luminance * (HLSMAX + saturation) + HLSMAX / 2) / HLSMAX)
                    : luminance + saturation
                        - Math.trunc((luminance * saturation + HLSMAX / 2) / HLSMAX);
                const low = 2 * luminance - high;
                /** @param {number} at */
                const channel = at=>Math.max(0, Math.min(RGBMAX,
                    Math.trunc((hueToChannel(low, high, at) * RGBMAX + HLSMAX / 2) / HLSMAX)));
                return (channel(hue + HLSMAX / 3) | channel(hue) << 8
                    | channel(hue - HLSMAX / 3) << 16) >>> 0;
            },
        },
    };
}
