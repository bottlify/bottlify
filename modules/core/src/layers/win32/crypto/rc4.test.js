/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRc4 } from './rc4.js';

test('RC4 answers the RFC 6229 keystream for a 40-bit key', ()=>{
    const cipher = createRc4(Uint8Array.from([1, 2, 3, 4, 5]));
    assert.equal(Buffer.from(cipher.transform(new Uint8Array(16))).toString('hex'),
        'b2396305f03dc027ccc3524a0a1118a8');
});

test('the keystream carries on across calls until a reset starts it again', ()=>{
    const key = Uint8Array.from([1, 2, 3, 4, 5]);
    const whole = createRc4(key).transform(new Uint8Array(32));
    const cipher = createRc4(key);
    const first = cipher.transform(new Uint8Array(16));
    const second = cipher.transform(new Uint8Array(16));
    assert.deepEqual([...first, ...second], [...whole]);
    cipher.reset();
    assert.deepEqual([...cipher.transform(new Uint8Array(16))], [...first]);
});
