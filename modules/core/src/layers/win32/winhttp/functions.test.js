/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDhcpFunctions, createWinhttpFunctions } from './functions.js';

function setup(){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    /** @type {number[]} */
    const errors = [];
    const fns = createWinhttpFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        setLastError: code=>errors.push(code),
    });
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
        view.setUint16(at + text.length * 2, 0, true);
        return at;
    };
    /** @param {number} at @param {number} length */
    const readWide = (at, length)=>String.fromCharCode(...Array.from({ length },
        (_, i)=>view.getUint16(at + i * 2, true)));
    return { memory, view, errors, fns, wide, readWide };
}

test('the proxy settings are a direct connection', ()=>{
    const { memory, view, fns } = setup();
    memory.fill(0xcc, 0x100, 0x110);
    assert.equal(fns.WinHttpGetIEProxyConfigForCurrentUser.handler([0x100]), 1);
    assert.deepEqual([...memory.subarray(0x100, 0x110)], new Array(16).fill(0),
        'no detection, no script, no proxy, no bypass');
    memory.fill(0xcc, 0x200, 0x20c);
    assert.equal(fns.WinHttpGetDefaultProxyConfiguration.handler([0x200]), 1);
    assert.deepEqual([0, 4, 8].map(at=>view.getUint32(0x200 + at, true)), [1, 0, 0],
        'WINHTTP_ACCESS_TYPE_NO_PROXY');
});

test('a URL is cracked with WinHTTP\'s scheme numbers, into the URL or into buffers', ()=>{
    const { view, errors, fns, wide, readWide } = setup();
    const url = wide(0x1000, 'https://user:pw@example.test:8443/a/b.pac?x=1');
    const parts = 0x2000;
    view.setUint32(parts, 60, true);
    for (const at of [8, 20, 32, 40, 48, 56])
    {
        view.setUint32(parts + at, 1, true);
    }
    assert.equal(fns.WinHttpCrackUrl.handler([url, 0, 0, parts]), 1);
    assert.equal(view.getUint32(parts + 12, true), 2, 'INTERNET_SCHEME_HTTPS');
    assert.equal(view.getUint16(parts + 24, true), 8443);
    const part = (/** @type {number} */ pointer, /** @type {number} */ length)=>
        readWide(view.getUint32(parts + pointer, true), view.getUint32(parts + length, true));
    assert.deepEqual([part(4, 8), part(16, 20), part(28, 32), part(36, 40), part(44, 48),
        part(52, 56)],
    ['https', 'example.test', 'user', 'pw', '/a/b.pac', '?x=1']);

    // Asked again with only the host, now into a buffer of its own.
    for (const at of [4, 8, 28, 32, 36, 40, 44, 48, 52, 56])
    {
        view.setUint32(parts + at, 0, true);
    }
    view.setUint32(parts + 16, 0x3000, true);
    view.setUint32(parts + 20, 4, true);
    assert.equal(fns.WinHttpCrackUrl.handler([url, 0, 0, parts]), 0);
    assert.equal(errors.at(-1), 122, 'a host buffer too small');
    assert.equal(view.getUint32(parts + 20, true), 13, 'and the room it needs');
    view.setUint32(parts + 20, 64, true);
    assert.equal(fns.WinHttpCrackUrl.handler([url, 0, 0, parts]), 1);
    assert.equal(readWide(0x3000, 12), 'example.test');

    assert.equal(fns.WinHttpCrackUrl.handler([wide(0x1000, 'ftp://example.test/'), 0, 0, parts]),
        0);
    assert.equal(errors.at(-1), 12006, 'ERROR_WINHTTP_UNRECOGNIZED_SCHEME');
    assert.equal(fns.WinHttpCrackUrl.handler([wide(0x1000, 'example'), 0, 0, parts]), 0);
    assert.equal(errors.at(-1), 12005, 'ERROR_WINHTTP_INVALID_URL');
    view.setUint32(parts, 56, true);
    assert.equal(fns.WinHttpCrackUrl.handler([url, 0, 0, parts]), 0);
    assert.equal(errors.at(-1), 87);
});

