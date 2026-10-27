/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NORM_IGNORECASE, NORM_IGNORENONSPACE, NORM_IGNORESYMBOLS, SORT_DIGITSASNUMBERS,
    SORT_STRINGSORT, compareText, sortKey } from './collation.js';

/** @param {Uint8Array} a @param {Uint8Array} b */
const compareKeys = (a, b)=>{
    for (let at = 0; at < Math.min(a.length, b.length); at++)
    {
        if (a[at] !== b[at])
        {
            return a[at] < b[at] ? -1 : 1;
        }
    }
    return Math.sign(a.length - b.length);
};

test('punctuation, then signs, then digits, then letters, a small letter before its capital', ()=>{
    // Wine's locale.c strings_sorted, as CompareString and the sort keys order them.
    const sorted = ['\'', '-', '!', '"', '.', ':', '\\', '_', '`', '{', '}', '+', '0', '1', '9',
        'a', 'A', 'b', 'B', 'c', 'C'];
    const shuffled = [...sorted].reverse();
    assert.deepEqual([...shuffled].sort((a, b)=>compareText(a, b, 0)), sorted);
    assert.deepEqual([...shuffled].sort((a, b)=>compareKeys(sortKey(a, 0), sortKey(b, 0))), sorted);
});

test('a word sort weighs the hyphen and the apostrophe last; a string sort as punctuation', ()=>{
    assert.equal(compareText('-o', '/m', 0), 1);
    assert.equal(compareText('-o', '/m', SORT_STRINGSORT), -1);
    assert.equal(compareText('\'o', '-o', 0), -1);
    assert.equal(compareText('a-', 'a', 0), 1);
    assert.equal(compareText('`o', '-m', 0), -1);
    assert.equal(compareText('`o', '-m', SORT_STRINGSORT), 1);
});

test('NUL counts for nothing; accents and case weigh after the letters; the flags drop them', ()=>{
    assert.equal(compareText('a\0\0', 'a', 0), 0);
    assert.equal(compareText('AAA', 'aab', 0), -1);
    assert.equal(compareText('AAA', 'aaa', 0), 1);
    assert.equal(compareText('ABC', 'ÁBC', 0), -1);
    assert.equal(compareText('ÁBC', 'ÁBC', 0), 0, 'composed or not');
    assert.equal(compareText('ABC', 'ÁBC', NORM_IGNORENONSPACE), 0);
    assert.equal(compareText('Salut', 'saLuT', NORM_IGNORECASE), 0);
    assert.equal(compareText('a.', 'a', NORM_IGNORESYMBOLS), 0);
    assert.equal(compareText('a', 'ą', 0), -1, 'Polish ą between a and b');
    assert.equal(compareText('ą', 'b', 0), -1);
    assert.equal(compareText('i', 'ı', 0), -1, 'Turkish dotless i after i');
    assert.equal(compareText('İ', 'ı', 0), 1, 'and before the dotted capital');
});

test('kana, widths and numbers as Windows orders them', ()=>{
    assert.equal(compareText('フ', 'ふ', 0), -1, 'katakana before hiragana');
    assert.equal(compareText('タ', 'ﾀ', 0), 1, 'a halfwidth form before the plain one');
    assert.equal(compareText('ビ', 'ピ', 0), -1, 'the voiced mark before the semi-voiced');
    assert.equal(compareText('1230', '321', 0), -1);
    assert.equal(compareText('1230', '321', SORT_DIGITSASNUMBERS), 1);
});

test('a sort key\'s levels end in 0x01, the key in 0x00, and order as the comparison does', ()=>{
    const key = sortKey('aB', 0);
    assert.equal(key[key.length - 1], 0);
    assert.equal(key.filter(byte=>byte === 1).length, 3);
    assert.ok([...key.subarray(0, key.length - 1)].every(byte=>byte >= 1));
    for (const [a, b] of [['a', 'A'], ['ab', 'aB'], ['-o', '/m'], ['é', 'e']])
    {
        assert.equal(compareKeys(sortKey(a, 0), sortKey(b, 0)), compareText(a, b, 0), `${a} ${b}`);
    }
    assert.deepEqual(sortKey('\tJUST! A\r\n', NORM_IGNORESYMBOLS | NORM_IGNORECASE),
        sortKey('justa', 0));
});
