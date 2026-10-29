/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WinHTTP: the service-grade HTTP client, and the place Windows answers
 * "which proxy?" from.
 *
 * A browser that carries its own network stack still links this library for
 * the second question: it reads the user's proxy settings
 * (WinHttpGetIEProxyConfigForCurrentUser) and, when they say "detect", asks
 * the resolver. This machine has no proxy and no WPAD server: the settings
 * are a direct connection, detection fails as it does on a network without
 * one, and a script URL cannot be downloaded.
 *
 * Sessions, connections and requests are a tree of handles as in WinINet,
 * closed by WinHttpCloseHandle. A request is refused when sent: there is no
 * transport behind this library (WinINet's `http` is the one an embedder
 * supplies), so it fails as a request to an unreachable server does, never
 * with a made-up response.
 */

import { crackUrl } from '../wininet/url.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_WINHTTP_INVALID_URL = 12005;
const ERROR_WINHTTP_UNRECOGNIZED_SCHEME = 12006;
const ERROR_WINHTTP_INCORRECT_HANDLE_TYPE = 12018;
const ERROR_WINHTTP_INCORRECT_HANDLE_STATE = 12019;
const ERROR_WINHTTP_CANNOT_CONNECT = 12029;
const ERROR_WINHTTP_UNABLE_TO_DOWNLOAD_SCRIPT = 12167;
const ERROR_WINHTTP_AUTODETECTION_FAILED = 12180;

/** WINHTTP_ACCESS_TYPE_NO_PROXY: what WinHttpGetDefaultProxyConfiguration answers. */
const ACCESS_TYPE_NO_PROXY = 1;
/** WINHTTP_AUTOPROXY_OPTIONS.dwFlags: detect, or a script by URL. */
const AUTOPROXY_AUTO_DETECT = 0x1;
const AUTOPROXY_CONFIG_URL = 0x2;
/** WINHTTP_INVALID_STATUS_CALLBACK. */
const INVALID_STATUS_CALLBACK = 0xffffffff;

/** URL_COMPONENTS (WinHTTP's is WinINet's layout), and WinHTTP's own scheme numbers. */
const URL = Object.freeze({ SIZE: 60, scheme: 4, schemeLength: 8, nScheme: 12, host: 16,
    hostLength: 20, port: 24, user: 28, userLength: 32, password: 36, passwordLength: 40,
    path: 44, pathLength: 48, extra: 52, extraLength: 56 });
const SCHEMES = Object.freeze({ http: 1, https: 2 });

/** Where handles are numbered from: opaque and never a pointer. */
const HANDLE_BASE = 0x5e000000;

/** Characters a URL may run to, read terminated. */
const MAX_URL = 0x8000;

/**
 * @typedef {Object} WinhttpHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {WinhttpHost} host */
