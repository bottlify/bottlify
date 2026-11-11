/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAes } from './aes.js';

/** @param {string} text */
const hex = text=>Uint8Array.from(text.match(/../g) ?? [], byte=>parseInt(byte, 16));
/** @param {Uint8Array} bytes */
const text = bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2, '0')).join('');

// FIPS 197, appendix C: the same plaintext under a 128-, 192- and 256-bit key.
const PLAIN = '00112233445566778899aabbccddeeff';
const VECTORS = [
    ['000102030405060708090a0b0c0d0e0f', '69c4e0d86a7b0430d8cdb78070b4c55a'],
    ['000102030405060708090a0b0c0d0e0f1011121314151617', 'dda97ca4864cdfe06eaf70a0ec0d7191'],
    ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        '8ea2b7ca516745bfeafc49904b496089'],
];

test('AES enciphers FIPS 197\'s example vectors at each key length, and deciphers them back', ()=>{
    for (const [key, cipher] of VECTORS)
    {
        const aes = createAes(hex(key));
        assert.equal(text(aes.encrypt(hex(PLAIN))), cipher, `a ${key.length * 4}-bit key`);
        assert.equal(text(aes.decrypt(hex(cipher))), PLAIN);
    }
});

test('AES-128 with appendix B\'s key and input', ()=>{
    const aes = createAes(hex('2b7e151628aed2a6abf7158809cf4f3c'));
    assert.equal(text(aes.encrypt(hex('3243f6a8885a308d313198a2e0370734'))),
        '3925841d02dc09fbdc118597196a0b32');
});

test('a key of another length is refused', ()=>{
    assert.throws(()=>createAes(new Uint8Array(20)), RangeError);
});
