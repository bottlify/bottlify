/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { beToBigInt, bigIntToBe, bigIntToLe, leToBigInt, modPow } from './rsa.js';

test('modPow raises and reduces, a negative base taken modulo first', ()=>{
    assert.equal(modPow(4n, 13n, 497n), 445n);
    assert.equal(modPow(-2n, 3n, 7n), 6n);
    assert.equal(modPow(5n, 0n, 7n), 1n);
});

test('integers go to bytes and back in either order, at the width asked for', ()=>{
    assert.deepEqual([...bigIntToBe(0x0102n, 4)], [0, 0, 1, 2]);
    assert.deepEqual([...bigIntToLe(0x0102n, 4)], [2, 1, 0, 0]);
    assert.equal(beToBigInt(Uint8Array.from([0, 0, 1, 2])), 0x0102n);
    assert.equal(leToBigInt(Uint8Array.from([2, 1, 0, 0])), 0x0102n);
});

test('a real signature raised to the public exponent is the PKCS#1 v1.5 block', ()=>{
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const jwk = publicKey.export({ format: 'jwk' });
    const n = beToBigInt(new Uint8Array(Buffer.from(/** @type {string} */ (jwk.n), 'base64url')));
    const e = beToBigInt(new Uint8Array(Buffer.from(/** @type {string} */ (jwk.e), 'base64url')));
    const signature = sign('sha1', Buffer.from('abc'), privateKey);
    const block = bigIntToBe(modPow(beToBigInt(new Uint8Array(signature)), e, n), 128);
    assert.deepEqual([...block.subarray(0, 2)], [0, 1]);
    assert.equal(Buffer.from(block.subarray(block.length - 20)).toString('hex'),
        'a9993e364706816aba3e25717850c26c9cd0d89d', 'ending in the hash that was signed');
});
