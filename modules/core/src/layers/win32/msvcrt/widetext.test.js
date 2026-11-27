/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUnits, encodeUnits, foldUnits, markIn, textOfUnits, unitsAt } from './widetext.js';
import { guestWindow } from './guest-window.fixture.js';

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

test('a string\'s units are read to its terminator or its count, never past its region', ()=>{
    for (const base of [0, 0x100000000])
    {
        // The region ends at 0x80: a read past it faults.
        const memory = new Uint8Array(0x80);
        const guest = guestWindow(memory, { base, pointerSize: 8 });
        /** @param {number} at @param {string} text */
        const place = (at, text)=>[...text, '\0'].forEach((character, index)=>{
            memory[at + index * 2] = character.charCodeAt(0) & 0xff;
            memory[at + index * 2 + 1] = character.charCodeAt(0) >> 8;
        });
        place(0x80 - 8, 'ab☺');
        assert.equal(textOfUnits([...unitsAt(guest, base + 0x80 - 8, 2, 100)]), 'ab☺',
            `at ${base}: ending where the region does`);
        place(0x51, 'odd');
        assert.equal(textOfUnits([...unitsAt(guest, base + 0x51, 2, 100)]), 'odd',
            `at ${base}: a unit at an odd address is whole`);
        memory.fill(0x41, 0x70);
        assert.deepEqual([...unitsAt(guest, base + 0x70, 1, 16)], new Array(16).fill(0x41),
            `at ${base}: a count ending with the region, no terminator in it`);
    }
});

test('folding a line stops after its LF, a CR LF counted whole', ()=>{
    const decoded = decodeUnits(Uint8Array.of(0x61, 0x0d, 0x0a, 0x62, 0x0a), 'utf8');
    assert.deepEqual(foldUnits(decoded, 8, true), { units: [0x61, 0x0a], consumed: 3 });
    assert.deepEqual(foldUnits(decoded, 8), { units: [0x61, 0x0a, 0x62, 0x0a], consumed: 5 });
});

test('the mark names the encoding, UTF-8 before UTF-16', ()=>{
    assert.deepEqual(markIn(Uint8Array.of(0xef, 0xbb, 0xbf)), { encoding: 'utf8', length: 3 });
    assert.deepEqual(markIn(Uint8Array.of(0xff, 0xfe, 0x61)), { encoding: 'utf16', length: 2 });
    assert.equal(markIn(Uint8Array.of(0x61, 0x62)), null);
});
