/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The URL functions that take a URL apart or put a scheme on one: UrlEscape,
 * UrlGetPart, UrlApplyScheme and ParseURL, each a string in and a string or
 * a number out, written once for both spellings.
 *
 * None of them is RFC 3986: each reads a URL the way shlwapi does, which is
 * what Wine's shlwapi:url records Windows answering -- a scheme of two
 * characters or more, a host only for the schemes that have one, a
 * backslash read as a slash in some schemes and escaped in others, nothing
 * escaped past the query.
 */

/** A scheme as shlwapi accepts one: two characters or more, then its colon. */
const SCHEME = /^([A-Za-z0-9+.-]{2,}):/;

/** URL_SCHEME_*: the schemes ParseURL numbers; any other is URL_SCHEME_UNKNOWN. */
export const SCHEME_NUMBERS = Object.freeze({
    ftp: 1, http: 2, gopher: 3, mailto: 4, news: 5, nntp: 6, telnet: 7, wais: 8, file: 9,
    mk: 10, https: 11, shell: 12, snews: 13, local: 14, javascript: 15, vbscript: 16,
    about: 17, res: 18, 'ms-shell-rooted': 19, 'ms-shell-idlist': 20, hcp: 21,
});

/** The schemes UrlGetPart finds a host, user, password and port in. */
const WITH_HOST = new Set(['file', 'ftp', 'gopher', 'http', 'https', 'news', 'nntp', 'snews',
    'telnet']);

/** The schemes whose rest is no hierarchy: UrlEscape escapes a slash, a `?` and a `#` in it. */
const OPAQUE = new Set(['about', 'javascript', 'mailto', 'shell', 'vbscript']);

/** The schemes whose backslash UrlEscape reads as a slash. */
const SLASHED = new Set(['gopher', 'http', 'https', 'news', 'nntp', 'snews', 'telnet']);

/** The marks UrlEscape escapes besides the control characters and the space. */
const UNSAFE = new Set([...'"#<>[\\]^`{|}&']);

export const URL_ESCAPE_PERCENT = 0x00001000;
export const URL_ESCAPE_SEGMENT_ONLY = 0x00002000;
export const URL_ESCAPE_AS_UTF8 = 0x00040000;
export const URL_ESCAPE_SPACES_ONLY = 0x04000000;

export const URL_APPLY_DEFAULT = 0x1;
export const URL_APPLY_GUESSSCHEME = 0x2;
export const URL_APPLY_GUESSFILE = 0x4;
export const URL_APPLY_FORCEAPPLY = 0x8;

export const URL_PART_SCHEME = 1;
export const URL_PART_HOSTNAME = 2;
export const URL_PART_USERNAME = 3;
export const URL_PART_PASSWORD = 4;
export const URL_PART_PORT = 5;
export const URL_PART_QUERY = 6;
export const URL_PARTFLAG_KEEPSCHEME = 0x1;

/**
 * The prefixes UrlApplyScheme guesses a scheme from, as Windows installs them
 * under `URL\Prefixes`: a host that starts with the word and a dot.
 */
const GUESSED = Object.freeze({
    ftp: 'ftp://', gopher: 'gopher://', home: 'http://', mosaic: 'http://', www: 'http://',
});
const DEFAULT_PREFIX = 'http://';

/**
 * The scheme a URL starts with, lowered, and where what follows its colon
 * begins; null for none.
 *
 * @param {string} url
 */
export const schemeOf = url=>{
    const match = SCHEME.exec(url);
    return match ? { scheme: match[1].toLowerCase(), rest: match[0].length } : null;
};

/**
 * One character escaped as UrlEscape writes it: its code in two hex digits,
 * or, with URL_ESCAPE_AS_UTF8, each byte of its UTF-8. A surrogate with no
 * partner is U+FFFD there.
 *
 * @param {string} char @param {boolean} utf8
 */
