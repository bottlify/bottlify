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
import { createForwards } from './forwards.js';

/** As long as a path a program hands these may be, terminator included. */
const MAX_LENGTH = 0x1000;

/** What PathCombine may produce, terminator included. */
const MAX_PATH = 260;

const FILE_ATTRIBUTE_DIRECTORY = 0x10;

const ERROR_SUCCESS = 0;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_KEY_HAS_CHILDREN = 1020;
const KEY_READ = 0x20019;

const S_OK = 0;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const URL_UNESCAPE_INPLACE = 0x00100000;
const URL_DONT_UNESCAPE_EXTRA_INFO = 0x02000000;

/**
 * Where a path's extension begins: the last dot of its last component, or the
 * end of the path when that component has none -- a dot in a directory's name
 * is not an extension of the file inside it.
 *
 * @param {string} path
 */
const extensionIndex = path=>{
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
    return dot;
};

/**
 * A URL with its %XX escapes decoded; with `extraInfo` false, what follows the
 * first ? or # is left as it is.
 *
 * @param {string} url @param {boolean} extraInfo
 */
const unescapeUrl = (url, extraInfo)=>{
    let out = '';
    let escaping = true;
    for (let at = 0; at < url.length; at++)
    {
        const char = url[at];
        if (!extraInfo && (char === '?' || char === '#'))
        {
            escaping = false;
        }
        if (escaping && char === '%' && /^[0-9A-Fa-f]{2}$/.test(url.slice(at + 1, at + 3)))
        {
            out += String.fromCharCode(parseInt(url.slice(at + 1, at + 3), 16));
            at += 2;
            continue;
        }
        out += char;
    }
    return out;
};

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

/** StrToIntEx and StrToInt64Ex read a 0x number only when asked. */
const STIF_SUPPORT_HEX = 0x1;

/**
 * The number a string starts with, as StrToIntEx and StrToInt64Ex read it:
 * spaces, tabs and line feeds skipped -- no other white space, and no
 * no-break space -- then one sign and decimal digits, or with STIF_SUPPORT_HEX
 * a 0x and hexadecimal digits, which take no sign. Only ASCII digits count,
 * whatever other scripts call a digit. As 64 bits, a longer number wrapping;
 * null when no digit is where one has to be.
 *
 * @param {string} text @param {number} flags
 * @returns {bigint | null}
 */
const leadingInteger = (text, flags)=>{
    let at = 0;
    while (text[at] === ' ' || text[at] === '\t' || text[at] === '\n')
    {
        at++;
    }
    const negative = text[at] === '-';
    if (negative || text[at] === '+')
    {
        at++;
    }
    if ((flags & STIF_SUPPORT_HEX) !== 0 && text[at] === '0'
        && (text[at + 1] === 'x' || text[at + 1] === 'X'))
    {
        const hex = /^[0-9A-Fa-f]+/.exec(text.slice(at + 2));
        return hex ? BigInt.asIntN(64, BigInt(`0x${hex[0]}`)) : null;
    }
    const digits = /^[0-9]+/.exec(text.slice(at));
    if (!digits)
    {
        return null;
    }
    const magnitude = BigInt(digits[0]);
    return BigInt.asIntN(64, negative ? -magnitude : magnitude);
};

/**
 * DllGetVersion's answer for a library of the given version. The caller says
 * which structure it passed by its first field -- DLLVERSIONINFO, 20 bytes, or
 * DLLVERSIONINFO2, 32, which adds flags and the whole version as one 64-bit
 * number -- and any other size is an invalid argument, as is no structure.
 *
 * @param {{ readMemory?: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void }} memory
 * @param {number} info
 * @param {[number, number, number, number]} version  major, minor, build, QFE
 * @returns {number} an HRESULT
 */
export function answerDllVersion(memory, info, [major, minor, build, qfe]){
    if (info === 0 || !memory.readMemory)
    {
        return E_INVALIDARG;
    }
    const head = memory.readMemory(info, 4);
    const size = (head[0] | head[1] << 8 | head[2] << 16 | head[3] << 24) >>> 0;
    if (size !== 20 && size !== 32)
    {
        return E_INVALIDARG;
    }
    const DLLVER_PLATFORM_NT = 2;
    const fields = new DataView(new ArrayBuffer(size - 4));
    fields.setUint32(0, major, true);
    fields.setUint32(4, minor, true);
    fields.setUint32(8, build, true);
    fields.setUint32(12, DLLVER_PLATFORM_NT, true);
    if (size === 32)
    {
        fields.setUint32(20, (build << 16 | qfe) >>> 0, true);
        fields.setUint32(24, (major << 16 | minor) >>> 0, true);
    }
    memory.writeMemory(info + 4, new Uint8Array(fields.buffer));
    return S_OK;
}

