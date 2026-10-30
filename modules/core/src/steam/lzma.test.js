/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLzma } from './lzma.js';

/**
 * The fixture's bytes: text with long and short repeats, 1500 bytes of a
 * linear congruential generator, then the text's first 900 bytes again --
 * literals, matches, repeated distances and matched literals all in one.
 */
function fixtureText(){
    const parts = [];
    for (let i = 0; i < 60; i++)
    {
        parts.push(`the bottle holds the game, the game holds the bottle ${i % 7}; `);
    }
    const text = new TextEncoder().encode(parts.join(''));
    const noise = new Uint8Array(1500);
    let x = 12345;
    for (let i = 0; i < noise.length; i++)
    {
        x = Number((BigInt(x) * 1103515245n + 12345n) & 0x7fffffffn);
        noise[i] = (x >>> 16) & 0xff;
    }
    const out = new Uint8Array(text.length + noise.length + 900);
    out.set(text);
    out.set(noise, text.length);
    out.set(text.subarray(0, 900), text.length + noise.length);
    return out;
}

// The fixture compressed by an independent encoder (Python 3.13's lzma, xz):
// raw LZMA1, lc 3, lp 0, pb 2, a 64 KiB dictionary, ending in an end marker.
const PACKED = Buffer.from([
    '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',
    'M7lPprp/L8+mwpt09ujSX8juf5xF4///QbdPAA==',
].join(''), 'base64');
const PROPERTIES = Uint8Array.of(0x5d, 0x00, 0x00, 0x01, 0x00);

test('a stream another encoder made decodes to its bytes', ()=>{
    const expected = fixtureText();
    assert.equal(expected.length, 5760);
    assert.deepEqual(decodeLzma(PROPERTIES, PACKED, expected.length), expected);
});

test('a stream that does not decode says so', ()=>{
    assert.throws(()=>decodeLzma(PROPERTIES, Uint8Array.of(1, 2, 3, 4, 5), 4), /zero byte/);
    assert.throws(()=>decodeLzma(Uint8Array.of(225, 0, 0, 1, 0), PACKED, 10), /properties/);
    const cut = PACKED.subarray(0, 200);
    assert.throws(()=>decodeLzma(PROPERTIES, cut, 5760));
});
