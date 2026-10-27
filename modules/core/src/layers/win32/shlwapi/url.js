/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi's URL functions: escapes, the parts of a URL, a URL made from a
 * path, and the canonical and combined forms a browser control or an update
 * check builds its addresses with.
 *
 * The rules are written from MSDN and from Wine's shlwapi URL tests, which
 * record Windows' answers. Those tables come from a later shlwapi than this
 * machine's, and only their common cases are followed: the scheme and an
 * http-like host in lower case, backslashes read as slashes in the schemes
 * that read them so, `.` and `..` resolved before any `?` or `#` and never
 * past the host or a drive, a drive or UNC path made a `file:` URL with its
 * unsafe characters escaped, and the escape flags. What the tables record
 * past that -- a `#` after an `.htm` file, `mk:` compound stores, the
 * URL_FILE_USE_PATHURL and URL_WININET_COMPATIBILITY forms, reordering a
 * `?` after a `#` -- is not followed.
 */

import { hasScheme } from './path.js';
import { dword, u32 } from './text.js';
import { applyScheme, escapeUrl, hashData, parseUrl, urlPart, URL_ESCAPE_AS_UTF8 }
    from './url-parts.js';
import { encodeAnsi } from '../kernel32/locale.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const E_FAIL = 0x80004005 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const URL_E_INVALID_SYNTAX = 0x80041001 | 0;
/** PARSEDURL: its size, the protocol and its length, the suffix and its length, the scheme. */
const PARSEDURL_SIZE = 24;

const URL_ESCAPE_PERCENT = 0x00001000;
const URL_UNESCAPE_INPLACE = 0x00100000;
const URL_DONT_ESCAPE_EXTRA_INFO = 0x02000000;
const URL_ESCAPE_SPACES_ONLY = 0x04000000;
const URL_DONT_SIMPLIFY = 0x08000000;
const URL_UNESCAPE = 0x10000000;
const URL_ESCAPE_UNSAFE = 0x20000000;

/** UrlIs's questions. */
const URLIS_URL = 0;
const URLIS_OPAQUE = 1;
const URLIS_NOHISTORY = 2;
const URLIS_FILEURL = 3;
const URLIS_APPLIABLE = 4;
const URLIS_DIRECTORY = 5;
const URLIS_HASQUERY = 6;

/** The schemes whose rest is no path, and is left as it is. */
const OPAQUE = new Set(['about', 'javascript', 'mailto', 'shell', 'vbscript']);

/** The schemes with a host, whose host is case-insensitive and lowered. */
const HOSTED = new Set(['ftp', 'gopher', 'http', 'https', 'local', 'news', 'nntp', 'res',
    'snews', 'telnet', 'wais']);

/** Of those, the ones that keep a backslash as it is rather than read it as a slash. */
const KEEPS_BACKSLASH = new Set(['ftp', 'local', 'res', 'wais']);

/**
 * What URL_ESCAPE_UNSAFE escapes (Wine's url tests, against Windows): space
 * and the control characters, and `"&<>[]^`{|}`. A `%` is escaped as well
 * where a path becomes a URL, and with URL_ESCAPE_PERCENT.
 */
const UNSAFE_MARKS = new Set([...'"&<>[]^`{|}']);

/** @param {string} c */
const isUnsafe = c=>c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) === 0x7f || UNSAFE_MARKS.has(c);

/** @param {string} char */
const escapeOf = char=>`%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * A string with its %XX escapes decoded; with `extraInfo` false, what follows
 * the first ? or # is left as it is. `char` turns a code into a character of
 * the caller's spelling: a byte of the ANSI page, or a UTF-16 unit.
 *
 * @param {string} url @param {boolean} extraInfo @param {(code: number) => string} char
 */
export const unescapeUrl = (url, extraInfo, char)=>{
    let out = '';
    let escaping = true;
    for (let at = 0; at < url.length; at++)
    {
        const c = url[at];
        if (!extraInfo && (c === '?' || c === '#'))
        {
            escaping = false;
        }
        if (escaping && c === '%' && /^[0-9A-Fa-f]{2}$/.test(url.slice(at + 1, at + 3)))
        {
            out += char(parseInt(url.slice(at + 1, at + 3), 16));
            at += 2;
            continue;
        }
        out += c;
    }
    return out;
};

/**
 * Characters escaped where `test` says.
 *
 * @param {string} text @param {(c: string) => boolean} test
 */
const escapeWhere = (text, test)=>[...text].map(c=>(test(c) ? escapeOf(c) : c)).join('');

/** @param {string} c */
const unsafeOrPercent = c=>isUnsafe(c) || c === '%';

/** @param {string} text */
const trimmed = text=>{
    let start = 0;
    let end = text.length;
    while (start < end && text.charCodeAt(start) <= 0x20)
    {
        start++;
    }
    while (end > start && text.charCodeAt(end - 1) <= 0x20)
    {
        end--;
    }
    return text.slice(start, end);
};

/**
 * A drive or a UNC path, which a URL function reads as a file.
 *
 * @param {string} text
 */
const isDosPath = text=>/^[A-Za-z]:/.test(text) || text.startsWith('\\\\');

/**
 * The scheme of a URL, lowered, and what follows its colon; null when it
 * has none.
 *
 * @param {string} url
 * @returns {{ scheme: string, rest: string } | null}
 */
export const parseScheme = url=>{
    if (!hasScheme(url))
    {
        return null;
    }
    const colon = url.indexOf(':');
    return { scheme: url.slice(0, colon).toLowerCase(), rest: url.slice(colon + 1) };
};

/**
 * A URL made of a drive or UNC path: its backslashes slashes, a drive after
 * `file:///` and a server after `file://`, a relative path after `file:`.
 * Unsafe characters and the percent sign are escaped unless `escape` is
 * false.
 *
 * @param {string} path @param {boolean} escape
 */