export function createWinhttpFunctions(host){
    /** @param {number} address */
    const dword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    };
    /** @param {number} address @param {number} value */
    const setDword = (address, value)=>{
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, out);
    };
    /** @param {number} address @param {number} value */
    const setWord = (address, value)=>host.writeMemory(address >>> 0,
        Uint8Array.of(value & 0xff, (value >>> 8) & 0xff));
    /** @param {number} code @param {number} [value] */
    const fail = (code, value = 0)=>{
        host.setLastError(code);
        return value;
    };
    /**
     * UTF-16 text: `count` characters, or up to the terminator when it is 0.
     *
     * @param {number} address @param {number} [count]
     */
    const readWide = (address, count = 0)=>{
        let text = '';
        for (let at = 0; at < (count || MAX_URL); at++)
        {
            const bytes = host.readMemory((address >>> 0) + at * 2, 2);
            const unit = bytes[0] | bytes[1] << 8;
            if (unit === 0 && count === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };
    /** @param {number} address @param {string} text */
    const writeWide = (address, text)=>{
        const out = new Uint8Array(text.length * 2 + 2);
        for (let i = 0; i < text.length; i++)
        {
            out[i * 2] = text.charCodeAt(i) & 0xff;
            out[i * 2 + 1] = text.charCodeAt(i) >>> 8;
        }
        host.writeMemory(address >>> 0, out);
    };

    /**
     * @typedef {{ kind: 'session' | 'connect' | 'request' | 'resolver', parent: number,
     *     callback: number }} WinhttpHandle
     */
    /** @type {Map<number, WinhttpHandle>} */
    const handles = new Map();
    let next = HANDLE_BASE;
    /** @param {WinhttpHandle['kind']} kind @param {number} parent */
    const open = (kind, parent)=>{
        const handle = next;
        next += 4;
        handles.set(handle, { kind, parent, callback: 0 });
        return handle;
    };
    /** A handle of one of `kinds`, or why not. @param {number} handle @param {string[]} kinds */
    const handleOf = (handle, kinds)=>{
        const found = handles.get(handle >>> 0);
        if (!found)
        {
            return { error: ERROR_INVALID_HANDLE };
        }
        return kinds.includes(found.kind) ? { found }
            : { error: ERROR_WINHTTP_INCORRECT_HANDLE_TYPE };
    };
    /** Closes a handle and everything opened under it. @param {number} handle */
    const close = handle=>{
        handles.delete(handle);
        for (const [child, entry] of [...handles])
        {
            if (entry.parent === handle)
            {
                close(child);
            }
        }
    };
    /** Said once a call: a request goes nowhere. */
    const said = new Set();
    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>{
        if (!said.has(api))
        {
            said.add(api);
            host.divergence?.(api, detail);
        }
    };

    /** A call on a request that has not been sent, which none here ever is. */
    const notSent = (/** @type {number} */ argBytes)=>({
        argBytes,
        /** @param {number[]} args */
        handler: ([handle])=>{
            const { error } = handleOf(handle, ['request']);
            return fail(error ?? ERROR_WINHTTP_INCORRECT_HANDLE_STATE);
        },
    });

    return {
        /**
         * BOOL WinHttpGetIEProxyConfigForCurrentUser(
         *     WINHTTP_CURRENT_USER_IE_PROXY_CONFIG *pProxyConfig)
         *
         * fAutoDetect, then the script URL, the proxy and the bypass list,
         * each a GlobalAlloc'd string or NULL: a direct connection, all of
         * them empty.
         */
        WinHttpGetIEProxyConfigForCurrentUser: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([config])=>{
                if ((config >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                host.writeMemory(config >>> 0, new Uint8Array(16));
                return 1;
            },
        },

        /**
         * BOOL WinHttpGetDefaultProxyConfiguration(WINHTTP_PROXY_INFO *pProxyInfo)
         *
         * No proxy, nothing to bypass.
         */
        WinHttpGetDefaultProxyConfiguration: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([info])=>{
                if ((info >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                host.writeMemory(info >>> 0, new Uint8Array(12));
                setDword(info, ACCESS_TYPE_NO_PROXY);
                return 1;
            },
        },

        /**
         * HINTERNET WinHttpOpen(LPCWSTR pszAgentW, DWORD dwAccessType,
         *     LPCWSTR pszProxyW, LPCWSTR pszProxyBypassW, DWORD dwFlags)
         */
        WinHttpOpen: {
            argBytes: 20,
            handler: ()=>open('session', 0),
        },

        /** BOOL WinHttpCloseHandle(HINTERNET hInternet) */
        WinHttpCloseHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!handles.has(handle >>> 0))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                close(handle >>> 0);
                return 1;
            },
        },

        /**
         * BOOL WinHttpSetTimeouts(HINTERNET hInternet, int nResolveTimeout,
         *     int nConnectTimeout, int nSendTimeout, int nReceiveTimeout)
         *
         * Kept nowhere, nothing being sent; -1 means forever, and less is
         * refused.
         */
        WinHttpSetTimeouts: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, ...timeouts])=>{
                if (timeouts.some(timeout=>(timeout | 0) < -1))
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const { error } = handleOf(handle, ['session', 'connect', 'request']);
                return error ? fail(error) : 1;
            },
        },

        /**
         * WINHTTP_STATUS_CALLBACK WinHttpSetStatusCallback(HINTERNET hInternet,
         *     WINHTTP_STATUS_CALLBACK lpfnInternetCallback, DWORD dwNotificationFlags,
         *     DWORD_PTR dwReserved)
         *
         * The callback before, NULL the first time; WINHTTP_INVALID_STATUS_CALLBACK
         * for a handle that is none. Nothing happens here to call it for.
         */
        WinHttpSetStatusCallback: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, callback])=>{
                const entry = handles.get(handle >>> 0);
                if (!entry)
                {
                    return fail(ERROR_INVALID_HANDLE, INVALID_STATUS_CALLBACK);
                }
                const before = entry.callback;
                entry.callback = callback >>> 0;
                return before;
            },
        },

        /**
         * BOOL WinHttpCrackUrl(LPCWSTR pwszUrl, DWORD dwUrlLength, DWORD dwFlags,
         *     LPURL_COMPONENTS lpUrlComponents)
         *
         * WinINet's split, with WinHTTP's two schemes and their numbers
         * (INTERNET_SCHEME_HTTP 1, HTTPS 2). A component asked for with a
         * NULL pointer and a nonzero length is pointed into the URL; one with
         * a buffer is copied with its terminator.
         */
        WinHttpCrackUrl: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([url, length, , components])=>{
                if ((url >>> 0) === 0 || (components >>> 0) === 0
                    || dword(components) !== URL.SIZE)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const text = readWide(url, length >>> 0);
                const cracked = crackUrl(text);
                if (!cracked)
                {
                    return fail(ERROR_WINHTTP_INVALID_URL);
                }
                const scheme = /** @type {Record<string, number>} */ (SCHEMES)[
                    cracked.scheme.text.toLowerCase()];
                if (scheme === undefined)
                {
                    return fail(ERROR_WINHTTP_UNRECOGNIZED_SCHEME);
                }
                const base = components >>> 0;
                setDword(base + URL.nScheme, scheme);
                setWord(base + URL.port, cracked.port);
                for (const [part, pointerAt, lengthAt] of /** @type {const} */ ([
                    ['scheme', URL.scheme, URL.schemeLength], ['host', URL.host, URL.hostLength],
                    ['user', URL.user, URL.userLength],
                    ['password', URL.password, URL.passwordLength],
                    ['path', URL.path, URL.pathLength], ['extra', URL.extra, URL.extraLength]]))
                {
                    const value = cracked[part];
                    const pointer = dword(base + pointerAt);
                    const room = dword(base + lengthAt);
                    if (pointer === 0)
                    {
                        if (room !== 0)
                        {
                            setDword(base + pointerAt,
                                value.text === '' ? 0 : (url >>> 0) + value.at * 2);
                            setDword(base + lengthAt, value.text.length);
                        }
                        continue;
                    }
                    if (room <= value.text.length)
                    {
                        setDword(base + lengthAt, value.text.length + 1);
                        return fail(ERROR_INSUFFICIENT_BUFFER);
                    }
                    writeWide(pointer, value.text);
                    setDword(base + lengthAt, value.text.length);
                }
                return 1;
            },
        },

        /**
         * HINTERNET WinHttpConnect(HINTERNET hSession, LPCWSTR pswzServerName,
         *     INTERNET_PORT nServerPort, DWORD dwReserved)
         */
        WinHttpConnect: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([session, server])=>{
                const { error } = handleOf(session, ['session']);
                if (error)
                {
                    return fail(error);
                }
                if ((server >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                return open('connect', session >>> 0);
            },
        },

        /**
         * HINTERNET WinHttpOpenRequest(HINTERNET hConnect, LPCWSTR pwszVerb,
         *     LPCWSTR pwszObjectName, LPCWSTR pwszVersion, LPCWSTR pwszReferrer,
         *     LPCWSTR *ppwszAcceptTypes, DWORD dwFlags)
         */
        WinHttpOpenRequest: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([connect])=>{
                const { error } = handleOf(connect, ['connect']);
                return error ? fail(error) : open('request', connect >>> 0);
            },
        },

        /**
         * BOOL WinHttpAddRequestHeaders(HINTERNET hRequest, LPCWSTR lpszHeaders,
         *     DWORD dwHeadersLength, DWORD dwModifiers)
         */
        WinHttpAddRequestHeaders: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([request, headers])=>{
                const { error } = handleOf(request, ['request']);
                if (error)
                {
                    return fail(error);
                }
                return (headers >>> 0) === 0 ? fail(ERROR_INVALID_PARAMETER) : 1;
            },
        },

        /**
         * BOOL WinHttpSendRequest(HINTERNET hRequest, LPCWSTR lpszHeaders,
         *     DWORD dwHeadersLength, LPVOID lpOptional, DWORD dwOptionalLength,
         *     DWORD dwTotalLength, DWORD_PTR dwContext)
         *
         * There is nothing behind this library to send through: the server
         * cannot be reached, said at once even on an asynchronous session.
         */
        WinHttpSendRequest: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([request])=>{
                const { error } = handleOf(request, ['request']);
                if (error)
                {
                    return fail(error);
                }
                diverge('WinHttpSendRequest', 'WinHTTP has no transport: every request fails '
                    + 'to connect, at once');
                return fail(ERROR_WINHTTP_CANNOT_CONNECT);
            },
        },

        /** BOOL WinHttpReceiveResponse(HINTERNET hRequest, LPVOID lpReserved) */
        WinHttpReceiveResponse: notSent(8),
        /**
         * BOOL WinHttpQueryHeaders(HINTERNET hRequest, DWORD dwInfoLevel, LPCWSTR pwszName,
         *     LPVOID lpBuffer, LPDWORD lpdwBufferLength, LPDWORD lpdwIndex)
         */
        WinHttpQueryHeaders: notSent(24),
        /**
         * BOOL WinHttpReadData(HINTERNET hRequest, LPVOID lpBuffer,
         *     DWORD dwNumberOfBytesToRead, LPDWORD lpdwNumberOfBytesRead)
         */
        WinHttpReadData: notSent(16),
        /**
         * BOOL WinHttpWriteData(HINTERNET hRequest, LPCVOID lpBuffer,
         *     DWORD dwNumberOfBytesToWrite, LPDWORD lpdwNumberOfBytesWritten)
         */
        WinHttpWriteData: notSent(16),

        /**
         * BOOL WinHttpGetProxyForUrl(HINTERNET hSession, LPCWSTR lpcwszUrl,
         *     WINHTTP_AUTOPROXY_OPTIONS *pAutoProxyOptions, WINHTTP_PROXY_INFO *pProxyInfo)
         *
         * Detection finds no WPAD server; a script by URL cannot be fetched.
         */
        WinHttpGetProxyForUrl: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([session, url, options, info])=>{
                const { error } = handleOf(session, ['session']);
                if (error)
                {
                    return fail(error);
                }
                if ((url >>> 0) === 0 || (options >>> 0) === 0 || (info >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const flags = dword(options);
                if ((flags & (AUTOPROXY_AUTO_DETECT | AUTOPROXY_CONFIG_URL)) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                return fail((flags & AUTOPROXY_CONFIG_URL) !== 0
                    ? ERROR_WINHTTP_UNABLE_TO_DOWNLOAD_SCRIPT : ERROR_WINHTTP_AUTODETECTION_FAILED);
            },
        },

        /** DWORD WinHttpCreateProxyResolver(HINTERNET hSession, HINTERNET *phResolver) */
        WinHttpCreateProxyResolver: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([session, out])=>{
                const { error } = handleOf(session, ['session']);
                if (error)
                {
                    return error;
                }
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                setDword(out, open('resolver', session >>> 0));
                return 0;
            },
        },

        /**
         * DWORD WinHttpGetProxyForUrlEx(HINTERNET hResolver, PCWSTR pcwszUrl,
         *     WINHTTP_AUTOPROXY_OPTIONS *pAutoProxyOptions, DWORD_PTR pContext)
         *
         * Answered at once rather than through the callback: there is no
         * WPAD server and no script to fetch.
         */
        WinHttpGetProxyForUrlEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([resolver, url, options])=>{
                const { error } = handleOf(resolver, ['resolver']);
                if (error)
                {
                    return error;
                }
                if ((url >>> 0) === 0 || (options >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                return (dword(options) & AUTOPROXY_CONFIG_URL) !== 0
                    ? ERROR_WINHTTP_UNABLE_TO_DOWNLOAD_SCRIPT : ERROR_WINHTTP_AUTODETECTION_FAILED;
            },
        },

        /** DWORD WinHttpGetProxyResult(HINTERNET hResolver, WINHTTP_PROXY_RESULT *pProxyResult) */
        WinHttpGetProxyResult: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([resolver])=>handleOf(resolver, ['resolver']).error
                ?? ERROR_WINHTTP_INCORRECT_HANDLE_STATE,
        },

        /** VOID WinHttpFreeProxyResult(WINHTTP_PROXY_RESULT *pProxyResult) */
        WinHttpFreeProxyResult: {
            argBytes: 4,
            handler: ()=>0,
        },
    };
}

