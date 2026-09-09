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

import { URL_COMPONENTS, buildUrl, crackUrl, defaultPort, schemeNumber } from './url.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

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
 * change what the URL names.
 *
 * @param {string} url @param {number} flags
 * @returns {string}
 */
export function canonicalizeUrl(url, flags){
    let text = url;
    if ((flags & ICU_DECODE) !== 0)
    {
        text = text.replace(/%([0-9a-fA-F]{2})/g,
            (_, hex)=>String.fromCharCode(parseInt(hex, 16)));
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
            const unsafe = spacesOnly
                ? code === 0x20
                : code <= 0x20 || code >= 0x7f || '"<>\\^`{|}'.includes(character)
                    || (percent && character === '%');
            encoded += unsafe && code <= 0xff
                ? `%${code.toString(16).toUpperCase().padStart(2, '0')}`
                : character;
        }
        text = encoded;
    }
    return text;
}

const ERROR_INTERNET_INVALID_URL = 12005;
const ERROR_INTERNET_UNRECOGNIZED_SCHEME = 12006;
const ERROR_INTERNET_INCORRECT_HANDLE_TYPE = 12018;
const ERROR_INTERNET_CANNOT_CONNECT = 12029;
const ERROR_HTTP_HEADER_NOT_FOUND = 12150;