export const fileUrlOf = (path, escape)=>{
    const slashed = path.replace(/\\/g, '/');
    const body = escape ? escapeWhere(slashed, unsafeOrPercent) : slashed;
    if (/^[A-Za-z]:/.test(path))
    {
        return `file:///${body}`;
    }
    if (path.startsWith('\\\\'))
    {
        return `file:${body}`;
    }
    return path.startsWith('\\') ? `file://${body}` : `file:${body}`;
};

const URL_FILE_USE_PATHURL = 0x00010000;
const URL_WININET_COMPATIBILITY = 0x80000000;

/**
 * A `file:` URL's parts as UrlCanonicalize reads them: where the path is
 * rooted -- at a server, at the volume's root, at a drive, or nowhere -- and
 * the path after that root, its separators either slash.
 *
 * @typedef {Object} FileParts
 * @property {'unc' | 'rooted' | 'drive' | 'relative'} kind
 * @property {string} host   The server, for 'unc'.
 * @property {string} drive  `x:` or `x|`, for 'drive'.
 * @property {string} path   What follows the root, from its first separator on.
 */

/** @param {string} text  A drive's two characters, and nothing else, or not. */
const isDrive = text=>/^[A-Za-z][:|]$/.test(text);

/**
 * The parts of what follows `file:`: no separator is a relative path, one
 * or three are rooted at the volume, two name a server and four or more a
 * server too; a drive wherever the root or the server would be is the root.
 * `localhost` is no server in the path forms -- what follows it is read
 * again, three separators naming a server and fewer the volume's root.
 *
 * @param {string} body @param {boolean} pathForm
 * @returns {FileParts}
 */
const fileParts = (body, pathForm)=>{
    const lead = /^[\\/]*/.exec(body)?.[0].length ?? 0;
    const rest = body.slice(lead);
    const drive = /^[A-Za-z][:|]/.exec(rest)?.[0];
    const driveRooted = drive !== undefined && (rest.length === 2 || /^..[\\/]/.test(rest)
        || lead !== 2);
    if (drive !== undefined && driveRooted && lead !== 2)
    {
        return { kind: 'drive', host: '', drive, path: rest.slice(2) };
    }
    if (lead === 0)
    {
        return { kind: 'relative', host: '', drive: '', path: rest };
    }
    if (lead === 1 || lead === 3 || (lead >= 2 && rest === ''))
    {
        return { kind: 'rooted', host: '', drive: '', path: `/${rest}` };
    }
    const end = rest.search(pathForm ? /[\\/?]/ : /[\\/]/);
    const host = end < 0 ? rest : rest.slice(0, end);
    const path = end < 0 ? '' : rest.slice(end);
    if (host === '')
    {
        return { kind: 'rooted', host: '', drive: '', path };
    }
    if (isDrive(host))
    {
        return { kind: 'drive', host: '', drive: host, path };
    }
    if (pathForm && host.toLowerCase() === 'localhost')
    {
        const again = /^[\\/]*/.exec(path)?.[0].length ?? 0;
        const after = path.slice(again);
        if (/^[A-Za-z][:|]/.test(after))
        {
            return { kind: 'drive', host: '', drive: after.slice(0, 2), path: after.slice(2) };
        }
        return again >= 3 ? fileParts(`//${after}`, pathForm)
            : { kind: 'rooted', host: '', drive: '', path: after === '' && again === 0 ? ''
                : `/${after}` };
    }
    return { kind: 'unc', host, drive: '', path };
};

/**
 * Where a `file:` path stops being a path: a `#` straight after `.htm` or
 * `.html` begins a fragment in every form, and in the path forms the first
 * `?` a query. -1 when it does not stop.
 *
 * @param {string} path @param {boolean} pathForm
 */
const fileExtraAt = (path, pathForm)=>{
    const fragment = /\.html?#/i.exec(path);
    const at = fragment ? fragment.index + fragment[0].length - 1 : -1;
    const query = pathForm ? path.indexOf('?') : -1;
    return at < 0 ? query : query < 0 ? at : Math.min(at, query);
};

/**
 * A `file:` path's dot elements resolved: `.` goes, `..` undoes the element
 * before it but never the root; one with nothing to undo goes in the URL
 * form and stays in the path forms. An element that is a dot and then a `#`
 * or `?` is that dot in the URL form. A path whose last element was a dot
 * ends in a separator, unless nothing at all is left of a relative one.
 *
 * @param {string[]} elements @param {{ keepExcess: boolean, splitMarks: boolean,
 *     relative: boolean }} rules
 */