const escaped = (char, utf8)=>{
    const code = char.codePointAt(0) ?? 0;
    if (!utf8 || code < 0x80)
    {
        return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    const lone = code >= 0xd800 && code <= 0xdfff;
    return Array.from(new TextEncoder().encode(lone ? '�' : char),
        byte=>`%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
};

/**
 * @typedef {Object} EscapeRules
 * @property {boolean} slash      `/` is escaped too.
 * @property {boolean} toSlash    `\` becomes `/` before it is looked at.
 * @property {boolean} stops      `?`, and `#` unless `hash`, end the escaping there.
 * @property {boolean} hash       `#` is escaped and does not stop it.
 * @property {boolean} query      `?` is escaped and does not stop it.
 */

/**
 * The text after a URL's prefix escaped by `rules`, with the flags'
 * additions: a `%` with URL_ESCAPE_PERCENT, UTF-8 for URL_ESCAPE_AS_UTF8, and
 * a character past Latin-1 left as it is otherwise.
 *
 * @param {string} text @param {EscapeRules} rules @param {number} flags
 */
const escapeBody = (text, rules, flags)=>{
    const utf8 = (flags & URL_ESCAPE_AS_UTF8) !== 0;
    const percent = (flags & URL_ESCAPE_PERCENT) !== 0;
    let out = '';
    const chars = Array.from(text);
    for (let at = 0; at < chars.length; at++)
    {
        const original = chars[at];
        const c = rules.toSlash && original === '\\' ? '/' : original;
        if (rules.stops && ((c === '?' && !rules.query) || (c === '#' && !rules.hash)))
        {
            return out + chars.slice(at).join('');
        }
        const code = c.codePointAt(0) ?? 0;
        const escape = code <= 0x20 || (code >= 0x7f && (code <= 0xff || utf8))
            || (UNSAFE.has(c) && (c !== '#' || rules.hash))
            || (c === '%' && percent) || (c === '/' && rules.slash)
            || (c === '?' && rules.query);
        out += escape ? escaped(c, utf8) : c;
    }
    return out;
};

/**
 * A `file:` URL's slashes as UrlEscape leaves them: one becomes three, two
 * name a host (none for `localhost`), three stay, four or more are a share.
 *
 * @param {string} rest  What follows `file:`.
 */
const fileSlashes = rest=>{
    const lead = /^[/\\]*/.exec(rest)?.[0].length ?? 0;
    const body = rest.slice(lead);
    if (lead === 0)
    {
        return { prefix: '', body };
    }
    if (lead === 2 && /^localhost(?=[/\\]|$)/i.test(body))
    {
        return { prefix: '///', body: body.slice('localhost'.length).replace(/^[/\\]/, '') };
    }
    return { prefix: lead === 1 || lead === 3 ? '///' : '//', body };
};

/**
 * UrlEscape's text for a URL.
 *
 * @param {string} url @param {number} flags
 */
export function escapeUrl(url, flags){
    if ((flags & URL_ESCAPE_SPACES_ONLY) !== 0 && (flags & URL_ESCAPE_SEGMENT_ONLY) === 0)
    {
        return url.replace(/ /g, '%20');
    }
    if ((flags & URL_ESCAPE_SEGMENT_ONLY) !== 0)
    {
        return escapeBody(url, { slash: true, toSlash: false, stops: false, hash: true,
            query: true }, flags);
    }
    const parsed = schemeOf(url);
    if (!parsed)
    {
        return escapeBody(url, { slash: false, toSlash: false, stops: true, hash: false,
            query: false }, flags);
    }
    const prefix = url.slice(0, parsed.rest);
    const rest = url.slice(parsed.rest);
    if (parsed.scheme === 'file')
    {
        const { prefix: slashes, body } = fileSlashes(rest);
        return prefix + slashes + escapeBody(body, { slash: false, toSlash: true, stops: true,
            hash: true, query: false }, flags);
    }
    if (OPAQUE.has(parsed.scheme))
    {
        return prefix + escapeBody(rest, { slash: true, toSlash: false, stops: false,
            hash: true, query: true }, flags);
    }
    const toSlash = SLASHED.has(parsed.scheme);
    const rooted = toSlash ? /^[/\\]/.test(rest) : rest.startsWith('/');
    if (!rooted)
    {
        return prefix + escapeBody(rest, { slash: true, toSlash, stops: true, hash: false,
            query: false }, flags);
    }
    return prefix + escapeBody(rest, { slash: false, toSlash, stops: true, hash: false,
        query: false }, flags);
}

/**
 * UrlApplyScheme's answer: the URL with the scheme the flags let it guess or
 * default to, or null when none applies -- a URL that has a scheme already
 * keeps it unless the caller forces one.
 *
 * @param {string} url @param {number} flags
 * @returns {string | null}
 */
export function applyScheme(url, flags){
    if ((flags & URL_APPLY_FORCEAPPLY) === 0 && schemeOf(url))
    {
        return null;
    }
    if ((flags & URL_APPLY_GUESSFILE) !== 0 && !schemeOf(url))
    {
        if (/^[A-Za-z]:/.test(url))
        {
            return `file:///${url.replace(/\\/g, '/')}`;
        }
        if (url.startsWith('\\\\'))
        {
            return `file://${url.slice(2).replace(/\\/g, '/')}`;
        }
    }
    if ((flags & URL_APPLY_GUESSSCHEME) !== 0)
    {
        const word = /^([A-Za-z]+)\./.exec(url)?.[1].toLowerCase();
        const guess = word === undefined ? undefined
            : GUESSED[/** @type {keyof typeof GUESSED} */ (word)];
        if (guess !== undefined)
        {
            return guess + url;
        }
    }
    return (flags & URL_APPLY_DEFAULT) !== 0 ? DEFAULT_PREFIX + url : null;
}

/**
 * What UrlGetPart finds, as an HRESULT's kind and the text: `found` with
 * the part, `empty` for a part that is there and empty or not there at all
 * where it could be (S_FALSE), `none` where the URL cannot have it
 * (E_FAIL), `invalid` for a part the URL's form has no place for
 * (E_INVALIDARG).
 *
 * @param {string} url @param {number} part @param {number} flags
 * @returns {{ kind: 'found' | 'empty' | 'none' | 'invalid', text: string }}
 */
export function urlPart(url, part, flags){
    const parsed = schemeOf(url);
    const keep = (flags & URL_PARTFLAG_KEEPSCHEME) !== 0;
    /** @param {string} text @param {boolean} [prefixed] */
    const found = (text, prefixed = keep)=>(text === '' && !(prefixed && parsed)
        ? { kind: /** @type {const} */ ('empty'), text: '' }
        : { kind: /** @type {const} */ ('found'),
            text: prefixed && parsed ? `${parsed.scheme}:${text}` : text });
    if (part === URL_PART_SCHEME)
    {
        return parsed ? found(parsed.scheme, false) : { kind: 'empty', text: '' };
    }
    if (part === URL_PART_QUERY)
    {
        const fragment = url.indexOf('#');
        const head = fragment < 0 ? url : url.slice(0, fragment);
        const mark = head.indexOf('?');
        return parsed && mark >= 0 ? found(head.slice(mark + 1), false)
            : { kind: 'empty', text: '' };
    }
    if (!parsed || !WITH_HOST.has(parsed.scheme))
    {
        return { kind: 'none', text: '' };
    }
    const rest = url.slice(parsed.rest);
    const file = parsed.scheme === 'file';
    if (!/^[/\\]{2}/.test(rest))
    {
        return file && part === URL_PART_HOSTNAME ? { kind: 'empty', text: '' }
            : { kind: 'none', text: '' };
    }
    const authority = rest.slice(2).split(/[/\\?#]/)[0];
    if (file)
    {
        if (part !== URL_PART_HOSTNAME)
        {
            return { kind: 'none', text: '' };
        }
        // A drive where a host would be is a path, not a host.
        return /^[A-Za-z]:$/.test(authority) ? { kind: 'empty', text: '' }
            : found(authority, false);
    }
    const at = authority.indexOf('@');
    const user = at < 0 ? null : authority.slice(0, at);
    const server = at < 0 ? authority : authority.slice(at + 1);
    const colon = server.indexOf(':');
    const host = colon < 0 ? server : server.slice(0, colon);
    if (part === URL_PART_HOSTNAME)
    {
        return found(host);
    }
    if (part === URL_PART_PORT)
    {
        return colon < 0 ? { kind: 'invalid', text: '' } : found(server.slice(colon + 1));
    }
    if (user === null)
    {
        return { kind: 'invalid', text: '' };
    }
    const split = user.indexOf(':');
    if (part === URL_PART_USERNAME)
    {
        return found(split < 0 ? user : user.slice(0, split));
    }
    if (part === URL_PART_PASSWORD)
    {
        return split < 0 ? { kind: 'invalid', text: '' } : found(user.slice(split + 1));
    }
    return { kind: 'invalid', text: '' };
}

/**
 * ParseURL's reading: the protocol's length and its number, or null for a
 * string with no scheme shlwapi accepts.
 *
 * @param {string} url
 */
export function parseUrl(url){
    const match = SCHEME.exec(url);
    if (!match)
    {
        return null;
    }
    const scheme = match[1].toLowerCase();
    return {
        protocolLength: match[1].length,
        number: SCHEME_NUMBERS[/** @type {keyof typeof SCHEME_NUMBERS} */ (scheme)] ?? 0,
    };
}

/**
 * HashData's permutation. Windows' own table is in no specification, and
 * this is not it: a permutation of 0-255 of our own, so a hash here is
 * stable from run to run and the A and W spellings of UrlHash agree, while
 * its bytes differ from the ones Windows computes for the same input.
 */
const PERMUTATION = (()=>{
    const table = Uint8Array.from({ length: 256 }, (_, i)=>i);
    let state = 0x2545f491;
    for (let at = 255; at > 0; at--)
    {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        const other = (state >>> 0) % (at + 1);
        [table[at], table[other]] = [table[other], table[at]];
    }
    return table;
})();

/**
 * Pearson's hash, one output byte for each byte asked for, each started from
 * its own place in the permutation: HashData's form, over our table.
 *
 * @param {Uint8Array} input @param {number} size
 */
export function hashData(input, size){
    // An output byte depends on its place only through (input[0] + place) & 0xff:
    // 256 of them at most are worked out, and the rest repeat them.
    const distinct = new Uint8Array(Math.min(size, 256));
    for (let at = 0; at < distinct.length; at++)
    {
        let hash = PERMUTATION[((input[0] ?? 0) + at) & 0xff];
        for (let next = 1; next < input.length; next++)
        {
            hash = PERMUTATION[hash ^ input[next]];
        }
        distinct[at] = hash;
    }
    const out = new Uint8Array(size);
    for (let at = 0; at < size; at += distinct.length)
    {
        out.set(distinct.subarray(0, Math.min(distinct.length, size - at)), at);
    }
    return out;
}
