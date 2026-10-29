/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LCMAP_FULLWIDTH, LCMAP_HALFWIDTH, LCMAP_HIRAGANA, LCMAP_KATAKANA, LCMAP_LOWERCASE,
    LCMAP_SORTKEY, LCMAP_UPPERCASE, mapText, validMapFlags } from './lcmap.js';
import { isSymbol } from './collation.js';

const NORM_IGNORENONSPACE = 0x2;
const NORM_IGNORESYMBOLS = 0x4;
/** @param {string} text @param {number} flags */
const map = (text, flags)=>mapText(text, flags, isSymbol, false);

test('case, one character for one', ()=>{
    assert.equal(map('\tjust! a, 1/*+-.', LCMAP_UPPERCASE), '\tJUST! A, 1/*+-.');
    assert.equal(map('STRAßE', LCMAP_LOWERCASE), 'straße');
    assert.equal(map('straße', LCMAP_UPPERCASE), 'STRAßE', 'the sharp s has no capital');
    assert.equal(mapText('i', LCMAP_UPPERCASE | 0x01000000, isSymbol, true), 'İ');
});

test('kana and widths, the sound marks with their letters', ()=>{
    // Wine's locale.c test_lcmapstring_unicode.
    assert.equal(map('イハヴヵ', LCMAP_HIRAGANA), 'いはゔゕ');
    assert.equal(map('いゝの', LCMAP_KATAKANA), 'イヽノ');
    assert.equal(map('ガ、', LCMAP_HALFWIDTH), 'ｶﾞ､');
    assert.equal(map('ｳﾞ､', LCMAP_FULLWIDTH), 'ヴ、');
    assert.equal(map('𝐀𝕒', LCMAP_FULLWIDTH), 'Aa', 'mathematical letters');
    assert.equal(map('←○', LCMAP_HALFWIDTH), '←○');
    assert.equal(map('￩', LCMAP_FULLWIDTH), '￩');
    assert.equal(map('い', LCMAP_HALFWIDTH), 'い', 'hiragana has no halfwidth form');
});

test('NORM_IGNORESYMBOLS and NORM_IGNORENONSPACE as mappings', ()=>{
    assert.equal(map('\tjust! a, test; 1/*+-.\r\n', NORM_IGNORESYMBOLS), 'justatest1');
    assert.equal(map('àç é,î', NORM_IGNORENONSPACE), 'ac e,i');
});

test('flags taken alone or together as Windows takes them', ()=>{
    for (const flags of [0, LCMAP_HIRAGANA | LCMAP_KATAKANA, LCMAP_HALFWIDTH | LCMAP_FULLWIDTH,
        LCMAP_UPPERCASE | NORM_IGNORESYMBOLS, LCMAP_HIRAGANA | NORM_IGNORENONSPACE,
        LCMAP_SORTKEY | LCMAP_UPPERCASE, LCMAP_LOWERCASE | 0x1000])
    {
        assert.equal(validMapFlags(flags), false, flags.toString(16));
    }
    for (const flags of [LCMAP_LOWERCASE, LCMAP_FULLWIDTH | LCMAP_HIRAGANA, LCMAP_SORTKEY | 0x1000,
        NORM_IGNORESYMBOLS | NORM_IGNORENONSPACE])
    {
        assert.equal(validMapFlags(flags), true, flags.toString(16));
    }
});
