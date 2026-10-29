/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUtf7, encodeUtf7 } from './utf7.js';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIRECT = '\0\t\n\r \'(),-./0123456789:?ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** @param {string} text */
const ascii = text=>Uint8Array.from(text, character=>character.charCodeAt(0));
/** @param {string} text */
const encoded = text=>String.fromCharCode(...encodeUtf7(text).bytes);

test('only set D and NUL, TAB, LF, CR go as themselves; "+" is "+-"; the rest is base64', ()=>{
    for (let code = 0; code <= 0xffff; code++)
    {
        const character = String.fromCharCode(code);
        const digits = BASE64[code >> 10] + BASE64[code >> 4 & 0x3f] + BASE64[(code & 0xf) << 2];
        const expected = code === 0x2b ? ' +- '
            : code < 0x80 && DIRECT.includes(character) ? ` ${character} ` : ` +${digits}- `;
        assert.equal(encoded(` ${character} `), expected, `U+${code.toString(16)}`);
    }
});

test('a base64 run goes on across characters it holds and ends at one written directly', ()=>{
    for (const code of [0x0001, 0x0021, 0x4f60, 0xd800, 0xffff])
    {
        const middle = `${BASE64[8 | code >> 14]}${BASE64[code >> 8 & 0x3f]}`
            + `${BASE64[code >> 2 & 0x3f]}${BASE64[(code & 3) << 4 | 2]}`;
        assert.equal(encoded(`\u2672${String.fromCharCode(code)}\u2672`), `+Jn${middle}Zy-`);
    }
    assert.equal(encoded('\u2672a\u2672'), '+JnI-a+JnI-');
    assert.equal(encoded('\u2672+\u2672'), '+JnI-+-+JnI-');
    assert.equal(encoded('\u4f60\u597d\u5417\0'), '+T2BZfVQX-\0');
});

test('a short buffer stops before a run\'s last digit and its "-", which go together', ()=>{
    const { fit } = encodeUtf7('\u4f60\0');
    assert.equal(encoded('\u4f60\0'), '+T2A-\0');
    assert.equal(fit(4), 3);
    assert.equal(fit(3), 3);
    assert.equal(fit(5), 5);
    assert.equal(encodeUtf7('\u4f60\u597d\u5417').fit(9), 9, 'a run ending on a whole digit');
    assert.equal(encodeUtf7('+').fit(1), 1, '"+" and "-" are two bytes');
});

test('a "+" that starts no run is dropped, and "+-" is a "+"', ()=>{
    for (let byte = 0; byte < 256; byte++)
    {
        const input = new Uint8Array([0x2b, byte, ...ascii('+AAA'), 0]);
        const digit = byte < 0x80 ? BASE64.indexOf(String.fromCharCode(byte)) : -1;
        const expected = byte === 0x2d ? '+\0\0'
            : digit !== -1 ? `${String.fromCharCode(digit << 10 | 0x3e0)}\0`
                : `${String.fromCharCode(byte)}\0\0`;
        assert.equal(decodeUtf7(input), expected, `byte ${byte}`);
    }
});

test('"-" ends a run and goes, another byte ends it and stays; only ASCII drops the bits', ()=>{
    for (let byte = 0; byte < 256; byte++)
    {
        const input = new Uint8Array([0x2b, 0x42, byte, ...ascii('+AAA'), 0]);
        const digit = byte < 0x80 ? BASE64.indexOf(String.fromCharCode(byte)) : -1;
        const expected = byte === 0x2d ? '\0\0'
            : digit !== -1 ? `${String.fromCharCode(0x400 | digit << 4 | 0xf)}\u8000\0`
                : byte < 0x80 ? `${String.fromCharCode(byte)}\0\0`
                    : `${String.fromCharCode(byte)}\u0400\0`;
        assert.equal(decodeUtf7(input), expected, `byte ${byte}`);
    }
});

test('bits short of a character are lost, and a lone "+" decodes to nothing', ()=>{
    assert.equal(decodeUtf7(ascii('+T-+T2-hello')), 'hello');
    assert.equal(decodeUtf7(ascii('+T2B-+T2BZ-x')), '\u4f60\u4f60x');
    assert.equal(decodeUtf7(ascii('+T2BZ-\x82\xfe')), '\u4f60\u0082\u00fe');
    assert.equal(decodeUtf7(ascii('+')), '');
    assert.equal(decodeUtf7(ascii('+T2BZfQ-')), '\u4f60\u597d');
});
