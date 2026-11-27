/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    jisToShiftJis, shiftJisToJis, toHiragana, toKatakana, isKatakana, toFullWidth, toHalfWidth,
    jisLevel,
} from './kana.js';
import { createMultiByteFunctions } from './mbstring.js';
import { fakeMemory } from './harness.test.js';

/** @param {[number, number][]} pairs @param {(code: number) => number} f */
const each = (pairs, f)=>{
    for (const [code, expected] of pairs)
    {
        assert.equal(f(code), expected, `0x${code.toString(16)}`);
    }
};

test('a JIS code and its Shift-JIS pair, zero outside the square', ()=>{
    each([[0x2020, 0], [0x2021, 0], [0x2120, 0], [0x2121, 0x8140], [0x7f7f, 0], [0x7f7e, 0],
        [0x7e7f, 0], [0x7e7e, 0xeffc], [0x255f, 0x837e], [0x2560, 0x8380], [0x2561, 0x8381],
        [0x2121ffff, 0], [0x2223, 0x81a1], [0x237e, 0x829e]], jisToShiftJis);
    each([[0x80fc, 0], [0x813f, 0], [0x8140, 0x2121], [0x817e, 0x215f], [0x817f, 0],
        [0x8180, 0x2160], [0x819e, 0x217e], [0x819f, 0x2221], [0x81fc, 0x227e], [0x81fd, 0],
        [0x9ffc, 0x5e7e], [0x9ffd, 0], [0xa040, 0], [0xdffc, 0], [0xe040, 0x5f21],
        [0xeffc, 0x7e7e], [0xf040, 0], [0x21, 0]], shiftJisToJis);
    for (let high = 0x21; high <= 0x7e; high++)
    {
        for (let low = 0x21; low <= 0x7e; low++)
        {
            const jis = high << 8 | low;
            assert.equal(shiftJisToJis(jisToShiftJis(jis)), jis, 'the two are inverses');
        }
    }
});

test('hiragana and katakana each as the other, the rest as itself', ()=>{
    each([[0x8152, 0x8152], [0x8153, 0x8153], [0x82a0, 0x82a0], [0x833f, 0x833f],
        [0x8340, 0x829f], [0x837e, 0x82dd], [0x837f, 0x837f], [0x8380, 0x82de],
        [0x8393, 0x82f1], [0x8394, 0x8394], [0x8396, 0x8396], [0x8397, 0x8397], [0xa5, 0xa5],
        [0xb0, 0xb0], [0xdd, 0xdd]], toHiragana);
    each([[0x8152, 0x8152], [0x833f, 0x833f], [0x829f, 0x8340], [0x82dd, 0x837e],
        [0x837f, 0x837f], [0x82de, 0x8380], [0x8394, 0x8394], [0x8397, 0x8397], [0xa5, 0xa5]],
    toKatakana);
    each([[0x8152, 0], [0x82a0, 0], [0x833f, 0], [0x8340, 1], [0x837e, 1], [0x837f, 0],
        [0x8380, 1], [0x8396, 1], [0x8397, 0], [0xa5, 0], [0xb0, 0], [0xdd, 0]],
    c=>(isKatakana(c) ? 1 : 0));
});

test('a single byte as its full-width pair and back', ()=>{
    each([[0x1f, 0x1f], [0x20, 0x8140], [0x39, 0x8258], [0x40, 0x8197], [0x41, 0x8260],
        [0x5e, 0x814f], [0x7e, 0x8150], [0x7f, 0x7f], [0x80, 0x80], [0x81, 0x81], [0xa0, 0xa0],
        [0xa7, 0x8340], [0xb0, 0x815b], [0xd1, 0x8380], [0xff, 0xff]], toFullWidth);
    each([[0x829e, 0x829e], [0x829f, 0xa7], [0x82f1, 0xdd], [0x82f2, 0x82f2], [0x833f, 0x833f],
        [0x8340, 0xa7], [0x837e, 0xd0], [0x837f, 0x837f], [0x8380, 0xd1], [0x8396, 0xb9],
        [0x8397, 0x8397], [0x813f, 0x813f], [0x8140, 0x20], [0x814c, 0x814c], [0x814f, 0x5e],
        [0x8197, 0x40], [0x8198, 0x8198], [0x8258, 0x39], [0x8259, 0x8259], [0x825f, 0x825f],
        [0x8260, 0x41]], toHalfWidth);
    for (let byte = 0x20; byte <= 0xdf; byte = byte === 0x7e ? 0xa1 : byte + 1)
    {
        assert.equal(toHalfWidth(toFullWidth(byte)), byte, `0x${byte.toString(16)} round trips`);
    }
});

