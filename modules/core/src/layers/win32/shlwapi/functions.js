/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi — the path helpers, and the colour-space pair a colour picker uses;
 * the rest of the path functions, the string and URL functions and the
 * registry helpers that read a value as something else are in `path.js`,
 * `strings.js`, `url.js` and `registry.js`.
 *
 * Pure string functions over the caller's own buffer. Some answer with a
 * pointer into that buffer rather than a copy, so what is returned is an
 * address computed from where the text was read, never the text itself.
 */

import { encodeAnsi } from '../kernel32/locale.js';
import { createForwards } from './forwards.js';
import { MAX_PATH, canonical, compactPath, createPathFunctions, extensionIndex, isSeparator,
    rootOf }
    from './path.js';
import { createRegistryHelpers } from './registry.js';
import { createStringFunctions } from './strings.js';
import { createWidths } from './text.js';
import { createUrlFunctions } from './url.js';
import { createRefusals } from '../common/refusal.js';

/** As long as a path a program hands these may be, terminator included. */
const MAX_LENGTH = 0x1000;

const FILE_ATTRIBUTE_DIRECTORY = 0x10;

const ERROR_SUCCESS = 0;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_KEY_HAS_CHILDREN = 1020;
const KEY_READ = 0x20019;

const S_OK = 0;
const E_INVALIDARG = 0x80070057;

/**
 * Hue, luminance and saturation each run from 0 to 240 here, against 255 for
 * a colour channel. A grey has no hue and is given two thirds of the way
 * round, which is what the colour dialog shows for one.
 */
const HLSMAX = 240;
const RGBMAX = 255;
const HUE_UNDEFINED = HLSMAX * 2 / 3;

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
 * @property {(hdc: number, text: string) => number} [textWidth]
 *           A text's width in pixels in a device context's font, the
 *           screen's for a null context: what PathCompactPath fits a path by.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(code: number) => void} [setLastError]
 *           For the calls that set one: PathCanonicalize refusing a missing
 *           argument. Absent, the last error is left as it was.
 */

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
 * Where PathFindFileName's answer starts: past the last separator or drive
 * colon that has something after it.
 *
 * @param {string} path
 */
