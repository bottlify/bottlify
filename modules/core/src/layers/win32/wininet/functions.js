/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The WinInet surface: HTTP, in the vocabulary a 1990s client speaks.
 *
 * Three things shape everything here.
 *
 * **A handle is a position in a tree.** InternetOpen makes a session,
 * InternetConnect makes a connection under it, HttpOpenRequest makes a request
 * under that. Closing one closes everything beneath it, because a client that
 * closes its session and then reads a request handle must be told the handle is
 * gone rather than served from a connection that no longer has a parent.
 *
 * **A guest call is synchronous and an HTTP request is not.** The send returns a
 * promise, and the bridge parks the calling thread until it settles -- the same
 * path a read from a bundle takes when the bytes are not here yet. Nothing here
 * waits, polls, or invents a mechanism of its own.
 *
 * **Nothing here reaches the network.** The transport is handed in, as the GPU
 * device and the bundle's block store are. A build given none fails honestly
 * with "cannot connect": a fabricated response would be indistinguishable from
 * a real one to the program, and far harder to explain later.
 */

import { URL_COMPONENTS, buildUrl, crackUrl, createUrl, defaultPort, schemeNumber }
    from './url.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { createCookieJar } from './cookies.js';
import { parseInternetTime } from './time.js';
import { createCacheFunctions } from './cache.js';
import { createFtpFunctions } from './ftp.js';
import { createRefusals } from '../common/refusal.js';

const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NEGATIVE_SEEK = 131;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_CANCELLED = 1223;

/** InternetCanonicalizeUrl's flags, the ones that change the answer. */
const ICU_NO_ENCODE = 0x20000000;
const ICU_DECODE = 0x10000000;
const ICU_NO_META = 0x08000000;
const ICU_ENCODE_SPACES_ONLY = 0x04000000;
const ICU_BROWSER_MODE = 0x02000000;
const ICU_ENCODE_PERCENT = 0x00001000;

/**
 * Canonicalises a URL the way WinINet does for the cases a program relies on:
 * "." and ".." collapsed out of the path, unsafe characters percent-encoded,
 * and, when asked, existing escapes decoded first.
 *
 * The characters encoded are the ones WinINet treats as unsafe in a URL --
 * controls, space, DEL, anything past ASCII, and the delimiters that are not
 * URL syntax. Reserved characters stay, because encoding "?" or "/" would
 * change what the URL names. An escape is of a byte of the ANSI page the URL
 * was read in, both ways.
 *
 * @param {string} url @param {number} flags
 * @returns {string}
 */
