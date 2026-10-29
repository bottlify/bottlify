/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDes, expandKey } from './des.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from(text.match(/../g) ?? [], pair=>parseInt(pair, 16));
/** @param {Uint8Array} data */
const hex = data=>[...data].map(byte=>byte.toString(16).padStart(2, '0')).join('');

test('DES answers the standard\'s worked vector and the NBS variable-plaintext one', ()=>{
    const des = createDes(bytes('133457799bbcdff1'));
    assert.equal(hex(des.encrypt(bytes('0123456789abcdef'))), '85e813540f0ab405');
    assert.equal(hex(des.decrypt(bytes('85e813540f0ab405'))), '0123456789abcdef');
    assert.equal(hex(createDes(bytes('0101010101010101')).encrypt(bytes('8000000000000000'))),
        '95f8a5e5dd31d900');
});

test('a seven-byte key spreads to eight: the LAN Manager hash of nothing', ()=>{
    // "KGS!@#$%" under the all-zero half-password: the well-known empty LM hash half.
    const key = expandKey(new Uint8Array(7));
    assert.equal(hex(createDes(key).encrypt(new TextEncoder().encode('KGS!@#$%'))),
        'aad3b435b51404ee');
    assert.equal(hex(expandKey(bytes('ffffffffffffff'))), 'fefefefefefefefe');
});
