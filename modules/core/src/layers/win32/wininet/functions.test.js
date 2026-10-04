/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, createWininetFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

const ICU_NO_ENCODE = 0x20000000;
const ICU_DECODE = 0x10000000;
const ICU_NO_META = 0x08000000;
const ICU_ENCODE_SPACES_ONLY = 0x04000000;
const ICU_BROWSER_MODE = 0x02000000;

const URL = 0x100;
const OUT = 0x300;
const LENGTH = 0x500;

function fixture(){
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const divergences = [];
    const fns = createWininetFunctions({
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /**
         * As the memory layer reads an ANSI string: in Windows-1252, which is
         * what the Encoding standard calls latin1.
         *
         * @param {number} address @param {number} maxLength
         */
        readCString(address, maxLength){
            let end = address;
            while (end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
        },
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        request: null,
    });
    const view = new DataView(bytes.buffer);
    return {
        fns, errors, divergences, bytes, view,
        /** @param {string} text */
        put(text){
            for (let at = 0; at < text.length; at++)
            {
                bytes[URL + at] = text.charCodeAt(at) & 0xff;
            }
            bytes[URL + text.length] = 0;
        },
        /** @param {number} value */
        room: value=>view.setUint32(LENGTH, value, true),
        length: ()=>view.getUint32(LENGTH, true),
        out(){
            let text = '';
            for (let at = OUT; bytes[at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[at]);
            }
            return text;
        },
    };
}

test('a path is collapsed and unsafe characters are escaped, and nothing else is touched', ()=>{
    assert.equal(canonicalizeUrl('http://host/a/./b/../c d?q=1 2#f', 0),
        'http://host/a/c%20d?q=1%202#f');
    assert.equal(canonicalizeUrl('http://host/x/../../y', 0), 'http://host/y',
        'climbing past the root stops at the root');
    assert.equal(canonicalizeUrl('http://host/a%20b', 0), 'http://host/a%20b',
        'an existing escape is kept as it is');
});

test('each flag turns off exactly the step it names', ()=>{
    assert.equal(canonicalizeUrl('http://host/a/../b c', ICU_NO_META), 'http://host/a/../b%20c');
    assert.equal(canonicalizeUrl('http://host/a/../b c', ICU_NO_ENCODE), 'http://host/b c');
    assert.equal(canonicalizeUrl('http://host/a%2Fb%20c', ICU_DECODE), 'http://host/a/b%20c',
        'decoded first, then canonicalised');
    assert.equal(canonicalizeUrl('http://host/a b"c', ICU_ENCODE_SPACES_ONLY),
        'http://host/a%20b"c');
});

test('the buffer form reports the size it needs, then writes and reports the length', ()=>{
    const fx = fixture();
    fx.put('http://host/a/../b c');
    fx.room(4);

    assert.equal(fx.fns.InternetCanonicalizeUrlA.handler([URL, OUT, LENGTH, 0]), 0);
    assert.equal(fx.length(), 'http://host/b%20c'.length + 1, 'with the terminator');
    assert.deepEqual(fx.errors, [ERROR_INSUFFICIENT_BUFFER]);

    fx.room(fx.length());
    assert.equal(fx.fns.InternetCanonicalizeUrlA.handler([URL, OUT, LENGTH, 0]), 1);
    assert.equal(fx.out(), 'http://host/b%20c');
    assert.equal(fx.length(), 'http://host/b%20c'.length, 'without it');
});

test('a URL\'s upper-half bytes are escaped, unescaped and copied as the ANSI page\'s', ()=>{
    // The URL is read as Windows-1252, where 0x80 is the euro sign and 0x99
    // the trade mark: escaped, they are %80 and %99, the bytes they are;
    // unescaped, those escapes are those bytes again; and a component copied
    // out of the URL is its own bytes.
    const fx = fixture();
    fx.put('http://host/\x80\x99 ');
    fx.room(64);
    assert.equal(fx.fns.InternetCanonicalizeUrlA.handler([URL, OUT, LENGTH, 0]), 1);
    assert.equal(fx.out(), 'http://host/%80%99%20');

    fx.put('http://host/%80%99');
    fx.room(64);
    assert.equal(fx.fns.InternetCanonicalizeUrlA.handler(
        [URL, OUT, LENGTH, ICU_DECODE | ICU_NO_ENCODE]), 1);
    assert.equal(fx.out(), 'http://host/\x80\x99');

    fx.put('http://host/\x80\x99\x97');
    const components = 0x600;
    fx.bytes.fill(0, components, components + 60);
    fx.view.setUint32(components, 60, true);
    fx.view.setUint32(components + 44, 0x700, true);
    fx.view.setUint32(components + 48, 32, true);
    assert.equal(fx.fns.InternetCrackUrlA.handler([URL, 0, 0, components]), 1);
    assert.deepEqual([...fx.bytes.subarray(0x700, 0x705)], [0x2f, 0x80, 0x99, 0x97, 0]);
});

test('a missing string or length is refused, and browser mode is said to be ignored once', ()=>{
    const fx = fixture();
    fx.put('http://host/');
    fx.room(64);

    assert.equal(fx.fns.InternetCanonicalizeUrlA.handler([0, OUT, LENGTH, 0]), 0);
    assert.equal(fx.fns.InternetCanonicalizeUrlA.handler([URL, OUT, 0, 0]), 0);
    assert.deepEqual(fx.errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);

    fx.fns.InternetCanonicalizeUrlA.handler([URL, OUT, LENGTH, ICU_BROWSER_MODE]);
    fx.fns.InternetCanonicalizeUrlA.handler([URL, OUT, LENGTH, ICU_BROWSER_MODE]);
    assert.equal(fx.divergences.length, 1, 'still answered, and reported once');
    assert.equal(fx.out(), 'http://host/');
});

test('the wide entry points open a URL in one call and answer its status in UTF-16', async()=>{
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    /** @type {any[]} */
    const sent = [];
    const host = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: ()=>'',
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        /** @param {any} request */
        request: async request=>{
            sent.push(request);
            return { status: 200, statusText: 'OK', headers: {}, body: new Uint8Array(0) };
        },
    };
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        bytes.fill(0, at, at + text.length * 2 + 2);
        [...text].forEach((unit, index)=>{
            bytes[at + index * 2] = unit.charCodeAt(0);
        });
    };
    const fns = createWininetFunctions(host);
    wide(0x100, 'Checker');
    const session = fns.InternetOpenW.handler([0x100, 0, 0, 0, 0]);
    assert.ok(Number(session) > 0);
    wide(0x200, 'http://example.com/offer?x=1');
    const request = await fns.InternetOpenUrlW.handler([Number(session), 0x200, 0, 0, 0, 0]);
    assert.ok(Number(request) > 0, 'a request handle, its GET already sent');
    assert.equal(sent[0].method, 'GET');
    assert.match(sent[0].url, /^http:\/\/example\.com(:80)?\/offer\?x=1$/);

    const HTTP_QUERY_STATUS_CODE = 19;
    view.setUint32(0x500, 64, true);
    assert.equal(fns.HttpQueryInfoW.handler([Number(request), HTTP_QUERY_STATUS_CODE, 0x400,
        0x500, 0]), 1);
    assert.equal(view.getUint32(0x500, true), 6, 'three characters, counted in bytes');
    assert.deepEqual([...bytes.subarray(0x400, 0x408)], [0x32, 0, 0x30, 0, 0x30, 0, 0, 0]);
    view.setUint32(0x500, 4, true);
    assert.equal(fns.HttpQueryInfoW.handler([Number(request), HTTP_QUERY_STATUS_CODE, 0x400,
        0x500, 0]), 0);
    assert.equal(view.getUint32(0x500, true), 8, 'the room asked for has the terminator');

    wide(0x200, 'ftp://example.com/');
    assert.equal(await fns.InternetOpenUrlW.handler([Number(session), 0x200, 0, 0, 0, 0]), 0);
    assert.equal(errors.at(-1), 12006, 'ERROR_INTERNET_UNRECOGNIZED_SCHEME');

    const offline = createWininetFunctions({ ...host, request: null });
    const alone = offline.InternetOpenW.handler([0x100, 0, 0, 0, 0]);
    wide(0x200, 'http://example.com/');
    assert.equal(await offline.InternetOpenUrlW.handler([Number(alone), 0x200, 0, 0, 0, 0]), 0);
    assert.equal(errors.at(-1), 12029, 'ERROR_INTERNET_CANNOT_CONNECT, with no network');
    assert.equal(fns.InternetOpenW.argBytes, 20);
    assert.equal(fns.InternetOpenUrlW.argBytes, 24);
    assert.equal(fns.HttpQueryInfoW.argBytes, 20);
});
