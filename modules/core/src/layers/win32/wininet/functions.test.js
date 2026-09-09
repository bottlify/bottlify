/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, createWininetFunctions } from './functions.js';

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
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let at = 0; at < maxLength && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        request: null,
    });
    const view = new DataView(bytes.buffer);
    return {
        fns, errors, divergences,
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