/** The shlwapi of Windows XP Service Pack 3: 6.0.2900.5512, as its shell's. */
const SHLWAPI_VERSION = /** @type {[number, number, number, number]} */ ([6, 0, 2900, 5512]);

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
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           For the counts a caller passes by pointer.
 * @property {() => Record<string, { handler: (args: number[]) => any }>} [advapi32]
 *           advapi32's exports, for the registry helpers -- read when called, so
 *           an HKEY the program holds names the key it does there. Absent, those
 *           helpers answer ERROR_CALL_NOT_IMPLEMENTED.
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 *           Guest memory for the handle and counts a helper asks advapi32 for.
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     [library]  Another library's exports, for the exports that are only another library's
 *           function under a number (`forwards.js`). Absent, those are not bound.
 * @property {(api: string, detail: string) => void} [divergence]
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

    /**
     * PathFindExtension for either width: the last dot of the last
     * component, or the terminator when there is none -- a dot in a
     * directory's name is not an extension of the file inside it. `unit` is
     * the bytes a character takes, which is how far the answer moves.
     *
     * @param {(address: number) => string | null} read @param {number} unit
     */
    const pathFindExtension = (read, unit)=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([pointer])=>{
            const path = read(pointer);
            return path === null ? 0 : (pointer >>> 0) + extensionIndex(path) * unit;
        },
    });

    /**
     * PathFindFileName for either width: what follows the last separator that
     * has something after it, so a path ending in a separator names its last
     * directory, slash and all.
     *
     * @param {(address: number) => string | null} read @param {number} unit
     */
    const pathFindFileName = (read, unit)=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([pointer])=>{
            const path = read(pointer);
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
            return (pointer >>> 0) + start * unit;
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

    /** @param {string} text */
    const bytesOf = text=>Uint8Array.from(text, char=>char.charCodeAt(0) & 0xff);

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>host.writeMemory(address,
        Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff));

    /** @param {number} address @param {number} value */
    const writeWord = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(address >>> 0, new Uint8Array([value & 0xff, value >>> 8 & 0xff]));
        }
    };

    /**
     * Calls advapi32's own function of that name with the program's
     * arguments as they came, so either width reads its strings itself.
     *
     * @param {string} name @param {number[]} args @returns {number}
     */
    const registry = (name, args)=>
        /** @type {number} */ (host.advapi32?.()[name].handler(args)) >>> 0;

    /**
     * SHDeleteEmptyKey for either width: the key opened, its subkeys and
     * values counted, and deleted only when it has neither.
     *
     * @param {'A' | 'W'} width
     */
    const deleteEmptyKey = width=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([key, subKey])=>{
            if (!host.advapi32 || !host.allocate || !host.readMemory)
            {
                return ERROR_CALL_NOT_IMPLEMENTED;
            }
            const out = host.allocate(12);
            if (!out)
            {
                return ERROR_NOT_ENOUGH_MEMORY;
            }
            try
            {
                const opened = registry(`RegOpenKeyEx${width}`, [key, subKey, 0, KEY_READ, out]);
                if (opened !== ERROR_SUCCESS)
                {
                    return opened;
                }
                const counts = new DataView(host.readMemory(out, 4).slice().buffer);
                const handle = counts.getUint32(0, true);
                const queried = registry(`RegQueryInfoKey${width}`,
                    [handle, 0, 0, 0, out + 4, 0, 0, out + 8, 0, 0, 0, 0]);
                registry('RegCloseKey', [handle]);
                if (queried !== ERROR_SUCCESS)
                {
                    return queried;
                }
                const found = new DataView(host.readMemory(out + 4, 8).slice().buffer);
                if (found.getUint32(0, true) !== 0 || found.getUint32(4, true) !== 0)
                {
                    return ERROR_KEY_HAS_CHILDREN;
                }
                return registry(`RegDeleteKey${width}`, [key, subKey]);
            }
            finally
            {
                host.free?.(out);
            }
        },
    });

    /**
     * A registry helper that is one advapi32 call under another name.
     *
     * @param {string} name @param {number} argBytes
     */
    const through = (name, argBytes)=>({
        argBytes,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>(host.advapi32
            ? registry(name, args) : ERROR_CALL_NOT_IMPLEMENTED),
    });

    /**
     * StrToIntEx and StrToInt64Ex for either width: TRUE and the number, or
     * FALSE with the out pointer left alone when no number starts the string.
     *
     * @param {(address: number) => string | null} read @param {number} bytes  the answer's
     */
    const strToIntEx = (read, bytes)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([pointer, flags, out])=>{
            const text = read(pointer);
            const value = text === null || (out >>> 0) === 0
                ? null : leadingInteger(text, flags >>> 0);
            if (value === null)
            {
                return 0;
            }
            const answer = new DataView(new ArrayBuffer(8));
            answer.setBigInt64(0, value, true);
            host.writeMemory(out >>> 0, new Uint8Array(answer.buffer, 0, bytes));
            return 1;
        },
    });

    /**
     * StrToInt for either width: a string that does not start with a digit or a
     * minus sign is 0 -- a plus sign or a leading space included -- and any
     * other is read as StrToIntEx reads it, to 32 bits.
     *
     * @param {(address: number) => string | null} read
     */
    const strToInt = read=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([pointer])=>{
            const text = read(pointer);
            if (text === null || !/^[-0-9]/.test(text))
            {
                return 0;
            }
            return Number(BigInt.asIntN(32, leadingInteger(text, 0) ?? 0n));
        },
    });

    return {
        ...(host.library ? createForwards(host.library, host.divergence) : {}),

        /**
         * int StrToIntA(LPCSTR pszSrc)
         * int StrToIntW(LPCWSTR pszSrc)
         */
        StrToIntA: strToInt(pathAt),
        StrToIntW: strToInt(widePathAt),

        /**
         * BOOL StrToIntExA(LPCSTR pszString, DWORD dwFlags, int *piRet)
         * BOOL StrToIntExW(LPCWSTR, DWORD, int *)
         */
        StrToIntExA: strToIntEx(pathAt, 4),
        StrToIntExW: strToIntEx(widePathAt, 4),

        /**
         * BOOL StrToInt64ExA(LPCSTR pszString, DWORD dwFlags, LONGLONG *pllRet)
         * BOOL StrToInt64ExW(LPCWSTR, DWORD, LONGLONG *)
         */
        StrToInt64ExA: strToIntEx(pathAt, 8),
        StrToInt64ExW: strToIntEx(widePathAt, 8),

        /** HRESULT DllGetVersion(DLLVERSIONINFO *pdvi) */
        DllGetVersion: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([info])=>answerDllVersion(host, info >>> 0, SHLWAPI_VERSION),
        },

        /**
         * DWORD SHDeleteKeyA(HKEY hkey, LPCSTR pszSubKey)
         *
         * The subkey, its values and every key beneath it: RegDeleteTree's
         * work, where RegDeleteKey refuses a key with subkeys.
         */
        SHDeleteKeyA: through('RegDeleteTreeA', 8),
        /** DWORD SHDeleteKeyW(HKEY hkey, LPCWSTR pszSubKey) */
        SHDeleteKeyW: through('RegDeleteTreeW', 8),

        /**
         * DWORD SHDeleteEmptyKeyA(HKEY hkey, LPCSTR pszSubKey)
         *
         * A key with a subkey or a value is not empty, and is kept:
         * ERROR_KEY_HAS_CHILDREN.
         */
        SHDeleteEmptyKeyA: deleteEmptyKey('A'),
        /** DWORD SHDeleteEmptyKeyW(HKEY hkey, LPCWSTR pszSubKey) */
        SHDeleteEmptyKeyW: deleteEmptyKey('W'),

        /** DWORD SHDeleteValueA(HKEY hkey, LPCSTR pszSubKey, LPCSTR pszValue) */
        SHDeleteValueA: through('RegDeleteKeyValueA', 12),
        /** DWORD SHDeleteValueW(HKEY hkey, LPCWSTR pszSubKey, LPCWSTR pszValue) */
        SHDeleteValueW: through('RegDeleteKeyValueW', 12),

        /** LPSTR PathFindExtensionA(LPCSTR pszPath) */
        PathFindExtensionA: pathFindExtension(pathAt, 1),

        /** LPWSTR PathFindExtensionW(LPCWSTR pszPath) */
        PathFindExtensionW: pathFindExtension(widePathAt, 2),

        /** LPSTR PathFindFileNameA(LPCSTR pszPath) */
        PathFindFileNameA: pathFindFileName(pathAt, 1),

        /** LPWSTR PathFindFileNameW(LPCWSTR pszPath) */
        PathFindFileNameW: pathFindFileName(widePathAt, 2),

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
         * LPSTR PathAddBackslashA(LPSTR pszPath)
         *
         * A backslash after the last character unless one is there, answering
         * where the terminator now is; an empty path is left empty, and one of
         * MAX_PATH characters or more is refused untouched.
         */
        PathAddBackslashA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = pathAt(pointer);
                if (path === null || path.length >= MAX_PATH)
                {
                    return 0;
                }
                if (path === '' || path.endsWith('\\'))
                {
                    return (pointer >>> 0) + path.length;
                }
                host.writeMemory((pointer >>> 0) + path.length, Uint8Array.of(0x5c, 0));
                return (pointer >>> 0) + path.length + 1;
            },
        },

        /** BOOL PathFileExistsA(LPCSTR pszPath): a file or a directory there. */
        PathFileExistsA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = pathAt(pointer);
                return path && host.files && host.fullPath
                    && host.files.stat(host.fullPath(path))?.exists ? 1 : 0;
            },
        },

        /** void PathRemoveExtensionA(LPSTR pszPath): cut at the extension. */
        PathRemoveExtensionA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = pathAt(pointer);
                const dot = path === null ? 0 : extensionIndex(path);
                if (path !== null && dot < path.length)
                {
                    host.writeMemory((pointer >>> 0) + dot, Uint8Array.of(0));
                }
                return 0;
            },
        },

        /**
         * HRESULT UrlUnescapeA(LPSTR pszUrl, LPSTR pszUnescaped,
         *                      LPDWORD pcchUnescaped, DWORD dwFlags)
         *
         * In place with URL_UNESCAPE_INPLACE. Otherwise into the buffer while
         * it has room: the count is then the characters written, or with
         * E_POINTER the room the whole answer and its terminator need.
         */
        UrlUnescapeA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pointer, output, count, flags])=>{
                const url = pathAt(pointer);
                if (url === null)
                {
                    return E_INVALIDARG;
                }
                const answer = unescapeUrl(url, !((flags >>> 0) & URL_DONT_UNESCAPE_EXTRA_INFO));
                if ((flags >>> 0) & URL_UNESCAPE_INPLACE)
                {
                    host.writeMemory(pointer >>> 0, bytesOf(`${answer}\0`));
                    return S_OK;
                }
                if ((output >>> 0) === 0 || (count >>> 0) === 0 || !host.readMemory)
                {
                    return E_INVALIDARG;
                }
                const word = host.readMemory(count >>> 0, 4);
                const room = (word[0] | word[1] << 8 | word[2] << 16 | word[3] << 24) >>> 0;
                if (answer.length < room)
                {
                    host.writeMemory(output >>> 0, bytesOf(`${answer}\0`));
                    writeDword(count >>> 0, answer.length);
                    return S_OK;
                }
                host.writeMemory(output >>> 0, bytesOf(answer.slice(0, room)));
                writeDword(count >>> 0, answer.length + 1);
                return E_POINTER;
            },
        },

        /**
         * BOOL PathIsDirectoryA(LPCSTR pszPath)
         * BOOL PathIsDirectoryW(LPCWSTR pszPath)
         */
        PathIsDirectoryA: pathIsDirectory(pathAt),
        PathIsDirectoryW: pathIsDirectory(widePathAt),

        /**
         * PSTR StrCatBuffA(PSTR pszDest, PCSTR pszSrc, int cchDestBuffSize)
         *
         * pszSrc appended, cut to what the buffer holds with its terminator.
         */
        StrCatBuffA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([dest, source, size])=>{
                const head = pathAt(dest);
                const tail = pathAt(source);
                if (head === null || tail === null || size <= head.length)
                {
                    return dest;
                }
                const bytes = encodeAnsi(`${head}${tail} `);
                const keep = Math.min(bytes.length, size);
                bytes[keep - 1] = 0;
                host.writeMemory((dest >>> 0) + head.length, bytes.subarray(head.length, keep));
                return dest;
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
