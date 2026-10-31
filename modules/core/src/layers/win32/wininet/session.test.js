/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWininetFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';

const ERROR_SUCCESS = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NEGATIVE_SEEK = 131;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_CANCELLED = 1223;
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
const ERROR_HTTP_HEADER_ALREADY_EXISTS = 12155;

const INTERNET_SERVICE_FTP = 1;
const INTERNET_SERVICE_HTTP = 3;
const HTTP_QUERY_FLAG_REQUEST_HEADERS = 0x80000000;
const HTTP_QUERY_CUSTOM = 0xffff;
const HTTP_QUERY_STATUS_CODE = 19;
const HTTP_QUERY_RAW_HEADERS_CRLF = 22;
const HTTP_QUERY_AUTHORIZATION = 28;
const HTTP_ADDREQ_FLAG_ADD_IF_NEW = 0x10000000;
const HTTP_ADDREQ_FLAG_ADD = 0x20000000;
const HTTP_ADDREQ_FLAG_COALESCE = 0x40000000;
const HTTP_ADDREQ_FLAG_COALESCE_WITH_SEMICOLON = 0x01000000;
const HTTP_ADDREQ_FLAG_REPLACE = 0x80000000;
const INTERNET_FLAG_NO_CACHE_WRITE = 0x04000000;

/** Fixed addresses in the fixture's memory; only their being apart matters. */
const A = 0x1000;
const B = 0x2000;
const C = 0x3000;
const OUT = 0x4000;
const LENGTH = 0x5000;
const INDEX = 0x5004;
const FLAGS = 0x5008;

/**
 * @param {Object} [options]
 * @param {any} [options.transport]  The host's `request`; null is offline.
 * @param {() => number} [options.now]
 */
function setup({ transport = null, now } = {}){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {Record<string, { argBytes: number, handler: Function }>} */ (
        createWininetFunctions({
            readMemory: (address, length)=>bytes.slice(address, address + length),
            writeMemory: (address, data)=>bytes.set(data, address),
            readCString(address, maxLength){
                let end = address;
                while (end - address < maxLength && bytes[end] !== 0)
                {
                    end++;
                }
                return decodeAnsi(bytes.subarray(address, end));
            },
            setLastError: code=>errors.push(code),
            divergence: api=>said.push(api),
            request: transport,
            now,
        }));
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>fns[name].handler(args);
    return {
        fns, errors, said, bytes, view, call,
        last: ()=>errors.at(-1),
        /** @param {number} at @param {string} text */
        ansi(at, text){
            bytes.set([...text].map(unit=>unit.charCodeAt(0)), at);
            bytes[at + text.length] = 0;
            return at;
        },
        /** @param {number} at @param {string} text */
        wide(at, text){
            [...text, '\0'].forEach((unit, index)=>view.setUint16(at + index * 2,
                unit.charCodeAt(0), true));
            return at;
        },
        /** @param {number} at */
        readAnsi(at){
            let end = at;
            while (bytes[end] !== 0)
            {
                end++;
            }
            return String.fromCharCode(...bytes.subarray(at, end));
        },
        /** @param {number} at */
        readWide(at){
            let text = '';
            for (let unit = view.getUint16(at, true); unit !== 0;
                at += 2, unit = view.getUint16(at, true))
            {
                text += String.fromCharCode(unit);
            }
            return text;
        },
        /** @param {number} at */
        dword: at=>view.getUint32(at, true),
        /** @param {number} at @param {number} value */
        setDword: (at, value)=>view.setUint32(at, value >>> 0, true),
    };
}

/**
 * A session, an HTTP connection and a GET request under them.
 *
 * @param {ReturnType<typeof setup>} fx
 */
function open(fx, { flags = 0 } = {}){
    const session = fx.call('InternetOpenA', [fx.ansi(A, 'Agent'), 1, 0, 0, 0]);
    const connection = fx.call('InternetConnectA', [session, fx.ansi(B, 'example.com'), 80, 0, 0,
        INTERNET_SERVICE_HTTP, 0, 7]);
    const request = fx.call('HttpOpenRequestA', [connection, 0, fx.ansi(C, '/path'), 0, 0, 0,
        flags, 9]);
    return { session, connection, request };
}

/** A transport that answers every request with `body` and keeps what it was sent. */
function echo(body = 'hello world', headers = {}){
    /** @type {any[]} */
    const sent = [];
    const transport = async(/** @type {any} */ request)=>{
        sent.push(request);
        return { status: 200, statusText: 'OK', headers,
            body: new TextEncoder().encode(body) };
    };
    return { sent, transport };
}

