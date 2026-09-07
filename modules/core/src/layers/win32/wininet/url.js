/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * URLs, split the way InternetCrackUrlA splits them.
 *
 * Parsed by hand rather than by the platform's URL type, and the reason is the
 * contract rather than taste: a caller may ask for its components as *pointers
 * into the string it passed in*, so every component has to carry the offset at
 * which it starts in the original text. A parser that normalises -- lowercasing
 * a host, appending a root path, re-encoding a character -- produces components
 * that are no longer substrings of the input, and those offsets become lies.
 *
 * So nothing here normalises. What the caller wrote is what comes back.
 */

/**
 * URL_COMPONENTSA, in bytes.
 *
 * Derived from the declaration rather than measured: every member is a DWORD or
 * a pointer at four bytes except `nPort`, which is an INTERNET_PORT -- a WORD.
 * That single narrow member is the whole subtlety of this table. It leaves two
 * bytes of padding behind it so `lpszUserName` lands on a four-byte boundary,
 * which is why the offsets after it stay divisible by four and the structure is
 * 60 bytes rather than 58.
 */
export const URL_COMPONENTS = Object.freeze({
    dwStructSize: 0,
    lpszScheme: 4,
    dwSchemeLength: 8,
    nScheme: 12,
    lpszHostName: 16,
    dwHostNameLength: 20,
    nPort: 24,
    lpszUserName: 28,
    dwUserNameLength: 32,
    lpszPassword: 36,
    dwPasswordLength: 40,
    lpszUrlPath: 44,
    dwUrlPathLength: 48,
    lpszExtraInfo: 52,
    dwExtraInfoLength: 56,
    SIZE: 60,
});

/** INTERNET_SCHEME. Only the ones a scheme name can produce here. */
export const Scheme = Object.freeze({
    UNKNOWN: 0,
    FTP: 1,
    HTTP: 3,
    HTTPS: 4,
    FILE: 8,
});

/** INTERNET_DEFAULT_*_PORT, and the zero that means "no default". */
const DEFAULT_PORTS = Object.freeze({ http: 80, https: 443, ftp: 21, file: 0 });

/** @param {string} scheme */
export function schemeNumber(scheme){
    switch (scheme.toLowerCase())
    {
        case 'ftp': return Scheme.FTP;
        case 'http': return Scheme.HTTP;
        case 'https': return Scheme.HTTPS;
        case 'file': return Scheme.FILE;
        default: return Scheme.UNKNOWN;
    }
}

/** @param {string} scheme */
export function defaultPort(scheme){
    return /** @type {any} */ (DEFAULT_PORTS)[scheme.toLowerCase()] ?? 0;
}

/**
 * @typedef {Object} UrlPart
 * @property {number} at      Offset of the first character within the URL.
 * @property {string} text
 */

/**
 * @typedef {Object} CrackedUrl
 * @property {UrlPart} scheme
 * @property {UrlPart} host
 * @property {UrlPart} user
 * @property {UrlPart} password
 * @property {UrlPart} path
 * @property {UrlPart} extra   Query and fragment together, from the '?' or '#'.
 * @property {number} port     The default for the scheme when none was written.
 * @property {boolean} portWasWritten
 */

/** @param {number} at @param {string} text @returns {UrlPart} */
const part = (at, text)=>({ at, text });

/**
 * Splits a URL. Answers null for anything without a scheme, which is what
 * "unrecognized scheme" means to this API -- a bare host is not a URL.
 *
 * @param {string} url
 * @returns {CrackedUrl | null}
 */
export function crackUrl(url){
    const separator = url.indexOf(':');
    if (separator <= 0)
    {
        return null;
    }
    const scheme = url.slice(0, separator);
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme))
    {
        return null;
    }

    // "scheme:" alone is legal for opaque schemes, but every scheme this
    // surface serves is hierarchical, so the slashes are expected and their
    // absence leaves an empty authority rather than a parse failure.
    let at = separator + 1;
    if (url.startsWith('//', at))
    {
        at += 2;
    }
    const authorityStart = at;

    // The authority ends at whichever comes first; a '?' before any '/' still
    // ends it, or "host?q" would parse its query as part of the host.
    let authorityEnd = url.length;
    for (let scan = authorityStart; scan < url.length; scan++)
    {
        const character = url[scan];
        if (character === '/' || character === '?' || character === '#')
        {
            authorityEnd = scan;
            break;
        }
    }

    const authority = url.slice(authorityStart, authorityEnd);
    // Last '@', not the first: a password may legally contain one.
    const credentialsEnd = authority.lastIndexOf('@');
    let user = part(authorityStart, '');
    let password = part(authorityStart, '');
    let hostStart = authorityStart;
    if (credentialsEnd !== -1)
    {
        const credentials = authority.slice(0, credentialsEnd);
        const split = credentials.indexOf(':');
        user = split === -1
            ? part(authorityStart, credentials)
            : part(authorityStart, credentials.slice(0, split));
        password = split === -1
            ? part(authorityStart + credentials.length, '')
            : part(authorityStart + split + 1, credentials.slice(split + 1));
        hostStart = authorityStart + credentialsEnd + 1;
    }

    const hostAndPort = url.slice(hostStart, authorityEnd);
    // A colon inside brackets belongs to an IPv6 literal, not to a port.
    const portMark = hostAndPort.startsWith('[')
        ? hostAndPort.indexOf(':', hostAndPort.indexOf(']'))
        : hostAndPort.indexOf(':');
    const host = portMark === -1 ? hostAndPort : hostAndPort.slice(0, portMark);
    const written = portMark === -1 ? '' : hostAndPort.slice(portMark + 1);
    const portWasWritten = written.length > 0 && /^[0-9]+$/.test(written);

    // The path runs to the query or the fragment, whichever starts first: both
    // belong to extra info here, unlike in most URL vocabularies.
    let extraStart = url.length;
    for (let scan = authorityEnd; scan < url.length; scan++)
    {
        if (url[scan] === '?' || url[scan] === '#')
        {
            extraStart = scan;
            break;
        }
    }

    return {
        scheme: part(0, scheme),
        host: part(hostStart, host),
        user,
        password,
        path: part(authorityEnd, url.slice(authorityEnd, extraStart)),
        extra: part(extraStart, url.slice(extraStart)),
        port: portWasWritten ? Number(written) & 0xffff : defaultPort(scheme),
        portWasWritten,
    };
}

/**
 * The URL a request will actually be sent to, from the parts a caller supplied
 * across InternetConnect and HttpOpenRequest.
 *
 * @param {Object} parts
 * @param {string} parts.host
 * @param {number} parts.port
 * @param {boolean} parts.secure
 * @param {string} parts.objectName  What HttpOpenRequest was given, path and all.
 */
export function buildUrl({ host, port, secure, objectName }){
    const scheme = secure ? 'https' : 'http';
    // An explicit port that is the scheme's default is left off, so that a
    // request and its Host header agree with what a server expects to see.
    const authority = port === 0 || port === defaultPort(scheme)
        ? host
        : `${host}:${port}`;
    const target = objectName.startsWith('/') ? objectName : `/${objectName}`;
    return `${scheme}://${authority}${target}`;
}