const fileNameStart = path=>{
    let start = 0;
    for (let at = 0; at + 1 < path.length; at++)
    {
        if (isSeparator(path[at]) || path[at] === ':')
        {
            start = at + 1;
        }
    }
    return start;
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
 * @returns {Record<string, { argBytes: number, handler: (args: number[]) => any }>}
 *     Every export by name: the table is built from parts whose names are made
 *     from a stem and a spelling, which no narrower type can list.
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
     * PathCompactPath for either width.
     *
     * @param {(address: number) => string | null} read
     * @param {(text: string) => Uint8Array} encode
     */
    const pathCompactPath = (read, encode)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([hdc, pointer, limit])=>{
            const path = read(pointer);
            if (path === null)
            {
                return 0;
            }
            const measure = host.textWidth;
            if (!measure)
            {
                host.divergence?.('PathCompactPath', 'no text measure: the path is left whole');
                return 1;
            }
            const text = compactPath(path, limit >>> 0, part=>measure(hdc >>> 0, part));
            if (text !== path)
            {
                host.writeMemory(pointer >>> 0, encode(text));
            }
            return 1;
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
            return (pointer >>> 0) + fileNameStart(path) * unit;
        },
    });

    /**
     * PathStripPath for either width: the name PathFindFileName finds moved
     * to the start of the buffer, over the directories before it.
     *
     * @param {(address: number) => string | null} read
     * @param {(text: string) => Uint8Array} encode
     */
    const pathStripPath = (read, encode)=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([pointer])=>{
            const path = read(pointer);
            const start = path === null ? 0 : fileNameStart(path);
            if (path !== null && start > 0)
            {
                host.writeMemory(pointer >>> 0, encode(path.slice(start)));
            }
            return 0;
        },
    });

    /**
     * PathAppend for either width: PathCombine of the path with the part, in
     * place, the part's leading backslashes dropped first unless it is a UNC
     * name -- so a part that starts at a root still goes under the path.
     *
     * @param {(address: number) => string | null} read
     * @param {(text: string) => Uint8Array} encode
     */
    const pathAppend = (read, encode)=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([pointer, more])=>{
            const path = read(pointer);
            const part = read(more);
            if (path === null || part === null)
            {
                return 0;
            }
            const result = combine(path, part.startsWith('\\\\') ? part : part.replace(/^\\+/, ''));
            if (result === null)
            {
                return 0;
            }
            host.writeMemory(pointer >>> 0, encode(result));
            return 1;
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

    const widths = createWidths(host);
    const unattached = createRefusals(host)('SHAutoComplete', { argBytes: 8, answer: S_OK,
        why: 'no autocompletion: the edit control is left as it is' });

    return {
        ...(host.library ? createForwards(host.library, host.divergence) : {}),
        ...createPathFunctions(host, widths),
        ...createStringFunctions(host, widths),
        ...createUrlFunctions(host, widths),
        ...createRegistryHelpers(host),

        /**
         * HRESULT SHAutoComplete(HWND hwndEdit, DWORD dwFlags)
         *
         * Attaches the shell's autocompletion to an edit control. There is
         * no autocompletion object here to attach, and the edit control works
         * as it did: the call is answered S_OK, as an attachment that never
         * proposes anything, which is what the program sees on a real system
         * when the sources hold nothing to propose. A program checks the
         * HRESULT only to decide whether to go on without autocompletion,
         * which is what it does either way. No window is E_INVALIDARG.
         */
        SHAutoComplete: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([window])=>((window >>> 0) === 0 ? E_INVALIDARG : unattached.handler()),
        },

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

        /**
         * BOOL PathCompactPathA(HDC hDC, LPSTR pszPath, UINT dx)
         *
         * The path made to fit dx pixels in the context's font -- the screen's
         * for no context -- in its own buffer, which it only ever shortens.
         */
        PathCompactPathA: pathCompactPath(pathAt, narrow),

        /** BOOL PathCompactPathW(HDC hDC, LPWSTR pszPath, UINT dx) */
        PathCompactPathW: pathCompactPath(widePathAt, wide),

        /** LPSTR PathFindFileNameA(LPCSTR pszPath) */
        PathFindFileNameA: pathFindFileName(pathAt, 1),

        /** LPWSTR PathFindFileNameW(LPCWSTR pszPath) */
        PathFindFileNameW: pathFindFileName(widePathAt, 2),

        /**
         * BOOL PathIsDirectoryA(LPCSTR pszPath)
         * BOOL PathIsDirectoryW(LPCWSTR pszPath)
         */
        PathIsDirectoryA: pathIsDirectory(pathAt),
        PathIsDirectoryW: pathIsDirectory(widePathAt),

        /**
         * LPSTR PathCombineA(LPSTR pszDest, LPCSTR pszDir, LPCSTR pszFile)
         * LPWSTR PathCombineW(LPWSTR, LPCWSTR, LPCWSTR)
         */
        PathCombineA: pathCombine(pathAt, narrow),
        PathCombineW: pathCombine(widePathAt, wide),

        /**
         * BOOL PathAppendA(LPSTR pszPath, LPCSTR pszMore)
         * BOOL PathAppendW(LPWSTR, LPCWSTR)
         */
        PathAppendA: pathAppend(pathAt, narrow),
        PathAppendW: pathAppend(widePathAt, wide),

        /**
         * void PathStripPathA(LPSTR pszPath)
         * void PathStripPathW(LPWSTR pszPath)
         */
        PathStripPathA: pathStripPath(pathAt, narrow),
        PathStripPathW: pathStripPath(widePathAt, wide),

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
