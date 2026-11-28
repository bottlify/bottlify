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

import { wholeAddress } from '../common/pointers.js';

/** What a path may be, terminator included. */
export const MAX_PATH = 260;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_READONLY = 0x1;
const FILE_ATTRIBUTE_SYSTEM = 0x4;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const HKEY_CLASSES_ROOT = 0x80000000;
const RRF_RT_REG_SZ = 0x2;
/** PathGetCharType's flags. */
const GCT_INVALID = 0x0;
const GCT_LFNCHAR = 0x1;
const GCT_SHORTCHAR = 0x2;
const GCT_WILD = 0x4;
const GCT_SEPARATOR = 0x8;
/**
 * The extensions PathFileExistsDefExt tries, by the bit of dwWhich that asks
 * for each, in the order Windows tries them.
 *
 * @type {readonly (readonly [number, string])[]}
 */
const DEFAULT_EXTENSIONS = Object.freeze([[0x1, '.pif'], [0x2, '.com'], [0x4, '.exe'],
    [0x8, '.bat'], [0x10, '.lnk'], [0x20, '.cmd']]);

const S_OK = 0;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const E_OUTOFMEMORY = 0x8007000e;
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
const isRoot = path=>{
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
const skipRoot = path=>{
    if (path.startsWith('\\\\'))
    {
        const server = path.indexOf('\\', 2);
        const share = server < 0 ? -1 : path.indexOf('\\', server + 1);
        return share < 0 ? null : share + 1;
    }
    return path.length >= 3 && path[1] === ':' && path[2] === '\\' ? 3 : null;
};

/**
 * PathGetArgs: the index just past a command line's first space outside
 * quotes, or its length when there is none.
 *
 * @param {string} path
 * @returns {number}
 */
const argumentsAt = path=>{
    let quoted = false;
    for (let at = 0; at < path.length; at++)
    {
        if (path[at] === ' ' && !quoted)
        {
            return at + 1;
        }
        if (path[at] === '"')
        {
            quoted = !quoted;
        }
    }
    return path.length;
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
const fileSpecCut = path=>{
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
const commonPrefixLength = (first, second)=>{
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
const relativePath = (from, fromIsDirectory, to, toIsDirectory)=>{
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
 * @property {import('../common/guest.js').Guest} guest
 * @property {{ stat(path: string): { exists: boolean, isDirectory: boolean } | null }} [files]
 * @property {(path: string) => string} [fullPath]
 * @property {(code: number) => void} [setLastError]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     [library]  kernel32, for the search PathSearchAndQualify makes.
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(hdc: number, text: string) => number} [textWidth]
 *           A text's width in a context's font, for a path shortened to fit.
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

/** PathIsValidChar's classes, as the SDK names them. */
const PATH_CHAR_CLASS = Object.freeze({ LETTER: 0x1, ASTERISK: 0x2, DOT: 0x4, BACKSLASH: 0x8,
    COLON: 0x10, SEMICOLON: 0x20, COMMA: 0x40, SPACE: 0x80, OTHER_VALID: 0x100,
    DOUBLEQUOTE: 0x200, ANY: 0xffffffff });

/**
 * The classes an ASCII character is in (Wine's SHELL_charclass, against
 * Windows): a letter is any class, `?` a letter's, the separators and
 * marks each their own, the controls and `/ < > |` none, and the rest
 * other valid characters. A character past ASCII is other valid.
 *
 * @param {number} code
 */
export const charClass = code=>{
    if (code >= 0x7f)
    {
        return PATH_CHAR_CLASS.OTHER_VALID;
    }
    const c = String.fromCharCode(code);
    if (/[A-Za-z]/.test(c))
    {
        return PATH_CHAR_CLASS.ANY;
    }
    const marks = /** @type {Record<string, number>} */ ({ ' ': PATH_CHAR_CLASS.SPACE,
        '"': PATH_CHAR_CLASS.DOUBLEQUOTE, '*': PATH_CHAR_CLASS.ASTERISK,
        ',': PATH_CHAR_CLASS.COMMA, '.': PATH_CHAR_CLASS.DOT, ':': PATH_CHAR_CLASS.COLON,
        ';': PATH_CHAR_CLASS.SEMICOLON, '?': PATH_CHAR_CLASS.LETTER,
        '\\': PATH_CHAR_CLASS.BACKSLASH });
    if (c in marks)
    {
        return marks[c];
    }
    return code < 0x20 || '/<>|'.includes(c) ? 0 : PATH_CHAR_CLASS.OTHER_VALID;
};

/**
 * The variables PathUnExpandEnvStrings puts back for the start of a path,
 * as MSDN lists them less %COMPUTERNAME%, whose value names no path (Wine's
 * test_PathUnExpandEnvStrings).
 */
const UNEXPANDED = Object.freeze(['ALLUSERSPROFILE', 'APPDATA', 'USERPROFILE', 'ProgramFiles',
    'SystemRoot', 'SystemDrive']);

/**
 * @param {PathHost} host
 * @param {{ A: import('./text.js').Width, W: import('./text.js').Width }} widths
 */
export function createPathFunctions(host, { A, W }){
    const { guest } = host;
    /**
     * A path function for both spellings.
     *
     * @param {string} name @param {number} argBytes
     * @param {(width: import('./text.js').Width, args: number[]) => number} body
     * @param {{ returns?: string }} [marshal]  `returns: 'pointer'` for one answering an address
     */
    const both = (name, argBytes, body, marshal = {})=>({
        [`${name}A`]: { argBytes, ...marshal,
            handler: (/** @type {number[]} */ args)=>body(A, args) },
        [`${name}W`]: { argBytes, ...marshal,
            handler: (/** @type {number[]} */ args)=>body(W, args) },
    });

    /** @param {number} address @param {import('./text.js').Width} width @param {string} text */
    const write = (address, width, text)=>guest.setBytes(address, width.sz(text));

    /**
     * The process's variables as kernel32 has them now, by upper-case name;
     * null without kernel32 to ask.
     *
     * @returns {Map<string, string> | null}
     */
    const environment = ()=>{
        const kernel32 = host.library?.('KERNEL32.dll');
        const block = kernel32
            ? /** @type {number} */ (kernel32.GetEnvironmentStringsW?.handler([])) >>> 0 : 0;
        if (!block || !kernel32)
        {
            return null;
        }
        /** @type {Map<string, string>} */
        const variables = new Map();
        let at = block;
        for (let count = 0; count < 0x8000; count++)
        {
            const entry = W.read(at) ?? '';
            at += (entry.length + 1) * 2;
            if (entry === '')
            {
                break;
            }
            const split = entry.indexOf('=', 1);
            if (split > 0)
            {
                variables.set(entry.slice(0, split).toUpperCase(), entry.slice(split + 1));
            }
        }
        kernel32.FreeEnvironmentStringsW?.handler([block]);
        return variables;
    };

    /**
     * The count a caller passes by pointer: how much room its buffer has,
     * and where the answer's length goes back.
     *
     * @param {number} address
     */
    const countAt = address=>((address >>> 0) === 0
        ? null : guest.u32(address));

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
            guest.set32(count, text.length);
            return S_OK;
        }
        guest.set32(count, text.length + 1);
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
                guest.setBytes(pointer + dot * width.unit, width.sz(''));
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
                guest.setBytes(pointer + (keep ?? 0) * width.unit, width.sz(''));
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
            guest.setBytes(end, width.sz('\\'));
            return end + width.unit;
        }, { returns: 'pointer' }),

        /**
         * LPSTR PathRemoveBackslashA(LPSTR pszPath)
         *
         * The last character dropped when it is a backslash and the path is
         * not a root, answering where it stood -- the terminator now, or the
         * last character when it was kept; NULL for NULL.
         */
        ...both('PathRemoveBackslash', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null)
            {
                return 0;
            }
            const last = (pointer >>> 0) + Math.max(path.length - 1, 0) * width.unit;
            if (path.endsWith('\\') && !isRoot(path))
            {
                guest.setBytes(last, width.sz(''));
            }
            return last;
        }, { returns: 'pointer' }),

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

        /**
         * BOOL PathIsValidCharA(UCHAR ch, DWORD dwFlags)  (#455)
         * BOOL PathIsValidCharW(WCHAR ch, DWORD dwFlags)  (#456)
         *
         * Whether the character is in any of the classes asked for.
         */
        PathIsValidCharA: { argBytes: 8, handler: (/** @type {number[]} */ [code, classes])=>
            ((charClass(code & 0xff) & classes) !== 0 ? 1 : 0) },
        PathIsValidCharW: { argBytes: 8, handler: (/** @type {number[]} */ [code, classes])=>
            ((charClass(code & 0xffff) & classes) !== 0 ? 1 : 0) },

        /**
         * BOOL PathUnExpandEnvStringsA(LPCSTR pszPath, LPSTR pszBuf, UINT cchBuf)
         *
         * The path with the longest of the variables' values that starts it
         * put back as the variable, read from the environment as it is now;
         * FALSE, the buffer as it was, when none does or the answer does not
         * fit.
         */
        ...both('PathUnExpandEnvStrings', 12, (width, [pointer, buffer, room])=>{
            const path = width.read(pointer);
            const variables = environment();
            if (path === null || (buffer >>> 0) === 0 || !variables)
            {
                return 0;
            }
            let best = null;
            for (const name of UNEXPANDED)
            {
                const value = variables.get(name.toUpperCase());
                const ends = (/** @type {string} */ text)=>/[\\:]$/.test(text)
                    || path.length === text.length || path[text.length] === '\\';
                if (value && path.toUpperCase().startsWith(value.toUpperCase()) && ends(value)
                    && (best === null || value.length > best.value.length))
                {
                    best = { name, value };
                }
            }
            if (best === null)
            {
                return 0;
            }
            const text = `%${best.name}%${path.slice(best.value.length)}`;
            if (text.length + 1 > (room >>> 0))
            {
                return 0;
            }
            write(buffer, width, text);
            return 1;
        }),

        /**
         * HRESULT PathCreateFromUrlAlloc(PCWSTR pszIn, PWSTR *ppszOut, DWORD dwFlags)
         *
         * PathCreateFromUrlW's path in a block the caller frees with LocalFree.
         */
        PathCreateFromUrlAlloc: { argBytes: 12, handler: (/** @type {number[]} */ [url, out])=>{
            const text = W.read(url);
            const path = text === null ? null : pathFromFileUrl(text, W.char);
            if (path === null || wholeAddress(out) === 0)
            {
                return E_INVALIDARG;
            }
            const bytes = W.sz(path);
            const alloc = host.library?.('KERNEL32.dll')?.LocalAlloc;
            const block = alloc ? /** @type {number} */ (alloc.handler([0, bytes.length])) >>> 0 : 0;
            guest.setBytes(out, Uint8Array.of(block & 0xff, block >>> 8 & 0xff,
                block >>> 16 & 0xff, block >>> 24 & 0xff));
            if (!block)
            {
                return E_OUTOFMEMORY;
            }
            guest.setBytes(block, bytes);
            return S_OK;
        } },

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

        /**
         * LPSTR PathGetArgsA(LPCSTR pszPath)
         *
         * Where a command line's arguments start: just past its first space
         * outside quotes, or at its end when it has none.
         */
        ...both('PathGetArgs', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path === null ? pointer >>> 0
                : (pointer >>> 0) + argumentsAt(path) * width.unit;
        }, { returns: 'pointer' }),

        /**
         * void PathRemoveArgsA(LPSTR pszPath)
         *
         * Cuts a command line at the space before its arguments, in place; a
         * line with no arguments keeps a trailing space only when it has none.
         */
        ...both('PathRemoveArgs', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null)
            {
                return 0;
            }
            const at = argumentsAt(path);
            if (at > 0 && (at < path.length || path[at - 1] === ' '))
            {
                guest.setBytes(pointer + (at - 1) * width.unit, width.sz(''));
            }
            return 0;
        }),

        /**
         * BOOL PathIsSameRootA(LPCSTR pszPath1, LPCSTR pszPath2)
         *
         * Whether the second path begins with the first one's root: a drive's
         * `X:\` or a UNC server and share, in any case. A first path with no
         * root is on no root at all.
         */
        ...both('PathIsSameRoot', 8, (width, [first, second])=>{
            const one = width.read(first);
            const other = width.read(second);
            if (one === null || other === null)
            {
                return 0;
            }
            const root = skipRoot(one);
            return root !== null && commonPrefixLength(one, other) + 1 >= root ? 1 : 0;
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
         * BOOL PathMakePrettyA(LPSTR lpPath)
         *
         * A path all in capitals put in small letters but its first
         * character; one with a small letter anywhere is left as it is, and
         * FALSE (Wine's test_PathMakePretty).
         */
        ...both('PathMakePretty', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null || path !== path.toUpperCase())
            {
                return 0;
            }
            write(pointer, width, path.slice(0, 1) + path.slice(1).toLowerCase());
            return 1;
        }),

        /**
         * void PathUnquoteSpacesA(LPSTR lpszPath)
         *
         * One double quote taken off each end, when both ends have one; a
         * lone quote is the empty path.
         */
        ...both('PathUnquoteSpaces', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path !== null && path.startsWith('"') && (path.length === 1 || path.endsWith('"')))
            {
                write(pointer, width, path.slice(1, Math.max(1, path.length - 1)));
            }
            return 0;
        }),

        /**
         * BOOL PathQuoteSpacesA(LPSTR lpsz)
         *
         * A path with a space in it put in double quotes, in place, when the
         * quoted path still fits in MAX_PATH; TRUE when it was quoted.
         */
        ...both('PathQuoteSpaces', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null || !path.includes(' ') || path.length + 2 >= MAX_PATH)
            {
                return 0;
            }
            write(pointer, width, `"${path}"`);
            return 1;
        }),

        /**
         * BOOL PathCompactPathExA(LPSTR pszOut, LPCSTR pszSrc, UINT cchMax, DWORD dwFlags)
         *
         * PathCompactPath's cut, by characters: the path in cchMax characters
         * with its terminator, the directories before the name given up to
         * an ellipsis first. No flags are defined.
         */
        ...both('PathCompactPathEx', 16, (width, [out, source, max, flags])=>{
            const path = width.read(source);
            if ((out >>> 0) === 0 || path === null || (max >>> 0) === 0 || flags !== 0)
            {
                return 0;
            }
            write(out, width, compactPath(path, (max >>> 0) - 1, text=>text.length));
            return 1;
        }),

        /**
         * void PathUndecorateA(LPSTR pszPath)
         *
         * The "[n]" a browser's cache puts before a file's extension taken
         * out: only ASCII digits, only right before the extension -- or the
         * end, for a name with none -- and never the whole name (Wine's
         * test_PathUndecorate).
         */
        ...both('PathUndecorate', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null)
            {
                return 0;
            }
            const dot = extensionIndex(path);
            const stem = path.slice(0, dot);
            const decoration = /\[[0-9]*\]$/.exec(stem);
            const start = decoration ? stem.length - decoration[0].length : -1;
            if (decoration && start > 0 && !isSeparator(stem[start - 1]))
            {
                write(pointer, width, stem.slice(0, start) + path.slice(dot));
            }
            return 0;
        }),

        /**
         * int PathGetDriveNumberA(LPCSTR lpszPath)
         *
         * The drive a path starts with, 0 for A; through a `\\?\` prefix in
         * the wide spelling, which alone has one; -1 for none, and for NULL
         * with the last error left alone (Wine's test_PathGetDriveNumber).
         */
        ...both('PathGetDriveNumber', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            const drive = path === null ? null
                : (width.wide ? /^(?:\\\\\?\\)?([A-Za-z]):/ : /^([A-Za-z]):/).exec(path);
            return drive ? drive[1].toUpperCase().charCodeAt(0) - 0x41 : -1;
        }),

        /**
         * LPSTR PathBuildRootA(LPSTR pszRoot, int iDrive)
         *
         * "A:\" for drive 0 to "Z:\" for 25 into the buffer; another number
         * leaves it alone. The buffer either way.
         */
        ...both('PathBuildRoot', 8, (width, [pointer, drive])=>{
            if ((pointer >>> 0) !== 0 && (drive | 0) >= 0 && (drive | 0) < 26)
            {
                write(pointer, width, `${String.fromCharCode(0x41 + (drive | 0))}:\\`);
            }
            return wholeAddress(pointer);
        }, { returns: 'pointer' }),

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
            guest.setBytes(pointer + cut * width.unit, width.sz(''));
            return 1;
        }),

        /**
         * int PathCommonPrefixA(LPCSTR pszFile1, LPCSTR pszFile2, LPSTR achPath)
         *
         * The shared length (`commonPrefixLength`), and the prefix itself
         * into achPath when one is given; a missing path leaves it alone
         * (Wine's test_PathCommonPrefixA).
         */
        ...both('PathCommonPrefix', 12, (width, [first, second, out])=>{
            const one = width.read(first);
            const two = width.read(second);
            const length = one === null || two === null ? 0 : commonPrefixLength(one, two);
            if ((out >>> 0) !== 0 && one !== null && two !== null)
            {
                write(out, width, one.slice(0, length));
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
            guest.setBytes(pointer + dot * width.unit, width.sz(added));
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
            guest.setBytes(pointer + path.length * width.unit, width.sz(added));
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
        }, { returns: 'pointer' }),

        /**
         * BOOL PathFileExistsDefExtA(LPSTR lpszPath, DWORD dwWhich)
         *
         * A path with an extension is there or not; one without is tried with
         * each extension dwWhich names, in Windows' order, and the first that
         * is there is added to the caller's buffer.
         */
        ...both('PathFileExistsDefExt', 8, (width, [pointer, which])=>{
            const path = width.read(pointer);
            return path === null ? 0 : withDefaultExtension(width, pointer, path, which >>> 0)
                ? 1 : 0;
        }),

        /**
         * BOOL PathFindOnPathExA(LPSTR lpszFile, LPCSTR *lppszOtherDirs, DWORD dwWhich)
         * BOOL PathFindOnPathA(LPSTR lpszFile, LPCSTR *lppszOtherDirs)
         *
         * The file looked for in the directories the caller lists, then the
         * system's own and those PATH names; the first full path that is
         * there, with the extension dwWhich found, is the caller's buffer.
         */
        ...both('PathFindOnPathEx', 12, (width, [pointer, others, which])=>
            findOnPath(width, pointer, others, which >>> 0)),
        ...both('PathFindOnPath', 8, (width, [pointer, others])=>
            findOnPath(width, pointer, others, 0)),

        /**
         * BOOL PathFileExistsAndAttributesA(LPCSTR lpszPath, DWORD *dwAttr)
         *
         * Whether it is there, and its attributes as GetFileAttributes gives
         * them - INVALID_FILE_ATTRIBUTES for nothing there.
         */
        ...both('PathFileExistsAndAttributes', 8, (width, [pointer, out])=>{
            const attributes = width.read(pointer) === null ? null
                : kernel32(`GetFileAttributes${width.wide ? 'W' : 'A'}`, [pointer]);
            const answer = attributes ?? INVALID_FILE_ATTRIBUTES;
            if ((out >>> 0) !== 0)
            {
                guest.set32(out, answer);
            }
            return answer === INVALID_FILE_ATTRIBUTES ? 0 : 1;
        }),

        /** LPSTR PathSkipLeadingSlashesA(LPCSTR lpszSrc): past a URL's leading "//". */
        PathSkipLeadingSlashesA: {
            returns: 'pointer',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = A.read(pointer);
                return path !== null && path.startsWith('//') ? wholeAddress(pointer) + 2
                    : wholeAddress(pointer);
            },
        },

        /**
         * VOID FixSlashesAndColonW(LPWSTR lpwstr)
         *
         * A file URL's path made a Windows one in place: forward slashes
         * become backslashes and a colon the bar URLs spell a drive with.
         */
        FixSlashesAndColonW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const path = W.read(pointer);
                if (path !== null)
                {
                    write(pointer, W, path.replace(/\//g, '\\').replace(/:/g, '|'));
                }
                return 0;
            },
        },

        /**
         * LPSTR PathFindNextComponentA(LPCSTR lpszPath)
         *
         * Past the first backslash, or the terminator when there is none;
         * NULL for no path or an empty one.
         */
        ...both('PathFindNextComponent', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null || path === '')
            {
                return 0;
            }
            const cut = path.indexOf('\\');
            return (pointer >>> 0) + (cut < 0 ? path.length : cut + 1) * width.unit;
        }, { returns: 'pointer' }),

        /**
         * LPCSTR PathFindSuffixArrayA(LPCSTR lpszSuffix, LPCSTR *lppszArray, int dwCount)
         *
         * The first suffix of the caller's list the path ends with, case
         * ignored - the list's own string - or NULL.
         */
        ...both('PathFindSuffixArray', 12, (width, [pointer, list, count])=>{
            const path = width.read(pointer);
            if (path === null || (list >>> 0) === 0)
            {
                return 0;
            }
            for (let at = 0; at < (count | 0); at++)
            {
                const entry = guest.ptr(list + at * guest.pointerSize);
                const suffix = width.read(entry);
                if (suffix !== null && path.length >= suffix.length
                    && path.slice(path.length - suffix.length).toLowerCase()
                        === suffix.toLowerCase())
                {
                    return entry;
                }
            }
            return 0;
        }, { returns: 'pointer' }),

        /**
         * UINT PathGetCharTypeA(UCHAR ch)
         *
         * GCT_INVALID, GCT_WILD, GCT_SEPARATOR, or GCT_LFNCHAR with
         * GCT_SHORTCHAR unless the character is one a short name has none of.
         */
        PathGetCharTypeA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>charType(A.char(code & 0xff)),
        },
        PathGetCharTypeW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>charType(String.fromCharCode(code & 0xffff)),
        },

        /**
         * BOOL PathIsContentTypeA(LPCSTR lpszPath, LPCSTR lpszContentType)
         *
         * The "Content Type" HKEY_CLASSES_ROOT gives the path's extension,
         * compared without regard to case.
         */
        ...both('PathIsContentType', 8, (width, [pointer, wanted])=>{
            const path = width.read(pointer);
            const type = width.read(wanted);
            if (path === null || type === null)
            {
                return 0;
            }
            const extension = path.slice(extensionIndex(path));
            const found = extension ? classesValue(extension, 'Content Type') : null;
            return found !== null && found.toLowerCase() === type.toLowerCase() ? 1 : 0;
        }),

        /** BOOL PathIsFileSpecA(LPCSTR lpszPath): no backslash and no colon in it. */
        ...both('PathIsFileSpec', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path !== null && !/[\\:]/.test(path) ? 1 : 0;
        }),

        /**
         * BOOL PathIsLFNFileSpecA(LPCSTR lpszPath)
         *
         * A name that is not 8.3: a space, a second dot, more than eight
         * characters before its dot or three after.
         */
        ...both('PathIsLFNFileSpec', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null)
            {
                return 0;
            }
            if (path.includes(' '))
            {
                return 1;
            }
            const parts = path.split('.');
            return parts.length > 2 || parts[0].length > 8 || (parts[1]?.length ?? 0) > 3
                ? 1 : 0;
        }),

        /**
         * BOOL PathIsNetworkPathA(LPCSTR lpszPath)
         *
         * A UNC path. A drive letter here is never a network drive.
         */
        ...both('PathIsNetworkPath', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path !== null && path.startsWith('\\\\') ? 1 : 0;
        }),

        /**
         * BOOL PathIsPrefixA(LPCSTR lpszPrefix, LPCSTR lpszPath)
         *
         * The whole of the prefix is the components the two paths share.
         */
        ...both('PathIsPrefix', 8, (width, [prefix, pointer])=>{
            const head = width.read(prefix);
            const path = width.read(pointer);
            return head !== null && path !== null
                && commonPrefixLength(head, path) === head.length ? 1 : 0;
        }),

        /**
         * BOOL PathIsSystemFolderA(LPCSTR lpszPath, DWORD dwAttrib)
         *
         * A directory that is read-only or system: the path's attributes, or
         * those the caller passes when it names no path.
         */
        ...both('PathIsSystemFolder', 8, (width, [pointer, given])=>{
            const path = width.read(pointer);
            const attributes = path ? kernel32(`GetFileAttributes${width.wide ? 'W' : 'A'}`,
                [pointer]) ?? INVALID_FILE_ATTRIBUTES : given >>> 0;
            return attributes !== INVALID_FILE_ATTRIBUTES
                && (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0
                && (attributes & (FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_SYSTEM)) !== 0 ? 1 : 0;
        }),

        /** BOOL PathMakeSystemFolderA(LPCSTR lpszPath): a directory given the system attribute. */
        ...both('PathMakeSystemFolder', 4, (width, [pointer])=>
            systemFolder(width, pointer, attributes=>attributes | FILE_ATTRIBUTE_SYSTEM)),

        /**
         * BOOL PathUnmakeSystemFolderA(LPCSTR lpszPath)
         *
         * The attributes that make a directory a system folder taken off.
         */
        ...both('PathUnmakeSystemFolder', 4, (width, [pointer])=>systemFolder(width, pointer,
            attributes=>attributes & ~(FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_READONLY))),

        /** BOOL PathIsUNCServerA(LPCSTR lpszPath): "\\server" and nothing after. */
        ...both('PathIsUNCServer', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path !== null && /^\\\\[^\\]*$/.test(path) ? 1 : 0;
        }),

        /** BOOL PathIsUNCServerShareA(LPCSTR lpszPath): "\\server\share" and nothing after. */
        ...both('PathIsUNCServerShare', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            return path !== null && /^\\\\[^\\]+\\[^\\]+$/.test(path) ? 1 : 0;
        }),

        /**
         * int PathParseIconLocationA(LPSTR pszIconFile)
         *
         * "file,index" split in place: the index answered, the file left with
         * its quotes and surrounding blanks taken off.
         */
        ...both('PathParseIconLocation', 4, (width, [pointer])=>{
            const path = width.read(pointer);
            if (path === null)
            {
                return 0;
            }
            const comma = path.indexOf(',');
            const file = comma < 0 ? path : path.slice(0, comma);
            const index = comma < 0 ? 0 : Number.parseInt(path.slice(comma + 1).trim(), 10) || 0;
            const unquoted = file.trim().replace(/^"(.*)"$/, '$1').trim();
            write(pointer, width, unquoted);
            return index | 0;
        }),

        /**
         * void PathSetDlgItemPathA(HWND hDlg, int id, LPCSTR pszPath)
         *
         * The dialog item's text set to the path, shortened with an ellipsis
         * to the item's width as PathCompactPath shortens one.
         */
        ...both('PathSetDlgItemPath', 12, (width, [dialog, id, pointer])=>{
            setItemPath(width, dialog, id, pointer);
            return 0;
        }),
    };

    /**
     * PathFileExistsDefExt's body: true when the path, or the path with one
     * of the extensions `which` names, is there; the extension then added to
     * the caller's buffer.
     *
     * @param {import('./text.js').Width} width @param {number} buffer
     * @param {string} path @param {number} which
     */
    function withDefaultExtension(width, buffer, path, which){
        if (extensionIndex(path) < path.length || which === 0)
        {
            return Boolean(stat(path)?.exists);
        }
        for (const [bit, extension] of DEFAULT_EXTENSIONS)
        {
            if ((which & bit) !== 0 && path.length + extension.length < MAX_PATH
                && stat(path + extension)?.exists)
            {
                guest.setBytes(buffer + path.length * width.unit,
                    width.sz(extension));
                return true;
            }
        }
        return false;
    }

    /**
     * PathFindOnPath's search: the caller's directories, then the system
     * directory, the Windows directory's System and the Windows directory,
     * then each PATH names.
     *
     * @param {import('./text.js').Width} width @param {number} buffer
     * @param {number} others @param {number} which
     */
    function findOnPath(width, buffer, others, which){
        const file = width.read(buffer);
        if (file === null)
        {
            return 0;
        }
        /** @type {string[]} */
        const directories = [];
        for (let at = wholeAddress(others); at !== 0 && directories.length < 0x400; at += 4)
        {
            const entry = guest.u32(at);
            const directory = entry === 0 ? null : width.read(entry);
            if (directory === null)
            {
                break;
            }
            directories.push(directory);
        }
        const windows = systemPath('GetWindowsDirectoryW');
        const system = systemPath('GetSystemDirectoryW');
        directories.push(...[system, windows === null ? null : `${windows}\\System`, windows]
            .filter(/** @returns {directory is string} */ directory=>directory !== null));
        directories.push(...(environment()?.get('PATH') ?? '').split(';')
            .filter(directory=>directory !== ''));
        for (const directory of directories)
        {
            const candidate = `${directory.replace(/[\\/]+$/, '')}\\${file}`;
            if (candidate.length >= MAX_PATH)
            {
                continue;
            }
            const scratch = host.allocate?.(MAX_PATH * width.unit) ?? 0;
            if (!scratch)
            {
                return 0;
            }
            try
            {
                guest.setBytes(scratch, width.sz(candidate));
                if (withDefaultExtension(width, scratch, candidate, which))
                {
                    write(buffer, width, width.read(scratch) ?? candidate);
                    return 1;
                }
            }
            finally
            {
                host.free?.(scratch);
            }
        }
        return 0;
    }

    /**
     * A directory kernel32 answers into a buffer of its own, or null.
     *
     * @param {'GetWindowsDirectoryW' | 'GetSystemDirectoryW'} name
     */
    function systemPath(name){
        const scratch = host.allocate?.(MAX_PATH * 2) ?? 0;
        if (!scratch)
        {
            return null;
        }
        try
        {
            const length = kernel32(name, [scratch, MAX_PATH]);
            return length !== null && length > 0 && length < MAX_PATH ? W.read(scratch) : null;
        }
        finally
        {
            host.free?.(scratch);
        }
    }

    /**
     * A string value of a key under HKEY_CLASSES_ROOT, or null.
     *
     * @param {string} key @param {string} value
     */
    function classesValue(key, value){
        const get = host.library?.('ADVAPI32.dll')?.RegGetValueW;
        const scratch = get ? host.allocate?.(0x400) ?? 0 : 0;
        if (!get || !scratch)
        {
            return null;
        }
        try
        {
            guest.setBytes(scratch, W.sz(key));
            guest.setBytes(scratch + 0x80, W.sz(value));
            guest.set32(scratch + 0x100, 0x200);
            const status = /** @type {number} */ (get.handler([HKEY_CLASSES_ROOT, scratch,
                scratch + 0x80, RRF_RT_REG_SZ, 0, scratch + 0x104, scratch + 0x100])) >>> 0;
            return status === 0 ? W.read(scratch + 0x104) : null;
        }
        finally
        {
            host.free?.(scratch);
        }
    }

    /**
     * PathMakeSystemFolder and PathUnmakeSystemFolder: a directory's
     * attributes changed as `change` says; FALSE for one that is not there
     * or is no directory.
     *
     * @param {import('./text.js').Width} width @param {number} pointer
     * @param {(attributes: number) => number} change
     */
    function systemFolder(width, pointer, change){
        const suffix = width.wide ? 'W' : 'A';
        const attributes = width.read(pointer) === null ? null
            : kernel32(`GetFileAttributes${suffix}`, [pointer]);
        if (attributes === null || attributes === INVALID_FILE_ATTRIBUTES
            || (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0)
        {
            return 0;
        }
        return kernel32(`SetFileAttributes${suffix}`, [pointer, change(attributes) >>> 0]) ? 1 : 0;
    }

    /**
     * PathSetDlgItemPath's body: the item's client width, the path compacted
     * to it in the screen's font, and the item's text set through user32.
     *
     * @param {import('./text.js').Width} width @param {number} dialog
     * @param {number} id @param {number} pointer
     */
    function setItemPath(width, dialog, id, pointer){
        const user32 = host.library?.('USER32.dll');
        const path = width.read(pointer) ?? '';
        const item = user32?.GetDlgItem ? /** @type {number} */ (user32.GetDlgItem.handler([dialog,
            id])) >>> 0 : 0;
        if (!user32 || item === 0 || !host.allocate)
        {
            return;
        }
        const rect = host.allocate(16 + (MAX_PATH + 1) * width.unit);
        try
        {
            guest.fill(rect, 0, 16);
            user32.GetClientRect?.handler([item, rect]);
            const room = guest.u32(rect + 8) - guest.u32(rect);
            const measure = host.textWidth;
            const text = measure && room > 0
                ? compactPath(path, room, piece=>measure(0, piece)) : path;
            guest.setBytes(rect + 16, width.sz(text));
            user32[`SetWindowText${width.wide ? 'W' : 'A'}`]?.handler([item, rect + 16]);
        }
        finally
        {
            host.free?.(rect);
        }
    }
}

/**
 * PathGetCharType's flags for one character: a short name (8.3) takes every
 * long-name character but a space, a comma and a semicolon.
 *
 * @param {string} char
 */
const charType = char=>{
    const code = char.charCodeAt(0);
    if (code < 0x20 || '<>"|/'.includes(char))
    {
        return GCT_INVALID;
    }
    if (char === '*' || char === '?')
    {
        return GCT_WILD;
    }
    if (char === '\\' || char === ':')
    {
        return GCT_SEPARATOR;
    }
    return GCT_LFNCHAR | (' ,;'.includes(char) ? 0 : GCT_SHORTCHAR);
};
