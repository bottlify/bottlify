/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand, expandedName, readHeader } from './expand.js';

/** @param {number} length @param {number} lastCharacter @param {number[]} body */
const compressed = (length, lastCharacter, body)=>Uint8Array.from([
    0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33, 0x41, lastCharacter,
    length & 0xff, length >>> 8 & 0xff, length >>> 16 & 0xff, length >>> 24 & 0xff,
    ...body,
]);

test('a compressed file expands through a ring that overlaps its own output', ()=>{
    // Two literals, then a reference back to them eight bytes long: the copy
    // reads bytes it is writing, which is how a repeated pair is encoded.
    const bytes = compressed(10, 'l'.charCodeAt(0), [
        0b00000011, 0x61, 0x62, 0xf0, 0xf5,
    ]);
    assert.equal(new TextDecoder().decode(expand(bytes)), 'ababababab');
    assert.deepEqual(readHeader(bytes), { lastCharacter: 0x6c, length: 10 });
    assert.equal(expandedName('SETUP.DL_', readHeader(bytes)), 'SETUP.DLl');
});

test('the ring starts full of spaces, and the header length bounds the output', ()=>{
    // A reference into the untouched ring is spaces; a control byte with more
    // items than the length allows stops at the length.
    const bytes = compressed(3, 0, [0b00000000, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(new TextDecoder().decode(expand(bytes)), '   ');
    assert.equal(expandedName('a.b_', readHeader(bytes)), 'a.b_', 'no last character known');
});

test('a file with no header is its own expansion', ()=>{
    const plain = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]);
    assert.equal(expand(plain), plain);
    assert.equal(readHeader(plain), null);
    assert.equal(expandedName('x.ex_', null), 'x.ex_');
});
