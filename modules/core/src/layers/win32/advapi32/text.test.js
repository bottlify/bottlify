/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    IS_TEXT_UNICODE_ASCII16, IS_TEXT_UNICODE_CONTROLS, IS_TEXT_UNICODE_ILLEGAL_CHARS,
    IS_TEXT_UNICODE_NULL_BYTES, IS_TEXT_UNICODE_ODD_LENGTH, IS_TEXT_UNICODE_REVERSE_ASCII16,
    IS_TEXT_UNICODE_REVERSE_SIGNATURE, IS_TEXT_UNICODE_SIGNATURE, IS_TEXT_UNICODE_STATISTICS,
    isTextUnicode,
} from './text.js';

/** @param {string} text */
const utf16 = text=>new Uint8Array(Uint16Array.from(text, c=>c.charCodeAt(0)).buffer);
/** @param {string} text */
const ansi = text=>Uint8Array.from(text, c=>c.charCodeAt(0));
/** @param {string} text */
const bigEndian = text=>{
    const bytes = utf16(text);
    for (let at = 0; at < bytes.length; at += 2)
    {
        [bytes[at], bytes[at + 1]] = [bytes[at + 1], bytes[at]];
    }
    return bytes;
};

test('UTF-16 of ASCII text is Unicode, and says which tests it passed', ()=>{
    const answer = isTextUnicode(utf16('Hello, world'));
    assert.equal(answer.unicode, true);
    for (const flag of [IS_TEXT_UNICODE_ASCII16, IS_TEXT_UNICODE_STATISTICS,
        IS_TEXT_UNICODE_CONTROLS, IS_TEXT_UNICODE_NULL_BYTES])
    {
        assert.notEqual(answer.passed & flag, 0, `0x${flag.toString(16)}`);
    }
    assert.equal(answer.passed & IS_TEXT_UNICODE_ILLEGAL_CHARS, 0);
    assert.equal(isTextUnicode(utf16('Hello\0')).unicode, true, 'its terminator is no NUL in it');
});

test('ANSI text is not Unicode, and an odd length cannot be', ()=>{
    assert.equal(isTextUnicode(ansi('Hello World!')).unicode, false);
    const odd = isTextUnicode(ansi('Hello World'));
    assert.equal(odd.unicode, false);
    assert.notEqual(odd.passed & IS_TEXT_UNICODE_ODD_LENGTH, 0);
    assert.equal(isTextUnicode(ansi('a')).unicode, false, 'less than a character');
    assert.equal(isTextUnicode(new Uint8Array(0)).passed, 0);
});

test('the byte-order marks: one says Unicode, the reversed one says the other order', ()=>{
    const marked = isTextUnicode(utf16('﻿Text'));
    assert.equal(marked.unicode, true);
    assert.notEqual(marked.passed & IS_TEXT_UNICODE_SIGNATURE, 0);
    const reversed = isTextUnicode(bigEndian('﻿Text'));
    assert.equal(reversed.unicode, false, 'big-endian is not what this means by Unicode');
    assert.notEqual(reversed.passed & IS_TEXT_UNICODE_REVERSE_SIGNATURE, 0);
    const unmarked = isTextUnicode(bigEndian('Text'));
    assert.equal(unmarked.unicode, false);
    assert.notEqual(unmarked.passed & IS_TEXT_UNICODE_REVERSE_ASCII16, 0);
});

test('only the tests asked for are run, and only those are answered', ()=>{
    const answer = isTextUnicode(utf16('Hello'), IS_TEXT_UNICODE_SIGNATURE);
    assert.equal(answer.passed, 0, 'the one test asked for did not pass');
    assert.equal(answer.unicode, false);
    const ascii = isTextUnicode(utf16('Hello'), IS_TEXT_UNICODE_ASCII16);
    assert.deepEqual(ascii, { unicode: true, passed: IS_TEXT_UNICODE_ASCII16 });
    const illegal = isTextUnicode(utf16('a￿b'), IS_TEXT_UNICODE_ILLEGAL_CHARS
        | IS_TEXT_UNICODE_ASCII16);
    assert.equal(illegal.passed, IS_TEXT_UNICODE_ILLEGAL_CHARS);
    assert.equal(illegal.unicode, false, 'a noncharacter is not text');
});
