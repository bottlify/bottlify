/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, lcidOfName, localeByLcid, localeByName } from './locales.js';

test('an LCID names its locale and its pages; a neutral one stands for its default locale', ()=>{
    // Wine's codepage.c test_threadcp and locale.c's neutralsublang tables.
    assert.deepEqual({ ...localeByLcid(0x0419) }, { lcid: 0x0419, name: 'ru-RU', ansi: 1251,
        oem: 866, mac: 10007, neutral: false, specific: 0x0419 });
    assert.equal(localeByLcid(0x0411)?.ansi, 932);
    assert.equal(localeByLcid(0x0804)?.ansi, 936);
    assert.equal(localeByLcid(0x0439)?.ansi, 0, 'Hindi has no ANSI page');
    assert.equal(localeByLcid(0x0437)?.ansi, 0, 'nor Georgian');
    for (const [neutral, specific] of [[0x0009, 0x0409], [0x000a, 0x0c0a], [0x001a, 0x041a],
        [0x0004, 0x0804], [0x7c04, 0x0c04], [0x7c1a, 0x241a], [0x003c, 0x083c], [0x0045, 0x0845]])
    {
        assert.equal(localeByLcid(neutral)?.specific, specific, neutral.toString(16));
    }
    assert.equal(localeByLcid(0x10407)?.name, 'de-DE', 'German phone-book order is German');
    assert.equal(localeByLcid(0x50409), null, 'a sort en-US does not have');
    assert.equal(localeByLcid(0x1234), null);
});

test('a name finds its locale in any case; LocaleNameToLCID\'s LCID for it', ()=>{
    assert.equal(localeByName('es-es')?.lcid, 0x0c0a);
    assert.equal(localeByName('EN')?.neutral, true);
    assert.equal(lcidOfName('en', false), 0x0409);
    assert.equal(lcidOfName('en', true), 0x0009);
    assert.equal(lcidOfName('zh-Hant', false), 0x0c04);
    assert.equal(lcidOfName('zh-hans', false), 0x0804);
    assert.equal(lcidOfName('sr', false), 0x241a);
    assert.equal(lcidOfName('de-DE_phoneb', false), 0x10407);
    assert.equal(lcidOfName('zz-ZZ', false), 0);
});

test('every locale has one LCID and one name', ()=>{
    assert.equal(new Set(LOCALES.map(locale=>locale.lcid)).size, LOCALES.length);
    assert.equal(new Set(LOCALES.map(locale=>locale.name.toLowerCase())).size, LOCALES.length);
    assert.ok(LOCALES.every(locale=>localeByLcid(locale.specific)?.neutral === false));
});