const resolveFileDots = (elements, rules)=>{
    /** @type {string[]} */
    const kept = [];
    let excess = 0;
    elements.forEach((element, index)=>{
        const marked = rules.splitMarks ? /^(\.\.?)([#?].*)$/.exec(element) : null;
        const dot = marked ? marked[1] : element;
        const last = index === elements.length - 1 || marked !== null;
        if (dot !== '.' && dot !== '..')
        {
            kept.push(element);
            return;
        }
        if (dot === '..')
        {
            if (kept.length > excess)
            {
                kept.pop();
            }
            else if (rules.keepExcess)
            {
                kept.push('..');
                excess++;
            }
        }
        if (marked)
        {
            kept.push(marked[2]);
        }
        else if (last && !(rules.relative && kept.length === 0))
        {
            kept.push('');
        }
    });
    return kept;
};

/**
 * UrlCanonicalize's answer for a `file:` URL, or a path that becomes one
 * (Wine's test_UrlCanonicalizeA file cases, against Windows). The URL form
 * keeps slashes and leaves alone a path whose first element is a dot or
 * that starts with a `#` or `?`; URL_FILE_USE_PATHURL and
 * URL_WININET_COMPATIBILITY write the path the URL names, with
 * backslashes, after `file://`, the first unescaped and without its query,
 * the second keeping the query as it was.
 *
 * @param {string} input @param {number} flags
 * @param {(code: number) => string} char
 */
const canonicalizeFileUrl = (input, flags, char)=>{
    const url = trimmed(input);
    const pathUrl = (flags & URL_FILE_USE_PATHURL) !== 0;
    const wininet = (flags & URL_WININET_COMPATIBILITY) !== 0 && !pathUrl;
    const pathForm = pathUrl || (flags & URL_WININET_COMPATIBILITY) !== 0;
    const simplifying = (flags & URL_DONT_SIMPLIFY) === 0;
    const fromPath = isDosPath(url) || /^[A-Za-z]\|/.test(url);
    let body = fromPath ? url : url.slice(url.indexOf(':') + 1);
    if (fromPath && /^[A-Za-z][:|]/.test(body))
    {
        body = `///${body}`;
    }
    if (fromPath && !pathForm && (flags & URL_UNESCAPE) === 0)
    {
        body = escapeWhere(body, unsafeOrPercent);
    }
    const parts = fileParts(body, pathForm);
    let path = parts.path;
    const extraAt = fileExtraAt(path, pathForm);
    let extra = extraAt < 0 ? '' : path.slice(extraAt);
    path = extraAt < 0 ? path : path.slice(0, extraAt);
    // The URL form leaves a path alone whose first element is a dot, or that
    // starts with a `#` or `?` within two separators of its root.
    // A drive as a server's first element is the root after it.
    const hostDrive = parts.kind === 'unc' ? /^[\\/][A-Za-z][:|](?=[\\/]|$)/.exec(path)?.[0] ?? ''
        : '';
    const guarded = !pathForm && parts.kind !== 'relative'
        && (/^[\\/]{1,2}[#?]/.test(path) || /^[\\/](\.\.?)(?:[\\/]|$)/.test(path)
            || (parts.kind === 'drive' && /^(\.\.?)(?:[\\/]|$)/.test(path))
            || (hostDrive !== '' && /^[\\/](\.\.?)(?:[\\/]|$)/.test(path.slice(hostDrive.length))));
    const mark = guarded ? path.search(/[#?]/) : -1;
    if (mark >= 0)
    {
        extra = path.slice(mark) + extra;
        path = path.slice(0, mark);
    }
    path = path.replace(/\\/g, '/');
    if (pathForm && path.indexOf('#') >= 0)
    {
        // After a `#` that is the path's own, a backslash is a slash all the same.
        path = path.replace(/\\/g, '/');
    }
    const rootless = parts.kind === 'relative' || (parts.kind === 'drive' && !path.startsWith('/'));
    // A drive-relative path is rooted at its first element in the path forms.
    const anchor = parts.kind === 'drive' && pathForm && rootless
        ? /^[^/]*/.exec(path)?.[0] ?? '' : hostDrive.replace(/\\/g, '/');
    let tail = path.slice(anchor.length);
    const rooted = tail.startsWith('/');
    const alone = tail === '/' || tail === '';
    let elements = (rooted ? tail.slice(1) : tail).split('/');
    if (tail === '' || (rooted && tail === '/'))
    {
        elements = [];
    }
    if (simplifying && !guarded)
    {
        elements = resolveFileDots(elements, { keepExcess: pathForm,
            splitMarks: !pathForm, relative: rootless && anchor === '' });
    }
    else if (pathForm && /^\.\.?$/.test(elements.at(-1) ?? ''))
    {
        elements = [...elements, ''];
    }
    const hostRoot = parts.kind === 'unc';
    tail = `${rooted || (hostRoot && elements.length > 0) ? '/' : ''}${elements.join('/')}`;
    if (anchor !== '' && elements.length > 0 && !rooted)
    {
        tail = `/${tail}`;
    }
    path = anchor + tail;
    // A drive in the path's first element is a root a `..` does not undo.
    if (!pathForm)
    {
        let head;
        switch (parts.kind)
        {
            case 'unc': head = `//${parts.host}`; break;
            case 'rooted': head = '//'; break;
            case 'drive': head = `///${parts.drive}`; break;
            default: head = ''; break;
        }
        if (parts.kind === 'unc' || parts.kind === 'rooted')
        {
            path ||= '/';
        }
        /** @param {string} text */
        const escaped = text=>{
            let out = (flags & URL_UNESCAPE) !== 0 ? unescapeUrl(text, true, char) : text;
            if ((flags & URL_ESCAPE_SPACES_ONLY) !== 0)
            {
                out = out.replace(/ /g, '%20');
            }
            else if ((flags & URL_ESCAPE_UNSAFE) !== 0)
            {
                const percent = (flags & URL_ESCAPE_PERCENT) !== 0;
                out = escapeWhere(out, c=>isUnsafe(c) || (percent && c === '%'));
            }
            return out;
        };
        const extraOut = (flags & URL_DONT_ESCAPE_EXTRA_INFO) !== 0 ? extra : escaped(extra);
        return `file:${escaped(head + path)}${extraOut}`;
    }
    let head;
    switch (parts.kind)
    {
        case 'unc': head = `\\\\${parts.host}`; break;
        case 'drive': head = parts.drive; break;
        default: head = ''; break;
    }
    if (pathUrl && alone && !(simplifying && elements.length > 0) && parts.kind !== 'drive')
    {
        path = '';
    }
    else if (wininet && path === '' && parts.kind !== 'relative' && parts.kind !== 'drive')
    {
        path = '/';
    }
    // Past the first `#`, the host's own included, a slash stays a slash.
    const whole = head + path;
    const hash = whole.indexOf('#', head.startsWith('\\\\') ? 2 : 0);
    const before = hash < 0 ? whole : whole.slice(0, hash);
    const after = hash < 0 ? '' : whole.slice(hash);
    let dos = before.replace(/\//g, '\\') + after;
    // A fragment the path's `.html` began goes after the query that follows it.
    const at = extra.startsWith('#') ? extra.indexOf('?') : 0;
    const fragment = at < 0 ? extra : extra.slice(0, at);
    const query = at < 0 ? '' : extra.slice(at);
    if (pathUrl)
    {
        dos = unescapeUrl(dos, true, char);
        return `file://${dos}`;
    }
    if ((flags & URL_UNESCAPE) !== 0)
    {
        dos = unescapeUrl(dos, true, char);
    }
    const prefix = parts.kind === 'relative' ? 'file:' : 'file://';
    return `${prefix}${dos}${query}${fragment}`;
};

/** The schemes UrlCanonicalize reads a backslash in as a slash. */
const CANON_SLASHED = new Set(['gopher', 'http', 'https', 'news', 'nntp', 'snews', 'telnet']);
/** The schemes it keeps a backslash in, reading it as a separator all the same. */
const CANON_BACKSLASHED = new Set(['ftp', 'local', 'res', 'wais']);

/**
 * @typedef {Object} DotRules
 * @property {boolean | 'dots'} backslash
 *           A backslash separates elements too, and is kept; 'dots', only
 *           before a dot element that a slash or the end closes.
 * @property {boolean} keepExcess  A `..` with nothing to undo stays, rather than going.
 * @property {boolean} guarded     A first element that is a dot leaves the path as it is.
 */

/**
 * A path's dot elements resolved: a `.` goes, a `..` undoes the element
 * before it -- never one it could not undo, which stays or goes as the
 * scheme's rules say -- and a path whose last element was a dot ends in a
 * separator. Each element keeps the separator that followed it.
 *
 * @param {string} path  What follows the host, or the root, or the scheme.
 * @param {DotRules} rules
 * @param {boolean} simplifying  False for URL_DONT_SIMPLIFY: only the trailing separator.
 */
const resolveDots = (path, rules, simplifying)=>{
    const parts = rules.backslash === true ? path.split(/(?<=[/\\])/)
        : path.split(/(?<=\/)/).flatMap(part=>(rules.backslash === 'dots'
            ? part.split(/(?<=\\)(?=\.\.?\/?$)/) : [part]));
    /** @type {{ text: string, separator: string }[]} */
    const elements = parts.map((part, at)=>{
        // A backslash the 'dots' split left at a part's end is the separator
        // before a dot; any other stays in the element's text.
        const next = parts[at + 1]?.replace(/\/$/, '');
        const backslash = rules.backslash === true
            || (rules.backslash === 'dots' && (next === '.' || next === '..'));
        const separator = part.endsWith('/') || (backslash && part.endsWith('\\'))
            ? part.slice(-1) : '';
        return { text: part.slice(0, part.length - separator.length), separator };
    });
    if (path === '')
    {
        return '';
    }
    const last = elements.at(-1);
    const dotLast = last !== undefined && (last.text === '.' || last.text === '..')
        && last.separator === '';
    // The guard reads the first element between slashes, whatever a
    // backslash in it does.
    const first = path.split('/')[0];
    if (!simplifying || (rules.guarded && (first === '.' || first === '..')))
    {
        return dotLast && rules.keepExcess ? `${path}/` : path;
    }
    /** @type {{ text: string, separator: string, fixed: boolean }[]} */
    const kept = [];
    elements.forEach(element=>{
        if (element.text === '.')
        {
            return;
        }
        if (element.text === '..')
        {
            const top = kept.at(-1);
            if (top && !top.fixed)
            {
                kept.pop();
            }
            else if (rules.keepExcess)
            {
                kept.push({ ...element, fixed: true });
            }
            return;
        }
        kept.push({ ...element, fixed: false });
    });
    const text = kept.map(element=>element.text + element.separator).join('');
    const top = kept.at(-1);
    return dotLast && top !== undefined && top.separator === '' ? `${text}/` : text;
};

/**
 * UrlCanonicalize's answer.
 *
 * Each scheme's family reads a path its own way (Wine's
 * test_UrlCanonicalizeA, against Windows): one that is not known, or no
 * scheme at all, keeps a `..` it cannot undo and moves a query before a
 * fragment that came first; the hosted ones read a backslash as a slash,
 * drop a `..` that would climb past the host and leave a path that starts
 * with a dot alone; the ftp-like ones are those but keep a backslash, and a
 * `file:` URL is a path's. The host of a `//` URL is never simplified, and a
 * slash always follows it. After the first `?` or `#` nothing is simplified.
 *
 * @param {string} input @param {number} flags
 * @param {(code: number) => string} char
 */
export const canonicalizeUrl = (input, flags, char)=>{
    const url = trimmed(input.replace(/[\t\n\r]/g, ''));
    const parsed = isDosPath(url) ? null : parseScheme(url);
    if (isDosPath(url) || /^[A-Za-z]\|/.test(url) || parsed?.scheme === 'file')
    {
        return canonicalizeFileUrl(url, flags, char);
    }
    const simplifying = (flags & URL_DONT_SIMPLIFY) === 0;
    const scheme = parsed?.scheme ?? null;
    const opaque = scheme !== null && OPAQUE.has(scheme);
    const slashed = scheme !== null && CANON_SLASHED.has(scheme);
    const backslashed = scheme !== null && CANON_BACKSLASHED.has(scheme);
    const hosted = slashed || backslashed;
    let rest = parsed ? parsed.rest : url;
    let main = rest;
    let extra = '';
    if (scheme === 'mk')
    {
        main = canonicalMk(rest, simplifying);
    }
    else if (!opaque)
    {
        const split = rest.search(/[?#]/);
        main = split < 0 ? rest : rest.slice(0, split);
        extra = split < 0 ? '' : rest.slice(split);
        const query = extra.indexOf('?');
        if (!hosted && extra.startsWith('#') && query > 0)
        {
            extra = extra.slice(query) + extra.slice(0, query);
        }
        if (slashed)
        {
            main = main.replace(/\\/g, '/');
        }
        /** @type {DotRules} */
        const rules = { backslash: backslashed, keepExcess: !hosted, guarded: hosted };
        const twoSlashes = hosted ? /^[/\\]{2}/ : /^\/\//;
        if (twoSlashes.test(main))
        {
            const after = main.slice(2);
            const end = after.indexOf('/');
            const host = end < 0 ? after : after.slice(0, end);
            const path = end < 0 ? '' : after.slice(end + 1);
            main = `${main.slice(0, 2)}${hosted ? host.toLowerCase() : host}/`
                + resolveDots(path, rules, simplifying);
        }
        else if (main.startsWith('/'))
        {
            // A backslash right after the root is passed over: it is no separator.
            const path = !hosted && main[1] === '\\' ? main.slice(2) : main.slice(1);
            main = hosted ? resolveDots(main, rules, simplifying)
                : `/${resolveDots(path, rules, simplifying)}`;
        }
        else if (scheme === null)
        {
            const resolved = resolveDots(main, rules, simplifying);
            main = resolved === '' && main !== '' && simplifying ? '/' : resolved;
        }
        else if (hosted)
        {
            main = resolveDots(main, { ...rules, guarded: false }, simplifying);
        }
        else if (main === '.' && simplifying)
        {
            main = '';
        }
    }
    rest = main;
    const head = parsed ? `${scheme}:` : '';
    return `${head}${escapeParts(rest, flags, char, opaque)}`
        + `${(flags & URL_DONT_ESCAPE_EXTRA_INFO) !== 0 ? extra
            : escapeParts(extra, flags, char, opaque)}`;
};

/**
 * What follows `mk:`: an `@` moniker's name up to the first slash is its
 * host, never simplified and always followed by a slash; a path is
 * simplified up to the first `?` or `#`, a `..` with nothing to undo
 * dropped, and a backslash is a separator only before a dot element.
 *
 * @param {string} rest @param {boolean} simplifying
 */
const canonicalMk = (rest, simplifying)=>{
    /** @type {DotRules} */
    const rules = { backslash: 'dots', keepExcess: false, guarded: false };
    if (rest.startsWith('@'))
    {
        const end = rest.indexOf('/');
        const host = end < 0 ? rest : rest.slice(0, end);
        const after = end < 0 ? '' : rest.slice(end + 1);
        const split = after.search(/[?#]/);
        const path = split < 0 ? after : after.slice(0, split);
        return `${host}/${resolveDots(path, { ...rules, guarded: true }, simplifying)}`
            + (split < 0 ? '' : after.slice(split));
    }
    const split = rest.search(/[?#]/);
    const path = split < 0 ? rest : rest.slice(0, split);
    return resolveDots(path, rules, simplifying) + (split < 0 ? '' : rest.slice(split));
};

/**
 * The flags' escaping and unescaping of a part of a canonical URL.
 *
 * @param {string} text @param {number} flags @param {(code: number) => string} char
 * @param {boolean} opaque
 */
const escapeParts = (text, flags, char, opaque)=>{
    let out = (flags & URL_UNESCAPE) !== 0 ? unescapeUrl(text, true, char) : text;
    if ((flags & URL_ESCAPE_SPACES_ONLY) !== 0 && !opaque)
    {
        out = out.replace(/ /g, '%20');
    }
    else if ((flags & URL_ESCAPE_UNSAFE) !== 0)
    {
        const percent = (flags & URL_ESCAPE_PERCENT) !== 0;
        out = escapeWhere(out, c=>isUnsafe(c) || (percent && c === '%'));
    }
    return out;
};

/**
 * UrlCombine's answer: the relative URL resolved against the base, then
 * made canonical. A relative URL with a scheme of its own stands alone
 * unless the scheme is the base's and what follows it is a relative path; a
 * drive or UNC path stands alone as a file URL; `//` keeps only the base's
 * scheme, `/` its host, `?` its path and `#` its query; and a relative path
 * replaces the base's last segment -- or, where the base has neither a host
 * nor a rooted path, everything after its scheme.
 *
 * @param {string} base @param {string} relative @param {number} flags
 * @param {(code: number) => string} char
 */
export const combineUrl = (base, relative, flags, char)=>{
    /** @param {string} url */
    const canonical = url=>canonicalizeUrl(url, flags, char);
    let from = trimmed(base);
    let to = trimmed(relative);
    if (isDosPath(to))
    {
        return canonical(to);
    }
    // The base is made canonical first, so that its last segment is the one
    // its dots leave: `a/b/..` is the directory `a/`.
    from = canonicalizeUrl(from, flags & URL_DONT_SIMPLIFY, char);
    const target = parseScheme(to);
    const origin = parseScheme(from);
    if (target)
    {
        if (!origin || target.scheme !== origin.scheme || OPAQUE.has(target.scheme)
            || /^[\\/]/.test(target.rest))
        {
            return canonical(to);
        }
        to = target.rest;
    }
    if (!origin)
    {
        return canonical(to);
    }
    const scheme = `${origin.scheme}:`;
    // A file URL's `#` is part of its path but after `.htm` or `.html`.
    const split = origin.scheme === 'file' ? fileExtraAt(origin.rest, false)
        : origin.rest.search(/[?#]/);
    let main = split < 0 ? origin.rest : origin.rest.slice(0, split);
    const extra = split < 0 ? '' : origin.rest.slice(split);
    if (origin.scheme === 'file' || (HOSTED.has(origin.scheme)
        && !KEEPS_BACKSLASH.has(origin.scheme)))
    {
        main = main.replace(/\\/g, '/');
    }
    const hostEnd = main.startsWith('//') ? main.indexOf('/', 2) : 0;
    const authority = hostEnd < 0 ? main : main.slice(0, hostEnd);
    const path = hostEnd < 0 ? '' : main.slice(hostEnd);
    if (to === '')
    {
        return canonical(from);
    }
    // An mk: URL's path starts after the `::` that ends its store; a
    // relative URL naming a store of its own stands alone.
    const store = origin.scheme === 'mk' ? main.indexOf('::') : -1;
    if (store >= 0)
    {
        if (to.includes('::'))
        {
            return canonical(`${scheme}${to}`);
        }
        const root = main.slice(0, store + 2);
        const inStore = main.slice(store + 2);
        return canonical(/^[\\/]/.test(to) ? `${scheme}${root}${to}`
            : `${scheme}${root}${inStore.slice(0, inStore.lastIndexOf('/') + 1)}${to}`);
    }
    if (to.startsWith('//') || to.startsWith('\\\\'))
    {
        return canonical(`${scheme}${to}`);
    }
    if (to.startsWith('/') || to.startsWith('\\'))
    {
        return canonical(`${scheme}${authority}${to}`);
    }
    if (to.startsWith('?'))
    {
        return canonical(`${scheme}${main}${to}`);
    }
    if (to.startsWith('#'))
    {
        const hash = extra.indexOf('#');
        const query = !extra.startsWith('?') ? '' : hash < 0 ? extra : extra.slice(0, hash);
        return canonical(`${scheme}${main}${query}${to}`);
    }
    if (authority === '' && !path.startsWith('/'))
    {
        return canonical(`${scheme}${to}`);
    }
    const directory = path.slice(0, path.lastIndexOf('/') + 1) || '/';
    return canonical(`${scheme}${authority}${directory}${to}`);
};

/**
 * UrlIs's answer for one question.
 *
 * @param {string} url @param {number} question
 * @returns {boolean | null} null for a question this does not answer
 */
export const urlIs = (url, question)=>{
    const parsed = parseScheme(url);
    switch (question){
        case URLIS_URL:
            return parsed !== null;
        case URLIS_OPAQUE:
            return parsed !== null && OPAQUE.has(parsed.scheme);
        case URLIS_NOHISTORY:
            return parsed !== null && OPAQUE.has(parsed.scheme);
        case URLIS_FILEURL:
            return parsed?.scheme === 'file';
        case URLIS_DIRECTORY:
            return /[\\/]$/.test(url);
        case URLIS_HASQUERY:
            return parsed !== null && parsed.rest.split('#')[0].includes('?');
        default:
            return null;
    }
};

/**
 * Where UrlGetLocation's answer starts: the first `?` or `#` after a URL's
 * scheme, a file URL's `#` only, its query being part of the file's name
 * (MSDN); null for no location, or no URL.
 *
 * @param {string} url
 * @returns {number | null}
 */
export const locationIndex = url=>{
    const parsed = parseScheme(url);
    if (!parsed)
    {
        return null;
    }
    const offset = url.length - parsed.rest.length;
    const found = parsed.rest.search(parsed.scheme === 'file' ? /#/ : /[?#]/);
    return found < 0 ? null : offset + found;
};

/**
 * @typedef {Object} UrlHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {UrlHost} host
 * @param {{ A: import('./text.js').Width, W: import('./text.js').Width }} widths
 */
export function createUrlFunctions(host, { A, W }){
    /** @param {string} name @param {number} argBytes
     *  @param {(width: import('./text.js').Width, args: number[]) => number} body */
    const both = (name, argBytes, body)=>({
        [`${name}A`]: { argBytes, handler: (/** @type {number[]} */ args)=>body(A, args) },
        [`${name}W`]: { argBytes, handler: (/** @type {number[]} */ args)=>body(W, args) },
    });

    /** @param {number} address */
    const countAt = address=>((address >>> 0) === 0 || !host.readMemory
        ? null : u32(host.readMemory(address >>> 0, 4)));

    /**
     * An answer into a buffer the caller counts the room of: written, with
     * its length, when it fits with its terminator; otherwise E_POINTER and
     * the room it needs, the buffer untouched. `success` is the HRESULT a
     * fit answers.
     *
     * @param {import('./text.js').Width} width @param {string} text
     * @param {number} buffer @param {number} count @param {number} room
     * @param {number} [success]
     */
    const answer = (width, text, buffer, count, room, success = S_OK)=>{
        if (text.length < room && (buffer >>> 0) !== 0)
        {
            host.writeMemory(buffer >>> 0, width.sz(text));
            host.writeMemory(count >>> 0, dword(text.length));
            return success;
        }
        if (text.length < room)
        {
            return E_INVALIDARG;
        }
        host.writeMemory(count >>> 0, dword(text.length + 1));
        return E_POINTER;
    };

    /** Said once: HashData's table is not Windows'. */
    let ownTable = false;
    /** @param {Uint8Array} input @param {number} size */
    const hash = (input, size)=>{
        if (!ownTable)
        {
            ownTable = true;
            host.divergence?.('HashData', 'a permutation of our own: the hash differs from '
                + 'Windows\'');
        }
        return hashData(input, size);
    };

    /**
     * An answer UrlGetPart and UrlApplyScheme count without the terminator
     * on success and with it when the room is short; the buffer is left
     * alone then.
     *
     * @param {import('./text.js').Width} width @param {string} text @param {number} buffer
     * @param {number} count @param {number} success
     */
    const counted = (width, text, buffer, count, success)=>{
        const room = /** @type {number} */ (countAt(count));
        if (text.length >= room)
        {
            host.writeMemory(count >>> 0, dword(text.length + 1));
            return E_POINTER;
        }
        host.writeMemory(buffer >>> 0, width.sz(text));
        host.writeMemory(count >>> 0, dword(text.length));
        return success;
    };

    /** Said once, the first time a URL is asked a question not answered here. */
    let unanswered = false;

    return {
        /**
         * HRESULT UrlUnescapeA(LPSTR pszUrl, LPSTR pszUnescaped,
         *                      LPDWORD pcchUnescaped, DWORD dwFlags)
         *
         * In place with URL_UNESCAPE_INPLACE, the count neither needed nor
         * touched. Otherwise into the buffer while it has room: the count is
         * then the characters written, or with E_POINTER the room the whole
         * answer and its terminator need; no buffer or no count is
         * E_INVALIDARG (Wine's test_UrlUnescape).
         */
        ...both('UrlUnescape', 16, (width, [pointer, output, count, flags])=>{
            const url = width.read(pointer);
            if (url === null)
            {
                return E_INVALIDARG;
            }
            const result = unescapeUrl(url, ((flags >>> 0) & URL_DONT_ESCAPE_EXTRA_INFO) === 0,
                width.char);
            if (((flags >>> 0) & URL_UNESCAPE_INPLACE) !== 0)
            {
                host.writeMemory(pointer >>> 0, width.sz(result));
                return S_OK;
            }
            const room = countAt(count);
            if ((output >>> 0) === 0 || room === null)
            {
                return E_INVALIDARG;
            }
            return answer(width, result, output, count, room);
        }),

        /**
         * HRESULT UrlCanonicalizeA(PCSTR pszUrl, PSTR pszCanonicalized,
         *                          DWORD *pcchCanonicalized, DWORD dwFlags)
         *
         * `canonicalizeUrl`. No URL, no buffer, no count or a count of zero
         * is E_INVALIDARG with the count untouched (Wine's
         * test_UrlCanonicalizeA).
         */
        ...both('UrlCanonicalize', 16, (width, [pointer, output, count, flags])=>{
            const url = width.read(pointer);
            const room = countAt(count);
            if (url === null || (output >>> 0) === 0 || room === null || room === 0)
            {
                return E_INVALIDARG;
            }
            return answer(width, canonicalizeUrl(url, flags >>> 0, width.char), output, count,
                room);
        }),

        /**
         * HRESULT UrlCombineA(PCSTR pszBase, PCSTR pszRelative, PSTR pszCombined,
         *                     DWORD *pcchCombined, DWORD dwFlags)
         *
         * `combineUrl`. No count is E_INVALIDARG; no buffer, or one too small,
         * E_POINTER and the room needed (Wine's test_UrlCombine).
         */
        ...both('UrlCombine', 20, (width, [base, relative, output, count, flags])=>{
            const from = width.read(base);
            const to = width.read(relative);
            const room = countAt(count);
            if (from === null || to === null || room === null)
            {
                return E_INVALIDARG;
            }
            return answer(width, combineUrl(from, to, flags >>> 0, width.char), output, count,
                (output >>> 0) === 0 ? 0 : room);
        }),

        /**
         * HRESULT UrlCreateFromPathA(PCSTR pszPath, PSTR pszUrl, DWORD *pcchUrl,
         *                            DWORD dwFlags)
         *
         * A path made a `file:` URL (`fileUrlOf`); one that is already a URL
         * is copied as it is and answered S_FALSE (Wine's
         * test_UrlCreateFromPath).
         */
        ...both('UrlCreateFromPath', 16, (width, [pointer, output, count])=>{
            const path = width.read(pointer);
            const room = countAt(count);
            if (path === null || (output >>> 0) === 0 || room === null)
            {
                return E_INVALIDARG;
            }
            return hasScheme(path)
                ? answer(width, path, output, count, room, S_FALSE)
                : answer(width, fileUrlOf(path, true), output, count, room);
        }),

        /** LPCSTR UrlGetLocationA(PCSTR pszURL): its `#` or `?` part, or NULL. */
        ...both('UrlGetLocation', 4, (width, [pointer])=>{
            const url = width.read(pointer);
            const at = url === null ? null : locationIndex(url);
            return at === null ? 0 : (pointer >>> 0) + at * width.unit;
        }),

        /**
         * HRESULT UrlApplySchemeA(LPCSTR pszIn, LPSTR pszOut, LPDWORD pcchOut, DWORD dwFlags)
         *
         * `applyScheme`'s URL; S_FALSE, all left as it was, when no scheme
         * applies (Wine's test_UrlApplyScheme).
         */
        ...both('UrlApplyScheme', 16, (width, [input, buffer, count, flags])=>{
            const url = width.read(input);
            if (url === null || (buffer >>> 0) === 0 || countAt(count) === null)
            {
                return E_INVALIDARG;
            }
            const applied = applyScheme(url, flags >>> 0);
            return applied === null ? S_FALSE : counted(width, applied, buffer, count, S_OK);
        }),

        /**
         * HRESULT UrlEscapeA(LPCSTR pszUrl, LPSTR pszEscaped, LPDWORD pcchEscaped, DWORD dwFlags)
         *
         * `escapeUrl`'s text, the source read before the answer is written so
         * the two may be one buffer. URL_ESCAPE_AS_UTF8 is the wide
         * spelling's alone: E_NOTIMPL in the ANSI one (Wine's test_UrlEscapeA).
         */
        ...both('UrlEscape', 16, (width, [input, buffer, count, flags])=>{
            const url = width.read(input);
            const room = countAt(count);
            if (url === null || (buffer >>> 0) === 0 || room === null || room === 0)
            {
                return E_INVALIDARG;
            }
            if (!width.wide && ((flags >>> 0) & URL_ESCAPE_AS_UTF8) !== 0)
            {
                return E_NOTIMPL;
            }
            return answer(width, escapeUrl(url, flags >>> 0), buffer, count, room);
        }),

        /**
         * HRESULT UrlGetPartA(LPCSTR pszIn, LPSTR pszOut, LPDWORD pcchOut, DWORD dwPart,
         *                     DWORD dwFlags)
         *
         * `urlPart`'s part. A part that is empty or absent where it could be
         * is S_FALSE and an empty string in the ANSI spelling, S_OK in the
         * wide one; a part the URL cannot have leaves all as it was (Wine's
         * test_UrlGetPart).
         */
        ...both('UrlGetPart', 20, (width, [input, buffer, count, part, flags])=>{
            const url = width.read(input);
            const room = countAt(count);
            if (url === null || (buffer >>> 0) === 0 || room === null || room === 0)
            {
                return E_INVALIDARG;
            }
            const { kind, text } = urlPart(url, part >>> 0, flags >>> 0);
            if (kind === 'none')
            {
                return E_FAIL;
            }
            if (kind === 'invalid')
            {
                return E_INVALIDARG;
            }
            if (kind === 'empty')
            {
                host.writeMemory(buffer >>> 0, width.sz(''));
                host.writeMemory(count >>> 0, dword(0));
                return width.wide ? S_OK : S_FALSE;
            }
            return counted(width, text, buffer, count, S_OK);
        }),

        /**
         * HRESULT UrlHashA(LPCSTR pszUrl, LPBYTE pbHash, DWORD cbHash)
         *
         * HashData over the URL's ANSI bytes, the wide spelling's narrowed
         * first, so both hash a URL alike (Wine's test_UrlHash).
         */
        ...both('UrlHash', 12, (width, [input, out, size])=>{
            const url = width.read(input);
            if (url === null || (out >>> 0) === 0 || (size >>> 0) === 0 || (size >>> 0) > 256)
            {
                return E_INVALIDARG;
            }
            host.writeMemory(out >>> 0, hash(encodeAnsi(url), size >>> 0));
            return S_OK;
        }),

        /**
         * HRESULT HashData(const BYTE *pbData, DWORD cbData, LPBYTE pbHash, DWORD cbHash)
         *
         * Neither pointer is looked at for nothing to hash, but either
         * missing is E_INVALIDARG (Wine's test_HashData).
         */
        HashData: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([input, length, out, size])=>{
                if ((input >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((length >>> 0) === 0 || (size >>> 0) === 0 || !host.readMemory)
                {
                    return S_OK;
                }
                host.writeMemory(out >>> 0, hash(host.readMemory(input >>> 0, length >>> 0),
                    size >>> 0));
                return S_OK;
            },
        },

        /**
         * HRESULT ParseURLA(LPCSTR pcszURL, PARSEDURLA *ppu)
         *
         * The protocol and what follows its colon, as places in the caller's
         * string, and the scheme's number; a string with no scheme is
         * URL_E_INVALID_SYNTAX with the protocol cleared and the number left
         * (Wine's test_ParseURL).
         */
        ...both('ParseURL', 8, (width, [input, parsed])=>{
            const url = width.read(input);
            if (url === null || (parsed >>> 0) === 0 || countAt(parsed) !== PARSEDURL_SIZE)
            {
                return E_INVALIDARG;
            }
            const result = parseUrl(url);
            if (result === null)
            {
                host.writeMemory((parsed >>> 0) + 4, dword(0));
                return URL_E_INVALID_SYNTAX;
            }
            const suffix = result.protocolLength + 1;
            const fields = new Uint8Array(20);
            fields.set(dword(input), 0);
            fields.set(dword(result.protocolLength), 4);
            fields.set(dword((input >>> 0) + suffix * width.unit), 8);
            fields.set(dword(url.length - suffix), 12);
            fields.set(dword(result.number), 16);
            host.writeMemory((parsed >>> 0) + 4, fields);
            return S_OK;
        }),

        /**
         * BOOL UrlIsA(PCSTR pszUrl, URLIS UrlIs)
         *
         * Whether it is a URL, an opaque one, a file URL, one that ends in a
         * directory or carries a query; never for no URL (Wine's test_UrlIs).
         * URLIS_NOHISTORY is answered for the opaque schemes, which name no
         * page to go back to. URLIS_APPLIABLE asks whether a scheme could be
         * guessed for the text, which this does not guess: FALSE.
         */
        ...both('UrlIs', 8, (width, [pointer, question])=>{
            const url = width.read(pointer);
            if (url === null)
            {
                return 0;
            }
            const result = urlIs(url, question >>> 0);
            if (result === null && (question >>> 0) === URLIS_APPLIABLE && !unanswered)
            {
                unanswered = true;
                host.divergence?.('UrlIs', 'URLIS_APPLIABLE guesses no scheme: FALSE');
            }
            return result ? 1 : 0;
        }),
    };
}
