/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBase64, toBase64 } from './base64.js';

const ascii = (/** @type {string} */ text)=>Uint8Array.from(text, c=>c.charCodeAt(0));

test('the RFC 4648 test vectors, padding included', ()=>{
    const vectors = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='],
        ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']];
    for (const [plain, coded] of vectors)
    {
        assert.equal(toBase64(ascii(plain)), coded, plain);
        assert.deepEqual(fromBase64(coded), ascii(plain), coded);
    }
});

test('every byte value, and the two characters past the letters and digits', ()=>{
    const all = Uint8Array.from({ length: 256 }, (unused, at)=>at);
    assert.deepEqual(fromBase64(toBase64(all)), all);
    assert.equal(toBase64(Uint8Array.of(0xfb, 0xff)), '+/8=');
});

test('a buffer far past what one String.fromCharCode spread takes', ()=>{
    const bytes = Uint8Array.from({ length: 1_000_003 }, (unused, at)=>at * 7 & 0xff);
    const text = toBase64(bytes);
    assert.equal(text.length, Math.ceil(bytes.length / 3) * 4);
    assert.ok(!text.slice(0, -4).includes('='), 'padding only at the very end');
    assert.deepEqual(fromBase64(text), bytes);
});

test('a view into a larger buffer codes only its own bytes', ()=>{
    const backing = ascii('xxfooxx');
    assert.equal(toBase64(backing.subarray(2, 5)), 'Zm9v');
});

test('fromBase64 passes over whitespace and refuses what is not base64', ()=>{
    assert.deepEqual(fromBase64('Zm9v\r\nYmFy'), ascii('foobar'));
    assert.throws(()=>fromBase64('Zm9v!'));
    assert.throws(()=>fromBase64('Zm9vY'));
});