test('the A and W twins are declared with the stack their signatures take', ()=>{
    const { fns } = setup();
    const expected = {
        InternetConnectW: 32, HttpOpenRequestW: 32, HttpSendRequestW: 20, HttpSendRequestExA: 20,
        HttpSendRequestExW: 20, HttpEndRequestA: 16, HttpEndRequestW: 16,
        HttpAddRequestHeadersA: 16, HttpAddRequestHeadersW: 16, InternetCrackUrlW: 16,
        InternetCreateUrlA: 16, InternetCreateUrlW: 16, InternetCanonicalizeUrlW: 16,
        InternetQueryOptionA: 16, InternetQueryOptionW: 16, InternetSetOptionW: 16,
        InternetSetOptionExA: 20, InternetSetOptionExW: 20, InternetSetStatusCallbackA: 8,
        InternetSetStatusCallbackW: 8, InternetGetConnectedState: 8,
        InternetGetConnectedStateEx: 16, InternetGetConnectedStateExA: 16,
        InternetGetConnectedStateExW: 16, InternetAttemptConnect: 4, InternetAutodial: 8,
        InternetGoOnlineW: 12, InternetErrorDlg: 20, InternetGetLastResponseInfoA: 12,
        InternetGetLastResponseInfoW: 12, InternetTimeToSystemTime: 12,
        InternetTimeToSystemTimeA: 12, InternetTimeToSystemTimeW: 12, InternetGetCookieA: 16,
        InternetGetCookieW: 16, InternetSetCookieA: 12, InternetSetCookieW: 12,
        InternetSetPerSiteCookieDecisionW: 8, InternetGetPerSiteCookieDecisionW: 8,
        InternetEnumPerSiteCookieDecisionW: 16, InternetClearAllPerSiteCookieDecisions: 0,
        PrivacySetZonePreferenceW: 16, InternetConfirmZoneCrossingW: 16,
        InternetShowSecurityInfoByURLW: 8, InternetInitializeAutoProxyDll: 4,
        InternetQueryDataAvailable: 16, InternetSetFilePointer: 20, InternetWriteFile: 16,
    };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fns[name]?.argBytes, argBytes, name);
    }
});

