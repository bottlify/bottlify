/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUnits, encodeUnits, foldUnits, markIn } from './widetext.js';

test('a character past U+FFFF is two units that go to UTF-8 and back as one', ()=>{
    const pair = [0xd83d, 0xde00];
    const { bytes, ends } = encodeUnits(pair, 'utf8');
    assert.deepEqual([...bytes], [0xf0, 0x9f, 0x98, 0x80]);
    assert.deepEqual(ends, [4, 4], 'neither half is written without the other');
    assert.deepEqual(decodeUnits(bytes, 'utf8'), { units: pair, ends: [4, 4] });
});

test('a surrogate alone goes to UTF-8 as U+FFFD, and LF as CR LF in every encoding', ()=>{
    assert.deepEqual([...encodeUnits([0xd800, 0x0a], 'utf8').bytes],
        [0xef, 0xbf, 0xbd, 0x0d, 0x0a]);
    assert.deepEqual([...encodeUnits([0x0a], 'utf16').bytes], [0x0d, 0, 0x0a, 0]);
    assert.deepEqual([...encodeUnits([0x0a, 0x263a], 'ansi').bytes], [0x0d, 0x0a, 0x3f]);
});

test('bytes that spell no UTF-8 character are U+FFFD a byte at a time', ()=>{
    // An overlong zero, a lead with no follower, and a surrogate's encoding.
    assert.deepEqual(decodeUnits(Uint8Array.of(0xc0, 0x80, 0xe2, 0x41, 0xed, 0xa0, 0x80),
        'utf8').units, [0xfffd, 0xfffd, 0xfffd, 0x41, 0xfffd, 0xfffd, 0xfffd]);
});

test('folding stops before a character it has room for only half of', ()=>{
    const decoded = decodeUnits(Uint8Array.of(0x61, 0xf0, 0x9f, 0x98, 0x80), 'utf8');
    assert.deepEqual(foldUnits(decoded, 2), { units: [0x61], consumed: 1 });
    assert.deepEqual(foldUnits(decoded, 3), { units: [0x61, 0xd83d, 0xde00], consumed: 5 });
});

test('the mark names the encoding, UTF-8 before UTF-16', ()=>{
    assert.deepEqual(markIn(Uint8Array.of(0xef, 0xbb, 0xbf)), { encoding: 'utf8', length: 3 });
    assert.deepEqual(markIn(Uint8Array.of(0xff, 0xfe, 0x61)), { encoding: 'utf16', length: 2 });
    assert.equal(markIn(Uint8Array.of(0x61, 0x62)), null);
});