export function canonicalizeUrl(url, flags){
    let text = url;
    if ((flags & ICU_DECODE) !== 0)
    {
        text = text.replace(/%([0-9a-fA-F]{2})/g,
            (_, hex)=>decodeAnsi(Uint8Array.of(parseInt(hex, 16))));
    }
    if ((flags & ICU_NO_META) === 0)
    {
        // Only the path: a query or fragment is the program's to keep as is,
        // and a host name has no segments to collapse.
        const scheme = text.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/);
        const start = scheme ? scheme[0].length : 0;
        const stop = text.slice(start).search(/[?#]/);
        const pathEnd = stop === -1 ? text.length : start + stop;
        const path = text.slice(start, pathEnd);
        if (path.startsWith('/'))
        {
            /** @type {string[]} */
            const kept = [];
            for (const segment of path.slice(1).split('/'))
            {
                if (segment === '.')
                {
                    continue;
                }
                if (segment === '..')
                {
                    kept.pop();
                    continue;
                }
                kept.push(segment);
            }
            text = text.slice(0, start) + '/' + kept.join('/') + text.slice(pathEnd);
        }
    }
    if ((flags & ICU_NO_ENCODE) === 0)
    {
        const spacesOnly = (flags & ICU_ENCODE_SPACES_ONLY) !== 0;
        const percent = (flags & ICU_ENCODE_PERCENT) !== 0;
        let encoded = '';
        for (const character of text)
        {
            const code = character.charCodeAt(0);
            // A character the page has no byte for has no escape, and stays.
            const [byte] = encodeAnsi(character);
            const unsafe = spacesOnly
                ? code === 0x20
                : code <= 0x20 || code >= 0x7f || '"<>\\^`{|}'.includes(character)
                    || (percent && character === '%');
            encoded += unsafe && (code < 0x80 || byte !== 0x3f)
                ? `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
                : character;
        }
        text = encoded;
    }
    return text;
}

/** ICU_ESCAPE: InternetCreateUrl escapes the path and extra info it writes. */
const ICU_ESCAPE = 0x80000000;

const ERROR_INTERNET_INVALID_URL = 12005;
const ERROR_INTERNET_UNRECOGNIZED_SCHEME = 12006;
const ERROR_INTERNET_NAME_NOT_RESOLVED = 12007;
const ERROR_INTERNET_INVALID_OPTION = 12009;
const ERROR_INTERNET_BAD_OPTION_LENGTH = 12010;
const ERROR_INTERNET_INVALID_OPERATION = 12016;
const ERROR_INTERNET_INCORRECT_HANDLE_TYPE = 12018;
const ERROR_INTERNET_INCORRECT_HANDLE_STATE = 12019;
const ERROR_INTERNET_ITEM_NOT_FOUND = 12028;
const ERROR_INTERNET_CANNOT_CONNECT = 12029;
const ERROR_HTTP_HEADER_NOT_FOUND = 12150;
const ERROR_HTTP_INVALID_HEADER = 12153;
const ERROR_HTTP_HEADER_ALREADY_EXISTS = 12155;

/** INTERNET_SERVICE_*: FTP and Gopher connect at once, HTTP when a request is sent. */
const INTERNET_SERVICE_FTP = 1;
const INTERNET_SERVICE_GOPHER = 2;
const INTERNET_SERVICE_HTTP = 3;

/** INTERNET_FLAG_NO_COOKIES: the request neither sends nor stores cookies. */
const INTERNET_FLAG_NO_COOKIES = 0x00080000;
/** INTERNET_FLAG_NO_CACHE_WRITE: the body is not kept, so it cannot be seeked in. */
const INTERNET_FLAG_NO_CACHE_WRITE = 0x04000000;

/** INTERNET_FLAG_SECURE, which is what picks https over http. */
const INTERNET_FLAG_SECURE = 0x00800000;

/**
 * The high bits of dwInfoLevel, which change what the buffer receives rather
 * than which header is read. NUMBER is the one that matters: a client asking
 * for a status code with it gets a DWORD, and a client given text instead reads
 * the first four characters as an integer.
 */
const HTTP_QUERY_FLAG_REQUEST_HEADERS = 0x80000000;
const HTTP_QUERY_FLAG_NUMBER = 0x20000000;

/**
 * HTTP_QUERY_* levels, and the response header each names.
 *
 * Only the ones whose numbers are certain. An unknown level is reported as a
 * header that is not there rather than mapped onto a guess -- a wrong mapping
 * answers confidently with the wrong header, which is worse for whoever has to
 * find it later than a clean "not found".
 */
const QUERY_HEADERS = new Map([
    [0, 'mime-version'], [1, 'content-type'], [2, 'content-transfer-encoding'],
    [3, 'content-id'], [4, 'content-description'], [5, 'content-length'],
    [6, 'content-language'], [7, 'allow'], [8, 'public'], [9, 'date'], [10, 'expires'],
    [11, 'last-modified'], [12, 'message-id'], [13, 'uri'], [14, 'derived-from'],
    [15, 'cost'], [16, 'link'], [17, 'pragma'], [23, 'connection'], [24, 'accept'],
    [25, 'accept-charset'], [26, 'accept-encoding'], [27, 'accept-language'],
    [28, 'authorization'], [29, 'content-encoding'], [30, 'forwarded'], [31, 'from'],
    [32, 'if-modified-since'], [33, 'location'], [34, 'orig-uri'], [35, 'referer'],
    [36, 'retry-after'], [37, 'server'], [38, 'title'], [39, 'user-agent'],
    [40, 'www-authenticate'], [41, 'proxy-authenticate'], [42, 'accept-ranges'],
    [43, 'set-cookie'], [44, 'cookie'], [46, 'refresh'], [47, 'content-disposition'],
    [48, 'age'], [49, 'cache-control'], [50, 'content-base'], [51, 'content-location'],
    [52, 'content-md5'], [53, 'content-range'], [54, 'etag'], [55, 'host'],
    [56, 'if-match'], [57, 'if-none-match'], [58, 'if-range'], [59, 'if-unmodified-since'],
    [60, 'max-forwards'], [61, 'proxy-authorization'], [62, 'range'],
    [63, 'transfer-encoding'], [64, 'upgrade'], [65, 'vary'], [66, 'via'], [67, 'warning'],
    [68, 'expect'], [69, 'proxy-connection'], [70, 'unless-modified-since'],
]);

/** HTTP_QUERY_CUSTOM: the header's name is the text the caller left in the buffer. */
const HTTP_QUERY_CUSTOM = 0xffff;

const HTTP_QUERY_VERSION = 18;
const HTTP_QUERY_STATUS_CODE = 19;
const HTTP_QUERY_STATUS_TEXT = 20;
const HTTP_QUERY_RAW_HEADERS = 21;
const HTTP_QUERY_RAW_HEADERS_CRLF = 22;

/**
 * INTERNET_BUFFERSA, in bytes. Every member is four wide, so these follow from
 * the declaration directly; `Next` at 4 is a pointer to another one of these,
 * which this surface reads but never follows -- a chained read is a single read
 * as far as a client can tell.
 */
const INTERNET_BUFFERS = Object.freeze({
    dwStructSize: 0,
    lpcszHeader: 8,
    dwHeadersLength: 12,
    lpvBuffer: 20,
    dwBufferLength: 24,
    dwBufferTotal: 28,
    SIZE: 40,
});

/** HttpAddRequestHeaders' modifiers. COALESCE is COALESCE_WITH_COMMA. */
const HTTP_ADDREQ_FLAG_ADD_IF_NEW = 0x10000000;
const HTTP_ADDREQ_FLAG_COALESCE_WITH_COMMA = 0x40000000;
const HTTP_ADDREQ_FLAG_COALESCE_WITH_SEMICOLON = 0x01000000;
const HTTP_ADDREQ_FLAG_ADD = 0x20000000;
const HTTP_ADDREQ_FLAG_REPLACE = 0x80000000;

/** InternetQueryOption and InternetSetOption's option numbers, the ones answered. */
const Option = Object.freeze({
    CONNECT_TIMEOUT: 2,
    CONNECT_RETRIES: 3,
    SEND_TIMEOUT: 5,
    RECEIVE_TIMEOUT: 6,
    DATA_SEND_TIMEOUT: 7,
    DATA_RECEIVE_TIMEOUT: 8,
    HANDLE_TYPE: 9,
    REQUEST_FLAGS: 23,
    USERNAME: 28,
    PASSWORD: 29,
    URL: 34,
    REFRESH: 37,
    PROXY: 38,
    SETTINGS_CHANGED: 39,
    VERSION: 40,
    USER_AGENT: 41,
    CONTEXT_VALUE: 45,
    POLICY: 48,
    CONNECTED_STATE: 50,
    ERROR_MASK: 62,
    MAX_CONNS_PER_SERVER: 73,
    MAX_CONNS_PER_1_0_SERVER: 74,
});

/**
 * The options a handle takes from its parent when it is made, and the value
 * each has before anyone sets it. Inherited at creation and not after: a
 * session's timeout changed later leaves its existing connections alone.
 * The defaults are the documented ones (not measured on a machine).
 *
 * @type {Map<number, number>}
 */
const INHERITED_DEFAULTS = new Map([
    [Option.CONNECT_TIMEOUT, 60000],
    [Option.CONNECT_RETRIES, 5],
    [Option.SEND_TIMEOUT, 30000],
    [Option.RECEIVE_TIMEOUT, 30000],
    [Option.DATA_SEND_TIMEOUT, 30000],
    [Option.DATA_RECEIVE_TIMEOUT, 30000],
]);

/**
 * The process-wide connection limits, which only a null handle reads and sets.
 *
 * @type {Map<number, number>}
 */
const CONNECTION_LIMIT_DEFAULTS = new Map([
    [Option.MAX_CONNS_PER_SERVER, 2],
    [Option.MAX_CONNS_PER_1_0_SERVER, 4],
]);

/** The bits INTERNET_OPTION_ERROR_MASK accepts; anything else is refused. */
const ERROR_MASK_BITS = 0x0b;

/** INTERNET_HANDLE_TYPE_* for each kind of handle there is here. */
const HANDLE_TYPES = Object.freeze({ session: 1, connect: 4, request: 13 });

/** INTERNET_REQFLAG_NO_HEADERS: no response has arrived on the request yet. */
const INTERNET_REQFLAG_NO_HEADERS = 0x8;

/** INTERNET_OPEN_TYPE_*: what a session's proxy setting says. */
const INTERNET_OPEN_TYPE_PRECONFIG = 0;
const INTERNET_OPEN_TYPE_DIRECT = 1;

/** INTERNET_STATE_*, for INTERNET_OPTION_CONNECTED_STATE. */
const INTERNET_STATE_CONNECTED = 1;
const INTERNET_STATE_DISCONNECTED = 2;

/** InternetGetConnectedState's flags: LAN, and the RAS that every XP installs. */
const INTERNET_CONNECTION_LAN = 0x02;
const INTERNET_RAS_INSTALLED = 0x10;

/** The connection InternetGetConnectedStateEx names when the transport is there. */
const LAN_CONNECTION_NAME = 'LAN Connection';

/** InternetErrorDlg's flags. */
const FLAGS_ERROR_UI_FILTER_FOR_ERRORS = 0x01;
const FLAGS_ERROR_UI_FLAGS_NO_UI = 0x08;

/**
 * What InternetErrorDlg answers, with no dialog, for the errors it treats
 * specially -- the rest answer as a dialog closed without a choice. A warning
 * that only informs (a redirect between http and https, a post over an
 * insecure channel) is acknowledged; one that wants a decision is cancelled.
 * Three of them are about a request in particular and refuse to answer
 * without one. From Windows' observed answers, as Wine's tests record them.
 *
 * @type {Map<number, { answer: number, needsRequest?: boolean }>}
 */
const ERROR_DIALOG_ANSWERS = new Map([
    [12014, { answer: ERROR_SUCCESS, needsRequest: true }],      // INCORRECT_PASSWORD
    [12037, { answer: ERROR_CANCELLED }],                        // SEC_CERT_DATE_INVALID
    [12038, { answer: ERROR_CANCELLED }],                        // SEC_CERT_CN_INVALID
    [12039, { answer: ERROR_SUCCESS }],                          // HTTP_TO_HTTPS_ON_REDIR
    [12040, { answer: ERROR_SUCCESS }],                          // HTTPS_TO_HTTP_ON_REDIR
    [12041, { answer: ERROR_CANCELLED }],                        // MIXED_SECURITY
    [12042, { answer: ERROR_SUCCESS }],                          // CHG_POST_IS_NON_SECURE
    [12043, { answer: ERROR_SUCCESS }],                          // POST_IS_NON_SECURE
    [12044, { answer: ERROR_CANCELLED, needsRequest: true }],    // CLIENT_AUTH_CERT_NEEDED
    [12045, { answer: ERROR_CANCELLED }],                        // INVALID_CA
    [12052, { answer: ERROR_CANCELLED }],                        // HTTPS_HTTP_SUBMIT_REDIR
    [12053, { answer: ERROR_CANCELLED, needsRequest: true }],    // INSERT_CDROM
    [12055, { answer: ERROR_CANCELLED }],                        // SEC_CERT_ERRORS
    [12057, { answer: ERROR_CANCELLED }],                        // SEC_CERT_REV_FAILED
    [12161, { answer: 12162 }],                     // COOKIE_NEEDS_CONFIRMATION: DECLINED
    [12166, { answer: ERROR_CANCELLED }],                        // BAD_AUTO_PROXY_SCRIPT
    [12167, { answer: ERROR_CANCELLED }],                        // UNABLE_TO_DOWNLOAD_SCRIPT
    [12168, { answer: ERROR_CANCELLED }],                        // REDIRECT_NEEDS_CONFIRMATION
    [12170, { answer: ERROR_CANCELLED }],                        // SEC_CERT_REVOKED
]);

/** COOKIE_STATE_*: UNKNOWN clears a site's decision, REJECT is the last there is. */
const COOKIE_STATE_UNKNOWN = 0;
const COOKIE_STATE_REJECT = 5;

/** SYSTEMTIME is eight WORDs. */
const SYSTEMTIME_SIZE = 16;

/** Handles are multiples of four and start above zero, which means failure. */
const HANDLE_STRIDE = 4;

/** A header or verb longer than this is a caller's bug, not a long header. */
const MAX_TEXT = 8192;

const TRUE = 1;
const FALSE = 0;

/**
 * @typedef {Object} HttpResponse
 * @property {number} status
 * @property {string} [statusText]
 * @property {Record<string, string>} [headers]  Names are matched case-insensitively.
 * @property {Uint8Array} [body]
 */

/**
 * @typedef {Object} WininetHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(code: number) => void} setLastError
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 *           Told, once per kind, when a call is answered differently from
 *           the real library.
 * @property {((request: { method: string, url: string,
 *                         headers: Record<string, string>,
 *                         body: Uint8Array | null }) => Promise<HttpResponse>) | null}
 *           [request]  The transport. Absent means this build has no network,
 *           and every question about connectivity is answered offline.
 * @property {() => number} [now]  The guest's wall clock, milliseconds since
 *           1970: what a cookie's expiry is compared with. Without it an
 *           expiry is kept and never acted on.
 */

/**
 * Splits a "Name: value" header block, as HttpSendRequest and HttpOpenRequest
 * both receive one.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseHeaders(text){
    /** @type {Record<string, string>} */
    const headers = {};
    for (const line of text.split(/\r?\n/))
    {
        const colon = line.indexOf(':');
        if (colon <= 0)
        {
            continue;
        }
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name)
        {
            headers[name] = value;
        }
    }
    return headers;
}

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * All stdcall, the bridge's default, so none of them says so.
 *
 * @param {WininetHost} host
 */
export function createWininetFunctions(host){
    /**
     * @typedef {Object} WininetHandle
     * @property {'session' | 'connect' | 'request'} kind
     * @property {number} parent          Zero for a session.
     * @property {any} state
     */

    /** @type {Map<number, WininetHandle>} */
    const handles = new Map();
    let next = HANDLE_STRIDE;

    /** What a null handle reads and sets: the process-wide options. */
    const globalOptions = new Map(INHERITED_DEFAULTS);
    const connectionLimits = new Map(CONNECTION_LIMIT_DEFAULTS);

    /** Whether anything here can reach a server at all. */
    const online = ()=>Boolean(host.request);

    const cookies = createCookieJar({ now: host.now });
    /** The sites a program has decided about, by host name. @type {Map<string, number>} */
    const cookieDecisions = new Map();

    const refuse = createRefusals(host);

    /**
     * @param {'session' | 'connect' | 'request'} kind
     * @param {number} parent
     * @param {any} state
     */
    const allocate = (kind, parent, state)=>{
        const handle = next;
        next += HANDLE_STRIDE;
        const inherited = parent === 0 ? globalOptions : handles.get(parent)?.state.options;
        handles.set(handle, { kind, parent, state: { ...state,
            options: new Map(inherited ?? INHERITED_DEFAULTS) } });
        return handle;
    };

    /**
     * @param {number} handle
     * @param {'session' | 'connect' | 'request'} [kind]
     * @returns {WininetHandle | null}
     */
    const resolve = (handle, kind)=>{
        const found = handles.get(handle >>> 0) ?? null;
        if (!found)
        {
            return null;
        }
        return !kind || found.kind === kind ? found : null;
    };

    /** Said once: a program canonicalises many URLs and one line is the whole finding. */
    let browserModeReported = false;
    /** Said once: a program that tries FTP once usually tries it again. */
    let otherServiceReported = false;

    /** @param {number} code @returns {number} FALSE, so a handler can return it directly */
    const fail = code=>{
        host.setLastError(code);
        return FALSE;
    };

    /** @param {number} code @returns {number} a null handle, the failure of every maker */
    const failHandle = code=>{
        host.setLastError(code);
        return 0;
    };

    /**
     * The request a call was handed, or the error for what it was handed
     * instead: nothing this library made, or a handle of another kind.
     *
     * @param {number} handle
     * @returns {WininetHandle | number}
     */
    const requestOf = handle=>{
        const found = handles.get(handle >>> 0);
        if (!found)
        {
            return ERROR_INVALID_HANDLE;
        }
        return found.kind === 'request' ? found : ERROR_INTERNET_INCORRECT_HANDLE_TYPE;
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @param {number} address @param {number} value */
    const writeDwordIf = (address, value)=>{
        if (address !== 0)
        {
            writeDword(address, value);
        }
    };

    /** @param {number} address @param {number} value */
    const writeWord = (address, value)=>{
        host.writeMemory(address, new Uint8Array([value & 0xff, value >>> 8 & 0xff]));
    };

    /** @param {number} pointer @param {number} [limit] */
    const readText = (pointer, limit = MAX_TEXT)=>
        pointer === 0 ? '' : host.readCString(pointer >>> 0, limit);

    /** readText for the wide entry points. @param {number} pointer @param {number} [limit] */
    const readWide = (pointer, limit = MAX_TEXT)=>{
        let text = '';
        for (let at = pointer >>> 0; at !== 0 && text.length < limit; at += 2)
        {
            const [low, high] = host.readMemory(at, 2);
            if ((low | high) === 0)
            {
                break;
            }
            text += String.fromCharCode(low | high << 8);
        }
        return text;
    };

    /** @param {boolean} wide */
    const reader = wide=>(wide ? readWide : readText);

    /**
     * A string a caller passed with a count: all of it, the count being
     * characters, or up to its terminator when the count is -1. A count of
     * zero is a terminated string in UTF-16, and in ANSI no string at all --
     * which the calls that take one refuse, so it answers null for them to.
     *
     * @param {number} pointer @param {number} count @param {boolean} wide
     * @returns {string | null}
     */
    const readCounted = (pointer, count, wide)=>{
        if ((pointer >>> 0) === 0)
        {
            return '';
        }
        const length = count >>> 0;
        if (length === 0xffffffff || (length === 0 && wide))
        {
            return reader(wide)(pointer);
        }
        if (length === 0)
        {
            return null;
        }
        return wide ? readWide(pointer, length)
            : decodeAnsi(host.readMemory(pointer >>> 0, length));
    };

    /**
     * Writes a string and its terminator. Latin-1 rather than UTF-8, because
     * what goes back has to be the same number of bytes the length reported.
     * What goes through here is what the transport answered; the program's
     * own text, a URL, goes back through writeAnsi.
     *
     * @param {number} pointer @param {string} text
     */
    const writeText = (pointer, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(pointer >>> 0, bytes);
    };

    /**
     * Writes text read from the program, a URL or a piece of one, and its
     * terminator, in the ANSI page it was read in.
     *
     * @param {number} pointer @param {string} text
     */
    const writeAnsi = (pointer, text)=>{
        host.writeMemory(pointer >>> 0, encodeAnsi(`${text}\0`));
    };

    /** Writes UTF-16 and its terminator. @param {number} pointer @param {string} text */
    const writeWide = (pointer, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at * 2] = text.charCodeAt(at) & 0xff;
            bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
        }
        host.writeMemory(pointer >>> 0, bytes);
    };

    /** @param {boolean} wide */
    const writer = wide=>(wide ? writeWide : writeAnsi);

    /**
     * The buffer protocol this API uses everywhere: a caller offers a buffer and
     * its capacity, and is told the size it needed when that is not enough.
     *
     * The length it reports on success is the text *without* the terminator, and
     * the size it demands on failure is *with* it. That asymmetry is the contract
     * and not an oversight: a caller that allocates what the failure asked for
     * and retries then has exactly enough room.
     *
     * @param {number} buffer @param {number} lengthPointer @param {string} text
     * @returns {number} TRUE or FALSE
     */
    const answerText = (buffer, lengthPointer, text)=>{
        const capacity = lengthPointer === 0 ? 0 : readDword(lengthPointer >>> 0);
        if (buffer === 0 || capacity < text.length + 1)
        {
            writeDwordIf(lengthPointer >>> 0, text.length + 1);
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        writeText(buffer, text);
        writeDwordIf(lengthPointer >>> 0, text.length);
        return TRUE;
    };

    /**
     * answerText for the wide entry points: the same protocol, counted in
     * bytes of UTF-16.
     *
     * @param {number} buffer @param {number} lengthPointer @param {string} text
     * @returns {number} TRUE or FALSE
     */
    const answerWide = (buffer, lengthPointer, text)=>{
        const capacity = lengthPointer === 0 ? 0 : readDword(lengthPointer >>> 0);
        if (buffer === 0 || capacity < (text.length + 1) * 2)
        {
            writeDwordIf(lengthPointer >>> 0, (text.length + 1) * 2);
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        writeWide(buffer, text);
        writeDwordIf(lengthPointer >>> 0, text.length * 2);
        return TRUE;
    };

    /**
     * The buffer protocol of the URL functions, counted in characters both
     * ways: the room asked for has the terminator, the length written does
     * not. InternetCreateUrlW alone asks for its room in bytes, as documented.
     *
     * @param {number} buffer @param {number} lengthPointer @param {string} text
     * @param {boolean} wide @param {boolean} [roomInBytes]
     */
    const answerUrl = (buffer, lengthPointer, text, wide, roomInBytes = false)=>{
        const needed = (wide ? text.length : encodeAnsi(text).length) + 1;
        if (buffer === 0 || readDword(lengthPointer) < needed)
        {
            writeDword(lengthPointer, roomInBytes ? needed * 2 : needed);
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        writer(wide)(buffer, text);
        writeDword(lengthPointer, needed - 1);
        return TRUE;
    };

    /** A DWORD option's answer. @param {number} buffer @param {number} lengthPointer @param {number} value */
    const answerDword = (buffer, lengthPointer, value)=>{
        if (buffer === 0 || readDword(lengthPointer) < 4)
        {
            writeDword(lengthPointer, 4);
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        writeDword(buffer, value >>> 0);
        writeDword(lengthPointer, 4);
        return TRUE;
    };

    /**
     * Writes one component of a URL_COMPONENTS.
     *
     * Three cases, chosen by what the caller left in the structure. A buffer
     * with a capacity gets a copy. A null pointer with a non-zero length gets a
     * pointer *into the caller's own URL* and the component's length -- which is
     * why the parser keeps offsets and never normalises. Both zero means the
     * caller did not ask for this component at all. Lengths are characters,
     * so a wide URL's offsets are twice its characters in bytes.
     *
     * @param {number} base       The structure.
     * @param {number} pointerAt  Offset of the pointer member.
     * @param {number} lengthAt   Offset of its length member.
     * @param {number} urlAddress Where the caller's URL sits in guest memory.
     * @param {import('./url.js').UrlPart} value
     * @param {boolean} wide
     */
    const writeComponent = (base, pointerAt, lengthAt, urlAddress, value, wide)=>{
        const pointer = readDword(base + pointerAt);
        const length = readDword(base + lengthAt);
        if (pointer === 0)
        {
            if (length === 0)
            {
                return;
            }
            writeDword(base + pointerAt,
                value.text.length === 0 ? 0 : urlAddress + value.at * (wide ? 2 : 1));
            writeDword(base + lengthAt, value.text.length);
            return;
        }
        const room = Math.max(0, length - 1);
        writer(wide)(pointer, value.text.slice(0, room));
        writeDword(base + lengthAt, Math.min(value.text.length, room));
    };

    /**
     * Everything a request needs to be sent, gathered from the three handles it
     * was built across.
     *
     * @param {WininetHandle} request
     */
    const requestUrl = request=>{
        const connection = handles.get(request.parent);
        if (!connection)
        {
            return null;
        }
        return buildUrl({
            host: connection.state.host,
            port: connection.state.port,
            secure: connection.state.secure,
            objectName: request.state.objectName,
        });
    };

    /**
     * Copies out of the response body and advances the cursor. Both readers go
     * through here so that the cursor cannot advance in one and not the other.
     *
     * @param {WininetHandle} request
     * @param {number} buffer
     * @param {number} capacity
     * @returns {number} how many bytes were taken
     */
    const readBody = (request, buffer, capacity)=>{
        const response = request.state.response;
        if (!response)
        {
            return 0;
        }
        const from = request.state.readOffset;
        const taken = Math.max(0, Math.min(capacity, response.body.length - from));
        if (taken > 0 && buffer !== 0)
        {
            host.writeMemory(buffer, response.body.subarray(from, from + taken));
            request.state.readOffset = from + taken;
        }
        return taken;
    };

    /**
     * Sends a request and keeps what came back, answering TRUE once it is
     * in -- a promise, which is what parks the calling thread.
     *
     * What goes out is the headers HttpAddRequestHeaders gathered, then the
     * ones given to the send, which win on a clash, then the jar's cookies
     * unless the request was opened without them or carries its own.
     *
     * @param {number} handle @param {WininetHandle} request
     * @param {string} headerText @param {Uint8Array | null} body
     * @returns {number | Promise<number>}
     */
    const send = (handle, request, headerText, body)=>{
        const url = requestUrl(request);
        if (!url)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if (!host.request)
        {
            return fail(ERROR_INTERNET_CANNOT_CONNECT);
        }
        /** @type {Record<string, string>} */
        const headers = {};
        for (const [name, value] of request.state.headers)
        {
            headers[name] = value;
        }
        Object.assign(headers, parseHeaders(headerText));
        const withCookies = (request.state.flags & INTERNET_FLAG_NO_COOKIES) === 0;
        if (withCookies && !Object.keys(headers).some(name=>name.toLowerCase() === 'cookie'))
        {
            const jar = cookies.get(url);
            if ('text' in jar)
            {
                headers.Cookie = jar.text;
            }
        }
        const sending = { method: request.state.verb, url, headers, body };
        return host.request(sending).then(response=>{
            // The handle may have been closed while this was in flight,
            // in which case there is nothing left to deliver it to.
            if (!handles.has(handle >>> 0))
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            /** @type {Record<string, string>} */
            const received = {};
            for (const [name, value] of Object.entries(response.headers ?? {}))
            {
                received[name.toLowerCase()] = value;
            }
            const setCookie = received['set-cookie'];
            if (withCookies && setCookie)
            {
                // Several cookies arrive folded into one value; a comma that
                // starts the next "name=" separates them, and the one inside
                // an expiry date does not.
                for (const one of setCookie.split(/,(?=\s*[^;,=\s]+=)/))
                {
                    cookies.set(url, null, one);
                }
            }
            request.state.response = {
                status: response.status >>> 0,
                statusText: response.statusText ?? '',
                headers: received,
                body: response.body ?? new Uint8Array(0),
            };
            request.state.readOffset = 0;
            return TRUE;
        }, ()=>fail(ERROR_INTERNET_CANNOT_CONNECT));
    };

    /**
     * InternetOpen, reading its text with `read`.
     *
     * @param {(pointer: number) => string} read
     */
    const openSession = read=>(/** @type {number[]} */ args)=>{
        const [agent, accessType, proxy, bypass, flags] = args;
        return allocate('session', 0, {
            agent: read(agent),
            accessType: accessType >>> 0,
            proxy: read(proxy),
            bypass: read(bypass),
            flags: flags >>> 0,
            callback: 0,
            context: 0,
        });
    };

    /**
     * InternetOpenUrl: a connection and a GET of the URL under the session in
     * one call, sent before it answers with the request; HTTP and HTTPS only.
     * A request that could not be sent takes its connection with it.
     *
     * @param {boolean} wide
     */
    const openUrl = wide=>(/** @type {number[]} */ args)=>{
        const [session, url, headers, headersLength, flags, context] = args;
        if (!resolve(session, 'session'))
        {
            return failHandle(ERROR_INVALID_HANDLE);
        }
        const read = reader(wide);
        const cracked = crackUrl(read(url));
        const scheme = cracked?.scheme.text.toLowerCase();
        if (!cracked || (scheme !== 'http' && scheme !== 'https'))
        {
            return failHandle(ERROR_INTERNET_UNRECOGNIZED_SCHEME);
        }
        const count = headersLength >>> 0;
        const headerText = (headers >>> 0) === 0 ? ''
            : count === 0xffffffff ? read(headers)
                : wide ? readWide(headers, count)
                    : decodeAnsi(host.readMemory(headers >>> 0, count));
        const connection = allocate('connect', session >>> 0, {
            host: cracked.host.text,
            port: cracked.port,
            secure: scheme === 'https',
            user: cracked.user.text,
            password: cracked.password.text,
            context: context >>> 0,
        });
        const handle = allocate('request', connection, {
            verb: 'GET',
            objectName: (cracked.path.text || '/') + cracked.extra.text,
            referrer: '',
            flags: flags >>> 0,
            context: context >>> 0,
            headers: [],
            pending: null,
            response: null,
            readOffset: 0,
        });
        /** @param {number} sent */
        const answer = sent=>{
            if (sent === TRUE)
            {
                return handle;
            }
            handles.delete(handle);
            handles.delete(connection);
            return 0;
        };
        const sent = send(handle, /** @type {WininetHandle} */ (resolve(handle, 'request')),
            headerText, null);
        return sent instanceof Promise ? sent.then(answer) : answer(sent);
    };

    /**
     * InternetConnect.
     *
     * HTTP makes a connection handle and touches no server. FTP and Gopher
     * reach theirs at once, and there is none to reach: with no network the
     * name does not resolve, and with a transport -- which speaks HTTP only --
     * the server cannot be connected to.
     *
     * @param {boolean} wide
     */
    const connect = wide=>(/** @type {number[]} */ args)=>{
        const [session, server, port, user, password, service, flags, context] = args;
        const read = reader(wide);
        if (!resolve(session, 'session'))
        {
            return failHandle(ERROR_INVALID_HANDLE);
        }
        const name = read(server);
        if (name === '')
        {
            return failHandle(ERROR_INVALID_PARAMETER);
        }
        const kind = service >>> 0;
        if (kind === INTERNET_SERVICE_FTP || kind === INTERNET_SERVICE_GOPHER)
        {
            // A password with no user to go with it is refused before
            // anything is dialled.
            if (kind === INTERNET_SERVICE_FTP && password !== 0 && read(user) === '')
            {
                return failHandle(ERROR_INVALID_PARAMETER);
            }
            if (!online())
            {
                return failHandle(ERROR_INTERNET_NAME_NOT_RESOLVED);
            }
            if (!otherServiceReported)
            {
                otherServiceReported = true;
                host.divergence?.('WinINet', 'InternetConnect: FTP and Gopher are not served');
            }
            return failHandle(ERROR_INTERNET_CANNOT_CONNECT);
        }
        if (kind !== INTERNET_SERVICE_HTTP)
        {
            return failHandle(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
        }
        const secure = ((flags >>> 0) & INTERNET_FLAG_SECURE) !== 0;
        const asked = (port >>> 0) & 0xffff;
        return allocate('connect', session >>> 0, {
            host: name,
            // Zero is INTERNET_INVALID_PORT_NUMBER, which asks for the
            // scheme's own default rather than for port zero.
            port: asked === 0 ? defaultPort(secure ? 'https' : 'http') : asked,
            secure,
            user: read(user),
            password: read(password),
            context: context >>> 0,
        });
    };

    /**
     * HttpOpenRequest. A null verb is GET, which is what the header says and
     * what every client that omits it expects.
     *
     * @param {boolean} wide
     */
    const openRequest = wide=>(/** @type {number[]} */ args)=>{
        const [connection, verb, objectName, , referrer, , flags, context] = args;
        const read = reader(wide);
        const parent = resolve(connection, 'connect');
        if (!parent)
        {
            return failHandle(ERROR_INVALID_HANDLE);
        }
        if (((flags >>> 0) & INTERNET_FLAG_SECURE) !== 0)
        {
            // The flag is accepted here as well as on the connection,
            // and either one making the request secure is what a client
            // that sets it in only one place depends on.
            parent.state.secure = true;
        }
        return allocate('request', connection >>> 0, {
            verb: (read(verb) || 'GET').toUpperCase(),
            objectName: read(objectName) || '/',
            referrer: read(referrer),
            flags: flags >>> 0,
            context: context >>> 0,
            headers: [],
            pending: null,
            response: null,
            readOffset: 0,
        });
    };

    /**
     * HttpSendRequest. Answers with a promise, which is what parks the calling
     * thread; the value it settles to is what the guest finds in EAX when it
     * wakes.
     *
     * @param {boolean} wide
     */
    const sendRequest = wide=>(/** @type {number[]} */ args)=>{
        const [handle, headers, headersLength, optional, optionalLength] = args;
        const request = requestOf(handle);
        if (typeof request === 'number')
        {
            return fail(request);
        }
        // Read before the promise is made, not inside it. What the arguments
        // point at belongs to the caller's frame, and by the time this
        // settles the frame is somewhere else entirely.
        const text = readCounted(headers, headersLength, wide);
        if (text === null)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const bodyLength = optionalLength >>> 0;
        const body = optional !== 0 && bodyLength > 0
            ? host.readMemory(optional >>> 0, bodyLength)
            : null;
        return send(handle, request, text, body);
    };

    /**
     * HttpSendRequestEx: the headers and the first of the body now, the rest
     * of the body by InternetWriteFile, and the send itself at HttpEndRequest.
     * Nothing leaves before the end, so a machine with no transport says so
     * here, where a real one would have failed to connect.
     *
     * @param {boolean} wide
     */
    const sendRequestEx = wide=>(/** @type {number[]} */ args)=>{
        const [handle, buffersIn, buffersOut] = args;
        const request = requestOf(handle);
        if (typeof request === 'number')
        {
            return fail(request);
        }
        if ((buffersOut >>> 0) !== 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        let headerText = '';
        /** @type {Uint8Array[]} */
        const chunks = [];
        const base = buffersIn >>> 0;
        if (base !== 0)
        {
            if (readDword(base + INTERNET_BUFFERS.dwStructSize) !== INTERNET_BUFFERS.SIZE)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const text = readCounted(readDword(base + INTERNET_BUFFERS.lpcszHeader),
                readDword(base + INTERNET_BUFFERS.dwHeadersLength), wide);
            if (text === null)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            headerText = text;
            const first = readDword(base + INTERNET_BUFFERS.lpvBuffer);
            const firstLength = readDword(base + INTERNET_BUFFERS.dwBufferLength);
            if (first !== 0 && firstLength > 0)
            {
                chunks.push(host.readMemory(first, firstLength));
            }
        }
        if (!online())
        {
            return fail(ERROR_INTERNET_CANNOT_CONNECT);
        }
        request.state.pending = { headerText, chunks };
        request.state.response = null;
        host.setLastError(ERROR_SUCCESS);
        return TRUE;
    };

    /**
     * HttpEndRequest: sends what HttpSendRequestEx began. lpBuffersOut is
     * reserved and must be null.
     *
     * @param {number[]} args
     */
    const endRequest = ([handle, buffersOut])=>{
        const request = requestOf(handle);
        if (typeof request === 'number')
        {
            return fail(request);
        }
        if ((buffersOut >>> 0) !== 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const pending = request.state.pending;
        if (!pending)
        {
            return fail(ERROR_INTERNET_INCORRECT_HANDLE_STATE);
        }
        request.state.pending = null;
        const total = pending.chunks.reduce(
            (/** @type {number} */ sum, /** @type {Uint8Array} */ chunk)=>sum + chunk.length, 0);
        const body = new Uint8Array(total);
        let at = 0;
        for (const chunk of pending.chunks)
        {
            body.set(chunk, at);
            at += chunk.length;
        }
        return send(handle, request, pending.headerText, total > 0 ? body : null);
    };

    /**
     * HttpAddRequestHeaders: one or more "Name: value" lines, split at any
     * run of CR and LF, each applied by the modifier. REPLACE takes the first
     * header of the name out and puts the new one at the end -- or only takes
     * it out, for an empty value -- and falls back to adding only with ADD;
     * ADD_IF_NEW refuses a name already there; COALESCE folds the value into
     * the first of the name; ADD, and no modifier, append.
     *
     * @param {boolean} wide
     */
    const addRequestHeaders = wide=>(/** @type {number[]} */ args)=>{
        const [handle, headers, headersLength, modifiers] = args;
        const request = requestOf(handle);
        if (typeof request === 'number')
        {
            return fail(request);
        }
        const count = (headersLength >>> 0) === 0 ? 0xffffffff : headersLength;
        const text = (headers >>> 0) === 0 ? null : readCounted(headers, count, wide);
        const lines = (text ?? '').split(/[\r\n]+/).filter(line=>line.trim() !== '');
        if (lines.length === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const flags = modifiers >>> 0;
        /** @type {[string, string][]} */
        const list = request.state.headers;
        for (const line of lines)
        {
            const colon = line.indexOf(':');
            if (colon <= 0)
            {
                return fail(ERROR_HTTP_INVALID_HEADER);
            }
            const name = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim();
            const found = list.findIndex(([held])=>held.toLowerCase() === name.toLowerCase());
            if ((flags & HTTP_ADDREQ_FLAG_REPLACE) !== 0)
            {
                if (found !== -1)
                {
                    list.splice(found, 1);
                }
                else if ((flags & HTTP_ADDREQ_FLAG_ADD) === 0)
                {
                    return fail(ERROR_HTTP_HEADER_NOT_FOUND);
                }
                if (value !== '')
                {
                    list.push([name, value]);
                }
                continue;
            }
            if (value === '')
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            if ((flags & HTTP_ADDREQ_FLAG_ADD_IF_NEW) !== 0 && found !== -1)
            {
                return fail(ERROR_HTTP_HEADER_ALREADY_EXISTS);
            }
            const separator = (flags & HTTP_ADDREQ_FLAG_COALESCE_WITH_COMMA) !== 0 ? ', '
                : (flags & HTTP_ADDREQ_FLAG_COALESCE_WITH_SEMICOLON) !== 0 ? '; ' : null;
            if (separator !== null && found !== -1)
            {
                list[found][1] += separator + value;
                continue;
            }
            list.push([name, value]);
        }
        return TRUE;
    };

    /**
     * HttpQueryInfo, its text in UTF-16 when `wide`.
     *
     * The flag in the high bits decides what the buffer receives. With NUMBER
     * it is a DWORD; without it, text. Getting that backwards is the usual
     * defect here, and it looks like success. REQUEST_HEADERS reads what will
     * be sent rather than what came back, and needs nothing to have been sent.
     *
     * @param {boolean} wide
     */
    const queryInfo = wide=>(/** @type {number[]} */ args)=>{
        const [handle, infoLevel, buffer, lengthPointer, indexPointer] = args;
        const request = resolve(handle, 'request');
        if (!request)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        const level = infoLevel >>> 0;
        const query = level & 0xffff;
        /** The name a level asks for: its own, or the caller's for CUSTOM. */
        const nameOf = ()=>(query === HTTP_QUERY_CUSTOM
            ? reader(wide)(buffer).toLowerCase() : QUERY_HEADERS.get(query));
        const index = (indexPointer >>> 0) === 0 ? 0 : readDword(indexPointer >>> 0);

        // Every branch below either assigns this or returns, so it is a
        // string by the time anything reads it.
        /** @type {string} */
        let text;
        if ((level & HTTP_QUERY_FLAG_REQUEST_HEADERS) !== 0)
        {
            /** @type {[string, string][]} */
            const list = request.state.headers;
            if (query === HTTP_QUERY_RAW_HEADERS_CRLF || query === HTTP_QUERY_RAW_HEADERS)
            {
                const lines = [`${request.state.verb} ${request.state.objectName} HTTP/1.1`,
                    ...list.map(([name, value])=>`${name}: ${value}`)];
                text = query === HTTP_QUERY_RAW_HEADERS ? `${lines.join('\0')}\0`
                    : `${lines.join('\r\n')}\r\n\r\n`;
            }
            else
            {
                const name = nameOf();
                const matching = list.filter(([held])=>held.toLowerCase() === name);
                if (index >= matching.length)
                {
                    return fail(ERROR_HTTP_HEADER_NOT_FOUND);
                }
                text = matching[index][1];
            }
        }
        else
        {
            const response = request.state.response;
            if (!response)
            {
                // Nothing has been sent, so there are no response headers to
                // read -- distinct from a header that is simply absent.
                return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
            }
            const raw = [...Object.entries(response.headers)]
                .map(([name, value])=>`${name}: ${value}`);
            if (query === HTTP_QUERY_STATUS_CODE)
            {
                text = String(response.status);
            }
            else if (query === HTTP_QUERY_STATUS_TEXT)
            {
                text = response.statusText;
            }
            else if (query === HTTP_QUERY_VERSION)
            {
                text = 'HTTP/1.1';
            }
            else if (query === HTTP_QUERY_RAW_HEADERS)
            {
                // NUL between headers and two at the end, which is what the
                // name distinguishes from the CRLF form below.
                text = `${raw.join('\0')}\0`;
            }
            else if (query === HTTP_QUERY_RAW_HEADERS_CRLF)
            {
                text = `${raw.join('\r\n')}\r\n\r\n`;
            }
            else
            {
                // The transport hands over one value per name, so there is
                // never a second of anything.
                const name = nameOf();
                const found = name === undefined || index > 0 ? undefined
                    : response.headers[name];
                if (found === undefined)
                {
                    return fail(ERROR_HTTP_HEADER_NOT_FOUND);
                }
                text = found;
            }
        }

        let answered;
        if ((level & HTTP_QUERY_FLAG_NUMBER) !== 0)
        {
            const value = Number.parseInt(text, 10);
            if (!Number.isFinite(value))
            {
                return fail(ERROR_HTTP_HEADER_NOT_FOUND);
            }
            answered = answerDword(buffer >>> 0, lengthPointer >>> 0, value);
        }
        else
        {
            answered = (wide ? answerWide : answerText)(buffer >>> 0, lengthPointer >>> 0, text);
        }
        if (answered === TRUE && (indexPointer >>> 0) !== 0)
        {
            writeDword(indexPointer >>> 0, index + 1);
        }
        return answered;
    };

    /**
     * InternetCrackUrl: the one function here that does no I/O, and the one
     * clients use most -- it is how a URL in a configuration file becomes the
     * arguments for InternetConnect and HttpOpenRequest.
     *
     * @param {boolean} wide
     */
    const crack = wide=>(/** @type {number[]} */ args)=>{
        const [url, urlLength, , components] = args;
        if (url === 0 || components === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const base = components >>> 0;
        if (readDword(base + URL_COMPONENTS.dwStructSize) !== URL_COMPONENTS.SIZE)
        {
            // A caller that did not set dwStructSize is a caller built against
            // a different structure, and writing into it by our offsets would
            // corrupt its stack.
            return fail(ERROR_INVALID_PARAMETER);
        }

        const length = urlLength >>> 0;
        const address = url >>> 0;
        // Zero means the string is null-terminated; anything else is an
        // explicit length, and the string need not be terminated at all.
        const text = length === 0 ? reader(wide)(address, MAX_TEXT)
            : /** @type {string} */ (readCounted(address, length, wide));

        const cracked = crackUrl(text);
        if (!cracked)
        {
            return fail(text.includes(':')
                ? ERROR_INTERNET_UNRECOGNIZED_SCHEME
                : ERROR_INTERNET_INVALID_URL);
        }

        writeDword(base + URL_COMPONENTS.nScheme, schemeNumber(cracked.scheme.text));
        writeWord(base + URL_COMPONENTS.nPort, cracked.port);
        writeComponent(base, URL_COMPONENTS.lpszScheme,
            URL_COMPONENTS.dwSchemeLength, address, cracked.scheme, wide);
        writeComponent(base, URL_COMPONENTS.lpszHostName,
            URL_COMPONENTS.dwHostNameLength, address, cracked.host, wide);
        writeComponent(base, URL_COMPONENTS.lpszUserName,
            URL_COMPONENTS.dwUserNameLength, address, cracked.user, wide);
        writeComponent(base, URL_COMPONENTS.lpszPassword,
            URL_COMPONENTS.dwPasswordLength, address, cracked.password, wide);
        writeComponent(base, URL_COMPONENTS.lpszUrlPath,
            URL_COMPONENTS.dwUrlPathLength, address, cracked.path, wide);
        writeComponent(base, URL_COMPONENTS.lpszExtraInfo,
            URL_COMPONENTS.dwExtraInfoLength, address, cracked.extra, wide);
        return TRUE;
    };

    /**
     * InternetCreateUrl: the inverse of cracking, from a URL_COMPONENTS whose
     * strings are each a pointer and a length -- a zero length meaning the
     * string is terminated, a null pointer meaning the part is absent.
     *
     * @param {boolean} wide
     */
    const create = wide=>(/** @type {number[]} */ args)=>{
        const [components, flags, url, lengthPointer] = args;
        if (components === 0 || lengthPointer === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const base = components >>> 0;
        if (readDword(base + URL_COMPONENTS.dwStructSize) !== URL_COMPONENTS.SIZE)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        /** @param {number} pointerAt @param {number} lengthAt */
        const part = (pointerAt, lengthAt)=>{
            const pointer = readDword(base + pointerAt);
            return pointer === 0 ? null
                : readCounted(pointer, readDword(base + lengthAt) || 0xffffffff, wide);
        };
        const built = createUrl({
            scheme: part(URL_COMPONENTS.lpszScheme, URL_COMPONENTS.dwSchemeLength),
            nScheme: readDword(base + URL_COMPONENTS.nScheme) | 0,
            host: part(URL_COMPONENTS.lpszHostName, URL_COMPONENTS.dwHostNameLength),
            port: host.readMemory(base + URL_COMPONENTS.nPort, 2)[0]
                | host.readMemory(base + URL_COMPONENTS.nPort, 2)[1] << 8,
            user: part(URL_COMPONENTS.lpszUserName, URL_COMPONENTS.dwUserNameLength),
            password: part(URL_COMPONENTS.lpszPassword, URL_COMPONENTS.dwPasswordLength),
            path: part(URL_COMPONENTS.lpszUrlPath, URL_COMPONENTS.dwUrlPathLength),
            extra: part(URL_COMPONENTS.lpszExtraInfo, URL_COMPONENTS.dwExtraInfoLength),
        }, ((flags >>> 0) & ICU_ESCAPE) !== 0
            ? text=>canonicalizeUrl(text, ICU_NO_META) : undefined);
        if (built === null)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        return answerUrl(url >>> 0, lengthPointer >>> 0, built, wide, wide);
    };

    /**
     * InternetCanonicalizeUrl. The length is characters without the
     * terminator on success and the size the caller must allocate on failure
     * -- the same two-call shape as the rest of the library.
     *
     * @param {boolean} wide
     */
    const canonicalize = wide=>(/** @type {number[]} */ args)=>{
        const [url, buffer, length, flags] = args;
        if (url === 0 || length === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        if ((flags & ICU_BROWSER_MODE) !== 0 && !browserModeReported)
        {
            // Browser mode leaves everything after the first "?" or "#"
            // untouched; this canonicalises the whole string.
            browserModeReported = true;
            host.divergence?.('WinINet',
                'InternetCanonicalizeUrl: ICU_BROWSER_MODE is not honoured');
        }
        const canonical = canonicalizeUrl(reader(wide)(url), flags >>> 0);
        return answerUrl(buffer >>> 0, length >>> 0, canonical, wide);
    };

    /**
     * InternetQueryOption. A null handle asks about the process; a handle
     * asks about itself, and an option that belongs to another kind of handle
     * is the wrong handle type.
     *
     * @param {boolean} wide
     */
    const queryOption = wide=>(/** @type {number[]} */ args)=>{
        const [handle, option, buffer, lengthPointer] = args;
        if ((lengthPointer >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const target = handle === 0 ? null : resolve(handle);
        if (handle !== 0 && !target)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        const out = buffer >>> 0;
        const length = lengthPointer >>> 0;
        const text = wide ? answerWide : answerText;
        switch (option >>> 0)
        {
            case Option.CONNECT_TIMEOUT:
            case Option.CONNECT_RETRIES:
            case Option.SEND_TIMEOUT:
            case Option.RECEIVE_TIMEOUT:
            case Option.DATA_SEND_TIMEOUT:
            case Option.DATA_RECEIVE_TIMEOUT:
                return answerDword(out, length,
                    (target ? target.state.options : globalOptions).get(option >>> 0));
            case Option.MAX_CONNS_PER_SERVER:
            case Option.MAX_CONNS_PER_1_0_SERVER:
                return target ? fail(ERROR_INTERNET_INVALID_OPERATION)
                    : answerDword(out, length, connectionLimits.get(option >>> 0) ?? 0);
            case Option.HANDLE_TYPE:
                return target ? answerDword(out, length, HANDLE_TYPES[target.kind])
                    : fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
            case Option.CONTEXT_VALUE:
                return target ? answerDword(out, length, target.state.context ?? 0)
                    : fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
            case Option.ERROR_MASK:
                return target ? answerDword(out, length, target.state.errorMask ?? 0)
                    : fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
            case Option.REQUEST_FLAGS:
                if (target?.kind !== 'request')
                {
                    if (!target)
                    {
                        writeDword(length, 0);
                    }
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
                }
                return answerDword(out, length,
                    target.state.response ? 0 : INTERNET_REQFLAG_NO_HEADERS);
            case Option.USER_AGENT:
                return target?.kind === 'session' ? text(out, length, target.state.agent)
                    : fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
            case Option.URL:
            {
                const url = target?.kind === 'request' ? requestUrl(target) : null;
                return url === null ? fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE)
                    : text(out, length, url);
            }
            case Option.USERNAME:
            case Option.PASSWORD:
            {
                const connection = target?.kind === 'request' ? handles.get(target.parent)
                    : target?.kind === 'connect' ? target : null;
                if (!connection)
                {
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
                }
                return text(out, length, (option >>> 0) === Option.USERNAME
                    ? connection.state.user : connection.state.password);
            }
            case Option.VERSION:
            {
                // INTERNET_VERSION_INFO: 1.2, the version WinINet has
                // answered since it was first versioned.
                if (out === 0 || readDword(length) < 8)
                {
                    writeDword(length, 8);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                writeDword(out, 1);
                writeDword(out + 4, 2);
                writeDword(length, 8);
                return TRUE;
            }
            case Option.CONNECTED_STATE:
                return answerDword(out, length,
                    online() ? INTERNET_STATE_CONNECTED : INTERNET_STATE_DISCONNECTED);
            case Option.PROXY:
                return answerProxy(target, out, length, wide);
            case Option.POLICY:
                return fail(ERROR_INVALID_PARAMETER);
            default:
                return fail(ERROR_INTERNET_INVALID_OPTION);
        }
    };

    /**
     * INTERNET_PROXY_INFO: the access type and two string pointers, the
     * strings written after the structure in the same buffer. With no proxy
     * configured anywhere, a session opened to take the machine's settings
     * has a direct connection.
     *
     * @param {WininetHandle | null} target @param {number} out
     * @param {number} length @param {boolean} wide
     */
    const answerProxy = (target, out, length, wide)=>{
        if (target && target.kind !== 'session')
        {
            return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
        }
        const accessType = !target || target.state.accessType === INTERNET_OPEN_TYPE_PRECONFIG
            ? INTERNET_OPEN_TYPE_DIRECT : target.state.accessType;
        const proxy = target?.state.proxy ?? '';
        const bypass = target?.state.bypass ?? '';
        /** @param {string} text */
        const size = text=>(text === '' ? 0
            : wide ? (text.length + 1) * 2 : encodeAnsi(text).length + 1);
        const needed = 12 + size(proxy) + size(bypass);
        if (out === 0 || readDword(length) < needed)
        {
            writeDword(length, needed);
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        writeDword(out, accessType);
        let at = out + 12;
        for (const [slot, text] of /** @type {[number, string][]} */ ([[4, proxy], [8, bypass]]))
        {
            writeDword(out + slot, text === '' ? 0 : at);
            if (text !== '')
            {
                writer(wide)(at, text);
                at += size(text);
            }
        }
        writeDword(length, needed);
        return TRUE;
    };

    /**
     * InternetSetOption and InternetSetOptionEx, whose extra flags change
     * nothing here.
     *
     * An option this does not know is accepted and kept, never acted on: every
     * such option a client sets is about how the stack should behave -- buffer
     * sizes, a proxy -- and all of that belongs to the transport, which is not
     * ours. Refusing them would fail clients that are only tuning.
     *
     * @param {boolean} wide
     */
    const setOption = wide=>(/** @type {number[]} */ args)=>{
        const [handle, option, buffer, length] = args;
        // A null handle sets the option process-wide, which is legal.
        const target = handle === 0 ? null : resolve(handle);
        if (handle !== 0 && !target)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        const value = ()=>((buffer >>> 0) === 0 ? 0 : readDword(buffer >>> 0));
        const read = ()=>reader(wide)(buffer >>> 0);
        switch (option >>> 0)
        {
            case Option.CONNECT_TIMEOUT:
            case Option.CONNECT_RETRIES:
            case Option.SEND_TIMEOUT:
            case Option.RECEIVE_TIMEOUT:
            case Option.DATA_SEND_TIMEOUT:
            case Option.DATA_RECEIVE_TIMEOUT:
                if ((length >>> 0) < 4)
                {
                    return fail(ERROR_INTERNET_BAD_OPTION_LENGTH);
                }
                (target ? target.state.options : globalOptions).set(option >>> 0, value());
                return TRUE;
            case Option.MAX_CONNS_PER_SERVER:
            case Option.MAX_CONNS_PER_1_0_SERVER:
                if (target)
                {
                    return fail(ERROR_INTERNET_INVALID_OPERATION);
                }
                if ((length >>> 0) !== 4)
                {
                    return fail(ERROR_INTERNET_BAD_OPTION_LENGTH);
                }
                connectionLimits.set(option >>> 0, value());
                return TRUE;
            case Option.ERROR_MASK:
                if (!target)
                {
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
                }
                if ((length >>> 0) !== 4)
                {
                    return fail(ERROR_INTERNET_BAD_OPTION_LENGTH);
                }
                if ((value() & ~ERROR_MASK_BITS) !== 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                target.state.errorMask = value();
                return TRUE;
            case Option.POLICY:
                return fail(ERROR_INVALID_PARAMETER);
            case Option.REFRESH:
                // Reloading the proxy settings is a session's business.
                return target && target.kind !== 'session'
                    ? fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE) : TRUE;
            case Option.USER_AGENT:
                if (target?.kind !== 'session')
                {
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
                }
                target.state.agent = read();
                return TRUE;
            case Option.USERNAME:
            case Option.PASSWORD:
            {
                const connection = target?.kind === 'request' ? handles.get(target.parent)
                    : target?.kind === 'connect' ? target : null;
                if (!connection)
                {
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
                }
                connection.state[(option >>> 0) === Option.USERNAME ? 'user' : 'password'] = read();
                return TRUE;
            }
            case Option.CONTEXT_VALUE:
                if (!target)
                {
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
                }
                target.state.context = value();
                return TRUE;
            default:
                return TRUE;
        }
    };

    /**
     * INTERNET_STATUS_CALLBACK InternetSetStatusCallback(HINTERNET,
     *     INTERNET_STATUS_CALLBACK lpfnInternetCallback)
     *
     * Kept, and returned when it is replaced, which is the whole of its
     * contract for a handle that completes its work synchronously. Nothing
     * calls it, and that is correct rather than unfinished: WinInet notifies
     * through this only for an operation that could not finish immediately,
     * and every operation here finishes before its caller is resumed. A
     * client that asked for INTERNET_FLAG_ASYNC and got TRUE from the send
     * has been told, in the API's own terms, that there was nothing to wait
     * for -- which is a legal answer, not a simplification. The A and W
     * forms differ only in the strings the callback would be handed.
     */
    const setStatusCallback = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([handle, callback])=>{
            const target = resolve(handle);
            if (!target)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            const previous = target.state.callback ?? 0;
            target.state.callback = callback >>> 0;
            return previous;
        },
    };

    /**
     * InternetGetConnectedStateEx: the flags, and the connection's name in
     * however much of the buffer there is -- truncated, never refused.
     * dwReserved must be zero.
     *
     * @param {boolean} wide
     */
    const connectedStateEx = wide=>(/** @type {number[]} */ args)=>{
        const [flagsPointer, name, nameLength, reserved] = args;
        if (reserved !== 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        writeDwordIf(flagsPointer >>> 0, connectedFlags());
        const room = nameLength >>> 0;
        if ((name >>> 0) !== 0 && room > 0)
        {
            writer(wide)(name, (online() ? LAN_CONNECTION_NAME : '').slice(0, room - 1));
        }
        host.setLastError(ERROR_SUCCESS);
        return online() ? TRUE : FALSE;
    };

    /** What InternetGetConnectedState reports: RAS is always there, a LAN only online. */
    const connectedFlags = ()=>(online() ? INTERNET_CONNECTION_LAN | INTERNET_RAS_INSTALLED
        : INTERNET_RAS_INSTALLED);

    /**
     * InternetGetLastResponseInfo: the text of the last FTP or Gopher reply on
     * this thread. No such server has ever answered here, so there is none --
     * an empty text and error zero, which is a success.
     *
     * @param {boolean} wide
     */
    const lastResponseInfo = wide=>(/** @type {number[]} */ args)=>{
        const [errorPointer, buffer, lengthPointer] = args;
        if ((errorPointer >>> 0) === 0 || (lengthPointer >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        writeDword(errorPointer >>> 0, 0);
        if ((buffer >>> 0) !== 0 && readDword(lengthPointer >>> 0) > 0)
        {
            writer(wide)(buffer, '');
        }
        writeDword(lengthPointer >>> 0, 0);
        return TRUE;
    };

    /**
     * InternetTimeToSystemTime(LPCTSTR lpszTime, SYSTEMTIME *pst, DWORD dwReserved)
     *
     * @param {boolean} wide
     */
    const timeToSystemTime = wide=>(/** @type {number[]} */ args)=>{
        const [text, out] = args;
        if ((text >>> 0) === 0 || (out >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const time = parseInternetTime(reader(wide)(text));
        const bytes = new Uint8Array(SYSTEMTIME_SIZE);
        const view = new DataView(bytes.buffer);
        [time.year, time.month, time.dayOfWeek, time.day, time.hour, time.minute, time.second, 0]
            .forEach((value, slot)=>view.setUint16(slot * 2, value & 0xffff, true));
        host.writeMemory(out >>> 0, bytes);
        return TRUE;
    };

    /**
     * InternetGetCookie(LPCTSTR lpszUrl, LPCTSTR lpszCookieName,
     *   LPTSTR lpszCookieData, LPDWORD lpdwSize)
     *
     * The name is not looked at, as on Windows: every cookie for the URL comes
     * back. Sizes are characters with the terminator -- except that the wide
     * form asks for its room in bytes, which is what its callers allocate.
     * No buffer is a question about the size, and answered as a success.
     *
     * @param {boolean} wide
     */
    const getCookie = wide=>(/** @type {number[]} */ args)=>{
        const [url, , data, sizePointer] = args;
        if ((url >>> 0) === 0 || (sizePointer >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const found = cookies.get(reader(wide)(url));
        if ('error' in found)
        {
            if (found.error === ERROR_NO_MORE_ITEMS)
            {
                writeDword(sizePointer >>> 0, 0);
            }
            return fail(found.error);
        }
        const needed = (wide ? found.text.length : encodeAnsi(found.text).length) + 1;
        const room = wide ? needed * 2 : needed;
        if ((data >>> 0) === 0)
        {
            writeDword(sizePointer >>> 0, room);
            return TRUE;
        }
        if (readDword(sizePointer >>> 0) < needed)
        {
            writeDword(sizePointer >>> 0, room);
            return fail(ERROR_INSUFFICIENT_BUFFER);
        }
        writer(wide)(data, found.text);
        writeDword(sizePointer >>> 0, needed);
        return TRUE;
    };

    /**
     * InternetSetCookie(LPCTSTR lpszUrl, LPCTSTR lpszCookieName, LPCTSTR lpszCookieData)
     *
     * @param {boolean} wide
     */
    const setCookie = wide=>(/** @type {number[]} */ args)=>{
        const [url, name, data] = args;
        if ((url >>> 0) === 0 || (data >>> 0) === 0)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const read = reader(wide);
        const refused = cookies.set(read(url), (name >>> 0) === 0 ? null : read(name), read(data));
        return refused ? fail(refused.error) : TRUE;
    };

    /**
     * InternetErrorDlg(HWND, HINTERNET hRequest, DWORD dwError, DWORD dwFlags,
     *   LPVOID *lppvData)
     *
     * There is no dialog to show. Asked for none (NO_UI), it answers what
     * Windows answers without one; asked for one, the dialog was closed
     * without a choice, which is a cancel. A request handle that is not one
     * is refused, and so is a window that is not there when a dialog would
     * need it. The answer is the return value and the last error is left
     * alone.
     *
     * @param {number[]} args
     */
    const errorDialog = ([window, handle, error, flags])=>{
        if (handle !== 0 && !resolve(handle, 'request'))
        {
            return ERROR_INVALID_HANDLE;
        }
        const noUi = ((flags >>> 0) & FLAGS_ERROR_UI_FLAGS_NO_UI) !== 0;
        if (window === 0 && !noUi)
        {
            return ERROR_INVALID_HANDLE;
        }
        const known = ERROR_DIALOG_ANSWERS.get(error >>> 0);
        if (known?.needsRequest && handle === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if (!known && ((flags >>> 0) & FLAGS_ERROR_UI_FILTER_FOR_ERRORS) !== 0)
        {
            // Filtering looks for an error the response hides -- a demand
            // for credentials -- and finds one only in a 401 or 407.
            const status = handle === 0 ? 0 : resolve(handle)?.state.response?.status;
            return status === 401 || status === 407 ? ERROR_CANCELLED : ERROR_SUCCESS;
        }
        return noUi && known ? known.answer : ERROR_CANCELLED;
    };

    return {
        /**
         * HINTERNET InternetOpenA(LPCSTR lpszAgent, DWORD dwAccessType,
         *                         LPCSTR lpszProxy, LPCSTR lpszProxyBypass,
         *                         DWORD dwFlags)
         *
         * The proxy arguments are read and kept but never acted on: whatever
         * reaches the network is the transport's, and a proxy is its business.
         */
        InternetOpenA: {
            argBytes: 20,
            handler: openSession(readText),
        },

        /** HINTERNET InternetOpenW(LPCWSTR, DWORD, LPCWSTR, LPCWSTR, DWORD): InternetOpenA in UTF-16 */
        InternetOpenW: {
            argBytes: 20,
            handler: openSession(readWide),
        },

        /**
         * HINTERNET InternetOpenUrlA(HINTERNET hInternet, LPCSTR lpszUrl,
         *                            LPCSTR lpszHeaders, DWORD dwHeadersLength,
         *                            DWORD dwFlags, DWORD_PTR dwContext)
         */
        InternetOpenUrlA: {
            argBytes: 24,
            handler: openUrl(false),
        },

        /** HINTERNET InternetOpenUrlW(...): InternetOpenUrlA in UTF-16 */
        InternetOpenUrlW: {
            argBytes: 24,
            handler: openUrl(true),
        },

        /**
         * HINTERNET InternetConnectA(HINTERNET, LPCSTR lpszServerName,
         *                            INTERNET_PORT nServerPort, LPCSTR lpszUserName,
         *                            LPCSTR lpszPassword, DWORD dwService,
         *                            DWORD dwFlags, DWORD_PTR dwContext)
         */
        InternetConnectA: { argBytes: 32, handler: connect(false) },
        InternetConnectW: { argBytes: 32, handler: connect(true) },

        /**
         * HINTERNET HttpOpenRequestA(HINTERNET, LPCSTR lpszVerb, LPCSTR lpszObjectName,
         *                            LPCSTR lpszVersion, LPCSTR lpszReferrer,
         *                            LPCSTR *lplpszAcceptTypes, DWORD dwFlags,
         *                            DWORD_PTR dwContext)
         */
        HttpOpenRequestA: { argBytes: 32, handler: openRequest(false) },
        HttpOpenRequestW: { argBytes: 32, handler: openRequest(true) },

        /**
         * BOOL HttpSendRequestA(HINTERNET, LPCSTR lpszHeaders, DWORD dwHeadersLength,
         *                       LPVOID lpOptional, DWORD dwOptionalLength)
         *
         * A length of -1 means the headers are terminated, which is what a
         * client that has a string rather than a buffer passes; a length of
         * zero with headers is refused in the ANSI form and means "terminated"
         * in the wide one.
         */
        HttpSendRequestA: { argBytes: 20, handler: sendRequest(false) },
        HttpSendRequestW: { argBytes: 20, handler: sendRequest(true) },

        /**
         * BOOL HttpSendRequestExA(HINTERNET, LPINTERNET_BUFFERSA lpBuffersIn,
         *                         LPINTERNET_BUFFERSA lpBuffersOut, DWORD, DWORD_PTR)
         */
        HttpSendRequestExA: { argBytes: 20, handler: sendRequestEx(false) },
        HttpSendRequestExW: { argBytes: 20, handler: sendRequestEx(true) },

        /** BOOL HttpEndRequest(HINTERNET, LPINTERNET_BUFFERS lpBuffersOut, DWORD, DWORD_PTR) */
        HttpEndRequestA: { argBytes: 16, handler: endRequest },
        HttpEndRequestW: { argBytes: 16, handler: endRequest },

        /**
         * BOOL HttpAddRequestHeaders(HINTERNET, LPCTSTR lpszHeaders,
         *                            DWORD dwHeadersLength, DWORD dwModifiers)
         */
        HttpAddRequestHeadersA: { argBytes: 16, handler: addRequestHeaders(false) },
        HttpAddRequestHeadersW: { argBytes: 16, handler: addRequestHeaders(true) },

        /**
         * BOOL HttpQueryInfoA(HINTERNET, DWORD dwInfoLevel, LPVOID lpBuffer,
         *                     LPDWORD lpdwBufferLength, LPDWORD lpdwIndex)
         */
        HttpQueryInfoA: { argBytes: 20, handler: queryInfo(false) },

        /** BOOL HttpQueryInfoW(...): HttpQueryInfoA, its text in UTF-16 */
        HttpQueryInfoW: { argBytes: 20, handler: queryInfo(true) },

        /**
         * BOOL InternetReadFile(HINTERNET, LPVOID lpBuffer, DWORD dwNumberOfBytesToRead,
         *                       LPDWORD lpdwNumberOfBytesRead)
         *
         * End of the body is zero bytes and success, not a failure: that is how
         * a client's read loop terminates.
         */
        InternetReadFile: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, buffer, wanted, readPointer])=>{
                const request = resolve(handle, 'request');
                if (!request)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const taken = readBody(request, buffer >>> 0, wanted >>> 0);
                writeDwordIf(readPointer >>> 0, taken);
                return TRUE;
            },
        },

        /**
         * BOOL InternetReadFileExA(HINTERNET, LPINTERNET_BUFFERSA lpBuffersOut,
         *                          DWORD dwFlags, DWORD_PTR dwContext)
         *
         * The same read, through a structure rather than three arguments. What
         * makes it worth its own entry is that the structure carries the answer
         * as well as the request: dwBufferLength is the capacity going in and
         * the count coming out.
         */
        InternetReadFileExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, buffers])=>{
                if (buffers === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const request = resolve(handle, 'request');
                if (!request)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const base = buffers >>> 0;
                const buffer = readDword(base + INTERNET_BUFFERS.lpvBuffer);
                const capacity = readDword(base + INTERNET_BUFFERS.dwBufferLength);
                const taken = readBody(request, buffer, capacity);
                writeDword(base + INTERNET_BUFFERS.dwBufferLength, taken);
                const response = request.state.response;
                writeDword(base + INTERNET_BUFFERS.dwBufferTotal,
                    response ? response.body.length - request.state.readOffset : 0);
                return TRUE;
            },
        },

        /**
         * BOOL InternetQueryDataAvailable(HINTERNET, LPDWORD lpdwNumberOfBytesAvailable,
         *                                 DWORD dwFlags, DWORD_PTR dwContext)
         *
         * Everything arrived with the response, so what is available is what
         * has not been read. A request with no response, or read from a
         * position past its end, is in no state to say.
         */
        InternetQueryDataAvailable: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, available])=>{
                const request = requestOf(handle);
                if (typeof request === 'number')
                {
                    return fail(request);
                }
                const response = request.state.response;
                if (!response || request.state.readOffset > response.body.length)
                {
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_STATE);
                }
                if ((available >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeDword(available >>> 0, response.body.length - request.state.readOffset);
                return TRUE;
            },
        },

        /**
         * DWORD InternetSetFilePointer(HINTERNET, LONG lDistanceToMove,
         *   PVOID pReserved, DWORD dwMoveMethod, DWORD_PTR dwContext)
         *
         * Moves the read position in a response that is kept -- one whose
         * request was not opened with NO_CACHE_WRITE. FILE_BEGIN takes the
         * distance as written, even past the end; the other two refuse to land
         * before the start. Fails with INVALID_SET_FILE_POINTER, and clears the
         * last error on success, since a position of 0xFFFFFFFF is legal.
         */
        InternetSetFilePointer: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, distance, , method])=>{
                const INVALID_SET_FILE_POINTER = 0xffffffff;
                const request = requestOf(handle);
                if (typeof request === 'number')
                {
                    host.setLastError(request);
                    return INVALID_SET_FILE_POINTER;
                }
                const response = request.state.response;
                if (!response || (request.state.flags & INTERNET_FLAG_NO_CACHE_WRITE) !== 0)
                {
                    host.setLastError(ERROR_INTERNET_INVALID_OPERATION);
                    return INVALID_SET_FILE_POINTER;
                }
                let position;
                switch (method >>> 0)
                {
                    case 0: position = distance >>> 0; break;
                    case 1: position = request.state.readOffset + (distance | 0); break;
                    case 2: position = response.body.length + (distance | 0); break;
                    default:
                        host.setLastError(ERROR_INVALID_PARAMETER);
                        return INVALID_SET_FILE_POINTER;
                }
                if (position < 0)
                {
                    host.setLastError(ERROR_NEGATIVE_SEEK);
                    return INVALID_SET_FILE_POINTER;
                }
                request.state.readOffset = position;
                host.setLastError(ERROR_SUCCESS);
                return position >>> 0;
            },
        },

        /**
         * BOOL InternetWriteFile(HINTERNET, LPCVOID lpBuffer,
         *   DWORD dwNumberOfBytesToWrite, LPDWORD lpdwNumberOfBytesWritten)
         *
         * The body of a request begun by HttpSendRequestEx, kept until
         * HttpEndRequest sends it all. A request not begun that way has no
         * body to add to.
         */
        InternetWriteFile: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, buffer, count, written])=>{
                const request = requestOf(handle);
                if (typeof request === 'number')
                {
                    return fail(request);
                }
                if (!request.state.pending)
                {
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_STATE);
                }
                const length = count >>> 0;
                if (length > 0)
                {
                    request.state.pending.chunks.push(host.readMemory(buffer >>> 0, length));
                }
                writeDwordIf(written >>> 0, length);
                return TRUE;
            },
        },

        /**
         * BOOL InternetCrackUrlA(LPCSTR lpszUrl, DWORD dwUrlLength, DWORD dwFlags,
         *                        LPURL_COMPONENTSA lpUrlComponents)
         */
        InternetCrackUrlA: { argBytes: 16, handler: crack(false) },
        InternetCrackUrlW: { argBytes: 16, handler: crack(true) },

        /**
         * BOOL InternetCreateUrlA(LPURL_COMPONENTSA, DWORD dwFlags, LPSTR lpszUrl,
         *                         LPDWORD lpdwUrlLength)
         */
        InternetCreateUrlA: { argBytes: 16, handler: create(false) },
        InternetCreateUrlW: { argBytes: 16, handler: create(true) },

        /**
         * BOOL InternetCanonicalizeUrlA(LPCSTR lpszUrl, LPSTR lpszBuffer,
         *                               LPDWORD lpdwBufferLength, DWORD dwFlags)
         */
        InternetCanonicalizeUrlA: { argBytes: 16, handler: canonicalize(false) },
        InternetCanonicalizeUrlW: { argBytes: 16, handler: canonicalize(true) },

        /** BOOL InternetQueryOption(HINTERNET, DWORD dwOption, LPVOID, LPDWORD) */
        InternetQueryOptionA: { argBytes: 16, handler: queryOption(false) },
        InternetQueryOptionW: { argBytes: 16, handler: queryOption(true) },

        /** BOOL InternetSetOption(HINTERNET, DWORD dwOption, LPVOID, DWORD) */
        InternetSetOptionA: { argBytes: 16, handler: setOption(false) },
        InternetSetOptionW: { argBytes: 16, handler: setOption(true) },
        /** BOOL InternetSetOptionEx(HINTERNET, DWORD, LPVOID, DWORD, DWORD dwFlags) */
        InternetSetOptionExA: { argBytes: 20, handler: setOption(false) },
        InternetSetOptionExW: { argBytes: 20, handler: setOption(true) },

        InternetSetStatusCallback: setStatusCallback,
        InternetSetStatusCallbackA: setStatusCallback,
        InternetSetStatusCallbackW: setStatusCallback,

        /** BOOL InternetGetConnectedState(LPDWORD lpdwFlags, DWORD dwReserved) */
        InternetGetConnectedState: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([flagsPointer])=>{
                writeDwordIf(flagsPointer >>> 0, connectedFlags());
                host.setLastError(ERROR_SUCCESS);
                return online() ? TRUE : FALSE;
            },
        },

        /**
         * BOOL InternetGetConnectedStateEx(LPDWORD lpdwFlags, LPTSTR lpszConnectionName,
         *   DWORD dwNameLen, DWORD dwReserved): exported as the ANSI form too.
         */
        InternetGetConnectedStateEx: { argBytes: 16, handler: connectedStateEx(false) },
        InternetGetConnectedStateExA: { argBytes: 16, handler: connectedStateEx(false) },
        InternetGetConnectedStateExW: { argBytes: 16, handler: connectedStateEx(true) },

        /**
         * DWORD InternetAttemptConnect(DWORD dwReserved)
         *
         * The connection is the transport, so there is one to attempt only
         * when there is a transport. Answers with its error, not the last one.
         */
        InternetAttemptConnect: {
            argBytes: 4,
            handler: ()=>(online() ? ERROR_SUCCESS : ERROR_INTERNET_CANNOT_CONNECT),
        },

        /** BOOL InternetAutodial(DWORD dwFlags, HWND hwndParent): nothing to dial, only to have */
        InternetAutodial: {
            argBytes: 8,
            handler: ()=>(online() ? TRUE : fail(ERROR_INTERNET_CANNOT_CONNECT)),
        },

        /**
         * BOOL InternetGoOnlineW(LPCWSTR lpszURL, HWND hwndParent, DWORD dwFlags)
         *
         * Online already, it is; offline, the dialog that would offer to
         * connect has nothing to connect with.
         */
        InternetGoOnlineW: {
            argBytes: 12,
            handler: ()=>(online() ? TRUE : fail(ERROR_INTERNET_CANNOT_CONNECT)),
        },

        /** DWORD InternetErrorDlg(HWND, HINTERNET, DWORD dwError, DWORD dwFlags, LPVOID *) */
        InternetErrorDlg: { argBytes: 20, handler: errorDialog },

        /** BOOL InternetGetLastResponseInfo(LPDWORD lpdwError, LPTSTR, LPDWORD lpdwBufferLength) */
        InternetGetLastResponseInfoA: { argBytes: 12, handler: lastResponseInfo(false) },
        InternetGetLastResponseInfoW: { argBytes: 12, handler: lastResponseInfo(true) },

        /** BOOL InternetTimeToSystemTime(LPCTSTR, SYSTEMTIME *, DWORD): exported bare too */
        InternetTimeToSystemTime: { argBytes: 12, handler: timeToSystemTime(false) },
        InternetTimeToSystemTimeA: { argBytes: 12, handler: timeToSystemTime(false) },
        InternetTimeToSystemTimeW: { argBytes: 12, handler: timeToSystemTime(true) },

        InternetGetCookieA: { argBytes: 16, handler: getCookie(false) },
        InternetGetCookieW: { argBytes: 16, handler: getCookie(true) },
        InternetSetCookieA: { argBytes: 12, handler: setCookie(false) },
        InternetSetCookieW: { argBytes: 12, handler: setCookie(true) },

        /**
         * BOOL InternetSetPerSiteCookieDecisionW(LPCWSTR pchHostName, DWORD dwDecision)
         *
         * Kept for the run, by host; COOKIE_STATE_UNKNOWN forgets the site.
         * The decisions are a record for the program to read back: what the
         * jar accepts does not change with them.
         */
        InternetSetPerSiteCookieDecisionW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([site, decision])=>{
                if ((site >>> 0) === 0 || (decision >>> 0) > COOKIE_STATE_REJECT)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const name = readWide(site).toLowerCase();
                if ((decision >>> 0) === COOKIE_STATE_UNKNOWN)
                {
                    cookieDecisions.delete(name);
                }
                else
                {
                    cookieDecisions.set(name, decision >>> 0);
                }
                return TRUE;
            },
        },

        /**
         * BOOL InternetGetPerSiteCookieDecisionW(LPCWSTR pchHostName, ULONG *pResult)
         *
         * FALSE for a site with no decision, which is all MSDN promises; the
         * last error is not part of that answer.
         */
        InternetGetPerSiteCookieDecisionW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([site, result])=>{
                if ((site >>> 0) === 0 || (result >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const decision = cookieDecisions.get(readWide(site).toLowerCase());
                if (decision === undefined)
                {
                    return FALSE;
                }
                writeDword(result >>> 0, decision);
                return TRUE;
            },
        },

        /**
         * BOOL InternetEnumPerSiteCookieDecisionW(LPWSTR pszSiteName,
         *   ULONG *pcSiteNameSize, ULONG *pdwDecision, ULONG dwIndex)
         *
         * The decisions in the order they were made; the name's room is in
         * characters with the terminator.
         */
        InternetEnumPerSiteCookieDecisionW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, sizePointer, decision, index])=>{
                if ((sizePointer >>> 0) === 0 || (decision >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const entry = [...cookieDecisions][index >>> 0];
                if (!entry)
                {
                    return fail(ERROR_NO_MORE_ITEMS);
                }
                const needed = entry[0].length + 1;
                if ((name >>> 0) === 0 || readDword(sizePointer >>> 0) < needed)
                {
                    writeDword(sizePointer >>> 0, needed);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                writeWide(name, entry[0]);
                writeDword(sizePointer >>> 0, needed);
                writeDword(decision >>> 0, entry[1]);
                return TRUE;
            },
        },

        /** BOOL InternetClearAllPerSiteCookieDecisions(void) */
        InternetClearAllPerSiteCookieDecisions: {
            argBytes: 0,
            handler: ()=>{
                cookieDecisions.clear();
                return TRUE;
            },
        },

        /**
         * DWORD PrivacySetZonePreferenceW(DWORD dwZone, DWORD dwType,
         *   DWORD dwTemplate, LPCWSTR pszPreference)
         *
         * Accepted for the five zones and the two party types. No cookie the
         * jar holds is judged by zone, so there is nothing for it to change.
         */
        PrivacySetZonePreferenceW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([zone, type])=>((zone >>> 0) > 4 || (type >>> 0) > 1
                ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS),
        },

        /**
         * DWORD InternetConfirmZoneCrossingW(HWND, LPWSTR szUrlPrev,
         *   LPWSTR szUrlNew, BOOL bPost)
         *
         * The warning about crossing between http and https is a setting, and
         * a machine with no dialog to show it on has it switched off: the
         * crossing is allowed.
         */
        InternetConfirmZoneCrossingW: { argBytes: 16, handler: ()=>ERROR_SUCCESS },

        /**
         * BOOL InternetShowSecurityInfoByURLW(LPWSTR lpszURL, HWND hwndParent)
         *
         * Shows the certificate a secure connection to the URL presented. The
         * transport's connections are not ours to inspect, so no certificate
         * is known for any URL.
         */
        InternetShowSecurityInfoByURLW: refuse('InternetShowSecurityInfoByURLW', {
            argBytes: 8, answer: FALSE, lastError: ERROR_INTERNET_ITEM_NOT_FOUND,
            why: 'no server certificate is known here',
        }),

        /**
         * BOOL InternetInitializeAutoProxyDll(DWORD dwReserved)
         *
         * Proxy discovery is the transport's; there is nothing here to load.
         */
        InternetInitializeAutoProxyDll: { argBytes: 4, handler: ()=>TRUE },

        /**
         * BOOL InternetCloseHandle(HINTERNET)
         *
         * Takes the subtree with it. A connection whose session is gone cannot
         * be used to make a request, so leaving it reachable would let a client
         * build one and find out only later.
         */
        InternetCloseHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const target = handle >>> 0;
                if (!handles.has(target))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const doomed = new Set([target]);
                // The tree is at most three deep and built parent-first, so one
                // pass in insertion order reaches every descendant.
                for (const [id, held] of handles)
                {
                    if (doomed.has(held.parent))
                    {
                        doomed.add(id);
                    }
                }
                for (const id of doomed)
                {
                    handles.delete(id);
                }
                return TRUE;
            },
        },

        ...createFtpFunctions({
            setLastError: host.setLastError,
            divergence: host.divergence,
            isHandle: handle=>handles.has(handle),
        }),

        ...createCacheFunctions({ setLastError: host.setLastError, divergence: host.divergence }),
    };
}