/**
 * dhcpcsvc: the DHCP client's API, which a browser asks for the WPAD option.
 * The address here is the run's, not a lease: there is no DHCP server, and a
 * parameter request names an adapter the client does not hold a lease on.
 *
 * @param {Pick<WinhttpHost, 'writeMemory'>} host
 */
export function createDhcpFunctions(host){
    const ERROR_NOT_FOUND = 1168;
    return {
        /** DWORD DhcpCApiInitialize(LPDWORD Version) -- version 2 of the API */
        DhcpCApiInitialize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([version])=>{
                if ((version >>> 0) !== 0)
                {
                    host.writeMemory(version >>> 0, Uint8Array.of(2, 0, 0, 0));
                }
                return 0;
            },
        },
        /** VOID DhcpCApiCleanup(void) */
        DhcpCApiCleanup: { argBytes: 0, handler: ()=>0 },
        /**
         * DWORD DhcpRequestParams(DWORD Flags, LPVOID Reserved, LPWSTR AdapterName,
         *     LPDHCPCAPI_CLASSID ClassId, DHCPCAPI_PARAMS_ARRAY SendParams,
         *     DHCPCAPI_PARAMS_ARRAY RecdParams, LPBYTE Buffer, LPDWORD pSize,
         *     LPWSTR RequestIdStr)
         *
         * The two PARAMS_ARRAYs are passed by value, two DWORDs each.
         */
        DhcpRequestParams: { argBytes: 44, handler: ()=>ERROR_NOT_FOUND },
    };
}