test('handles form a tree; a request is refused when sent, and closing the session closes it',
    ()=>{
        const { errors, fns, wide } = setup();
        const session = fns.WinHttpOpen.handler();
        assert.notEqual(session, 0);
        assert.equal(fns.WinHttpSetTimeouts.handler([session, 1000, -1, 0, 0]), 1);
        assert.equal(fns.WinHttpSetTimeouts.handler([session, -2, 0, 0, 0]), 0);
        assert.equal(fns.WinHttpSetStatusCallback.handler([session, 0x401000, 0xffffffff, 0]), 0);
        assert.equal(fns.WinHttpSetStatusCallback.handler([session, 0, 0, 0]), 0x401000);
        assert.equal(fns.WinHttpSetStatusCallback.handler([0x1234, 0, 0, 0]), 0xffffffff);
        const connect = fns.WinHttpConnect.handler([session, wide(0x100, 'example.test'), 80, 0]);
        assert.equal(fns.WinHttpConnect.handler([connect, wide(0x100, 'x'), 80, 0]), 0);
        assert.equal(errors.at(-1), 12018, 'ERROR_WINHTTP_INCORRECT_HANDLE_TYPE');
        const request = fns.WinHttpOpenRequest.handler([connect, 0, 0, 0, 0, 0, 0]);
        assert.equal(fns.WinHttpAddRequestHeaders.handler([request, wide(0x200, 'A: b'), -1, 0]),
            1);
        assert.equal(fns.WinHttpSendRequest.handler([request, 0, 0, 0, 0, 0, 0]), 0);
        assert.equal(errors.at(-1), 12029, 'ERROR_WINHTTP_CANNOT_CONNECT');
        assert.equal(fns.WinHttpReceiveResponse.handler([request, 0]), 0);
        assert.equal(errors.at(-1), 12019, 'nothing was sent to answer');
        assert.equal(fns.WinHttpCloseHandle.handler([session]), 1);
        assert.equal(fns.WinHttpReadData.handler([request, 0x300, 4, 0x310]), 0);
        assert.equal(errors.at(-1), 6, 'the request went with its session');
        assert.equal(fns.WinHttpCloseHandle.handler([request]), 0);
    });

test('proxy detection finds no WPAD server, and a script cannot be fetched', ()=>{
    const { view, errors, fns, wide } = setup();
    const session = fns.WinHttpOpen.handler();
    const url = wide(0x100, 'http://example.test/');
    view.setUint32(0x400, 1, true);
    assert.equal(fns.WinHttpGetProxyForUrl.handler([session, url, 0x400, 0x500]), 0);
    assert.equal(errors.at(-1), 12180, 'ERROR_WINHTTP_AUTODETECTION_FAILED');
    view.setUint32(0x400, 2, true);
    assert.equal(fns.WinHttpGetProxyForUrl.handler([session, url, 0x400, 0x500]), 0);
    assert.equal(errors.at(-1), 12167, 'ERROR_WINHTTP_UNABLE_TO_DOWNLOAD_SCRIPT');
    assert.equal(fns.WinHttpCreateProxyResolver.handler([session, 0x600]), 0);
    const resolver = view.getUint32(0x600, true);
    view.setUint32(0x400, 1, true);
    assert.equal(fns.WinHttpGetProxyForUrlEx.handler([resolver, url, 0x400, 0]), 12180);
    assert.equal(fns.WinHttpGetProxyResult.handler([resolver, 0x700]), 12019);
    assert.equal(fns.WinHttpCreateProxyResolver.handler([0x9999, 0x600]), 6);
});

test('the DHCP client answers version 2 and holds no lease to ask about', ()=>{
    const memory = new Uint8Array(16);
    const fns = createDhcpFunctions({ writeMemory: (address, bytes)=>memory.set(bytes, address) });
    assert.equal(fns.DhcpCApiInitialize.handler([4]), 0);
    assert.equal(memory[4], 2);
    assert.equal(fns.DhcpRequestParams.handler(), 1168, 'ERROR_NOT_FOUND');
    assert.equal(fns.DhcpRequestParams.argBytes, 44);
});
