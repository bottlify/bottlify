/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Windows path semantics: parsing, normalisation, and the wildcard matcher.
 *
 * Nothing here touches a store. It is the half of a filesystem that a program
 * notices only when it is wrong -- a name written as `Config.WTF` and opened as
 * `config.wtf`, a trailing space that survived a string concatenation, a `..`
 * that walks off the top of the volume. Each of those is a lookup that silently
 * finds nothing instead of failing loudly, which is why this file is separate
 * and tested on its own.
 *
 * Deliberately out of scope: UNC shares and the `\\?\` namespaces. This layer
 * mounts drive letters, so anything beginning with two separators is refused
 * rather than half-supported.
 */

import { ErrorCode, fsError } from './errors.js';

/**
 * Names NT reserves for devices, recognised in every directory rather than only
 * at a root -- `C:\Game\nul` is the null device, not a file called `nul`.
 */
export const DEVICE_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(index=>[`COM${index}`, `LPT${index}`]),
]);

/** Both separators divide a path; the canonical one is the backslash. */
const SEPARATORS = /[\\/]/;

/**
 * Characters a name cannot contain. `*` and `?` are absent on purpose: they are
 * legal in an enumeration pattern and rejected by whoever opens a file.
 */
const INVALID_CHARACTERS = /[<>:"|]/;

/** @param {string} name @returns {boolean} */
const usableName = name=>name.length > 0
    && !INVALID_CHARACTERS.test(name)
    && ![...name].some(character=>character.charCodeAt(0) < 0x20);

/**
 * Windows folds case with the invariant mapping, never the user's locale.
 *
 * @param {string} name
 */
export const foldName = name=>name.toLowerCase();

/** @param {string} name */
export const hasWildcard = name=>name.includes('*') || name.includes('?');

/**
 * Strips what Win32 strips from a component before looking it up: trailing dots
 * and spaces. This is what lets a program that built `"file.txt "` by
 * concatenation still find `file.txt`.
 *
 * @param {string} name
 */
function trimComponent(name){
    let end = name.length;
    while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' '))
    {
        end--;
    }
    return name.slice(0, end);
}

/**
 * The device a component names, or null.
 *
 * A device is recognised through an extension and a trailing colon, so `NUL:`,
 * `nul` and `nul.txt` all name the same device.
 *
 * @param {string} component
 * @returns {string | null}
 */
export function deviceName(component){
    const bare = trimComponent(component.replace(/:$/, '').split('.')[0]);
    const upper = bare.toUpperCase();
    return DEVICE_NAMES.has(upper) ? upper : null;
}

/**
 * @typedef {Object} ParsedPath
 * @property {string | null} drive    Upper-case letter, or null when the path names no drive.
 * @property {boolean} rooted         True for `\a` and `C:\a`; false for `a` and `C:a`.
 * @property {string[]} components    `.` and `..` survive; resolution applies them.
 * @property {string | null} device   Set when the path names a reserved device.
 * @property {boolean} wildcard       True when a component holds `*` or `?`.
 */

/**
 * @typedef {Object} ResolvedPath
 * @property {string} drive
 * @property {string[]} components
 * @property {string | null} device
 * @property {boolean} wildcard
 */

/**
 * Parses a path into its parts, without resolving it against anything.
 *
 * @param {string} text
 * @returns {ParsedPath}
 */
export function parsePath(text){
    if (typeof text !== 'string' || text.length === 0)
    {
        throw fsError(ErrorCode.INVALID_PATH, 'An empty path names nothing');
    }

    if (text.startsWith('\\\\?\\'))
    {
        return parseLiteral(text);
    }

    let rest = text;
    /** @type {string | null} */
    let drive = null;
    if (/^[A-Za-z]:/.test(rest))
    {
        drive = rest[0].toUpperCase();
        rest = rest.slice(2);
    }
    else if (SEPARATORS.test(rest[0] ?? '') && SEPARATORS.test(rest[1] ?? ''))
    {
        throw fsError(ErrorCode.INVALID_PATH, `"${text}" addresses a namespace we do not mount`);
    }

    const rooted = SEPARATORS.test(rest[0] ?? '');
    const raw = rest.split(SEPARATORS).filter(part=>part.length > 0);

    // A reserved name is a device wherever it appears, so the directory part of
    // the path is not merely ignored -- it is not consulted at all.
    const device = raw.length > 0 ? deviceName(raw[raw.length - 1]) : null;
    if (device)
    {
        return { drive, rooted, components: [], device, wildcard: false };
    }

    /** @type {string[]} */
    const components = [];
    let wildcard = false;
    for (const part of raw)
    {
        if (part === '.' || part === '..')
        {
            components.push(part);
            continue;
        }
        // A pattern is kept verbatim: trimming would turn `*.` -- which matches
        // names without an extension -- into `*`, which matches everything.
        const name = hasWildcard(part) ? part : trimComponent(part);
        if (!usableName(name))
        {
            throw fsError(ErrorCode.INVALID_PATH, `"${part}" is not a usable path component`);
        }
        wildcard = wildcard || hasWildcard(name);
        components.push(name);
    }

    return { drive, rooted, components, device: null, wildcard };
}

/**
 * A path in the Win32 file namespace, `\\?\C:\a\b`: handed on as written, with
 * none of the parsing a plain path gets -- the backslash alone divides it, a
 * trailing dot or space stays, `.` and `..` are names rather than steps, and a
 * reserved name is a file, not a device. Only a drive under it is mounted here.
 *
 * @param {string} text
 * @returns {ParsedPath}
 */
function parseLiteral(text){
    const after = text.slice(4);
    if (!/^[A-Za-z]:(\\|$)/.test(after))
    {
        throw fsError(ErrorCode.INVALID_PATH, `"${text}" addresses a namespace we do not mount`);
    }
    const components = after.slice(2).split('\\').filter(part=>part.length > 0);
    for (const part of components)
    {
        // `/` is not a divider here but a character, and one no name can hold.
        if (!usableName(part) || part.includes('/') || part === '.' || part === '..')
        {
            throw fsError(ErrorCode.INVALID_PATH, `"${part}" is not a usable path component`);
        }
    }
    return { drive: after[0].toUpperCase(), rooted: true, components, device: null,
        wildcard: components.some(hasWildcard) };
}

/**
 * Applies `.` and `..` to an absolute component list.
 *
 * `..` at a root stays at the root instead of escaping the volume, which is
 * what makes `C:\..\..\Game` and `C:\Game` the same directory.
 *
 * @param {string[]} components
 * @returns {string[]}
 */
export function normalise(components){
    /** @type {string[]} */
    const out = [];
    for (const part of components)
    {
        if (part === '.')
        {
            continue;
        }
        if (part === '..')
        {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out;
}

/**
 * @param {string} drive
 * @param {string[]} components
 * @returns {string} `C:\` for a root, `C:\Game\Data` otherwise.
 */
export function formatPath(drive, components){
    return `${drive}:\\${components.join('\\')}`;
}

/**
 * Splits a path that may end in a search pattern into the directory to
 * enumerate and the pattern to filter it by, which is the shape FindFirstFile
 * hands over.
 *
 * @param {string} text
 * @returns {{ directory: string, pattern: string | null }}
 */
export function splitPattern(text){
    const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
    const last = text.slice(cut + 1);
    if (!hasWildcard(last))
    {
        return { directory: text, pattern: null };
    }
    // The separator is kept so that `C:\*.exe` stays rooted at `C:\`.
    return { directory: cut < 0 ? '.' : text.slice(0, cut + 1), pattern: last };
}

/**
 * Matches one name against one pattern, with the wildcard rules enumeration
 * actually uses on Windows rather than the shell-glob rules that look similar.
 *
 * Three of those rules are not obvious and are the reason this is hand-written:
 *
 * - `*` immediately before a `.` stops at the *last* dot in the name, so `*.`
 *   matches only names with no extension rather than every name.
 * - A `.` that ends the pattern, or that is followed only by a trailing `*`,
 *   also matches nothing at all -- which is why `*.*` matches `readme`.
 * - `?` matches exactly one character, except at the end of the name or
 *   immediately before its last dot, where it may match nothing.
 *
 * @param {string} pattern
 * @param {string} name
 * @returns {boolean}
 */
export function matchName(pattern, name){
    const p = foldName(pattern);
    const n = foldName(name);

    /**
     * @param {number} pi
     * @param {number} ni
     * @returns {boolean}
     */
    const from = (pi, ni)=>{
        let at = pi;
        let cursor = ni;
        while (at < p.length)
        {
            const c = p[at];
            if (c === '*')
            {
                if (p[at + 1] === '.')
                {
                    const dot = n.lastIndexOf('.');
                    return from(at + 1, dot >= cursor ? dot : n.length);
                }
                for (let k = cursor; k <= n.length; k++)
                {
                    if (from(at + 1, k))
                    {
                        return true;
                    }
                }
                return false;
            }
            if (c === '.')
            {
                const optional = at === p.length - 1
                    || (at === p.length - 2 && p[at + 1] === '*');
                if (optional && from(at + 1, cursor))
                {
                    return true;
                }
            }
            else if (c === '?')
            {
                const beforeLastDot = n[cursor] === '.' && n.indexOf('.', cursor + 1) < 0;
                if ((cursor >= n.length || beforeLastDot) && from(at + 1, cursor))
                {
                    return true;
                }
                if (cursor >= n.length)
                {
                    return false;
                }
                at++;
                cursor++;
                continue;
            }
            if (n[cursor] !== c)
            {
                return false;
            }
            at++;
            cursor++;
        }
        return cursor === n.length;
    };

    return from(0, 0);
}

/**
 * The process's current directory, kept the way Win32 keeps it: one current
 * drive, plus a directory remembered separately for every drive visited. That
 * per-drive memory is what makes `C:data` and `D:data` two different files.
 *
 * @param {Object} [options]
 * @param {string} [options.drive]
 * @param {string[]} [options.directory]
 */
export function createDirectoryState({ drive = 'C', directory = [] } = {}){
    /** @type {Map<string, string[]>} */
    const current = new Map([[drive.toUpperCase(), [...directory]]]);
    let active = drive.toUpperCase();

    return {
        drive: ()=>active,

        /** @param {string} letter @returns {string[]} */
        directoryOf(letter){
            return [...(current.get(letter.toUpperCase()) ?? [])];
        },

        /**
         * Moving to a directory on another drive also makes that drive current,
         * which is how a single SetCurrentDirectory call changes both.
         *
         * @param {string} letter @param {string[]} components
         */
        setCurrent(letter, components){
            active = letter.toUpperCase();
            current.set(active, [...components]);
        },

        /**
         * Resolves a path against the current directories into an absolute one.
         *
         * @param {string} text
         * @returns {ResolvedPath}
         */
        resolve(text){
            const parsed = parsePath(text);
            const letter = parsed.drive ?? active;
            const base = parsed.rooted ? [] : (current.get(letter) ?? []);
            return {
                drive: letter,
                components: normalise([...base, ...parsed.components]),
                device: parsed.device,
                wildcard: parsed.wildcard,
            };
        },
    };
}