test('offline, every connectivity question is answered offline', ()=>{
    const fx = setup();
    fx.setDword(FLAGS, 0xdead);
    assert.equal(fx.call('InternetGetConnectedState', [FLAGS, 0]), 0);
    assert.equal(fx.dword(FLAGS), 0x10, 'RAS installed, no LAN');
    assert.equal(fx.last(), ERROR_SUCCESS);
    fx.ansi(OUT, 'zz');
    assert.equal(fx.call('InternetGetConnectedStateExA', [FLAGS, OUT, 64, 0]), 0);
    assert.equal(fx.readAnsi(OUT), '', 'no connection to name');
    assert.equal(fx.call('InternetGetConnectedStateExA', [FLAGS, OUT, 64, 1]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    assert.equal(fx.call('InternetAttemptConnect', [0]), ERROR_INTERNET_CANNOT_CONNECT);
    assert.equal(fx.call('InternetAutodial', [0, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_CANNOT_CONNECT);
    assert.equal(fx.call('InternetGoOnlineW', [0, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_CANNOT_CONNECT);
    fx.setDword(LENGTH, 4);
    assert.equal(fx.call('InternetQueryOptionA', [0, 50, OUT, LENGTH]), 1);
    assert.equal(fx.dword(OUT), 2, 'INTERNET_STATE_DISCONNECTED');
});

test('with a transport, the machine is on a LAN and the name is truncated to the room', ()=>{
    const fx = setup({ transport: echo().transport });
    assert.equal(fx.call('InternetGetConnectedState', [FLAGS, 0]), 1);
    assert.equal(fx.dword(FLAGS), 0x12);
    assert.equal(fx.call('InternetGetConnectedStateExW', [FLAGS, OUT, 64, 0]), 1);
    assert.equal(fx.readWide(OUT), 'LAN Connection');
    assert.equal(fx.call('InternetGetConnectedStateEx', [0, OUT, 4, 0]), 1);
    assert.equal(fx.readAnsi(OUT), 'LAN');
    fx.ansi(OUT, 'keep');
    assert.equal(fx.call('InternetGetConnectedStateExA', [0, OUT, 0, 0]), 1);
    assert.equal(fx.readAnsi(OUT), 'keep', 'no room is no write');
    assert.equal(fx.call('InternetAttemptConnect', [0]), ERROR_SUCCESS);
    assert.equal(fx.call('InternetAutodial', [0, 0]), 1);
    assert.equal(fx.call('InternetGoOnlineW', [0, 0, 0]), 1);
});

test('FTP and Gopher connect at once and find no server; HTTP twins share their bodies', ()=>{
    const offline = setup();
    const session = offline.call('InternetOpenW', [offline.wide(A, 'Agent'), 1, 0, 0, 0]);
    assert.equal(offline.call('InternetConnectA', [session, offline.ansi(B, 'ftp.test'), 21, 0, 0,
        INTERNET_SERVICE_FTP, 0, 0]), 0);
    assert.equal(offline.last(), ERROR_INTERNET_NAME_NOT_RESOLVED);
    assert.equal(offline.call('InternetConnectA', [session, B, 21, 0, offline.ansi(C, 'pw'),
        INTERNET_SERVICE_FTP, 0, 0]), 0);
    assert.equal(offline.last(), ERROR_INVALID_PARAMETER, 'a password needs a user');
    assert.equal(offline.call('InternetConnectW', [session, 0, 0, 0, 0, 0, 0, 0]), 0);
    assert.equal(offline.last(), ERROR_INVALID_PARAMETER);
    assert.equal(offline.call('InternetConnectW', [0, B, 0, 0, 0, INTERNET_SERVICE_FTP, 0, 0]), 0);
    assert.equal(offline.last(), ERROR_INVALID_HANDLE);

    const online = setup({ transport: echo().transport });
    const live = online.call('InternetOpenA', [0, 1, 0, 0, 0]);
    assert.equal(online.call('InternetConnectA', [live, online.ansi(B, 'ftp.test'), 21, 0, 0,
        INTERNET_SERVICE_FTP, 0, 0]), 0);
    assert.equal(online.last(), ERROR_INTERNET_CANNOT_CONNECT);
    online.call('InternetConnectA', [live, B, 21, 0, 0, INTERNET_SERVICE_FTP, 0, 0]);
    assert.deepEqual(online.said, ['WinINet'], 'said once');

    const connection = online.call('InternetConnectW', [live, online.wide(B, 'example.com'), 0,
        0, 0, INTERNET_SERVICE_HTTP, 0, 0]);
    assert.ok(connection > 0);
    const request = online.call('HttpOpenRequestW', [connection, online.wide(A, 'post'),
        online.wide(C, '/form'), 0, 0, 0, 0, 0]);
    assert.ok(request > 0);
    assert.equal(online.call('FtpCreateDirectoryA', [request, 0]), 0);
    assert.equal(online.last(), ERROR_INTERNET_INCORRECT_HANDLE_TYPE,
        'an HTTP handle is the wrong type for FTP');
});

test('HttpSendRequest: ANSI headers need a length, wide ones may be terminated', async()=>{
    const { sent, transport } = echo();
    const fx = setup({ transport });
    const { request } = open(fx);
    assert.equal(fx.call('HttpSendRequestA', [request, fx.ansi(OUT, 'X-A: 1'), 0, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    assert.equal(await fx.call('HttpSendRequestW', [request, fx.wide(OUT, 'X-W: 2'), 0, 0, 0]),
        1);
    assert.equal(sent[0].headers['X-W'], '2');
    assert.equal(fx.call('HttpSendRequestW', [0, 0, 0, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_HANDLE);
});

test('HttpAddRequestHeaders keeps headers by modifier, and the send carries them', async()=>{
    const { sent, transport } = echo();
    const fx = setup({ transport });
    const { request, connection } = open(fx);
    /** @param {string} text @param {number} flags */
    const add = (text, flags)=>fx.call('HttpAddRequestHeadersA',
        [request, fx.ansi(A, text), -1, flags]);
    /** Every value of `name` among the request headers, by index. @param {string} name */
    const values = name=>{
        const found = [];
        fx.setDword(INDEX, 0);
        for (;;)
        {
            fx.ansi(OUT, name);
            fx.setDword(LENGTH, 256);
            if (!fx.call('HttpQueryInfoA', [request,
                HTTP_QUERY_CUSTOM | HTTP_QUERY_FLAG_REQUEST_HEADERS, OUT, LENGTH, INDEX]))
            {
                return found;
            }
            found.push(fx.readAnsi(OUT));
        }
    };
    // The sequence Windows' answers are recorded for in Wine's tests.
    assert.equal(add('Warning:test1', HTTP_ADDREQ_FLAG_ADD), 1);
    assert.equal(add('Warning:test2', HTTP_ADDREQ_FLAG_ADD), 1);
    assert.deepEqual(values('Warning'), ['test1', 'test2']);
    assert.equal(fx.last(), ERROR_HTTP_HEADER_NOT_FOUND, 'past the last index');
    assert.equal(add('Warning:test3', HTTP_ADDREQ_FLAG_REPLACE), 1);
    assert.deepEqual(values('Warning'), ['test2', 'test3']);
    assert.equal(add('Warning:test4', HTTP_ADDREQ_FLAG_ADD_IF_NEW), 0);
    assert.equal(fx.last(), ERROR_HTTP_HEADER_ALREADY_EXISTS);
    assert.equal(add('Warning:test4', HTTP_ADDREQ_FLAG_COALESCE), 1);
    assert.equal(add('Warning:test5', HTTP_ADDREQ_FLAG_COALESCE), 1);
    assert.equal(add('Warning:test6', HTTP_ADDREQ_FLAG_COALESCE_WITH_SEMICOLON), 1);
    assert.deepEqual(values('Warning'), ['test2, test4, test5; test6', 'test3']);
    assert.equal(add('Warning:test7', HTTP_ADDREQ_FLAG_ADD | HTTP_ADDREQ_FLAG_REPLACE), 1);
    assert.deepEqual(values('Warning'), ['test3', 'test7']);
    assert.equal(add('\r\rMalformed:value\n\nTwo: value2\r\n', HTTP_ADDREQ_FLAG_ADD), 1);
    assert.deepEqual(values('Two'), ['value2']);
    assert.equal(add('Authorization: Basic\r\n', HTTP_ADDREQ_FLAG_ADD), 1);
    fx.setDword(LENGTH, 256);
    assert.equal(fx.call('HttpQueryInfoA', [request,
        HTTP_QUERY_AUTHORIZATION | HTTP_QUERY_FLAG_REQUEST_HEADERS, OUT, LENGTH, 0]), 1);
    assert.equal(fx.readAnsi(OUT), 'Basic');
    assert.equal(add('Authorization:\r\n', HTTP_ADDREQ_FLAG_REPLACE), 1);
    assert.deepEqual(values('Authorization'), [], 'an empty value replaces by removing');
    assert.equal(add('Empty:', HTTP_ADDREQ_FLAG_ADD), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    assert.equal(add('Absent: x', HTTP_ADDREQ_FLAG_REPLACE), 0);
    assert.equal(fx.last(), ERROR_HTTP_HEADER_NOT_FOUND);
    assert.equal(fx.call('HttpAddRequestHeadersW', [request, fx.wide(A, 'Wide: yes'), 0,
        HTTP_ADDREQ_FLAG_ADD]), 1);
    assert.equal(fx.call('HttpAddRequestHeadersA', [connection, A, -1, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_TYPE);

    fx.setDword(LENGTH, 512);
    assert.equal(fx.call('HttpQueryInfoA', [request,
        HTTP_QUERY_RAW_HEADERS_CRLF | HTTP_QUERY_FLAG_REQUEST_HEADERS, OUT, LENGTH, 0]), 1);
    assert.match(fx.readAnsi(OUT), /^GET \/path HTTP\/1\.1\r\n.*\r\n\r\n$/s);

    assert.equal(await fx.call('HttpSendRequestA', [request, 0, 0, 0, 0]), 1);
    assert.equal(sent[0].headers.Warning, 'test7', 'the later of a name is what is sent');
    assert.equal(sent[0].headers.Wide, 'yes');
});

test('HttpSendRequestEx, InternetWriteFile and HttpEndRequest send one body, at the end', async()=>{
    const { sent, transport } = echo('posted');
    const fx = setup({ transport });
    const { request } = open(fx);
    const buffers = 0x6000;
    fx.bytes.fill(0, buffers, buffers + 40);
    fx.setDword(buffers, 40);
    fx.setDword(buffers + 8, fx.ansi(A, 'Content-Type: text/plain'));
    fx.setDword(buffers + 12, 24);
    fx.setDword(buffers + 20, fx.ansi(B, 'mod'));
    fx.setDword(buffers + 24, 3);

    assert.equal(fx.call('InternetWriteFile', [request, B, 3, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_STATE, 'nothing begun to write to');
    assert.equal(fx.call('HttpEndRequestA', [request, 0, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_STATE);
    assert.equal(fx.call('HttpSendRequestExA', [request, buffers, 0x10, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER, 'lpBuffersOut is reserved');

    assert.equal(fx.call('HttpSendRequestExA', [request, buffers, 0, 0, 0]), 1);
    assert.equal(fx.last(), ERROR_SUCCESS);
    assert.equal(sent.length, 0, 'nothing leaves before the end');
    assert.equal(fx.call('InternetWriteFile', [request, fx.ansi(C, 'e=Test'), 6, LENGTH]), 1);
    assert.equal(fx.dword(LENGTH), 6);
    assert.equal(fx.call('HttpEndRequestW', [request, 0x10, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    assert.equal(await fx.call('HttpEndRequestA', [request, 0, 0, 0]), 1);
    assert.equal(sent.length, 1);
    assert.equal(new TextDecoder().decode(sent[0].body), 'mode=Test');
    assert.equal(sent[0].headers['Content-Type'], 'text/plain');

    fx.setDword(buffers + 12, 0);
    assert.equal(fx.call('HttpSendRequestExA', [request, buffers, 0, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER, 'ANSI headers with no length');
    fx.setDword(buffers + 8, fx.wide(A, 'X: 1'));
    assert.equal(fx.call('HttpSendRequestExW', [request, buffers, 0, 0, 0]), 1);

    const offline = setup();
    const quiet = open(offline);
    assert.equal(offline.call('HttpSendRequestExA', [quiet.request, 0, 0, 0, 0]), 0);
    assert.equal(offline.last(), ERROR_INTERNET_CANNOT_CONNECT);
});

test('the read position: available bytes, seeking, and where seeking is refused', async()=>{
    const { transport } = echo('0123456789');
    const fx = setup({ transport });
    const { request, session } = open(fx);
    assert.equal(fx.call('InternetQueryDataAvailable', [request, LENGTH, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_STATE, 'nothing sent yet');
    assert.equal(fx.call('InternetSetFilePointer', [request, 0, 0, 0, 0]), 0xffffffff);
    assert.equal(fx.last(), ERROR_INTERNET_INVALID_OPERATION);
    await fx.call('HttpSendRequestA', [request, 0, 0, 0, 0]);

    assert.equal(fx.call('InternetQueryDataAvailable', [request, LENGTH, 0, 0]), 1);
    assert.equal(fx.dword(LENGTH), 10);
    assert.equal(fx.call('InternetSetFilePointer', [request, 4, 0, 0, 0]), 4);
    assert.equal(fx.last(), ERROR_SUCCESS);
    fx.call('InternetReadFile', [request, OUT, 2, LENGTH]);
    assert.equal(String.fromCharCode(...fx.bytes.subarray(OUT, OUT + 2)), '45');
    assert.equal(fx.call('InternetSetFilePointer', [request, -1, 0, 1, 0]), 5);
    assert.equal(fx.call('InternetSetFilePointer', [request, -6, 0, 1, 0]), 0xffffffff);
    assert.equal(fx.last(), ERROR_NEGATIVE_SEEK);
    assert.equal(fx.call('InternetSetFilePointer', [request, -3, 0, 2, 0]), 7);
    assert.equal(fx.call('InternetSetFilePointer', [request, -11, 0, 2, 0]), 0xffffffff);
    assert.equal(fx.last(), ERROR_NEGATIVE_SEEK);
    assert.equal(fx.call('InternetSetFilePointer', [request, -1, 0, 0, 0]), 0xffffffff);
    assert.equal(fx.last(), ERROR_SUCCESS, 'a legal position of -1');
    assert.equal(fx.call('InternetQueryDataAvailable', [request, LENGTH, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_STATE, 'past the end');

    assert.equal(fx.call('InternetSetFilePointer', [0, 0, 0, 0, 0]), 0xffffffff);
    assert.equal(fx.last(), ERROR_INVALID_HANDLE);
    assert.equal(fx.call('InternetQueryDataAvailable', [session, LENGTH, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
    assert.equal(fx.call('InternetWriteFile', [0, OUT, 1, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INVALID_HANDLE);

    const uncached = open(fx, { flags: INTERNET_FLAG_NO_CACHE_WRITE });
    await fx.call('HttpSendRequestA', [uncached.request, 0, 0, 0, 0]);
    assert.equal(fx.call('InternetSetFilePointer', [uncached.request, 0, 0, 0, 0]), 0xffffffff);
    assert.equal(fx.last(), ERROR_INTERNET_INVALID_OPERATION, 'a body not kept');
});

test('options: per-handle values inherited at creation, and the wrong handle for each', ()=>{
    const fx = setup();
    /** @param {number} handle @param {number} option @param {number} value */
    const set = (handle, option, value)=>{
        fx.setDword(OUT, value);
        return fx.call('InternetSetOptionA', [handle, option, OUT, 4]);
    };
    /** @param {number} handle @param {number} option */
    const get = (handle, option)=>{
        fx.setDword(LENGTH, 4);
        return fx.call('InternetQueryOptionA', [handle, option, OUT, LENGTH])
            ? fx.dword(OUT) : -(fx.last() ?? 0);
    };
    const CONNECT_TIMEOUT = 2;
    assert.equal(set(0, CONNECT_TIMEOUT, 12345), 1);
    assert.equal(get(0, CONNECT_TIMEOUT), 12345);
    const { session, connection, request } = open(fx);
    assert.equal(get(session, CONNECT_TIMEOUT), 12345, 'the session took the global value');
    assert.equal(set(session, CONNECT_TIMEOUT, 15000), 1);
    const later = fx.call('InternetConnectA', [session, fx.ansi(B, 'h'), 80, 0, 0, 3, 0, 0]);
    assert.equal(get(later, CONNECT_TIMEOUT), 15000);
    assert.equal(get(connection, CONNECT_TIMEOUT), 12345, 'made before the change');
    assert.equal(fx.call('InternetSetOptionExW', [later, CONNECT_TIMEOUT, OUT, 2, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_BAD_OPTION_LENGTH);

    assert.equal(get(0, 73), 2, 'MAX_CONNS_PER_SERVER');
    assert.equal(get(session, 73), -ERROR_INTERNET_INVALID_OPERATION);
    assert.equal(set(session, 73, 4), 0);
    assert.equal(get(session, 9), 1, 'HANDLE_TYPE: session');
    assert.equal(get(connection, 9), 4);
    assert.equal(get(request, 9), 13);
    assert.equal(get(0, 9), -ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
    assert.equal(get(connection, 45), 7, 'CONTEXT_VALUE');
    assert.equal(get(request, 23), 8, 'REQUEST_FLAGS: no headers yet');
    fx.setDword(LENGTH, 4);
    assert.equal(fx.call('InternetQueryOptionA', [0, 23, 0, LENGTH]), 0);
    assert.equal(fx.dword(LENGTH), 0);
    assert.equal(get(0, 62), -ERROR_INTERNET_INCORRECT_HANDLE_TYPE, 'ERROR_MASK');
    assert.equal(set(request, 62, 11), 1);
    assert.equal(set(request, 62, 4), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    assert.equal(fx.call('InternetSetOptionA', [request, 62, OUT, 20]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_BAD_OPTION_LENGTH);
    assert.equal(fx.call('InternetSetOptionW', [session, 48, 0, 0]), 0, 'POLICY');
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    assert.equal(fx.call('InternetSetOptionA', [session, 37, 0, 0]), 1, 'REFRESH');
    assert.equal(fx.call('InternetSetOptionA', [request, 37, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
    assert.equal(fx.call('InternetSetOptionA', [request, 39, 0, 0]), 1, 'SETTINGS_CHANGED');
    assert.equal(fx.call('InternetSetOptionA', [0x7770, 2, OUT, 4]), 0);
    assert.equal(fx.last(), ERROR_INVALID_HANDLE);
    assert.equal(get(session, 999), -ERROR_INTERNET_INVALID_OPTION);
    assert.equal(fx.call('InternetSetOptionA', [session, 12, OUT, 4]), 1, 'kept, not refused');

    fx.setDword(LENGTH, 8);
    assert.equal(fx.call('InternetQueryOptionA', [0, 40, OUT, LENGTH]), 1, 'VERSION');
    assert.deepEqual([fx.dword(OUT), fx.dword(OUT + 4)], [1, 2]);
});

test('options: text answers by the buffer protocol, in either width', ()=>{
    const fx = setup();
    const { session, connection, request } = open(fx);
    const USER_AGENT = 41;
    fx.setDword(LENGTH, 0);
    assert.equal(fx.call('InternetQueryOptionA', [session, USER_AGENT, OUT, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(fx.dword(LENGTH), 6);
    assert.equal(fx.call('InternetQueryOptionA', [session, USER_AGENT, OUT, LENGTH]), 1);
    assert.equal(fx.readAnsi(OUT), 'Agent');
    assert.equal(fx.dword(LENGTH), 5);
    fx.setDword(LENGTH, 0);
    assert.equal(fx.call('InternetQueryOptionA', [connection, USER_AGENT, 0, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_TYPE);
    assert.equal(fx.call('InternetQueryOptionA', [0, USER_AGENT, 0, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_INCORRECT_HANDLE_TYPE);

    fx.wide(A, 'Renamed');
    assert.equal(fx.call('InternetSetOptionW', [session, USER_AGENT, A, 16]), 1);
    fx.setDword(LENGTH, 64);
    assert.equal(fx.call('InternetQueryOptionW', [session, USER_AGENT, OUT, LENGTH]), 1);
    assert.equal(fx.readWide(OUT), 'Renamed');
    fx.setDword(LENGTH, 64);
    assert.equal(fx.call('InternetQueryOptionA', [request, 34, OUT, LENGTH]), 1, 'URL');
    assert.equal(fx.readAnsi(OUT), 'http://example.com/path');
    fx.ansi(A, 'me');
    assert.equal(fx.call('InternetSetOptionA', [request, 28, A, 3]), 1, 'USERNAME');
    fx.setDword(LENGTH, 64);
    assert.equal(fx.call('InternetQueryOptionA', [connection, 28, OUT, LENGTH]), 1);
    assert.equal(fx.readAnsi(OUT), 'me');

    const PROXY = 38;
    fx.setDword(LENGTH, 0);
    assert.equal(fx.call('InternetQueryOptionA', [0, PROXY, 0, LENGTH]), 0);
    assert.equal(fx.dword(LENGTH), 12);
    assert.equal(fx.call('InternetQueryOptionA', [0, PROXY, OUT, LENGTH]), 1);
    assert.deepEqual([fx.dword(OUT), fx.dword(OUT + 4), fx.dword(OUT + 8)], [1, 0, 0]);
    const proxied = fx.call('InternetOpenA', [0, 3, fx.ansi(B, 'proxy:8080'), 0, 0]);
    fx.setDword(LENGTH, 64);
    assert.equal(fx.call('InternetQueryOptionA', [proxied, PROXY, OUT, LENGTH]), 1);
    assert.equal(fx.dword(OUT), 3);
    assert.equal(fx.readAnsi(fx.dword(OUT + 4)), 'proxy:8080');
    assert.equal(fx.dword(LENGTH), 12 + 11);
    assert.equal(fx.call('InternetQueryOptionA', [0, 2, OUT, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
});

test('InternetErrorDlg answers as a dialog with no one to answer it', ()=>{
    const fx = setup();
    const { request } = open(fx);
    const NO_UI = 8;
    const FILTER = 1;
    const SEC_CERT_ERRORS = 12055;
    const INCORRECT_PASSWORD = 12014;
    const COOKIE_NEEDS_CONFIRMATION = 12161;
    const dialog = (/** @type {number[]} */ args)=>fx.call('InternetErrorDlg', [...args, 0]);
    assert.equal(dialog([0, 0, SEC_CERT_ERRORS, 0]), ERROR_INVALID_HANDLE, 'no window');
    assert.equal(dialog([1, 0xdeadbeef, SEC_CERT_ERRORS, NO_UI]), ERROR_INVALID_HANDLE);
    assert.equal(dialog([1, request, SEC_CERT_ERRORS, NO_UI]), ERROR_CANCELLED);
    assert.equal(dialog([0, request, INCORRECT_PASSWORD, NO_UI]), ERROR_SUCCESS);
    assert.equal(dialog([0, 0, INCORRECT_PASSWORD, NO_UI]), ERROR_INVALID_PARAMETER,
        'needs the request');
    assert.equal(dialog([0, request, COOKIE_NEEDS_CONFIRMATION, NO_UI]), 12162);
    assert.equal(dialog([0, request, 12000, NO_UI]), ERROR_CANCELLED);
    assert.equal(dialog([0, request, 12000, NO_UI | FILTER]), ERROR_SUCCESS);
    assert.equal(dialog([0, 0, 0xdeadbeef, NO_UI | FILTER]), ERROR_SUCCESS);
    assert.equal(dialog([1, request, INCORRECT_PASSWORD, 0]), ERROR_CANCELLED,
        'a dialog asked for was closed');
    assert.deepEqual(fx.errors, [], 'the answer is the return value only');
});

test('URL twins: crack in UTF-16 with pointers into the URL, create and canonicalise', ()=>{
    const fx = setup();
    const url = fx.wide(A, 'http://user@host.test:81/p/a?q=1');
    const components = 0x6000;
    fx.bytes.fill(0, components, components + 60);
    fx.setDword(components, 60);
    fx.setDword(components + 20, 1);
    fx.setDword(components + 44, OUT);
    fx.setDword(components + 48, 32);
    assert.equal(fx.call('InternetCrackUrlW', [url, 0, 0, components]), 1);
    assert.equal(fx.dword(components + 16), url + 24, 'the host, two bytes a character in');
    assert.equal(fx.dword(components + 20), 9);
    assert.equal(fx.readWide(OUT), '/p/a');
    assert.equal(fx.dword(components + 12), 3);
    assert.equal(fx.view.getUint16(components + 24, true), 81);
    assert.equal(fx.call('InternetCrackUrlW', [0, 0, 0, components]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    fx.wide(A, 'fide:///x');
    assert.equal(fx.call('InternetCrackUrlW', [A, 0, 0, components]), 1);
    assert.equal(fx.dword(components + 12), 0xffffffff, 'INTERNET_SCHEME_UNKNOWN');

    fx.bytes.fill(0, components, components + 60);
    fx.setDword(components, 60);
    fx.setDword(components + 4, fx.ansi(B, 'http'));
    fx.setDword(components + 16, fx.ansi(B + 8, 'www.winehq.org'));
    fx.view.setUint16(components + 24, 80, true);
    fx.setDword(components + 28, fx.ansi(B + 32, 'username'));
    fx.setDword(components + 36, fx.ansi(B + 48, 'password'));
    fx.setDword(components + 44, fx.ansi(B + 64, '/site/about'));
    const full = 'http://username:password@www.winehq.org/site/about';
    fx.setDword(LENGTH, 0);
    assert.equal(fx.call('InternetCreateUrlA', [components, 0, 0, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(fx.dword(LENGTH), full.length + 1);
    assert.equal(fx.call('InternetCreateUrlA', [components, 0, OUT, LENGTH]), 1);
    assert.equal(fx.readAnsi(OUT), full);
    assert.equal(fx.dword(LENGTH), full.length);
    fx.setDword(LENGTH, full.length + 1);
    fx.wide(B, 'http');
    fx.wide(B + 16, 'www.winehq.org');
    fx.wide(B + 64, '/site/about');
    fx.setDword(components + 28, 0);
    fx.setDword(components + 36, 0);
    fx.setDword(components + 16, B + 16);
    fx.setDword(components + 44, B + 64);
    assert.equal(fx.call('InternetCreateUrlW', [components, 0, OUT, LENGTH]), 1);
    const short = 'http://www.winehq.org/site/about';
    assert.equal(fx.readWide(OUT), short);
    assert.equal(fx.dword(LENGTH), short.length, 'characters');
    fx.setDword(LENGTH, 4);
    assert.equal(fx.call('InternetCreateUrlW', [components, 0, OUT, LENGTH]), 0);
    assert.equal(fx.dword(LENGTH), (short.length + 1) * 2, 'the wide room is asked in bytes');
    fx.setDword(LENGTH, 64);
    fx.setDword(components + 36, B + 48);
    assert.equal(fx.call('InternetCreateUrlW', [components, 0, OUT, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER, 'a password with no user');
    fx.setDword(components, 0);
    assert.equal(fx.call('InternetCreateUrlA', [components, 0, OUT, LENGTH]), 0);
    assert.equal(fx.call('InternetCreateUrlA', [0, 0, OUT, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);

    fx.wide(A, 'http://host/a/../b c');
    fx.setDword(LENGTH, 64);
    assert.equal(fx.call('InternetCanonicalizeUrlW', [A, OUT, LENGTH, 0]), 1);
    assert.equal(fx.readWide(OUT), 'http://host/b%20c');
    assert.equal(fx.dword(LENGTH), 17, 'characters');
    fx.setDword(LENGTH, 3);
    assert.equal(fx.call('InternetCanonicalizeUrlW', [A, OUT, LENGTH, 0]), 0);
    assert.equal(fx.dword(LENGTH), 18);
});

test('time, response info, and the calls with nothing behind them', ()=>{
    const fx = setup();
    assert.equal(fx.call('InternetTimeToSystemTimeW',
        [fx.wide(A, 'Fri, 07 Jan 2005 12:06:35 GMT'), OUT, 0]), 1);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(slot=>fx.view.getUint16(OUT + slot * 2, true)),
        [2005, 1, 5, 7, 12, 6, 35, 0]);
    assert.equal(fx.call('InternetTimeToSystemTimeA', [fx.ansi(A, 'Fr'), OUT, 0]), 1);
    assert.equal(fx.call('InternetTimeToSystemTime', [0, OUT, 0]), 0);
    assert.equal(fx.call('InternetTimeToSystemTimeW', [A, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);

    fx.setDword(INDEX, 99);
    fx.setDword(LENGTH, 16);
    fx.ansi(OUT, 'stale');
    assert.equal(fx.call('InternetGetLastResponseInfoA', [INDEX, OUT, LENGTH]), 1);
    assert.deepEqual([fx.dword(INDEX), fx.dword(LENGTH), fx.readAnsi(OUT)], [0, 0, '']);
    assert.equal(fx.call('InternetGetLastResponseInfoW', [0, 0, LENGTH]), 0);
    assert.equal(fx.call('InternetGetLastResponseInfoW', [INDEX, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);

    assert.equal(fx.call('InternetConfirmZoneCrossingW', [0, 0, 0, 0]), ERROR_SUCCESS);
    assert.equal(fx.call('InternetInitializeAutoProxyDll', [0]), 1);
    assert.equal(fx.call('PrivacySetZonePreferenceW', [3, 0, 5, 0]), ERROR_SUCCESS);
    assert.equal(fx.call('PrivacySetZonePreferenceW', [9, 0, 5, 0]), ERROR_INVALID_PARAMETER);
    assert.equal(fx.call('InternetShowSecurityInfoByURLW', [A, 0]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_ITEM_NOT_FOUND);
    assert.ok(fx.said.includes('InternetShowSecurityInfoByURLW'));

    const session = fx.call('InternetOpenA', [0, 1, 0, 0, 0]);
    assert.equal(fx.call('InternetSetStatusCallbackA', [session, 0x1234]), 0);
    assert.equal(fx.call('InternetSetStatusCallbackW', [session, 0x5678]), 0x1234);
    assert.equal(fx.call('InternetSetStatusCallback', [session, 0]), 0x5678);
});

test('cookies through the API: sizes, wide bytes, and what a request carries', async()=>{
    const { sent, transport } = echo('', { 'Set-Cookie': 'id=7; path=/, t=Fri, x=1' });
    const fx = setup({ transport });
    // Away from A, B and C, which open() writes its own strings to.
    const url = fx.ansi(0x7000, 'http://example.com/');
    fx.setDword(LENGTH, 64);
    assert.equal(fx.call('InternetGetCookieA', [url, 0, 0, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_NO_MORE_ITEMS);
    assert.equal(fx.dword(LENGTH), 0);
    assert.equal(fx.call('InternetSetCookieA', [url, 0, fx.ansi(B, 'A=B')]), 1);
    assert.equal(fx.call('InternetSetCookieW', [fx.wide(C, 'http://example.com/'),
        fx.wide(OUT, 'C'), fx.wide(OUT + 64, 'D')]), 1);
    assert.equal(fx.call('InternetGetCookieA', [url, 0, 0, LENGTH]), 1, 'a size question');
    assert.equal(fx.dword(LENGTH), 9);
    fx.setDword(LENGTH, 4);
    assert.equal(fx.call('InternetGetCookieA', [url, 0, OUT, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(fx.dword(LENGTH), 9);
    assert.equal(fx.call('InternetGetCookieA', [url, 0, OUT, LENGTH]), 1);
    assert.equal(fx.readAnsi(OUT), 'A=B; C=D');
    assert.equal(fx.dword(LENGTH), 9, 'with the terminator');
    fx.setDword(LENGTH, 0);
    assert.equal(fx.call('InternetGetCookieW', [C, 0, 0, LENGTH]), 1);
    assert.equal(fx.dword(LENGTH), 18, 'bytes');
    fx.setDword(LENGTH, 4);
    assert.equal(fx.call('InternetGetCookieW', [C, 0, OUT, LENGTH]), 0);
    assert.equal(fx.dword(LENGTH), 18);
    fx.setDword(LENGTH, 32);
    assert.equal(fx.call('InternetGetCookieW', [C, 0, OUT, LENGTH]), 1);
    assert.equal(fx.readWide(OUT), 'A=B; C=D');
    assert.equal(fx.dword(LENGTH), 9, 'characters, with the terminator');
    assert.equal(fx.call('InternetSetCookieW', [0, 0, 0]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    assert.equal(fx.call('InternetSetCookieA', [fx.ansi(B, 'server'), 0, B]), 0);
    assert.equal(fx.last(), ERROR_INTERNET_UNRECOGNIZED_SCHEME);
    assert.equal(fx.call('InternetGetCookieA', [fx.ansi(B, 'about:blank'), 0, OUT, LENGTH]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);

    const { request } = open(fx);
    await fx.call('HttpSendRequestA', [request, 0, 0, 0, 0]);
    assert.equal(sent[0].headers.Cookie, 'A=B; C=D');
    fx.setDword(LENGTH, 64);
    assert.equal(fx.call('InternetGetCookieA', [url, 0, OUT, LENGTH]), 1, String(fx.last()));
    assert.equal(fx.readAnsi(OUT), 'A=B; C=D; id=7; t=Fri; x=1', 'stored from the response');
});

test('per-site cookie decisions are kept, enumerated and cleared', ()=>{
    const fx = setup();
    const site = fx.wide(A, 'Example.com');
    assert.equal(fx.call('InternetGetPerSiteCookieDecisionW', [site, OUT]), 0);
    assert.equal(fx.call('InternetSetPerSiteCookieDecisionW', [site, 1]), 1);
    assert.equal(fx.call('InternetSetPerSiteCookieDecisionW', [fx.wide(B, 'other.test'), 5]), 1);
    assert.equal(fx.call('InternetSetPerSiteCookieDecisionW', [B, 6]), 0);
    assert.equal(fx.last(), ERROR_INVALID_PARAMETER);
    assert.equal(fx.call('InternetGetPerSiteCookieDecisionW', [fx.wide(C, 'example.com'), OUT]),
        1);
    assert.equal(fx.dword(OUT), 1);
    fx.setDword(LENGTH, 2);
    assert.equal(fx.call('InternetEnumPerSiteCookieDecisionW', [OUT, LENGTH, FLAGS, 1]), 0);
    assert.equal(fx.last(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(fx.dword(LENGTH), 11);
    assert.equal(fx.call('InternetEnumPerSiteCookieDecisionW', [OUT, LENGTH, FLAGS, 1]), 1);
    assert.deepEqual([fx.readWide(OUT), fx.dword(FLAGS)], ['other.test', 5]);
    assert.equal(fx.call('InternetEnumPerSiteCookieDecisionW', [OUT, LENGTH, FLAGS, 2]), 0);
    assert.equal(fx.last(), ERROR_NO_MORE_ITEMS);
    assert.equal(fx.call('InternetSetPerSiteCookieDecisionW', [B, 0]), 1, 'forgotten');
    assert.equal(fx.call('InternetClearAllPerSiteCookieDecisions', []), 1);
    assert.equal(fx.call('InternetEnumPerSiteCookieDecisionW', [OUT, LENGTH, FLAGS, 0]), 0);
    assert.equal(fx.last(), ERROR_NO_MORE_ITEMS);
});

test('a status code is still read the old way, now with an index that advances', async()=>{
    const fx = setup({ transport: echo().transport });
    const { request } = open(fx);
    await fx.call('HttpSendRequestA', [request, 0, 0, 0, 0]);
    fx.setDword(LENGTH, 16);
    fx.setDword(INDEX, 0);
    assert.equal(fx.call('HttpQueryInfoA', [request, HTTP_QUERY_STATUS_CODE, OUT, LENGTH, INDEX]),
        1);
    assert.equal(fx.readAnsi(OUT), '200');
    assert.equal(fx.dword(INDEX), 1);
});

test('InternetCheckConnection reaches a URL host only with a transport', ()=>{
    const ERROR_NOT_CONNECTED = 2250;
    const offline = setup();
    assert.equal(offline.call('InternetCheckConnectionW',
        [offline.wide(A, 'http://www.example.com/'), 1, 0]), 0);
    assert.equal(offline.last(), ERROR_NOT_CONNECTED);
    const fx = setup({ transport: echo().transport });
    assert.equal(fx.call('InternetCheckConnectionW', [fx.wide(A, 'http://www.example.com/'), 1, 0]), 1);
    assert.equal(fx.last(), ERROR_SUCCESS);
    assert.equal(fx.call('InternetCheckConnectionA', [fx.ansi(B, 'http://www.example.com'), 0, 0]), 1);
    assert.equal(fx.call('InternetCheckConnectionW', [0, 0, 0]), 0, 'no server database');
    assert.equal(fx.last(), ERROR_NOT_CONNECTED);
    assert.equal(fx.call('InternetCheckConnectionA', [fx.ansi(B, 'not a url'), 0, 0]), 0);
    assert.equal(fx.last(), ERROR_NOT_CONNECTED);
    assert.equal(fx.fns.InternetCheckConnectionW.argBytes, 12);
});