/** INTERNET_SERVICE_HTTP. The only service this surface answers for. */
const INTERNET_SERVICE_HTTP = 3;

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
    [0, 'mime-version'],
    [1, 'content-type'],
    [5, 'content-length'],
    [9, 'date'],
    [10, 'expires'],
    [11, 'last-modified'],
]);

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
    lpvBuffer: 20,
    dwBufferLength: 24,
    dwBufferTotal: 28,
});

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
 *           [request]  The transport. Absent means this build has no network.
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

    /**
     * @param {'session' | 'connect' | 'request'} kind
     * @param {number} parent
     * @param {any} state
     */
    const allocate = (kind, parent, state)=>{
        const handle = next;
        next += HANDLE_STRIDE;
        handles.set(handle, { kind, parent, state });
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

    /**
     * Writes a string and its terminator. Latin-1 rather than UTF-8, because
     * what goes back has to be the same number of bytes the length reported.
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
     * Writes one component of a URL_COMPONENTS.
     *
     * Three cases, chosen by what the caller left in the structure. A buffer
     * with a capacity gets a copy. A null pointer with a non-zero length gets a
     * pointer *into the caller's own URL* and the component's length -- which is
     * why the parser keeps offsets and never normalises. Both zero means the
     * caller did not ask for this component at all.
     *
     * @param {number} base       The structure.
     * @param {number} pointerAt  Offset of the pointer member.
     * @param {number} lengthAt   Offset of its length member.
     * @param {number} urlAddress Where the caller's URL sits in guest memory.
     * @param {import('./url.js').UrlPart} value
     */
    const writeComponent = (base, pointerAt, lengthAt, urlAddress, value)=>{
        const pointer = readDword(base + pointerAt);
        const length = readDword(base + lengthAt);
        if (pointer === 0)
        {
            if (length === 0)
            {
                return;
            }
            writeDword(base + pointerAt, value.text.length === 0 ? 0 : urlAddress + value.at);
            writeDword(base + lengthAt, value.text.length);
            return;
        }
        const room = Math.max(0, length - 1);
        writeText(pointer, value.text.slice(0, room));
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
            /** @param {number[]} args */
            handler: ([agent, accessType, proxy, , flags])=>allocate('session', 0, {
                agent: readText(agent),
                accessType: accessType >>> 0,
                proxy: readText(proxy),
                flags: flags >>> 0,
                callback: 0,
            }),
        },

        /**
         * HINTERNET InternetConnectA(HINTERNET, LPCSTR lpszServerName,
         *                            INTERNET_PORT nServerPort, LPCSTR lpszUserName,
         *                            LPCSTR lpszPassword, DWORD dwService,
         *                            DWORD dwFlags, DWORD_PTR dwContext)
         *
         * Only HTTP. A client asking for FTP is told the handle type is wrong
         * rather than handed a connection that will fail later for a reason it
         * cannot relate to what it asked for.
         */
        InternetConnectA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([session, server, port, user, password, service, flags, context])=>{
                const parent = resolve(session, 'session');
                if (!parent)
                {
                    return failHandle(ERROR_INVALID_HANDLE);
                }
                if ((service >>> 0) !== INTERNET_SERVICE_HTTP)
                {
                    return failHandle(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
                }
                const name = readText(server);
                if (name === '')
                {
                    return failHandle(ERROR_INVALID_PARAMETER);
                }
                const secure = ((flags >>> 0) & INTERNET_FLAG_SECURE) !== 0;
                const asked = (port >>> 0) & 0xffff;
                return allocate('connect', session >>> 0, {
                    host: name,
                    // Zero is INTERNET_INVALID_PORT_NUMBER, which asks for the
                    // scheme's own default rather than for port zero.
                    port: asked === 0 ? defaultPort(secure ? 'https' : 'http') : asked,
                    secure,
                    user: readText(user),
                    password: readText(password),
                    context: context >>> 0,
                });
            },
        },

        /**
         * HINTERNET HttpOpenRequestA(HINTERNET, LPCSTR lpszVerb, LPCSTR lpszObjectName,
         *                            LPCSTR lpszVersion, LPCSTR lpszReferrer,
         *                            LPCSTR *lplpszAcceptTypes, DWORD dwFlags,
         *                            DWORD_PTR dwContext)
         *
         * A null verb is GET, which is what the header says and what every
         * client that omits it expects.
         */
        HttpOpenRequestA: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([connection, verb, objectName, , referrer, , flags, context])=>{
                const parent = resolve(connection, 'connect');
                if (!parent)
                {
                    return failHandle(ERROR_INVALID_HANDLE);
                }
                const secure = ((flags >>> 0) & INTERNET_FLAG_SECURE) !== 0;
                if (secure)
                {
                    // The flag is accepted here as well as on the connection,
                    // and either one making the request secure is what a client
                    // that sets it in only one place depends on.
                    parent.state.secure = true;
                }
                return allocate('request', connection >>> 0, {
                    verb: (readText(verb) || 'GET').toUpperCase(),
                    objectName: readText(objectName) || '/',
                    referrer: readText(referrer),
                    flags: flags >>> 0,
                    context: context >>> 0,
                    response: null,
                    readOffset: 0,
                });
            },
        },

        /**
         * BOOL HttpSendRequestA(HINTERNET, LPCSTR lpszHeaders, DWORD dwHeadersLength,
         *                       LPVOID lpOptional, DWORD dwOptionalLength)
         *
         * Answers with a promise, which is what parks the calling thread. The
         * value it settles to is what the guest finds in EAX when it wakes.
         */
        HttpSendRequestA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, headers, headersLength, optional, optionalLength])=>{
                const request = resolve(handle, 'request');
                if (!request)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const url = requestUrl(request);
                if (!url)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!host.request)
                {
                    return fail(ERROR_INTERNET_CANNOT_CONNECT);
                }

                // -1 means "the block is null-terminated, measure it yourself",
                // which is what a client that has a string rather than a buffer
                // passes.
                const length = headersLength >>> 0;
                const text = headers === 0
                    ? ''
                    : length === 0xffffffff
                        ? readText(headers)
                        : new TextDecoder('latin1')
                            .decode(host.readMemory(headers >>> 0, length));

                const bodyLength = optionalLength >>> 0;
                const body = optional !== 0 && bodyLength > 0
                    ? host.readMemory(optional >>> 0, bodyLength)
                    : null;

                // Read before the promise is made, not inside it. What the
                // arguments point at belongs to the caller's frame, and by the
                // time this settles the frame is somewhere else entirely.
                const sending = {
                    method: request.state.verb,
                    url,
                    headers: parseHeaders(text),
                    body,
                };

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
                    request.state.response = {
                        status: response.status >>> 0,
                        statusText: response.statusText ?? '',
                        headers: received,
                        body: response.body ?? new Uint8Array(0),
                    };
                    request.state.readOffset = 0;
                    return TRUE;
                }, ()=>fail(ERROR_INTERNET_CANNOT_CONNECT));
            },
        },

        /**
         * BOOL HttpQueryInfoA(HINTERNET, DWORD dwInfoLevel, LPVOID lpBuffer,
         *                     LPDWORD lpdwBufferLength, LPDWORD lpdwIndex)
         *
         * The flag in the high bits decides what the buffer receives. With
         * NUMBER it is a DWORD; without it, text. Getting that backwards is the
         * usual defect here, and it looks like success.
         */
        HttpQueryInfoA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, infoLevel, buffer, lengthPointer])=>{
                const request = resolve(handle, 'request');
                if (!request)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const response = request.state.response;
                if (!response)
                {
                    // Nothing has been sent, so there are no response headers to
                    // read -- distinct from a header that is simply absent.
                    return fail(ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
                }
                const level = infoLevel >>> 0;
                if ((level & HTTP_QUERY_FLAG_REQUEST_HEADERS) !== 0)
                {
                    // Request headers are not kept after sending; saying so is
                    // better than answering with the response's.
                    return fail(ERROR_HTTP_HEADER_NOT_FOUND);
                }

                const query = level & 0xffff;
                const raw = [...Object.entries(response.headers)]
                    .map(([name, value])=>`${name}: ${value}`);

                // Every branch below either assigns this or returns, so it is
                // a string by the time anything reads it.
                /** @type {string} */
                let text;
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
                    const name = QUERY_HEADERS.get(query);
                    const found = name === undefined ? undefined : response.headers[name];
                    if (found === undefined)
                    {
                        return fail(ERROR_HTTP_HEADER_NOT_FOUND);
                    }
                    text = found;
                }

                if ((level & HTTP_QUERY_FLAG_NUMBER) !== 0)
                {
                    const value = Number.parseInt(text, 10);
                    if (!Number.isFinite(value))
                    {
                        return fail(ERROR_HTTP_HEADER_NOT_FOUND);
                    }
                    if (buffer === 0 || readDword(lengthPointer >>> 0) < 4)
                    {
                        writeDwordIf(lengthPointer >>> 0, 4);
                        return fail(ERROR_INSUFFICIENT_BUFFER);
                    }
                    writeDword(buffer >>> 0, value >>> 0);
                    writeDwordIf(lengthPointer >>> 0, 4);
                    return TRUE;
                }
                return answerText(buffer >>> 0, lengthPointer >>> 0, text);
            },
        },

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
         * BOOL InternetCrackUrlA(LPCSTR lpszUrl, DWORD dwUrlLength, DWORD dwFlags,
         *                        LPURL_COMPONENTSA lpUrlComponents)
         *
         * The one function here that does no I/O, and the one clients use most:
         * it is how a URL in a configuration file becomes the arguments for
         * InternetConnect and HttpOpenRequest.
         */
        InternetCrackUrlA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([url, urlLength, , components])=>{
                if (url === 0 || components === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const base = components >>> 0;
                if (readDword(base + URL_COMPONENTS.dwStructSize) !== URL_COMPONENTS.SIZE)
                {
                    // A caller that did not set dwStructSize is a caller built
                    // against a different structure, and writing into it by our
                    // offsets would corrupt its stack.
                    return fail(ERROR_INVALID_PARAMETER);
                }

                const length = urlLength >>> 0;
                const address = url >>> 0;
                // Zero means the string is null-terminated; anything else is an
                // explicit length, and the string need not be terminated at all.
                const text = length === 0
                    ? readText(address, MAX_TEXT)
                    : new TextDecoder('latin1').decode(host.readMemory(address, length));

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
                    URL_COMPONENTS.dwSchemeLength, address, cracked.scheme);
                writeComponent(base, URL_COMPONENTS.lpszHostName,
                    URL_COMPONENTS.dwHostNameLength, address, cracked.host);
                writeComponent(base, URL_COMPONENTS.lpszUserName,
                    URL_COMPONENTS.dwUserNameLength, address, cracked.user);
                writeComponent(base, URL_COMPONENTS.lpszPassword,
                    URL_COMPONENTS.dwPasswordLength, address, cracked.password);
                writeComponent(base, URL_COMPONENTS.lpszUrlPath,
                    URL_COMPONENTS.dwUrlPathLength, address, cracked.path);
                writeComponent(base, URL_COMPONENTS.lpszExtraInfo,
                    URL_COMPONENTS.dwExtraInfoLength, address, cracked.extra);
                return TRUE;
            },
        },

        /**
         * BOOL InternetSetOptionA(HINTERNET, DWORD dwOption, LPVOID lpBuffer,
         *                         DWORD dwBufferLength)
         *
         * Accepted and kept, never acted on. Every option a client sets here is
         * about how the stack should behave -- timeouts, buffer sizes, retry
         * counts, a proxy -- and all of that belongs to the transport, which is
         * not ours. Refusing them would fail clients that are only tuning.
         */
        InternetSetOptionA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, option, , length])=>{
                // A null handle sets the option process-wide, which is legal.
                const target = handle === 0 ? null : resolve(handle);
                if (handle !== 0 && !target)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (target)
                {
                    (target.state.options ??= new Map()).set(option >>> 0, length >>> 0);
                }
                return TRUE;
            },
        },

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
         * for -- which is a legal answer, not a simplification.
         */
        InternetSetStatusCallback: {
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
        },

        /**
         * BOOL InternetCanonicalizeUrlA(LPCSTR lpszUrl, LPSTR lpszBuffer,
         *                               LPDWORD lpdwBufferLength, DWORD dwFlags)
         *
         * The length is characters without the terminator on success and the
         * size the caller must allocate on failure -- the same two-call shape
         * as the rest of the library.
         */
        InternetCanonicalizeUrlA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([url, buffer, length, flags])=>{
                if (url === 0 || length === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if ((flags & ICU_BROWSER_MODE) !== 0 && !browserModeReported)
                {
                    // Browser mode leaves everything after the first "?" or
                    // "#" untouched; this canonicalises the whole string.
                    browserModeReported = true;
                    host.divergence?.('WinINet',
                        'InternetCanonicalizeUrl: ICU_BROWSER_MODE is not honoured');
                }
                const canonical = canonicalizeUrl(readText(url), flags >>> 0);
                const needed = canonical.length + 1;
                if (buffer === 0 || readDword(length) < needed)
                {
                    writeDword(length, needed);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                writeText(buffer, canonical);
                writeDword(length, canonical.length);
                return TRUE;
            },
        },

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
    };
}
