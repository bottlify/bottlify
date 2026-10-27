/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi's path functions: string rules over the caller's own buffer, each
 * written once and exported in both spellings.
 *
 * The rules are MSDN's, with the edge cases as Wine's shlwapi path tests
 * record Windows answering them. Only PathFileExists and
 * PathSearchAndQualify look at the volume; every other answer is the text
 * alone, whatever is or is not on the disk.
 */

import { dword, u32 } from './text.js';

/** What a path may be, terminator included. */
export const MAX_PATH = 260;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;

const S_OK = 0;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const ERROR_INVALID_PARAMETER = 87;

/** @param {string} c */
export const isSeparator = c=>c === '\\' || c === '/';

/**
 * Where a path's extension begins: the last dot of its last component, or the
 * end of the path when that component has none -- a dot in a directory's name
 * is not an extension of the file inside it.
 *
 * @param {string} path
 */
export const extensionIndex = path=>{
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
 * The root a path starts with -- a drive and its backslash, a UNC server and
 * share, or a lone backslash -- or nothing. A forward slash is not a
 * separator to PathCombine and its canonicalisation, only to the finders.
 *
 * @param {string} path
 */
export const rootOf = path=>(/^[A-Za-z]:\\/.exec(path)
    ?? /^\\\\[^\\]+\\[^\\]+\\?/.exec(path)
    ?? /^\\/.exec(path))?.[0] ?? '';

/**
 * A path with its `.` components dropped and each `..` taking the component
 * before it, never the root. Only a backslash separates components: a
 * forward slash is part of one, so `one/.` is a name (Wine's
 * test_PathCanonicalizeA). A path with nothing left is the root of the
 * current drive, a lone backslash.
 *
 * @param {string} path
 */
export const canonical = path=>{
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
    const result = root + kept.join('\\');
    return result === '' ? '\\' : result;
};

/**
 * PathIsRoot: a lone backslash, a drive and its backslash and nothing more,
 * or a UNC server, with or without one share after it but never a backslash
 * past that.
 *
 * @param {string} path
 */
export const isRoot = path=>{
    if (path === '\\' || /^[^\\]:\\$/.test(path))
    {
        return true;
    }
    return path.startsWith('\\\\') && path.slice(2).split('\\').length <= 2;
};

/**
 * PathSkipRoot: the index just past a drive's `X:\`, or past a UNC server,
 * its share and the backslash after it; null for a path that has neither --
 * a share with nothing after it included, as are a bare drive and a lone
 * backslash.
 *
 * @param {string} path
 * @returns {number | null}
 */
export const skipRoot = path=>{
    if (path.startsWith('\\\\'))
    {
        const server = path.indexOf('\\', 2);
        const share = server < 0 ? -1 : path.indexOf('\\', server + 1);
        return share < 0 ? null : share + 1;
    }
    return path.length >= 3 && path[1] === ':' && path[2] === '\\' ? 3 : null;
};

/**
 * PathRemoveFileSpec: where the path is cut, or null when nothing would be.
 * The cut is at the last backslash, except that the backslash after a drive
 * and the one or two a path starts with are kept: `C:\file` becomes `C:\`,
 * `\file` becomes `\`, and `\\server` becomes `\\`.
 *
 * @param {string} path
 * @returns {number | null}
 */
export const fileSpecCut = path=>{
    let cut = 0;
    let at = 0;
    while (at < 2 && path[at] === '\\')
    {
        cut = ++at;
    }
    for (; at < path.length; at++)
    {
        if (path[at] === '\\')
        {
            cut = at;
        }
        else if (path[at] === ':')
        {
            // A drive's backslash belongs to its root.
            if (path[at + 1] === '\\')
            {
                at++;
            }
            cut = at + 1;
        }
    }
    return cut < path.length ? cut : null;
};

/**
 * PathCommonPrefix's length: how much of `first` the two paths share in whole
 * components, compared without case. A UNC path shares nothing with one that
 * is not, and two drive prefixes keep their backslash (`C:\a` and `C:\b`
 * share `C:\`, 3), as Windows answers (Wine's test_PathCommonPrefixA).
 *
 * @param {string} first @param {string} second
 * @returns {number}
 */
export const commonPrefixLength = (first, second)=>{
    const unc = (/** @type {string} */ path)=>path.startsWith('\\\\');
    if (unc(first) !== unc(second))
    {
        return 0;
    }
    let length = 0;
    for (let at = unc(first) ? 2 : 0; ; at++)
    {
        const ends = (/** @type {string} */ path)=>at >= path.length || path[at] === '\\';
        if (ends(first) && ends(second))
        {
            length = at;
        }
        if (at >= first.length || first[at].toLowerCase() !== second[at]?.toLowerCase())
        {
            break;
        }
    }
    return length === 2 ? 3 : length;
};

/**
 * PathRelativePathTo's answer: the way from `from` to `to` as `..\` steps
 * out of what is left of `from` past the shared prefix, then the rest of
 * `to`; `.` when `from` is the prefix itself. A path that is not a directory
 * is matched by the directory holding it, a target's own name still part of
 * the answer. Null when the two share no prefix, or the answer would not fit
 * MAX_PATH.
 *
 * @param {string} from @param {boolean} fromIsDirectory
 * @param {string} to @param {boolean} toIsDirectory
 * @returns {string | null}
 */
export const relativePath = (from, fromIsDirectory, to, toIsDirectory)=>{
    const directory = (/** @type {string} */ path, /** @type {boolean} */ is)=>{
        const cut = is ? null : fileSpecCut(path);
        return cut === null ? path : path.slice(0, cut);
    };
    const start = directory(from.slice(0, MAX_PATH - 1), fromIsDirectory);
    const target = to.slice(0, MAX_PATH - 1);
    const end = directory(target, toIsDirectory);
    const shared = commonPrefixLength(start, end);
    if (shared === 0)
    {
        return null;
    }
    const steps = start.slice(shared).split('\\').filter(Boolean).map(()=>'..');
    const answer = (steps.length ? steps.join('\\') : '.') + target.slice(shared);
    return answer.length < MAX_PATH ? answer : null;
};

/**
 * Whether a string starts with a URL's scheme: two or more of the letters,
 * digits, `+`, `-` and `.` a scheme is made of, then a colon. A single letter
 * is a drive, and a space in front is not a scheme (Wine's test_PathIsUrl).
 *
 * @param {string} text
 */
export const hasScheme = text=>/^[A-Za-z0-9+.-]{2,}:/.test(text);

/**
 * The path a `file:` URL names, as PathCreateFromUrl reads it, or null for
 * anything else. `char` turns an escape's code into a character of the
 * caller's spelling.
 *
 * What follows the colon is read by how many slashes or backslashes it starts
 * with (Wine's test_PathCreateFromUrl records Windows for each count):
 * none or one is a local path, rooted when there was a slash and no drive;
 * two name a host, where `localhost` is no host and a drive straight after
 * the slashes is a path written the old way and taken literally; three is a
 * rooted local path; four is a UNC path taken literally; five or more a UNC
 * path. A drive's `|` is read as its colon. The slashes become backslashes,
 * and the escapes are decoded after that, so an escaped slash stays one.
 *
 * @param {string} url @param {(code: number) => string} char
 * @returns {string | null}
 */
export const pathFromFileUrl = (url, char)=>{
    if (!/^file:/i.test(url))
    {
        return null;
    }
    const after = url.slice(5);
    const slashes = /^[\\/]*/.exec(after)?.[0].length ?? 0;
    const rest = after.slice(slashes);
    const drive = /^[A-Za-z][:|]/.test(rest);
    /** @param {string} text */
    const asDrive = text=>(/^[A-Za-z][:|]/.test(text) ? `${text[0]}:${text.slice(2)}` : text);
    let path;
    let unescape = true;
    if (slashes === 0)
    {
        path = asDrive(rest);
    }
    else if (slashes === 1 || slashes === 3)
    {
        path = drive ? asDrive(rest) : `\\${rest}`;
    }
    else if (slashes === 2)
    {
        const end = rest.search(/[\\/]/);
        const host = end < 0 ? rest : rest.slice(0, end);
        const beyond = end < 0 ? '' : rest.slice(end + 1);
        if (drive)
        {
            path = asDrive(rest);
            unescape = false;
        }
        else if (host.toLowerCase() === 'localhost' && end >= 0)
        {
            path = /^[A-Za-z][:|]/.test(beyond) ? asDrive(beyond) : `\\${beyond}`;
        }
        else
        {
            // A drive after the host is joined to it without the slash, the
            // way Windows answers it, rather than read as a share.
            const joint = end < 0 || /^[A-Za-z][:|]/.test(beyond) ? '' : rest[end];
            path = `\\\\${host}${joint}${beyond}`;
        }
    }
    else if (slashes === 4)
    {
        path = drive ? asDrive(rest) : `\\\\${rest}`;
        unescape = false;
    }
    else
    {
        path = `\\\\${rest}`;
    }
    path = path.replace(/\//g, '\\');
    return unescape
        ? path.replace(/%([0-9A-Fa-f]{2})/g, (_, hex)=>char(parseInt(hex, 16)))
        : path;
};

/**
 * PathStripToRoot's root: a drive with its separator, a UNC server and
 * share, or a lone separator; how many characters it is, or null for none.
 *
 * @param {string} path
 * @returns {number | null}
 */
const strippedRoot = path=>{
    const root = /^[A-Za-z]:[\\/]?/.exec(path)
        ?? /^[\\/]{2}[^\\/]+(?:[\\/][^\\/]+)?/.exec(path)
        ?? /^[\\/]/.exec(path);
    return root ? root[0].length : null;
};

/**
 * @typedef {Object} PathHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {{ stat(path: string): { exists: boolean, isDirectory: boolean } | null }} [files]
 * @property {(path: string) => string} [fullPath]
 * @property {(code: number) => void} [setLastError]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     [library]  kernel32, for the search PathSearchAndQualify makes.
 */

/**
 * The volume's answer for a path, against the current directory, or null for
 * nothing there. A path the volume refuses -- a wildcard, a tab, a drive that
 * is not a letter -- is nothing there too: Windows' GetFileAttributes fails
 * on it and PathFileExists and PathIsDirectory answer FALSE.
 *
 * @param {{ files?: { stat(path: string): { exists?: boolean, isDirectory?: boolean } | null },
 *     fullPath?: (path: string) => string }} host
 * @param {string | null} path
 */
export function statPath(host, path){
    if (!path || !host.files || !host.fullPath)
    {
        return null;
    }
    try
    {
        return host.files.stat(host.fullPath(path));
    }
    catch (e){
        if (e && typeof e === 'object' && 'code' in e)
        {
            return null;
        }
        throw e;
    }
}

/**
 * PathCompactPath's answer: the path as it is when it fits in `limit`
 * pixels; otherwise the directories before its file name cut back and an
 * ellipsis put in their place, as much of the path's start kept as fits --
 * "C:\Program Fi...\setup.exe"; and when even the file name with the
 * ellipsis does not fit, the ellipsis and as much of the name as does, or as
 * much of the ellipsis as does when nothing else will.
 *
 * @param {string} path @param {number} limit
 * @param {(text: string) => number} width  The text's width in the context's font.
 * @returns {string}
 */
export function compactPath(path, limit, width){
    if (width(path) <= limit)
    {
        return path;
    }
    const ELLIPSIS = '...';
    const dots = width(ELLIPSIS);
    const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    const file = cut >= 0 ? path.slice(cut) : path;
    /** The longest start of `text` that fits in `room`. @param {string} text @param {number} room */
    const fitting = (text, room)=>{
        let count = 0;
        while (count < text.length && width(text.slice(0, count + 1)) <= room)
        {
            count++;
        }
        return text.slice(0, count);
    };
    if (cut <= 0 || width(file) + dots > limit)
    {
        // The name alone is too long: the ellipsis, then what of the name
        // fits after it.
        if (dots > limit)
        {
            return fitting(ELLIPSIS, limit);
        }
        const name = cut >= 0 ? path.slice(cut + 1) : path;
        return ELLIPSIS + fitting(name, limit - dots);
    }
    const kept = fitting(path.slice(0, cut), limit - width(file) - dots);
    return kept + ELLIPSIS + file;
}

/**
 * @param {PathHost} host
 * @param {{ A: import('./text.js').Width, W: import('./text.js').Width }} widths
 */
export function createPathFunctions(host, { A, W }){
    /**
     * A path function for both spellings.
     *
     * @param {string} name @param {number} argBytes
     * @param {(width: import('./text.js').Width, args: number[]) => number} body
     */
    const both = (name, argBytes, body)=>({
        [`${name}A`]: { argBytes, handler: (/** @type {number[]} */ args)=>body(A, args) },
        [`${name}W`]: { argBytes, handler: (/** @type {number[]} */ args)=>body(W, args) },
    });

    /** @param {number} address @param {import('./text.js').Width} width @param {string} text */
    const write = (address, width, text)=>host.writeMemory(address >>> 0, width.sz(text));

    /**
     * The count a caller passes by pointer: how much room its buffer has,
     * and where the answer's length goes back.
     *
     * @param {number} address
     */
    const countAt = address=>((address >>> 0) === 0 || !host.readMemory
        ? null : u32(host.readMemory(address >>> 0, 4)));

    /**
     * An answer into a buffer whose room the caller counts: written with its
     * length when it fits with its terminator, and otherwise E_POINTER with
     * the room it needs.
     *
     * @param {import('./text.js').Width} width @param {string} text
     * @param {number} buffer @param {number} count @param {number} room
     */
    const answerCounted = (width, text, buffer, count, room)=>{
        if (text.length < room)
        {
            write(buffer, width, text);
            host.writeMemory(count >>> 0, dword(text.length));
            return S_OK;
        }
        host.writeMemory(count >>> 0, dword(text.length + 1));
        return E_POINTER;
    };

    /**
     * The volume's answer for a path, against the current directory.
     *
     * @param {string | null} path
     */
    const stat = path=>statPath(host, path);

    /**
     * One of kernel32's file functions, called with the caller's own
     * arguments, so that the search and the qualification are its rules.
     *
     * @param {string} name @param {number[]} args @returns {number | null}
     */
    const kernel32 = (name, args)=>{
        const entry = host.library?.('KERNEL32.dll')?.[name];
        return entry ? /** @type {number} */ (entry.handler(args)) >>> 0 : null;
    };

    return {
        /** BOOL PathIsUNCA(LPCSTR pszPath): two separators to start with. */
        ...both('PathIsUNC', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path !== null && path.length > 1
                && isSeparator(path[0]) && isSeparator(path[1]) ? 1 : 0;
        }),

        /** void PathRemoveExtensionA(LPSTR pszPath): cut at the extension. */
        ...both('PathRemoveExtension', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            const dot = path === null ? 0 : extensionIndex(path);
            if (path !== null && dot < path.length)
            {
                host.writeMemory((pointer >>> 0) + dot * width.unit, width.sz(''));
            }
            return 0;
        }),

        /**
         * BOOL PathStripToRootA(LPSTR pszPath)
         *
         * Cuts the path down to its root in place: a drive with its backslash,
         * or a UNC server and share. A path with no root is cut to nothing and
         * refused, which is what removing one component at a time until only a
         * root is left does when there was never a root to reach.
         */
        ...both('PathStripToRoot', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null)
            {
                return 0;
            }
            const keep = strippedRoot(path);
            if ((keep ?? 0) < path.length)
            {
                host.writeMemory((pointer >>> 0) + (keep ?? 0) * width.unit, width.sz(''));
            }
            return keep === null ? 0 : 1;
        }),

        /**
         * LPSTR PathAddBackslashA(LPSTR pszPath)
         *
         * A backslash after the last character unless one is there, answering
         * where the terminator now is; an empty path is left empty, and one of
         * MAX_PATH characters or more is refused untouched.
         */
        ...both('PathAddBackslash', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null || path.length >= MAX_PATH)
            {
                return 0;
            }
            const end = (pointer >>> 0) + path.length * width.unit;
            if (path === '' || path.endsWith('\\'))
            {
                return end;
            }
            host.writeMemory(end, width.sz('\\'));
            return end + width.unit;
        }),

        /**
         * BOOL PathCanonicalizeA(LPSTR pszBuf, LPCSTR pszPath)
         *
         * The `.` and `..` components resolved; an empty path is the root,
         * `\`. Without a source or a destination it is refused with
         * ERROR_INVALID_PARAMETER and the destination is left alone, and a
         * source of MAX_PATH or more is refused (Wine's
         * test_PathCanonicalizeA).
         */
        ...both('PathCanonicalize', 8, (width, [destination, source])=>{
            const path = width.read(source);
            if (path === null || (destination >>> 0) === 0)
            {
                host.setLastError?.(ERROR_INVALID_PARAMETER);
                return 0;
            }
            const result = path.length < MAX_PATH ? canonical(path) : null;
            if (result === null || result.length >= MAX_PATH)
            {
                return 0;
            }
            write(destination, width, result);
            return 1;
        }),

        /**
         * HRESULT PathCreateFromUrlA(LPCSTR pszUrl, LPSTR pszPath,
         *                            LPDWORD pcchPath, DWORD dwFlags)
         *
         * The path a `file:` URL names (`pathFromFileUrl`). Anything else, or
         * a missing argument, is E_INVALIDARG with the count left alone; a
         * buffer too small is E_POINTER and the room the path needs.
         */
        ...both('PathCreateFromUrl', 16, (width, [url, buffer, count])=>{
            const text = width.read(url);
            const room = countAt(count);
            const path = text === null ? null : pathFromFileUrl(text, width.char);
            if (path === null || room === null || (buffer >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return answerCounted(width, path, buffer, count, room);
        }),

        /** BOOL PathFileExistsA(LPCSTR pszPath): a file or a directory there. */
        ...both('PathFileExists', 4, (width, [pointer])=>
            (stat(width.read(pointer))?.exists ? 1 : 0)),

        /** BOOL PathIsRootA(LPCSTR pszPath) */
        ...both('PathIsRoot', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path !== null && isRoot(path) ? 1 : 0;
        }),

        /**
         * BOOL PathIsRelativeA(LPCSTR pszPath): neither rooted at a backslash
         * nor at a drive; NULL and the empty string count as relative.
         */
        ...both('PathIsRelative', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path === null || !(path.startsWith('\\') || path[1] === ':') ? 1 : 0;
        }),

        /** BOOL PathIsURLA(LPCSTR pszPath): a scheme of two characters or more. */
        ...both('PathIsURL', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path !== null && hasScheme(path) ? 1 : 0;
        }),

        /** void PathRemoveBlanksA(LPSTR pszPath): spaces off both ends, in place. */
        ...both('PathRemoveBlanks', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path !== null)
            {
                write(pointer, width, path.replace(/^ +| +$/g, ''));
            }
            return 0;
        }),

        /**
         * BOOL PathRemoveFileSpecA(LPSTR pszPath)
         *
         * The last component and the backslash before it cut off, a root's
         * backslash kept (`fileSpecCut`); FALSE when there was nothing to cut.
         */
        ...both('PathRemoveFileSpec', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            const cut = path === null ? null : fileSpecCut(path);
            if (cut === null)
            {
                return 0;
            }
            host.writeMemory((pointer >>> 0) + cut * width.unit, width.sz(''));
            return 1;
        }),

        /**
         * int PathCommonPrefixA(LPCSTR pszFile1, LPCSTR pszFile2, LPSTR achPath)
         *
         * The shared length (`commonPrefixLength`), and the prefix itself
         * into achPath when one is given.
         */
        ...both('PathCommonPrefix', 12, (width, [first, second, out])=>{
            const one = width.read(first);
            const two = width.read(second);
            const length = one === null || two === null ? 0 : commonPrefixLength(one, two);
            if ((out >>> 0) !== 0)
            {
                write(out, width, (one ?? '').slice(0, length));
            }
            return length;
        }),

        /**
         * BOOL PathRelativePathToA(LPSTR pszPath, LPCSTR pszFrom, DWORD dwAttrFrom,
         *   LPCSTR pszTo, DWORD dwAttrTo)
         *
         * `relativePath`, FILE_ATTRIBUTE_DIRECTORY saying which ends are
         * directories; pszPath is emptied when there is no answer.
         */
        ...both('PathRelativePathTo', 20, (width, [out, from, fromAttributes, to, toAttributes])=>{
            const start = width.read(from);
            const end = width.read(to);
            if ((out >>> 0) === 0 || start === null || end === null)
            {
                return 0;
            }
            const answer = relativePath(start, (fromAttributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
                end, (toAttributes & FILE_ATTRIBUTE_DIRECTORY) !== 0);
            write(out, width, answer ?? '');
            return answer === null ? 0 : 1;
        }),

        /**
         * BOOL PathRenameExtensionA(LPSTR pszPath, LPCSTR pszExt)
         *
         * The extension replaced, or added where there was none; refused,
         * the path untouched, when the result would not fit MAX_PATH.
         */
        ...both('PathRenameExtension', 8, (width, [pointer, extension])=>{
            const path = width.read(pointer);
            const added = width.read(extension);
            if (path === null || added === null)
            {
                return 0;
            }
            const dot = extensionIndex(path);
            if (dot + added.length >= MAX_PATH)
            {
                return 0;
            }
            host.writeMemory((pointer >>> 0) + dot * width.unit, width.sz(added));
            return 1;
        }),

        /**
         * BOOL PathAddExtensionA(LPSTR pszPath, LPCSTR pszExt)
         *
         * The extension added only where the path has none -- FALSE, the
         * path untouched, when it has one or the result would not fit
         * MAX_PATH; a null or empty extension adds ".exe", as documented.
         */
        ...both('PathAddExtension', 8, (width, [pointer, extension])=>{
            const path = width.read(pointer);
            if (path === null || extensionIndex(path) !== path.length)
            {
                return 0;
            }
            const added = width.read(extension) || '.exe';
            if (path.length + added.length >= MAX_PATH)
            {
                return 0;
            }
            host.writeMemory((pointer >>> 0) + path.length * width.unit, width.sz(added));
            return 1;
        }),

        /**
         * BOOL PathSearchAndQualifyA(LPCSTR pszPath, LPSTR pszBuf, UINT cchBuf)
         *
         * A name found where SearchPath finds one, and otherwise the path
         * made full against the current directory as GetFullPathName makes
         * it (Wine's test_PathSearchAndQualify): both are kernel32's own
         * calls, into the caller's buffer. TRUE when the answer fit.
         */
        ...both('PathSearchAndQualify', 12, (width, [pointer, buffer, room])=>{
            const suffix = width.wide ? 'W' : 'A';
            if (width.read(pointer) === null || (buffer >>> 0) === 0)
            {
                return 0;
            }
            const found = kernel32(`SearchPath${suffix}`, [0, pointer, 0, room, buffer, 0]);
            const written = found !== null && found !== 0 ? found
                : kernel32(`GetFullPathName${suffix}`, [pointer, room, buffer, 0]);
            return written !== null && written > 0 && written < (room >>> 0) ? 1 : 0;
        }),

        /** LPSTR PathSkipRootA(LPCSTR pszPath): just past its root, or NULL. */
        ...both('PathSkipRoot', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            const past = path === null ? null : skipRoot(path);
            return past === null ? 0 : (pointer >>> 0) + past * width.unit;
        }),
    };
}