test('each full-width pair is the character its byte stands for, as Shift-JIS decodes it', ()=>{
    // The WHATWG decoder reads 0x5c and 0x7e as ASCII and the quotes as
    // straight ones; JIS-Roman, which the full-width row follows, reads the
    // yen sign and the macron, and its quotes close.
    const decoder = new TextDecoder('shift_jis');
    const asJisRoman = new Map([['\\', '\u00a5'], ['~', '\uffe3'], ['"', '\u201d'],
        ['\'', '\u2019']]);
    for (let byte = 0x20; byte <= 0xdf; byte = byte === 0x7e ? 0xa1 : byte + 1)
    {
        const pair = toFullWidth(byte);
        const single = decoder.decode(Uint8Array.of(byte));
        const wide = decoder.decode(Uint8Array.of(pair >> 8, pair & 0xff));
        // Spacing and combining voicing marks differ by a space in NFKC.
        const expected = (asJisRoman.get(single) ?? single).normalize('NFKC').trim();
        assert.equal(wide.normalize('NFKC').trim(), expected, `0x${byte.toString(16)}`);
    }
});

test('the JIS levels: symbols, first-level kanji, second-level kanji', ()=>{
    each([[0, -1], [0x8140, 0], [0x817f, -1], [0x889f, 1], [0x88fd, -1], [0x989f, 2],
        [0x993f, -1], [0x9873, -1], [0xeaa4, 2], [0xeaa5, -1]], jisLevel);
});

test('the conversions hold under page 932 alone', ()=>{
    const memory = fakeMemory();
    const table = /** @type {Record<string, any>} */ (createMultiByteFunctions({}, { ...memory }));
    const call = (/** @type {string} */ name, /** @type {number} */ code)=>
        table[name].handler([code]);
    assert.equal(call('_mbcjistojms', 0x2121), 0x2121, 'the C locale\'s page');
    assert.equal(call('_ismbcl0', 0x8140), 0);
    assert.equal(table._setmbcp.handler([1252]), 0);
    assert.equal(call('_mbbtombc', 0x41), 0x41);
    assert.equal(call('_ismbckata', 0x8340), 0);
    assert.equal(table._setmbcp.handler([932]), 0);
    assert.equal(call('_mbcjistojms', 0x2121), 0x8140);
    assert.equal(call('_mbcjmstojis', 0x8140), 0x2121);
    assert.equal(call('_mbctohira', 0x8340), 0x829f);
    assert.equal(call('_mbctokata', 0x829f), 0x8340);
    assert.equal(call('_mbbtombc', 0x41), 0x8260);
    assert.equal(call('_mbctombb', 0x8260), 0x41);
    assert.equal(call('_ismbckata', 0x8340), 1);
    assert.equal(call('_ismbchira', 0x829f), 1);
    assert.equal(call('_ismbcl0', 0x8140), 1);
    assert.equal(call('_ismbcl1', 0x889f), 1);
    assert.equal(call('_ismbcl2', 0x989f), 1);
    assert.equal(call('_ismbcl2', 0x993f), 0);
    assert.equal(table._setmbcp.handler([936]), 0);
    assert.equal(call('_mbcjistojms', 0x2121ffff), 0x2121ffff);
});
