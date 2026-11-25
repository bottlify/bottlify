/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesOfUnits, utf16, utf16z } from './utf16.js';

test('utf16 of no text is no bytes, utf16z one NUL unit', ()=>{
    assert.deepEqual(utf16(''), new Uint8Array(0));
    assert.deepEqual(utf16z(''), Uint8Array.of(0, 0));
});

test('utf16 is little-endian, one unit a code unit', ()=>{
    assert.deepEqual(utf16('AЖＡ'), Uint8Array.of(0x41, 0, 0x16, 0x04, 0x21, 0xff));
    assert.deepEqual(utf16z('Ab'), Uint8Array.of(0x41, 0, 0x62, 0, 0, 0));
});

test('a character past U+FFFF is both its surrogates, in order', ()=>{
    // U+1F600 is D83D DE00: iterating by code point and taking charCodeAt(0)
    // of each would keep D83D alone.
    assert.deepEqual(utf16('\u{1F600}x'), Uint8Array.of(0x3d, 0xd8, 0x00, 0xde, 0x78, 0));
    assert.equal(utf16z('\u{1F600}').length, 6);
});

test('a lone surrogate goes back as the unit it was', ()=>{
    assert.deepEqual(utf16('\udc00\ud800'), Uint8Array.of(0x00, 0xdc, 0x00, 0xd8));
});

test('bytesOfUnits lays units out the same way, room past them zero', ()=>{
    assert.deepEqual(bytesOfUnits([0x41, 0xd83d, 0xde00]), utf16('A\u{1F600}'));
    assert.deepEqual(bytesOfUnits([0x41], 2), utf16z('A'));
    assert.deepEqual(bytesOfUnits([]), new Uint8Array(0));
    assert.deepEqual(bytesOfUnits(Uint16Array.of(0x1234)), Uint8Array.of(0x34, 0x12));
});
